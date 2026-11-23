// Общий контекст приложения и мелкие элементы интерфейса: значки, диалог, меню, палитра, уведомления.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Config, GNode, State } from './api';
import { type Index, pathOf, scopeOf } from './model';

export interface Nav { root: string | null; sel: string | null; type: string; graph: boolean }
// Редактор с правками: перед уходом с узла сохраняет их. false — остаться.
export type LeaveGuard = () => Promise<boolean>;
export interface Field { name: string; label: string; value?: string; options?: string[]; placeholder?: string; optional?: boolean }
export interface MenuItem { label: string; run?: () => void; danger?: boolean; sep?: boolean; hint?: string }

export interface Ctx {
  state: State;
  ix: Index;
  config: Config;
  nav: Nav;
  go: (patch: Partial<Nav>) => void;
  reload: () => Promise<void>;
  toast: (text: string, action?: { label: string; run: () => void }) => void;
  ask: (title: string, fields: Field[], submit?: string) => Promise<Record<string, string> | null>;
  pick: (title: string, filter?: (n: GNode) => boolean) => Promise<GNode | null>;
  menu: (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  // Регистрирует защиту ухода, возвращает снятие. Действует, пока узел открыт.
  guard: (fn: LeaveGuard) => () => void;
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

// Переход к узлу. Если он вне текущего корня, корнем становится его проект.
export function openNode(app: Ctx, id: string) {
  const inScope = !app.nav.root || id === app.nav.root || scopeOf(app.ix, app.nav.root).some((s) => s.node.id === id);
  if (inScope) app.go({ sel: id });
  else app.go({ root: pathOf(app.ix, id)[0]?.id ?? null, sel: id });
}

// ---------- значки ----------
const P: Record<string, ReactNode> = {
  space: <path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  doc: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 5.5h2" /></>,
  board: <><rect x="1.5" y="2.5" width="6" height="4.5" rx="1" /><circle cx="11.5" cy="11" r="3" /><path d="M7.5 5h2.5a1.5 1.5 0 0 1 1.5 1.5V8" /></>,
  office: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3M5.5 7.5h5v4.5h-5zM5.5 9.7h5M8 7.5V12" /></>,
  pdf: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3M5.5 11.5c2-1 3-3.5 2.5-5-.6 1.800 1 4 2.800 4.300" /></>,
  design: <><rect x="2" y="2" width="12" height="12" rx="2" /><circle cx="6" cy="6.5" r="1.500" /><path d="M5 12l3.500-4 3.500 4" /></>,
  file: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3" /></>,
  resource: <><path d="M6.800 9.200a2.800 2.800 0 0 0 4 0l2.200-2.200a2.800 2.800 0 0 0-4-4l-.800.800" /><path d="M9.200 6.800a2.800 2.800 0 0 0-4 0L3 9a2.800 2.800 0 0 0 4 4l.800-.800" /></>,
  s3: <><path d="M2.500 4l1.500 9.500h8L13.500 4" /><ellipse cx="8" cy="4" rx="5.500" ry="1.800" /></>,
  git: <><circle cx="4.500" cy="3.500" r="1.700" /><circle cx="4.500" cy="12.500" r="1.700" /><circle cx="11.500" cy="6" r="1.700" /><path d="M4.500 5.200v5.600M11.500 7.700c0 2.300-3.500 2-6.500 3.300" /></>,
  registry: <><path d="M8 1.500l6 3v7l-6 3-6-3v-7z" /><path d="M2 4.500l6 3 6-3M8 7.500v7" /></>,
  root: <><circle cx="8" cy="8" r="5.500" /><circle cx="8" cy="8" r="1.500" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  more: <><circle cx="3.500" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="12.500" cy="8" r=".8" /></>,
  chev: <path d="M6 4l4 4-4 4" />,
  search: <><circle cx="7" cy="7" r="4.500" /><path d="M10.500 10.500l3.500 3.500" /></>,
  graph: <><circle cx="3.5" cy="8" r="1.8" /><circle cx="12.5" cy="3.5" r="1.8" /><circle cx="12.5" cy="12.5" r="1.8" /><path d="M5.2 7.2l5.600-2.900M5.200 8.800l5.600 2.900" /></>,
  shared: <path d="M5.500 10.500l5-5M6.500 5.500h4v4" />,
  collapse: <><rect x="2.500" y="2.500" width="11" height="11" rx="1.500" /><path d="M5.500 8h5" /></>,
};
export const iconPaths = P;
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name] ?? P.file}</svg>
  );
}
export const iconOf = (n: GNode) => (n.type === 'resource' && P[n.props.kind] ? n.props.kind : n.type);
export function NodeIcon({ node }: { node: GNode }) {
  return <Icon name={iconOf(node)} className={`t-${node.type}`} />;
}

// ---------- диалог с полями ----------
export function AskDialog({ title, fields, submit, done }: { title: string; fields: Field[]; submit: string; done: (v: Record<string, string> | null) => void }) {
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])));
  const ok = fields.every((f) => f.optional || vals[f.name].trim());
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); if (ok) done(vals); }} onKeyDown={(e) => e.key === 'Escape' && done(null)}>
        <h3>{title}</h3>
        {fields.map((f, i) => (
          <label key={f.name}>
            <span>{f.label}</span>
            <input autoFocus={i === 0} value={vals[f.name]} placeholder={f.placeholder} list={f.options ? `opt-${f.name}` : undefined}
              onFocus={(e) => i === 0 && e.target.select()}
              onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
            {f.options && <datalist id={`opt-${f.name}`}>{f.options.map((o) => <option key={o} value={o} />)}</datalist>}
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" onClick={() => done(null)}>Отмена</button>
          <button type="submit" className="primary" disabled={!ok}>{submit}</button>
        </div>
      </form>
    </div>
  );
}

// ---------- контекстное меню ----------
export function Menu({ x, y, items, close }: { x: number; y: number; items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
    const off = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) close(); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('mousedown', off); addEventListener('keydown', key); addEventListener('blur', close);
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key); removeEventListener('blur', close); };
  }, [x, y, close]);
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="menu-sep">{it.label}</div>
        : <button key={i} className={it.danger ? 'danger' : ''} onClick={() => { close(); it.run?.(); }}>{it.label}{it.hint && <kbd>{it.hint}</kbd>}</button>)}
    </div>
  );
}

// ---------- палитра: быстрый переход и выбор узла ----------
export function Palette({ title, nodes, ix, done }: { title: string; nodes: GNode[]; ix: Index; done: (n: GNode | null) => void }) {
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return nodes
      .map((n) => ({ n, path: pathOf(ix, n.id).slice(0, -1).map((p) => p.title).join(' / ') }))
      .filter(({ n, path }) => { const hay = `${n.title} ${path} ${n.props.kind ?? ''} ${n.props.label ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
      .sort((a, b) => Number(b.n.title.toLowerCase().startsWith(q.toLowerCase())) - Number(a.n.title.toLowerCase().startsWith(q.toLowerCase())))
      .slice(0, 40);
  }, [q, nodes, ix]);
  useEffect(() => setCur(0), [q]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') done(null);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(c + 1, found.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && found[cur]) done(found[cur].n);
  };
  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="palette" onKeyDown={key}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={title} />
        <div className="palette-list">
          {found.map(({ n, path }, i) => (
            <button key={n.id} className={i === cur ? 'cur' : ''} onMouseEnter={() => setCur(i)} onClick={() => done(n)}>
              <NodeIcon node={n} /><span className="grow">{n.title}</span><span className="muted">{path}</span>
            </button>
          ))}
          {!found.length && <div className="empty">Ничего не найдено</div>}
        </div>
      </div>
    </div>
  );
}

export interface ToastItem { id: number; text: string; action?: { label: string; run: () => void } }
export function Toasts({ items, drop }: { items: ToastItem[]; drop: (id: number) => void }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && <button onClick={() => { t.action!.run(); drop(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
