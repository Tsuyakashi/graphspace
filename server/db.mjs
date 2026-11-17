// Хранилище: Postgres (узлы, связи, версии, доступ) + блобы в S3 по sha256.
// Доступ: у каждого узла есть владелец (владелец корня его дерева). Пользователь видит свои деревья
// и поддеревья, которыми с ним поделились (shares). Чужое и несуществующее неотличимы: 404.
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.mjs';
import { secret } from './env.mjs';
import * as s3 from './s3.mjs';

export { HttpError };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Локальный каталог только под кэш (превью) и нативное открытие. Данных в нём нет.
export const DATA = process.env.GRAPHSPACE_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

pg.types.setTypeParser(20, Number); // bigint (size, count) — числом

function dbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('нужен DATABASE_URL (postgres://user@host:5432/db)');
  const url = new URL(raw);
  const pw = secret('DATABASE_PASSWORD');
  if (pw) url.password = encodeURIComponent(pw);
  return url.toString();
}
let pool;
const q = async (text, params) => (await pool.query(text, params)).rows;
const one = async (text, params) => (await q(text, params))[0];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id text PRIMARY KEY,
    type text NOT NULL,
    title text NOT NULL,
    parent_id text REFERENCES nodes(id),
    position double precision NOT NULL DEFAULT 0,
    props jsonb NOT NULL DEFAULT '{}',
    ext text,
    head integer,
    owner text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
  CREATE INDEX IF NOT EXISTS nodes_owner ON nodes(owner);
  CREATE TABLE IF NOT EXISTS versions (
    node_id text NOT NULL REFERENCES nodes(id),
    n integer NOT NULL,
    blob text NOT NULL,
    size bigint NOT NULL,
    author text NOT NULL,
    created_at timestamptz NOT NULL,
    name text,
    PRIMARY KEY (node_id, n)
  );
  CREATE TABLE IF NOT EXISTS links (
    from_id text NOT NULL REFERENCES nodes(id),
    to_id text NOT NULL REFERENCES nodes(id),
    kind text NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE TABLE IF NOT EXISTS shares (
    node_id text NOT NULL REFERENCES nodes(id),
    email text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (node_id, email)
  );
  CREATE INDEX IF NOT EXISTS shares_email ON shares(email);
  CREATE TABLE IF NOT EXISTS users (
    email text PRIMARY KEY,
    first_seen timestamptz NOT NULL,
    last_seen timestamptz NOT NULL
  );
`;

// База и бакет могут подниматься дольше сервера (compose): ждём до минуты.
export async function init({ tries = 60 } = {}) {
  pool = new pg.Pool({ connectionString: dbUrl(), max: 10 });
  for (let i = 1; ; i++) {
    try {
      await q(SCHEMA);
      await s3.ensureBucket();
      return;
    } catch (e) {
      if (i >= tries) throw e;
      if (i === 1 || i % 10 === 0) console.log(`ждём Postgres и S3: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
export const close = () => pool?.end();

export const TYPES = ['space', 'doc', 'board', 'office', 'pdf', 'design', 'file', 'resource'];
const now = () => new Date(); // метка из JS (мс): корзина восстанавливает по точному совпадению
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const newId = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
const notFound = () => new HttpError(404, 'узел не найден');

// ---------- пользователи ----------
const seen = new Set();
export async function touchUser(email) {
  if (seen.has(email)) return;
  const t = now();
  await q('INSERT INTO users (email, first_seen, last_seen) VALUES ($1, $2, $2) ON CONFLICT (email) DO UPDATE SET last_seen = $2', [email, t]);
  seen.add(email);
}
export const allUsers = async () => (await q('SELECT email FROM users ORDER BY email')).map((r) => r.email);

// ---------- блобы ----------
const blobKey = (hash) => `blobs/${hash.slice(0, 2)}/${hash}`;
export async function putBlob(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!(await s3.exists(blobKey(hash)))) await s3.put(blobKey(hash), bytes, hash);
  return hash;
}
export const readBlob = (hash) => s3.get(blobKey(hash));

// ---------- доступ ----------
// Видимые пользователю узлы: свои плюс поддеревья, которыми поделились.
const VISIBLE = `
  WITH RECURSIVE v(id) AS (
    SELECT id FROM nodes WHERE owner = $1
    UNION
    SELECT node_id FROM shares WHERE email = $1
    UNION
    SELECT c.id FROM nodes c JOIN v ON c.parent_id = v.id
  )`;

export async function canAccess(user, id) {
  const r = await one(`
    WITH RECURSIVE a(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE id = $2
      UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN a ON n.id = a.parent_id
    )
    SELECT (SELECT owner FROM nodes WHERE id = $2) = $1
        OR EXISTS (SELECT 1 FROM shares s JOIN a ON a.id = s.node_id WHERE s.email = $1) AS ok`, [user, id]);
  return !!r?.ok;
}

// Узел, которым поделились напрямую, и выше него пользователю ничего не видно.
export async function isShareRoot(user, n) {
  if (n.owner === user) return false;
  return !n.parent_id || !(await canAccess(user, n.parent_id));
}

// ---------- узлы ----------
const COLS = 'id, type, title, parent_id, position, props, ext, head, owner, created_at, updated_at, deleted_at';
const getNode = (id) => one(`SELECT ${COLS} FROM nodes WHERE id = $1`, [id]);

export async function mustNode(id, user, { trashed = false } = {}) {
  const n = typeof id === 'string' ? await getNode(id) : null;
  if (!n || (n.deleted_at && !trashed) || !(await canAccess(user, id))) throw notFound();
  return n;
}

export const allNodes = (user) => q(`${VISIBLE}
  SELECT ${COLS} FROM nodes n WHERE n.id IN (SELECT id FROM v) AND n.deleted_at IS NULL
  ORDER BY position, created_at`, [user]);
export const allLinks = (user) => q(`${VISIBLE}
  SELECT l.from_id, l.to_id, l.kind FROM links l
  JOIN nodes a ON a.id = l.from_id AND a.deleted_at IS NULL
  JOIN nodes b ON b.id = l.to_id AND b.deleted_at IS NULL
  WHERE l.from_id IN (SELECT id FROM v) AND l.to_id IN (SELECT id FROM v)`, [user]);

export async function createNode(user, { id, type, title, parent_id = null, props = {}, ext = null }) {
  if (!TYPES.includes(type)) throw new HttpError(400, `неизвестный тип: ${type}`);
  if (!title?.trim()) throw new HttpError(400, 'нужно имя');
  // Узлы универсальны: детей может иметь любой узел, а на верхнем уровне может жить любой тип.
  // Владелец — владелец дерева: внутри чужого общего раздела создаётся узел владельца раздела.
  const owner = parent_id ? (await mustNode(parent_id, user)).owner : user;
  id ||= newId();
  const t = now();
  await q(`INSERT INTO nodes (id, type, title, parent_id, position, props, ext, owner, created_at, updated_at)
    VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM nodes WHERE parent_id IS NOT DISTINCT FROM $4), $5, $6, $7, $8, $8)`,
    [id, type, title.trim(), parent_id, JSON.stringify(props), ext, owner, t]);
  return getNode(id);
}

export const descendants = async (id) => (await q(`
  WITH RECURSIVE d(id) AS (
    SELECT id FROM nodes WHERE parent_id = $1
    UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id
  ) SELECT id FROM d`, [id])).map((r) => r.id);

export async function updateNode(user, id, patch) {
  const n = await mustNode(id, user);
  if ('parent_id' in patch && (patch.parent_id ?? null) !== n.parent_id) {
    const to = patch.parent_id ?? null; // null — вынести на верхний уровень
    if (to) {
      const target = await mustNode(to, user);
      if (to === id || (await descendants(id)).includes(to)) throw new HttpError(400, 'нельзя перенести узел внутрь самого себя');
      // Перенос в чужое пространство сменил бы владельца: так данные не уходят.
      if (target.owner !== n.owner) throw new HttpError(400, 'переносить можно только внутри одного пространства');
    } else if (n.owner !== user) throw new HttpError(403, 'выносить на верхний уровень может только владелец');
    if (await isShareRoot(user, n)) throw new HttpError(403, 'общий раздел переносит только владелец');
    n.parent_id = to;
    n.position = (await one('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM nodes WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL', [to])).p;
  }
  if (typeof patch.title === 'string' && patch.title.trim()) n.title = patch.title.trim();
  if (patch.props && typeof patch.props === 'object') n.props = { ...n.props, ...patch.props };
  await q('UPDATE nodes SET title = $1, parent_id = $2, position = $3, props = $4, updated_at = $5 WHERE id = $6',
    [n.title, n.parent_id, n.position, JSON.stringify(n.props), now(), id]);
  return getNode(id);
}

// Удаление — это корзина: узел и потомки помечаются одной меткой времени, блобы остаются.
export async function trashNode(user, id) {
  const n = await mustNode(id, user);
  if (await isShareRoot(user, n)) throw new HttpError(403, 'общий раздел удаляет только владелец');
  const stamp = now();
  await q('UPDATE nodes SET deleted_at = $1 WHERE id = ANY($2) AND deleted_at IS NULL', [stamp, [id, ...(await descendants(id))]]);
  return stamp;
}
export async function restoreNode(user, id) {
  const n = await mustNode(id, user, { trashed: true });
  if (!n.deleted_at) throw new HttpError(404, 'в корзине такого нет');
  await q('UPDATE nodes SET deleted_at = NULL WHERE deleted_at = $1 AND owner = $2', [n.deleted_at, n.owner]);
}

// ---------- доступ: кому показан узел ----------
// Делится только владелец. Поддерево открывается целиком, на правку.
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
export async function share(user, id, email) {
  const n = await mustNode(id, user);
  if (n.owner !== user) throw new HttpError(403, 'делиться может только владелец');
  email = normEmail(email);
  if (!email || /\s/.test(email)) throw new HttpError(400, 'нужен email');
  if (email === user) throw new HttpError(400, 'это ваш узел');
  await q('INSERT INTO shares (node_id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, email, now()]);
}
export async function unshare(user, id, email) {
  const n = await mustNode(id, user);
  if (n.owner !== user) throw new HttpError(403, 'закрывать доступ может только владелец');
  await q('DELETE FROM shares WHERE node_id = $1 AND email = $2', [id, normEmail(email)]);
}
// Кому открыты мои узлы — для меню «Закрыть доступ».
export const mySharing = (user) => q(`SELECT s.node_id, s.email FROM shares s JOIN nodes n ON n.id = s.node_id
  WHERE n.owner = $1 AND n.deleted_at IS NULL ORDER BY s.created_at`, [user]);

// ---------- версии ----------
// Вызывающий уже проверил доступ к узлу (mustNode).
export const versions = (id) => q('SELECT * FROM versions WHERE node_id = $1 ORDER BY n DESC', [id]);
export const getVersion = (id, n) => one('SELECT * FROM versions WHERE node_id = $1 AND n = $2', [id, n]);

// Ничего не перезаписывается: каждое сохранение — новая версия.
// Если клиент редактировал не последнюю версию, его байты сохраняются рядом, а head не двигается.
export async function addVersion(user, id, bytes, { author = user, base = null, name = null } = {}) {
  await mustNode(id, user);
  const blob = await putBlob(bytes);
  const c = await pool.connect();
  let result, reindex = null;
  try {
    await c.query('BEGIN');
    const node = (await c.query('SELECT id, type, head FROM nodes WHERE id = $1 FOR UPDATE', [id])).rows[0];
    const head = node.head ? (await c.query('SELECT * FROM versions WHERE node_id = $1 AND n = $2', [id, node.head])).rows[0] : null;
    if (head && head.blob === blob && !name) result = { version: head, unchanged: true };
    else {
      const n = (await c.query('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM versions WHERE node_id = $1', [id])).rows[0].n;
      const conflict = base != null && node.head != null && Number(base) !== node.head;
      const vname = conflict ? `конфликт: правка поверх v${base}, а текущая v${node.head}` : name;
      const t = now();
      const version = (await c.query('INSERT INTO versions (node_id, n, blob, size, author, created_at, name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [id, n, blob, bytes.length, author, t, vname])).rows[0];
      if (!conflict) {
        await c.query('UPDATE nodes SET head = $1, updated_at = $2 WHERE id = $3', [n, t, id]);
        if (node.type === 'doc') reindex = bytes.toString('utf8');
      }
      result = { version, conflict };
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
  if (reindex != null) await reindexDocLinks(user, id, reindex);
  return result;
}

export async function nameVersion(id, n, name) {
  const v = await one('UPDATE versions SET name = $1 WHERE node_id = $2 AND n = $3 RETURNING *', [name?.trim() || null, id, n]);
  if (!v) throw new HttpError(404, 'версия не найдена');
  return v;
}

export async function headBytes(node) {
  return node.head ? readBlob((await getVersion(node.id, node.head)).blob) : null;
}

// ---------- связи ----------
export async function ancestors(id) {
  return (await q(`WITH RECURSIVE a(id, parent_id, d) AS (
      SELECT id, parent_id, 0 FROM nodes WHERE id = $1
      UNION ALL SELECT n.id, n.parent_id, a.d + 1 FROM nodes n JOIN a ON n.id = a.parent_id
    ) SELECT id FROM a WHERE d > 0 ORDER BY d`, [id])).map((r) => r.id);
}
// uses — «этим пользуются отсюда»: узел остаётся в своём доме. Ссылаться можно на что угодно видимое,
// включая разделы, кроме самого себя, собственных предков и того, что и так лежит прямо внутри.
export async function addLink(user, from_id, to_id, kind) {
  await mustNode(from_id, user);
  const to = await mustNode(to_id, user);
  if (from_id === to_id) throw new HttpError(400, 'ссылка на самого себя');
  if (kind === 'uses') {
    if ((await ancestors(from_id)).includes(to_id)) throw new HttpError(400, 'нельзя сослаться на раздел, внутри которого находишься');
    if (to.parent_id === from_id) throw new HttpError(400, 'этот узел и так лежит здесь');
  }
  await q('INSERT INTO links (from_id, to_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [from_id, to_id, kind]);
}
export async function removeLink(user, from_id, to_id, kind) {
  await mustNode(from_id, user);
  await q('DELETE FROM links WHERE from_id = $1 AND to_id = $2 AND kind = $3', [from_id, to_id, kind]);
}

// ![[id]] и ![[id|type=doc]] — вставка, [[id]] — упоминание. Связи строятся при сохранении дока,
// и только на узлы, которые видит автор правки.
export const EMBED_RE = /(!?)\[\[([a-z0-9]{6,})(?:@[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
async function reindexDocLinks(user, id, text) {
  await q("DELETE FROM links WHERE from_id = $1 AND kind IN ('embeds', 'mentions')", [id]);
  for (const m of text.matchAll(EMBED_RE)) {
    if (m[2] === id || !(await canAccess(user, m[2]))) continue;
    await q('INSERT INTO links (from_id, to_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m[2], m[1] ? 'embeds' : 'mentions']);
  }
}

// Для демо-наборов.
export const setPosition = (id, position) => q('UPDATE nodes SET position = $1 WHERE id = $2', [position, id]);
export const countOwned = async (user) => (await one('SELECT COUNT(*) AS c FROM nodes WHERE owner = $1', [user])).c;
export const resetOwned = async (user) => {
  const ids = (await q('SELECT id FROM nodes WHERE owner = $1', [user])).map((r) => r.id);
  await q('DELETE FROM links WHERE from_id = ANY($1) OR to_id = ANY($1)', [ids]);
  await q('DELETE FROM shares WHERE node_id = ANY($1)', [ids]);
  await q('DELETE FROM versions WHERE node_id = ANY($1)', [ids]);
  await q('UPDATE nodes SET parent_id = NULL WHERE id = ANY($1)', [ids]);
  await q('DELETE FROM nodes WHERE id = ANY($1)', [ids]);
};
