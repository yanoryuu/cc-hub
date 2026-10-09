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

const s1 = mkSession({
  name: 'login-fix',
  cwd: 'C:\\wt\\TomsLands\\wt-01',
  status: 'awaiting_approval',
  branch: 'feat/login-fix',
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
  cwd: 'C:\\wt\\TomsLands\\wt-02',
  status: 'running',
  branch: 'feat/shop-refactor',
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
for (const s of [s1, s2, s3]) sessions[s.id] = s;

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
for (const s of [s1, s2]) {
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
  return { sessions, agents, usage, daemon: { version: '0.0.0-mock', startedAt: now, port: PORT } };
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
  if (p === '/api/sessions' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
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
  const m = p.match(/^\/api\/sessions\/([^/]+)\/(input|resize|control|approve|rename)$/);
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
