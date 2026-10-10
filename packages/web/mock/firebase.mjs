// モック: Firebase(GET /api/firebase・POST /api/firebase/deploy・POST /api/deploys/:id/promote・Claude からの申請)
// 契約は packages/shared/src/index.ts の「Firebase」に準拠。デプロイのジョブは ops.mjs の deploys に入れる(承認 / 却下 / 中止は ops.mjs)
// D:\WorkTree\shop-web(リポジトリ shop-web の .base / worktree)に firebase.json がある想定。
// C:\Users\yanor\blog は firebase.json はあるが firebase login が切れている想定(エラー表示の確認用)。ほかは projectDir: null
import crypto from 'node:crypto';

const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFirebaseMock({ deploys, upsertDeploy, notifyDeploy, log, sessions, requesterId, json, readBody }) {
  const now = Date.now();
  const FB_PID = 'shop-web-prod';
  const FB_LIVE = 'https://shop-web-prod.web.app';
  const channels = [
    { site: FB_PID, channel: 'feat-cart-redesign', url: 'https://shop-web-prod--feat-cart-redesign-k2j9x1ab.web.app', expireAt: now + 5 * 24 * 60 * MIN, updatedAt: now - 2 * 24 * 60 * MIN },
    { site: FB_PID, channel: 'pr-142', url: 'https://shop-web-prod--pr-142-7fq0zz31.web.app', expireAt: now + 20 * 60 * MIN, updatedAt: now - 6 * 24 * 60 * MIN },
  ];
  const lowerPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

  function info(cwd) {
    const n = lowerPath(cwd);
    const base = { aliases: {}, sites: [], channels: [], functions: [], account: null, projects: [], checkedAt: Date.now(), error: null };
    if (n === 'd:\\worktree\\shop-web' || n.startsWith('d:\\worktree\\shop-web\\')) {
      const m = String(cwd).match(/^(D:\\WorkTree\\shop-web\\[^\\]+)/i);
      return {
        ...base,
        projectDir: m ? m[1] : String(cwd),
        projectId: FB_PID,
        aliases: { default: FB_PID, staging: 'shop-web-staging' },
        configured: { hosting: true, functions: true, firestore: true, storage: false },
        sites: [{ site: FB_PID, url: FB_LIVE }],
        channels,
        functions: [
          { name: 'api', region: 'asia-northeast1', runtime: 'nodejs20', state: 'ACTIVE', trigger: 'HTTPS' },
          { name: 'onOrderCreated', region: 'asia-northeast1', runtime: 'nodejs20', state: 'ACTIVE', trigger: 'Firestore: orders/{orderId} の作成' },
          { name: 'dailyReport', region: 'asia-northeast1', runtime: 'nodejs20', state: 'ACTIVE', trigger: 'スケジュール: 毎日 09:00' },
        ],
        account: 'yano@example.com',
        projects: [
          { projectId: FB_PID, displayName: 'Shop Web' },
          { projectId: 'shop-web-staging', displayName: 'Shop Web (staging)' },
        ],
      };
    }
    if (n === 'c:\\users\\yanor\\blog') {
      return {
        ...base,
        projectDir: 'C:\\Users\\yanor\\blog',
        projectId: 'yanor-blog',
        aliases: { default: 'yanor-blog' },
        configured: { hosting: true, functions: false, firestore: false, storage: false },
        sites: [{ site: 'yanor-blog', url: 'https://yanor-blog.web.app' }],
        error: 'Failed to authenticate, have you run firebase login?',
      };
    }
    return { ...base, projectDir: null, projectId: null, configured: { hosting: false, functions: false, firestore: false, storage: false } };
  }

  function mk(p) {
    const fb = {
      projectId: FB_PID,
      projectDir: 'D:\\WorkTree\\shop-web\\.base',
      targets: ['hosting'],
      preview: true,
      channel: null,
      previewUrl: null,
      previewExpiresAt: null,
      promoted: false,
      ...(p.firebase ?? {}),
    };
    const { firebase, ...rest } = p;
    return {
      id: crypto.randomUUID(),
      serverId: '',
      serverName: `Firebase: ${fb.projectId}`,
      localDir: fb.projectDir,
      requestedBy: { kind: 'user' },
      note: null,
      state: 'planning',
      buildCommand: null,
      plan: null,
      progress: null,
      log: [],
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      url: null,
      ...rest,
      firebase: fb,
    };
  }

  /** planning(ビルド)→ uploading(約 4 秒)→ preview_ready(Hosting + preview)/ done */
  async function run(d) {
    const fb = d.firebase;
    d.state = 'planning';
    upsertDeploy(d);
    if (d.buildCommand) {
      for (const line of [`> ${d.buildCommand}`, 'vite v6.4.4 building for production...', '✓ 482 modules transformed.', '✓ built in 1.62s']) {
        await sleep(400);
        if (d.state !== 'planning') return;
        log(d, line);
        upsertDeploy(d);
      }
    } else {
      await sleep(800);
      if (d.state !== 'planning') return;
    }
    const previewing = fb.preview && fb.targets.includes('hosting');
    log(d, previewing ? `=== Deploying to '${fb.projectId}' (preview channel)...` : `=== Deploying to '${fb.projectId}'...`);
    d.state = 'uploading';
    const total = 24;
    d.progress = { done: 0, total, bytes: 0, current: 'index.html' };
    upsertDeploy(d);
    const files = ['index.html', 'assets/index-B8x2kQ.js', 'assets/index-C1d9aa.css', 'assets/vendor-react-9fQ1.js', 'assets/hero@2x.webp', 'favicon.ico'];
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      if (d.state !== 'uploading') return;
      d.progress.done = Math.min(total, Math.round(((i + 1) / 8) * total));
      d.progress.bytes = d.progress.done * 41_000;
      d.progress.current = files[i % files.length];
      if (i === 1) log(d, `i  hosting[${fb.projectId}]: found ${total} files in dist`);
      if (i === 6) log(d, `✔  hosting[${fb.projectId}]: file upload complete`);
      upsertDeploy(d);
    }
    d.progress.current = null;
    if (previewing) {
      const ch = fb.channel || `cc-hub-${d.id.slice(0, 6)}`;
      fb.channel = ch;
      fb.previewUrl = `https://${fb.projectId}--${ch}-${d.id.slice(9, 13)}${d.id.slice(14, 18)}.web.app`;
      fb.previewExpiresAt = Date.now() + 7 * 24 * 60 * MIN;
      log(d, `✔  hosting:channel: Channel URL (${ch}): ${fb.previewUrl} [expires ${new Date(fb.previewExpiresAt).toISOString()}]`);
      channels.unshift({ site: fb.projectId, channel: ch, url: fb.previewUrl, expireAt: fb.previewExpiresAt, updatedAt: Date.now() });
      d.url = fb.previewUrl;
      d.state = 'preview_ready';
      upsertDeploy(d);
      notifyDeploy('プレビュー URL に公開しました', `${fb.projectId}: 確認して「本番に反映」してください`, d.requestedBy.sessionId ?? '');
      return;
    }
    for (const t of fb.targets.filter((t) => t !== 'hosting')) {
      await sleep(500);
      if (d.state !== 'uploading') return;
      log(d, `✔  ${t}: deployed`);
      upsertDeploy(d);
    }
    finish(d);
  }

  function finish(d) {
    d.state = 'done';
    d.finishedAt = Date.now();
    d.url = d.firebase.targets.includes('hosting') ? FB_LIVE : null;
    log(d, '✔  Deploy complete!');
    if (d.url) log(d, `Hosting URL: ${d.url}`);
    upsertDeploy(d);
    notifyDeploy(`Firebase(${d.firebase.projectId})へのデプロイが完了しました`, d.url ?? d.firebase.targets.join(', '));
  }

  /** 本番に反映: hosting:clone(再ビルドしない)+ 同じジョブの Functions / ルール */
  async function promote(d) {
    const fb = d.firebase;
    fb.promoted = true;
    d.state = 'uploading';
    d.progress = null;
    log(d, 'あなたが本番への反映を承認しました');
    log(d, `firebase hosting:clone ${fb.projectId}:${fb.channel} ${fb.projectId}:live`);
    upsertDeploy(d);
    await sleep(1500);
    if (d.state !== 'uploading') return;
    log(d, `✔  hosting: ${fb.channel} を live に複製しました`);
    upsertDeploy(d);
    for (const t of fb.targets.filter((t) => t !== 'hosting')) {
      await sleep(900);
      if (d.state !== 'uploading') return;
      log(d, `✔  ${t}: deployed`);
      upsertDeploy(d);
    }
    await sleep(400);
    finish(d);
  }

  // 過去の Firebase のデプロイ
  {
    const done = mk({
      state: 'done',
      createdAt: now - 2 * 24 * 60 * MIN - 5 * MIN,
      finishedAt: now - 2 * 24 * 60 * MIN,
      url: FB_LIVE,
      buildCommand: 'npm run build',
      log: ['> npm run build', '✓ built in 1.71s', "=== Deploying to 'shop-web-prod' (preview channel)...", '✔  Deploy complete!'],
      firebase: { targets: ['hosting', 'functions'], channel: 'pr-142', previewUrl: 'https://shop-web-prod--pr-142-7fq0zz31.web.app', previewExpiresAt: now + 20 * 60 * MIN, promoted: true },
    });
    const discarded = mk({
      state: 'cancelled',
      requestedBy: { kind: 'claude', sessionId: null, sessionName: 'cart-badge' },
      note: 'カートのバッジの色を変えたのでプレビューで確認してほしいです',
      createdAt: now - 5 * 24 * 60 * MIN,
      finishedAt: now - 5 * 24 * 60 * MIN + 30 * MIN,
      firebase: { targets: ['hosting'], channel: 'cc-hub-a1b2c3', previewUrl: 'https://shop-web-prod--cc-hub-a1b2c3-x9k2.web.app', previewExpiresAt: now + 2 * 24 * 60 * MIN },
    });
    const rules = mk({
      state: 'done',
      createdAt: now - 6 * 24 * 60 * MIN,
      finishedAt: now - 6 * 24 * 60 * MIN + 40_000,
      firebase: { targets: ['firestore:rules', 'firestore:indexes'], preview: false },
    });
    for (const d of [done, discarded, rules]) deploys[d.id] = d;
  }

  /** Claude からの Firebase デプロイの申請(承認待ち) */
  function claudeRequest(note) {
    const s = requesterId ? sessions[requesterId] : null;
    const d = mk({
      state: 'pending_approval',
      requestedBy: { kind: 'claude', sessionId: s?.id ?? null, sessionName: s?.name ?? null },
      buildCommand: 'npm run build',
      note: note ?? '商品一覧のページネーションを直し、Firestore のルールで orders の読み取りを本人だけに絞りました。プレビューで確認してから本番に出したいです。',
      firebase: { targets: ['hosting', 'firestore:rules'], preview: true },
    });
    deploys[d.id] = d;
    upsertDeploy(d);
    notifyDeploy('Claude が Firebase へのデプロイを申請しています', `${FB_PID}: hosting, firestore:rules`, s?.id ?? '');
    return d;
  }
  // 起動の数秒後に 1 件申請が届く
  setTimeout(() => claudeRequest(), 9000);

  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/firebase' && m === 'GET') {
      await sleep(url.searchParams.get('refresh') ? 1200 : 350);
      return json(res, 200, { ok: true, info: info(url.searchParams.get('cwd') || '') }), true;
    }
    if (p === '/api/firebase/deploy' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const i = info(b.cwd || '');
      if (!i.projectDir) return json(res, 400, { ok: false, error: 'firebase.json が見つかりません' }), true;
      if (i.error) return json(res, 400, { ok: false, error: i.error }), true;
      const targets = Array.isArray(b.targets) && b.targets.length ? b.targets : ['hosting'];
      const d = mk({ buildCommand: b.buildCommand ?? null, firebase: { projectDir: i.projectDir, targets, preview: b.preview !== false, channel: b.channel ?? null } });
      deploys[d.id] = d;
      upsertDeploy(d);
      void run(d);
      return json(res, 200, { ok: true, deploy: d }), true;
    }
    if (p === '/api/_mock/firebase-request' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      return json(res, 200, { ok: true, deploy: claudeRequest(b.note) }), true;
    }
    const pm = p.match(/^\/api\/deploys\/([^/]+)\/promote$/);
    if (pm && m === 'POST') {
      const d = deploys[decodeURIComponent(pm[1])];
      if (!d || !d.firebase) return json(res, 404, { ok: false, error: 'デプロイが見つかりません' }), true;
      if (d.state !== 'preview_ready') return json(res, 409, { ok: false, error: 'プレビュー確認待ちではありません' }), true;
      void promote(d);
      await sleep(150);
      return json(res, 200, { ok: true, deploy: d }), true;
    }
    return false;
  }

  return { handle, run };
}
