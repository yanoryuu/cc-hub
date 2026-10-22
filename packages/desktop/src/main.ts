// CC Hub デスクトップシェル(Electron)
// デーモンを必要に応じて起動し、Web UI を表示する。終了してもデーモンは止めない。
// インストール版(app.isPackaged): デーモン一式は resources/hub(同梱の cc-hub-node.exe で動かす)。
//   ログイン時にトレイで起動し、デーモンが落ちていれば起こし直す(開発版の watchdog / スタートアップ登録の代わり)。
//   初回(とバージョンが変わったとき)は Claude Code に hooks・MCP・スキルを登録する(setup.ts)
import {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, shell, session, nativeImage, ipcMain, dialog,
} from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import WebSocket from 'ws';
import type { NotifyEvent } from '@cc-hub/shared';
import { runSetup, setupDone, type SetupPaths, type SetupResult } from './setup';

const DEFAULT_PORT = 7861;
const dataDir = process.env.CC_HUB_DATA_DIR || path.join(process.env.APPDATA || app.getPath('appData'), 'cc-hub');
const repoRoot = path.resolve(__dirname, '..', '..', '..'); // dist → desktop → packages → repo
/** デーモン一式のルート(インストール版は resources/hub、開発版はリポジトリ) */
const hubRoot = app.isPackaged ? path.join(process.resourcesPath, 'hub') : repoRoot;
const daemonEntry = path.join(hubRoot, 'packages', 'daemon', 'dist', 'main.js');
/** デーモンを動かす node(インストール版は同梱、開発版は PATH の node) */
const nodeExe = app.isPackaged ? path.join(hubRoot, 'cc-hub-node.exe') : 'node';
/** 検証用(CC_HUB_DATA_DIR を指定)の起動では、ログイン時の起動を登録しない */
const isolated = !!process.env.CC_HUB_DATA_DIR;
/** ログイン時の起動(--hidden)ではウィンドウを出さずにトレイに置く */
const startHidden = process.argv.includes('--hidden');
const WATCH_MS = 30_000;
/** package.json の build.appId と同じ */
const APP_ID = 'com.yanoryuu.cchub';
// 開発版は前からの userData(%APPDATA%\@cc-hub\desktop)を使う。package.json の productName(CC Hub)に任せると、
// 画面の保存内容(localStorage など)が新しいフォルダに移って消えたように見え、インストール版と二重起動の判定もぶつかる
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), '@cc-hub', 'desktop'));
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
  const child = spawn(nodeExe, [daemonEntry], {
    detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: hubRoot,
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
  if (app.isPackaged) void firstRunSetup();
}

// ---- インストール版 ----
const setupPaths = (): SetupPaths => ({ hubRoot, node: nodeExe, dataDir, version: app.getVersion() });
let settingUp = false;

/** 初回(とバージョンが変わったとき)に Claude Code へつなぐ。前提が足りなければ案内する */
async function firstRunSetup(): Promise<void> {
  if (settingUp || setupDone(setupPaths())) return;
  settingUp = true;
  try {
    const r = runSetup(setupPaths());
    if (r.missing.length) await showMissing(r.missing);
    else if (r.errors.length) {
      await dialog.showMessageBox({
        type: 'warning', title: 'CC Hub', message: 'Claude Code との連携の設定で失敗したものがあります',
        detail: `${r.errors.join('\n')}\n\n詳しくは ${path.join(dataDir, 'setup.log')} を見てください。次に起動したときにもう一度試します。`,
      });
    } else {
      await dialog.showMessageBox({
        type: 'info', title: 'CC Hub', message: 'Claude Code と連携しました',
        detail: 'CC Hub から起動したセッションに加えて、ターミナルや VS Code で使っている Claude Code もここに表示されます(起動し直したものから)。',
      });
    }
  } finally {
    settingUp = false;
  }
}

async function showMissing(missing: SetupResult['missing']): Promise<void> {
  const r = await dialog.showMessageBox({
    type: 'warning', title: 'CC Hub', message: `${missing.map((m) => m.name).join(' と ')} が見つかりません`,
    detail: `${missing.map((m) => `■ ${m.name}\n${m.how}`).join('\n\n')}\n\nインストールしたら、トレイの「再読み込み」か CC Hub の起動し直しで設定を続けます。`,
    buttons: [...missing.map((m) => `${m.name} の入手方法を開く`), '閉じる'],
    cancelId: missing.length,
  });
  const m = missing[r.response];
  if (m) void shell.openExternal(m.url);
}

/** デーモンが落ちていたら起こし直す(開発版は watchdog.ps1 がやるので、インストール版だけ) */
function watchDaemon(): void {
  let restarting = false;
  setInterval(async () => {
    if (quitting || restarting || (await healthy())) return;
    loadConfig();
    if (await healthy()) return;
    restarting = true;
    try {
      fs.appendFileSync(logPath, `[desktop] ${new Date().toISOString()} デーモンが応答しないので起動し直します\n`);
      if ((await ensureDaemon()) && win) void load();
    } finally {
      restarting = false;
    }
  }, WATCH_MS).unref();
}

function loginItemEnabled(): boolean {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setLoginItem(on: boolean): void {
  // name = レジストリ(HKCU\...\Run)の値の名前。アンインストール時に installer.nsh が消す
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'], name: 'CC Hub' });
}

/** 初めて起動したときだけ、ログイン時の起動を有効にする(あとはトレイのメニューで切り替える) */
function initLoginItem(): void {
  const flag = path.join(dataDir, 'desktop-login-item');
  if (fs.existsSync(flag)) return;
  setLoginItem(true);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(flag, '1');
  } catch { /* 無視 */ }
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
  win.once('ready-to-show', () => { if (!startHidden) win?.show(); });
  // 前面かどうかをデーモンに知らせる(表示中のセッションの通知を Discord などにも出さないため。セッションは画面側が送る)
  win.on('focus', () => reportFocus(true));
  win.on('blur', () => reportFocus(false));
  win.on('hide', () => reportFocus(false));
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
    ...(app.isPackaged && !isolated
      ? [{ label: 'ログイン時に起動', type: 'checkbox' as const, checked: loginItemEnabled(), click: (i: Electron.MenuItem) => setLoginItem(i.checked) }]
      : []),
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

/** POST /api/client/focus {focused}(失敗は無視) */
function reportFocus(focused: boolean): void {
  const body = JSON.stringify({ focused });
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/client/focus', method: 'POST', timeout: 2000,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => res.resume());
  req.on('error', () => { /* 無視 */ });
  req.on('timeout', () => req.destroy());
  req.end(body);
}

// ---- 通知(WS) ----
function connectWs(): void {
  if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* 無視 */ } ws = null; }
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  // client=desktop: デーモンはこの接続がある間だけ Windows 通知をアプリに任せる(無ければデーモンが自分で出す)
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?client=desktop`, {
    headers: { Authorization: `Bearer ${token}`, 'X-CC-Hub-Client': 'desktop' },
  });
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

// ---- レンダラーからの呼び出し(preload の ccHub.* 経由) ----
/** 公開するチャンネル(preload と合わせる) */
const IPC_PICK_FOLDER = 'hub:pick-folder';

function registerIpc(): void {
  // フォルダ選択ダイアログ。自分のウィンドウ(デーモンの画面)からの呼び出しだけ受ける
  ipcMain.handle(IPC_PICK_FOLDER, async (e): Promise<string | null> => {
    if (!win || e.sender !== win.webContents) return null;
    if (!e.senderFrame?.url.startsWith(`http://127.0.0.1:${port}`)) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'フォルダを選択' });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
}

// ---- 起動 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // インストール版はインストーラーが作るショートカットの AppUserModelId(= appId)と合わせる(合わないと Windows の通知が出ない)
  app.setAppUserModelId(app.isPackaged ? APP_ID : 'CC Hub');
  app.whenReady().then(() => {
    registerIpc();
    if (app.isPackaged) {
      if (!isolated) initLoginItem();
      watchDaemon();
    }
    createWindow();
    createTray();
    globalShortcut.register('Control+Shift+Space', toggleWindow);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* トレイ常駐 */ });
}
