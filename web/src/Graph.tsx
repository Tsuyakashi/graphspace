// Граф области: слои слева направо по вложенности, сплошные рёбра — «лежит внутри», пунктир — «пользуется по ссылке».
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GNode } from './api';
import { Icon, iconOf, iconPaths, useApp } from './ctx';
import { useActions } from './actions';
import { SHARED, matches, pathOf, TYPE_LABEL, type Index } from './model';

// Без корня — два виртуальных корня: свои проекты и разделы, которыми поделились другие.
const VROOT = '__mine__', VSHARED = '__shared__';
const VLABEL: Record<string, string> = { [VROOT]: 'Мои проекты', [VSHARED]: 'Доступно мне' };
const ROW = 44, H = 30, GAP = 72;

interface GN { id: string; node: GNode | null; layer: number; y: number; w: number; label: string; shared: boolean; hiddenKids: number }
interface GE { from: string; to: string; uses: boolean }

const short = (s: string) => (s.length > 30 ? s.slice(0, 29) + '…' : s);
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function layout(ix: Index, rootId: string | null) {
  const roots = rootId ? [rootId] : [VROOT, ...((ix.kids.get(SHARED) ?? []).length ? [VSHARED] : [])];
  const kidsOf = (id: string) => (ix.kids.get(id === VROOT ? null : id === VSHARED ? SHARED : id) ?? []).map((k) => k.id);
  const layer = new Map<string, number>(roots.map((r) => [r, 0]));
  const parent = new Map<string, string>();
  const order: string[] = [];
  const walk = (id: string) => { order.push(id); for (const k of kidsOf(id)) { layer.set(k, layer.get(id)! + 1); parent.set(k, id); walk(k); } };
  roots.forEach(walk);

  // Ссылки: если цель уже в графе — только пунктирное ребро; если нет — цель добавляется рядом с тем, кто ссылается.
  const edges: GE[] = order.filter((id) => !roots.includes(id)).map((id) => ({ from: parent.get(id)!, to: id, uses: false }));
  const outside = new Set<string>();
  for (const id of [...order]) {
    for (const t of ix.uses.get(id) ?? []) {
      if (!ix.byId.has(t)) continue;
      if (!layer.has(t)) { layer.set(t, layer.get(id)! + 1); parent.set(t, id); order.push(t); outside.add(t); }
      edges.push({ from: id, to: t, uses: true });
    }
  }

  const layers: string[][] = [];
  for (const id of order) (layers[layer.get(id)!] ||= []).push(id);
  const y = new Map<string, number>();
  const place = (list: string[], want: (id: string) => number) => {
    const wanted = new Map(list.map((id) => [id, want(id)]));
    list.sort((a, b) => wanted.get(a)! - wanted.get(b)!);
    let last = -Infinity;
    for (const id of list) { const v = Math.max(wanted.get(id)!, last + ROW); y.set(id, v); last = v; }
  };
  // Каждый корень раскладывается своей полосой, полосы — одна под другой: деревья не переплетаются.
  const rootOf = (id: string): string => (parent.has(id) ? rootOf(parent.get(id)!) : id);
  let top = 0;
  for (const r of roots) {
    const band = layers.map((list) => list.filter((id) => rootOf(id) === r));
    // Вперёд — узел встаёт напротив родителя, назад — родитель центрируется по своим детям.
    band.forEach((list, li) => place(list, (id) => (li === 0 ? 0 : y.get(parent.get(id)!) ?? 0)));
    for (let li = band.length - 2; li >= 0; li--) {
      place(band[li], (id) => { const ks = order.filter((k) => parent.get(k) === id); return ks.length ? avg(ks.map((k) => y.get(k)!)) : y.get(id)!; });
    }
    const ids = band.flat();
    const min = Math.min(...ids.map((id) => y.get(id)!)), max = Math.max(...ids.map((id) => y.get(id)!));
    for (const id of ids) y.set(id, y.get(id)! - min + top);
    top += max - min + ROW * 2;
  }

  const nodes = new Map<string, GN>();
  for (const id of order) {
    const node = VLABEL[id] ? null : ix.byId.get(id)!;
    const label = short(node ? node.title : VLABEL[id]);
    nodes.set(id, {
      id, node, label, layer: layer.get(id)!, y: y.get(id)!, w: Math.max(96, 40 + label.length * 7.2),
      shared: !!node && (outside.has(id) || (ix.usedBy.get(id) ?? []).length > 0),
      hiddenKids: outside.has(id) ? kidsOf(id).length : 0,
    });
  }
  const colX: number[] = [];
  let acc = 0;
  layers.forEach((list, li) => { colX[li] = acc; acc += Math.max(...list.map((id) => nodes.get(id)!.w)) + GAP; });
  return { nodes, edges, colX, parent, roots };
}

export function GraphView() {
  const app = useApp();
  const act = useActions();
  const { ix, nav } = app;
  const g = useMemo(() => layout(ix, nav.root), [ix, nav.root]);
  const svg = useRef<SVGSVGElement>(null);
  const inner = useRef<SVGGElement>(null);
  const [t, setT] = useState({ x: 40, y: 40, k: 1 });
  const tRef = useRef(t); tRef.current = t;
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  // Фильтр по типу: подходящие узлы и путь к ним остаются яркими, остальное приглушается.
  const lit = useMemo(() => {
    if (!nav.type) return null;
    const set = new Set<string>();
    for (const n of g.nodes.values()) {
      if (!n.node || !matches(n.node, nav.type)) continue;
      const up = (from: string) => { for (let id: string | undefined = from; id && !set.has(id); id = g.parent.get(id)) set.add(id); };
      up(n.id);
      for (const holder of ix.usedBy.get(n.id) ?? []) if (g.nodes.has(holder)) up(holder); // кто пользуется — тоже на пути
    }
    return set;
  }, [g, ix, nav.type]);

  const fit = () => {
    if (!svg.current || !inner.current) return;
    const bb = inner.current.getBBox(), W = svg.current.clientWidth, Hh = svg.current.clientHeight;
    if (!bb.width || !W) return;
    const k = Math.min(1.2, (W - 80) / bb.width, (Hh - 80) / bb.height);
    setT({ k, x: (W - bb.width * k) / 2 - bb.x * k, y: (Hh - bb.height * k) / 2 - bb.y * k });
  };
  useLayoutEffect(fit, [nav.root]);

  useEffect(() => {
    const el = svg.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, c = tRef.current;
      const k = Math.min(3, Math.max(0.2, c.k * Math.exp(-e.deltaY * 0.0015)));
      setT({ k, x: mx - (mx - c.x) * (k / c.k), y: my - (my - c.y) * (k / c.k) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const X = (n: GN) => g.colX[n.layer];
  const sel = nav.sel && g.nodes.get(nav.sel)?.node ? ix.byId.get(nav.sel)! : null;
  const hasKids = (n: GNode) => (ix.kids.get(n.id) ?? []).length > 0;
  const open = (n: GNode) => app.go({ sel: n.id, graph: false });

  return (
    <div className="graph-wrap">
      <svg ref={svg} className="graph" role="img" aria-label="Граф области"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
          if (d.moved) setT((c) => ({ ...c, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }));
        }}
        onPointerUp={() => { setTimeout(() => (drag.current = null)); }}
        onPointerLeave={() => (drag.current = null)}>
        <g ref={inner} transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {g.edges.map((e) => {
            const a = g.nodes.get(e.from)!, b = g.nodes.get(e.to)!;
            const back = b.layer <= a.layer; // ссылка назад или в тот же слой — огибаем справа
            const x1 = X(a) + a.w, x2 = back ? X(b) + b.w : X(b), mx = back ? Math.max(x1, x2) + 46 : (x1 + x2) / 2;
            const dim = lit && !(lit.has(e.to) && lit.has(e.from));
            return <path key={`${e.from}>${e.to}${e.uses ? 'u' : ''}`} className={`ge ${e.uses ? 'uses' : ''} ${dim ? 'dim' : ''}`}
              d={`M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`} />;
          })}
          {[...g.nodes.values()].map((n) => (
            <g key={n.id} data-id={n.id} className={`gn ${n.node ? `t-${n.node.type}` : 'vroot'} ${n.shared ? 'shared' : ''} ${nav.sel === n.id ? 'sel' : ''} ${lit && !lit.has(n.id) ? 'dim' : ''}`}
              transform={`translate(${X(n)},${n.y - H / 2})`}
              onClick={() => { if (drag.current?.moved) return; n.node ? app.go({ sel: n.id }) : app.go({ root: null }); }}
              onDoubleClick={() => { if (!n.node) return; hasKids(n.node) && !g.roots.includes(n.id) ? app.go({ root: n.id }) : open(n.node); }}
              onContextMenu={(e) => n.node && app.menu(e, act.menuFor(n.node))}>
              <title>{n.node ? `${n.node.title} · ${pathOf(ix, n.id).slice(0, -1).map((p) => p.title).join(' / ') || 'верхний уровень'}` : n.label}</title>
              <rect className="box" width={n.w} height={H} rx="7" />
              <rect className="stripe" width="4" height={H - 10} x="5" y="5" rx="2" />
              <g transform="translate(15,7)" className="gi" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                {iconPaths[n.node ? iconOf(n.node) : n.id === VSHARED ? 'shared' : 'root'] ?? iconPaths.file}
              </g>
              <text x="37" y={H / 2}>{n.label}{n.hiddenKids ? `  +${n.hiddenKids}` : ''}</text>
            </g>
          ))}
        </g>
      </svg>

      <div className="graph-tools">
        <button onClick={fit}>Вписать</button>
        <span className="legend"><i className="solid" />лежит внутри<i className="dashed" />пользуется по ссылке</span>
      </div>

      {sel && (
        <div className="graph-card">
          <b>{sel.title}</b>
          <span className="muted">
            {sel.type === 'space' ? sel.props.label || 'раздел' : sel.type === 'resource' ? sel.props.kind : TYPE_LABEL[sel.type]}
            {' · '}{pathOf(ix, sel.id).slice(0, -1).map((p) => p.title).join(' / ') || 'верхний уровень'}
          </span>
          {(ix.usedBy.get(sel.id) ?? []).length > 0 && (
            <span className="muted">Им пользуются: {(ix.usedBy.get(sel.id) ?? []).map((id) => ix.byId.get(id)?.title).filter(Boolean).join(', ')}</span>
          )}
          <div className="graph-card-actions">
            <button className="primary" onClick={() => open(sel)}>Открыть</button>
            {(sel.type === 'space' || hasKids(sel)) && sel.id !== nav.root && <button onClick={() => app.go({ root: sel.id })}><Icon name="graph" />Граф отсюда</button>}
            <button title="Действия" onClick={(e) => app.menu(e, act.menuFor(sel))}><Icon name="more" /></button>
          </div>
        </div>
      )}
    </div>
  );
}
