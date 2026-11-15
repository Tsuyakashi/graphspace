// Экспорт узла zip-архивом: сам узел и всё, что он вставляет и упоминает, рекурсивно.
// Пути в архиве повторяют дерево. Вставки переписываются в ![[путь]] — архив открывается в Obsidian как хранилище.
import path from 'node:path';
import zlib from 'node:zlib';
import { allNodes, allLinks, getVersion, versions, readBlob, mustNode, HttpError } from './db.mjs';

// Те же правила, что у клиента (web/src/Markdown.tsx): вставка — целая строка, остальное — упоминания.
const EMBED_LINE = /^\s*!\[\[([a-z0-9]{6,})(?:@([^\]|]*))?(?:\|([^\]]*))?\]\]\s*$/;
const MENTION = /!?\[\[([a-z0-9]{6,})(?:@[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const FILE_TYPES = ['office', 'pdf', 'design', 'file'];
const TYPE_NAMES = new Set(['space', 'doc', 'board', 'office', 'pdf', 'design', 'file', 'resource', 'files']);
const parseFilter = (v) => (!v || TYPE_NAMES.has(v) || v.startsWith('kind:') ? v : `kind:${v}`);
const matches = (n, f) => {
  if (!f) return true;
  if (f === 'files') return FILE_TYPES.includes(n.type);
  if (f.startsWith('kind:')) return n.type === 'resource' && n.props.kind === f.slice(5);
  return n.type === f;
};

// Имя файла без символов, которые не любят файловые системы и вики-ссылки Obsidian.
const clean = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f#^[\]]/g, '_').trim() || '_';

// Индекс каталога и область узла — как buildIndex и scopeOf в web/src/model.ts.
function catalog() {
  const nodes = allNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
  const uses = new Map();
  for (const l of allLinks()) if (l.kind === 'uses') uses.set(l.from_id, [...(uses.get(l.from_id) ?? []), l.to_id]);

  // Область узла — как scopeOf в web/src/model.ts: потомки, затем то, чем они пользуются по ссылке.
  const scopeOf = (rootId) => {
    const out = [], seen = new Set([rootId]), pending = [];
    const walk = (id) => {
      for (const t of uses.get(id) ?? []) pending.push(t);
      for (const k of kids.get(id) ?? []) if (!seen.has(k.id)) { seen.add(k.id); out.push(k); walk(k.id); }
    };
    walk(rootId);
    for (let i = 0; i < pending.length; i++) {
      const n = byId.get(pending[i]);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id); out.push(n); walk(n.id);
    }
    return out;
  };
  return { byId, scopeOf };
}
const optsOf = (raw) => Object.fromEntries((raw ?? '').split(',').map((s) => s.split('=').map((x) => x.trim())).filter((p) => p.length === 2));
const resolvePin = (n, pin) => {
  if (/^\d+$/.test(pin)) return getVersion(n.id, Number(pin)) ? Number(pin) : null;
  return versions(n.id).find((v) => v.name === pin)?.n ?? null;
};
const IMAGE = /^(png|jpe?g|gif|webp|svg)$/i;

// ---------- док одним файлом ----------
// origin — адрес Graphspace: то, что нельзя раскрыть текстом, становится ссылкой на узел.
export function exportDoc(rootId, origin) {
  const root = mustNode(rootId);
  if (root.type !== 'doc') throw new HttpError(400, 'одним файлом выгружается только док');
  const { byId, scopeOf } = catalog();
  const url = (n) => `${origin}/?sel=${n.id}`;
  const esc = (t) => t.replace(/([[\]*_`])/g, '\\$1');
  const where = (n) => {
    const parts = [];
    for (let p = n.parent_id && byId.get(n.parent_id); p; p = p.parent_id && byId.get(p.parent_id)) parts.unshift(p.title);
    return parts.join(' / ');
  };
  const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const frame = (n, note, body) => {
    const head = `**[${esc(n.title)}](${url(n)})**${note ? ` · _${esc(note)}_` : ''}`;
    return quote(body ? `${head}\n\n${body}` : head);
  };

  // Одна вставка в виде блока markdown. chain — цепочка доков, чтобы оборвать цикл.
  const embed = (n, pin, depth, chain) => {
    if (n.type === 'doc') {
      if (chain.includes(n.id)) return frame(n, 'ссылается сама на себя');
      const v = pin ? resolvePin(n, pin) : n.head;
      if (pin && !v) return frame(n, `нет снапшота «${pin}»`);
      const text = v ? readBlob(getVersion(n.id, v).blob).toString('utf8') : '';
      return frame(n, [where(n), pin && `снапшот «${pin}»`].filter(Boolean).join(' · '), render(text, depth + 1, [...chain, n.id]));
    }
    if (n.type === 'resource') {
      const link = n.props.url ? ` — ${n.props.url}` : '';
      return frame(n, `${n.props.kind ?? 'ресурс'}${link}${n.props.note ? `. ${n.props.note}` : ''}`);
    }
    if (n.type === 'file' && IMAGE.test(n.ext ?? '') && n.head) {
      const bytes = readBlob(getVersion(n.id, n.head).blob);
      const type = n.ext === 'svg' ? 'image/svg+xml' : `image/${n.ext.toLowerCase().replace('jpg', 'jpeg')}`;
      return frame(n, where(n), `![${esc(n.title)}](data:${type};base64,${bytes.toString('base64')})`);
    }
    return frame(n, `${n.type === 'board' ? 'схема' : n.ext ?? n.type} — открыть в Graphspace`);
  };

  const render = (text, depth, chain) => {
    const out = [];
    let fence = false;
    // Самый крупный заголовок вставленного дока становится уровнем depth + 1, остальные — относительно него.
    const levels = [];
    for (const l of text.split('\n')) { if (/^\s*(```|~~~)/.test(l)) fence = !fence; else if (!fence) { const h = l.match(/^(#{1,6})\s/); if (h) levels.push(h[1].length); } }
    fence = false;
    const shift = depth && levels.length ? depth + 1 - Math.min(...levels) : 0;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue; }
      if (fence) { out.push(line); continue; }
      const m = line.match(EMBED_LINE);
      if (!m) {
        out.push(line
          .replace(/^(#{1,6})(\s)/, (_, h, sp) => '#'.repeat(Math.max(1, Math.min(6, h.length + shift))) + sp)
          .replace(MENTION, (_, id) => { const n = byId.get(id); return n ? `[${esc(n.title)}](${url(n)})` : '`узел не найден`'; }));
        continue;
      }
      const [, id, pin, raw] = m;
      const n = byId.get(id);
      const opts = optsOf(raw);
      let blocks;
      if (!n) blocks = ['> Вставка: узел не найден или в корзине'];
      else if (opts.type || n.type === 'space') {
        const f = parseFilter(opts.type ?? '');
        const items = scopeOf(n.id).filter((x) => (f ? matches(x, f) : x.type !== 'space'));
        blocks = items.length ? items.map((x) => embed(x, null, depth, chain)) : [`> В «${esc(n.title)}» пока нет подходящих узлов`];
      } else blocks = [embed(n, pin?.trim() || null, depth, chain)];
      // Пустые строки вокруг: иначе соседние цитаты склеятся в одну.
      out.push('', blocks.join('\n\n'), '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const text = root.head ? readBlob(getVersion(root.id, root.head).blob).toString('utf8') : '';
  const base = root.title.toLowerCase().endsWith('.md') ? root.title : `${root.title}.md`;
  return { name: base, bytes: Buffer.from(render(text, 0, [root.id]) + '\n') };
}

// ---------- раздел zip-архивом ----------
export function exportSpace(rootId) {
  const root = mustNode(rootId);
  const { byId, scopeOf } = catalog();

  const dirOf = (n) => {
    const parts = [];
    for (let p = n.parent_id && byId.get(n.parent_id); p; p = p.parent_id && byId.get(p.parent_id)) parts.unshift(clean(p.title));
    return parts.join('/');
  };
  const nameOf = (n, pin) => {
    const ext = n.type === 'resource' ? 'md' : n.ext;
    let base = clean(n.title);
    if (ext && base.toLowerCase().endsWith('.' + ext)) base = base.slice(0, -ext.length - 1);
    return `${base}${pin ? `@${clean(pin)}` : ''}${ext ? '.' + ext : ''}`;
  };

  const files = new Map();  // ключ id или id@n → путь
  const taken = new Set();
  const queue = [];
  // Путь узла в архиве; при первом обращении узел ставится в очередь на выгрузку.
  const want = (n, v = null, pin = null) => {
    if (n.type === 'space') return null;
    if (n.type !== 'resource' && !(v ?? n.head)) return null; // содержимого нет — выгружать нечего
    const key = v ? `${n.id}@${v}` : n.id;
    if (files.has(key)) return files.get(key);
    const dir = dirOf(n), name = nameOf(n, pin);
    let p = dir ? `${dir}/${name}` : name;
    for (let i = 2; taken.has(p); i++) p = p.replace(/( \(\d+\))?(\.[^./]*)?$/, (_, __, ext = '') => ` (${i})${ext}`);
    taken.add(p); files.set(key, p);
    queue.push({ n, v, path: p });
    return p;
  };
  const rewrite = (text, from) => {
    const out = [];
    let fence = false;
    const link = (id) => {
      const n = byId.get(id);
      if (!n) return '`узел не найден`';
      const p = want(n);
      if (!p) return n.title;
      return `[${n.title.replace(/([[\]])/g, '\\$1')}](${encodeURI(path.posix.relative(path.posix.dirname(from), p))})`;
    };
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue; }
      const m = !fence && line.match(EMBED_LINE);
      if (!m) { out.push(fence ? line : line.replace(MENTION, (_, id) => link(id))); continue; }
      const [, id, pin, rawOpts] = m;
      const n = byId.get(id);
      if (!n) { out.push(`> Вставка: узел ${id} не найден или в корзине`); continue; }
      const opts = optsOf(rawOpts);
      if (opts.type || n.type === 'space') {
        const f = parseFilter(opts.type ?? '');
        const items = scopeOf(n.id).filter((x) => (f ? matches(x, f) : x.type !== 'space')).map((x) => want(x)).filter(Boolean);
        out.push(...(items.length ? items.map((p) => `![[${p}]]`) : [`> В «${n.title}» пока нет подходящих узлов`]));
        continue;
      }
      const v = pin?.trim() ? resolvePin(n, pin.trim()) : null;
      if (pin?.trim() && !v) { out.push(`> У «${n.title}» нет снапшота «${pin.trim()}»`); continue; }
      const p = want(n, v, v ? pin.trim() : null);
      out.push(p ? `![[${p}]]` : `> «${n.title}»: содержимого нет`);
    }
    return out.join('\n');
  };

  for (const n of scopeOf(root.id)) want(n);

  const entries = [];
  for (let i = 0; i < queue.length; i++) {
    const { n, v, path: p } = queue[i];
    if (n.type === 'resource') {
      const lines = [`# ${n.title}`, '', `- Вид: ${n.props.kind ?? ''}`];
      if (n.props.url) lines.push(`- Ссылка: ${n.props.url}`);
      if (n.props.note) lines.push('', n.props.note);
      entries.push({ name: p, data: Buffer.from(lines.join('\n') + '\n') });
      continue;
    }
    const bytes = readBlob(getVersion(n.id, v ?? n.head).blob);
    entries.push({ name: p, data: n.type === 'doc' ? Buffer.from(rewrite(bytes.toString('utf8'), p)) : bytes });
  }
  const base = clean(root.title).replace(/\.md$/i, '');
  return { name: `${base}.zip`, bytes: zip(entries) };
}

// Минимальный zip без зависимостей: deflate, если выгодно, иначе без сжатия. Имена в UTF-8.
function zip(entries) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fname = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(store ? 0 : 8, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(store ? 0 : 8, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, fname, body);
    central.push(cen, fname);
    offset += head.length + fname.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
