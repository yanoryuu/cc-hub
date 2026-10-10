// モック: 履歴(GET /api/history, /api/history/:id, POST /api/history/:id/open)と
// フォルダブラウザ(GET /api/fs/dirs)。契約は packages/shared/src/index.ts の REST 一覧に準拠
import crypto from 'node:crypto';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 決まった順で値を選ぶための簡易乱数(毎回同じデータになるように) */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

const PLACES = [
  { cwd: 'D:\\WorkTree\\TomsLands\\wt-01', branch: 'feat/inventory-ui', w: 3 },
  { cwd: 'D:\\WorkTree\\TomsLands\\wt-02', branch: 'feat/save-slots', w: 2 },
  { cwd: 'D:\\WorkTree\\TomsLands\\.base', branch: 'main', w: 2 },
  { cwd: 'C:\\Users\\yanor\\cc-hub', branch: 'main', w: 4 },
  { cwd: 'D:\\WorkTree\\shop-web\\wt-01', branch: 'feat/login-fix', w: 2 },
  { cwd: 'D:\\WorkTree\\shop-web\\wt-02', branch: 'feat/shop-refactor', w: 2 },
  { cwd: 'D:\\WorkTree\\shop-web\\wt-04', branch: 'feat/search-box', w: 1 },
  { cwd: 'C:\\Users\\yanor\\blog', branch: 'main', w: 1 },
  { cwd: 'C:\\Users\\yanor\\old-tool', branch: null, w: 1 },
  { cwd: 'D:\\WorkTree\\legacy-admin\\wt-02', branch: 'fix/csv-export', w: 1 },
];

const TITLES = {
  'TomsLands': [
    '/commander インベントリ UI のスクロールがカクつく問題を直して',
    'セーブスロットを 3 つに増やして、上書き確認ダイアログを出す',
    '/hub-commander 敵 AI のパス探索を NavMesh に置き換え',
    'Addressables のビルドが CI で失敗する原因を調べて',
    'タイトル画面の BGM がループ時にプチッと鳴る',
    '/review PR #31(クエストログ)',
    'URP のポストプロセスでブルームが強すぎる',
  ],
  'cc-hub': [
    'デーモンの WS プロトコルを実装',
    '/commander 管理画面にトークンのタブを追加',
    'PIN ログインのレート制限を入れて',
    '/simplify packages/daemon/src/pool.ts',
    'スマホでターミナルのフォントが小さすぎる',
    'Electron のトースト通知をクリックしたらセッションを開く',
    '/code-review high',
    '設計書(docs/design.md)を最新の実装に合わせて更新して',
  ],
  'shop-web': [
    'ログイン後に常にトップへ飛ばされる不具合を直して',
    'ShopService を在庫・価格・カートに分割',
    '/commander 商品一覧に検索ボックスを追加',
    'カートのバッジに件数を表示',
    'E2E テスト(Playwright)が CI だけ落ちる',
    '/review 決済画面の入力チェック',
  ],
  'blog': ['Astro を v5 に上げて', '記事一覧のページネーションが壊れている'],
  'old-tool': ['CSV を読み込んで集計する小さなスクリプト', 'Python 3.12 で動かない'],
  'legacy-admin': ['CSV エクスポートの文字化け(Shift_JIS)を直して', '/commander 管理画面のテーブルをソート可能に'],
};

function folderKey(cwd) {
  const parts = cwd.split('\\');
  const last = parts[parts.length - 1];
  return /^wt-\d+$|^\.base$/.test(last) ? parts[parts.length - 2] : last;
}

const ASSIST = [
  '原因を特定しました。{x} が初期化前に参照されていたためです。修正してテストを追加しました。',
  '変更点をまとめます:\n- {x} を分離\n- 既存のテストはすべて通過\n- 追加で 3 件のテストを書きました',
  '確認しました。{x} の設定を見直す必要があります。進めてよいですか?',
  '実装が終わりました。動作確認の手順:\n1. npm run dev\n2. 該当画面を開いて {x} を確認',
];
const TOOLS = ['Read src/{x}.ts', 'Edit src/{x}.ts', 'Bash npm test -- {x}', 'Grep "{x}" src/', 'Task 並列で 2 エージェントを起動'];
const WORDS = ['inventory', 'session', 'redirect', 'pool', 'cart', 'search', 'save', 'export', 'router', 'config'];

export function createHistoryMock({ sessions, upsertSession, json, readBody, mkSession, termBuf, linkIds = [] }) {
  const now = Date.now();
  const r = rng(42);
  const entries = [];
  // 重みに比例してフォルダを選ぶ
  const bag = PLACES.flatMap((p) => Array(p.w).fill(p));
  for (let i = 0; i < 64; i++) {
    const place = bag[Math.floor(r() * bag.length)];
    const titles = TITLES[folderKey(place.cwd)];
    const title = titles[Math.floor(r() * titles.length)];
    // 新しいものほど密に(今日 / 昨日 / 数日前 / 数週間前)
    const ago = i < 6 ? i * 37 * MIN + 5 * MIN : i < 14 ? DAY + (i - 6) * 70 * MIN : i < 30 ? (2 + (i - 14) / 3) * DAY : (8 + (i - 30)) * DAY;
    const mtime = now - ago;
    const count = 2 + Math.floor(r() * 40);
    const word = WORDS[Math.floor(r() * WORDS.length)];
    entries.push({
      id: crypto.randomUUID(),
      cwd: place.cwd,
      title,
      mtime,
      createdAt: mtime - (10 + Math.floor(r() * 180)) * MIN,
      messageCount: count,
      lastMessage: ASSIST[Math.floor(r() * ASSIST.length)].replace('{x}', word).split('\n')[0],
      gitBranch: place.branch,
      hubSessionId: null,
      _word: word,
    });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  // いくつかは CC Hub 上のセッションと紐付ける(「CC Hub で表示中」)
  linkIds.forEach((sid, i) => {
    const s = sessions[sid];
    const e = entries[i * 2 + 1];
    if (!s || !e) return;
    e.id = s.id;
    e.cwd = s.cwd;
    e.title = s.task || s.name;
    e.gitBranch = s.branch;
    e.hubSessionId = s.id;
  });

  const pub = (e) => {
    const { _word, ...rest } = e;
    // セッションが一覧から消えていたら紐付けを外す
    return { ...rest, hubSessionId: rest.hubSessionId && sessions[rest.hubSessionId] ? rest.hubSessionId : null };
  };

  function messages(e) {
    const rr = rng(e.mtime % 100000);
    const out = [];
    const n = Math.min(24, 4 + Math.floor(e.messageCount / 2));
    let ts = e.createdAt ?? e.mtime - HOUR;
    const step = Math.max(MIN, (e.mtime - ts) / n);
    out.push({ role: 'user', text: e.title, ts });
    for (let i = 1; i < n; i++) {
      ts += step;
      const k = rr();
      if (k < 0.45) out.push({ role: 'tool', text: TOOLS[Math.floor(rr() * TOOLS.length)].replace('{x}', e._word), ts });
      else if (k < 0.8) out.push({ role: 'assistant', text: ASSIST[Math.floor(rr() * ASSIST.length)].replace('{x}', e._word), ts });
      else out.push({ role: 'user', text: ['それで進めて', 'テストも追加して', '<script>alert(1)</script> がそのまま表示されること', 'PR を作って'][Math.floor(rr() * 4)], ts });
    }
    out.push({ role: 'assistant', text: e.lastMessage, ts: e.mtime });
    return out;
  }

  // ---------------- フォルダの木(/api/fs/dirs)
  const TREE = {
    'C:\\': ['Users', 'Program Files', 'Windows', 'tools'],
    'C:\\Users': ['yanor', 'Public'],
    'C:\\Users\\yanor': ['cc-hub', 'cc-remote', 'blog', 'old-tool', 'Documents', 'Downloads', 'Desktop', 'sandbox'],
    'C:\\Users\\yanor\\cc-hub': ['packages', 'docs', 'scripts'],
    'C:\\Users\\yanor\\cc-hub\\packages': ['daemon', 'web', 'shared', 'desktop'],
    'C:\\Users\\yanor\\Documents': ['notes', 'Unity Projects'],
    'C:\\Users\\yanor\\sandbox': ['react-try', 'rust-hello', 'py-scrape'],
    'D:\\': ['WorkTree', 'Unity', 'AITEST', 'Backup'],
    'D:\\WorkTree': ['shop-web', 'TomsLands', 'legacy-admin', 'cc-remote'],
    'D:\\WorkTree\\shop-web': ['.base', 'wt-01', 'wt-02', 'wt-03', 'wt-04', 'wt-08'],
    'D:\\WorkTree\\TomsLands': ['.base', 'wt-01', 'wt-02'],
    'D:\\WorkTree\\legacy-admin': ['wt-01', 'wt-02'],
    'D:\\Unity': ['TomsLands', 'Prototype2025'],
  };
  const GIT = /(cc-hub|cc-remote|blog|old-tool|react-try|rust-hello|py-scrape|\.base|wt-\d+|TomsLands|Prototype2025)$/i;
  const CLAUDE = /(cc-hub|blog|\.base|wt-0[12]|TomsLands)$/i;
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const join = (a, b) => (a.endsWith('\\') ? a + b : `${a}\\${b}`);
  const parentOf = (p) => {
    const t = p.replace(/[\\/]+$/, '');
    if (/^[a-z]:$/i.test(t)) return null;
    const i = t.lastIndexOf('\\');
    const up = t.slice(0, i);
    return /^[a-z]:$/i.test(up) ? `${up}\\` : up;
  };

  // json() は値を返さないので、処理したことを true で返す
  const send = (...a) => (json(...a), true);
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/fs/dirs' && req.method === 'GET') {
      const raw = (url.searchParams.get('path') || '').trim();
      if (!raw) {
        return send(res, 200, {
          ok: true,
          path: '',
          parent: null,
          dirs: [
            { name: 'C:', path: 'C:\\', isGitRepo: false, hasClaude: false },
            { name: 'D:', path: 'D:\\', isGitRepo: false, hasClaude: false },
            { name: 'ホーム', path: 'C:\\Users\\yanor', isGitRepo: false, hasClaude: true },
          ],
        });
      }
      const key = Object.keys(TREE).find((k) => norm(k) === norm(raw)) ?? (/^[a-z]:\\?$/i.test(raw) ? `${raw[0].toUpperCase()}:\\` : null);
      const exists = key || Object.entries(TREE).some(([k, v]) => v.some((c) => norm(join(k, c)) === norm(raw)));
      if (!exists) return send(res, 404, { ok: false, error: `フォルダが見つかりません: ${raw}` });
      const path = key ?? raw.replace(/[\\/]+$/, '');
      const kids = TREE[key ?? ''] ?? [];
      return send(res, 200, {
        ok: true,
        path,
        parent: parentOf(path),
        dirs: kids.map((name) => {
          const full = join(path, name);
          return { name, path: full, isGitRepo: GIT.test(full), hasClaude: CLAUDE.test(full) };
        }),
      });
    }
    if (p === '/api/history' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 30)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const cwd = (url.searchParams.get('cwd') || '').trim();
      let list = entries;
      if (cwd) {
        const n = norm(cwd);
        list = list.filter((e) => norm(e.cwd) === n || norm(e.cwd).startsWith(`${n}\\`));
      }
      if (q) list = list.filter((e) => `${e.title} ${e.cwd} ${e.lastMessage}`.toLowerCase().includes(q));
      await new Promise((r2) => setTimeout(r2, 250));
      return send(res, 200, { ok: true, sessions: list.slice(offset, offset + limit).map(pub), total: list.length });
    }
    const m = p.match(/^\/api\/history\/([^/]+)(\/open)?$/);
    if (m) {
      const e = entries.find((x) => x.id === decodeURIComponent(m[1]));
      if (!e) return send(res, 404, { ok: false, error: '履歴が見つかりません' });
      if (!m[2] && req.method === 'GET') {
        await new Promise((r2) => setTimeout(r2, 200));
        return send(res, 200, { ok: true, entry: pub(e), messages: messages(e) });
      }
      if (m[2] && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const target = b.target === 'terminal' ? 'terminal' : 'hub';
        let s = sessions[e.id];
        if (s && target === 'hub' && s.managed) return send(res, 200, { ok: true, session: s });
        if (!s) {
          s = mkSession({ id: e.id, name: e.title.replace(/^\/\S+\s*/, '').slice(0, 24) || 'resumed', cwd: e.cwd, branch: e.gitBranch, task: e.title, mode: 'plain', createdAt: Date.now(), lastEventAt: Date.now() });
          sessions[s.id] = s;
        }
        if (target === 'terminal') {
          Object.assign(s, { managed: false, handedOff: true, status: 'awaiting_input', cols: 0, rows: 0 });
        } else {
          Object.assign(s, { managed: true, handedOff: false, status: 'awaiting_input', cols: 120, rows: 32 });
          termBuf[s.id] = (termBuf[s.id] || '') + `(mock) claude --resume ${s.id.slice(0, 8)}… で再開しました\r\n> `;
        }
        e.hubSessionId = s.id;
        upsertSession(s);
        return send(res, 200, { ok: true, session: s });
      }
    }
    return false;
  }
  return { handle };
}
