// Действия над узлами: создание, загрузка, переименование, удаление, ссылки, меню.
import { api, type GNode } from './api';
import { useApp, type MenuItem } from './ctx';
import { pathOf, splitName, typeForExt } from './model';

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

  const upload = (parent: GNode, files: File[]) => app.run(async () => {
    let last: GNode | null = null;
    for (const f of files) {
      const { base, ext } = splitName(f.name);
      const t = typeForExt(ext);
      last = await api.create({ type: t.type, title: t.type === 'file' ? f.name : base, parent_id: parent.id, ext: t.ext || null });
      await api.save(last.id, f, null);
    }
    await app.reload();
    if (last) { app.go({ sel: last.id }); app.toast(files.length > 1 ? `Загружено файлов: ${files.length}` : `Загружен: ${files[0].name}`); }
  });

  const pickFiles = (parent: GNode) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.onchange = () => input.files?.length && upload(parent, [...input.files]);
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

  const move = (id: string, parent: GNode) => app.run(async () => {
    const n = app.ix.byId.get(id);
    if (!n || n.parent_id === parent.id || n.id === parent.id) return;
    await api.patch(id, { parent_id: parent.id });
    await app.reload();
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
    { label: 'Загрузить файлы…', run: () => pickFiles(parent) },
    { label: 'Добавить существующий ссылкой…', run: () => addExisting(parent) },
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
    if (node.parent_id) items.push({ label: 'Вынести на верхний уровень', run: () => app.run(async () => { await api.patch(node.id, { parent_id: null }); await app.reload(); }) });
    items.push({ label: 'В корзину', danger: true, run: () => remove(node) });
    return items;
  };

  return { createIn, upload, pickFiles, rename, remove, move, addExisting, unlink, createItems, menuFor };
}
