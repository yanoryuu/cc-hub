// モック: 通知の設定 / アップロード先のサーバー / アップロード(Claude の申請を含む)/ プロジェクトの共通の指示
// 契約は packages/shared/src/index.ts の「通知」「アップロード先のサーバー」「プロジェクトの共通の指示」に準拠。
import crypto from 'node:crypto';
import { createFirebaseMock } from './firebase.mjs';

const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOpsMock({ broadcast, sessions, json, readBody, REPO_WEB, requesterId }) {
  const now = Date.now();

  // ---------------------------------------------------------------- 通知の設定
  let notify = {
    windows: { enabled: true, topics: ['approval', 'input', 'error', 'pr_ci_failed', 'deploy_request', 'deploy_done'], suppressWhenViewing: true },
    discord: [
      {
        id: 'dc-all',
        name: '全体',
        webhookMasked: '…a1B2c3',
        repoIds: [],
        topics: ['approval', 'error', 'pr_ci_failed', 'pr_merged', 'deploy_request', 'deploy_done'],
        enabled: true,
      },
    ],
    throttleSeconds: 30,
  };

  // ---------------------------------------------------------------- サーバー
  const servers = {};
  const secretOk = {};
  const mkServer = (p) => ({
    id: crypto.randomUUID(),
    name: '',
    protocol: 'sftp',
    host: '',
    port: 22,
    username: '',
    auth: { type: 'password', hasSecret: true },
    remoteDir: '/public_html',
    publicUrl: null,
    defaultLocalDir: null,
    buildCommand: null,
    exclude: [],
    deleteExtra: false,
    note: '',
    lastDeployAt: null,
    lastTest: null,
    ...p,
  });
  const sv1 = mkServer({
    name: 'ショップ本番',
    protocol: 'sftp',
    host: 'sv8123.xserver.jp',
    port: 10022,
    username: 'coly',
    remoteDir: '/home/coly/shop.example.com/public_html',
    publicUrl: 'https://shop.example.com/',
    defaultLocalDir: 'D:\\WorkTree\\shop-web\\wt-02\\dist',
    buildCommand: 'npm run build',
    exclude: ['*.map'],
    note: '本番。公開前に必ずローカルで確認',
    lastDeployAt: now - 26 * 60 * MIN,
    lastTest: { ok: true, message: '接続できました(/home/coly/shop.example.com/public_html に 14 件)', at: now - 26 * 60 * MIN },
  });
  const sv2 = mkServer({
    name: 'ポートフォリオ',
    protocol: 'ftps',
    host: 'ftp.lolipop.jp',
    port: 21,
    username: 'yano.jp-portfolio',
    remoteDir: '/portfolio',
    publicUrl: 'https://yano.example.jp/portfolio/',
    defaultLocalDir: 'C:\\Users\\yanor\\blog\\public',
    buildCommand: 'npm run build',
    deleteExtra: true,
    lastDeployAt: null,
    lastTest: { ok: false, message: '530 Login incorrect(ユーザー名かパスワードが違います)', at: now - 3 * 60 * MIN },
  });
  for (const s of [sv1, sv2]) servers[s.id] = s;
  secretOk[sv1.id] = true;
  const upsertServer = (s) => broadcast('state', { t: 'server.upsert', server: s });

  // ---------------------------------------------------------------- アップロード
  const deploys = {};
  const upsertDeploy = (d) => broadcast('state', { t: 'deploy.upsert', deploy: d });
  const notifyDeploy = (title, body, sessionId = '') =>
    broadcast('state', { t: 'notify', event: { kind: 'deploy', sessionId, title, body, ts: Date.now() } });

  const FILES = [
    ['index.html', 6_412],
    ['about/index.html', 4_980],
    ['products/index.html', 12_330],
    ['cart/index.html', 7_204],
    ['assets/index-B8x2kQ.js', 184_220],
    ['assets/index-C1d9aa.css', 28_400],
    ['assets/vendor-react-9fQ1.js', 142_880],
    ['assets/logo.svg', 3_120],
    ['assets/hero@2x.webp', 312_500],
    ['assets/products/mug.webp', 88_100],
    ['assets/products/tshirt.webp', 96_440],
    ['assets/products/tote.webp', 74_020],
    ['favicon.ico', 15_086],
    ['robots.txt', 64],
    ['sitemap.xml', 1_820],
  ];
  function makePlan(server) {
    const upload = FILES.slice(0, 11).map(([path, size], i) => ({ path, size, reason: i % 4 === 0 ? 'new' : 'changed' }));
    const del = server.deleteExtra ? ['assets/index-A0z9pp.js', 'assets/index-Z7k2bb.css', 'old/landing.html'] : ['assets/index-A0z9pp.js'];
    return { upload, delete: del, unchanged: 37, totalBytes: upload.reduce((n, u) => n + u.size, 0) };
  }
  function mkDeploy(server, p) {
    return {
      id: crypto.randomUUID(),
      serverId: server.id,
      serverName: server.name,
      localDir: server.defaultLocalDir ?? '',
      requestedBy: { kind: 'user' },
      note: null,
      state: 'planning',
      buildCommand: server.buildCommand,
      plan: null,
      progress: null,
      log: [],
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      url: server.publicUrl,
      ...p,
    };
  }
  const log = (d, line) => {
    d.log.push(line);
    if (d.log.length > 200) d.log.splice(0, d.log.length - 200);
  };

  /** planning: ビルド(あれば)→ 差分 → ready。auto なら続けて送信 */
  async function runPlan(d, auto) {
    const server = servers[d.serverId];
    d.state = 'planning';
    upsertDeploy(d);
    if (d.buildCommand) {
      for (const line of [`> ${d.buildCommand}`, 'vite v6.4.4 building for production...', 'transforming (412) src/main.tsx', '✓ 482 modules transformed.', 'dist/index.html  6.41 kB', '✓ built in 1.82s']) {
        await sleep(350);
        if (d.state !== 'planning') return;
        log(d, line);
        upsertDeploy(d);
      }
    }
    await sleep(500);
    if (d.state !== 'planning') return;
    log(d, `接続: ${server.protocol}://${server.host}:${server.port}${server.remoteDir}`);
    log(d, 'リモートの一覧を取得(48 件)… 差分を計算');
    d.plan = makePlan(server);
    log(d, `差分: 送信 ${d.plan.upload.length} 件 / 削除 ${d.plan.delete.length} 件 / 変更なし ${d.plan.unchanged} 件`);
    d.state = 'ready';
    upsertDeploy(d);
    if (auto) {
      await sleep(600);
      void runUpload(d);
    }
  }

  /** uploading: 約 6 秒で全ファイル */
  async function runUpload(d) {
    const server = servers[d.serverId];
    if (!d.plan) return;
    d.state = 'uploading';
    d.progress = { done: 0, total: d.plan.upload.length, bytes: 0, current: d.plan.upload[0]?.path ?? null };
    upsertDeploy(d);
    const step = 6000 / Math.max(1, d.plan.upload.length);
    for (const u of d.plan.upload) {
      d.progress.current = u.path;
      upsertDeploy(d);
      await sleep(step);
      if (d.state !== 'uploading') return;
      d.progress.done++;
      d.progress.bytes += u.size;
      log(d, `↑ ${u.path} (${u.size} B)`);
      upsertDeploy(d);
    }
    if (server.deleteExtra) for (const p of d.plan.delete) log(d, `✗ 削除 ${p}`);
    d.progress.current = null;
    d.state = 'done';
    d.finishedAt = Date.now();
    log(d, `完了: ${d.progress.done} ファイル`);
    server.lastDeployAt = d.finishedAt;
    upsertServer(server);
    upsertDeploy(d);
    notifyDeploy(`${server.name} へのアップロードが完了しました`, `${d.progress.done} ファイル · ${server.publicUrl ?? ''}`);
  }

  // 過去の履歴
  {
    const old = mkDeploy(sv1, {
      localDir: sv1.defaultLocalDir,
      state: 'done',
      createdAt: now - 26 * 60 * MIN - 40_000,
      finishedAt: now - 26 * 60 * MIN,
      plan: makePlan(sv1),
      log: ['> npm run build', '✓ built in 1.71s', '完了: 9 ファイル'],
    });
    old.progress = { done: 9, total: 9, bytes: 501_200, current: null };
    const fail = mkDeploy(sv2, {
      localDir: sv2.defaultLocalDir,
      state: 'failed',
      createdAt: now - 3 * 60 * MIN - 20_000,
      finishedAt: now - 3 * 60 * MIN,
      error: '530 Login incorrect(ユーザー名かパスワードが違います)',
      log: ['> npm run build', '✓ built in 0.94s', '接続: ftps://ftp.lolipop.jp:21/portfolio', '530 Login incorrect'],
    });
    const claudeOld = mkDeploy(sv1, {
      state: 'rejected',
      requestedBy: { kind: 'claude', sessionId: null, sessionName: 'hotfix-price' },
      note: '価格表示の修正を本番に反映したいです',
      createdAt: now - 2 * 24 * 60 * MIN,
      finishedAt: now - 2 * 24 * 60 * MIN + 5 * MIN,
      error: '却下: テストが終わってから',
    });
    for (const d of [old, fail, claudeOld]) deploys[d.id] = d;
  }

  /** Claude からの申請(承認待ち)を作る */
  function claudeRequest(note) {
    const s = requesterId ? sessions[requesterId] : null;
    const d = mkDeploy(sv1, {
      state: 'pending_approval',
      requestedBy: { kind: 'claude', sessionId: s?.id ?? null, sessionName: s?.name ?? null },
      note: note ?? 'ShopService の分割が終わり、テストも全部通りました。ステージングで確認済みなので本番に反映したいです。',
    });
    deploys[d.id] = d;
    upsertDeploy(d);
    notifyDeploy('Claude がアップロードを申請しています', `${sv1.name} ← ${d.localDir}`, s?.id ?? '');
    return d;
  }
  // 起動の数秒後に 1 件申請が届く
  setTimeout(() => claudeRequest(), 6000);

  // ---------------------------------------------------------------- Firebase(firebase.mjs)
  const firebase = createFirebaseMock({ deploys, upsertDeploy, notifyDeploy, log, sessions, requesterId, json, readBody });

  // ---------------------------------------------------------------- 共通の指示
  const instructions = {};
  function shopInstructions() {
    const out = ['# shop-web の共通の指示', '', '## 全体', '- 返答・コミットメッセージ・PR の説明は日本語で書く', '- 既存のコードのスタイル(Prettier の設定)に合わせる', '- 大きな変更の前に方針を 3 行で説明してから始める', '- 依存パッケージを追加するときは理由を書く', '- 秘密情報(.env)は読まない・書かない', ''];
    const secs = ['フロントエンド', 'API', 'テスト', 'デザイン', 'セキュリティ', '運用', 'ドキュメント', 'パフォーマンス'];
    let k = 1;
    for (const sec of secs) {
      out.push(`## ${sec}`);
      for (let i = 0; i < 20; i++) out.push(`- ${sec}のルール ${k++}: ${['命名は camelCase', '副作用はフックの外に出す', 'エラーは握りつぶさない', 'ログに個人情報を出さない', '定数は src/constants にまとめる'][i % 5]}`);
      out.push('');
    }
    return out.slice(0, 185).join('\n') + '\n';
  }
  const keyOf = (url) => (url.searchParams.get('repoId') ? `repo:${url.searchParams.get('repoId')}` : `cwd:${(url.searchParams.get('cwd') || '').toLowerCase()}`);
  function getIns(url) {
    const k = keyOf(url);
    if (!instructions[k]) {
      let content = '';
      let updatedAt = null;
      let updatedBy = null;
      if (k === `repo:${REPO_WEB}`) {
        content = shopInstructions();
        updatedAt = now - 50 * MIN;
        updatedBy = 'claude';
      } else if (k === 'cwd:c:\\users\\yanor\\cc-hub') {
        content = ['# cc-hub', '', '- packages/shared の契約を先に変える', '- web は日本語 UI。コントラストは scripts/contrast.mjs で確認', '- 7860 は本番。ビルドは dist-p* に出す', ''].join('\n');
        updatedAt = now - 3 * 24 * 60 * MIN;
        updatedBy = 'user';
      }
      instructions[k] = {
        key: { repoId: url.searchParams.get('repoId'), cwd: url.searchParams.get('cwd') },
        content,
        updatedAt,
        updatedBy,
      };
    }
    return finish(instructions[k]);
  }
  function countLines(t) {
    if (!t) return 0;
    return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n').length;
  }
  function finish(x) {
    const lineCount = countLines(x.content);
    const warning = lineCount > 200 ? `${lineCount} 行あります(目安は 200 行)。要点を絞ってください` : lineCount >= 180 ? `200 行に近づいています(${lineCount} 行)` : null;
    return { ...x, lineCount, limit: 200, warning };
  }
  function rewrite(content, request) {
    const lines = content ? content.replace(/\n$/, '').split('\n') : ['# 共通の指示', ''];
    const r = request.trim();
    if (/まとめ|絞|短く|減ら/.test(r)) {
      // ルールの番号付き行を半分に間引く
      const out = [];
      let n = 0;
      for (const l of lines) {
        if (/^- .+のルール \d+/.test(l) && n++ % 2 === 1) continue;
        out.push(l);
      }
      return out.join('\n') + '\n';
    }
    const item = r.replace(/[、,]?\s*を?(追加|足)して.*$/, '').replace(/^「|」$/g, '') || r;
    const testIdx = lines.findIndex((l) => /^## テスト/.test(l));
    const out = [...lines];
    if (testIdx >= 0 && /テスト|test/i.test(r)) {
      out.splice(testIdx + 1, 0, `- ${item}`);
      // ついでに似たルールを 1 行言い換える
      const j = out.findIndex((l, i) => i > testIdx + 1 && /^- テストのルール/.test(l));
      if (j >= 0) out[j] = out[j].replace(/: .*$/, ': 失敗したテストはスキップせず原因を直す');
    } else {
      const gi = out.findIndex((l) => /^## 全体/.test(l));
      out.splice(gi >= 0 ? gi + 1 : out.length, 0, `- ${item}`);
    }
    return out.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- HTTP
  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    // 通知
    if (p === '/api/notify/settings' && m === 'GET') return json(res, 200, { ok: true, settings: notify }), true;
    if (p === '/api/notify/settings' && m === 'PUT') {
      const b = await readBody(req).catch(() => ({}));
      const discord = (b.discord ?? []).map((t) => {
        const prev = notify.discord.find((x) => x.id === t.id);
        const masked = t.webhookUrl ? `…${String(t.webhookUrl).slice(-6)}` : prev?.webhookMasked ?? '';
        const { webhookUrl, ...rest } = t;
        return { ...rest, id: t.id || crypto.randomUUID(), webhookMasked: masked };
      });
      notify = { windows: b.windows ?? notify.windows, discord, throttleSeconds: Number(b.throttleSeconds ?? notify.throttleSeconds) };
      await sleep(300);
      return json(res, 200, { ok: true, settings: notify }), true;
    }
    if (p === '/api/notify/test' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      await sleep(500);
      const t = b.targetId ? notify.discord.find((x) => x.id === b.targetId) : null;
      if (b.channel === 'discord' && !t) return json(res, 404, { ok: false, error: '送信先が見つかりません' }), true;
      broadcast('state', { t: 'notify', event: { kind: 'done', sessionId: '', title: 'テスト通知', body: b.channel === 'discord' ? `Discord「${t.name}」に送りました(mock)` : 'Windows の通知を出しました(mock)', ts: Date.now() } });
      return json(res, 200, { ok: true }), true;
    }
    // サーバー
    if (p === '/api/servers' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const { secret, ...rest } = b;
      const s = mkServer({ ...rest, auth: { type: b.auth?.type ?? 'password', keyPath: b.auth?.keyPath, hasSecret: !!secret } });
      servers[s.id] = s;
      if (secret) secretOk[s.id] = true;
      upsertServer(s);
      await sleep(250);
      return json(res, 200, { ok: true, server: s }), true;
    }
    const sm = p.match(/^\/api\/servers\/([^/]+)(\/test)?$/);
    if (sm) {
      const s = servers[decodeURIComponent(sm[1])];
      if (!s) return json(res, 404, { ok: false, error: 'サーバーが見つかりません' }), true;
      if (sm[2] && m === 'POST') {
        await sleep(1400);
        const ok = !!secretOk[s.id];
        s.lastTest = ok
          ? { ok: true, message: `接続できました(${s.remoteDir} に 12 件)`, at: Date.now() }
          : { ok: false, message: '530 Login incorrect(ユーザー名かパスワードが違います)', at: Date.now() };
        upsertServer(s);
        if (!ok) return json(res, 200, { ok: false, message: s.lastTest.message }), true;
        return json(res, 200, {
          ok: true,
          message: s.lastTest.message,
          entries: ['index.html', 'about/', 'products/', 'cart/', 'assets/', 'favicon.ico', 'robots.txt', 'sitemap.xml', '.htaccess', 'old/', 'images/', 'privacy.html'],
        }), true;
      }
      if (m === 'PATCH') {
        const b = await readBody(req).catch(() => ({}));
        const { secret, ...rest } = b;
        Object.assign(s, rest, { auth: { type: b.auth?.type ?? s.auth.type, keyPath: b.auth?.keyPath, hasSecret: s.auth.hasSecret || !!secret } });
        if (secret) secretOk[s.id] = true;
        upsertServer(s);
        await sleep(250);
        return json(res, 200, { ok: true, server: s }), true;
      }
      if (m === 'DELETE') {
        delete servers[s.id];
        broadcast('state', { t: 'server.remove', id: s.id });
        return json(res, 200, { ok: true }), true;
      }
    }
    // アップロード
    if (p === '/api/deploys' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const s = servers[b.serverId];
      if (!s) return json(res, 404, { ok: false, error: 'サーバーが見つかりません' }), true;
      const d = mkDeploy(s, { localDir: b.localDir || s.defaultLocalDir || '', buildCommand: b.buildCommand ?? null });
      deploys[d.id] = d;
      upsertDeploy(d);
      void runPlan(d, !b.dryRun);
      return json(res, 200, { ok: true, deploy: d }), true;
    }
    if (p === '/api/_mock/claude-request' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      return json(res, 200, { ok: true, deploy: claudeRequest(b.note) }), true;
    }
    const dm = p.match(/^\/api\/deploys\/([^/]+)\/(start|approve|reject|cancel)$/);
    if (dm && m === 'POST') {
      const d = deploys[decodeURIComponent(dm[1])];
      if (!d) return json(res, 404, { ok: false, error: 'アップロードが見つかりません' }), true;
      const b = await readBody(req).catch(() => ({}));
      const act = dm[2];
      if (act === 'start') {
        if (d.state !== 'ready') return json(res, 409, { ok: false, error: `いまは開始できません(${d.state})` }), true;
        void runUpload(d);
      } else if (act === 'approve') {
        if (d.state !== 'pending_approval') return json(res, 409, { ok: false, error: '承認待ちではありません' }), true;
        log(d, 'あなたが承認しました');
        if (d.firebase) void firebase.run(d);
        else void runPlan(d, true);
      } else if (act === 'reject') {
        if (d.state !== 'pending_approval') return json(res, 409, { ok: false, error: '承認待ちではありません' }), true;
        d.state = 'rejected';
        d.error = b.reason ? `却下: ${b.reason}` : null;
        d.finishedAt = Date.now();
        upsertDeploy(d);
      } else {
        if (d.state === 'done' || d.state === 'failed') return json(res, 409, { ok: false, error: '終わっています' }), true;
        d.state = 'cancelled';
        d.finishedAt = Date.now();
        log(d, '中止しました');
        upsertDeploy(d);
      }
      return json(res, 200, { ok: true, deploy: d }), true;
    }
    if (await firebase.handle(req, res, url)) return true;
    // 共通の指示
    if (p === '/api/project/instructions' && m === 'GET') {
      await sleep(200);
      return json(res, 200, { ok: true, instructions: getIns(url) }), true;
    }
    if (p === '/api/project/instructions' && m === 'PUT') {
      const b = await readBody(req).catch(() => ({}));
      getIns(url);
      const x = instructions[keyOf(url)];
      x.content = String(b.content ?? '');
      x.updatedAt = Date.now();
      x.updatedBy = 'user';
      await sleep(300);
      return json(res, 200, { ok: true, instructions: finish(x) }), true;
    }
    if (p === '/api/project/instructions/rewrite' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const cur = getIns(url);
      await sleep(2000);
      const proposal = rewrite(cur.content, String(b.request ?? ''));
      return json(res, 200, { ok: true, proposal, lineCount: countLines(proposal) }), true;
    }
    return false;
  }

  return { handle, servers, deploys };
}
