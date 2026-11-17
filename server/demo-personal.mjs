// Общий демо-набор «Personal project #1» — тот же, что в прототипе graphspace-concept (seed.mjs),
// чтобы сравнивать механику двух приложений на одинаковых данных.
// Разница только там, где различаются модели: у общего registry один дом (app2), а app3 пользуется им по ссылке uses.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createNode, addVersion, addLink } from './db.mjs';

let OWNER;

const SEED = path.join(ROOT, 'seed');
const file = (name) => (fs.existsSync(path.join(SEED, name)) ? fs.readFileSync(path.join(SEED, name)) : null);
const text = (s) => Buffer.from(s.trim() + '\n');

// Сцена Excalidraw — байт в байт та же, что в прототипе.
function scene(boxes, arrows) {
  let seed = 1;
  const base = (o) => ({ angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: seed++,
    version: 1, versionNonce: seed * 7, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false, ...o });
  const els = [];
  for (const b of boxes) {
    els.push(base({ id: b.id, type: 'rectangle', x: b.x, y: b.y, width: 160, height: 60, backgroundColor: b.bg || '#a5d8ff',
      boundElements: [{ type: 'text', id: b.id + '-t' }] }));
    els.push(base({ id: b.id + '-t', type: 'text', x: b.x + 10, y: b.y + 18, width: 140, height: 25, text: b.label, originalText: b.label,
      fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: b.id, lineHeight: 1.25, autoResize: true, roundness: null }));
  }
  for (const [from, to] of arrows) {
    const a = boxes.find((b) => b.id === from), z = boxes.find((b) => b.id === to);
    const x1 = a.x + 160, y1 = a.y + 30, x2 = z.x, y2 = z.y + 30;
    els.push(base({ id: `${from}-${to}`, type: 'arrow', x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      points: [[0, 0], [x2 - x1, y2 - y1]], startArrowhead: null, endArrowhead: 'arrow', roundness: { type: 2 },
      startBinding: { elementId: from, focus: 0, gap: 4 }, endBinding: { elementId: to, focus: 0, gap: 4 } }));
  }
  return Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, source: 'graphspace', elements: els,
    appState: { viewBackgroundColor: '#ffffff' }, files: {} }));
}

const space = async (title, parent, label) => await createNode(OWNER, { type: 'space', title, parent_id: parent?.id ?? null, props: { label } });
const res = async (title, parent, kind, url, note = '') => await createNode(OWNER, { type: 'resource', title, parent_id: parent.id, props: { kind, url, note } });
const put = async (node, bytes) => { if (bytes) await addVersion(OWNER, node.id, bytes, { author: 'seed' }); return node; };
const doc = async (title, parent, body) => put(await createNode(OWNER, { type: 'doc', title, parent_id: parent.id, ext: 'md' }), body == null ? null : text(body));
const office = async (title, parent, ext) => put(await createNode(OWNER, { type: 'office', title, parent_id: parent.id, ext }), file(title));

export async function seedPersonal(owner) {
  OWNER = owner;
  const p1 = await space('Personal project #1', null, 'проект');

  // marketing
  const mk = await space('marketing', p1, 'направление');
  const landing = await space('landing', mk, 'аппка');
  const marketingMd = await doc('marketing.md', mk, `
## Marketing

Запуск лендинга, каналы и бюджет. План — в **marketing-plan.docx**, цифры — в **budget.xlsx**.`);
  await office('marketing-plan.docx', mk, 'docx');
  await office('budget.xlsx', mk, 'xlsx');
  await office('pitch.pptx', mk, 'pptx');
  await doc('landing.md', landing, '### landing\n\nАппка внутри маркетинга: узлы универсальны, вложенность любая.');
  await res('lombel-landing', landing, 'git', 'https://github.com/Tsuyakashi/lombel-landing');

  // dev
  const dev = await space('dev', p1, 'направление');
  const infra = await space('infra', dev, 'инфра');
  const app1 = await space('app1', dev, 'аппка');
  const app2 = await space('app2', dev, 'аппка');
  const app3 = await space('app3', dev, 'аппка');
  const devMd = await doc('dev.md', dev); // текст ниже, когда известны id встраиваемых доков
  await put(await createNode(OWNER, { type: 'board', title: 'architecture.excalidraw', parent_id: dev.id, ext: 'excalidraw' }), scene(
    [{ id: 'infra', label: 'infra', x: 0, y: 120, bg: '#b2f2bb' }, { id: 'app1', label: 'app1', x: 260, y: 0 },
     { id: 'app2', label: 'app2', x: 260, y: 120 }, { id: 'app3', label: 'app3', x: 260, y: 240 },
     { id: 'reg', label: 'shared registry', x: 520, y: 180, bg: '#ffd8a8' }],
    [['infra', 'app1'], ['infra', 'app2'], ['infra', 'app3'], ['app2', 'reg'], ['app3', 'reg']]));

  const infraMd = await doc('infra.md', infra, '### infra\n\nProxmox + Terraform. Артефакты в S3, образы в registry.');
  await res('dev-assets', infra, 's3', 'http://minio.lab:9000/dev-assets', 'endpoint http://minio.lab:9000, bucket dev-assets');
  await res('iac-proxmox-lab', infra, 'git', 'https://github.com/Tsuyakashi/iac-proxmox-lab');

  const app1Md = await doc('app1.md', app1, '### app1\n\nСвой registry, своя дока.');
  await res('app1-registry', app1, 'registry', 'ghcr.io/tsuyakashi/app1');

  await doc('app2.md', app2, '### app2\n\nДелит registry с app3.');
  const shared = await res('shared registry', app2, 'registry', 'ghcr.io/tsuyakashi/shared', 'Общий: дом в app2, им же пользуется app3');
  await doc('app3.md', app3, '### app3\n\nДелит registry с app2.');
  await addLink(OWNER, app3.id, shared.id, 'uses'); // в прототипе — второй родитель, здесь — ссылка

  await put(devMd, text(`
## Dev

Общий текст по разработке. Подчасти:

![[${infraMd.id}]]

![[${app1Md.id}]]`));

  await doc('README.md', p1, `
# Personal project #1

Обобщённое описание проекта. Ниже — доки направлений, встроенные по ссылке (не копии):

![[${marketingMd.id}]]

![[${devMd.id}]]`);

  const p2 = await space('Personal project #2', null, 'проект');
  await doc('notes.md', p2, '# Personal project #2\n\nПусто — место для нового.');
  await space('co-op project #1', null, 'проект');
}
