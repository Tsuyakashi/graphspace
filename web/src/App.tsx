import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Config, type GNode, type State } from './api';
import { AppCtx, AskDialog, Icon, Menu, NodeIcon, Palette, Toasts, openNode, useApp, type Ctx, type Field, type MenuItem, type Nav, type ToastItem } from './ctx';
import { buildIndex, matches, pathOf, scopeOf, treeRows, type Row } from './model';
import { useActions } from './actions';
import { NodeView, Projects } from './NodeView';
import { GraphView } from './Graph';

// Экран целиком описывается адресом: корень, выбранный узел, фильтр по типу, способ показа.
function readNav(): Nav {
  const q = new URLSearchParams(location.search);
  return { root: q.get('root'), sel: q.get('sel'), type: q.get('type') ?? '', show: q.get('show') === 'flat' ? 'flat' : 'tree', graph: q.get('view') === 'graph' };
}
function writeNav(n: Nav) {
  const q = new URLSearchParams();
  if (n.root) q.set('root', n.root);
  if (n.sel && n.sel !== n.root) q.set('sel', n.sel);
  if (n.type) q.set('type', n.type);
  if (n.show === 'flat') q.set('show', 'flat');
  if (n.graph) q.set('view', 'graph');
  const s = q.toString();
  history.pushState(null, '', s ? `?${s}` : location.pathname);
}

const loadCollapsed = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem('gs.collapsed') || '[]')); } catch { return new Set(); } };

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [nav, setNav] = useState<Nav>(readNav);
  const navRef = useRef(nav); navRef.current = nav;
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<{ title: string; fields: Field[]; submit: string; done: (v: Record<string, string> | null) => void } | null>(null);
  const [palette, setPalette] = useState<{ title: string; filter?: (n: GNode) => boolean; done: (n: GNode | null) => void } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => setState(await api.state()), []);
  const toast = useCallback((text: string, action?: ToastItem['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 4000);
  }, []);

  useEffect(() => {
    Promise.all([api.config(), api.state()]).then(([c, s]) => { setConfig(c); setState(s); }).catch((e) => setError(e.message));
    const es = new EventSource('/api/events');
    let t = 0;
    es.onmessage = () => { clearTimeout(t); t = window.setTimeout(() => reload().catch(() => {}), 80); };
    const pop = () => setNav(readNav());
    addEventListener('popstate', pop);
    return () => { es.close(); removeEventListener('popstate', pop); };
  }, [reload]);

  const ix = useMemo(() => (state ? buildIndex(state) : null), [state]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!state || !config || !ix) return null;
    const root = nav.root && ix.byId.has(nav.root) ? nav.root : null;
    const sel = nav.sel && ix.byId.has(nav.sel) ? nav.sel : root;
    return {
      state, ix, config, reload, toast,
      nav: { ...nav, root, sel },
      go: (patch) => {
        const next = { ...navRef.current, ...patch };
        if ('root' in patch && !('sel' in patch)) next.sel = patch.root ?? null;
        writeNav(next); setNav(next);
      },
      ask: (title, fields, submit = 'Готово') => new Promise((resolve) => setDialog({ title, fields, submit, done: (v) => { setDialog(null); resolve(v); } })),
      pick: (title, filter) => new Promise((resolve) => setPalette({ title, filter, done: (n) => { setPalette(null); resolve(n); } })),
      menu: (e, items) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }); },
      run: async (fn) => { try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); } },
    };
  }, [state, config, ix, nav, reload, toast]);

  // Ctrl+K — быстрый переход. Если узел вне текущего корня, корнем становится его проект.
  useEffect(() => {
    if (!ctx) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ctx.pick('Перейти к узлу…').then((n) => n && openNode(ctx, n.id));
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [ctx]);

  if (error) return <div className="boot">Сервер недоступен: {error}</div>;
  if (!ctx) return <div className="boot">Загрузка…</div>;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <Sidebar />
        <main>{ctx.nav.graph ? <GraphView /> : ctx.nav.sel ? <NodeView key={ctx.nav.sel} node={ctx.ix.byId.get(ctx.nav.sel)!} /> : <Projects />}</main>
      </div>
      {dialog && <AskDialog {...dialog} />}
      {palette && <Palette title={palette.title} ix={ctx.ix} nodes={palette.filter ? ctx.state.nodes.filter(palette.filter) : ctx.state.nodes} done={palette.done} />}
      {menu && <Menu {...menu} close={() => setMenu(null)} />}
      <Toasts items={toasts} drop={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </AppCtx.Provider>
  );
}

const CHIPS: [string, string][] = [['', 'Всё'], ['doc', 'Доки'], ['board', 'Схемы'], ['files', 'Файлы'], ['resource', 'Ресурсы']];

function Sidebar() {
  const app = useApp();
  const act = useActions();
  const { ix, nav } = app;
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const root = nav.root ? ix.byId.get(nav.root)! : null;
  const crumbs = root ? pathOf(ix, root.id) : [];

  const scope = useMemo(() => scopeOf(ix, nav.root), [ix, nav.root]);
  const kinds = useMemo(() => [...new Set(scope.filter((s) => s.node.type === 'resource' && s.node.props.kind).map((s) => s.node.props.kind as string))].sort(), [scope]);
  const chips = [...CHIPS, ...kinds.map((k) => [`kind:${k}`, k] as [string, string])]
    .map(([f, label]) => ({ f, label, count: f ? scope.filter((s) => matches(s.node, f)).length : scope.length }))
    .filter((c) => !c.f || c.count > 0 || c.f === nav.type);

  const rows = useMemo(() => treeRows(ix, nav.root, nav.type, collapsed), [ix, nav.root, nav.type, collapsed]);
  const flat = useMemo(() => scope.filter((s) => (nav.type ? matches(s.node, nav.type) : s.node.type !== 'space')), [scope, nav.type]);

  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem('gs.collapsed', JSON.stringify([...n])); } catch { /* без хранилища просто не запомним */ }
    return n;
  });

  return (
    <aside>
      <div className="side-head">
        <button className="brand" onClick={() => app.go({ root: null, type: '' })}>Graphspace</button>
        <button className="ghost" title="Быстрый переход (Ctrl+K)" onClick={() => app.pick('Перейти к узлу…').then((n) => n && openNode(app, n.id))}>
          <Icon name="search" /><kbd>Ctrl K</kbd>
        </button>
      </div>

      <nav className="crumbs" aria-label="Корень отображения">
        <button className={!root ? 'here' : ''} onClick={() => app.go({ root: null })}>Все проекты</button>
        {crumbs.map((c) => (
          <span key={c.id}><Icon name="chev" className="sep" />
            <button className={c.id === nav.root ? 'here' : ''} onClick={() => app.go({ root: c.id })}>{c.title}</button></span>
        ))}
      </nav>

      <div className="chips">
        {chips.map((c) => (
          <button key={c.f} className={c.f === nav.type ? 'on' : ''} onClick={() => app.go({ type: c.f })}>{c.label}<i>{c.count}</i></button>
        ))}
      </div>

      <div className="side-tools">
        <div className="seg">
          <button className={nav.show === 'tree' ? 'on' : ''} onClick={() => app.go({ show: 'tree' })}>Дерево</button>
          <button className={nav.show === 'flat' ? 'on' : ''} onClick={() => app.go({ show: 'flat' })}>Список</button>
        </div>
        <button className={nav.graph ? 'on' : ''} title="Показать область графом" onClick={() => app.go({ graph: !nav.graph })}><Icon name="graph" />Граф</button>
        <button className="ghost" title="Создать здесь" onClick={(e) => (root ? app.menu(e, act.createItems(root)) : act.createIn(null, 'space'))}>
          <Icon name="plus" />{root ? 'Создать' : 'Проект'}
        </button>
      </div>

      <div className="tree" role="tree">
        {root && (
          <div className={`row root-row ${nav.sel === root.id ? 'sel' : ''}`} onClick={() => app.go({ sel: root.id })}
            onContextMenu={(e) => app.menu(e, act.menuFor(root))} {...dropProps(root, act)}>
            <Icon name="root" className="t-space" /><span className="title">{root.title}</span>
            {root.props.label && <span className="label">{root.props.label}</span>}
          </div>
        )}
        {nav.show === 'tree'
          ? rows.map((r) => <TreeRow key={r.node.id + (r.via ?? '')} row={r} toggle={toggle} />)
          : flat.map((s) => <TreeRow key={s.node.id} row={{ node: s.node, depth: 0, via: s.via }} toggle={toggle} flatRoot={nav.root} />)}
        {(nav.show === 'tree' ? rows.length : flat.length) === 0 && (
          <div className="empty">{nav.type ? 'В этой области таких узлов нет' : root ? 'Пусто. Создайте что-нибудь кнопкой выше.' : 'Проектов пока нет'}</div>
        )}
      </div>
    </aside>
  );
}

// Перенос узла в контейнер и загрузка файлов с диска — одним и тем же жестом.
function dropProps(node: GNode, act: ReturnType<typeof useActions>) {
  if (node.type !== 'space') return {};
  return {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.currentTarget.classList.add('drop'); },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      e.currentTarget.classList.remove('drop');
      if (e.dataTransfer.files.length) act.upload(node, [...e.dataTransfer.files]);
      else { const id = e.dataTransfer.getData('application/x-graphspace-node'); if (id) act.move(id, node); }
    },
  };
}

function TreeRow({ row, toggle, flatRoot }: { row: Row; toggle: (id: string) => void; flatRoot?: string | null }) {
  const app = useApp();
  const act = useActions();
  const { node, depth, via } = row;
  const isSpace = node.type === 'space';
  const canRoot = !via && (isSpace || (app.ix.kids.get(node.id) ?? []).length > 0);
  const where = flatRoot !== undefined ? pathOf(app.ix, node.id, flatRoot).slice(0, -1).map((p) => p.title).join(' / ') : '';
  return (
    <div role="treeitem" aria-selected={app.nav.sel === node.id}
      className={`row ${app.nav.sel === node.id ? 'sel' : ''} ${via ? 'shared' : ''}`}
      style={{ paddingLeft: 10 + depth * 16 }}
      draggable={!via}
      onDragStart={(e) => { e.dataTransfer.setData('application/x-graphspace-node', node.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => app.go({ sel: node.id })}
      onDoubleClick={() => canRoot && app.go({ root: node.id })}
      onContextMenu={(e) => app.menu(e, act.menuFor(node, via))}
      {...(via ? {} : dropProps(node, act))}>
      {flatRoot === undefined && (
        <button className={`twisty ${row.open ? 'open' : ''}`} style={{ visibility: row.expandable ? 'visible' : 'hidden' }} aria-label={row.open ? 'Свернуть' : 'Развернуть'}
          onClick={(e) => { e.stopPropagation(); toggle(node.id); }}><Icon name="chev" /></button>
      )}
      <NodeIcon node={node} />
      <span className="title">{node.title}</span>
      {isSpace && node.props.label && <span className="label">{node.props.label}</span>}
      {node.type === 'resource' && node.props.kind && <span className="label">{node.props.kind}</span>}
      {where && <span className="label where">{where}</span>}
      {via && <span className="badge" title="Общий узел: показан ссылкой, дом в другом месте"><Icon name="shared" />общий</span>}
      <span className="row-actions">
        {canRoot && <button title="Сделать корнем" onClick={(e) => { e.stopPropagation(); app.go({ root: node.id }); }}><Icon name="root" /></button>}
        {isSpace && !via && <button title="Создать внутри" onClick={(e) => { e.stopPropagation(); app.menu(e, act.createItems(node)); }}><Icon name="plus" /></button>}
        <button title="Действия" onClick={(e) => { e.stopPropagation(); app.menu(e, act.menuFor(node, via)); }}><Icon name="more" /></button>
      </span>
    </div>
  );
}

