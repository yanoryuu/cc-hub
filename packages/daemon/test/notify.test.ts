// 通知の振り分け(種類・絞り込み・間引き・表示中の抑制・Windows の出し先)と Discord(URL の検証・本文)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { NotifyEvent, NotifySettings } from '@cc-hub/shared';
import { Throttle, prTopic, route, throttleKey, topicOf } from '../src/notify/topic';
import { DESCRIPTION_MAX, DiscordSender, buildPayload, maskWebhook, redact, retryAfterMs, validateWebhookUrl } from '../src/notify/discord';
import { defaultSettings, loadStored, mergeUpdate, toPublic } from '../src/notify/settings';
import { NotifyService } from '../src/notify/service';
import { emitNotify } from '../src/notify/emit';
import { bus } from '../src/bus';

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}\n     ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };
  pending.push((pending.length ? pending[pending.length - 1] : Promise.resolve()).then(run));
}

const ev = (o: Partial<NotifyEvent>): NotifyEvent => ({ kind: 'input', sessionId: 's1', title: 't', body: 'b', ts: 1000, ...o });
const settings = (o: Partial<NotifySettings> = {}): NotifySettings => ({
  windows: { enabled: true, topics: ['approval', 'input', 'deploy_done'], suppressWhenViewing: true },
  discord: [
    { id: 'all', name: '全体', webhookMasked: '…aaaaaa', repoIds: [], topics: ['approval', 'pr_ci_failed', 'deploy_done'], enabled: true },
    { id: 'toms', name: 'TomsLands', webhookMasked: '…bbbbbb', repoIds: ['o/TomsLands'], topics: ['input', 'approval'], enabled: true },
    { id: 'off', name: '無効', webhookMasked: '…cccccc', repoIds: [], topics: ['approval'], enabled: false },
  ],
  throttleSeconds: 30,
  ...o,
});

// ------------------------------------------------------------ 種類
test('topicOf: セッションの種類', () => {
  assert.equal(topicOf(ev({ kind: 'approval' })), 'approval');
  assert.equal(topicOf(ev({ kind: 'input' })), 'input');
  assert.equal(topicOf(ev({ kind: 'error' })), 'error');
  assert.equal(topicOf(ev({ kind: 'done' })), null);
});

test('topicOf: PR(diffPrEvents のタイトル)', () => {
  assert.equal(prTopic('CI が失敗しました'), 'pr_ci_failed');
  assert.equal(prTopic('PR がマージされました'), 'pr_merged');
  assert.equal(prTopic('修正を依頼されました'), 'pr_review');
  assert.equal(prTopic('PR が承認されました'), 'pr_review');
  assert.equal(prTopic('新しいコメント / レビュー'), 'pr_review');
  assert.equal(prTopic('PR がクローズされました'), null);
  assert.equal(topicOf(ev({ kind: 'pr', title: 'CI が失敗しました: o/r#3' })), 'pr_ci_failed');
});

test('topicOf: アップロード / meta の明示が優先', () => {
  assert.equal(topicOf(ev({ kind: 'deploy', title: 'アップロードの申請: 本番' })), 'deploy_request');
  assert.equal(topicOf(ev({ kind: 'deploy', title: 'アップロード完了: 本番' })), 'deploy_done');
  assert.equal(topicOf(ev({ kind: 'pr', title: '何か' }), { topic: 'pr_merged' }), 'pr_merged');
});

// ------------------------------------------------------------ 振り分け
test('route: 種類とリポジトリで絞る / 無効な送信先は除く', () => {
  const r = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: 'o/TomsLands', settings: settings(), focus: null, desktopConnected: false, now: 1 });
  assert.equal(r.windows, 'daemon');
  assert.deepEqual(r.discord, ['all', 'toms']);
  const r2 = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: 'o/other', settings: settings(), focus: null, desktopConnected: false, now: 1 });
  assert.deepEqual(r2.discord, ['all']);
  // リポジトリ指定の送信先は repoId が分からない通知には送らない
  const r3 = route({ event: ev({ kind: 'input' }), topic: 'input', repoId: null, settings: settings(), focus: null, desktopConnected: false, now: 1 });
  assert.deepEqual(r3.discord, []);
  // リポジトリ名の大文字小文字は区別しない
  const r4 = route({ event: ev({ kind: 'input' }), topic: 'input', repoId: 'o/tomslands', settings: settings(), focus: null, desktopConnected: false, now: 1 });
  assert.deepEqual(r4.discord, ['toms']);
});

test('route: Windows はデスクトップアプリが接続中ならアプリ、未接続ならデーモン', () => {
  const base = { event: ev({ kind: 'input' }), topic: 'input' as const, repoId: null, settings: settings(), focus: null, now: 1 };
  assert.equal(route({ ...base, desktopConnected: true }).windows, 'app');
  assert.equal(route({ ...base, desktopConnected: false }).windows, 'daemon');
  const off = settings();
  off.windows.enabled = false;
  assert.equal(route({ ...base, settings: off, desktopConnected: true }).windows, null);
  // 種類が選ばれていない
  assert.equal(route({ ...base, topic: 'error', desktopConnected: true }).windows, null);
});

test('route: 前面で表示中のセッションは Windows / Discord とも出さない', () => {
  const focus = { sessionId: 's1', focused: true, at: 1000, activeAt: 1000 };
  const r = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: settings(), focus, desktopConnected: true, now: 2000 });
  assert.equal(r.windows, null);
  assert.deepEqual(r.discord, []);
  assert.equal(r.skipped, '表示中のセッション');
  // 別のセッション / 背面 / 設定オフ / 古い報告 なら出す
  const other = route({ event: ev({ kind: 'approval', sessionId: 's2' }), topic: 'approval', repoId: null, settings: settings(), focus, desktopConnected: true, now: 2000 });
  assert.equal(other.windows, 'app');
  const blur = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: settings(), focus: { ...focus, focused: false }, desktopConnected: true, now: 2000 });
  assert.equal(blur.windows, 'app');
  const s = settings();
  s.windows.suppressWhenViewing = false;
  assert.equal(route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: s, focus, desktopConnected: true, now: 2000 }).windows, 'app');
  const stale = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: settings(), focus, desktopConnected: true, now: 1000 + 31 * 60_000 });
  assert.equal(stale.windows, 'app');
});

test('route: 表示中でも 2 分以上操作がなければ Discord は送る(Windows は出さない)', () => {
  const focus = { sessionId: 's1', focused: true, at: 1000, activeAt: 1000 };
  const away = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: settings(), focus, desktopConnected: true, now: 1000 + 3 * 60_000 });
  assert.equal(away.windows, null);
  assert.ok(away.discord.length > 0);
  assert.equal(away.skipped, null);
  // 操作の記録が無い(古いクライアント)場合も席を外しているとみなす
  const noActive = route({ event: ev({ kind: 'approval' }), topic: 'approval', repoId: null, settings: settings(), focus: { sessionId: 's1', focused: true, at: 1000 }, desktopConnected: true, now: 2000 });
  assert.ok(noActive.discord.length > 0);
});

test('Throttle: 同じセッション・種類は throttleSeconds 以内に 1 回', () => {
  const t = new Throttle();
  const k = throttleKey(ev({}), 'input');
  assert.equal(t.allow(k, 30, 0), true);
  assert.equal(t.allow(k, 30, 29_999), false);
  assert.equal(t.allow(throttleKey(ev({}), 'approval'), 30, 1000), true); // 種類が違う
  assert.equal(t.allow(throttleKey(ev({ sessionId: 's2' }), 'input'), 30, 1000), true); // セッションが違う
  assert.equal(t.allow(k, 30, 30_000), true);
  assert.equal(t.allow(k, 0, 30_001), true); // 0 = 間引かない
  // PR はセッションが無いので prId で分ける
  assert.notEqual(throttleKey(ev({ sessionId: '', prId: 'o/r#1' }), 'pr_review'), throttleKey(ev({ sessionId: '', prId: 'o/r#2' }), 'pr_review'));
});

// ------------------------------------------------------------ Discord
test('Discord: Webhook URL の検証(本番は discord.com / discordapp.com の https のみ)', () => {
  const ok = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABC-123';
  assert.equal(validateWebhookUrl(ok, false), null);
  assert.equal(validateWebhookUrl(ok.replace('discord.com', 'discordapp.com'), false), null);
  assert.ok(validateWebhookUrl(ok.replace('https', 'http'), false));
  assert.ok(validateWebhookUrl('https://evil.example.com/api/webhooks/1/abc', false));
  assert.ok(validateWebhookUrl('https://discord.com.evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', false));
  assert.ok(validateWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz?x=1', false));
  assert.ok(validateWebhookUrl('', false));
  // 偽サーバーは CC_HUB_TEST=1 のときだけ
  assert.ok(validateWebhookUrl('http://127.0.0.1:9999/hook', false));
  assert.equal(validateWebhookUrl('http://127.0.0.1:9999/hook', true), null);
  assert.ok(validateWebhookUrl('http://localhost:9999/hook', true));
  assert.ok(validateWebhookUrl('http://10.0.0.1:9999/hook', true));
  assert.equal(maskWebhook(ok), '…BC-123');
});

test('Discord: 本文の形(タイトル / 300 文字 / 色 / フィールド / メンション無効 / 秘密を伏せる)', () => {
  const long = 'あ'.repeat(500);
  const p = buildPayload(ev({ kind: 'approval', title: '承認待ち: s', body: long }), {
    topic: 'approval',
    sessionName: 'login-fix',
    repoId: 'o/r',
    branch: 'feat/x',
    prUrl: 'https://github.com/o/r/pull/3',
  }) as any;
  const e = p.embeds[0];
  assert.equal(e.title, '承認待ち: s');
  assert.equal(e.description.length, DESCRIPTION_MAX);
  assert.equal(e.color, 0xf59e0b);
  assert.deepEqual(
    e.fields.map((f: any) => f.name),
    ['セッション', 'リポジトリ / ブランチ', 'PR'],
  );
  assert.equal(e.fields[1].value, 'o/r / feat/x');
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  const red = buildPayload(ev({ kind: 'error', body: 'see https://discord.com/api/webhooks/1/xyz and Bearer abcdefghijklmnop' }), { topic: 'error' }) as any;
  assert.equal(red.embeds[0].color, 0xef4444);
  assert.ok(!red.embeds[0].description.includes('xyz'));
  assert.ok(!red.embeds[0].description.includes('abcdefghijklmnop'));
  assert.equal(redact('token ' + 'a'.repeat(64)), 'token [伏せ字]');
  // PR のリンクは github.com のみ
  const noPr = buildPayload(ev({}), { topic: 'input', prUrl: 'https://evil.example.com/x' }) as any;
  assert.equal(noPr.embeds[0].fields, undefined);
});

test('Discord: 429 は retry_after 待って再送 / Webhook ごとに直列', async () => {
  assert.equal(retryAfterMs({ retry_after: 1.5 }, null), 1500);
  assert.equal(retryAfterMs(null, '2'), 2000);
  assert.equal(retryAfterMs(null, null), 1000);
  const calls: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const sender = new DiscordSender(
    async (_u, init) => {
      calls.push(JSON.parse(init.body).n);
      n++;
      if (n === 1) return { status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ retry_after: 0.25 }) };
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  const [a, b] = await Promise.all([sender.send('w', 'u', { n: 'a' }), sender.send('w', 'u', { n: 'b' })]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual(calls, ['a', 'a', 'b']);
  assert.deepEqual(sleeps, [250]);
  const failing = new DiscordSender(async () => ({ status: 404, headers: { get: () => null }, text: async () => '' }), async () => {});
  const f = await failing.send('w', 'u', {});
  assert.equal(f.ok, false);
});

// ------------------------------------------------------------ 設定
test('設定: 既定値 / 壊れた値の補正 / 公開形は暗号文を含まない', () => {
  const d = defaultSettings();
  assert.equal(d.windows.enabled, true);
  const s = loadStored({ windows: { topics: ['input', 'bogus'] }, throttleSeconds: -5, discord: [{ id: 'x', name: 'n', webhookEnc: 'ENC', webhookMasked: '…123456' }] });
  assert.deepEqual(s.windows.topics, ['input']);
  assert.equal(s.throttleSeconds, 0);
  const pub = toPublic(s) as any;
  assert.equal(pub.discord[0].webhookEnc, undefined);
  assert.equal(pub.discord[0].webhookMasked, '…123456');
});

test('設定: PUT は新しい URL のときだけ暗号化して差し替え、空なら据え置き。不正な URL は 400', async () => {
  const enc = async (p: string) => `ENC(${p.length})`;
  const url = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABC-123';
  const s1 = await mergeUpdate(defaultSettings(), { discord: [{ id: 'a', name: '全体', webhookUrl: url, topics: ['approval'] }] }, enc);
  assert.equal(s1.discord[0].webhookEnc, `ENC(${url.length})`);
  assert.equal(s1.discord[0].webhookMasked, '…' + url.slice(-6));
  const s2 = await mergeUpdate(s1, { discord: [{ id: 'a', name: '改名', webhookUrl: '', topics: ['input'] }] }, async () => {
    throw new Error('呼ばれないはず');
  });
  assert.equal(s2.discord[0].webhookEnc, s1.discord[0].webhookEnc);
  assert.equal(s2.discord[0].name, '改名');
  await assert.rejects(mergeUpdate(s1, { discord: [{ id: 'b', name: 'x', webhookUrl: 'https://example.com/hook' }] }, enc), /Webhook/);
  await assert.rejects(mergeUpdate(s1, { discord: [{ id: 'c', name: 'URL なし' }] }, enc), /Webhook URL を入力/);
  // discord を省略した PUT は送信先を据え置き
  const s3 = await mergeUpdate(s1, { throttleSeconds: 10 }, enc);
  assert.equal(s3.discord.length, 1);
  assert.equal(s3.throttleSeconds, 10);
});

// ------------------------------------------------------------ NotifyService(結合)
test('NotifyService: emitNotify → 間引き・抑制・Windows の出し先・Discord の送信', async () => {
  const kv = new Map<string, unknown>();
  const store = { getSetting: (k: string) => kv.get(k) ?? null, setSetting: (k: string, v: unknown) => kv.set(k, v) } as any;
  const toasts: string[] = [];
  const posts: any[] = [];
  let desktop = 0;
  const sender = new DiscordSender(async (u, init) => {
    posts.push({ u, body: JSON.parse(init.body) });
    return { status: 204, headers: { get: () => null }, text: async () => '' };
  });
  const svc = new NotifyService({
    store,
    secrets: { protect: async (p) => `enc:${Buffer.from(p).toString('base64')}`, unprotect: async (b) => Buffer.from(b.slice(4), 'base64').toString() },
    session: (id) => (id === 's1' ? ({ id, name: 'login-fix', repoId: 'o/r', branch: 'feat/x' } as any) : undefined),
    desktopClients: () => desktop,
    toaster: async (t) => {
      toasts.push(t.title);
    },
    sender,
  });
  const appToasts: string[] = [];
  const onDesk = (e: NotifyEvent) => appToasts.push(e.title);
  bus.on('notify.desktop', onDesk);
  try {
    process.env.CC_HUB_TEST = '1';
    await svc.putSettings({
      windows: { enabled: true, topics: ['input', 'approval'], suppressWhenViewing: true },
      throttleSeconds: 60,
      discord: [{ id: 'd', name: 'D', webhookUrl: 'http://127.0.0.1:1/hook', topics: ['input', 'approval'] }],
    });
    const flush = () => new Promise((r) => setTimeout(r, 30));
    emitNotify(ev({ kind: 'input', title: '入力待ち: login-fix' }));
    await flush();
    assert.deepEqual(toasts, ['入力待ち: login-fix']); // 未接続 → デーモン
    assert.equal(posts.length, 1);
    assert.equal(posts[0].u, 'http://127.0.0.1:1/hook');
    assert.equal(posts[0].body.embeds[0].fields[0].value, 'login-fix');
    // 間引き: 同じセッション・種類は 60 秒以内は出さない
    emitNotify(ev({ kind: 'input', title: '入力待ち 2' }));
    await flush();
    assert.equal(toasts.length, 1);
    assert.equal(posts.length, 1);
    // デスクトップ接続中 → アプリに出させる
    desktop = 1;
    emitNotify(ev({ kind: 'approval', title: '承認待ち: login-fix' }));
    await flush();
    assert.deepEqual(appToasts, ['承認待ち: login-fix']);
    assert.equal(toasts.length, 1);
    assert.equal(posts.length, 2);
    // 表示中のセッション → どこにも出さない
    svc.setFocus({ sessionId: 's2', focused: true });
    emitNotify(ev({ kind: 'approval', sessionId: 's2', title: '承認待ち: other' }));
    await flush();
    assert.equal(appToasts.length, 1);
    assert.equal(posts.length, 2);
    assert.equal(svc.recent[0].decision.skipped, '表示中のセッション');
    // 保存された設定に平文の URL が無い
    assert.ok(!JSON.stringify(kv.get('notify')).includes('127.0.0.1:1/hook'));
    assert.ok(!JSON.stringify(svc.getSettings()).includes('127.0.0.1:1/hook'));
  } finally {
    bus.off('notify.desktop', onDesk);
    svc.stop();
    delete process.env.CC_HUB_TEST;
  }
});

void Promise.all(pending).then(() => console.log(`\nnotify: ${passed} passed`));
