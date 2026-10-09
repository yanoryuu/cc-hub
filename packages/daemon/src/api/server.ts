// HTTP サーバー(Node http、フレームワーク無し)。REST の一覧は packages/shared/src/index.ts を参照。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { HubState, StartSessionRequest } from '@cc-hub/shared';
import type { Auth } from './auth';
import type { SessionManager } from '../session/manager';
import { listProjects, scanSessions } from '../history';
import { handleGame } from '../game/capture';
import { HttpError, json, readBody } from '../util';

// dist/main.js から見て packages/web/dist
const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PLACEHOLDER = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CC Hub</title></head>
<body style="font-family:sans-serif;background:#1a1b26;color:#c0caf5;padding:24px">
<h1>CC Hub デーモンは起動しています</h1><p>Web UI(packages/web/dist)がまだビルドされていません。<code>npm run build -w @cc-hub/web</code> を実行してください。</p>
</body></html>`;

export interface ServerDeps {
  auth: Auth;
  sessions: SessionManager;
  getState: () => HubState;
  onIngestHook: (body: any, hubHeader: string | undefined) => void;
  onIngestStatusline: (body: any) => void;
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  const root = path.resolve(WEB_DIST);
  let file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root)) file = path.join(root, 'index.html');
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null;
  }
  if (!st || st.isDirectory()) {
    // 拡張子付きで見つからないものは 404、それ以外は SPA フォールバック
    if (st == null && path.extname(rel) && !rel.endsWith('.html')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(PLACEHOLDER);
      return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    // ハッシュ付きのアセットは長期キャッシュ、それ以外は毎回確認
    const immutable = /[\\/]assets[\\/]/.test(file) && !file.endsWith('.html');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
}

export function createServer(d: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(d, req, res).catch((err) => {
      if (err instanceof HttpError) return json(res, err.status, { ok: false, error: err.message });
      console.error('[http]', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    });
  });
}

async function handle(d: ServerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  // ------------------------------------------------ ingest(hooks / statusLine)
  // 即座に 200 を返し、処理は非同期に行う(Claude の動作を妨げないため)。
  // 応答本文は hooks の出力として解釈されるので空オブジェクト {} にする。
  if (p === '/ingest/hook' || p === '/ingest/statusline') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (!d.auth.isIngest(req)) return json(res, 403, { ok: false, error: 'forbidden' });
    let body: any;
    try {
      body = await readBody(req, 5e6);
    } catch {
      return json(res, 400, {});
    }
    json(res, 200, {});
    const hubHeader = req.headers['x-cc-hub-session'];
    setImmediate(() => {
      try {
        if (p === '/ingest/hook') d.onIngestHook(body, typeof hubHeader === 'string' ? hubHeader : undefined);
        else d.onIngestStatusline(body);
      } catch (err) {
        console.error('[ingest]', err);
      }
    });
    return;
  }

  // ------------------------------------------------ 認証不要
  if (p === '/auth' && method === 'POST') {
    const body = await readBody(req);
    const r = d.auth.login(body.pin);
    if (!r.ok) return json(res, r.status, { ok: false, error: r.error });
    return json(res, 200, { ok: true }, {
      'Set-Cookie': `ccr_token=${r.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    });
  }

  const isApi = p.startsWith('/api/') || p.startsWith('/game/') || p === '/ws' || p.startsWith('/ingest/') || p === '/auth';
  if (!isApi) {
    if (method === 'GET' || method === 'HEAD') return serveStatic(res, p);
    return json(res, 404, { ok: false, error: 'not found' });
  }

  // ------------------------------------------------ ここから認証必須
  if (!d.auth.isAuthed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (p.startsWith('/game/')) {
    if (await handleGame(req, res, url)) return;
    return json(res, 404, { ok: false, error: 'not found' });
  }

  if (p === '/api/state' && method === 'GET') return json(res, 200, { ok: true, ...d.getState() });

  if (p === '/api/projects' && method === 'GET') return json(res, 200, { ok: true, projects: listProjects() });

  if (p === '/api/history' && method === 'GET') {
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '', 10) || 30));
    return json(res, 200, { ok: true, sessions: scanSessions(limit) });
  }

  if (p === '/api/sessions' && method === 'POST') {
    const body = (await readBody(req)) as StartSessionRequest;
    const session = d.sessions.start(body);
    return json(res, 200, { ok: true, session });
  }

  const m = /^\/api\/sessions\/([^/]+)\/(input|resize|control|approve|rename)$/.exec(p);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const body = await readBody(req);
    switch (m[2]) {
      case 'input':
        d.sessions.input(id, body.data, body.submit);
        return json(res, 200, { ok: true });
      case 'resize':
        return json(res, 200, { ok: true, ...d.sessions.resize(id, body.cols, body.rows) });
      case 'control':
        d.sessions.control(id, String(body.action || ''));
        return json(res, 200, { ok: true });
      case 'approve':
        d.sessions.approve(id, body.option);
        return json(res, 200, { ok: true });
      case 'rename':
        d.sessions.rename(id, body.name);
        return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
}
