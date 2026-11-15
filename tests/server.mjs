// Общая обвязка тестов: сервер на свободном порту с временным каталогом данных.
import { spawn } from 'node:child_process';
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

export async function startServer({ seed = false } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'graphspace-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GRAPHSPACE_DATA: data, GRAPHSPACE_SEED: seed ? '1' : '0', GRAPHSPACE_DEMO: 'orbit', GRAPHSPACE_AUTHOR: 'test' },
  });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`сервер не запустился, код ${code}`)));
    child.stdout.on('data', (d) => String(d).includes('Graphspace:') && resolve());
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async stop() { child.kill(); await new Promise((r) => child.once('exit', r)); fs.rmSync(data, { recursive: true, force: true }); },
    // JSON-запрос: возвращает статус и тело, не бросает на 4xx — тесты проверяют и отказы.
    async call(method, url, body) {
      const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async put(id, bytes, baseVersion) {
      const res = await fetch(`${base}/api/nodes/${id}/content`, { method: 'PUT', headers: { 'x-base-version': baseVersion == null ? '' : String(baseVersion) }, body: bytes });
      return { status: res.status, body: await res.json() };
    },
    text: async (id, v) => (await fetch(`${base}/api/nodes/${id}/content${v ? `?v=${v}` : ''}`)).text(),
  };
}
