// CC Hub デスクトップシェル(Electron)
// デーモンを必要に応じて起動し、Web UI を表示する。終了してもデーモンは止めない。
import {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, shell, session, nativeImage,
} from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import WebSocket from 'ws';
import type { NotifyEvent } from '@cc-hub/shared';

const DEFAULT_PORT = 7861;
const dataDir = process.env.CC_HUB_DATA_DIR || path.join(process.env.APPDATA || app.getPath('appData'), 'cc-hub');
const repoRoot = path.resolve(__dirname, '..', '..', '..'); // dist → desktop → packages → repo
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'main.js');
const logPath = path.join(dataDir, 'daemon.log');
const boundsPath = path.join(dataDir, 'desktop-window.json');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let ws: WebSocket | null = null;
let wsTimer: NodeJS.Timeout | null = null;
let port = DEFAULT_PORT;
let token = '';

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return fallback; }
}

function loadConfig(): void {
  const cfg = readJson<{ port?: number }>(path.join(dataDir, 'config.json'), {});
  port = typeof cfg.port === 'number' ? cfg.port : DEFAULT_PORT;
  try { token = fs.readFileSync(path.join(dataDir, 'local-token'), 'utf8').trim(); } catch { token = ''; }
}

/** GET /api/state が 200 なら正常 */
function healthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/state', timeout: 2000, headers: { Authorization: `Bearer ${token}` } },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function spawnDaemon(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const child = spawn('node', [daemonEntry], {
    detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: repoRoot,
  });
  child.on('error', (e) => fs.appendFileSync(logPath, `[desktop] spawn failed: ${e.message}\n`));
  child.unref();
}

async function ensureDaemon(): Promise<boolean> {
  if (await healthy()) return true;
  loadConfig(); // 起動後に token が生成される場合に備えて再読込
  spawnDaemon();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    loadConfig();
    if (await healthy()) return true;
  }
  return false;
}

function errorPage(): string {
  const html = `<meta charset="utf-8"><body style="font-family:sans-serif;background:#1e1e1e;color:#eee;padding:2em">
<h2>デーモンに接続できません</h2><p>ポート ${port} が応答しません。ログを確認してください。</p>
<p><code>${logPath.replace(/\\/g, '/')}</code></p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function saveBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { fs.writeFileSync(boundsPath, JSON.stringify({ ...win.getBounds(), max: win.isMaximized() })); } catch { /* 無視 */ }
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

async function load(): Promise<void> {
  if (!win) return;
  loadConfig();
  if (!(await ensureDaemon())) {
    await win.loadURL(errorPage());
    return;
  }
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${port}`, name: 'hub_local', value: token, path: '/', httpOnly: true,
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  connectWs();
}

function createWindow(): void {
  const b = readJson<{ x?: number; y?: number; width?: number; height?: number; max?: boolean }>(boundsPath, {});
  win = new BrowserWindow({
    width: b.width ?? 1280, height: b.height ?? 800, x: b.x, y: b.y,
    show: false, title: 'CC Hub', backgroundColor: '#1e1e1e', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    saveBounds();
    if (!quitting) { e.preventDefault(); win?.hide(); } // トレイに格納
  });
  // 外部リンクは既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith('data:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  void load();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('CC Hub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '表示', click: showWindow },
    { label: '再読み込み', click: () => { showWindow(); void load(); } },
    { label: 'デーモンのログを開く', click: () => { void shell.openPath(logPath); } },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---- 通知(WS) ----
function connectWs(): void {
  if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* 無視 */ } ws = null; }
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  ws = sock;
  sock.on('open', () => sock.send(JSON.stringify({ t: 'sub', topics: ['state'] })));
  sock.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { t: string; event?: NotifyEvent };
      if (msg.t === 'notify' && msg.event) onNotify(msg.event);
    } catch { /* 不正メッセージは無視 */ }
  });
  const retry = (): void => {
    if (ws !== sock || quitting) return;
    ws = null;
    wsTimer = setTimeout(() => { loadConfig(); connectWs(); }, 3000);
  };
  sock.on('close', retry);
  sock.on('error', () => { /* close で再接続 */ });
}

function onNotify(ev: NotifyEvent): void {
  if (win && win.isVisible() && win.isFocused()) return; // フォーカス中は出さない
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: ev.title, body: ev.body });
  n.on('click', () => {
    showWindow();
    win?.webContents.send('hub:select-session', ev.sessionId);
  });
  n.show();
}

// ---- 起動 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('CC Hub');
  app.whenReady().then(() => {
    createWindow();
    createTray();
    globalShortcut.register('Control+Shift+Space', toggleWindow);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* トレイ常駐 */ });
}
