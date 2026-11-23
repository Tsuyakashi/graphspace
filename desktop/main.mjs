// Десктоп-оболочка Graphspace: окно с самим Graphspace и webview на внешний ресурс справа.
// Webview — не iframe: запреты на встраивание (X-Frame-Options, frame-ancestors) его не касаются,
// сессия своя, общая для всех ресурсов и постоянная — вход в GitHub один раз.
import { app, BrowserWindow, WebContentsView, ipcMain, shell, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Адрес Graphspace: аргумент, GRAPHSPACE_URL или локальный сервер.
const START = new URL(process.argv.find((a) => /^https?:\/\//.test(a)) || process.env.GRAPHSPACE_URL || 'http://127.0.0.1:4680');
const ORIGIN = START.origin;
const WEB_PARTITION = 'persist:web';
const isHttp = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

let win, view, shown = false;

function sendState() {
  if (!win || !view) return;
  const wc = view.webContents;
  win.webContents.send('web:state', {
    url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(),
  });
}

function ensureView() {
  if (view) return view;
  view = new WebContentsView({ webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true } });
  const wc = view.webContents;
  // Новые окна сайта — в том же webview, не-http — в системе.
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) wc.loadURL(url); else shell.openExternal(url);
    return { action: 'deny' };
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, sendState);
  return view;
}

// Только страница Graphspace в главном фрейме может управлять webview.
const trusted = (e) => e.senderFrame && e.senderFrame === win?.webContents.mainFrame && e.senderFrame.origin === ORIGIN;

ipcMain.on('web:show', (e, { url, rect } = {}) => {
  if (!trusted(e) || !isHttp(url) || !rect) return;
  const v = ensureView();
  const z = win.webContents.getZoomFactor();
  v.setBounds({ x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.max(0, Math.round(rect.width * z)), height: Math.max(0, Math.round(rect.height * z)) });
  if (!shown) { win.contentView.addChildView(v); shown = true; }
  // Новый адрес ресурса — грузим; тот же — оставляем, где пользователь уже ходит внутри сайта.
  if (v.home !== url) { v.home = url; v.webContents.loadURL(url); }
  sendState();
});

function hide() {
  if (!view || !shown) return;
  win.contentView.removeChildView(view);
  shown = false;
}
ipcMain.on('web:hide', (e) => { if (trusted(e)) hide(); });

ipcMain.on('web:nav', (e, action) => {
  if (!trusted(e) || !view) return;
  const wc = view.webContents;
  if (action === 'back') wc.navigationHistory.goBack();
  else if (action === 'forward') wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'home' && view.home) wc.loadURL(view.home);
  else if (action === 'external' && isHttp(wc.getURL())) shell.openExternal(wc.getURL());
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, title: 'Graphspace', autoHideMenuBar: true,
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Ссылки «в новой вкладке» из Graphspace — в системный браузер.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isHttp(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Ушли со страницы Graphspace (вход Cloudflare Access, перезагрузка) — webview убираем.
  win.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) hide(); });
  win.on('closed', () => { win = null; view = null; shown = false; });
  win.loadURL(START.href);
}

app.whenReady().then(() => {
  // Камера, микрофон и прочее сайтам в webview не нужны.
  session.fromPartition(WEB_PARTITION).setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
