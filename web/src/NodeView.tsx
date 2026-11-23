// Правая часть: шапка узла и содержимое по типу.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, shell, type GNode, type Version } from './api';
import { Icon, NodeIcon, openNode, useApp } from './ctx';
import { useActions, RESOURCE_KINDS } from './actions';
import { FILE_TYPES, SHARED, fmtSize, fmtTime, matches, pathOf, scopeOf, TYPE_LABEL } from './model';
import { Markdown } from './Markdown';
import { CraftView } from './Craft';
import { WebPane } from './WebPane';

const BoardEditor = lazy(() => import('./Board'));

export function Projects() {
  const app = useApp();
  const act = useActions();
  const projects = app.ix.kids.get(null) ?? [];
  const shared = app.ix.kids.get(SHARED) ?? [];
  return (
    <div className="page fill" onContextMenu={(e) => { if (!e.defaultPrevented) app.menu(e, act.areaItems(null)); }}>
      <h1>Проекты</h1>
      <div className="cards">
        {projects.map((p) => (
          <button key={p.id} className="card" onClick={() => app.go({ root: p.id })} onContextMenu={(e) => app.menu(e, act.menuFor(p))}>
            <NodeIcon node={p} /><b>{p.title}</b>
            <span className="muted">{p.props.label ? `${p.props.label} · ` : ''}узлов: {scopeOf(app.ix, p.id).length}</span>
          </button>
        ))}
        <button className="card add" onClick={() => act.createIn(null, 'space')}><Icon name="plus" /><b>Новый проект</b></button>
      </div>
      {shared.length > 0 && <>
        <h2>Доступно мне</h2>
        <div className="cards">
          {shared.map((p) => (
            <button key={p.id} className="card" onClick={() => app.go({ root: p.id })} onContextMenu={(e) => app.menu(e, act.menuFor(p))}>
              <NodeIcon node={p} /><b>{p.title}</b>
              <span className="muted">{p.owner} · узлов: {scopeOf(app.ix, p.id).length}</span>
            </button>
          ))}
        </div>
      </>}
    </div>
  );
}

export function NodeView({ node }: { node: GNode }) {
  const app = useApp();
  const act = useActions();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const crumbs = pathOf(app.ix, node.id).slice(0, -1);
  const usedBy = (app.ix.usedBy.get(node.id) ?? []).map((id) => app.ix.byId.get(id)).filter((n): n is GNode => !!n);
  const craft = app.config.craftByExt[node.ext ?? ''];
  const nativeOpen = app.state.checkouts.includes(node.id);
  const hasContent = node.type !== 'space' && node.type !== 'resource';
  const kids = app.ix.kids.get(node.id) ?? [];
  const canRoot = node.type === 'space' || kids.length > 0;

  return (
    <div className="node">
      <header className="node-head">
        <div className="node-path">
          {crumbs.map((c) => <span key={c.id}><button onClick={() => openNode(app, c.id)}>{c.title}</button><Icon name="chev" className="sep" /></span>)}
        </div>
        <div className="node-title">
          <NodeIcon node={node} />
          <h1 title="Переименовать" onClick={() => act.rename(node)}>{node.title}</h1>
          <span className="label">{node.type === 'space' ? node.props.label || 'раздел' : node.type === 'resource' ? node.props.kind : node.ext ?? TYPE_LABEL[node.type]}</span>
          {usedBy.length > 0 && <span className="badge" title="Узел показан ссылкой в других разделах"><Icon name="shared" />общий: {usedBy.map((u) => u.title).join(', ')}</span>}
          <span className="grow" />
          <span className="slot" ref={setSlot} />
          {canRoot && app.nav.root !== node.id && <button onClick={() => app.go({ root: node.id })}><Icon name="root" />Сделать корнем</button>}
          {canRoot && <button onClick={() => app.go({ root: node.id, graph: true })}><Icon name="graph" />Граф отсюда</button>}
          {craft && app.config.native[craft] && node.head != null && (
            <button disabled={nativeOpen} title="Файл выгружается, открывается в нативном приложении, каждое сохранение становится версией"
              onClick={() => app.run(async () => { await api.openNative(node.id); await app.reload(); app.toast(`Открывается в ${craft}. Сохранения вернутся сюда версиями.`); })}>
              {nativeOpen ? `Открыт в ${craft}` : 'Открыть нативно'}
            </button>
          )}
          {hasContent && node.head != null && <a className="btn" href={api.contentUrl(node.id, null, true)}>Скачать</a>}
          {(node.type === 'doc' || node.type === 'space') && (
            <a className="btn" href={api.exportUrl(node.id)} title={node.type === 'doc' ? 'Один md: вставки раскрыты текстом, как на экране' : 'Zip всей области раздела, открывается в Obsidian как хранилище'}>Экспорт</a>
          )}
          {hasContent && <button className={showVersions ? 'on' : ''} onClick={() => setShowVersions((v) => !v)}>Версии{node.head ? ` · v${node.head}` : ''}</button>}
          <button title="Действия" onClick={(e) => app.menu(e, act.menuFor(node))}><Icon name="more" /></button>
        </div>
        {node.type !== 'space' && kids.length > 0 && (
          <div className="node-kids">
            <span className="muted">Вложено:</span>
            {kids.map((k) => <button key={k.id} className="pill" onClick={() => app.go({ sel: k.id })}><NodeIcon node={k} />{k.title}</button>)}
          </div>
        )}
      </header>
      <div className="node-body">
        <div className="node-main">
          {node.type === 'space' && <SpaceView node={node} />}
          {node.type === 'doc' && <DocView node={node} slot={slot} />}
          {node.type === 'board' && <Suspense fallback={<div className="pane-note">Редактор схем загружается…</div>}><BoardEditor node={node} slot={slot} /></Suspense>}
          {(node.type === 'office' || node.type === 'pdf' || node.type === 'design' || (node.type === 'file' && craft)) && <CraftView node={node} slot={slot} />}
          {node.type === 'file' && !craft && <FileView node={node} />}
          {node.type === 'resource' && <ResourceView node={node} slot={slot} />}
        </div>
        {showVersions && <VersionsPanel node={node} close={() => setShowVersions(false)} />}
      </div>
    </div>
  );
}

// ---------- текстовый док ----------
function DocView({ node, slot }: { node: GNode; slot: HTMLElement | null }) {
  const app = useApp();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const inflight = useRef<Promise<boolean> | null>(null);
  const sent = useRef<string | null>(null); // последний текст, который сервер принял (в т.ч. конфликтной версией)
  const live = useRef({ text, saved, base }); live.current = { text, saved, base };
  const dirty = text !== null && text !== saved;
  const unsent = () => { const { text: t, saved: s } = live.current; return t !== null && t !== s && t !== sent.current; };

  const load = useCallback(async () => {
    const r = await api.text(node.id).catch(() => ({ text: '', version: 0 }));
    setText(r.text); setSaved(r.text); setBase(r.version || null);
    sent.current = r.text;
    return r.text;
  }, [node.id]);
  useEffect(() => { load().then((t) => setEdit(t.trim().split('\n').length <= 1)); }, [load]);
  useEffect(() => {
    const { text: t, saved: s, base: b } = live.current;
    if (t !== null && !busy.current && t === s && node.head !== b) load();
  }, [node.head, load]);

  // true — правки на сервере (или их нет). Идущее сохранение не пропускается: ждём его и досохраняем остаток.
  const save = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current.then(() => save());
    if (!unsent()) return Promise.resolve(true);
    const { text: t, base: b } = live.current;
    const run = (async () => {
      busy.current = true;
      try {
        const r = await api.save(node.id, t!, b);
        sent.current = t;
        if (r.conflict) app.toast('На сервере уже другая версия. Ваш текст сохранён рядом как конфликтная версия.');
        else { setSaved(t!); setBase(r.version.n); live.current = { ...live.current, saved: t!, base: r.version.n }; }
        if (!r.unchanged) app.reload().catch(() => {}); // head и «Версии · vN» сразу, не ждём события
        return true;
      } catch (e) {
        app.toast(e instanceof Error ? e.message : String(e));
        return false;
      } finally { busy.current = false; inflight.current = null; }
    })();
    inflight.current = run;
    return run;
  }, [node.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } };
    addEventListener('keydown', key);
    return () => { removeEventListener('keydown', key); save(); }; // страховка: размонтирование тоже сохраняет
  }, [save]);

  // Уход на другой узел или граф ждёт сохранения. Не вышло — спрашиваем.
  useEffect(() => app.guard(async () => {
    if (await save()) return true;
    return !!(await app.ask(`Не удалось сохранить «${node.title}». Уйти без сохранения?`, [], 'Уйти без сохранения'));
  }), [save]);

  // Закрытие вкладки: браузер переспросит, а если уйти — правка уходит запросом, который переживает страницу.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => { if (unsent()) e.preventDefault(); };
    const flush = () => { if (unsent()) api.saveOnExit(node.id, live.current.text!, live.current.base); };
    addEventListener('beforeunload', ask); addEventListener('pagehide', flush);
    return () => { removeEventListener('beforeunload', ask); removeEventListener('pagehide', flush); };
  }, [node.id]);

  const insert = async () => {
    const n = await app.pick('Что вставить в док', (x) => x.id !== node.id);
    if (!n || text === null) return;
    const snippet = n.type === 'space' ? `![[${n.id}|type=doc]]` : `![[${n.id}]]`;
    const at = area.current?.selectionStart ?? text.length;
    const before = text.slice(0, at), after = text.slice(at);
    setText(`${before}${before && !before.endsWith('\n') ? '\n' : ''}\n${snippet}\n${after.startsWith('\n') ? '' : '\n'}${after}`);
  };

  const refs = useMemo(() => {
    const ids = [...new Set([...(text ?? '').matchAll(/\[\[([a-z0-9]{6,})/g)].map((m) => m[1]))];
    return ids.map((id) => ({ id, node: app.ix.byId.get(id) }));
  }, [text, app.ix]);

  if (text === null) return <div className="pane-note">Загрузка…</div>;
  return (
    <div className={`doc ${edit ? 'editing' : ''}`}>
      {slot && createPortal(<>
        {edit && <button onClick={insert}>Вставить узел</button>}
        {edit && <button className={dirty ? 'primary' : ''} disabled={!dirty} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        <button className={edit ? 'on' : ''} onClick={() => { if (edit) save(); setEdit(!edit); }}>{edit ? 'Готово' : 'Править'}</button>
      </>, slot)}
      {dirty && node.head !== base && <div className="banner">Пока вы правили, на сервере появилась версия v{node.head}. Ваше сохранение ляжет рядом конфликтной версией.</div>}
      {edit && (
        <div className="doc-edit">
          <textarea ref={area} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} aria-label="Текст дока в markdown" />
          {refs.length > 0 && (
            <div className="doc-refs">
              <span className="muted">Узлы в тексте:</span>
              {refs.map((r) => <span key={r.id}><code>{r.id}</code> {r.node ? r.node.title : 'не найден'}</span>)}
            </div>
          )}
        </div>
      )}
      <div className="doc-read"><Markdown text={text} chain={[node.id]} /></div>
    </div>
  );
}

// ---------- раздел ----------
const GROUPS: [string, string][] = [['space', 'Разделы'], ['doc', 'Доки'], ['board', 'Схемы'], ['files', 'Файлы'], ['resource', 'Ресурсы']];
function SpaceView({ node }: { node: GNode }) {
  const app = useApp();
  const act = useActions();
  const kids = app.ix.kids.get(node.id) ?? [];
  const shared = (app.ix.uses.get(node.id) ?? []).map((id) => app.ix.byId.get(id)).filter((n): n is GNode => !!n);
  const scope = scopeOf(app.ix, node.id);
  const totals = GROUPS.slice(1).map(([f, label]) => ({ f, label, count: scope.filter((s) => matches(s.node, f)).length })).filter((t) => t.count);
  const card = (n: GNode, via?: boolean) => (
    <button key={n.id} className="card" onClick={() => app.go({ sel: n.id })} onDoubleClick={() => n.type === 'space' && !via && app.go({ root: n.id })}
      onContextMenu={(e) => app.menu(e, act.menuFor(n, via ? node.id : undefined))}>
      <NodeIcon node={n} /><b>{n.title}</b>
      <span className="muted">
        {n.type === 'space' ? `${n.props.label ? n.props.label + ' · ' : ''}узлов: ${scopeOf(app.ix, n.id).length}`
          : n.type === 'resource' ? n.props.kind : FILE_TYPES.includes(n.type) ? n.ext : TYPE_LABEL[n.type]}
        {via ? ` · дом: ${pathOf(app.ix, n.id).slice(0, -1).map((p) => p.title).join(' / ')}` : ''}
      </span>
    </button>
  );
  return (
    <div className="page fill" onDragOver={(e) => e.preventDefault()}
      onContextMenu={(e) => { if (!e.defaultPrevented) app.menu(e, act.createItems(node)); }}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) act.upload(node.id, [...e.dataTransfer.files]); }}>
      <div className="space-bar">
        <span className="muted">Во всей области:</span>
        {totals.length ? totals.map((t) => (
          <button key={t.f} className="pill" title="Показать только это в дереве от этого раздела" onClick={() => app.go({ root: node.id, type: t.f })}>{t.label}<i>{t.count}</i></button>
        )) : <span className="muted">пока пусто</span>}
        <span className="grow" />
        <button onClick={(e) => app.menu(e, act.createItems(node))}><Icon name="plus" />Создать</button>
      </div>
      {GROUPS.map(([f, label]) => {
        const list = kids.filter((k) => matches(k, f));
        return list.length ? <section key={f}><h2>{label}</h2><div className="cards">{list.map((n) => card(n))}</div></section> : null;
      })}
      {shared.length > 0 && <section><h2>Общие, по ссылке</h2><div className="cards">{shared.map((n) => card(n, true))}</div></section>}
      {!kids.length && !shared.length && <p className="muted">Здесь пока ничего нет. Создайте узел или перетащите сюда файлы.</p>}
    </div>
  );
}

// ---------- внешний ресурс ----------
// В десктоп-оболочке сам сайт открывается справа, свойства — по кнопке. В браузере — только свойства:
// GitHub и подобные запрещают встраивание во фрейм.
function ResourceView({ node, slot }: { node: GNode; slot: HTMLElement | null }) {
  const url = node.props.url ?? '';
  const live = !!shell && /^https?:\/\//i.test(url);
  const [props, setProps] = useState(!live);
  return <>
    {live && slot && createPortal(<button className={props ? 'on' : ''} onClick={() => setProps((v) => !v)}>Свойства</button>, slot)}
    {live && !props ? <WebPane url={url} /> : <ResourceProps node={node} />}
  </>;
}

function ResourceProps({ node }: { node: GNode }) {
  const app = useApp();
  const act = useActions();
  const [p, setP] = useState({ kind: node.props.kind ?? '', url: node.props.url ?? '', note: node.props.note ?? '' });
  const dirty = p.kind !== (node.props.kind ?? '') || p.url !== (node.props.url ?? '') || p.note !== (node.props.note ?? '');
  const save = () => app.run(async () => { await api.patch(node.id, { props: { ...p, kind: p.kind.trim().toLowerCase() } }); await app.reload(); });
  const home = node.parent_id ? app.ix.byId.get(node.parent_id) : null;
  const usedBy = (app.ix.usedBy.get(node.id) ?? []).map((id) => app.ix.byId.get(id)).filter((n): n is GNode => !!n);
  const safeUrl = /^https?:\/\//i.test(p.url);
  return (
    <div className="page narrow">
      <p className="muted">Внешняя система. Платформа хранит только ссылку и свойства, сам ресурс остаётся там, где живёт.
        {!shell && ' Внутри Graphspace сайт открывается в десктоп-оболочке (desktop/).'}</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label><span>Вид</span>
          <input value={p.kind} list="kinds" onChange={(e) => setP({ ...p, kind: e.target.value })} />
          <datalist id="kinds">{RESOURCE_KINDS.map((k) => <option key={k} value={k} />)}</datalist>
        </label>
        <label><span>Ссылка</span><input value={p.url} placeholder="https://…" onChange={(e) => setP({ ...p, url: e.target.value })} /></label>
        <label><span>Заметка</span><textarea rows={3} value={p.note} onChange={(e) => setP({ ...p, note: e.target.value })} /></label>
        <div className="form-actions">
          {safeUrl && <a className="btn" href={p.url} target="_blank" rel="noopener noreferrer">Открыть</a>}
          <button type="submit" className="primary" disabled={!dirty}>Сохранить</button>
        </div>
      </form>
      <h2>Где виден</h2>
      <ul className="where-list">
        {home && <li><button onClick={() => openNode(app, home.id)}>{pathOf(app.ix, home.id).map((x) => x.title).join(' / ')}</button><span className="label">дом</span></li>}
        {usedBy.map((u) => (
          <li key={u.id}><button onClick={() => openNode(app, u.id)}>{pathOf(app.ix, u.id).map((x) => x.title).join(' / ')}</button>
            <span className="label">ссылка</span><button className="ghost danger" onClick={() => act.unlink(u.id, node)}>убрать</button></li>
        ))}
      </ul>
    </div>
  );
}

function FileView({ node }: { node: GNode }) {
  const isImage = /^(png|jpe?g|gif|webp|svg)$/.test(node.ext ?? '');
  if (!node.head) return <div className="pane-note">У файла пока нет содержимого.</div>;
  return (
    <div className="page">
      {isImage ? <img className="file-img" src={api.contentUrl(node.id, node.head)} alt={node.title} />
        : <div className="pane-note"><p>Для этого формата нет просмотра.</p><a className="btn" href={api.contentUrl(node.id, null, true)}>Скачать</a></div>}
    </div>
  );
}

// ---------- версии и снапшоты ----------
function VersionsPanel({ node, close }: { node: GNode; close: () => void }) {
  const app = useApp();
  const [list, setList] = useState<Version[] | null>(null);
  const load = useCallback(() => api.versions(node.id).then(setList).catch(() => setList([])), [node.id]);
  useEffect(() => { load(); }, [load, node.head, node.updated_at]);
  const name = (v: Version) => app.run(async () => {
    const r = await app.ask(`Снапшот v${v.n}`, [{ name: 'name', label: 'Имя снапшота', value: v.name ?? '', optional: true, placeholder: 'например: отправлено заказчику' }], 'Сохранить');
    if (r) { await api.nameVersion(node.id, v.n, r.name); await load(); }
  });
  const restore = (v: Version) => app.run(async () => { await api.restoreVersion(node.id, v.n); await app.reload(); app.toast(`Содержимое v${v.n} стало новой версией`); });
  return (
    <aside className="versions">
      <header><b>Версии</b><span className="grow" /><button className="ghost" onClick={close}>Закрыть</button></header>
      <p className="muted">Сохранение ничего не перезаписывает. Версия с именем — это снапшот.</p>
      {list?.map((v) => (
        <div key={v.n} className={`version ${v.n === node.head ? 'head' : ''}`}>
          <div><b>v{v.n}</b>{v.n === node.head && <span className="label">текущая</span>}{v.name && <span className="snap">{v.name}</span>}</div>
          <div className="muted">{fmtTime(v.created_at)} · {v.author} · {fmtSize(v.size)}</div>
          <div className="version-actions">
            <button className="ghost" onClick={() => name(v)}>{v.name ? 'Переименовать' : 'Назвать'}</button>
            <a className="ghost" href={api.contentUrl(node.id, v.n, true)}>Скачать</a>
            {v.n !== node.head && <button className="ghost" onClick={() => restore(v)}>Вернуть</button>}
          </div>
        </div>
      ))}
      {list && !list.length && <p className="muted">Версий пока нет.</p>}
    </aside>
  );
}
