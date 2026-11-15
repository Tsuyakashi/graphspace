// Тесты API: node --test tests/api.test.mjs. Зависимостей нет, сервер поднимается на временных данных.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const make = async (node) => {
  const r = await s.call('POST', '/api/nodes', node);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const state = async () => (await s.call('GET', '/api/state')).body;

test('узлы универсальны: любой тип на верхнем уровне и дети у любого узла', async () => {
  const repo = await make({ type: 'resource', title: 'repo', props: { kind: 'git' } });
  assert.equal(repo.parent_id, null);
  const doc = await make({ type: 'doc', title: 'README', parent_id: repo.id, ext: 'md' });
  assert.equal(doc.parent_id, repo.id);
  const board = await make({ type: 'board', title: 'схема', parent_id: doc.id, ext: 'excalidraw' });
  assert.equal(board.parent_id, doc.id);
  assert.equal((await s.call('POST', '/api/nodes', { type: 'nope', title: 'x' })).status, 400);
  assert.equal((await s.call('POST', '/api/nodes', { type: 'doc', title: '  ' })).status, 400);
});

test('перенос: в другой узел, на верхний уровень, но не внутрь самого себя', async () => {
  const a = await make({ type: 'space', title: 'a' });
  const b = await make({ type: 'space', title: 'b', parent_id: a.id });
  const c = await make({ type: 'doc', title: 'c', parent_id: b.id, ext: 'md' });
  assert.equal((await s.call('PATCH', `/api/nodes/${a.id}`, { parent_id: c.id })).status, 400);
  assert.equal((await s.call('PATCH', `/api/nodes/${a.id}`, { parent_id: a.id })).status, 400);
  assert.equal((await s.call('PATCH', `/api/nodes/${c.id}`, { parent_id: a.id })).body.parent_id, a.id);
  assert.equal((await s.call('PATCH', `/api/nodes/${b.id}`, { parent_id: null })).body.parent_id, null);
  assert.equal((await s.call('PATCH', `/api/nodes/${a.id}`, { parent_id: b.id })).body.parent_id, b.id); // проект вложился в бывшего ребёнка
});

test('версии: сохранение ничего не перезаписывает, снапшот и возврат', async () => {
  const d = await make({ type: 'doc', title: 'версии', ext: 'md' });
  assert.equal((await s.put(d.id, 'один', null)).body.version.n, 1);
  assert.equal((await s.put(d.id, 'два', 1)).body.version.n, 2);
  assert.equal((await s.put(d.id, 'два', 2)).body.unchanged, true); // те же байты — версии не плодятся
  assert.equal(await s.text(d.id), 'два');
  assert.equal(await s.text(d.id, 1), 'один');

  const named = await s.call('PATCH', `/api/nodes/${d.id}/versions/1`, { name: 'отправлено' });
  assert.equal(named.body.name, 'отправлено');
  assert.equal((await s.call('POST', `/api/nodes/${d.id}/versions/1/restore`)).body.version.n, 3);
  assert.equal(await s.text(d.id), 'один');
  const list = (await s.call('GET', `/api/nodes/${d.id}/versions`)).body;
  assert.deepEqual(list.map((v) => v.n), [3, 2, 1]);
});

test('конфликт: правка поверх устаревшей версии ложится рядом, текущая не меняется', async () => {
  const d = await make({ type: 'doc', title: 'конфликт', ext: 'md' });
  await s.put(d.id, 'v1', null);
  await s.put(d.id, 'v2', 1);
  const stale = await s.put(d.id, 'опоздавшая правка', 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.match(stale.body.version.name, /конфликт/);
  assert.equal(await s.text(d.id), 'v2');
  assert.equal(await s.text(d.id, stale.body.version.n), 'опоздавшая правка'); // ничего не потеряно
  assert.equal((await state()).nodes.find((n) => n.id === d.id).head, 2);
});

test('ссылки uses: можно на раздел, нельзя на себя, предка и собственного ребёнка', async () => {
  const p = await make({ type: 'space', title: 'p' });
  const x = await make({ type: 'space', title: 'x', parent_id: p.id });
  const y = await make({ type: 'space', title: 'y', parent_id: p.id });
  const kid = await make({ type: 'resource', title: 'reg', parent_id: x.id, props: { kind: 'registry' } });
  const link = (from, to) => s.call('POST', '/api/links', { from, to, kind: 'uses' });
  assert.equal((await link(y.id, kid.id)).status, 200);
  assert.equal((await link(y.id, x.id)).status, 200); // общий раздел целиком
  assert.equal((await link(x.id, x.id)).status, 400);
  assert.equal((await link(x.id, p.id)).status, 400);
  assert.equal((await link(x.id, kid.id)).status, 400);
  assert.equal((await s.call('POST', '/api/links', { from: y.id, to: kid.id, kind: 'embeds' })).status, 400); // embeds строит только сервер
  const uses = (await state()).links.filter((l) => l.from_id === y.id && l.kind === 'uses');
  assert.equal(uses.length, 2);
  await s.call('DELETE', '/api/links', { from: y.id, to: x.id, kind: 'uses' });
  assert.equal((await state()).links.filter((l) => l.from_id === y.id && l.kind === 'uses').length, 1);
});

test('связи дока строятся из текста при сохранении', async () => {
  const a = await make({ type: 'doc', title: 'a', ext: 'md' });
  const b = await make({ type: 'doc', title: 'b', ext: 'md' });
  await s.put(a.id, `текст\n\n![[${b.id}]]\n\nи упоминание [[${b.id}]], и ![[${b.id}|type=doc]]`, null);
  let mine = (await state()).links.filter((l) => l.from_id === a.id).map((l) => l.kind).sort();
  assert.deepEqual(mine, ['embeds', 'mentions']);
  await s.put(a.id, 'вставок больше нет', 1);
  mine = (await state()).links.filter((l) => l.from_id === a.id);
  assert.equal(mine.length, 0);
});

test('корзина: удаление с потомками обратимо', async () => {
  const p = await make({ type: 'space', title: 'корзина' });
  const d = await make({ type: 'doc', title: 'внутри', parent_id: p.id, ext: 'md' });
  await s.put(d.id, 'текст', null);
  assert.equal((await s.call('DELETE', `/api/nodes/${p.id}`)).status, 200);
  let ids = (await state()).nodes.map((n) => n.id);
  assert.ok(!ids.includes(p.id) && !ids.includes(d.id));
  assert.equal((await s.call('PATCH', `/api/nodes/${d.id}`, { title: 'x' })).status, 404);
  assert.equal((await s.call('POST', `/api/nodes/${p.id}/restore`)).status, 200);
  ids = (await state()).nodes.map((n) => n.id);
  assert.ok(ids.includes(p.id) && ids.includes(d.id));
  assert.equal(await s.text(d.id), 'текст');
});

test('статика не выпускает за пределы каталога', async () => {
  for (const url of ['/craft/../../etc/passwd', '/craft/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await fetch(s.base + url);
    const body = await res.text();
    assert.ok(!body.includes('root:'), url);
  }
});
