// Действия над узлами: создание, загрузка, переименование, удаление, ссылки, меню.
import { api, type GNode } from './api';
import { useApp, type MenuItem } from './ctx';
import { isShareRoot, pathOf, splitName, typeForExt } from './model';

const EMPTY_BOARD = JSON.stringify({ type: 'excalidraw', version: 2, source: 'graphspace', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} });
export const RESOURCE_KINDS = ['git', 's3', 'registry', 'url'];

export function useActions() {
  const app = useApp();

  const createIn = (parent: GNode | null, what: string) => app.run(async () => {
    let node: GNode | null = null;
    if (what === 'space') {
      const v = await app.ask(parent ? 'Новый раздел' : 'Новый проект', [
        { name: 'title', label: 'Имя' },
        { name: 'label', label: 'Метка', value: parent ? '' : 'проект', optional: true, options: ['направление', 'аппка', 'инфра'], placeholder: 'направление, аппка — любая' },
      ], 'Создать');
      if (!v) return;
      node = await api.create({ type: 'space', title: v.title, parent_id: parent?.id ?? null, props: { label: v.label.trim() } });
    } else if (what === 'resource') {
      const v = await app.ask('Новый ресурс', [
        { name: 'title', label: 'Имя' },
        { name: 'kind', label: 'Вид', value: 'git', options: RESOURCE_KINDS },
        { name: 'url', label: 'Ссылка', placeholder: 'https://…', optional: true },
      ], 'Создать');
      if (!v) return;
      node = await api.create({ type: 'resource', title: v.title, parent_id: parent!.id, props: { kind: v.kind.trim().toLowerCase(), url: v.url.trim(), note: '' } });
    } else {
      const spec: Record<string, { type: GNode['type']; ext: string; title: string }> = {
        doc: { type: 'doc', ext: 'md', title: 'Новый док' },
        board: { type: 'board', ext: 'excalidraw', title: 'Новая схема' },
        docx: { type: 'office', ext: 'docx', title: 'Новый документ Word' },
        xlsx: { type: 'office', ext: 'xlsx', title: 'Новая таблица' },
        pptx: { type: 'office', ext: 'pptx', title: 'Новая презентация' },
      };
      const s = spec[what];
      const v = await app.ask(s.title, [{ name: 'title', label: 'Имя', value: s.title }], 'Создать');
      if (!v) return;
      node = await api.create({ type: s.type, title: v.title, parent_id: parent!.id, ext: s.ext });
      if (what === 'doc') await api.save(node.id, `# ${v.title}\n\n`, null);
      if (what === 'board') await api.save(node.id, EMPTY_BOARD, null);
      // Офисные файлы создаются пустыми узлами: первую версию запишет Craft при первом сохранении.
    }
    await app.reload();
    if (node) app.go({ sel: node.id });
  });

  // parentId null — на верхний уровень: там может жить любой узел.
  const upload = (parentId: string | null, files: File[]) => app.run(async () => {
    let last: GNode | null = null;
    for (const f of files) {
      const { base, ext } = splitName(f.name);
      const t = typeForExt(ext);
      last = await api.create({ type: t.type, title: t.type === 'file' ? f.name : base, parent_id: parentId, ext: t.ext || null });
      await api.save(last.id, f, null);
    }
    await app.reload();
    if (last) { app.go({ sel: last.id }); app.toast(files.length > 1 ? `Загружено файлов: ${files.length}` : `Загружен: ${files[0].name}`); }
  });

  const pickFiles = (parentId: string | null) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.onchange = () => input.files?.length && upload(parentId, [...input.files]);
    input.click();
  };

  const rename = (node: GNode) => app.run(async () => {
    const v = await app.ask('Переименовать', [{ name: 'title', label: 'Имя', value: node.title }], 'Сохранить');
    if (v && v.title.trim() !== node.title) { await api.patch(node.id, { title: v.title }); await app.reload(); }
  });

  const remove = (node: GNode) => app.run(async () => {
    const up = node.parent_id;
    await api.trash(node.id);
    if (app.nav.sel === node.id || app.nav.root === node.id) app.go({ root: app.nav.root === node.id ? up : app.nav.root, sel: up });
    await app.reload();
    app.toast(`«${node.title}» в корзине`, { label: 'Вернуть', run: () => app.run(async () => { await api.restore(node.id); await app.reload(); }) });
  });

  // Перенос в другой узел или на верхний уровень (parentId null). Нельзя внутрь самого себя — сервер ответит 400.
  const move = (id: string, parentId: string | null) => app.run(async () => {
    const n = app.ix.byId.get(id);
    if (!n || n.parent_id === parentId || n.id === parentId) return;
    if (parentId && pathOf(app.ix, parentId).some((p) => p.id === id)) throw new Error('Нельзя перенести узел внутрь самого себя');
    await api.patch(id, { parent_id: parentId });
    await app.reload();
    const to = parentId ? app.ix.byId.get(parentId)?.title : null;
    app.toast(to ? `«${n.title}» перенесён в «${to}»` : `«${n.title}» теперь на верхнем уровне`);
  });

  // Перенос через выбор цели — когда перетаскивать неудобно: далеко по дереву или цель не раздел.
  const moveTo = (node: GNode) => app.run(async () => {
    const target = await app.pick(`Куда перенести «${node.title}»`, (n) =>
      n.owner === node.owner && n.id !== node.parent_id && !pathOf(app.ix, n.id).some((p) => p.id === node.id));
    if (target) await move(node.id, target.id);
  });

  // Общий узел: остаётся в своём доме, а здесь появляется ссылкой. Годится и для раздела целиком.
  const addExisting = (holder: GNode) => app.run(async () => {
    const blocked = new Set([holder.id, ...pathOf(app.ix, holder.id).map((p) => p.id), ...(app.ix.kids.get(holder.id) ?? []).map((k) => k.id), ...(app.ix.uses.get(holder.id) ?? [])]);
    const target = await app.pick(`Что показать в «${holder.title}» ссылкой`, (n) => !blocked.has(n.id));
    if (!target) return;
    await api.link(holder.id, target.id);
    await app.reload();
    app.toast(`«${target.title}» теперь виден в «${holder.title}», дом прежний`);
  });
  const unlink = (spaceId: string, target: GNode) => app.run(async () => { await api.unlink(spaceId, target.id); await app.reload(); });

  // Поделиться поддеревом: выбрать можно любого, кто уже входил, или вписать email.
  const shareNode = (node: GNode) => app.run(async () => {
    const v = await app.ask(`Поделиться «${node.title}»`, [
      { name: 'email', label: 'Email', placeholder: 'кто уже входил — в подсказках', options: app.state.users.filter((u) => u !== app.state.me) },
    ], 'Открыть доступ');
    if (!v) return;
    await api.share(node.id, v.email);
    await app.reload();
    app.toast(`«${node.title}» доступен ${v.email.trim().toLowerCase()}: всё внутри, на правку`);
  });
  const unshare = (node: GNode, email: string) => app.run(async () => { await api.unshare(node.id, email); await app.reload(); });

  const createItems = (parent: GNode): MenuItem[] => [
    { label: parent.type === 'space' ? 'Создать' : 'Создать внутри', sep: true },
    { label: 'Раздел', run: () => createIn(parent, 'space') },
    { label: 'Док', run: () => createIn(parent, 'doc') },
    { label: 'Схема', run: () => createIn(parent, 'board') },
    { label: 'Word', run: () => createIn(parent, 'docx') },
    { label: 'Excel', run: () => createIn(parent, 'xlsx') },
    { label: 'PowerPoint', run: () => createIn(parent, 'pptx') },
    { label: 'Ресурс: git, S3, registry…', run: () => createIn(parent, 'resource') },
    { label: '', sep: true },
    { label: 'Загрузить файлы…', run: () => pickFiles(parent.id) },
    { label: 'Добавить существующий ссылкой…', run: () => addExisting(parent) },
  ];

  // Правый клик по пустому месту дерева: создать в текущем корне, без корня — на верхнем уровне.
  const areaItems = (root: GNode | null): MenuItem[] => root ? createItems(root) : [
    { label: 'Верхний уровень', sep: true },
    { label: 'Новый проект', run: () => createIn(null, 'space') },
    { label: 'Загрузить файлы…', run: () => pickFiles(null) },
  ];

  const menuFor = (node: GNode, via?: string): MenuItem[] => {
    if (via) {
      const home = pathOf(app.ix, node.id).slice(0, -1).map((p) => p.title).join(' / ');
      return [
        { label: `Общий узел, дом: ${home}`, sep: true },
        { label: 'Перейти в дом', run: () => app.go({ root: node.parent_id, sel: node.id }) },
        { label: 'Убрать ссылку отсюда', danger: true, run: () => unlink(via, node) },
      ];
    }
    const hasKids = (app.ix.kids.get(node.id) ?? []).length > 0;
    const items: MenuItem[] = [];
    if (node.type === 'space' || hasKids) {
      items.push({ label: 'Сделать корнем', run: () => app.go({ root: node.id }) });
      items.push({ label: 'Граф отсюда', run: () => app.go({ root: node.id, graph: true }) });
    }
    // Детей может иметь любой узел: к репозиторию можно прицепить его доки, к доку — приложения.
    items.push(...createItems(node));
    items.push({ label: '', sep: true });
    items.push({ label: 'Переименовать', run: () => rename(node) });
    const mine = node.owner === app.state.me;
    const shareRoot = isShareRoot(app.ix, node);
    if (mine) {
      items.push({ label: 'Поделиться…', run: () => shareNode(node) });
      for (const s of app.state.sharing.filter((x) => x.node_id === node.id)) {
        items.push({ label: `Закрыть доступ: ${s.email}`, run: () => unshare(node, s.email) });
      }
    } else if (shareRoot) items.push({ label: `Владелец: ${node.owner}`, sep: true });
    // Корень общего раздела удаляет и переносит только владелец, наверх выносит тоже он.
    if (!shareRoot) items.push({ label: 'Перенести в…', run: () => moveTo(node) });
    if (node.parent_id && mine) items.push({ label: 'Вынести на верхний уровень', run: () => move(node.id, null) });
    if (!shareRoot) items.push({ label: 'В корзину', danger: true, run: () => remove(node) });
    return items;
  };

  return { createIn, upload, pickFiles, rename, remove, move, moveTo, addExisting, unlink, shareNode, createItems, areaItems, menuFor };
}
