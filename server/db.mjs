// Хранилище: SQLite (узлы, связи, версии) + блобы на диске по sha256.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.GRAPHSPACE_DATA || path.join(ROOT, 'data');
const BLOBS = path.join(DATA, 'blobs');
fs.mkdirSync(BLOBS, { recursive: true });

export const db = new DatabaseSync(path.join(DATA, 'graphspace.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT REFERENCES nodes(id),
    position REAL NOT NULL DEFAULT 0,
    props TEXT NOT NULL DEFAULT '{}',
    ext TEXT,
    head INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
  CREATE TABLE IF NOT EXISTS versions (
    node_id TEXT NOT NULL REFERENCES nodes(id),
    n INTEGER NOT NULL,
    blob TEXT NOT NULL,
    size INTEGER NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (node_id, n)
  );
  CREATE TABLE IF NOT EXISTS links (
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
`);

export const TYPES = ['space', 'doc', 'board', 'office', 'pdf', 'design', 'file', 'resource'];
const now = () => new Date().toISOString();
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const newId = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- блобы ----------
const blobPath = (hash) => path.join(BLOBS, hash.slice(0, 2), hash);
export function putBlob(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = blobPath(hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return hash;
}
export const blobFile = (hash) => blobPath(hash);
export const readBlob = (hash) => fs.readFileSync(blobPath(hash));

// ---------- узлы ----------
const row = (r) => r && { ...r, props: JSON.parse(r.props) };
export const getNode = (id) => row(db.prepare('SELECT * FROM nodes WHERE id = ?').get(id));
export function mustNode(id) {
  const n = getNode(id);
  if (!n || n.deleted_at) throw new HttpError(404, 'узел не найден');
  return n;
}
export const allNodes = () => db.prepare('SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY position, created_at').all().map(row);
export const allLinks = () => db.prepare(`
  SELECT l.* FROM links l
  JOIN nodes a ON a.id = l.from_id AND a.deleted_at IS NULL
  JOIN nodes b ON b.id = l.to_id AND b.deleted_at IS NULL`).all();

export function createNode({ id, type, title, parent_id = null, props = {}, ext = null }) {
  if (!TYPES.includes(type)) throw new HttpError(400, `неизвестный тип: ${type}`);
  if (!title?.trim()) throw new HttpError(400, 'нужно имя');
  // Узлы универсальны: детей может иметь любой узел, а на верхнем уровне может жить любой тип.
  if (parent_id) mustNode(parent_id);
  id ||= newId();
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM nodes WHERE parent_id IS ?').get(parent_id).p;
  const t = now();
  db.prepare('INSERT INTO nodes (id, type, title, parent_id, position, props, ext, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, type, title.trim(), parent_id, pos, JSON.stringify(props), ext, t, t);
  return getNode(id);
}

export function descendants(id) {
  return db.prepare(`
    WITH RECURSIVE d(id) AS (
      SELECT id FROM nodes WHERE parent_id = ?
      UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id
    ) SELECT id FROM d`).all(id).map((r) => r.id);
}

export function updateNode(id, patch) {
  const n = mustNode(id);
  if ('parent_id' in patch && (patch.parent_id ?? null) !== n.parent_id) {
    const to = patch.parent_id ?? null; // null — вынести на верхний уровень
    if (to) {
      mustNode(to);
      if (to === id || descendants(id).includes(to)) throw new HttpError(400, 'нельзя перенести узел внутрь самого себя');
    }
    n.parent_id = to;
    n.position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM nodes WHERE parent_id IS ? AND deleted_at IS NULL').get(to).p;
  }
  if (typeof patch.title === 'string' && patch.title.trim()) n.title = patch.title.trim();
  if (patch.props && typeof patch.props === 'object') n.props = { ...n.props, ...patch.props };
  db.prepare('UPDATE nodes SET title = ?, parent_id = ?, position = ?, props = ?, updated_at = ? WHERE id = ?')
    .run(n.title, n.parent_id, n.position, JSON.stringify(n.props), now(), id);
  return getNode(id);
}

// Удаление — это корзина: узел и потомки помечаются одной меткой времени, блобы остаются.
export function trashNode(id) {
  mustNode(id);
  const stamp = now();
  const ids = [id, ...descendants(id)];
  const st = db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
  for (const i of ids) st.run(stamp, i);
  return stamp;
}
export function restoreNode(id) {
  const n = getNode(id);
  if (!n?.deleted_at) throw new HttpError(404, 'в корзине такого нет');
  db.prepare('UPDATE nodes SET deleted_at = NULL WHERE deleted_at = ?').run(n.deleted_at);
}

// ---------- версии ----------
export const versions = (id) => db.prepare('SELECT * FROM versions WHERE node_id = ? ORDER BY n DESC').all(id);
export const getVersion = (id, n) => db.prepare('SELECT * FROM versions WHERE node_id = ? AND n = ?').get(id, n);

// Ничего не перезаписывается: каждое сохранение — новая версия.
// Если клиент редактировал не последнюю версию, его байты сохраняются рядом, а head не двигается.
export function addVersion(id, bytes, { author = 'me', base = null, name = null } = {}) {
  const node = mustNode(id);
  const blob = putBlob(bytes);
  const head = node.head ? getVersion(id, node.head) : null;
  if (head && head.blob === blob && !name) return { version: head, unchanged: true };
  const n = (db.prepare('SELECT COALESCE(MAX(n), 0) AS m FROM versions WHERE node_id = ?').get(id).m) + 1;
  const conflict = base != null && node.head != null && Number(base) !== node.head;
  const vname = conflict ? `конфликт: правка поверх v${base}, а текущая v${node.head}` : name;
  db.prepare('INSERT INTO versions (node_id, n, blob, size, author, created_at, name) VALUES (?,?,?,?,?,?,?)')
    .run(id, n, blob, bytes.length, author, now(), vname);
  if (!conflict) {
    db.prepare('UPDATE nodes SET head = ?, updated_at = ? WHERE id = ?').run(n, now(), id);
    if (node.type === 'doc') reindexDocLinks(id, bytes.toString('utf8'));
  }
  return { version: getVersion(id, n), conflict };
}

export function nameVersion(id, n, name) {
  if (!getVersion(id, n)) throw new HttpError(404, 'версия не найдена');
  db.prepare('UPDATE versions SET name = ? WHERE node_id = ? AND n = ?').run(name?.trim() || null, id, n);
  return getVersion(id, n);
}

export function headBytes(id) {
  const node = mustNode(id);
  return node.head ? readBlob(getVersion(id, node.head).blob) : null;
}

// ---------- связи ----------
export function ancestors(id) {
  const out = [];
  for (let n = getNode(id); n?.parent_id; n = getNode(n.parent_id)) out.push(n.parent_id);
  return out;
}
// uses — «этим пользуются отсюда»: узел остаётся в своём доме. Ссылаться можно на что угодно, включая разделы,
// кроме самого себя, собственных предков и того, что и так лежит прямо внутри.
export function addLink(from_id, to_id, kind) {
  mustNode(from_id);
  const to = mustNode(to_id);
  if (from_id === to_id) throw new HttpError(400, 'ссылка на самого себя');
  if (kind === 'uses') {
    if (ancestors(from_id).includes(to_id)) throw new HttpError(400, 'нельзя сослаться на раздел, внутри которого находишься');
    if (to.parent_id === from_id) throw new HttpError(400, 'этот узел и так лежит здесь');
  }
  db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?,?,?)').run(from_id, to_id, kind);
}
export const removeLink = (from_id, to_id, kind) =>
  db.prepare('DELETE FROM links WHERE from_id = ? AND to_id = ? AND kind = ?').run(from_id, to_id, kind);

// ![[id]] и ![[id|type=doc]] — вставка, [[id]] — упоминание. Связи строятся при сохранении дока.
export const EMBED_RE = /(!?)\[\[([a-z0-9]{6,})(?:@[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
function reindexDocLinks(id, text) {
  db.prepare("DELETE FROM links WHERE from_id = ? AND kind IN ('embeds', 'mentions')").run(id);
  const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?,?,?)');
  for (const m of text.matchAll(EMBED_RE)) {
    if (m[2] !== id && exists.get(m[2])) ins.run(id, m[2], m[1] ? 'embeds' : 'mentions');
  }
}
