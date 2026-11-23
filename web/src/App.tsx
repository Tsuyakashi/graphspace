import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Config, type GNode, type State } from './api';
import { AppCtx, AskDialog, Icon, Menu, NodeIcon, Palette, Toasts, openNode, useApp, type Ctx, type Field, type LeaveGuard, type MenuItem, type Nav, type ToastItem } from './ctx';
import { SHARED, buildIndex, isShareRoot, matches, pathOf, scopeOf, treeRows, type Row } from './model';
import { useActions } from './actions';
import { NodeView, Projects } from './NodeView';
import { GraphView } from './Graph';

// Экран целиком описывается адресом: корень, выбранный узел, фильтр по типу, граф или содержимое.
function readNav(): Nav {
  const q = new URLSearchParams(location.search);
  return { root: q.get('root'), sel: q.get('sel'), type: q.get('type') ?? '', graph: q.get('view') === 'graph' };
}
function urlOf(n: Nav) {
  const q = new URLSearchParams();
  if (n.root) q.set('root', n.root);
  if (n.sel && n.sel !== n.root) q.set('sel', n.sel);
  if (n.type) q.set('type', n.type);
  if (n.graph) q.set('view', 'graph');
  const s = q.toString();
  return s ? `?${s}` : location.pathname;
}
const writeNav = (n: Nav) => history.pushState(null, '', urlOf(n));
// Что показано справа. Смена этого снимает открытый редактор — перед ней срабатывает защита ухода.
const screenOf = (n: Nav) => (n.graph ? '#graph' : n.sel ?? n.root ?? '');

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
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const leaving = useRef(false);

  // Переход с проверкой: если справа редактор с правками, он сначала сохраняет их.
  const navigate = useCallback((next: Nav, push: boolean) => {
    const apply = () => { if (push) writeNav(next); setNav(next); };
    const g = leaveGuard.current;
    if (!g || screenOf(next) === screenOf(navRef.current)) return apply();
    if (leaving.current) return;
    leaving.current = true;
    g().then((ok) => { if (ok) apply(); }).finally(() => { leaving.current = false; });
  }, []);
  const guard = useCallback((fn: LeaveGuard) => {
    leaveGuard.current = fn;
    return () => { if (leaveGuard.current === fn) leaveGuard.current = null; };
  }, []);

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
    // Поток мог отвалиться (прокси, сон ноутбука): EventSource переподключается сам, а пропущенное
    // догоняем перечитыванием при переподключении и при возврате на вкладку.
    let lost = false;
    es.onerror = () => { if (!lost) console.warn('graphspace: поток /api/events прервался, переподключаюсь'); lost = true; };
    es.onopen = () => { if (lost) { lost = false; reload().catch(() => {}); } };
    const back = () => { if (document.visibilityState === 'visible') reload().catch(() => {}); };
    document.addEventListener('visibilitychange', back);
    // «Назад» в браузере: адрес уже сменился. Возвращаем текущий, а переход делаем через защиту.
    const pop = () => {
      const next = readNav();
      if (!leaveGuard.current || screenOf(next) === screenOf(navRef.current)) return setNav(next);
      history.pushState(null, '', urlOf(navRef.current));
      navigate(next, true);
    };
    addEventListener('popstate', pop);
    return () => { es.close(); removeEventListener('popstate', pop); document.removeEventListener('visibilitychange', back); };
  }, [reload, navigate]);

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
        navigate(next, true);
      },
      guard,
      ask: (title, fields, submit = 'Готово') => new Promise((resolve) => setDialog({ title, fields, submit, done: (v) => { setDialog(null); resolve(v); } })),
      pick: (title, filter) => new Promise((resolve) => setPalette({ title, filter, done: (n) => { setPalette(null); resolve(n); } })),
      menu: (e, items) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }); },
      run: async (fn) => { try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); } },
    };
  }, [state, config, ix, nav, reload, toast, navigate, guard]);

  // Ctrl+K — быстрый переход. Если узел вне текущего корня, корнем становится его проект.
  useEffect(() => {
    if (!ctx) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
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
  // Без корня ниже своего — то, чем поделились другие.
  const sharedRows = useMemo(() => (nav.root ? [] : treeRows(ix, SHARED, nav.type, collapsed)), [ix, nav.root, nav.type, collapsed]);

  const keep = (n: Set<string>) => {
    try { localStorage.setItem('gs.collapsed', JSON.stringify([...n])); } catch { /* без хранилища просто не запомним */ }
    return n;
  };
  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    n.has(id) ? n.delete(id) : n.add(id);
    return keep(n);
  });
  // Как «Collapse Folders» в VS Code: сворачивает всё, у чего есть дети, корень остаётся раскрытым.
  const collapseAll = () => setCollapsed(keep(new Set([...ix.kids.keys()].filter((k): k is string => typeof k === 'string' && k !== SHARED))));

  return (
    <aside>
      <div className="side-head">
        <button className="brand" onClick={() => app.go({ root: null, type: '' })}>Graphspace</button>
        <button className="ghost" title="Быстрый переход (Ctrl+K)" onClick={() => app.pick('Перейти к узлу…').then((n) => n && openNode(app, n.id))}>
          <Icon name="search" /><kbd>Ctrl K</kbd>
        </button>
      </div>

      <nav className="crumbs" aria-label="Корень отображения">
        <button className={!root ? 'here' : ''} title="Сюда можно перетащить узел — он станет проектом верхнего уровня"
          onClick={() => app.go({ root: null })} {...dropProps(null, act)}>Все проекты</button>
        {crumbs.map((c) => (
          <span key={c.id}><Icon name="chev" className="sep" />
            <button className={c.id === nav.root ? 'here' : ''} onClick={() => app.go({ root: c.id })} {...dropProps(c.id, act)}>{c.title}</button></span>
        ))}
      </nav>

      <div className="chips">
        {chips.map((c) => (
          <button key={c.f} className={c.f === nav.type ? 'on' : ''} onClick={() => app.go({ type: c.f })}>{c.label}<i>{c.count}</i></button>
        ))}
      </div>

      <div className="side-tools">
        <div className="seg view-switch" role="group" aria-label="Что показать справа">
          <button className={!nav.graph ? 'on' : ''} aria-pressed={!nav.graph} title="Открытый узел или список проектов" onClick={() => app.go({ graph: false })}><Icon name="doc" />Explorer</button>
          <button className={nav.graph ? 'on' : ''} aria-pressed={nav.graph} title="Область графом" onClick={() => app.go({ graph: true })}><Icon name="graph" />Graph</button>
        </div>
        <span className="side-actions">
          <button className="ghost" title="Создать здесь" onClick={(e) => (root ? app.menu(e, act.createItems(root)) : act.createIn(null, 'space'))}>
            <Icon name="plus" />{root ? 'Создать' : 'Проект'}
          </button>
          <button className="ghost collapse-all" title="Свернуть всё" aria-label="Свернуть всё" onClick={collapseAll}><Icon name="collapse" /></button>
        </span>
      </div>

      {/* Пустое место дерева — тоже цель переноса: в текущий корень, без корня — на верхний уровень. */}
      <div className="tree" role="tree" {...dropProps(nav.root, act, true)}
        onContextMenu={(e) => { if (!(e.target instanceof Element && e.target.closest('.row'))) app.menu(e, act.areaItems(root)); }}>
        {root && (
          <div className={`row root-row ${nav.sel === root.id ? 'sel' : ''}`} onClick={() => app.go({ sel: root.id })}
            onContextMenu={(e) => app.menu(e, act.menuFor(root))} {...dropProps(root.id, act)}>
            <Icon name="root" className="t-space" /><span className="title">{root.title}</span>
            {root.props.label && <span className="label">{root.props.label}</span>}
          </div>
        )}
        {rows.map((r) => <TreeRow key={r.node.id + (r.via ?? '')} row={r} toggle={toggle} />)}
        {sharedRows.length > 0 && <>
          <div className="tree-sep">Доступно мне</div>
          {sharedRows.map((r) => <TreeRow key={'s' + r.node.id + (r.via ?? '')} row={r} toggle={toggle} />)}
        </>}
        {rows.length + sharedRows.length === 0 && (
          <div className="empty">{nav.type ? 'В этой области таких узлов нет' : root ? 'Пусто. Создайте что-нибудь кнопкой выше.' : 'Проектов пока нет'}</div>
        )}
      </div>
      <UserBadge />
    </aside>
  );
}

// Кто вошёл. Email — из состояния; за Cloudflare Access страница спрашивает у Access имя и провайдера
// входа (GitHub и т. п.) — эндпоинт get-identity есть на любом домене за Access и читает его куку.
const IDP: Record<string, string> = { github: 'GitHub', google: 'Google', 'google-apps': 'Google', azureAD: 'Microsoft', onetimepin: 'код на почту', oidc: 'OIDC', saml: 'SAML' };
function UserBadge() {
  const app = useApp();
  const [idp, setIdp] = useState<{ name?: string; type?: string } | null>(null);
  const cf = app.config.auth === 'cf';
  useEffect(() => {
    if (!cf) return;
    fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setIdp({ name: typeof j.name === 'string' ? j.name : undefined, type: j.idp?.type }))
      .catch(() => {});
  }, [cf]);
  const me = app.state.me;
  const name = idp?.name || me;
  const via = !cf ? 'dev-режим, без входа' : idp?.type ? `через ${IDP[idp.type] ?? idp.type}` : 'Cloudflare Access';
  return (
    <div className="side-user" title={me}>
      <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      <span className="who"><b>{name}</b><small>{name !== me ? `${me} · ` : ''}{via}</small></span>
      {cf && <a className="ghost" href="/cdn-cgi/access/logout" title="Выйти из Cloudflare Access">Выйти</a>}
    </div>
  );
}

// Перенос узла и загрузка файлов с диска — одним и тем же жестом. target — новый родитель, null — верхний уровень.
// area — подложка дерева: срабатывает только на пустом месте, строки обрабатывают бросок сами.
function dropProps(target: string | null | undefined, act: ReturnType<typeof useActions>, area = false) {
  if (target === undefined) return {};
  const off = (e: React.DragEvent) => area && e.target instanceof Element && !!e.target.closest('.row');
  return {
    onDragOver: (e: React.DragEvent) => {
      if (off(e)) { e.currentTarget.classList.remove('drop'); return; }
      e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('drop');
    },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: (e: React.DragEvent) => {
      e.currentTarget.classList.remove('drop');
      if (off(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer.files.length) act.upload(target, [...e.dataTransfer.files]);
      else { const id = e.dataTransfer.getData('application/x-graphspace-node'); if (id) act.move(id, target); }
    },
  };
}

// Куда ляжет узел, брошенный на строку: в раздел — внутрь, на прочее — рядом, в тот же родитель.
// undefined — бросать нельзя: выше узла ничего не видно (чужой общий).
function dropTargetOf(app: Ctx, node: GNode): string | null | undefined {
  if (node.type === 'space') return node.id;
  if (node.parent_id) return app.ix.byId.has(node.parent_id) ? node.parent_id : undefined;
  return node.owner === app.state.me ? null : undefined;
}

function TreeRow({ row, toggle }: { row: Row; toggle: (id: string) => void }) {
  const app = useApp();
  const act = useActions();
  const { node, depth, via } = row;
  const isSpace = node.type === 'space';
  const canRoot = !via && (isSpace || (app.ix.kids.get(node.id) ?? []).length > 0);
  return (
    <div role="treeitem" aria-selected={app.nav.sel === node.id}
      className={`row ${app.nav.sel === node.id ? 'sel' : ''} ${via ? 'shared' : ''}`}
      style={{ paddingLeft: 10 + depth * 16 }}
      draggable={!via}
      onDragStart={(e) => { e.dataTransfer.setData('application/x-graphspace-node', node.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => app.go({ sel: node.id })}
      onDoubleClick={() => canRoot && app.go({ root: node.id })}
      onContextMenu={(e) => app.menu(e, act.menuFor(node, via))}
      {...(via ? {} : dropProps(dropTargetOf(app, node), act))}>
      <button className={`twisty ${row.open ? 'open' : ''}`} style={{ visibility: row.expandable ? 'visible' : 'hidden' }} aria-label={row.open ? 'Свернуть' : 'Развернуть'}
        onClick={(e) => { e.stopPropagation(); toggle(node.id); }}><Icon name="chev" /></button>
      <NodeIcon node={node} />
      <span className="title">{node.title}</span>
      {isSpace && node.props.label && <span className="label">{node.props.label}</span>}
      {isShareRoot(app.ix, node) && <span className="label where" title="Владелец">{node.owner}</span>}
      {node.type === 'resource' && node.props.kind && <span className="label">{node.props.kind}</span>}
      {via && <span className="badge" title="Общий узел: показан ссылкой, дом в другом месте"><Icon name="shared" />общий</span>}
      <span className="row-actions">
        {canRoot && <button title="Сделать корнем" onClick={(e) => { e.stopPropagation(); app.go({ root: node.id }); }}><Icon name="root" /></button>}
        {isSpace && !via && <button title="Создать внутри" onClick={(e) => { e.stopPropagation(); app.menu(e, act.createItems(node)); }}><Icon name="plus" /></button>}
        <button title="Действия" onClick={(e) => { e.stopPropagation(); app.menu(e, act.menuFor(node, via)); }}><Icon name="more" /></button>
      </span>
    </div>
  );
}

