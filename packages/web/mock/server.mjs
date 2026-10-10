// CC Hub デーモンのモック(開発・動作確認用)。契約は packages/shared/src/index.ts に準拠。
//   node packages/web/mock/server.mjs        → http://127.0.0.1:7862 (PIN: 1234)
//   HUB_TARGET=http://127.0.0.1:7862 npm run dev -w @cc-hub/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createProjectMock } from './project.mjs';
import { createHistoryMock } from './history.mjs';
import { createOpsMock } from './ops.mjs';

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
    handedOff: false,
    task: null,
    tokens: null,
    ...p,
  };
}
/** トークン使用量(mock) */
function mkTokens(input, output, cacheRead, cacheCreation) {
  return { input, output, cacheRead, cacheCreation, updatedAt: Date.now() };
}

const sessions = {};
const agents = {};
const termBuf = {};

const REPO_WEB = 'coly-dev/shop-web';
const REPO_UNITY = 'coly-dev/TomsLands';
const REPO_CLONING = 'ryuichi-yano/cc-remote';

const s1 = mkSession({
  name: 'login-fix',
  cwd: 'D:\\WorkTree\\shop-web\\wt-01',
  status: 'awaiting_approval',
  branch: 'feat/login-fix',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-01`,
  contextPct: 48,
  costUsd: 1.23,
  task: 'ログイン後に常にトップへ飛ばされる不具合を直して。?next= で元のページに戻すようにし、オープンリダイレクトにならないよう検証も入れて',
  tokens: mkTokens(182_400, 21_350, 1_240_000, 96_000),
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
  cwd: 'D:\\WorkTree\\shop-web\\wt-02',
  status: 'running',
  branch: 'feat/shop-refactor',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-02`,
  contextPct: 72,
  costUsd: 3.87,
  task: 'ShopService が肥大化しているので責務ごと(在庫・価格・カート)に分割して。既存のテストが通る状態を保つこと',
  tokens: mkTokens(412_800, 58_900, 3_820_000, 214_000),
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
  task: '設計書(docs/design.md)を最新の実装に合わせて更新して',
  tokens: mkTokens(64_200, 9_800, 420_000, 31_000),
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
  cwd: 'D:\\WorkTree\\shop-web\\wt-03',
  status: 'stopped',
  exitCode: 0,
  branch: 'feat/cart-badge-count',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-03`,
  contextPct: 35,
  costUsd: 0.88,
  task: 'ヘッダーのカートアイコンに商品数のバッジを表示して(0 件なら非表示)',
  tokens: mkTokens(98_100, 12_400, 610_000, 44_000),
  createdAt: now - 90 * MIN,
  lastMessage: 'カートのバッジに件数を表示するようにしました。テストも追加済みです。',
});
// 入力待ち・コミットあり・PR なし(「PR を作成」の確認用)
const s5 = mkSession({
  name: 'search-box',
  cwd: 'D:\\WorkTree\\shop-web\\wt-04',
  status: 'awaiting_input',
  branch: 'feat/search-box',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-04`,
  contextPct: 22,
  costUsd: 0.61,
  task: '商品一覧の上に検索ボックスを追加。入力から 300ms で絞り込み、該当なしのときは案内を出す',
  tokens: mkTokens(71_500, 10_200, 380_000, 27_500),
  createdAt: now - 20 * MIN,
  lastMessage: '検索ボックスを追加しました。PR を作りますか?',
});
// PowerShell に移したセッション(handedOff。worktree は保持したまま)
const s6 = mkSession({
  name: 'checkout-flow',
  cwd: 'D:\\WorkTree\\shop-web\\wt-08',
  managed: false,
  handedOff: true,
  status: 'awaiting_input',
  branch: 'feat/checkout-flow',
  repoId: REPO_WEB,
  worktreeId: `${REPO_WEB}#wt-08`,
  contextPct: 41,
  costUsd: 1.02,
  task: '決済画面の入力チェック(カード番号・有効期限・郵便番号)を追加',
  tokens: mkTokens(120_300, 15_600, 720_000, 51_000),
  createdAt: now - 50 * MIN,
  lastEventAt: now - 8 * MIN,
  lastMessage: '決済画面の入力チェックを追加しました。PowerShell 側で手動確認中です。',
  cols: 0,
  rows: 0,
});
// 何日も前に外部で起動されたまま止まっている古いセッション(起動時にここへ飛ばないことの確認用)
const s7 = mkSession({
  name: 'csv-script',
  cwd: 'C:\\Users\\yanor\\old-tool',
  managed: false,
  status: 'idle',
  mode: 'plain',
  contextPct: 12,
  costUsd: 0.08,
  task: 'CSV を読み込んで集計する小さなスクリプト',
  tokens: mkTokens(12_400, 2_100, 40_000, 6_000),
  model: 'claude-sonnet-4-5',
  createdAt: now - 4 * 24 * 60 * MIN,
  lastEventAt: now - 3 * 24 * 60 * MIN,
  lastMessage: '集計スクリプトを作成しました。',
  cols: 0,
  rows: 0,
});
// 未登録リポジトリの worktree で動くセッション(ホームでは legacy-admin フォルダにまとまる)
const s8 = mkSession({
  name: 'csv-export',
  cwd: 'D:\\WorkTree\\legacy-admin\\wt-02',
  status: 'running',
  branch: 'fix/csv-export',
  contextPct: 30,
  costUsd: 0.4,
  task: 'CSV エクスポートの文字化け(Shift_JIS)を直して',
  tokens: mkTokens(54_000, 7_200, 210_000, 18_000),
  currentTool: { name: 'Edit', target: 'src/export.ts', since: now - 30_000 },
});
for (const s of [s1, s2, s3, s4, s5, s6, s7, s8]) sessions[s.id] = s;

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
    baseDir: `D:\\WorkTree\\${name}`,
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
  baseDir: 'D:\\WorkTree\\TomsLands',
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
  mkWt(rWeb, 4, { state: 'assigned', branch: s5.branch, sessionId: s5.id, lastUsedAt: now - 20 * MIN }),
  mkWt(rWeb, 8, { state: 'assigned', branch: s6.branch, sessionId: s6.id, lastUsedAt: now - 50 * MIN }),
  mkWt(rWeb, 7, { state: 'idle', lastUsedAt: now - 300 * MIN }),
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
for (const s of [s1, s2, s4, s5]) {
  termBuf[s.id] =
    `${C.mag}╭───────────────────────────────────────────╮${C.reset}\r\n` +
    `${C.mag}│${C.reset} ${C.bold}✻ Claude Code${C.reset} (mock)                        ${C.mag}│${C.reset}\r\n` +
    `${C.mag}│${C.reset}   cwd: ${s.cwd.padEnd(34)}${C.mag}│${C.reset}\r\n` +
    `${C.mag}╰───────────────────────────────────────────╯${C.reset}\r\n\r\n` +
    `${C.dim}> /commander ${s.name} を進めて${C.reset}\r\n\r\n` +
    `${C.green}●${C.reset} 了解しました。まず関連ファイルを調べます。\r\n`;
}
termBuf[s1.id] += `\r\n${C.yellow}╭─ Bash command ─────────────────────────────╮${C.reset}\r\n  npm test -- --watch=false\r\n\r\n  Do you want to proceed?\r\n  ${C.cyan}❯ 1. Yes${C.reset}\r\n    2. Yes, and don't ask again\r\n    3. No (esc)\r\n${C.yellow}╰────────────────────────────────────────────╯${C.reset}\r\n`;


// ---------------------------------------------------------------- フェーズ 3: PR / ブランチ
const prs = {};
const prDetails = {};
let prSeq = 52;
function mkPr(repoId, number, p) {
  return {
    id: `${repoId}#${number}`,
    repoId,
    number,
    title: '',
    url: `https://github.com/${repoId}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: '',
    baseRefName: 'main',
    author: 'ryuichi-yano',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: 'success',
    checksSummary: { passed: 6, failed: 0, pending: 0 },
    commentCount: 0,
    updatedAt: now - 10 * MIN,
    mine: true,
    reviewRequested: false,
    sessionId: null,
    worktreeId: null,
    ...p,
  };
}
const pr42 = mkPr(REPO_WEB, 42, {
  title: 'ログイン後のリダイレクト先を元のページに戻す',
  headRefName: s1.branch,
  reviewDecision: 'CHANGES_REQUESTED',
  checks: 'failure',
  checksSummary: { passed: 4, failed: 2, pending: 0 },
  commentCount: 4,
  updatedAt: now - 25 * MIN,
  sessionId: s1.id,
  worktreeId: `${REPO_WEB}#wt-01`,
});
const pr38 = mkPr(REPO_WEB, 38, {
  title: 'カートのバッジに商品数を表示',
  headRefName: s4.branch,
  reviewDecision: 'APPROVED',
  commentCount: 1,
  updatedAt: now - 70 * MIN,
  sessionId: s4.id,
  worktreeId: `${REPO_WEB}#wt-03`,
});
const pr45 = mkPr(REPO_WEB, 45, {
  title: 'ShopService を責務ごとに分割(WIP)',
  headRefName: s2.branch,
  isDraft: true,
  checks: 'pending',
  checksSummary: { passed: 3, failed: 0, pending: 3 },
  updatedAt: now - 5 * MIN,
  sessionId: s2.id,
  worktreeId: `${REPO_WEB}#wt-02`,
});
const pr51 = mkPr(REPO_UNITY, 51, {
  title: 'インベントリにレア度順の並び替えを追加',
  headRefName: 'feat/inventory-sort',
  author: 'tanaka-k',
  mine: false,
  reviewRequested: true,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'CONFLICTING',
  commentCount: 2,
  updatedAt: now - 3 * 60 * MIN,
});
const pr36 = mkPr(REPO_WEB, 36, {
  title: 'ヘッダーのロゴを SVG に差し替え',
  headRefName: 'feat/header-logo',
  state: 'MERGED',
  reviewDecision: 'APPROVED',
  updatedAt: now - 5 * 60 * MIN,
});
const pr33 = mkPr(REPO_WEB, 33, {
  title: '決済 SDK の試験導入',
  headRefName: 'feat/payment-sdk-trial',
  state: 'CLOSED',
  checks: 'failure',
  checksSummary: { passed: 2, failed: 1, pending: 0 },
  updatedAt: now - 2 * 24 * 60 * MIN,
});
for (const p of [pr42, pr38, pr45, pr51, pr36, pr33]) prs[p.id] = p;

prDetails[pr42.id] = {
  body:
    'ログイン後に常にトップへ飛ばされていたのを、元のページ(?next=)に戻すようにしました。\n\n' +
    '## 変更点\n- `?next=` を検証してから遷移(オープンリダイレクト対策)\n- 期限切れセッションでも next を引き継ぐ\n\n' +
    '## 確認\n- [x] 単体テスト\n- [ ] E2E\n\n' +
    '(HTML がそのまま表示されることの確認: <script>alert("x")</script> <b>太字にならない</b>)',
  reviews: [
    {
      author: 'tanaka-k',
      state: 'CHANGES_REQUESTED',
      body: 'next の検証が甘いです。`//evil.example.com` のようなプロトコル相対 URL も弾いてください。',
      submittedAt: now - 40 * MIN,
    },
  ],
  comments: [
    {
      author: 'tanaka-k',
      body: 'ここは startsWith("/") だけだと "//evil.example.com" を通してしまいます。',
      createdAt: now - 41 * MIN,
      path: 'src/auth/redirect.ts',
      line: 18,
      url: `https://github.com/${REPO_WEB}/pull/42#discussion_r1`,
    },
    {
      author: 'tanaka-k',
      body: 'テストケースに "/\\\\evil" も追加をお願いします。',
      createdAt: now - 40 * MIN,
      path: 'test/auth/redirect.test.ts',
      line: 52,
      url: `https://github.com/${REPO_WEB}/pull/42#discussion_r2`,
    },
    {
      author: 'suzuki-m',
      body: 'E2E は CI の preview 環境で確認できます。\nログは Actions の artifacts にあります。',
      createdAt: now - 30 * MIN,
    },
  ],
  files: [
    { path: 'src/auth/redirect.ts', additions: 42, deletions: 9 },
    { path: 'src/auth/login.ts', additions: 18, deletions: 12 },
    { path: 'src/pages/LoginPage.tsx', additions: 7, deletions: 3 },
    { path: 'test/auth/redirect.test.ts', additions: 53, deletions: 0 },
  ],
  failedChecks: [
    { name: 'test (ubuntu-latest, node 20)', url: `https://github.com/${REPO_WEB}/actions/runs/9001`, runId: 9001 },
    { name: 'e2e / chromium', url: `https://github.com/${REPO_WEB}/actions/runs/9002`, runId: 9002 },
  ],
};
prDetails[pr38.id] = {
  body: 'ヘッダーのカートアイコンに件数バッジを表示します。0 件のときは非表示。',
  reviews: [{ author: 'suzuki-m', state: 'APPROVED', body: 'LGTM 👍', submittedAt: now - 75 * MIN }],
  comments: [],
  files: [
    { path: 'src/components/CartBadge.tsx', additions: 31, deletions: 0 },
    { path: 'src/components/Header.tsx', additions: 4, deletions: 1 },
  ],
  failedChecks: [],
};
prDetails[pr51.id] = {
  body: 'インベントリ画面にレア度順・入手順の並び替えを追加しました。\nレビューをお願いします。',
  reviews: [],
  comments: [
    { author: 'tanaka-k', body: '@ryuichi-yano UI の文言も見てもらえると助かります', createdAt: now - 3 * 60 * MIN },
    { author: 'github-actions', body: 'Unity のビルドサイズ: +0.2 MB', createdAt: now - 3 * 60 * MIN + 60000 },
  ],
  files: [
    { path: 'Assets/Scripts/UI/InventoryView.cs', additions: 88, deletions: 14 },
    { path: 'Assets/Scripts/Items/ItemSort.cs', additions: 61, deletions: 0 },
  ],
  failedChecks: [],
};
function prDetailOf(pr) {
  const d = prDetails[pr.id] ?? {
    body: `${pr.title}\n\n(mock の説明文)`,
    reviews: [],
    comments: [],
    files: [{ path: 'src/index.ts', additions: 12, deletions: 3 }],
    failedChecks: [],
  };
  return {
    ...pr,
    ...d,
    failedChecks:
      pr.checks === 'failure'
        ? d.failedChecks.length
          ? d.failedChecks
          : [{ name: 'build', url: `${pr.url}/checks`, runId: null }]
        : [],
  };
}
function upsertPr(pr) {
  broadcast('state', { t: 'pr.upsert', pr });
}
function notifyPr(pr, title, body) {
  broadcast('state', {
    t: 'notify',
    event: { kind: 'pr', sessionId: pr.sessionId ?? pr.id, title: `${title}: ${pr.repoId}#${pr.number}`, body: body ?? pr.title, ts: Date.now() },
  });
}
function setChecks(pr, checks) {
  pr.checks = checks;
  pr.checksSummary =
    checks === 'success'
      ? { passed: 6, failed: 0, pending: 0 }
      : checks === 'failure'
        ? { passed: 5, failed: 1, pending: 0 }
        : { passed: 2, failed: 0, pending: 4 };
  pr.updatedAt = Date.now();
  upsertPr(pr);
  if (checks === 'success') notifyPr(pr, 'CI 成功');
  if (checks === 'failure') notifyPr(pr, 'CI 失敗');
}

// worktree の変更状況(assigned のもの)
function mkGit(p) {
  return { changed: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, unpushed: 0, pushed: false, updatedAt: Date.now(), ...p };
}
worktrees[`${REPO_WEB}#wt-01`].git = mkGit({ changed: 3, insertions: 120, deletions: 34, ahead: 4, behind: 2, unpushed: 1, pushed: true });
worktrees[`${REPO_WEB}#wt-02`].git = mkGit({ changed: 7, insertions: 310, deletions: 188, ahead: 2, behind: 0, unpushed: 2, pushed: true });
worktrees[`${REPO_WEB}#wt-04`].git = mkGit({ changed: 1, insertions: 64, deletions: 5, ahead: 2, behind: 1, unpushed: 2, pushed: false });
worktrees[`${REPO_WEB}#wt-03`].git = mkGit({ changed: 0, insertions: 35, deletions: 1, ahead: 3, behind: 0, unpushed: 0, pushed: true });
worktrees[`${REPO_WEB}#wt-08`].git = mkGit({ changed: 2, insertions: 88, deletions: 12, ahead: 1, behind: 0, unpushed: 1, pushed: false });

// ブランチ一覧(固定の追加分 + 使用中の worktree のブランチ)
const deletedBranches = new Set(); // "<repoId>|<name>"
const EXTRA_BRANCHES = {
  [REPO_WEB]: [
    { name: 'feat/header-logo', isLocal: true, hasRemote: false, ahead: 0, behind: 5, unpushed: 0, merged: true, prNumber: 36, subject: 'ヘッダーのロゴを SVG に', author: 'ryuichi-yano', ago: 6 * 60 },
    { name: 'fix/typo-readme', isLocal: true, hasRemote: true, ahead: 0, behind: 12, unpushed: 0, merged: true, prNumber: null, subject: 'README の誤字を修正', author: 'ryuichi-yano', ago: 3 * 24 * 60 },
    { name: 'chore/deps-bump', isLocal: true, hasRemote: false, ahead: 0, behind: 8, unpushed: 0, merged: true, prNumber: null, subject: 'chore: 依存を更新', author: 'dependabot', ago: 5 * 24 * 60 },
    { name: 'feat/old-experiment', isLocal: true, hasRemote: false, ahead: 3, behind: 23, unpushed: 3, merged: false, prNumber: null, subject: 'WIP: キャッシュ層の試作', author: 'ryuichi-yano', ago: 12 * 24 * 60 },
    { name: 'feat/payment-sdk-trial', isLocal: false, hasRemote: true, ahead: 2, behind: 30, unpushed: 0, merged: false, prNumber: 33, subject: '決済 SDK を試験導入', author: 'ryuichi-yano', ago: 2 * 24 * 60 },
  ],
  [REPO_UNITY]: [
    { name: 'feat/inventory-sort', isLocal: false, hasRemote: true, ahead: 6, behind: 4, unpushed: 0, merged: false, prNumber: 51, subject: 'レア度順の並び替え', author: 'tanaka-k', ago: 3 * 60 },
    { name: 'fix/crash-on-load', isLocal: true, hasRemote: true, ahead: 0, behind: 2, unpushed: 0, merged: true, prNumber: null, subject: 'ロード時のクラッシュを修正', author: 'ryuichi-yano', ago: 4 * 24 * 60 },
  ],
};
function branchList(repo) {
  const out = [];
  const base = {
    repoId: repo.id,
    name: repo.defaultBranch || 'main',
    isLocal: true,
    hasRemote: true,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    lastCommit: { sha: 'a1b2c3d', subject: 'Merge pull request #36 from feat/header-logo', author: 'ryuichi-yano', date: now - 5 * 60 * MIN },
    merged: false,
    worktreeId: null,
    sessionId: null,
    prNumber: null,
  };
  out.push(base);
  for (const w of repoWts(repo.id)) {
    if (w.state !== 'assigned' || !w.branch) continue;
    const g = w.git ?? mkGit({});
    const pr = Object.values(prs).find((p) => p.repoId === repo.id && p.headRefName === w.branch);
    out.push({
      repoId: repo.id,
      name: w.branch,
      isLocal: true,
      hasRemote: g.pushed,
      ahead: g.ahead,
      behind: g.behind,
      unpushed: g.unpushed,
      lastCommit: { sha: crypto.randomBytes(4).toString('hex'), subject: `${w.branch.replace(/^feat\//, '')} の作業`, author: 'Claude', date: g.updatedAt - 3 * MIN },
      merged: false,
      worktreeId: w.id,
      sessionId: w.sessionId,
      prNumber: pr ? pr.number : null,
    });
  }
  for (const b of EXTRA_BRANCHES[repo.id] ?? []) {
    if (deletedBranches.has(`${repo.id}|${b.name}`)) continue;
    if (out.some((x) => x.name === b.name)) continue;
    out.push({
      repoId: repo.id,
      name: b.name,
      isLocal: b.isLocal,
      hasRemote: b.hasRemote,
      ahead: b.ahead,
      behind: b.behind,
      unpushed: b.unpushed,
      lastCommit: { sha: crypto.randomBytes(4).toString('hex'), subject: b.subject, author: b.author, date: now - b.ago * MIN },
      merged: b.merged,
      worktreeId: null,
      sessionId: null,
      prNumber: b.prNumber,
    });
  }
  return out;
}

// ---------------------------------------------------------------- スキル / MCP(モックのデータ)
const HOME = 'C:\\Users\\yanor';
function sk(name, description, source, p = {}) {
  const kind = p.kind || 'skill';
  const plugin = p.plugin;
  const base =
    source === 'plugin'
      ? `${HOME}\\.claude\\plugins\\cache\\${plugin}\\${kind === 'skill' ? 'skills' : 'commands'}`
      : source === 'project'
        ? `${p.cwd || 'C:\\proj'}\\.claude\\${kind === 'skill' ? 'skills' : 'commands'}`
        : `${HOME}\\.claude\\${kind === 'skill' ? 'skills' : 'commands'}`;
  const bare = name.includes(':') ? name.split(':')[1] : name;
  return {
    name,
    description,
    source,
    kind,
    ...(plugin ? { plugin } : {}),
    path: kind === 'skill' ? `${base}\\${bare}\\SKILL.md` : `${base}\\${bare}.md`,
  };
}
function skillsFor(cwd) {
  const list = [
    sk('hub-commander', '任意リポジトリ向けの司令官モード。複数タスクを分解し、難易度で opus/sonnet/haiku に振り分けて並列実行する', 'user'),
    sk('cc-remote-recover', 'CC Remote / CC Hub に接続できない時の診断と復旧', 'user'),
    sk('claude-auto-resume', 'トークン上限に達したら次のリセットまで待機して claude -c で再開しつづける', 'user'),
    sk('design-flow', 'UI をゼロから作るときに、デザイン系スキルを「固める → 作る → 見直す」の順で回す', 'user'),
    sk('pbakaus-critique', 'UX スコアリング・ペルソナチェックでデザイン品質を評価する', 'user'),
    sk('web-design-guidelines', 'UI コードを Web Interface Guidelines に照らしてレビューする', 'user'),
    sk('review-pr', '開いている PR の差分を読んで、指摘をまとめる', 'user', { kind: 'command' }),
    sk('standup', '今日やったことを git log からまとめる', 'user', { kind: 'command' }),
    sk('unity:ui-ugui', 'Unity uGUI(Canvas)の UI を理解・編集・生成する', 'plugin', { plugin: 'unity' }),
    sk('unity:ui-uitk', 'Unity UI Toolkit(UXML / USS)の UI を作る', 'plugin', { plugin: 'unity' }),
    sk('unity:localization', 'Unity Localization の設定(ロケール・テーブル・CJK フォント)', 'plugin', { plugin: 'unity' }),
    sk('unity:urp-postprocessing', 'URP のポストプロセス(Bloom / Tonemapping など)を設定する', 'plugin', { plugin: 'unity' }),
    sk('unity:2d-pixel-perfect', 'ピクセルパーフェクトな 2D 描画を設定・修正する', 'plugin', { plugin: 'unity' }),
    sk('unity:build-live-game', 'Unity Services でライブゲーム(リーダーボード・クラウドセーブ等)を作る', 'plugin', { plugin: 'unity' }),
    sk('unity:unity-cli', 'Unity CLI でエディタの操作・プロジェクト作成・ビルドを行う', 'plugin', { plugin: 'unity', kind: 'command' }),
  ];
  // プロジェクトのスキル(cc-hub / shop-web の worktree)
  if (/cc-hub|shop-web|WorkTree/i.test(cwd)) {
    list.push(
      sk('commander', 'このリポジトリ用の司令官。タスクを分解してサブエージェントに振り、結果を検証して統合する', 'project', { cwd }),
      sk('release-notes', 'main との差分からリリースノートの下書きを作る', 'project', { cwd, kind: 'command' }),
      // 同名のユーザースキルより優先される(重複は UI 側で除く)
      sk('review-pr', 'このリポジトリのレビュー観点(セキュリティ / i18n)で PR を確認する', 'project', { cwd, kind: 'command' }),
    );
  }
  return list;
}

let mcpCheckedAt = 0;
let mcpRound = 0;
/** claude mcp list の実際の出力をもとにしたデータ。再確認のたびに 1 つ揺らす */
function mcpServers() {
  const c = (name, target, status, statusText) => ({
    name,
    target,
    status,
    statusText,
    origin: name.startsWith('claude.ai ') ? 'claude.ai' : 'local',
  });
  const NA = 'Needs authentication';
  return [
    c('claude.ai Claude Docs', 'https://docs.mcp.claude.ai/mcp', 'connected', 'Connected'),
    c('claude.ai Sentry', 'https://mcp.sentry.dev/mcp', 'needs_auth', NA),
    c('claude.ai Google Drive', 'https://drivemcp.googleapis.com/mcp/v1', 'connected', 'Connected'),
    c('claude.ai Gmail', 'https://gmail.mcp.claude.com/mcp', 'connected', 'Connected'),
    c('claude.ai Google Calendar', 'https://gcal.mcp.claude.com/mcp', 'connected', 'Connected'),
    c('claude.ai Notion', 'https://mcp.notion.com/mcp', 'connected', 'Connected'),
    c('claude.ai Slack', 'https://mcp.slack.com/mcp', 'needs_auth', NA),
    c('claude.ai Linear', 'https://mcp.linear.app/mcp', 'needs_auth', NA),
    c('claude.ai Figma', 'https://mcp.figma.com/mcp', 'needs_auth', NA),
    c('claude.ai Asana', 'https://mcp.asana.com/sse', 'needs_auth', NA),
    c('claude.ai Atlassian', 'https://mcp.atlassian.com/v1/sse', 'needs_auth', NA),
    c('claude.ai Box', 'https://mcp.box.com', 'needs_auth', NA),
    c('claude.ai Canva', 'https://mcp.canva.com/mcp', 'needs_auth', NA),
    c('claude.ai HubSpot', 'https://app.hubspot.com/mcp/v1/http', 'needs_auth', NA),
    c('cc-hub', 'http://127.0.0.1:7862/mcp (HTTP)', 'connected', 'Connected'),
    c('image-gen', 'node C:\\Users\\yanor\\mcp\\image-gen\\dist\\index.js', 'connected', 'Connected'),
    c('touchdesigner', 'npx -y touchdesigner-mcp-server@latest --stdio', 'connected', 'Connected'),
    c('unity-editor-mcp', 'node D:\\Unity\\Tools\\unity-editor-mcp\\build\\index.js', mcpRound % 2 ? 'connected' : 'connected', 'Connected'),
    c('playwright', 'npx @playwright/mcp@latest', mcpRound % 3 === 2 ? 'connected' : 'failed', mcpRound % 3 === 2 ? 'Connected' : 'Failed to connect'),
  ];
}

// ---------------------------------------------------------------- WS
const clients = new Set(); // { ws, topics:Set }
function send(c, msg) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}
function broadcast(topic, msg) {
  for (const c of clients) if (c.topics.has(topic)) send(c, msg);
}
function fullState() {
  return { sessions, agents, repos, worktrees, prs, servers: ops.servers, deploys: ops.deploys, usage, daemon: { version: '0.0.0-mock', startedAt: now, port: PORT } };
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
  // ---------------- フォルダ(プロジェクト)ごとの管理画面
  if (await ops.handle(req, res, url)) return;
  if (await project.handle(req, res, url)) return;
  if (p === '/api/projects')
    return json(res, 200, {
      ok: true,
      projects: [
        { path: 'C:\\Users\\yanor\\cc-hub', lastUsed: now - 5 * MIN },
        { path: 'D:\\WorkTree\\TomsLands\\.base', lastUsed: now - 60 * MIN },
        { path: 'D:\\WorkTree\\_test-p5\\wt-01', lastUsed: now - 90 * MIN }, // 検証用: ホームには出さない
        { path: 'D:\\AITEST\\p5-web', lastUsed: now - 100 * MIN }, // 検証用: ホームには出さない
        { path: 'C:\\Users\\yanor\\blog', lastUsed: now - 26 * 60 * MIN },
        { path: 'C:\\Users\\yanor\\cc-remote', lastUsed: now - 600 * MIN },
        { path: 'C:\\Users\\yanor\\sandbox\\react-try', lastUsed: now - 5 * 24 * 60 * MIN },
        { path: 'D:\\Unity\\Prototype2025', lastUsed: now - 9 * 24 * 60 * MIN },
      ],
    });
  // ---------------- 履歴 / フォルダブラウザ
  if (await history.handle(req, res, url)) return;
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
      task: b.instruction ? String(b.instruction).slice(0, 300) : null,
      tokens: mkTokens(0, 0, 0, 0),
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
        w.git = null;
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

  // ---------------- フェーズ 3: ブランチ / PR
  const bm = p.match(/^\/api\/repos\/([^/]+)\/branches(\/cleanup)?$/);
  if (bm) {
    const r = repos[decodeURIComponent(bm[1])];
    if (!r) return json(res, 404, { ok: false, error: 'repo not found' });
    if (r.status !== 'ready') return json(res, 409, { ok: false, error: 'クローンが完了していません' });
    if (!bm[2] && req.method === 'GET') {
      await sleep(700); // git fetch --prune のつもり
      return json(res, 200, { ok: true, branches: branchList(r) });
    }
    if (bm[2] && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const names = Array.isArray(b.names) ? b.names.map(String) : [];
      const list = branchList(r);
      for (const n of names) {
        const br = list.find((x) => x.name === n);
        if (!br) return json(res, 404, { ok: false, error: `${n} はありません` });
        if (br.worktreeId || br.sessionId) return json(res, 409, { ok: false, error: `${n} は使用中です` });
        if (!br.merged) return json(res, 409, { ok: false, error: `${n} はマージされていません` });
      }
      await sleep(500);
      for (const n of names) deletedBranches.add(`${r.id}|${n}`);
      console.log('[branches cleanup]', r.id, names);
      return json(res, 200, { ok: true, deleted: names });
    }
  }
  if (p === '/api/prs/refresh' && req.method === 'POST') {
    await sleep(600);
    return json(res, 200, { ok: true });
  }
  const pm = p.match(/^\/api\/prs\/([^/]+)\/(\d+)(?:\/(fix|open-session|merge|close))?$/);
  if (pm) {
    const pr = prs[`${decodeURIComponent(pm[1])}#${pm[2]}`];
    if (!pr) return json(res, 404, { ok: false, error: 'PR が見つかりません' });
    const act = pm[3];
    if (!act && req.method === 'GET') {
      await sleep(300);
      return json(res, 200, { ok: true, pr: prDetailOf(pr) });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const b = await readBody(req).catch(() => ({}));
    const repo = repos[pr.repoId];
    if (act === 'fix') {
      if (!b.comments && !b.checks) return json(res, 400, { ok: false, error: 'comments か checks を指定してください' });
      const what = b.checks ? 'CI の失敗ログ' : 'レビューコメント';
      const instruction = `PR #${pr.number} の${what}を直して${b.note ? `(補足: ${b.note})` : ''}`;
      let s = pr.sessionId && sessions[pr.sessionId];
      const live = s && s.managed && s.status !== 'stopped' && s.status !== 'error';
      if (!live) {
        const r2 = startOnBranch(repo, pr.headRefName, { mode: 'commander', instruction, name: `pr-${pr.number}-fix` });
        if (r2.error) return json(res, r2.code, { ok: false, error: r2.error });
        s = r2.session;
        pr.sessionId = s.id;
        pr.worktreeId = s.worktreeId;
        upsertPr(pr);
      } else {
        termWrite(s.id, `${C.cyan}> /commander ${instruction}${C.reset}\r\n`);
        s.status = 'running';
        s.currentTool = { name: 'Read', target: b.checks ? 'gh run view --log-failed' : 'レビューコメント', since: Date.now() };
        upsertSession(s);
        setTimeout(() => {
          if (!sessions[s.id]) return;
          s.status = 'awaiting_input';
          s.currentTool = null;
          s.lastMessage = `${what}に対応して push しました(mock)`;
          upsertSession(s);
          notify('input', s, `${s.name}: 入力待ち`, s.lastMessage);
        }, 6000);
      }
      if (b.checks) {
        setTimeout(() => setChecks(pr, 'pending'), 7000);
        setTimeout(() => {
          if (prDetails[pr.id]) prDetails[pr.id].failedChecks = [];
          setChecks(pr, 'success');
        }, 18000);
      }
      return json(res, 200, { ok: true, sessionId: s.id, session: s });
    }
    if (act === 'open-session') {
      const r2 = startOnBranch(repo, pr.headRefName, {
        mode: b.mode || 'commander',
        instruction: b.instruction || '',
        name: `pr-${pr.number}`,
      });
      if (r2.error) return json(res, r2.code, { ok: false, error: r2.error });
      pr.sessionId = r2.session.id;
      pr.worktreeId = r2.session.worktreeId;
      upsertPr(pr);
      return json(res, 200, { ok: true, session: r2.session });
    }
    if (act === 'merge') {
      if (pr.state !== 'OPEN') return json(res, 409, { ok: false, error: 'Open の PR ではありません' });
      if (pr.mergeable === 'CONFLICTING') return json(res, 409, { ok: false, error: 'コンフリクトがあるためマージできません。先に解消してください' });
      if (pr.isDraft) return json(res, 409, { ok: false, error: 'ドラフトの PR はマージできません' });
      await sleep(1200);
      console.log('[merge]', pr.id, b.method);
      pr.state = 'MERGED';
      pr.updatedAt = Date.now();
      upsertPr(pr);
      notifyPr(pr, 'マージ', `${pr.title}(${b.method || 'squash'})`);
      // 停止済みのセッションの worktree は解放する
      const w = pr.worktreeId && worktrees[pr.worktreeId];
      const s = pr.sessionId && sessions[pr.sessionId];
      if (w && w.state === 'assigned' && (!s || s.status === 'stopped' || s.status === 'error')) {
        w.state = 'releasing';
        w.progress = 'git reset / clean';
        upsertWt(w);
        setTimeout(() => {
          w.state = 'idle';
          w.branch = null;
          w.sessionId = null;
          w.progress = null;
          w.git = null;
          w.lastUsedAt = Date.now();
          upsertWt(w);
        }, 2500);
      }
      return json(res, 200, { ok: true });
    }
    if (act === 'close') {
      if (pr.state !== 'OPEN') return json(res, 409, { ok: false, error: 'Open の PR ではありません' });
      await sleep(500);
      pr.state = 'CLOSED';
      pr.updatedAt = Date.now();
      upsertPr(pr);
      return json(res, 200, { ok: true });
    }
  }
  // ---------------- 指示・PowerShell・スキル・MCP
  const hm = p.match(/^\/api\/sessions\/([^/]+)\/(open-terminal|takeover|attach)$/);
  if (hm && req.method === 'POST') {
    const s = sessions[hm[1]];
    if (!s) return json(res, 404, { ok: false, error: 'session not found' });
    const b = await readBody(req).catch(() => ({}));
    if (hm[2] === 'attach') {
      const name = String(b.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
      const bytes = Math.floor((String(b.dataBase64 || '').length * 3) / 4);
      console.log('[attach]', s.name, name, b.mime, `${bytes} bytes`);
      await sleep(400);
      return json(res, 200, { ok: true, path: `.cc-hub/attachments/${name}` });
    }
    if (hm[2] === 'open-terminal') {
      if (!s.managed) return json(res, 409, { ok: false, error: 'CC Hub で動いているセッションではありません' });
      termWrite(s.id, `\r\n${C.yellow}--- PowerShell の新しいウィンドウで続きを開きました(mock) ---${C.reset}\r\n`);
      s.managed = false;
      s.handedOff = true;
      s.status = 'running';
      s.approval = null;
      s.currentTool = { name: 'Thinking', target: '', since: Date.now() };
      upsertSession(s);
      setTimeout(() => {
        if (!sessions[s.id] || s.managed) return;
        s.status = 'awaiting_input';
        s.currentTool = null;
        upsertSession(s);
      }, 2500);
      return json(res, 200, { ok: true });
    }
    // takeover
    if (s.managed) return json(res, 409, { ok: false, error: 'すでに CC Hub で動いています' });
    if (!b.force && (s.status === 'running' || s.status === 'awaiting_approval'))
      return json(res, 409, {
        ok: false,
        error: `${s.handedOff ? 'PowerShell' : '元のウィンドウ'}でまだ実行中です(${s.currentTool ? s.currentTool.name : '応答の生成中'})`,
      });
    s.managed = true;
    s.handedOff = false;
    s.status = 'starting';
    s.currentTool = null;
    s.cols = 120;
    s.rows = 32;
    termBuf[s.id] =
      (termBuf[s.id] || '') +
      `${C.dim}(mock) claude --resume ${s.id.slice(0, 8)}… で CC Hub に引き継ぎました${b.force ? '(強制)' : ''}${C.reset}\r\n`;
    upsertSession(s);
    setTimeout(() => {
      if (!sessions[s.id]) return;
      s.status = 'awaiting_input';
      upsertSession(s);
      termWrite(s.id, `${C.green}●${C.reset} 会話を再開しました。続きの指示をどうぞ。\r\n> `);
    }, 1500);
    return json(res, 200, { ok: true, session: s });
  }
  if (p === '/api/skills') {
    const cwd = url.searchParams.get('cwd') || '';
    await sleep(250);
    return json(res, 200, { ok: true, skills: skillsFor(cwd) });
  }
  if (p === '/api/mcp') {
    const refresh = url.searchParams.get('refresh') === '1';
    if (refresh || !mcpCheckedAt) {
      await sleep(refresh ? 3000 : 600);
      mcpCheckedAt = Date.now();
      mcpRound++;
    }
    return json(res, 200, { ok: true, servers: mcpServers(), checkedAt: mcpCheckedAt });
  }
  const cm = p.match(/^\/api\/sessions\/([^/]+)\/create-pr$/);
  if (cm && req.method === 'POST') {
    const s = sessions[cm[1]];
    if (!s) return json(res, 404, { ok: false, error: 'session not found' });
    if (!s.managed || s.status === 'stopped' || s.status === 'error')
      return json(res, 409, { ok: false, error: 'セッションが動いていません' });
    if (!s.branch || !s.repoId) return json(res, 409, { ok: false, error: 'ブランチがありません' });
    if (Object.values(prs).some((x) => x.repoId === s.repoId && x.headRefName === s.branch && x.state === 'OPEN'))
      return json(res, 409, { ok: false, error: 'このブランチの PR は作成済みです' });
    const b = await readBody(req).catch(() => ({}));
    termWrite(s.id, `${C.cyan}> /commander push して gh pr create${b.draft ? ' --draft' : ''} して(説明は変更内容から下書き)${C.reset}\r\n`);
    s.status = 'running';
    s.currentTool = { name: 'Bash', target: 'git push -u origin ' + s.branch, since: Date.now() };
    upsertSession(s);
    setTimeout(() => {
      if (!sessions[s.id]) return;
      const w = s.worktreeId && worktrees[s.worktreeId];
      if (w && w.git) {
        w.git.pushed = true;
        w.git.unpushed = 0;
        w.git.updatedAt = Date.now();
        upsertWt(w);
      }
      const pr = mkPr(s.repoId, prSeq++, {
        title: `${s.name}: 変更をまとめました`,
        headRefName: s.branch,
        isDraft: !!b.draft,
        checks: 'pending',
        checksSummary: { passed: 0, failed: 0, pending: 5 },
        reviewDecision: b.draft ? null : 'REVIEW_REQUIRED',
        updatedAt: Date.now(),
        sessionId: s.id,
        worktreeId: s.worktreeId,
      });
      prs[pr.id] = pr;
      upsertPr(pr);
      notifyPr(pr, 'PR を作成');
      s.status = 'awaiting_input';
      s.currentTool = null;
      s.lastMessage = `PR #${pr.number} を作成しました`;
      upsertSession(s);
      setTimeout(() => prs[pr.id] && pr.state === 'OPEN' && setChecks(pr, 'success'), 15000);
    }, 3000);
    return json(res, 200, { ok: true });
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
  // worktree の変更状況(動いているセッションのものだけ少しずつ増やし、ときどきコミット)
  if (tick % 3 === 0) {
    for (const w of Object.values(worktrees)) {
      if (w.state !== 'assigned' || !w.git) continue;
      const s = w.sessionId && sessions[w.sessionId];
      if (!s || s.status === 'stopped' || s.status === 'error') continue;
      const g = w.git;
      if (tick % 15 === 0 && g.changed > 0) {
        g.changed = 0;
        g.ahead++;
        g.unpushed++;
      } else if (s.status === 'running' || Math.random() < 0.3) {
        const add = Math.floor(Math.random() * 25);
        g.changed += Math.random() < 0.5 ? 1 : 0;
        g.insertions += add;
        g.deletions += Math.floor(add / 3);
      }
      g.updatedAt = Date.now();
      upsertWt(w);
    }
  }
  // 30 秒ごとにドラフト PR の CI が 実行中 → 成功 → 失敗 → 実行中 と変わる
  if (tick % 15 === 0 && prs[pr45.id] && pr45.state === 'OPEN') {
    setChecks(pr45, pr45.checks === 'pending' ? 'success' : pr45.checks === 'success' ? 'failure' : 'pending');
  }
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

// 管理画面(/api/project, /api/git/*)と、トークン数の疑似増加
const project = createProjectMock({ sessions, worktrees, repos, prs, upsertSession, upsertWt, json, readBody, REPO_WEB, mkTokens });
const ops = createOpsMock({ broadcast, sessions, json, readBody, REPO_WEB, requesterId: s2.id });
const history = createHistoryMock({ sessions, upsertSession, json, readBody, mkSession, termBuf, linkIds: [s1.id, s3.id, s5.id, s7.id] });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CC Hub mock: http://127.0.0.1:${PORT}  (PIN: ${PIN})`);
});

/** POST /api/sessions で repoId があればプールから割り当てて起動する。処理したら true */
async function peekRepoStart(req, res) {
  const b = await readBody(req).catch(() => ({}));
  req._body = b;
  if (!b.repoId) return false;
  const repo = repos[b.repoId];
  const slug = String(b.branchSlug || slugOf(b.instruction || 'work'));
  const r = startOnBranch(repo, `feat/${slug}`, { mode: b.mode, instruction: b.instruction, name: b.name || slug, repoId: b.repoId });
  if (r.error) json(res, r.code, { ok: false, error: r.error });
  else json(res, 200, { ok: true, session: r.session });
  return true;
}

/** プールの worktree を割り当て、branch でセッションを起動する。{session} か {error, code} */
function startOnBranch(repo, branch, b) {
  if (!repo) return { error: `リポジトリ ${b.repoId ?? ''} は登録されていません`, code: 404 };
  if (repo.status !== 'ready') return { error: `${repo.name} はまだ利用できません(${repo.status})`, code: 409 };
  let w = repoWts(repo.id).find((x) => x.state === 'idle');
  const fresh = !w;
  if (!w) {
    if (repoWts(repo.id).length >= repo.poolMax) return { error: `worktree が上限(${repo.poolMax})に達しています`, code: 409 };
    w = mkWt(repo, nextWtNo(repo), { state: 'creating' });
    worktrees[w.id] = w;
  }
  const s = mkSession({
    name: b.name || branch.replace(/^feat\//, ''),
    cwd: w.path,
    mode: b.mode || 'commander',
    status: 'starting',
    createdAt: Date.now(),
    contextPct: 0,
    costUsd: 0,
    repoId: repo.id,
    worktreeId: w.id,
    branch,
    task: b.instruction ? String(b.instruction).slice(0, 300) : null,
    tokens: mkTokens(0, 0, 0, 0),
  });
  sessions[s.id] = s;
  termBuf[s.id] = `${C.dim}(mock) ${w.name} に ${branch} を用意して起動: ${s.mode} ${b.instruction ?? ''}${C.reset}\r\n`;
  upsertSession(s);
  const assign = () => {
    w.state = 'assigned';
    w.branch = branch;
    w.sessionId = s.id;
    w.lastUsedAt = Date.now();
    w.progress = null;
    // 既存ブランチ(PR から開いた場合)は push 済みとして扱う
    const existing = Object.values(prs).some((x) => x.repoId === repo.id && x.headRefName === branch);
    w.git = mkGit(existing ? { ahead: 3, insertions: 80, deletions: 20, pushed: true } : {});
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
  return { session: s };
}
