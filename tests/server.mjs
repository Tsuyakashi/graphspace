// Общая обвязка тестов: сервер на свободном порту со своей временной базой и бакетом.
// Нужны Postgres (TEST_DATABASE_URL — админское подключение, по умолчанию локальный postgres)
// и S3 (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY) — в CI это service-контейнеры.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const ADMIN = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

export async function startServer({ seed = false, env = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'graphspace-test-'));
  const tag = `gs_test_${randomBytes(4).toString('hex')}`;
  await admin(`CREATE DATABASE ${tag}`);
  const dbUrl = new URL(ADMIN); dbUrl.pathname = `/${tag}`;
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', GRAPHSPACE_DATA: data, GRAPHSPACE_SEED: seed ? '1' : '0', GRAPHSPACE_DEMO: 'orbit',
      AUTH_MODE: 'dev', AUTH_DEV_USER: 'test', DATABASE_URL: dbUrl.toString(), S3_BUCKET: tag.replace(/_/g, '-'), ...env,
    },
  });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`сервер не запустился, код ${code}`)));
    child.stdout.on('data', (d) => String(d).includes('Graphspace:') && resolve());
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async stop() {
      child.kill(); await new Promise((r) => child.once('exit', r));
      fs.rmSync(data, { recursive: true, force: true });
      await admin(`DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    },
    // JSON-запрос: возвращает статус и тело, не бросает на 4xx — тесты проверяют и отказы.
    // as — от чьего имени (AUTH_MODE=dev): заголовок x-graphspace-dev-user.
    as: (user) => ({ 'x-graphspace-dev-user': user }),
    async call(method, url, body, headers = {}) {
      const res = await fetch(base + url, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async put(id, bytes, baseVersion, headers = {}) {
      const res = await fetch(`${base}/api/nodes/${id}/content`, { method: 'PUT', headers: { ...headers, 'x-base-version': baseVersion == null ? '' : String(baseVersion) }, body: bytes });
      return { status: res.status, body: await res.json() };
    },
    text: async (id, v, headers = {}) => (await fetch(`${base}/api/nodes/${id}/content${v ? `?v=${v}` : ''}`, { headers })).text(),
  };
}
