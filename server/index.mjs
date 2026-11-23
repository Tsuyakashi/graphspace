// Сервер Graphspace: API, события, раздача интерфейса и веб-сборок Craft с одного origin.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import {
  ROOT, DATA, HttpError, init, allNodes, allLinks, createNode, updateNode, trashNode, restoreNode, mustNode,
  versions, getVersion, addVersion, nameVersion, headBytes, readBlob, addLink, removeLink,
  touchUser, allUsers, share, unshare, mySharing,
} from './db.mjs';
import { checkS3Config } from './s3.mjs';
import { seedIfEmpty } from './seed.mjs';
import { exportDoc, exportSpace } from './export.mjs';
import { AUTH_MODE, DEV_USER, checkAuthConfig, userOf } from './auth.mjs';

const PORT = Number(process.env.PORT || 4680);
const HOST = process.env.HOST || '127.0.0.1';
// Веб-сборки Craft: ./craft (ставит setup-craft.sh), иначе каталог из переменной.
const CRAFT_DIR = process.env.GRAPHSPACE_CRAFT_DIR || path.join(ROOT, 'craft');
const DIST = path.join(ROOT, 'web', 'dist');

// Какое приложение Craft отвечает за расширение: веб-сборка (iframe) и нативный бинарник.
const CRAFT_BY_EXT = {
  docx: 'wordcraft', odt: 'wordcraft', rtf: 'wordcraft',
  xlsx: 'gridcraft', csv: 'gridcraft',
  pptx: 'deckcraft', deckcraft: 'deckcraft', // .deckcraft — свой формат DeckCraft (Save безымянной презентации)
  pdf: 'pdfcraft',
  fig: 'figcraft',
};
const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, bin)));
const craftApps = [...new Set(Object.values(CRAFT_BY_EXT))];
const config = {
  craftByExt: CRAFT_BY_EXT,
  web: Object.fromEntries(craftApps.map((a) => [a, fs.existsSync(path.join(CRAFT_DIR, a, 'index.html'))])),
  native: Object.fromEntries(craftApps.map((a) => [a, onPath(a)])),
  preview: onPath('wordcraft-cli'),
  auth: AUTH_MODE, // интерфейсу: показать, кто вошёл и как
};

// ---------- события для клиентов ----------
// Событие без id: клиент по нему просто перечитывает своё состояние, а чужие id никуда не уходят.
const listeners = new Set();
function broadcast() {
  for (const res of listeners) res.write('data: {"type":"changed"}\n\n');
}

// ---------- нативное открытие: checkout → приложение → слежение за файлом → новая версия ----------
const checkouts = new Map();
const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
async function openNative(node, user) {
  const app = CRAFT_BY_EXT[node.ext];
  if (!app || !config.native[app]) throw new HttpError(409, `нативное приложение для .${node.ext} не установлено`);
  const bytes = await headBytes(node);
  if (!bytes) throw new HttpError(409, 'у узла ещё нет содержимого');
  const dir = path.join(DATA, 'checkout', node.id);
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(node.title);
  const file = path.join(dir, base.toLowerCase().endsWith('.' + node.ext) ? base : `${base}.${node.ext}`);
  if (checkouts.has(node.id)) return { file, already: true };
  fs.writeFileSync(file, bytes);

  let timer = null;
  const pull = async () => {
    try {
      const fresh = fs.readFileSync(file);
      if (!fresh.length) return;
      const r = await addVersion(user, node.id, fresh, { author: `${user} · ${app}` });
      if (!r.unchanged) broadcast();
    } catch { /* файл в середине записи или уже удалён — следующий сигнал повторит */ }
  };
  // Следим за каталогом, а не за файлом: редакторы часто сохраняют через временный файл и переименование.
  const watcher = fs.watch(dir, () => { clearTimeout(timer); timer = setTimeout(pull, 400); });
  const child = spawn(app, [file], { detached: true, stdio: 'ignore' });
  child.on('error', () => { watcher.close(); checkouts.delete(node.id); });
  child.on('exit', () => setTimeout(() => { pull(); watcher.close(); checkouts.delete(node.id); broadcast(); }, 600));
  child.unref();
  checkouts.set(node.id, { file, app });
  return { file };
}

// ---------- превью docx первой страницей ----------
async function preview(node, res) {
  if (!config.preview || !['docx', 'odt', 'rtf'].includes(node.ext) || !node.head) throw new HttpError(404, 'превью нет');
  const blob = (await getVersion(node.id, node.head)).blob;
  const dir = path.join(DATA, 'cache');
  const out = path.join(dir, `${blob}.png`);
  const send = () => sendFile(res, out, 'image/png', 'private, max-age=31536000, immutable');
  if (fs.existsSync(out)) return send();
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${blob}.${node.ext}`);
  fs.writeFileSync(src, await readBlob(blob));
  execFile('wordcraft-cli', ['render', src, out, '--page', '1'], { timeout: 30000 }, (err) => {
    fs.rm(src, { force: true }, () => {});
    if (err || !fs.existsSync(out)) return fail(res, new HttpError(500, 'не удалось построить превью'));
    send();
  });
}

// ---------- HTTP ----------
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mime = (ext) => MIME[(ext || '').toLowerCase()] || 'application/octet-stream';
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, e) => {
  if (res.headersSent) return res.end();
  if (!(e instanceof HttpError)) console.error(e);
  json(res, { error: e.message || 'ошибка сервера' }, e.status || 500);
};
function sendFile(res, file, type, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, new HttpError(404, 'нет такого файла'));
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}
// Статика из каталога с защитой от выхода за его пределы.
function serveStatic(res, base, rel, { spa = false } = {}) {
  let file = path.join(base, path.normalize('/' + decodeURIComponent(rel)));
  if (!file.startsWith(base)) return fail(res, new HttpError(403, 'нельзя'));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    // Запасной index.html — только для адресов страниц, не для потерянных файлов.
    if (!spa || path.extname(file)) return fail(res, new HttpError(404, 'нет такого файла'));
    file = path.join(base, 'index.html');
  }
  const ext = path.extname(file).slice(1);
  const hashed = /-[0-9a-f]{8,}[._]/i.test(path.basename(file)) || file.includes(`${path.sep}assets${path.sep}`);
  sendFile(res, file, mime(ext), ext === 'html' || !hashed ? 'no-cache' : 'public, max-age=31536000, immutable');
}
const readBody = (req, limit = 512 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'слишком большой файл')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req) => {
  const b = await readBody(req, 4 * 1024 * 1024);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw new HttpError(400, 'ожидался JSON'); }
};

async function api(req, res, url, user) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // без "api"
  const m = req.method;
  const changed = () => broadcast();

  if (seg[0] === 'config' && m === 'GET') return json(res, { ...config, author: user });
  if (seg[0] === 'state' && m === 'GET') {
    const [nodes, links, users, sharing] = await Promise.all([allNodes(user), allLinks(user), allUsers(), mySharing(user)]);
    const ids = new Set(nodes.map((n) => n.id));
    return json(res, { me: user, nodes, links, users, sharing, checkouts: [...checkouts.keys()].filter((id) => ids.has(id)) });
  }

  if (seg[0] === 'events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': ok\n\n');
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  if (seg[0] === 'links') {
    const { from, to, kind = 'uses' } = await readJson(req);
    if (kind !== 'uses') throw new HttpError(400, 'вручную создаётся только связь uses');
    if (m === 'POST') { await addLink(user, from, to, kind); changed(); return json(res, { ok: true }); }
    if (m === 'DELETE') { await removeLink(user, from, to, kind); changed(); return json(res, { ok: true }); }
  }

  if (seg[0] === 'nodes' && seg.length === 1 && m === 'POST') {
    const node = await createNode(user, await readJson(req));
    changed();
    return json(res, node, 201);
  }

  if (seg[0] === 'nodes' && seg[1]) {
    const id = seg[1];
    const sub = seg[2];
    if (sub === 'restore' && m === 'POST') { await restoreNode(user, id); changed(); return json(res, { ok: true }); }
    // Дальше — только видимые узлы. Чужой и несуществующий неотличимы: 404.
    const node = await mustNode(id, user);
    if (!sub && m === 'PATCH') { const n = await updateNode(user, id, await readJson(req)); changed(); return json(res, n); }
    if (!sub && m === 'DELETE') { await trashNode(user, id); changed(); return json(res, { ok: true }); }

    if (sub === 'shares' && m === 'POST') { await share(user, id, (await readJson(req)).email); changed(); return json(res, { ok: true }); }
    if (sub === 'shares' && seg[3] && m === 'DELETE') { await unshare(user, id, decodeURIComponent(seg[3])); changed(); return json(res, { ok: true }); }

    if (sub === 'content' && m === 'GET') {
      const n = url.searchParams.get('v') ? Number(url.searchParams.get('v')) : node.head;
      const v = n && await getVersion(id, n);
      if (!v) throw new HttpError(404, 'содержимого нет');
      const bytes = await readBlob(v.blob);
      const headers = { 'content-type': mime(node.ext), 'content-length': bytes.length, 'cache-control': 'no-store', 'x-version': String(v.n), 'x-content-type-options': 'nosniff' };
      if (url.searchParams.has('download')) {
        const name = node.title.toLowerCase().endsWith('.' + node.ext) || !node.ext ? node.title : `${node.title}.${node.ext}`;
        headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      }
      res.writeHead(200, headers);
      return res.end(bytes);
    }
    if (sub === 'content' && m === 'PUT') {
      const bytes = await readBody(req);
      const base = req.headers['x-base-version'] ?? null;
      const r = await addVersion(user, id, bytes, { base: base === '' ? null : base });
      if (!r.unchanged) changed();
      return json(res, r, r.conflict ? 409 : 200);
    }
    if (sub === 'versions' && !seg[3] && m === 'GET') return json(res, await versions(id));
    if (sub === 'versions' && seg[3] && m === 'PATCH') {
      const v = await nameVersion(id, Number(seg[3]), (await readJson(req)).name);
      changed();
      return json(res, v);
    }
    if (sub === 'versions' && seg[3] && seg[4] === 'restore' && m === 'POST') {
      const old = await getVersion(id, Number(seg[3]));
      if (!old) throw new HttpError(404, 'версия не найдена');
      const r = await addVersion(user, id, await readBlob(old.blob), { name: `возврат к v${old.n}` });
      changed();
      return json(res, r);
    }
    if (sub === 'export' && m === 'GET') {
      const { name, bytes } = node.type === 'space' ? await exportSpace(user, id) : await exportDoc(user, id, `http://${req.headers.host}`);
      res.writeHead(200, { 'content-type': node.type === 'space' ? 'application/zip' : mime('md'), 'content-length': bytes.length, 'cache-control': 'no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      return res.end(bytes);
    }
    if (sub === 'preview' && m === 'GET') return preview(node, res);
    if (sub === 'open-native' && m === 'POST') { const r = await openNative(node, user); changed(); return json(res, r); }
  }
  throw new HttpError(404, 'нет такого метода');
}

let authInfo, s3Info;
try { authInfo = checkAuthConfig(); s3Info = checkS3Config(); await init(); } catch (e) { console.error(`Graphspace не запущен: ${e.message}`); process.exit(1); }
// Демо — только в режиме разработки: в проде у каждого своё пустое пространство.
if (AUTH_MODE === 'dev' && process.env.GRAPHSPACE_SEED !== '0') await seedIfEmpty(DEV_USER.toLowerCase());

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Проверка живости для Docker: без входа и без данных.
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  let user;
  try { user = await userOf(req); await touchUser(user); } catch (e) { return fail(res, e); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url, user).catch((e) => fail(res, e));
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, new HttpError(405, 'метод не поддерживается'));
  if (url.pathname.startsWith('/craft/')) return serveStatic(res, CRAFT_DIR, url.pathname.slice('/craft'.length));
  if (!fs.existsSync(DIST)) return fail(res, new HttpError(503, 'интерфейс не собран: npm run build'));
  serveStatic(res, DIST, url.pathname, { spa: true });
}).listen(PORT, HOST, () => {
  console.log(`Graphspace: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  кэш: ${DATA}, блобы: ${s3Info}`);
  console.log(`  вход: ${authInfo}`);
  console.log(`  Craft в вебе: ${Object.entries(config.web).filter(([, v]) => v).map(([k]) => k).join(', ') || 'нет'} (${CRAFT_DIR})`);
  console.log(`  Craft нативно: ${Object.entries(config.native).filter(([, v]) => v).map(([k]) => k).join(', ') || 'нет'}`);
});
