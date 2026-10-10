// HTTP サーバー(Node http、フレームワーク無し)。REST の一覧は packages/shared/src/index.ts を参照。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { HubState, RegisterRepoRequest, ReleaseMode, StartSessionRequest } from '@cc-hub/shared';
import type { Auth } from './auth';
import type { SessionManager } from '../session/manager';
import type { RepoManager } from '../repo/manager';
import type { GitHubWatcher } from '../github/watcher';
import type { PrActions } from '../github/actions';
import type { ProjectService } from '../project/service';
import type { NotifyService } from '../notify/service';
import type { DeployService } from '../deploy/service';
import type { InstructionsService } from '../project/instructions';
import type { FirebaseInfoService } from '../firebase/info';
import { handleMcp, type McpHttpDeps } from '../mcp/server';
import { cleanupBranches, listBranches } from '../repo/branches';
import { generateSlug } from '../repo/slug';
import { historyEntry, listProjects, queryHistory, readMessages } from '../history';
import { listDirs } from '../fsdirs';
import { handleGame } from '../game/capture';
import { listSkills } from '../skills';
import { listMcp } from '../mcp';
import { ATTACH_MAX_BYTES, saveAttachment } from '../session/attach';
import { HttpError, json, readBody } from '../util';

// packages/web/dist。バンドルの出力先(dist / dist-test など)に依らないよう、daemon パッケージのルートを探してから辿る
// 検証時は環境変数 CC_HUB_WEB_DIST で別のビルド(dist-test など)を配信できる
function findWebDist(): string {
  if (process.env.CC_HUB_WEB_DIST) return path.resolve(process.env.CC_HUB_WEB_DIST);
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@cc-hub/daemon') return path.join(dir, '..', 'web', 'dist');
    } catch {
      /* 上へ */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(__dirname, '..', '..', 'web', 'dist');
}
const WEB_DIST = findWebDist();

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
  repos: RepoManager;
  github: GitHubWatcher;
  prs: PrActions;
  project: ProjectService;
  notify: NotifyService;
  deploy: DeployService;
  firebase: FirebaseInfoService;
  instructions: InstructionsService;
  /** /mcp(CC Hub 自身の MCP サーバー) */
  mcp: McpHttpDeps;
  claudePath: string;
  getState: () => HubState;
  onIngestHook: (body: any, hubHeader: string | undefined) => void;
  onIngestStatusline: (body: any) => void;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
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

  // ------------------------------------------------ MCP(mcp トークンで認証。PIN / ローカルトークンは使わない)
  if (p === '/mcp') return handleMcp(d.mcp, req, res);

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

  // ------------------------------------------------ 会話履歴(~/.claude/projects)・フォルダ選択
  if (p === '/api/history' && method === 'GET') {
    const sp = url.searchParams;
    const limit = Math.max(1, Math.min(200, parseInt(sp.get('limit') || '', 10) || 30));
    const offset = Math.max(0, parseInt(sp.get('offset') || '', 10) || 0);
    const t0 = Date.now();
    const r = queryHistory({
      limit,
      offset,
      q: sp.get('q'),
      cwd: sp.get('cwd'),
      includeTests: /^(1|true)$/i.test(sp.get('includeTests') || ''),
      hubIdFor: (id) => d.sessions.hubIdFor(id),
    });
    const ms = Date.now() - t0;
    if (ms > 300) console.log(`[history] 一覧 ${r.total} 件 ${ms}ms`);
    return json(res, 200, { ok: true, ...r });
  }

  const hm = /^\/api\/history\/([^/]+)(\/open)?$/.exec(p);
  if (hm) {
    const id = decodeURIComponent(hm[1]);
    const hubIdFor = (cid: string) => d.sessions.hubIdFor(cid);
    if (!hm[2] && method === 'GET') {
      const entry = historyEntry(id, hubIdFor);
      if (!entry) throw new HttpError(404, '会話が見つかりません');
      return json(res, 200, { ok: true, entry, messages: readMessages(id, 200) });
    }
    if (hm[2] && method === 'POST') {
      const body = await readBody(req);
      const target = body.target === 'terminal' ? 'terminal' : body.target === 'hub' || body.target == null ? 'hub' : null;
      if (!target) throw new HttpError(400, "target は 'hub' か 'terminal' です");
      const entry = historyEntry(id, hubIdFor);
      // transcript が無くても CC Hub 上のセッションなら開ける(/clear 直後など)
      if (!entry && !d.sessions.hubIdFor(id)) throw new HttpError(404, '会話が見つかりません');
      const session = await d.sessions.openHistory(id, target, { cwd: entry?.cwd ?? '', title: entry?.title ?? '' });
      return json(res, 200, { ok: true, session });
    }
  }

  if (p === '/api/fs/dirs' && method === 'GET') return json(res, 200, listDirs(url.searchParams.get('path')));

  if (p === '/api/sessions' && method === 'POST') {
    const body = (await readBody(req)) as StartSessionRequest;
    // フェーズ 2: repoId 指定ならプールの worktree で起動(準備は非同期。状態 starting で返る)
    const session = body && body.repoId ? d.repos.startSession(body) : d.sessions.start(body);
    return json(res, 200, { ok: true, session });
  }

  // ------------------------------------------------ フェーズ 2: リポジトリ / worktree
  if (p === '/api/slug' && method === 'POST') {
    const body = await readBody(req);
    const g = await generateSlug(String(body.instruction ?? ''), d.claudePath);
    return json(res, 200, { ok: true, slug: g.slug, source: g.source });
  }

  if (p === '/api/repos' && method === 'GET') return json(res, 200, { ok: true, ...d.repos.list() });

  if (p === '/api/repos' && method === 'POST') {
    const body = (await readBody(req)) as RegisterRepoRequest;
    const repo = await d.repos.register(body);
    return json(res, 200, { ok: true, repo });
  }

  // ------------------------------------------------ フェーズ 3: ブランチ / PR
  const bm = /^\/api\/repos\/([^/]+)\/branches(\/cleanup)?$/.exec(p);
  if (bm) {
    const repo = d.repos.require(decodeURIComponent(bm[1]));
    if (repo.status !== 'ready') throw new HttpError(409, `リポジトリの準備ができていません(${repo.status})`);
    const deps = { pool: d.repos.pool, sessions: () => d.sessions.all(), prs: () => d.github.list() };
    if (!bm[2] && method === 'GET') return json(res, 200, { ok: true, branches: await listBranches(repo, deps) });
    if (bm[2] && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...(await cleanupBranches(repo, body.names, deps)) });
    }
  }

  if (p === '/api/prs/refresh' && method === 'POST') {
    await d.github.refreshAll();
    return json(res, 200, { ok: true, prs: d.github.all() });
  }

  const pm = /^\/api\/prs\/([^/]+)\/(\d+)(?:\/(fix|open-session|merge|close))?$/.exec(p);
  if (pm) {
    const repoId = decodeURIComponent(pm[1]);
    const n = Number(pm[2]);
    if (!pm[3] && method === 'GET') return json(res, 200, { ok: true, pr: await d.prs.detail(repoId, n) });
    if (pm[3] && method === 'POST') {
      const body = await readBody(req);
      switch (pm[3]) {
        case 'fix':
          return json(res, 200, await d.prs.fix(repoId, n, body));
        case 'open-session':
          return json(res, 200, await d.prs.openSession(repoId, n, body));
        case 'merge':
          return json(res, 200, await d.prs.merge(repoId, n, body.method));
        case 'close':
          return json(res, 200, await d.prs.close(repoId, n));
      }
    }
  }

  const cp = /^\/api\/sessions\/([^/]+)\/create-pr$/.exec(p);
  if (cp && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, d.prs.createPr(decodeURIComponent(cp[1]), body.draft === true));
  }

  const rm = /^\/api\/repos\/([^/]+)(\/refill)?$/.exec(p);
  if (rm) {
    const id = decodeURIComponent(rm[1]);
    if (rm[2] && method === 'POST') return json(res, 200, { ok: true, repo: d.repos.refill(id) });
    if (!rm[2] && method === 'PATCH') return json(res, 200, { ok: true, repo: d.repos.patch(id, await readBody(req)) });
    if (!rm[2] && method === 'DELETE') {
      const purge = /^(1|true)$/i.test(url.searchParams.get('purge') || '');
      await d.repos.remove(id, purge);
      return json(res, 200, { ok: true });
    }
  }

  const wm = /^\/api\/worktrees\/([^/]+)(\/rebuild)?$/.exec(p);
  if (wm) {
    const id = decodeURIComponent(wm[1]);
    if (wm[2] && method === 'POST') {
      d.repos.rebuildWorktree(id);
      return json(res, 200, { ok: true });
    }
    if (!wm[2] && method === 'DELETE') {
      await d.repos.removeWorktree(id);
      return json(res, 200, { ok: true });
    }
  }

  // ------------------------------------------------ フォルダ(プロジェクト)ごとの管理画面
  if (p === '/api/project' && method === 'GET') {
    const project = await d.project.overview({ repoId: url.searchParams.get('repoId'), cwd: url.searchParams.get('cwd') });
    return json(res, 200, { ok: true, project });
  }

  if (p === '/api/project/file' && method === 'GET') {
    // テキスト(画像以外)は JSON {ok, path, size, mtime, binary, truncated, text}(512KB まで)。
    // 画像はそのままのバイト列(SVG はスクリプトが動かないよう CSP を付ける)
    const r = await d.project.file(url.searchParams.get('target'), url.searchParams.get('path'));
    if (r.type === 'json') return json(res, 200, r.body);
    const headers: Record<string, string> = {
      'Content-Type': r.mime,
      'Content-Length': String(r.data.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (r.svg) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    res.writeHead(200, headers);
    res.end(r.data);
    return;
  }

  if (p === '/api/project/diff' && method === 'GET') {
    const staged = /^(1|true)$/i.test(url.searchParams.get('staged') || '');
    const r = await d.project.diff(url.searchParams.get('target'), url.searchParams.get('path'), staged);
    return json(res, 200, { ok: true, ...r });
  }

  if (p === '/api/git/stage' && method === 'POST') {
    return json(res, 200, { ok: true, target: await d.project.stage(await readBody(req)) });
  }

  if (p === '/api/git/commit' && method === 'POST') {
    return json(res, 200, { ok: true, commit: await d.project.commit(await readBody(req)) });
  }

  if (p === '/api/git/push' && method === 'POST') {
    return json(res, 200, { ok: true, ...(await d.project.push(await readBody(req))) });
  }

  // ------------------------------------------------ 通知
  if (p === '/api/notify/settings' && method === 'GET') {
    const out: Record<string, unknown> = { ok: true, settings: d.notify.getSettings() };
    if (url.searchParams.get('debug') === '1') out.recent = d.notify.recent;
    return json(res, 200, out);
  }
  if (p === '/api/notify/settings' && method === 'PUT') {
    return json(res, 200, { ok: true, settings: await d.notify.putSettings(await readBody(req)) });
  }
  if (p === '/api/notify/test' && method === 'POST') {
    const body = await readBody(req);
    const r = await d.notify.test(body.channel, body.targetId);
    return json(res, r.ok ? 200 : 502, r.ok ? { ...r, ok: true } : { ok: false, error: r.message });
  }
  // 画面が「どのセッションを前面で表示しているか」を知らせる(表示中のセッションの通知を抑える)
  if (p === '/api/client/focus' && method === 'POST') {
    return json(res, 200, { ok: true, focus: d.notify.setFocus(await readBody(req)) });
  }

  // ------------------------------------------------ アップロード先のサーバー / アップロード
  if (p === '/api/servers' && method === 'GET') return json(res, 200, { ok: true, servers: d.deploy.serverList() });
  if (p === '/api/servers' && method === 'POST') return json(res, 200, { ok: true, server: await d.deploy.createServer(await readBody(req, 64 * 1024)) });
  const sv = /^\/api\/servers\/([^/]+)(\/test)?$/.exec(p);
  if (sv) {
    const id = decodeURIComponent(sv[1]);
    if (sv[2] && method === 'POST') return json(res, 200, await d.deploy.testServer(id));
    if (!sv[2] && method === 'PATCH') return json(res, 200, { ok: true, server: await d.deploy.patchServer(id, await readBody(req, 64 * 1024)) });
    if (!sv[2] && method === 'DELETE') {
      d.deploy.deleteServer(id);
      return json(res, 200, { ok: true });
    }
  }
  if (p === '/api/deploys' && method === 'POST') return json(res, 200, { ok: true, deploy: d.deploy.createUserJob(await readBody(req)) });
  const dp = /^\/api\/deploys\/([^/]+)(?:\/(approve|reject|cancel|start|promote))?$/.exec(p);
  if (dp) {
    const id = decodeURIComponent(dp[1]);
    if (!dp[2] && method === 'GET') {
      const deploy = d.deploy.job(id);
      if (!deploy) throw new HttpError(404, 'アップロードが見つかりません');
      return json(res, 200, { ok: true, deploy });
    }
    if (dp[2] && method === 'POST') {
      const body = await readBody(req);
      switch (dp[2]) {
        case 'approve':
          return json(res, 200, { ok: true, deploy: d.deploy.approve(id) });
        case 'reject':
          return json(res, 200, { ok: true, deploy: d.deploy.reject(id, body.reason) });
        case 'cancel':
          return json(res, 200, { ok: true, deploy: d.deploy.cancel(id) });
        case 'start':
          return json(res, 200, { ok: true, deploy: d.deploy.start(id) });
        case 'promote':
          return json(res, 200, { ok: true, deploy: d.deploy.promote(id) });
      }
    }
  }

  // ------------------------------------------------ Firebase
  if (p === '/api/firebase' && method === 'GET') {
    const cwd = (url.searchParams.get('cwd') ?? '').trim();
    if (!cwd || !path.isAbsolute(cwd)) throw new HttpError(400, 'cwd(絶対パス)を指定してください');
    return json(res, 200, { ok: true, info: await d.firebase.get(cwd, url.searchParams.get('refresh') === '1') });
  }
  if (p === '/api/firebase/deploy' && method === 'POST') {
    return json(res, 200, { ok: true, deploy: d.deploy.createFirebaseUserJob(await readBody(req, 64 * 1024)) });
  }

  // ------------------------------------------------ プロジェクトの共通の指示
  if (p === '/api/project/instructions' || p === '/api/project/instructions/rewrite') {
    const key = d.instructions.normalizeKey({ repoId: url.searchParams.get('repoId'), cwd: url.searchParams.get('cwd') });
    if (key.repoId) d.repos.require(key.repoId);
    if (p === '/api/project/instructions' && method === 'GET') return json(res, 200, { ok: true, instructions: d.instructions.get(key) });
    if (p === '/api/project/instructions' && method === 'PUT') {
      const body = await readBody(req, 1e6);
      return json(res, 200, { ok: true, instructions: d.instructions.put(key, body.content, 'user') });
    }
    if (p === '/api/project/instructions/rewrite' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...(await d.instructions.rewrite(key, body.request)) });
    }
  }

  // ------------------------------------------------ 指示・PowerShell・スキル・MCP
  if (p === '/api/skills' && method === 'GET') {
    const cwd = url.searchParams.get('cwd') || '';
    if (cwd && !isDir(cwd)) throw new HttpError(400, `ディレクトリが存在しません: ${cwd}`);
    return json(res, 200, { ok: true, skills: listSkills(cwd ? path.resolve(cwd) : null) });
  }

  if (p === '/api/mcp' && method === 'GET') {
    // cwd 省略時はホーム(ユーザースコープの MCP だけが見える)
    const cwd = url.searchParams.get('cwd') || process.env.USERPROFILE || require('node:os').homedir();
    if (!isDir(cwd)) throw new HttpError(400, `ディレクトリが存在しません: ${cwd}`);
    const refresh = /^(1|true)$/i.test(url.searchParams.get('refresh') || '');
    const r = await listMcp(d.claudePath, path.resolve(cwd), refresh);
    return json(res, r.ok ? 200 : 502, r);
  }

  const sx = /^\/api\/sessions\/([^/]+)\/(open-terminal|takeover|attach)$/.exec(p);
  if (sx && method === 'POST') {
    const id = decodeURIComponent(sx[1]);
    switch (sx[2]) {
      case 'open-terminal':
        return json(res, 200, { ok: true, session: await d.sessions.openTerminal(id) });
      case 'takeover': {
        const body = await readBody(req);
        return json(res, 200, { ok: true, session: d.sessions.takeover(id, body.force === true) });
      }
      case 'attach': {
        const info = d.sessions.info(id);
        if (!info) throw new HttpError(404, 'セッションが見つかりません');
        // base64 は元の 4/3 倍 + JSON の分
        const body = await readBody(req, Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 64 * 1024);
        return json(res, 200, { ok: true, path: await saveAttachment(info.cwd, body) });
      }
    }
  }

  const rel = /^\/api\/sessions\/([^/]+)\/release$/.exec(p);
  if (rel && method === 'POST') {
    const body = await readBody(req);
    const worktree = await d.repos.release(decodeURIComponent(rel[1]), body.mode as ReleaseMode);
    return json(res, 200, { ok: true, worktree });
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
