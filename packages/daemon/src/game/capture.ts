// GameCapture(CC Remote から移植。仕様はそのまま)
// native/gamecap.exe がウィンドウを JPEG 連続キャプチャ → MJPEG で配信。
// タップ座標(0..1 正規化)は gamecap の stdin 経由で SendInput によりクリック注入。
import path from 'node:path';
import type http from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { json, readBody } from '../util';

// dist/main.js から見て ../native/gamecap.exe
const GAMECAP = path.join(__dirname, '..', 'native', 'gamecap.exe');

let capProc: ChildProcess | null = null;
let capHwnd: number | null = null;
let capBuf = Buffer.alloc(0);
let lastFrame: Buffer | null = null;
const mjpegClients = new Set<http.ServerResponse>();
let capIdleTimer: NodeJS.Timeout | undefined;

function startCapture(hwnd: number): void {
  stopCapture();
  capHwnd = hwnd;
  capBuf = Buffer.alloc(0);
  lastFrame = null;
  const proc = spawn(GAMECAP, ['stream', String(hwnd), '10', '65', '1280']);
  capProc = proc;
  proc.on('error', () => {
    if (capProc === proc) capProc = null;
  });
  proc.stdout!.on('data', (d: Buffer) => {
    capBuf = Buffer.concat([capBuf, d]);
    while (capBuf.length >= 4) {
      const len = capBuf.readUInt32LE(0);
      if (len <= 0 || len > 20e6) {
        capBuf = Buffer.alloc(0);
        break;
      }
      if (capBuf.length < 4 + len) break;
      const frame = capBuf.subarray(4, 4 + len);
      lastFrame = frame;
      capBuf = capBuf.subarray(4 + len);
      for (const res of mjpegClients) {
        if (res.writableLength > 2e6) continue; // 遅いクライアントはフレームを間引く
        res.write(`--ccrframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      }
    }
  });
  proc.on('exit', () => {
    if (capProc === proc) capProc = null;
  });
}

export function stopCapture(): void {
  if (capProc) {
    try {
      capProc.kill();
    } catch {
      /* 既に終了 */
    }
    capProc = null;
  }
  capHwnd = null;
  lastFrame = null;
}

function scheduleCapIdle(): void {
  clearTimeout(capIdleTimer);
  capIdleTimer = setTimeout(() => {
    if (mjpegClients.size === 0) stopCapture();
  }, 15000);
}

function listGameWindows(): Promise<unknown[]> {
  return new Promise((resolve) => {
    execFile(GAMECAP, ['list'], { maxBuffer: 1e6 }, (err, stdout) => {
      if (err) return resolve([]);
      const out: unknown[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* 壊れた行は無視 */
        }
      }
      resolve(out);
    });
  });
}

/** /game/* を処理したら true(認証済みの前提で呼ぶ) */
export async function handleGame(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p === '/game/windows' && req.method === 'GET') {
    const windows = await listGameWindows();
    json(res, 200, { ok: true, windows });
    return true;
  }

  if (p === '/game/stream' && req.method === 'GET') {
    const hwnd = parseInt(url.searchParams.get('hwnd') || '', 10);
    if (!hwnd) {
      json(res, 400, { ok: false, error: 'hwnd required' });
      return true;
    }
    if (capHwnd !== hwnd || !capProc) startCapture(hwnd);
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ccrframe',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    if (lastFrame) {
      res.write(`--ccrframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${lastFrame.length}\r\n\r\n`);
      res.write(lastFrame);
      res.write('\r\n');
    }
    mjpegClients.add(res);
    req.on('close', () => {
      mjpegClients.delete(res);
      scheduleCapIdle();
    });
    return true;
  }

  if (p === '/game/input' && req.method === 'POST') {
    let body: any;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { ok: false, error: 'bad request' });
      return true;
    }
    if (!capProc) {
      json(res, 409, { ok: false, error: 'キャプチャが起動していません' });
      return true;
    }
    const stdin = capProc.stdin!;
    const type = String(body.type);
    if (type === 'keydown' || type === 'keyup') {
      const vk = body.vk | 0;
      if (vk < 1 || vk > 254) {
        json(res, 400, { ok: false, error: 'bad vk' });
        return true;
      }
      stdin.write(`${type} ${vk}\n`);
      json(res, 200, { ok: true });
      return true;
    }
    if (type === 'text') {
      const text = String(body.text || '').slice(0, 500);
      if (!text) {
        json(res, 400, { ok: false, error: 'empty text' });
        return true;
      }
      stdin.write(`text ${Buffer.from(text, 'utf8').toString('base64')}\n`);
      json(res, 200, { ok: true });
      return true;
    }
    if (!['click', 'down', 'move', 'up'].includes(type)) {
      json(res, 400, { ok: false, error: 'bad type' });
      return true;
    }
    const x = Math.max(0, Math.min(1, Number(body.x)));
    const y = Math.max(0, Math.min(1, Number(body.y)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      json(res, 400, { ok: false, error: 'bad coords' });
      return true;
    }
    stdin.write(`${type} ${x.toFixed(4)} ${y.toFixed(4)}\n`);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
