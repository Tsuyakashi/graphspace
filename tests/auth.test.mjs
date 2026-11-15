// Вход через Cloudflare Access: сервер верит только JWT с подписью команды, правильными aud и iss.
// JWKS отдаёт локальный сервер с тестовым ключом.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startServer } from './server.mjs';

const AUD = 'test-aud-123';
const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let team, jwks, s;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { key = good.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg, kid, typ: 'JWT' })}.${b64({ iss: team, aud: [AUD], iat: now, nbf: now, exp: now + 600, email: 'me@example.com', ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

before(async () => {
  jwks = http.createServer((req, res) => {
    if (req.url !== '/cdn-cgi/access/certs') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  team = `http://127.0.0.1:${jwks.address().port}`;
  s = await startServer({ env: { AUTH_MODE: '', CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: AUD } });
});
after(async () => { await s.stop(); jwks.close(); });

const as = (token) => (token ? { 'cf-access-jwt-assertion': token } : {});
const status = async (url, headers = {}) => (await fetch(s.base + url, { headers })).status;

test('без валидного JWT — 401 везде, кроме /healthz', async () => {
  assert.equal(await status('/healthz'), 200);
  for (const url of ['/', '/api/state', '/craft/wordcraft/index.html', '/api/events']) assert.equal(await status(url), 401, url);
  // Заголовку с почтой без JWT не верим.
  assert.equal(await status('/api/state', { 'cf-access-authenticated-user-email': 'me@example.com' }), 401);
});

test('плохие токены отклоняются', async () => {
  const now = Math.floor(Date.now() / 1000);
  const bad = {
    'чужой ключ': sign({}, { key: evil.privateKey }),
    'неизвестный kid': sign({}, { kid: 'nope' }),
    'чужой aud': sign({ aud: ['other'] }),
    'чужой iss': sign({ iss: 'https://evil.cloudflareaccess.com' }),
    'истёк': sign({ exp: now - 3600 }),
    'ещё не действует': sign({ nbf: now + 3600 }),
    'alg none': `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: team, aud: [AUD], exp: now + 600, email: 'x@y' })}.`,
    'мусор': 'a.b.c',
  };
  for (const [name, token] of Object.entries(bad)) assert.equal(await status('/api/state', as(token)), 401, name);
});

test('валидный JWT: доступ, пользователь — автор версий', async () => {
  const h = as(sign({}));
  assert.equal(await status('/', h), 200);
  assert.equal((await s.call('GET', '/api/config', undefined, h)).body.author, 'me@example.com');
  const doc = (await s.call('POST', '/api/nodes', { type: 'doc', title: 'вход', ext: 'md' }, h)).body;
  const put = await fetch(`${s.base}/api/nodes/${doc.id}/content`, { method: 'PUT', headers: { ...h, 'x-base-version': '' }, body: 'текст' });
  assert.equal((await put.json()).version.author, 'me@example.com');
  // Сервисный токен Access: вместо почты common_name.
  assert.equal((await s.call('GET', '/api/config', undefined, as(sign({ email: undefined, common_name: 'abc.access' })))).body.author, 'abc.access');
});
