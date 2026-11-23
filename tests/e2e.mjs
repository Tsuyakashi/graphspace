// Сквозной тест в браузере: node tests/e2e.mjs [каталог для скриншотов]
// Нужен Chrome (CHROME=/путь, по умолчанию /usr/bin/google-chrome) и собранный интерфейс (npm run build).
// Шаг с WordCraft пропускается, если веб-сборки Craft на сервере нет.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const s = await startServer({ seed: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results = [];
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
  const step = async (name, fn) => { await fn(); results.push(name); console.log('✔', name); };
  const state = async () => (await fetch(`${s.base}/api/state`)).json();
  const versions = async (id) => (await (await fetch(`${s.base}/api/nodes/${id}/versions`)).json()).length;
  const st = await state();
  const id = (title, type) => st.nodes.find((n) => n.title === title && (!type || n.type === type)).id;
  const config = await (await fetch(`${s.base}/api/config`)).json();

  await step('дерево проекта', async () => {
    await page.goto(s.base);
    await page.waitForSelector('.tree .row');
    assert.ok(await page.locator('.tree .row').count() > 20);
    await shot('1-tree');
  });

  await step('смена корня и вид «все git отсюда»', async () => {
    await page.goto(`${s.base}/?root=${id('dev')}&type=kind:git`);
    await page.waitForSelector('.tree .row');
    assert.equal(await page.locator('.crumbs button.here').textContent(), 'dev');
    // Дерево с фильтром: подходящие узлы и путь к ним.
    assert.equal(await page.locator('.tree .row:not(.root-row):has(.icon.t-resource)').count(), 5); // app1, app2, app3, ui-kit, iac
    assert.equal(await page.locator('.chips button.on i').textContent(), '5');
    await shot('2-view-git');
  });

  await step('общий узел виден ссылкой и в области считается один раз', async () => {
    await page.goto(`${s.base}/?root=${id('app3', 'space')}`);
    await page.waitForSelector('.tree .row.shared');
    assert.equal(await page.locator('.tree .row.shared .title').textContent(), 'registry');
    await page.goto(`${s.base}/?root=${id('dev')}&type=kind:registry`);
    await page.waitForSelector('.tree .row.shared');
    assert.equal(await page.locator('.tree .row:not(.shared):has(.icon.t-resource)').count(), 1); // дом — app2
    assert.equal(await page.locator('.chips button.on i').textContent(), '1');
  });

  await step('слева только дерево, справа переключатель «Explorer | Graph»', async () => {
    await page.goto(`${s.base}/?root=${id('Orbit')}`);
    await page.waitForSelector('.view-switch');
    assert.equal(await page.locator('.side-tools button', { hasText: 'Список' }).count(), 0);
    assert.equal(await page.locator('.view-switch button.on').textContent(), 'Explorer');
    await page.locator('.view-switch button', { hasText: 'Graph' }).click();
    await page.waitForSelector('.graph .gn');
    assert.equal(await page.locator('.view-switch button.on').textContent(), 'Graph');
    assert.ok(await page.locator('.tree .row').count() > 5); // дерево слева осталось
    await shot('2b-switch-graph');
    await page.locator('.view-switch button', { hasText: 'Explorer' }).click();
    await page.waitForFunction(() => document.querySelector('.node-title h1')?.textContent === 'Orbit');
    assert.equal(await page.locator('.graph').count(), 0);
  });

  await step('граф: вложенность, ссылки пунктиром, фильтр приглушает', async () => {
    await page.goto(`${s.base}/?root=${id('Orbit')}&view=graph`);
    await page.waitForSelector('.graph .gn');
    assert.equal(await page.locator('.graph .gn').count(), st.nodes.length); // все узлы проекта, каждый один раз
    assert.equal(await page.locator('.graph .ge.uses').count(), 2);
    await shot('3-graph');
    await page.locator('.chips button', { hasText: 'registry' }).click();
    await page.waitForSelector('.graph .gn.dim');
    const lit = await page.locator('.graph .gn:not(.dim)').count();
    assert.equal(lit, 5); // Orbit, dev, app2, registry и app3, который им пользуется
    await shot('4-graph-filter');
  });

  await step('граф отсюда и переход к узлу', async () => {
    await page.goto(`${s.base}/?root=${id('Orbit')}&view=graph`);
    await page.locator(`.graph .gn[data-id="${id('marketing')}"]`).click();
    await page.locator('.graph-card button', { hasText: 'Граф отсюда' }).click();
    await page.waitForFunction(() => document.querySelector('.crumbs button.here')?.textContent === 'marketing');
    assert.ok(await page.locator(`.graph .gn.shared[data-id="${id('ui-kit', 'space')}"]`).count() === 1); // общий раздел подтянулся по ссылке
    await page.locator(`.graph .gn[data-id="${id('План запуска')}"]`).dblclick();
    await page.waitForSelector('.doc .md h1');
    assert.equal(await page.locator('.node-title h1').textContent(), 'План запуска');
  });

  await step('родительский док: вставки-виды и схема картинкой', async () => {
    await page.goto(`${s.base}/?sel=${id('Обзор проекта')}`);
    await page.waitForSelector('.embed-board svg', { timeout: 30000 });
    assert.ok(await page.locator('.doc-read > .md > .embed-view > .embed').count() >= 15);
    assert.ok(await page.locator('.embed .md h1', { hasText: 'app2: API' }).count() === 1);
    const href = await page.locator('.node-title a.btn', { hasText: 'Экспорт' }).getAttribute('href');
    const res = await fetch(s.base + href);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    const md = await res.text();
    assert.ok(md.includes('> # app2: API') || md.includes('> ## app2: API'), 'вставки раскрыты текстом');
    await shot('5-doc-embeds');
  });

  await step('правка дока создаёт версию, вставка обновляется вживую', async () => {
    const doc = id('app2: API');
    await page.goto(`${s.base}/?sel=${doc}`);
    await page.locator('.slot button', { hasText: 'Править' }).click();
    await page.locator('.doc-edit textarea').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nправка из теста');
    // Русская раскладка: key — «ы», code — KeyS. Браузерное «Сохранить страницу» не должно открыться.
    const prevented = await page.locator('.doc-edit textarea').evaluate((t) =>
      !t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ы', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })));
    assert.ok(prevented, 'Ctrl+S в ru-раскладке перехвачен');
    await page.waitForFunction(() => [...document.querySelectorAll('.slot button')].some((b) => b.textContent === 'Сохранено'));
    assert.equal(await versions(doc), 2);
    await page.goto(`${s.base}/?sel=${id('Обзор проекта')}`);
    await page.waitForSelector('.embed .md p:has-text("правка из теста")');
  });

  await step('уход с дока без Ctrl+S сохраняет правку', async () => {
    const doc = id('План запуска');
    await page.goto(`${s.base}/?sel=${doc}`);
    await page.locator('.slot button', { hasText: 'Править' }).click();
    await page.locator('.doc-edit textarea').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nне сохранял руками');
    await page.locator('.tree .row .title', { hasText: /^dev$/ }).click();
    await page.waitForFunction(() => document.querySelector('.node-title h1')?.textContent === 'dev');
    assert.equal(await versions(doc), 2);
    assert.match(await (await fetch(`${s.base}/api/nodes/${doc}/content`)).text(), /не сохранял руками/);
  });

  await step('дети у не-раздела: док под репозиторием', async () => {
    await page.goto(`${s.base}/?sel=${id('app2', 'resource')}`);
    await page.waitForSelector('.node-kids .pill');
    assert.equal((await page.locator('.node-kids .pill').textContent()).trim(), 'Как выкатывать');
  });

  await step('схема: правка в Excalidraw создаёт версию', async () => {
    const board = id('Архитектура');
    await page.goto(`${s.base}/?sel=${board}`);
    await page.waitForSelector('.excalidraw canvas.interactive', { timeout: 60000 });
    await page.waitForTimeout(800);
    const box = await page.locator('.excalidraw canvas.interactive').boundingBox();
    await page.mouse.click(box.x + box.width - 260, box.y + box.height - 220); // фокус на холст, иначе клавиша инструмента не дойдёт
    await page.keyboard.press('r'); // инструмент «прямоугольник»
    await page.mouse.move(box.x + box.width - 260, box.y + box.height - 220);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 120, box.y + box.height - 140, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.slot button')?.textContent === 'Сохранить');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('.slot button')?.textContent === 'Сохранено');
    assert.equal(await versions(board), 2);
    await shot('6-board');
    // Стереть фигуру и сохранить кнопкой: удалённые элементы не должны оставлять схему «несохранённой».
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelector('.slot button')?.textContent === 'Сохранить');
    await page.locator('.slot button', { hasText: 'Сохранить' }).click();
    await page.waitForFunction(() => document.querySelector('.slot button')?.textContent === 'Сохранено');
    assert.equal(await versions(board), 3);
    // Ещё прямоугольник и сразу на граф, без Ctrl+S: схема сохраняется сама.
    await page.mouse.click(box.x + box.width - 400, box.y + box.height - 220);
    await page.keyboard.press('r');
    await page.mouse.move(box.x + box.width - 400, box.y + box.height - 220);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 300, box.y + box.height - 140, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.slot button')?.textContent === 'Сохранить');
    await page.locator('.view-switch button', { hasText: 'Graph' }).click();
    await page.waitForSelector('.graph .gn');
    assert.equal(await versions(board), 4);
  });

  if (config.web.wordcraft) {
    await step('docx в WordCraft: правка и сохранение создают версию', async () => {
      const brief = id('Бриф подрядчику');
      await page.goto(`${s.base}/?sel=${brief}`);
      await page.waitForFunction(() => /wordcraft \d/.test(document.querySelector('.slot .state')?.textContent ?? ''), null, { timeout: 90000 });
      const frame = page.frames().find((f) => f.url().includes('/craft/wordcraft/'));
      await page.waitForTimeout(2500);
      await frame.evaluate(() => window.wordcraft.execute('text.insert', { text: 'graphspace: ' }));
      await frame.evaluate(() => window.wordcraft.execute('file.save', {}));
      await page.waitForFunction(() => /v2/.test(document.querySelector('.node-title')?.textContent ?? ''), null, { timeout: 15000 });
      assert.equal(await versions(brief), 2);
      await shot('7-wordcraft');
      // Правка без сохранения и уход на другой узел: хост сам сохраняет через file.save.
      await page.waitForFunction(() => !/несохран/.test(document.querySelector('.slot .state')?.textContent ?? ''));
      await frame.evaluate(() => window.wordcraft.execute('text.insert', { text: 'ещё: ' }));
      await page.waitForFunction(() => /несохран/.test(document.querySelector('.slot .state')?.textContent ?? ''), null, { timeout: 15000 });
      await page.locator('.tree .row .title', { hasText: /^dev$/ }).click();
      await page.waitForFunction(() => document.querySelector('.node-title h1')?.textContent === 'dev', null, { timeout: 30000 });
      assert.equal(await versions(brief), 3);
    });
  } else {
    console.log('– WordCraft пропущен: веб-сборки нет (./setup-craft.sh wordcraft)');
  }

  await step('перенос: проект в проект и обратно наверх', async () => {
    const mk = async (body) => (await fetch(`${s.base}/api/nodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const p1 = await mk({ type: 'space', title: 'Проект 1', props: { label: 'проект' } });
    const p2 = await mk({ type: 'space', title: 'Проект 2', props: { label: 'проект' } });
    const note = await mk({ type: 'doc', title: 'Заметка сверху', ext: 'md' });
    const parent = async (n) => (await state()).nodes.find((x) => x.id === n.id).parent_id;
    const row = (n) => page.locator('.tree .row', { has: page.locator('.title', { hasText: new RegExp(`^${n.title}$`) }) });
    await page.goto(s.base);
    await row(p1).waitFor();
    await row(p1).dragTo(row(p2)); // в раздел — внутрь
    await page.waitForFunction(async (pid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === pid).parent_id !== null, p1.id);
    assert.equal(await parent(p1), p2.id);
    await row(p1).dragTo(page.locator('.crumbs button', { hasText: 'Все проекты' })); // на крошку — туда
    await page.waitForFunction(async (pid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === pid).parent_id === null, p1.id);
    await row(p1).dragTo(row(p2));
    await page.waitForFunction(async (pid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === pid).parent_id !== null, p1.id);
    await row(p1).dragTo(row(note)); // на не-раздел — рядом с ним, то есть наверх
    await page.waitForFunction(async (pid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === pid).parent_id === null, p1.id);
    // Внутри корня: из подраздела на уровень корня — бросок на строку корня.
    await row(p1).dragTo(row(p2));
    await page.waitForFunction(async (pid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === pid).parent_id !== null, p1.id);
    const inner = await mk({ type: 'doc', title: 'Глубже', parent_id: p1.id, ext: 'md' });
    await page.goto(`${s.base}/?root=${p2.id}`);
    await row(inner).dragTo(page.locator('.tree .root-row'));
    await page.waitForFunction(async (iid) => (await (await fetch('/api/state')).json()).nodes.find((x) => x.id === iid).parent_id !== null, inner.id);
    assert.equal(await parent(inner), p2.id);
    for (const n of [p1, p2, note]) await fetch(`${s.base}/api/nodes/${n.id}`, { method: 'DELETE' });
  });

  await step('свернуть всё и кто вошёл', async () => {
    await page.goto(s.base);
    await page.waitForSelector('.tree .row');
    const before = await page.locator('.tree .row').count();
    await page.locator('.collapse-all').click();
    const after = await page.locator('.tree .row').count();
    assert.ok(after < before, `строк: ${before} → ${after}`);
    assert.equal(await page.locator('.tree .row .twisty.open').count(), 0);
    const me = (await state()).me;
    assert.equal(await page.locator('.side-user .who b').textContent(), me);
    assert.match(await page.locator('.side-user .who small').textContent(), /dev-режим/);
    await page.evaluate(() => localStorage.removeItem('gs.collapsed'));
  });

  await step('правый клик по пустому месту справа: проекты, раздел, граф', async () => {
    await page.goto(s.base);
    await page.waitForSelector('.page h1');
    await page.mouse.click(1300, 820, { button: 'right' });
    await page.locator('.menu button', { hasText: 'Новый проект' }).waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${s.base}/?sel=${id('dev')}`);
    await page.waitForSelector('.space-bar');
    await page.mouse.click(1300, 820, { button: 'right' });
    await page.locator('.menu button', { hasText: 'PowerPoint' }).waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${s.base}/?root=${id('dev')}&view=graph`);
    await page.waitForSelector('.graph .gn');
    await page.mouse.click(560, 860, { button: "right" }); // справа внизу — карточка узла
    await page.locator('.menu button', { hasText: 'PowerPoint' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('правый клик по пустому месту дерева — меню создания', async () => {
    await page.goto(s.base);
    await page.waitForSelector('.tree .row');
    await page.locator('.tree').evaluate((t) => { t.scrollTop = t.scrollHeight; });
    const box = await page.locator('.tree').boundingBox();
    await page.mouse.click(box.x + 40, box.y + box.height - 8, { button: 'right' });
    await page.locator('.menu button', { hasText: 'Новый проект' }).waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${s.base}/?root=${id('dev')}`);
    await page.waitForSelector('.tree .row');
    const b2 = await page.locator('.tree').boundingBox();
    await page.mouse.click(b2.x + 40, b2.y + b2.height - 8, { button: 'right' });
    await page.locator('.menu button', { hasText: 'PowerPoint' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('создание проекта с меткой и корзина', async () => {
    await page.goto(s.base);
    await page.locator('.side-tools button', { hasText: 'Проект' }).click();
    await page.locator('.dialog input').first().fill('Новый проект');
    await page.locator('.dialog input').nth(1).fill('pet');
    await page.locator('.dialog button.primary').click();
    await page.waitForFunction(() => document.querySelector('.node-title h1')?.textContent === 'Новый проект');
    const made = (await state()).nodes.find((n) => n.title === 'Новый проект');
    assert.equal(made.props.label, 'pet');
    assert.equal(made.parent_id, null);
    await page.locator('.node-title button[title="Действия"]').click();
    await page.locator('.menu button', { hasText: 'В корзину' }).click();
    await page.locator('.toast button', { hasText: 'Вернуть' }).waitFor();
    assert.ok(!(await state()).nodes.some((n) => n.id === made.id));
    await page.locator('.toast button', { hasText: 'Вернуть' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tree .row .title')].some((e) => e.textContent === 'Новый проект'));
  });

  await step('чужой раздел, которым поделились: секция «Доступно мне» и владелец', async () => {
    const other = { 'content-type': 'application/json', 'x-graphspace-dev-user': 'alice@example.com' };
    const p = await (await fetch(`${s.base}/api/nodes`, { method: 'POST', headers: other, body: JSON.stringify({ type: 'space', title: 'Проект Алисы', props: { label: 'проект' } }) })).json();
    await fetch(`${s.base}/api/nodes`, { method: 'POST', headers: other, body: JSON.stringify({ type: 'doc', title: 'Её заметки', parent_id: p.id, ext: 'md' }) });
    await page.goto(s.base);
    await page.waitForSelector('.tree .row');
    assert.equal(await page.locator('.tree .row .title', { hasText: 'Проект Алисы' }).count(), 0); // пока не поделились — не видно
    await fetch(`${s.base}/api/nodes/${p.id}/shares`, { method: 'POST', headers: other, body: JSON.stringify({ email: 'test' }) });
    await page.locator('.tree-sep', { hasText: 'Доступно мне' }).waitFor();
    await page.locator('.tree .row .title', { hasText: 'Проект Алисы' }).waitFor();
    assert.equal(await page.locator('.tree .row .label.where', { hasText: 'alice@example.com' }).count(), 1);
    await page.locator('.tree .row', { hasText: 'Проект Алисы' }).click({ button: 'right' });
    assert.equal(await page.locator('.menu button', { hasText: 'В корзину' }).count(), 0); // корень общего удаляет только владелец
    await page.keyboard.press('Escape');
    await shot('9-shared');
    // Граф без корня: два виртуальных корня, свои проекты и доступные.
    await page.goto(`${s.base}/?view=graph`);
    await page.locator('.graph .gn.vroot', { hasText: 'Мои проекты' }).waitFor();
    await page.locator('.graph .gn.vroot', { hasText: 'Доступно мне' }).waitFor();
    assert.equal(await page.locator('.graph .gn > text', { hasText: 'Проект Алисы' }).count(), 1); // подпись узла, не путь в title
    await shot('10-graph-shared');
  });

  // Хост Craft на заглушке (tests/craft-mock): тот же протокол, что у веб-сборок, без самих сборок.
  const m = await startServer({ env: { GRAPHSPACE_CRAFT_DIR: new URL('./craft-mock', import.meta.url).pathname } });
  try {
    const mk = async (b) => (await fetch(`${m.base}/api/nodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
    const vers = async (nid) => (await (await fetch(`${m.base}/api/nodes/${nid}/versions`)).json()).length;
    const P = await mk({ type: 'space', title: 'P' });
    const X = await mk({ type: 'office', title: 'Таблица', parent_id: P.id, ext: 'xlsx' });
    const S = await mk({ type: 'office', title: 'Слайды', parent_id: P.id, ext: 'pptx' });
    await mk({ type: 'doc', title: 'Док', parent_id: P.id, ext: 'md' });
    const p2 = await browser.newPage();
    await p2.route('**/api/events', (r) => r.abort()); // без событий: состояние у клиента устаревает
    const go = async (title, app) => {
      await p2.locator('.tree .row .title', { hasText: new RegExp(`^${title}$`) }).click();
      await p2.waitForFunction((t) => document.querySelector('.node-title h1')?.textContent === t, title);
      if (!app) return null;
      await p2.waitForFunction((a) => new RegExp(a + ' mock').test(document.querySelector('.slot .state')?.textContent ?? ''), app);
      await p2.waitForTimeout(300);
      return p2.frames().find((f) => f.url().includes(`/craft/${app}/`));
    };
    await p2.goto(`${m.base}/?root=${P.id}`);

    await step('Craft: новый файл, правка, уход и возврат — правка на месте', async () => {
      let f = await go('Таблица', 'gridcraft');
      await f.locator('#t').fill('hello');
      await p2.waitForFunction(() => /несохран/.test(document.querySelector('.slot .state')?.textContent ?? ''));
      await go('Док');
      assert.equal(await vers(X.id), 1);
      f = await go('Таблица', 'gridcraft');
      await p2.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#t')?.value === 'hello', null, { timeout: 5000 });
    });

    await step('без событий сервера «Версии · vN» обновляется сразу после своего сохранения', async () => {
      await go('Док');
      await p2.locator('.slot button', { hasText: /^(Править|Готово)$/ }).waitFor();
      if (await p2.locator('.slot button', { hasText: 'Править' }).count()) await p2.locator('.slot button', { hasText: 'Править' }).click(); // пустой док открыт сразу на правку
      await p2.locator('.doc-edit textarea').fill('# Док\n\nтекст');
      await p2.locator('.slot button', { hasText: 'Сохранить' }).click();
      await p2.waitForFunction(() => [...document.querySelectorAll('.node-head button')].some((b) => /Версии · v\d/.test(b.textContent ?? '')), null, { timeout: 5000 });
    });

    await step('Craft: новый pptx открывается шаблоном, Ctrl+S пишет в этот узел, а не .deckcraft рядом', async () => {
      const count = async () => (await (await fetch(`${m.base}/api/state`)).json()).nodes.length;
      const before = await count();
      const f = await go('Слайды', 'deckcraft');
      assert.match(await f.locator('#log').textContent(), /opened Слайды\.pptx/);
      await f.locator('#t').fill('slide');
      await f.locator('#t').press('Control+s');
      await p2.waitForFunction(async (nid) => (await (await fetch(`/api/nodes/${nid}/versions`)).json()).length === 1, S.id);
      assert.equal(await count(), before);
    });

    await step('Craft: .deckcraft рядом открывается в DeckCraft', async () => {
      const junk = await mk({ type: 'file', title: 'Presentation1.deckcraft', parent_id: P.id, ext: 'deckcraft' });
      await fetch(`${m.base}/api/nodes/${junk.id}/content`, { method: 'PUT', headers: { 'x-base-version': '' }, body: 'MOCK:старое' });
      await p2.reload();
      await go('Presentation1.deckcraft', 'deckcraft');
      await p2.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#t')?.value === 'старое', null, { timeout: 5000 });
    });
    await p2.close();
  } finally { await m.stop(); }

  const real = errors.filter((e) => !/subsetting/.test(e));
  assert.deepEqual(real, [], 'ошибки на странице');
  console.log(`\nшагов пройдено: ${results.length}, ошибок на странице: 0`);
} catch (e) {
  failed = true;
  console.error('\n✖', e.message);
} finally {
  await browser.close();
  await s.stop();
}
process.exit(failed ? 1 : 0);
