// モック: フォルダ(プロジェクト)ごとの管理画面(GET /api/project, /api/project/file, /api/project/diff, POST /api/git/*)
// 契約は packages/shared/src/index.ts の「フォルダ(プロジェクト)ごとの管理画面」に準拠。
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MIN = 60_000;

// ---------------------------------------------------------------- 小さな PNG を生成(画像プレビュー確認用)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** paint(x, y) → [r, g, b] */
function makePng(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// 構成図っぽい画像(3 つの箱と矢印)
const PNG_ARCH = makePng(360, 200, (x, y) => {
  const box = (bx, by, bw, bh) => x >= bx && x < bx + bw && y >= by && y < by + bh;
  const edge = (bx, by, bw, bh) => box(bx, by, bw, bh) && !box(bx + 2, by + 2, bw - 4, bh - 4);
  if (edge(20, 30, 90, 50) || edge(135, 30, 90, 50) || edge(250, 30, 90, 50) || edge(135, 120, 90, 50)) return [140, 188, 255];
  if (box(20, 30, 90, 50)) return [34, 52, 83];
  if (box(135, 30, 90, 50)) return [36, 70, 52];
  if (box(250, 30, 90, 50)) return [70, 46, 92];
  if (box(135, 120, 90, 50)) return [80, 64, 26];
  if ((y === 55 || y === 56) && ((x > 110 && x < 135) || (x > 225 && x < 250))) return [200, 205, 215];
  if ((x === 180 || x === 181) && y > 80 && y < 120) return [200, 205, 215];
  return [23 + ((x + y) % 40 === 0 ? 8 : 0), 26, 33];
});
// スクリーンショットっぽい画像(検索ボックス)
const PNG_SEARCH = makePng(320, 180, (x, y) => {
  if (y < 28) return [29, 33, 41];
  if (x > 20 && x < 300 && y > 44 && y < 74) {
    if (x < 23 || x > 297 || y < 47 || y > 71) return [140, 188, 255];
    if (x > 32 && x < 120 && y > 55 && y < 62) return [110, 118, 135];
    return [19, 22, 28];
  }
  if (x > 20 && x < 300 && y > 90 && (y - 90) % 28 < 22) return (y - 90) % 28 < 2 ? [53, 60, 74] : [37, 42, 52];
  return [23, 26, 33];
});

// ---------------------------------------------------------------- ファイルの中身
const MD_LOGIN = `# ログイン後のリダイレクト

ログイン後に **元のページ** に戻すための設計メモです。

## 方針

1. \`?next=\` を受け取る
2. 同一オリジンの相対パスだけ許可する
   - \`//evil.example.com\` のような *プロトコル相対 URL* は拒否
   - \`/\\\\evil\` も拒否
3. 不正な値のときはトップ \`/\` に戻す

## タスク

- [x] redirect.ts の検証関数
- [x] 単体テスト
- [ ] E2E(preview 環境)

## 参考

- [OWASP: Unvalidated Redirects](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)
- [危険なリンク](javascript:alert(1))(リンクにならないこと)
- ![構成図](../docs/shop-architecture.png)

\`\`\`ts
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}
\`\`\`

> HTML はそのまま文字で表示されます: <script>alert("x")</script> <b>太字にならない</b>

| ケース | 結果 |
| --- | --- |
| \`/cart\` | 許可 |
| \`//evil.example.com\` | 拒否 |
`;

const MD_PLAN = `# ShopService 分割計画

## 現状
ShopService.ts が 1,800 行あり、在庫・価格・カートの責務が混ざっている。

## 分割後
- **InventoryService** — 在庫の引当と戻し
- **PricingService** — 割引・税計算
- **CartService** — カートの操作

---

### 移行手順
1. 呼び出し元を列挙(Explore エージェント)
2. インターフェースを先に切る
3. テストを通しながら移す
`;

function codeFor(path) {
  const name = path.split('/').pop().replace(/\.\w+$/, '');
  if (path.endsWith('.json')) return JSON.stringify({ name, version: '1.0.0', items: [1, 2, 3] }, null, 2) + '\n';
  if (path.endsWith('.css')) return `.${name} {\n  display: flex;\n  gap: 8px;\n}\n`;
  return [
    `// ${path}`,
    `import { describe } from './util';`,
    '',
    `export interface ${name}Options {`,
    '  limit: number;',
    '  /** 説明: HTML <b>タグ</b> はエスケープされること */',
    '  label?: string;',
    '}',
    '',
    `export class ${name} {`,
    `  constructor(private readonly opts: ${name}Options) {}`,
    '',
    '  run(items: string[]): string[] {',
    '    const out: string[] = [];',
    '    for (const it of items) {',
    '      if (out.length >= this.opts.limit) break;',
    "      out.push(it.trim());",
    '    }',
    '    return out;',
    '  }',
    '',
    '  describe(): string {',
    `    return describe('${name}', this.opts);`,
    '  }',
    '}',
    '',
  ].join('\n');
}

export function createProjectMock(ctx) {
  const { sessions, worktrees, repos, prs, upsertSession, upsertWt, json, readBody, REPO_WEB, mkTokens } = ctx;
  const now = Date.now();
  const sha = () => crypto.randomBytes(20).toString('hex');
  const commit = (subject, ago, pushed, author = 'ryuichi-yano') => ({ sha: sha(), subject, author, date: now - ago * MIN, pushed });
  const fc = (path, status, additions, deletions) => ({ path, status, additions, deletions });

  /** targetId → git 状態(staged / unstaged / untracked / commits / committedFiles) */
  const git = new Map();
  /** "targetId|path" → { content: Buffer | string, mtime } */
  const files = new Map();
  const setFile = (tid, path, content, agoMin = 5) => files.set(`${tid}|${path}`, { content, mtime: now - agoMin * MIN });
  const getFile = (tid, path) => {
    const f = files.get(`${tid}|${path}`);
    if (f) return f;
    // 未登録のファイルは拡張子から中身を作る
    const g = { content: path.endsWith('.md') ? `# ${path}\n\n(mock の Markdown)\n` : codeFor(path), mtime: now - 30 * MIN };
    files.set(`${tid}|${path}`, g);
    return g;
  };

  function mkState(p) {
    return {
      kind: 'worktree',
      label: '',
      path: '',
      branch: null,
      baseRef: 'origin/main',
      upstream: null,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      commits: [],
      committedFiles: [],
      sessionId: null,
      updatedAt: now,
      ...p,
    };
  }

  // ------------------------------------------------ 初期データ(shop-web)
  const wt = (n) => worktrees[`${REPO_WEB}#wt-${String(n).padStart(2, '0')}`];
  const tidOf = (w) => `wt:${w.id}`;
  const W1 = wt(1), W2 = wt(2), W3 = wt(3), W4 = wt(4), W8 = wt(8);
  if (W1) {
    const id = tidOf(W1);
    git.set(id, mkState({
      label: W1.name, path: W1.path, branch: W1.branch, upstream: `origin/${W1.branch}`, behind: 2, sessionId: W1.sessionId,
      staged: [fc('src/auth/redirect.ts', 'M', 42, 9)],
      unstaged: [fc('test/auth/redirect.test.ts', 'M', 12, 0), fc('src/auth/login.ts', 'M', 6, 4)],
      untracked: ['docs/login-redirect.md'],
      commits: [commit('fix: next の検証を追加', 8, false), commit('test: リダイレクトのテストを追加', 25, true), commit('feat: ?next= で元のページに戻す', 40, true), commit('refactor: ログイン処理を整理', 55, true)],
      committedFiles: [fc('src/pages/LoginPage.tsx', 'M', 7, 3), fc('src/auth/session.ts', 'M', 11, 2)],
    }));
    setFile(id, 'docs/login-redirect.md', MD_LOGIN, 2);
    setFile(id, 'docs/shop-architecture.png', PNG_ARCH, 30);
  }
  if (W2) {
    const id = tidOf(W2);
    git.set(id, mkState({
      label: W2.name, path: W2.path, branch: W2.branch, upstream: `origin/${W2.branch}`, sessionId: W2.sessionId,
      staged: [fc('src/shop/ShopService.ts', 'M', 38, 212), fc('src/shop/CartService.ts', 'A', 96, 0)],
      unstaged: [fc('src/shop/index.ts', 'M', 4, 1)],
      untracked: ['src/shop/PricingService.ts', 'docs/shop-architecture.png'],
      commits: [commit('refactor: InventoryService を切り出し', 12, false), commit('docs: 分割計画を追加', 35, false), commit('chore: テストの準備', 70, true)],
      committedFiles: [fc('docs/refactor-plan.md', 'A', 18, 0), fc('src/shop/InventoryService.ts', 'A', 120, 0)],
    }));
    setFile(id, 'docs/shop-architecture.png', PNG_ARCH, 1);
    setFile(id, 'docs/refactor-plan.md', MD_PLAN, 35);
  }
  if (W3) {
    git.set(tidOf(W3), mkState({
      label: W3.name, path: W3.path, branch: W3.branch, upstream: `origin/${W3.branch}`, sessionId: W3.sessionId,
      commits: [commit('test: バッジのテスト', 80, true), commit('feat: カートに件数バッジ', 95, true), commit('style: バッジの色', 100, true)],
      committedFiles: [fc('src/components/CartBadge.tsx', 'A', 31, 0), fc('src/components/Header.tsx', 'M', 4, 1), fc('test/CartBadge.test.tsx', 'A', 40, 0), fc('src/styles/badge.css', 'A', 12, 0)],
    }));
  }
  if (W4) {
    const id = tidOf(W4);
    git.set(id, mkState({
      label: W4.name, path: W4.path, branch: W4.branch, upstream: null, behind: 1, sessionId: W4.sessionId,
      unstaged: [fc('src/components/SearchBox.tsx', 'M', 18, 5)],
      untracked: ['screenshots/search-box.png', 'src/hooks/useDebounce.ts'],
      commits: [commit('feat: 検索ボックスを追加', 6, false), commit('feat: 絞り込みのロジック', 15, false)],
      committedFiles: [fc('src/pages/ProductList.tsx', 'M', 22, 3), fc('src/data/products.json', 'M', 30, 0)],
    }));
    setFile(id, 'screenshots/search-box.png', PNG_SEARCH, 3);
  }
  if (W8) {
    git.set(tidOf(W8), mkState({
      label: W8.name, path: W8.path, branch: W8.branch, upstream: null, sessionId: W8.sessionId,
      unstaged: [fc('src/checkout/validate.ts', 'M', 52, 8), fc('src/checkout/CheckoutForm.tsx', 'M', 20, 6)],
      commits: [commit('feat: カード番号の検証', 45, false)],
      committedFiles: [fc('src/checkout/luhn.ts', 'A', 24, 0)],
    }));
  }
  // .base(既定ブランチ main。ローカルに未 push のコミット → push すると既定ブランチで 409)
  git.set(`base:${REPO_WEB}`, mkState({
    kind: 'base', label: '.base', path: `${repos[REPO_WEB]?.baseDir ?? 'D:\\WorkTree\\shop-web'}\\.base`, branch: 'main', baseRef: 'origin/main', upstream: 'origin/main',
    commits: [commit('docs: README のセットアップ手順を更新', 18, false)],
    committedFiles: [fc('README.md', 'M', 9, 2)],
  }));
  setFile(`base:${REPO_WEB}`, 'README.md', '# shop-web\n\n## セットアップ\n\n```sh\nnpm ci\nnpm run dev\n```\n\n- Node 20 以上\n- `.env.local` を用意する\n', 18);

  // フォルダ(C:\Users\yanor\cc-hub)
  const DIR = 'C:\\Users\\yanor\\cc-hub';
  const DIR_ID = `dir:${DIR}`;
  const s3 = Object.values(sessions).find((s) => !s.repoId && s.cwd.toLowerCase() === DIR.toLowerCase());
  git.set(DIR_ID, mkState({
    kind: 'dir', label: 'cc-hub', path: DIR, branch: 'main', baseRef: null, upstream: 'origin/main', sessionId: s3?.id ?? null,
    unstaged: [fc('docs/design.md', 'M', 64, 12)],
    untracked: ['docs/notes.md'],
    commits: [commit('docs: §12 UI を追記', 30, false), commit('feat: 管理画面の契約を追加', 90, true), commit('fix: WS の再接続', 180, true), commit('chore: 依存を更新', 600, true)],
    committedFiles: [],
  }));
  setFile(DIR_ID, 'docs/design.md', '# CC Hub 設計書\n\n## §12 UI\n\n- デスクトップ: サイドバー / 中央 / 右パネル\n- スマホ: 下タブ\n\n## §13 API\n\n`GET /api/project` で管理画面の情報を返す。\n', 1);
  setFile(DIR_ID, 'docs/notes.md', '# メモ\n\n- [ ] 管理画面のスクリーンショットを撮る\n- [x] 契約を確認\n', 4);

  /** 割り当て中の worktree で状態がまだ無いもの(新しく起動したセッション)は空で作る */
  function ensureRepoTargets(repoId) {
    const repo = repos[repoId];
    if (repo && repo.status === 'ready' && !git.has(`base:${repoId}`)) {
      git.set(`base:${repoId}`, mkState({ kind: 'base', label: '.base', path: `${repo.baseDir}\.base`, branch: repo.defaultBranch || 'main', upstream: `origin/${repo.defaultBranch || 'main'}` }));
    }
    for (const w of Object.values(worktrees)) {
      if (w.repoId !== repoId || w.state !== 'assigned') continue;
      const id = tidOf(w);
      const g = git.get(id);
      if (!g) git.set(id, mkState({ label: w.name, path: w.path, branch: w.branch, sessionId: w.sessionId }));
      else {
        g.branch = w.branch;
        g.sessionId = w.sessionId;
      }
    }
  }

  function toTarget(id, g) {
    const ahead = g.commits.length;
    const unpushed = g.commits.filter((c) => !c.pushed).length;
    return {
      id,
      kind: g.kind,
      label: g.label,
      path: g.path,
      branch: g.branch,
      baseRef: g.baseRef,
      upstream: g.upstream,
      ahead: g.kind === 'worktree' ? ahead : unpushed,
      behind: g.behind,
      unpushed,
      staged: g.staged,
      unstaged: g.unstaged,
      untracked: g.untracked,
      commits: g.commits,
      sessionId: g.sessionId,
      updatedAt: g.updatedAt,
    };
  }

  const sizeOf = (tid, path) => {
    const c = getFile(tid, path).content;
    return typeof c === 'string' ? Buffer.byteLength(c) : c.length;
  };
  const kindOf = (p) => {
    const ext = p.toLowerCase().split('.').pop();
    if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) return 'image';
    if (/^(md|markdown)$/.test(ext)) return 'markdown';
    if (/^(json|ya?ml|csv|toml)$/.test(ext)) return 'data';
    if (/^(ts|tsx|js|jsx|css|cs|py)$/.test(ext)) return 'code';
    return 'other';
  };

  function artifactsOf(id, g) {
    const out = new Map();
    const push = (path, status, committed) => {
      const f = getFile(id, path);
      out.set(path, { targetId: id, sessionId: g.sessionId, path, status, kind: kindOf(path), size: status === 'D' ? 0 : sizeOf(id, path), mtime: f.mtime, committed });
    };
    for (const f of g.committedFiles) push(f.path, f.status, true);
    for (const f of g.staged) push(f.path, f.status, false);
    for (const f of g.unstaged) push(f.path, f.status, false);
    for (const p of g.untracked) push(p, '?', false);
    return [...out.values()];
  }

  function overview(q) {
    const repoId = q.get('repoId');
    const cwd = q.get('cwd');
    let ids = [];
    let name = '';
    let path = '';
    let sess = [];
    if (repoId) {
      const repo = repos[repoId];
      if (!repo) return null;
      ensureRepoTargets(repoId);
      ids = [...git.keys()].filter((k) => k === `base:${repoId}` || (k.startsWith('wt:') && worktrees[k.slice(3)]?.repoId === repoId && worktrees[k.slice(3)]?.state === 'assigned'));
      name = repo.name;
      path = repo.baseDir;
      sess = Object.values(sessions).filter((s) => s.repoId === repoId);
    } else if (cwd) {
      const norm = cwd.replace(/[\\/]+$/, '').toLowerCase();
      sess = Object.values(sessions).filter((s) => !s.repoId && s.cwd.replace(/[\\/]+$/, '').toLowerCase() === norm);
      const id = `dir:${cwd}`;
      if (!git.has(id) && ![...git.keys()].some((k) => k.toLowerCase() === id.toLowerCase())) {
        git.set(id, mkState({ kind: 'dir', label: cwd.split(/[\\/]/).pop(), path: cwd, branch: 'main', baseRef: null, upstream: 'origin/main', sessionId: sess[0]?.id ?? null }));
      }
      ids = [...git.keys()].filter((k) => k.toLowerCase() === id.toLowerCase());
      name = cwd.split(/[\\/]/).pop();
      path = cwd;
    } else return null;
    sess.sort((a, b) => b.createdAt - a.createdAt);
    const targets = ids.map((id) => toTarget(id, git.get(id)));
    // 並び: worktree(名前順)→ base → dir
    targets.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label, undefined, { numeric: true }) : a.kind === 'worktree' ? -1 : b.kind === 'worktree' ? 1 : 0));
    const artifacts = ids.flatMap((id) => artifactsOf(id, git.get(id)));
    const sids = new Set(sess.map((s) => s.id));
    const prIds = Object.values(prs)
      .filter((p) => (repoId ? p.repoId === repoId : p.sessionId && sids.has(p.sessionId)))
      .map((p) => p.id);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, bySession: {} };
    for (const s of sess) {
      const t = s.tokens ?? mkTokens(0, 0, 0, 0);
      const row = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation, costUsd: s.costUsd ?? 0 };
      tokens.bySession[s.id] = row;
      tokens.input += row.input;
      tokens.output += row.output;
      tokens.cacheRead += row.cacheRead;
      tokens.cacheCreation += row.cacheCreation;
      tokens.costUsd += row.costUsd;
    }
    return { key: { repoId: repoId ?? null, cwd: repoId ? null : cwd }, name, path, sessionIds: sess.map((s) => s.id), targets, artifacts, prIds, tokens, updatedAt: Date.now() };
  }

  // ------------------------------------------------ 差分(それっぽい unified diff を作る)
  function textOf(tid, path) {
    const c = getFile(tid, path).content;
    return typeof c === 'string' ? c : null;
  }
  function makeDiff(tid, path, staged) {
    const g = git.get(tid);
    if (!g) return '';
    const st = staged ? g.staged.find((f) => f.path === path) : g.unstaged.find((f) => f.path === path);
    const untracked = !staged && g.untracked.includes(path);
    const committed = g.committedFiles.find((f) => f.path === path);
    const status = untracked ? 'A' : st?.status ?? committed?.status ?? 'M';
    const text = textOf(tid, path);
    const head = `diff --git a/${path} b/${path}\n`;
    if (text === null) return `${head}Binary files ${status === 'A' ? '/dev/null' : `a/${path}`} and b/${path} differ\n`;
    const lines = text.replace(/\n$/, '').split('\n');
    if (status === 'A') return `${head}new file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    if (status === 'D') return `${head}deleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join('\n')}\n`;
    // 変更: 2 か所を書き換えたことにする
    const out = [`${head}index 3f2a1c0..9b8e7d4 100644`, `--- a/${path}`, `+++ b/${path}`];
    const hunk = (from) => {
      const a = Math.max(0, from - 3);
      const ctxBefore = lines.slice(a, from);
      const changed = lines.slice(from, from + 2);
      const ctxAfter = lines.slice(from + 2, from + 5);
      out.push(`@@ -${a + 1},${ctxBefore.length + changed.length + ctxAfter.length} +${a + 1},${ctxBefore.length + changed.length * 2 + ctxAfter.length - 1} @@`);
      for (const l of ctxBefore) out.push(` ${l}`);
      for (const l of changed) out.push(`-${l.replace(/\S+\s*$/, 'old();')}`);
      for (const l of changed) out.push(`+${l}`);
      out.push(`+  // 追加: 入力値を検証する`);
      for (const l of ctxAfter) out.push(` ${l}`);
    };
    hunk(Math.min(3, Math.max(0, lines.length - 2)));
    if (lines.length > 14) hunk(lines.length - 6);
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------ git 操作
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lineCount = (tid, p) => (textOf(tid, p) ?? '').split('\n').length;
  /** worktree の変更状況(WorktreeGitStat)を git 状態に合わせる */
  function syncWt(tid) {
    const g = git.get(tid);
    if (!g) return;
    g.updatedAt = Date.now();
    if (!tid.startsWith('wt:')) return;
    const w = worktrees[tid.slice(3)];
    if (!w || !w.git) return;
    w.git.changed = g.staged.length + g.unstaged.length + g.untracked.length;
    w.git.ahead = g.commits.length;
    w.git.unpushed = g.commits.filter((c) => !c.pushed).length;
    w.git.pushed = !!g.upstream;
    w.git.updatedAt = Date.now();
    upsertWt(w);
  }
  function stage(g, tid, paths, unstage) {
    for (const p of paths) {
      if (unstage) {
        const i = g.staged.findIndex((f) => f.path === p);
        if (i < 0) continue;
        const [f] = g.staged.splice(i, 1);
        if (f.status === 'A' && f.fromUntracked) g.untracked.push(p);
        else {
          const u = g.unstaged.find((x) => x.path === p);
          if (u) {
            u.additions += f.additions;
            u.deletions += f.deletions;
          } else g.unstaged.push({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions });
        }
      } else {
        const i = g.unstaged.findIndex((f) => f.path === p);
        if (i >= 0) {
          const [f] = g.unstaged.splice(i, 1);
          const s = g.staged.find((x) => x.path === p);
          if (s) {
            s.additions += f.additions;
            s.deletions += f.deletions;
          } else g.staged.push(f);
          continue;
        }
        const j = g.untracked.indexOf(p);
        if (j >= 0) {
          g.untracked.splice(j, 1);
          g.staged.push({ path: p, status: 'A', additions: lineCount(tid, p), deletions: 0, fromUntracked: true });
        }
      }
    }
  }
  const working = (s) => !!s && (s.status === 'running' || s.status === 'starting');
  const clean = (f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions });

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/project' && req.method === 'GET') {
      await sleep(120);
      const o = overview(url.searchParams);
      if (!o) return json(res, 404, { ok: false, error: 'プロジェクトが見つかりません' }), true;
      // JSON に内部用のフラグ(fromUntracked)を出さない
      for (const t of o.targets) t.staged = t.staged.map(clean);
      json(res, 200, { ok: true, project: o });
      return true;
    }
    if (p === '/api/project/file' && req.method === 'GET') {
      const tid = url.searchParams.get('target') ?? '';
      const path = url.searchParams.get('path') ?? '';
      if (!git.has(tid)) return json(res, 404, { ok: false, error: '対象が見つかりません' }), true;
      if (path.includes('..')) return json(res, 400, { ok: false, error: '不正なパスです' }), true;
      const g = git.get(tid);
      if (g.staged.concat(g.unstaged).some((f) => f.path === path && f.status === 'D')) return json(res, 404, { ok: false, error: '削除されたファイルです' }), true;
      const f = getFile(tid, path);
      const isBin = typeof f.content !== 'string';
      const ext = path.toLowerCase().split('.').pop();
      res.writeHead(200, {
        'Content-Type': isBin ? (ext === 'png' ? 'image/png' : 'application/octet-stream') : ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.split('/').pop())}"`,
      });
      res.end(f.content);
      return true;
    }
    if (p === '/api/project/diff' && req.method === 'GET') {
      const tid = url.searchParams.get('target') ?? '';
      if (!git.has(tid)) return json(res, 404, { ok: false, error: '対象が見つかりません' }), true;
      await sleep(150);
      json(res, 200, { ok: true, diff: makeDiff(tid, url.searchParams.get('path') ?? '', url.searchParams.get('staged') === '1') });
      return true;
    }
    if (p === '/api/git/stage' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const g = git.get(b.target);
      if (!g) return json(res, 404, { ok: false, error: '対象が見つかりません' }), true;
      if (!Array.isArray(b.paths) || b.paths.length === 0) return json(res, 400, { ok: false, error: 'paths が必要です' }), true;
      await sleep(250);
      stage(g, b.target, b.paths, !!b.unstage);
      syncWt(b.target);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/git/commit' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const g = git.get(b.target);
      if (!g) return json(res, 404, { ok: false, error: '対象が見つかりません' }), true;
      const message = String(b.message ?? '').trim();
      if (!message) return json(res, 400, { ok: false, error: 'コミットメッセージが必要です' }), true;
      await sleep(400);
      if (Array.isArray(b.paths) && b.paths.length) stage(g, b.target, b.paths, false);
      if (g.staged.length === 0) return json(res, 409, { ok: false, error: 'ステージされた変更がありません(空のコミットはできません)' }), true;
      const s = g.sessionId ? sessions[g.sessionId] : null;
      if (working(s) && !b.force) {
        syncWt(b.target);
        return json(res, 409, { ok: false, error: `セッション「${s.name}」が実行中です。作業が終わってからコミットするか、force で強制してください` }), true;
      }
      const c = { sha: sha(), subject: message.split('\n')[0], author: 'ryuichi-yano', date: Date.now(), pushed: false };
      g.commits.unshift(c);
      for (const f of g.staged) {
        const i = g.committedFiles.findIndex((x) => x.path === f.path);
        if (i >= 0) g.committedFiles.splice(i, 1);
        g.committedFiles.push(clean(f));
        const file = files.get(`${b.target}|${f.path}`);
        if (file) file.mtime = Date.now();
      }
      g.staged = [];
      syncWt(b.target);
      json(res, 200, { ok: true, commit: c });
      return true;
    }
    if (p === '/api/git/push' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const g = git.get(b.target);
      if (!g) return json(res, 404, { ok: false, error: '対象が見つかりません' }), true;
      await sleep(700);
      if (!g.branch) return json(res, 409, { ok: false, error: 'ブランチがありません(detached HEAD)' }), true;
      const def = (g.baseRef ?? 'origin/main').replace(/^origin\//, '');
      if ((g.branch === def || g.branch === 'main' || g.branch === 'master') && !b.force) {
        return json(res, 409, { ok: false, error: `既定ブランチ(${g.branch})への直接 push は止めています。PR を経由するか、force で強制してください` }), true;
      }
      for (const c of g.commits) c.pushed = true;
      g.upstream = g.upstream ?? `origin/${g.branch}`;
      syncWt(b.target);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // ------------------------------------------------ トークン数の疑似増加(動いているセッションだけ)
  let tick = 0;
  setInterval(() => {
    tick++;
    for (const s of Object.values(sessions)) {
      if (!s.tokens) continue;
      const busy = s.status === 'running' || s.status === 'starting';
      // 承認待ち / 入力待ちでもときどき少し増える(要約など)
      if (!busy && !(s.status === 'awaiting_approval' && tick % 3 === 0)) continue;
      const r = (a, b) => a + Math.floor(Math.random() * (b - a));
      const k = busy ? 1 : 0.2;
      s.tokens = {
        input: s.tokens.input + Math.round(r(900, 3800) * k),
        output: s.tokens.output + Math.round(r(150, 900) * k),
        cacheRead: s.tokens.cacheRead + Math.round(r(6000, 24000) * k),
        cacheCreation: s.tokens.cacheCreation + Math.round(r(0, 2500) * k),
        updatedAt: Date.now(),
      };
      s.costUsd = +((s.costUsd ?? 0) + 0.004 + Math.random() * 0.01 * k).toFixed(3);
      upsertSession(s);
    }
    // 実行中の shop-refactor はときどき新しいファイルを作る(アーティファクトが増える)
    if (tick % 20 === 0 && W2 && git.has(tidOf(W2))) {
      const g = git.get(tidOf(W2));
      const n = g.untracked.filter((x) => x.startsWith('src/shop/generated/')).length + 1;
      if (n <= 5) {
        const path = `src/shop/generated/Part${n}.ts`;
        g.untracked.push(path);
        setFile(tidOf(W2), path, codeFor(path), 0);
        syncWt(tidOf(W2));
      }
    }
  }, 2500);

  return { handle };
}
