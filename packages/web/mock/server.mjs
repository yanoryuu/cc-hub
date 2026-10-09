// CC Hub デーモンのモック(開発・動作確認用)。契約は packages/shared/src/index.ts に準拠。
//   node packages/web/mock/server.mjs        → http://127.0.0.1:7862 (PIN: 1234)
//   HUB_TARGET=http://127.0.0.1:7862 npm run dev -w @cc-hub/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT || 7862);
const PIN = '1234';
const tokens = new Set();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon.png'));

const now = Date.now();
const MIN = 60_000;

function mkSession(p) {
  return {
    id: crypto.randomUUID(),
    name: 'session',
    cwd: 'C:\\Users\\yanor\\proj',
    mode: 'commander',
    managed: true,
    status: 'awaiting_input',
    createdAt: now - 30 * MIN,
    lastEventAt: now,
    currentTool: null,
    lastMessage: null,
    contextPct: 20,
    costUsd: 0.5,
    model: 'claude-opus-4-1',
    permissionMode: 'auto',
    approval: null,
    cols: 120,
    rows: 32,
    exitCode: null,
    repoId: null,
    worktreeId: null,
    branch: null,
    ...p,
  };
}

const sessions = {};
const agents = {};
const termBuf = {};

const REPO_WEB = 'coly-dev/shop-web';
const REPO_UNITY = 'coly-dev/TomsLands';
const REPO_CLONING = 'ryuichi-yano/cc-remote';

const s1 = mkSession({
  name: 'login-fix',
  cwd: 'C:\\wt\\shop-web\\wt-01',
  status: 'awaiting_approval',
  branch: 'feat/login-fix',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-01`,
  contextPct: 48,
  costUsd: 1.23,
  approval: {
    type: 'options',
    question: 'Bash コマンドを実行しますか?\n  npm test -- --watch=false',
    options: [
      { n: '1', label: 'Yes', selected: true },
      { n: '2', label: "Yes, and don't ask again for npm test", selected: false },
      { n: '3', label: 'No, and tell Claude what to do differently (esc)', selected: false },
    ],
  },
});
const s2 = mkSession({
  name: 'shop-refactor',
  cwd: 'C:\\wt\\shop-web\\wt-02',
  status: 'running',
  branch: 'feat/shop-refactor',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-02`,
  contextPct: 72,
  costUsd: 3.87,
  currentTool: { name: 'Task', target: '並列で 3 エージェントを起動', since: now - 95_000 },
});
const s3 = mkSession({
  name: 'docs (VS Code)',
  cwd: 'C:\\Users\\yanor\\cc-hub',
  managed: false,
  status: 'running',
  mode: 'plain',
  contextPct: 91,
  costUsd: 0.42,
  model: 'claude-sonnet-4-5',
  permissionMode: 'default',
  currentTool: { name: 'Edit', target: 'docs/design.md', since: now - 12_000 },
  lastMessage: '設計書の §12 UI にスマホのタブ構成を追記しました。次に API 節の WebSocket プロトコルを最新の契約に合わせます。',
  cols: 0,
  rows: 0,
});
// 停止済み・worktree が割り当てられたまま(解放待ち)
const s4 = mkSession({
  name: 'cart-badge',
  cwd: 'C:\\wt\\shop-web\\wt-03',
  status: 'stopped',
  exitCode: 0,
  branch: 'feat/cart-badge-count',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-03`,
  contextPct: 35,
  costUsd: 0.88,
  createdAt: now - 90 * MIN,
  lastMessage: 'カートのバッジに件数を表示するようにしました。テストも追加済みです。',
});
for (const s of [s1, s2, s3, s4]) sessions[s.id] = s;

// ---------------------------------------------------------------- リポジトリ / worktree プール
const repos = {};
const worktrees = {};
function mkRepo(id, p) {
  const [owner, name] = id.split('/');
  return {
    id,
    url: `https://github.com/${id}`,
    owner,
    name,
    baseDir: `C:\\wt\\${name}`,
    defaultBranch: 'main',
    kind: 'node',
    installCmd: null,
    keepDirs: ['node_modules'],
    seedLibraryFrom: null,
    poolMin: 3,
    poolMax: 10,
    trusted: true,
    status: 'ready',
    error: null,
    createdAt: now - 3 * 24 * 60 * MIN,
    ...p,
  };
}
function mkWt(repo, n, p) {
  const name = `wt-${String(n).padStart(2, '0')}`;
  return {
    id: `${repo.id}#${name}`,
    repoId: repo.id,
    name,
    path: `${repo.baseDir}\\${name}`,
    state: 'idle',
    branch: null,
    sessionId: null,
    lastUsedAt: now - 40 * MIN,
    progress: null,
    error: null,
    ...p,
  };
}
const rWeb = mkRepo(REPO_WEB, {});
const rUnity = mkRepo(REPO_UNITY, {
  baseDir: 'D:\\wt\\TomsLands',
  kind: 'unity',
  keepDirs: ['Library'],
  seedLibraryFrom: 'D:\\Unity\\TomsLands\\Library',
  poolMin: 2,
  poolMax: 5,
  error: 'D: の空き容量が残り 48GB です。50GB を下回ると補充を停止します',
});
const rClone = mkRepo(REPO_CLONING, { status: 'cloning', defaultBranch: '', createdAt: Date.now() });
for (const r of [rWeb, rUnity, rClone]) repos[r.id] = r;
for (const w of [
  mkWt(rWeb, 1, { state: 'assigned', branch: s1.branch, sessionId: s1.id, lastUsedAt: now - 30 * MIN }),
  mkWt(rWeb, 2, { state: 'assigned', branch: s2.branch, sessionId: s2.id, lastUsedAt: now - 30 * MIN }),
  mkWt(rWeb, 3, { state: 'assigned', branch: s4.branch, sessionId: s4.id, lastUsedAt: now - 90 * MIN }),
  mkWt(rWeb, 4, { state: 'idle', lastUsedAt: now - 300 * MIN }),
  mkWt(rWeb, 5, { state: 'warming', progress: 'npm ci 実行中(312/840 パッケージ)', lastUsedAt: now - 2 * MIN }),
  mkWt(rWeb, 6, { state: 'broken', error: 'git worktree remove に失敗: ファイルがロックされています (node_modules\\.bin\\esbuild.exe)', lastUsedAt: now - 600 * MIN }),
  mkWt(rUnity, 1, { state: 'warming', progress: 'Library をコピー中 (3.1 / 7.4 GB)', lastUsedAt: now - 5 * MIN }),
  mkWt(rUnity, 2, { state: 'creating', progress: 'git worktree add', lastUsedAt: now - 1 * MIN }),
])
  worktrees[w.id] = w;

function upsertRepo(r) {
  broadcast('state', { t: 'repo.upsert', repo: r });
}
function upsertWt(w) {
  broadcast('state', { t: 'worktree.upsert', worktree: w });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function repoWts(id) {
  return Object.values(worktrees).filter((w) => w.repoId === id);
}
function nextWtNo(repo) {
  const used = new Set(repoWts(repo.id).map((w) => parseInt(w.name.slice(3), 10)));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
/** creating → warming → idle(onDone があれば idle にせず呼ぶ) */
async function warm(w, onDone) {
  const repo = repos[w.repoId];
  w.state = 'creating';
  w.progress = 'git worktree add';
  w.error = null;
  upsertWt(w);
  await sleep(1500);
  if (!worktrees[w.id]) return;
  w.state = 'warming';
  w.progress = repo?.kind === 'unity' ? 'Library をコピー中' : 'npm ci 実行中';
  upsertWt(w);
  await sleep(3000);
  if (!worktrees[w.id]) return;
  w.progress = null;
  w.lastUsedAt = Date.now();
  if (onDone) return onDone();
  w.state = 'idle';
  upsertWt(w);
}
function refill(repo) {
  if (repo.status !== 'ready') return 0;
  const wts = repoWts(repo.id);
  const ready = wts.filter((w) => ['idle', 'creating', 'warming'].includes(w.state)).length;
  let made = 0;
  for (let i = ready; i < repo.poolMin && wts.length + made < repo.poolMax; i++) {
    const w = mkWt(repo, nextWtNo(repo), { state: 'creating' });
    worktrees[w.id] = w;
    made++;
    void warm(w);
  }
  return made;
}
async function cloneRepo(repo, ms) {
  await sleep(ms);
  if (!repos[repo.id]) return;
  repo.status = 'ready';
  repo.defaultBranch = 'main';
  upsertRepo(repo);
  refill(repo);
}
void cloneRepo(rClone, 5000);
function slugOf(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g);
  if (words && words.length) return words.slice(0, 5).join('-').slice(0, 40);
  const fake = ['fix-login-redirect', 'add-cart-badge', 'refactor-shop-service', 'update-inventory-ui', 'improve-error-toast'];
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return fake[h % fake.length];
}

function mkAgent(p) {
  return {
    agentId: crypto.randomUUID().slice(0, 8),
    sessionId: s2.id,
    parentAgentId: null,
    type: 'general-purpose',
    description: '',
    model: 'sonnet',
    status: 'running',
    currentTool: null,
    startedAt: now - 60_000,
    endedAt: null,
    depth: 1,
    ...p,
  };
}
const aExplore = mkAgent({ type: 'Explore', model: 'haiku', description: '既存のショップ実装を調査', status: 'done', startedAt: now - 300_000, endedAt: now - 240_000 });
const aImpl = mkAgent({ type: 'implementer', model: 'opus', description: 'ShopService を分割', startedAt: now - 200_000, currentTool: { name: 'Edit', target: 'src/shop/ShopService.ts', since: now - 4000 } });
const aImplSub = mkAgent({ parentAgentId: aImpl.agentId, depth: 2, type: 'Explore', model: 'haiku', description: '呼び出し元を列挙', startedAt: now - 80_000, currentTool: { name: 'Grep', target: 'ShopService', since: now - 2000 } });
const aImplSub2 = mkAgent({ parentAgentId: aImplSub.agentId, depth: 3, type: 'general-purpose', model: 'haiku', description: 'テストの依存を確認', startedAt: now - 30_000, currentTool: { name: 'Read', target: 'test/shop.test.ts', since: now - 1000 } });
const aTest = mkAgent({ type: 'tester', model: 'sonnet', description: 'テストを追加', startedAt: now - 150_000, currentTool: { name: 'Bash', target: 'npm test', since: now - 20_000 } });
for (const a of [aExplore, aImpl, aImplSub, aImplSub2, aTest]) agents[a.agentId] = a;

let usage = {
  fiveHour: { pct: 62, resetsAt: now + 100 * MIN },
  sevenDay: { pct: 35, resetsAt: now + 3 * 24 * 60 * MIN + 4 * 60 * MIN },
  updatedAt: now,
};

// 疑似ターミナルの初期内容
const C = { reset: '\x1b[0m', dim: '\x1b[2m', blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', cyan: '\x1b[36m', mag: '\x1b[35m' };
for (const s of [s1, s2, s4]) {
  termBuf[s.id] =
    `${C.mag}╭───────────────────────────────────────────╮${C.reset}\r\n` +
    `${C.mag}│${C.reset} ${C.bold}✻ Claude Code${C.reset} (mock)                        ${C.mag}│${C.reset}\r\n` +
    `${C.mag}│${C.reset}   cwd: ${s.cwd.padEnd(34)}${C.mag}│${C.reset}\r\n` +
    `${C.mag}╰───────────────────────────────────────────╯${C.reset}\r\n\r\n` +
    `${C.dim}> /commander ${s.name} を進めて${C.reset}\r\n\r\n` +
    `${C.green}●${C.reset} 了解しました。まず関連ファイルを調べます。\r\n`;
}
termBuf[s1.id] += `\r\n${C.yellow}╭─ Bash command ─────────────────────────────╮${C.reset}\r\n  npm test -- --watch=false\r\n\r\n  Do you want to proceed?\r\n  ${C.cyan}❯ 1. Yes${C.reset}\r\n    2. Yes, and don't ask again\r\n    3. No (esc)\r\n${C.yellow}╰────────────────────────────────────────────╯${C.reset}\r\n`;

// ---------------------------------------------------------------- WS
const clients = new Set(); // { ws, topics:Set }
function send(c, msg) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}
function broadcast(topic, msg) {
  for (const c of clients) if (c.topics.has(topic)) send(c, msg);
}
function fullState() {
  return { sessions, agents, repos, worktrees, usage, daemon: { version: '0.0.0-mock', startedAt: now, port: PORT } };
}
function upsertSession(s) {
  s.lastEventAt = Date.now();
  broadcast('state', { t: 'session.upsert', session: s });
}
function termWrite(sid, data) {
  termBuf[sid] = (termBuf[sid] || '') + data;
  if (termBuf[sid].length > 200_000) termBuf[sid] = termBuf[sid].slice(-150_000);
  broadcast(`term:${sid}`, { t: 'term.data', sid, data });
}
function notify(kind, s, title, body) {
  broadcast('state', { t: 'notify', event: { kind, sessionId: s.id, title, body, ts: Date.now() } });
}

// ---------------------------------------------------------------- HTTP
function parseCookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => tokens.has(parseCookies(req).ccr_token);
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/auth' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (String(body.pin) !== PIN) return json(res, 401, { ok: false, error: 'PIN が違います' });
    const t = crypto.randomBytes(16).toString('hex');
    tokens.add(t);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `ccr_token=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p.startsWith('/api/') || p.startsWith('/game/')) {
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  } else {
    return json(res, 404, { ok: false, error: 'not found (mock serves API only)' });
  }

  if (p === '/api/state') return json(res, 200, fullState());
  if (p === '/api/projects')
    return json(res, 200, {
      ok: true,
      projects: [
        { path: 'C:\\Users\\yanor\\cc-hub', lastUsed: now - 5 * MIN },
        { path: 'C:\\wt\\TomsLands\\.base', lastUsed: now - 60 * MIN },
        { path: 'C:\\Users\\yanor\\cc-remote', lastUsed: now - 600 * MIN },
      ],
    });
  if (p === '/api/history')
    return json(res, 200, {
      ok: true,
      sessions: [
        { id: crypto.randomUUID(), cwd: 'C:\\Users\\yanor\\cc-hub', title: 'デーモンの WS プロトコルを実装', mtime: now - 20 * MIN },
        { id: crypto.randomUUID(), cwd: 'C:\\wt\\TomsLands\\wt-03', title: 'インベントリ UI の不具合修正', mtime: now - 300 * MIN },
      ],
    });
  // ---------------- フェーズ 2: リポジトリ / worktree
  if (p === '/api/slug' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    await sleep(600);
    return json(res, 200, { ok: true, slug: slugOf(b.instruction || '') });
  }
  if (p === '/api/repos' && req.method === 'GET') {
    return json(res, 200, { ok: true, repos: Object.values(repos), worktrees: Object.values(worktrees) });
  }
  if (p === '/api/repos' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    if (!b.trusted) return json(res, 400, { ok: false, error: '信頼の確認が必要です' });
    const u = String(b.url || '').trim();
    const m2 =
      u.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) || u.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (!m2) return json(res, 400, { ok: false, error: `URL を解釈できません: ${u}` });
    const id = `${m2[1]}/${m2[2]}`;
    if (repos[id]) return json(res, 409, { ok: false, error: `${id} は登録済みです` });
    if (/fail/i.test(id)) {
      // 失敗例: "owner/fail" でクローン失敗を再現
      const r = mkRepo(id, { status: 'cloning', defaultBranch: '', createdAt: Date.now(), poolMin: b.poolMin ?? 3 });
      repos[id] = r;
      upsertRepo(r);
      setTimeout(() => {
        r.status = 'error';
        r.error = 'gh repo clone に失敗しました: Could not resolve to a Repository';
        upsertRepo(r);
      }, 3000);
      return json(res, 200, { ok: true, repo: r });
    }
    const r = mkRepo(id, { status: 'cloning', defaultBranch: '', createdAt: Date.now(), poolMin: b.poolMin ?? 3, trusted: true });
    repos[id] = r;
    upsertRepo(r);
    void cloneRepo(r, 5000);
    return json(res, 200, { ok: true, repo: r });
  }
  const rm = p.match(/^\/api\/repos\/([^/]+)(\/refill)?$/);
  if (rm) {
    const r = repos[decodeURIComponent(rm[1])];
    if (!r) return json(res, 404, { ok: false, error: 'repo not found' });
    if (rm[2] && req.method === 'POST') {
      if (r.status !== 'ready') return json(res, 409, { ok: false, error: 'クローンが完了していません' });
      const n = refill(r);
      return json(res, 200, { ok: true, created: n });
    }
    if (req.method === 'PATCH') {
      const b = await readBody(req).catch(() => ({}));
      for (const k of ['poolMin', 'poolMax', 'installCmd', 'keepDirs', 'seedLibraryFrom', 'trusted']) if (k in b) r[k] = b[k];
      upsertRepo(r);
      refill(r);
      return json(res, 200, { ok: true, repo: r });
    }
    if (req.method === 'DELETE') {
      const wts = repoWts(r.id);
      if (wts.some((w) => w.state === 'assigned' || w.state === 'releasing'))
        return json(res, 409, { ok: false, error: '使用中の worktree があります' });
      for (const w of wts) {
        delete worktrees[w.id];
        broadcast('state', { t: 'worktree.remove', id: w.id });
      }
      delete repos[r.id];
      broadcast('state', { t: 'repo.remove', id: r.id });
      console.log('[repo delete]', r.id, 'purge=', url.searchParams.get('purge'));
      return json(res, 200, { ok: true });
    }
  }
  const wm = p.match(/^\/api\/worktrees\/([^/]+)(\/rebuild)?$/);
  if (wm) {
    const w = worktrees[decodeURIComponent(wm[1])];
    if (!w) return json(res, 404, { ok: false, error: 'worktree not found' });
    if (wm[2] && req.method === 'POST') {
      void warm(w);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (w.state !== 'idle' && w.state !== 'broken')
        return json(res, 409, { ok: false, error: `${w.name} は ${w.state} のため削除できません` });
      w.state = 'deleting';
      w.progress = 'git worktree remove';
      upsertWt(w);
      setTimeout(() => {
        delete worktrees[w.id];
        broadcast('state', { t: 'worktree.remove', id: w.id });
      }, 1500);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/sessions' && req.method === 'POST' && (await peekRepoStart(req, res))) return;
  if (p === '/api/sessions' && req.method === 'POST') {
    const b = req._body ?? (await readBody(req).catch(() => ({})));
    if (!b.cwd) return json(res, 400, { ok: false, error: 'cwd が必要です' });
    const s = mkSession({
      name: b.name || path.win32.basename(b.cwd),
      cwd: b.cwd,
      mode: b.mode || 'commander',
      status: 'starting',
      createdAt: Date.now(),
      contextPct: 0,
      costUsd: 0,
    });
    sessions[s.id] = s;
    termBuf[s.id] = `${C.dim}(mock) 起動: ${b.mode} ${b.resume ? '--resume ' + b.resume : ''} ${b.instruction ?? ''}${C.reset}\r\n`;
    upsertSession(s);
    setTimeout(() => {
      s.status = 'awaiting_input';
      upsertSession(s);
      termWrite(s.id, `${C.green}●${C.reset} 準備できました。\r\n> `);
    }, 1500);
    return json(res, 200, { ok: true, session: s });
  }
  const m = p.match(/^\/api\/sessions\/([^/]+)\/(input|resize|control|approve|rename|release)$/);
  if (m && req.method === 'POST') {
    const s = sessions[m[1]];
    if (!s) return json(res, 404, { ok: false, error: 'session not found' });
    const b = await readBody(req).catch(() => ({}));
    const act = m[2];
    if (act === 'input') {
      if (!s.managed) return json(res, 409, { ok: false, error: '読み取り専用です' });
      // マウスホイールシーケンスは表示だけ
      if (/^(\x1b\[<6[45];\d+;\d+M)+$/.test(b.data)) {
        termWrite(s.id, `${C.dim}[wheel ${b.data.includes('<64') ? 'up' : 'down'} ×${b.data.split('M').length - 1}]${C.reset}\r\n`);
      } else {
        const shown = String(b.data).replace(/\r/g, '\r\n').replace(/\x1b/g, '^[').replace(/\x03/g, '^C');
        termWrite(s.id, b.submit ? `${C.cyan}> ${shown}${C.reset}\r\n` : shown);
      }
      if (b.submit) {
        s.status = 'running';
        s.currentTool = { name: 'Thinking', target: '', since: Date.now() };
        upsertSession(s);
        setTimeout(() => {
          termWrite(s.id, `${C.green}●${C.reset} 「${b.data}」を受け取りました(mock)。\r\n`);
          s.status = 'awaiting_input';
          s.currentTool = null;
          s.lastMessage = `「${b.data}」を受け取りました(mock)。`;
          upsertSession(s);
          notify('input', s, `${s.name}: 入力待ち`, s.lastMessage);
        }, 1200);
      }
      return json(res, 200, { ok: true });
    }
    if (act === 'resize') {
      console.log('[resize]', s.name, b.cols, b.rows);
      s.cols = b.cols | 0;
      s.rows = b.rows | 0;
      broadcast(`term:${s.id}`, { t: 'term.resize', sid: s.id, cols: s.cols, rows: s.rows });
      upsertSession(s);
      return json(res, 200, { ok: true });
    }
    if (act === 'control') {
      if (b.action === 'stop') {
        s.status = 'stopped';
        s.exitCode = 0;
        s.currentTool = null;
        s.approval = null;
        upsertSession(s);
      } else if (b.action === 'restart') {
        s.status = 'starting';
        s.exitCode = null;
        upsertSession(s);
        termWrite(s.id, `\r\n${C.yellow}--- 再起動 ---${C.reset}\r\n`);
        setTimeout(() => {
          s.status = 'awaiting_input';
          upsertSession(s);
        }, 1000);
      } else if (b.action === 'remove') {
        const w = s.worktreeId && worktrees[s.worktreeId];
        if (w && w.sessionId === s.id && (w.state === 'assigned' || w.state === 'releasing'))
          return json(res, 409, { ok: false, error: `${w.name} がまだ割り当てられています。先に解放してください` });
        delete sessions[s.id];
        for (const a of Object.values(agents)) if (a.sessionId === s.id) delete agents[a.agentId];
        broadcast('state', { t: 'session.remove', id: s.id });
      }
      return json(res, 200, { ok: true });
    }
    if (act === 'approve') {
      if (!s.approval) return json(res, 409, { ok: false, error: '承認待ちではありません' });
      termWrite(s.id, `${C.dim}(承認: ${b.option})${C.reset}\r\n`);
      s.approval = null;
      s.status = 'running';
      s.currentTool = { name: 'Bash', target: 'npm test -- --watch=false', since: Date.now() };
      upsertSession(s);
      // しばらくしたら再び承認待ちにする(繰り返し確認できるように)
      setTimeout(() => {
        if (!sessions[s.id]) return;
        s.status = 'awaiting_approval';
        s.currentTool = null;
        s.approval = {
          type: 'yn',
          question: 'src/auth/login.ts を上書きしますか?',
          options: [],
        };
        upsertSession(s);
        notify('approval', s, `${s.name}: 承認待ち`, s.approval.question);
      }, 15000);
      return json(res, 200, { ok: true });
    }
    if (act === 'release') {
      const w = s.worktreeId && worktrees[s.worktreeId];
      if (!w || w.sessionId !== s.id || w.state !== 'assigned')
        return json(res, 409, { ok: false, error: 'このセッションに割り当てられた worktree はありません' });
      if (s.status !== 'stopped' && s.status !== 'error')
        return json(res, 409, { ok: false, error: 'セッションが実行中です' });
      w.state = 'releasing';
      w.progress = b.mode === 'discard' ? `git branch -D ${w.branch} / reset / clean` : 'git reset / clean';
      upsertWt(w);
      setTimeout(() => {
        w.state = 'idle';
        w.branch = null;
        w.sessionId = null;
        w.progress = null;
        w.lastUsedAt = Date.now();
        upsertWt(w);
      }, 2500);
      return json(res, 200, { ok: true });
    }
    if (act === 'rename') {
      s.name = String(b.name || s.name);
      upsertSession(s);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/game/windows')
    return json(res, 200, {
      ok: true,
      windows: [
        { hwnd: 1001, title: 'Unity 6 - TomsLands - Main.unity' },
        { hwnd: 1002, title: 'メモ帳' },
      ],
    });
  if (p === '/game/stream') {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ccrframe', 'Cache-Control': 'no-cache' });
    const frame = () => {
      res.write(`--ccrframe\r\nContent-Type: image/png\r\nContent-Length: ${ICON.length}\r\n\r\n`);
      res.write(ICON);
      res.write('\r\n');
    };
    frame();
    const t = setInterval(frame, 1000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/game/input' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    console.log('[game/input]', JSON.stringify(b));
    return json(res, 200, { ok: true });
  }
  json(res, 404, { ok: false, error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws') || !authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { ws, topics: new Set() };
    clients.add(c);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'ping') return send(c, { t: 'pong' });
      if (msg.t === 'sub') {
        for (const t of msg.topics) {
          c.topics.add(t);
          if (t === 'state') send(c, { t: 'state.full', state: fullState() });
          else if (t.startsWith('term:')) {
            const sid = t.slice(5);
            const s = sessions[sid];
            if (s) send(c, { t: 'term.snapshot', sid, data: termBuf[sid] || '', cols: s.cols, rows: s.rows });
          }
        }
      }
      if (msg.t === 'unsub') for (const t of msg.topics) c.topics.delete(t);
    });
    ws.on('close', () => clients.delete(c));
  });
});

// ---------------------------------------------------------------- 定期更新(疑似アクティビティ)
const TOOLS = [
  ['Read', 'src/shop/ShopService.ts'],
  ['Grep', 'purchaseItem'],
  ['Edit', 'src/shop/Cart.ts'],
  ['Bash', 'npm run typecheck'],
  ['Glob', 'src/**/*.test.ts'],
];
let tick = 0;
setInterval(() => {
  tick++;
  const [name, target] = TOOLS[tick % TOOLS.length];
  // s2: ツールとターミナル出力
  if (sessions[s2.id] && s2.status === 'running') {
    s2.currentTool = { name, target, since: Date.now() };
    s2.contextPct = Math.min(99, (s2.contextPct ?? 0) + 0.5);
    s2.costUsd = +(s2.costUsd + 0.01).toFixed(2);
    upsertSession(s2);
    termWrite(s2.id, `${C.green}●${C.reset} ${C.bold}${name}${C.reset}(${C.cyan}${target}${C.reset})\r\n  ${C.dim}⎿  ${tick} 行を処理${C.reset}\r\n`);
  }
  // エージェントのツール更新
  for (const a of [aImpl, aImplSub, aImplSub2, aTest]) {
    if (!agents[a.agentId] || a.status !== 'running') continue;
    const [n2, t2] = TOOLS[(tick + a.depth) % TOOLS.length];
    a.currentTool = { name: n2, target: t2, since: Date.now() };
    broadcast('state', { t: 'agent.upsert', agent: a });
  }
  // 外部セッション
  if (sessions[s3.id]) {
    s3.currentTool = { name: tick % 2 ? 'Edit' : 'Read', target: 'docs/design.md', since: Date.now() };
    upsertSession(s3);
  }
  // 使用量
  usage = { ...usage, fiveHour: { ...usage.fiveHour, pct: Math.min(100, usage.fiveHour.pct + 0.2) }, updatedAt: Date.now() };
  broadcast('state', { t: 'usage', usage });
  // 20 秒ごとに深いエージェントを完了 → 新しく起動
  if (tick % 10 === 0) {
    if (aImplSub2.status === 'running') {
      aImplSub2.status = 'done';
      aImplSub2.endedAt = Date.now();
      aImplSub2.currentTool = null;
    } else {
      aImplSub2.status = 'running';
      aImplSub2.startedAt = Date.now();
      aImplSub2.endedAt = null;
    }
    broadcast('state', { t: 'agent.upsert', agent: aImplSub2 });
  }
}, 2000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CC Hub mock: http://127.0.0.1:${PORT}  (PIN: ${PIN})`);
});

/** POST /api/sessions で repoId があればプールから割り当てて起動する。処理したら true */
async function peekRepoStart(req, res) {
  const b = await readBody(req).catch(() => ({}));
  req._body = b;
  if (!b.repoId) return false;
  const repo = repos[b.repoId];
  if (!repo) {
    json(res, 404, { ok: false, error: `リポジトリ ${b.repoId} は登録されていません` });
    return true;
  }
  if (repo.status !== 'ready') {
    json(res, 409, { ok: false, error: `${repo.name} はまだ利用できません(${repo.status})` });
    return true;
  }
  const slug = String(b.branchSlug || slugOf(b.instruction || 'work'));
  const branch = `feat/${slug}`;
  let w = repoWts(repo.id).find((x) => x.state === 'idle');
  const fresh = !w;
  if (!w) {
    if (repoWts(repo.id).length >= repo.poolMax) {
      json(res, 409, { ok: false, error: `worktree が上限(${repo.poolMax})に達しています` });
      return true;
    }
    w = mkWt(repo, nextWtNo(repo), { state: 'creating' });
    worktrees[w.id] = w;
  }
  const s = mkSession({
    name: b.name || slug,
    cwd: w.path,
    mode: b.mode || 'commander',
    status: 'starting',
    createdAt: Date.now(),
    contextPct: 0,
    costUsd: 0,
    repoId: repo.id,
    worktreeId: w.id,
    branch,
  });
  sessions[s.id] = s;
  termBuf[s.id] = `${C.dim}(mock) ${w.name} に ${branch} を作成して起動: ${b.mode} ${b.instruction ?? ''}${C.reset}\r\n`;
  upsertSession(s);
  const assign = () => {
    w.state = 'assigned';
    w.branch = branch;
    w.sessionId = s.id;
    w.lastUsedAt = Date.now();
    w.progress = null;
    upsertWt(w);
    setTimeout(() => {
      s.status = 'awaiting_input';
      upsertSession(s);
      termWrite(s.id, `${C.green}●${C.reset} ${branch} で準備できました。\r\n> `);
    }, 1500);
    // 待機が減ったので補充
    setTimeout(() => refill(repo), 500);
  };
  if (fresh) void warm(w, assign);
  else assign();
  json(res, 200, { ok: true, session: s });
  return true;
}
