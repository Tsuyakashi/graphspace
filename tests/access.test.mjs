// Доступ: у каждого своё пространство, общие поддеревья открывает только владелец.
// Чужое и несуществующее неотличимы — 404. Пользователи — заголовок dev-режима.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const A = 'alice@example.com', B = 'bob@example.com';
const call = (who, method, url, body) => s.call(method, url, body, s.as(who));
const make = async (who, node) => {
  const r = await call(who, 'POST', '/api/nodes', node);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const state = async (who) => (await call(who, 'GET', '/api/state')).body;
const ids = async (who) => new Set((await state(who)).nodes.map((n) => n.id));

test('чужое пространство не видно и неотличимо от несуществующего', async () => {
  const p = await make(A, { type: 'space', title: 'личное A' });
  const d = await make(A, { type: 'doc', title: 'секрет', parent_id: p.id, ext: 'md' });
  await s.put(d.id, 'секрет', null, s.as(A));
  assert.equal(p.owner, A);
  assert.equal(d.owner, A);

  assert.ok(!(await ids(B)).has(p.id));
  const probes = [
    ['GET', `/api/nodes/${d.id}/content`], ['GET', `/api/nodes/${d.id}/versions`], ['GET', `/api/nodes/${d.id}/export`],
    ['PATCH', `/api/nodes/${d.id}`, { title: 'x' }], ['DELETE', `/api/nodes/${d.id}`], ['POST', `/api/nodes/${p.id}/restore`],
    ['POST', '/api/nodes', { type: 'doc', title: 'x', parent_id: p.id, ext: 'md' }],
    ['GET', '/api/nodes/nosuchnode/content'],
  ];
  for (const [m, url, body] of probes) assert.equal((await call(B, m, url, body)).status, 404, `${m} ${url}`);
  assert.equal((await s.put(d.id, 'взлом', null, s.as(B))).status, 404);
  assert.equal(await s.text(d.id, null, s.as(A)), 'секрет');

  // Ссылка из своего на чужое — тоже «не найдено».
  const mine = await make(B, { type: 'space', title: 'B' });
  assert.equal((await call(B, 'POST', '/api/links', { from: mine.id, to: d.id, kind: 'uses' })).status, 404);
});

test('общий раздел: получатель видит поддерево и правит его, владелец — всё', async () => {
  const p = await make(A, { type: 'space', title: 'совместный' });
  const inside = await make(A, { type: 'doc', title: 'план', parent_id: p.id, ext: 'md' });
  const outside = await make(A, { type: 'space', title: 'не общее' });
  await s.put(inside.id, 'v1', null, s.as(A));

  assert.equal((await call(A, 'POST', `/api/nodes/${p.id}/shares`, { email: ' Bob@Example.com ' })).status, 200);
  const st = await state(B);
  const seen = new Set(st.nodes.map((n) => n.id));
  assert.ok(seen.has(p.id) && seen.has(inside.id) && !seen.has(outside.id));
  assert.equal(st.nodes.find((n) => n.id === p.id).owner, A);
  assert.ok((await state(A)).sharing.some((x) => x.node_id === p.id && x.email === B));
  assert.ok(st.users.includes(A) && st.users.includes(B));

  // Правка и создание внутри — от имени получателя, узлы остаются в пространстве владельца.
  assert.equal((await s.put(inside.id, 'v2 от B', 1, s.as(B))).body.version.author, B);
  const added = await make(B, { type: 'doc', title: 'от B', parent_id: p.id, ext: 'md' });
  assert.equal(added.owner, A);
  assert.ok((await ids(A)).has(added.id));

  // Удалить и переносить корень общего раздела, выносить наверх и делиться дальше — только владелец.
  assert.equal((await call(B, 'DELETE', `/api/nodes/${p.id}`)).status, 403);
  assert.equal((await call(B, 'PATCH', `/api/nodes/${added.id}`, { parent_id: null })).status, 403);
  assert.equal((await call(B, 'POST', `/api/nodes/${p.id}/shares`, { email: 'eve@example.com' })).status, 403);
  // Перенос между пространствами сменил бы владельца.
  const bSpace = await make(B, { type: 'space', title: 'своё B' });
  assert.equal((await call(B, 'PATCH', `/api/nodes/${added.id}`, { parent_id: bSpace.id })).status, 400);
  assert.equal((await call(B, 'PATCH', `/api/nodes/${bSpace.id}`, { parent_id: p.id })).status, 400);
  // Ребёнка внутри общего удалить можно.
  assert.equal((await call(B, 'DELETE', `/api/nodes/${added.id}`)).status, 200);

  // Закрыли доступ — всё снова 404.
  assert.equal((await call(A, 'DELETE', `/api/nodes/${p.id}/shares/${encodeURIComponent(B)}`)).status, 200);
  assert.ok(!(await ids(B)).has(p.id));
  assert.equal((await call(B, 'GET', `/api/nodes/${inside.id}/versions`)).status, 404);
});

test('вставка недоступного узла в общем доке: у получателя «не найден», содержимое не утекает', async () => {
  const p = await make(A, { type: 'space', title: 'общий с вставкой' });
  const priv = await make(A, { type: 'doc', title: 'личный', ext: 'md' });
  const d = await make(A, { type: 'doc', title: 'общий', parent_id: p.id, ext: 'md' });
  await s.put(priv.id, 'ЛИЧНЫЙ ТЕКСТ', null, s.as(A));
  await s.put(d.id, `# Общий\n\n![[${priv.id}]]\n\nсм. [[${priv.id}]]`, null, s.as(A));
  await call(A, 'POST', `/api/nodes/${p.id}/shares`, { email: B });

  const mine = await (await fetch(`${s.base}/api/nodes/${d.id}/export`, { headers: s.as(A) })).text();
  assert.match(mine, /ЛИЧНЫЙ ТЕКСТ/);
  const theirs = await (await fetch(`${s.base}/api/nodes/${d.id}/export`, { headers: s.as(B) })).text();
  assert.ok(!theirs.includes('ЛИЧНЫЙ ТЕКСТ'));
  assert.match(theirs, /не найден/);
  // Связь на личный узел получателю не показывается.
  assert.ok(!(await state(B)).links.some((l) => l.to_id === priv.id));
});

test('корзина: восстанавливает только то, что видишь', async () => {
  const p = await make(A, { type: 'space', title: 'в корзину' });
  await call(A, 'DELETE', `/api/nodes/${p.id}`);
  assert.equal((await call(B, 'POST', `/api/nodes/${p.id}/restore`)).status, 404);
  assert.equal((await call(A, 'POST', `/api/nodes/${p.id}/restore`)).status, 200);
});
