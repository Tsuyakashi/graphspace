// Чистая логика каталога: индекс, область видимости узла, фильтр по типу, строки дерева.
import type { GNode, NodeType, State } from './api';

export interface Index {
  byId: Map<string, GNode>;
  kids: Map<string | null, GNode[]>;
  uses: Map<string, string[]>;   // контейнер → чужие узлы, которыми он пользуется
  usedBy: Map<string, string[]>; // узел → контейнеры, которые на него ссылаются
  embeddedIn: Map<string, string[]>;
}

// Псевдо-родитель для чужих разделов, которыми поделились: их настоящий родитель не виден.
export const SHARED = '@shared';

export function buildIndex(state: State): Index {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const kids = new Map<string | null, GNode[]>();
  for (const n of state.nodes) {
    const key = n.parent_id && byId.has(n.parent_id) ? n.parent_id : n.owner === state.me && !n.parent_id ? null : SHARED;
    const list = kids.get(key) ?? [];
    list.push(n);
    kids.set(key, list);
  }
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  const uses = new Map<string, string[]>(), usedBy = new Map<string, string[]>(), embeddedIn = new Map<string, string[]>();
  for (const l of state.links) {
    if (l.kind === 'uses') { push(uses, l.from_id, l.to_id); push(usedBy, l.to_id, l.from_id); }
    else push(embeddedIn, l.to_id, l.from_id);
  }
  return { byId, kids, uses, usedBy, embeddedIn };
}

// Узел, которым поделились напрямую: выше него ничего не видно.
export const isShareRoot = (ix: Index, n: GNode) => (ix.kids.get(SHARED) ?? []).includes(n);

export function pathOf(ix: Index, id: string, stopAt: string | null = null): GNode[] {
  const out: GNode[] = [];
  let n = ix.byId.get(id);
  while (n && n.id !== stopAt) { out.unshift(n); n = n.parent_id ? ix.byId.get(n.parent_id) : undefined; }
  return out;
}

// Фильтр: '' — всё, тип узла, 'files' — все файловые типы, 'kind:s3' — вид ресурса.
export const FILE_TYPES: NodeType[] = ['office', 'pdf', 'design', 'file'];
const TYPE_NAMES = new Set(['space', 'doc', 'board', 'office', 'pdf', 'design', 'file', 'resource', 'files']);
export const parseFilter = (v: string) => (!v || TYPE_NAMES.has(v) || v.startsWith('kind:') ? v : `kind:${v}`);
export function matches(n: GNode, f: string): boolean {
  if (!f) return true;
  if (f === 'files') return FILE_TYPES.includes(n.type);
  if (f.startsWith('kind:')) return n.type === 'resource' && n.props.kind === f.slice(5);
  return n.type === f;
}

export interface ScopeItem { node: GNode; via?: string } // via — контейнер, через который узел попал в область ссылкой

// Область узла: все потомки плюс то, чем они пользуются по ссылке, вместе с содержимым общего узла.
// Каждый узел входит один раз; via — узел, через ссылку которого он попал в область.
// Без корня — всё видимое: своё и то, чем поделились.
export function scopeOf(ix: Index, rootId: string | null): ScopeItem[] {
  const out: ScopeItem[] = [];
  const seen = new Set<string>(rootId ? [rootId] : []);
  const pending: { holder: string; target: string }[] = [];
  const walk = (id: string | null, via?: string) => {
    if (id) for (const t of ix.uses.get(id) ?? []) pending.push({ holder: via ?? id, target: t });
    for (const k of ix.kids.get(id) ?? []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push({ node: k, via });
      walk(k.id, via);
    }
  };
  walk(rootId);
  if (!rootId) walk(SHARED);
  // Свои потомки идут первыми, поэтому общий узел, который и так лежит в области, остаётся «своим».
  for (let i = 0; i < pending.length; i++) {
    const { holder, target } = pending[i];
    const node = ix.byId.get(target);
    if (!node || seen.has(target)) continue;
    seen.add(target);
    out.push({ node, via: holder });
    walk(target, holder);
  }
  return out;
}

export interface Row { node: GNode; depth: number; via?: string; open?: boolean; expandable?: boolean }

// Строки дерева от корня. При активном фильтре остаются подходящие узлы и всё, что лежит на пути к ним.
// Общий узел показывается одной строкой под тем, кто на него ссылается: его содержимое живёт в его доме.
export function treeRows(ix: Index, rootId: string | null, filter: string, collapsed: Set<string>): Row[] {
  const keep = new Map<string, boolean>();
  const visible = (n: GNode): boolean => {
    const known = keep.get(n.id);
    if (known !== undefined) return known;
    keep.set(n.id, false); // защита от кругов по ссылкам
    const v = matches(n, filter) || (ix.kids.get(n.id) ?? []).some(visible) || sharedOf(n.id).length > 0;
    keep.set(n.id, v);
    return v;
  };
  const sharedOf = (id: string) => (ix.uses.get(id) ?? []).map((t) => ix.byId.get(t)).filter((x): x is GNode => !!x && visible(x));
  const rows: Row[] = [];
  const walk = (id: string | null, depth: number) => {
    for (const n of ix.kids.get(id) ?? []) {
      if (!visible(n)) continue;
      const shared = sharedOf(n.id);
      const expandable = (ix.kids.get(n.id) ?? []).some(visible) || shared.length > 0;
      const open = expandable && !collapsed.has(n.id);
      rows.push({ node: n, depth, open, expandable });
      if (open) {
        walk(n.id, depth + 1);
        for (const s of shared) rows.push({ node: s, depth: depth + 1, via: n.id });
      }
    }
    if (id && depth === 0) for (const s of sharedOf(id)) rows.push({ node: s, depth: 0, via: id });
  };
  walk(rootId, 0);
  return rows;
}

export const TYPE_LABEL: Record<NodeType, string> = {
  space: 'Раздел', doc: 'Док', board: 'Схема', office: 'Офисный файл', pdf: 'PDF', design: 'Макет', file: 'Файл', resource: 'Ресурс',
};

export function typeForExt(ext: string): { type: NodeType; ext: string } {
  const e = ext.toLowerCase();
  if (['docx', 'odt', 'rtf', 'xlsx', 'csv', 'pptx'].includes(e)) return { type: 'office', ext: e };
  if (e === 'pdf') return { type: 'pdf', ext: e };
  if (e === 'fig') return { type: 'design', ext: e };
  if (e === 'md') return { type: 'doc', ext: e };
  if (e === 'excalidraw') return { type: 'board', ext: e };
  return { type: 'file', ext: e };
}

export const splitName = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i + 1) } : { base: name, ext: '' };
};

export const fileName = (n: GNode) => (n.ext && !n.title.toLowerCase().endsWith('.' + n.ext) ? `${n.title}.${n.ext}` : n.title);

export const fmtSize = (b: number) => (b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(1)} КБ` : `${(b / 1048576).toFixed(1)} МБ`);
export const fmtTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
