// Демо-данные. По умолчанию — общий набор «Personal project #1» (server/demo-personal.mjs), тот же, что в прототипе.
// GRAPHSPACE_DEMO=orbit — прежний демо-проект Orbit (на нём держатся e2e-тесты).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, createNode, addVersion, addLink } from './db.mjs';
import { seedPersonal } from './demo-personal.mjs';

const space = (title, parent, label) => createNode({ type: 'space', title, parent_id: parent?.id ?? null, props: { label } });
const res = (title, parent, kind, url, note = '') => createNode({ type: 'resource', title, parent_id: parent.id, props: { kind, url, note } });
function doc(title, parent, text) {
  const n = createNode({ type: 'doc', title, parent_id: parent.id, ext: 'md' });
  addVersion(n.id, Buffer.from(text.trim() + '\n'), { author: 'seed' });
  return n;
}

// Минимальная схема Excalidraw: недостающие поля редактор восстановит при открытии.
function boardJson() {
  const box = (id, x, y, text, color) => [
    { id, type: 'rectangle', x, y, width: 180, height: 70, strokeColor: '#1e1e1e', backgroundColor: color, fillStyle: 'solid', roundness: { type: 3 } },
    { id: id + 't', type: 'text', x: x + 20, y: y + 22, width: 140, height: 25, text, originalText: text, fontSize: 20, fontFamily: 5, textAlign: 'center', strokeColor: '#1e1e1e' },
  ];
  const arrow = (id, x, y, dx, dy) => ({ id, type: 'arrow', x, y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]], strokeColor: '#1e1e1e', endArrowhead: 'arrow' });
  return JSON.stringify({
    type: 'excalidraw', version: 2, source: 'graphspace',
    elements: [
      ...box('app1', 0, 0, 'app1 · витрина', '#a5d8ff'),
      ...box('app2', 0, 140, 'app2 · API', '#b2f2bb'),
      ...box('app3', 0, 280, 'app3 · воркер', '#b2f2bb'),
      ...box('reg', 320, 210, 'registry', '#ffec99'),
      ...box('s3', 320, 0, 'S3 · медиа', '#ffec99'),
      arrow('a1', 180, 35, 140, 0), arrow('a2', 180, 175, 140, 60), arrow('a3', 180, 315, 140, -60), arrow('a4', 90, 70, 0, 70),
    ],
    appState: { viewBackgroundColor: '#ffffff' }, files: {},
  });
}

function docx(markdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphspace-seed-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.md'), markdown);
    execFileSync('wordcraft-cli', ['convert', path.join(dir, 'in.md'), path.join(dir, 'out.docx')], { stdio: 'ignore', timeout: 30000 });
    return fs.readFileSync(path.join(dir, 'out.docx'));
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function seedOrbit() {
  const p = space('Orbit', null, 'проект');
  const mkt = space('marketing', p, 'направление');
  const dev = space('dev', p, 'направление');

  const board = createNode({ type: 'board', title: 'Архитектура', parent_id: p.id, ext: 'excalidraw' });
  addVersion(board.id, Buffer.from(boardJson()), { author: 'seed' });

  // marketing
  doc('План запуска', mkt, `
# План запуска

1. Лендинг с формой раннего доступа.
2. Рассылка по списку ожидания.
3. Публичный запуск app1.

Бюджет и сроки — в брифе рядом.`);
  const brief = docx('# Бриф для подрядчика\n\nЦель: лендинг Orbit с формой раннего доступа.\n\n## Сроки\n\nДве недели от согласования макета.\n\n## Материалы\n\nЛоготип и фото лежат в бакете с ассетами.\n');
  if (brief) {
    const b = createNode({ type: 'office', title: 'Бриф подрядчику', parent_id: mkt.id, ext: 'docx' });
    addVersion(b.id, brief, { author: 'seed', name: 'отправлено подрядчику' });
  }
  res('Ассеты', mkt, 's3', 'https://minio.home.arpa/browser/orbit-assets', 'Логотипы, фото, баннеры');
  const landing = space('Лендинг', mkt, 'аппка');
  doc('ТЗ на лендинг', landing, `
# ТЗ на лендинг

Одна страница: оффер, три преимущества, форма.

Аппка живёт внутри маркетинга, хотя это такой же узел, как app1 в dev.`);
  res('landing', landing, 'git', 'https://git.home.arpa/orbit/landing');

  // dev
  doc('Соглашения разработки', dev, `
# Соглашения разработки

- Одна аппка — один репозиторий.
- Образы собираются в общий registry.
- Инфраструктура описана в Terraform.`);
  const app1 = space('app1', dev, 'аппка');
  const app2 = space('app2', dev, 'аппка');
  const app3 = space('app3', dev, 'аппка');
  const infra = space('infra', dev, 'инфра');

  doc('app1: витрина', app1, '# app1: витрина\n\nФронт магазина. Медиа берёт из S3, данные — из API app2.');
  res('app1', app1, 'git', 'https://git.home.arpa/orbit/app1');
  res('Медиа', app1, 's3', 'https://minio.home.arpa/browser/orbit-media', 'Картинки товаров');

  doc('app2: API', app2, '# app2: API\n\nREST для витрины и воркера. Образ публикуется в registry, которым пользуется и app3.');
  const repo2 = res('app2', app2, 'git', 'https://git.home.arpa/orbit/app2');
  // Дети есть не только у разделов: док прицеплен прямо к репозиторию.
  doc('Как выкатывать', repo2, '# Как выкатывать\n\n1. Собрать образ и отправить в registry.\n2. Обновить тег в iac.\n3. Применить Terraform.');
  const registry = res('registry', app2, 'registry', 'https://registry.home.arpa/v2/orbit/', 'Общий: дом в app2, им же пользуется app3');

  doc('app3: воркер', app3, `# app3: воркер\n\nФоновые задачи. Свой registry не заводит, пользуется общим: [[${registry.id}]].`);
  res('app3', app3, 'git', 'https://git.home.arpa/orbit/app3');
  addLink(app3.id, registry.id, 'uses');

  // Общий раздел: ui-kit живёт в dev, а лендинг из маркетинга пользуется им по ссылке.
  const kit = space('ui-kit', dev, 'аппка');
  doc('ui-kit: компоненты', kit, '# ui-kit: компоненты\n\nКнопки, формы и сетка. Используется витриной и лендингом.');
  res('ui-kit', kit, 'git', 'https://git.home.arpa/orbit/ui-kit');
  addLink(landing.id, kit.id, 'uses');

  res('iac', infra, 'git', 'https://git.home.arpa/orbit/iac', 'Terraform для Proxmox');
  res('Proxmox', infra, 'url', 'https://pve.home.arpa:8006');

  // Родительский док: общий текст сверху, ниже — виды на дочерние части. Ничего не скопировано.
  const overview = doc('Обзор проекта', p, `
# Orbit

Магазин из трёх аппок и лендинга. Этот док пишет только общее, остальное подтягивается из дочерних частей.

## Схема

![[${board.id}]]

## Разработка

Все доки направления dev, от любого уровня вложенности:

![[${dev.id}|type=doc]]

## Маркетинг

![[${mkt.id}|type=doc]]

## Инфраструктура

Все внешние ресурсы проекта одним списком:

![[${p.id}|type=resource]]`);
  db.prepare('UPDATE nodes SET position = 0 WHERE id = ?').run(overview.id);
}

export const DEMOS = { personal: seedPersonal, orbit: seedOrbit };
export function seed(name = process.env.GRAPHSPACE_DEMO || 'personal') {
  const fn = DEMOS[name];
  if (!fn) throw new Error(`нет демо-набора «${name}», есть: ${Object.keys(DEMOS).join(', ')}`);
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c === 0) seed();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--reset')) db.exec('DELETE FROM links; DELETE FROM versions; DELETE FROM nodes;');
  seedIfEmpty();
  console.log(`узлов: ${db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c}`);
}
