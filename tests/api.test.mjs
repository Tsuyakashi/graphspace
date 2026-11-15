// Тесты API: node --test tests/api.test.mjs. Зависимостей нет, сервер поднимается на временных данных.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
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

// Разбор zip по центральному каталогу: имя → текст.
function unzip(buf) {
  const out = {};
  let p = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(p + 10);
  p = buf.readUInt32LE(p + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const off = buf.readUInt32LE(p + 42);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const body = buf.subarray(start, start + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8');
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test('экспорт дока: один md, вставки раскрыты текстом цитатами, заголовки по глубине', async () => {
  const p = await make({ type: 'space', title: 'Проект #1' });
  const mk = await make({ type: 'space', title: 'mk', parent_id: p.id });
  const dev = await make({ type: 'space', title: 'dev', parent_id: p.id });
  const other = await make({ type: 'space', title: 'чужое' });
  const top = await make({ type: 'doc', title: 'README.md', parent_id: p.id, ext: 'md' });
  const mkDoc = await make({ type: 'doc', title: 'mk.md', parent_id: mk.id, ext: 'md' });
  const devDoc = await make({ type: 'doc', title: 'dev.md', parent_id: dev.id, ext: 'md' });
  const infra = await make({ type: 'doc', title: 'infra.md', parent_id: dev.id, ext: 'md' });
  const shared = await make({ type: 'doc', title: 'общий.md', parent_id: other.id, ext: 'md' });
  const reg = await make({ type: 'resource', title: 'registry', parent_id: dev.id, props: { kind: 'registry', url: 'https://r.lab' } });
  await s.call('POST', '/api/links', { from: dev.id, to: shared.id, kind: 'uses' });
  await s.put(mkDoc.id, '## Marketing\n\nстарый', null);
  await s.call('PATCH', `/api/nodes/${mkDoc.id}/versions/1`, { name: 'v-old' });
  await s.put(mkDoc.id, `## Marketing\n\nсм. [[${infra.id}]]`, 1);
  await s.put(infra.id, `### infra\n\n#### детали\n\n![[${top.id}]]`, null); // цикл обрывается
  await s.put(devDoc.id, `## Dev\n\n![[${infra.id}]]\n![[${reg.id}]]`, null);
  await s.put(shared.id, 'общий текст', null);
  await s.put(top.id, `# Верх\n\n![[${mkDoc.id}]]\n![[${mkDoc.id}@v-old]]\n![[${dev.id}|type=doc]]\n\n\`\`\`\n# не заголовок\n![[${mkDoc.id}]]\n\`\`\``, null);

  const res = await fetch(`${s.base}/api/nodes/${top.id}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/markdown/);
  assert.match(res.headers.get('content-disposition'), /README\.md/);
  const md = await res.text();
  assert.ok(!/!\[\[/.test(md.split('```')[0])); // вне кода вставок не осталось
  assert.match(md, /^# Верх$/m);
  assert.match(md, /^> ## Marketing$/m); // глубина 1
  assert.match(md, /^> см\. \[infra\.md\]\(http:\/\/127\.0\.0\.1:\d+\/\?sel=/m); // упоминание — ссылка на узел
  assert.match(md, /^> старый$/m); // снапшот
  assert.match(md, /снапшот «v-old»/);
  assert.match(md, /^> > ### infra$/m); // dev.md → infra.md, глубина 2
  assert.match(md, /^> > #### детали$/m);
  assert.match(md, /^> > > \*\*\[README\.md\].*ссылается сама на себя/m);
  assert.match(md, /^> > \*\*\[registry\].*registry — https:\/\/r\.lab/m);
  assert.match(md, /^> общий текст$/m); // общий док попал в вид по ссылке uses
  assert.match(md, /```\n# не заголовок\n!\[\[/); // код не трогаем
  assert.match(md, /^> см\..*\n\n> \*\*\[mk\.md\]/m); // соседние вставки не склеиваются в одну цитату

  // Раздел — zip всей области по путям дерева.
  const zip = await fetch(`${s.base}/api/nodes/${p.id}/export`);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const files = unzip(Buffer.from(await zip.arrayBuffer()));
  assert.ok(files['Проект _1/README.md'] && files['Проект _1/dev/registry.md'] && files['чужое/общий.md']);
  assert.match(files['Проект _1/README.md'], /^!\[\[Проект _1\/mk\/mk\.md\]\]$/m);
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
