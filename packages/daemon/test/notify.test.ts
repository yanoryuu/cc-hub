// 通知の振り分け(種類・絞り込み・間引き・表示中の抑制・Windows の出し先)と Discord(URL の検証・本文)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { DeployJob, NotifyEvent, NotifySettings } from '@cc-hub/shared';
import { Throttle, prTopic, route, throttleKey, topicOf } from '../src/notify/topic';
import { DESCRIPTION_MAX, DiscordSender, buildPayload, maskWebhook, redact, retryAfterMs, validateWebhookUrl } from '../src/notify/discord';
import { defaultSettings, loadStored, mergeUpdate, toPublic } from '../src/notify/settings';
import { NotifyService } from '../src/notify/service';
import { emitNotify } from '../src/notify/emit';
import { bus } from '../src/bus';
import { BOT_COMMANDS, parseInteraction, parseReply, splitMessage } from '../src/notify/bot';
import { formatStatus } from '../src/notify/status';
import { artifactFromHook, htmlToText } from '../src/notify/artifact';
import { RestartScheduler } from '../src/restart/scheduler';
import { DeployApprovals, buttons, cardText, customId, parseCustomId } from '../src/notify/approvals';
import { HISTORY_TURNS, btwPrompt, decideReply } from '../src/notify/replies';

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
    assert.equal(posts[0].u, 'http://127.0.0.1:1/hook?wait=true');
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

// ------------------------------------------------------------ Discord Bot(通知への返信)
test('Bot: 人のメッセージを拾う(返信先 / スレッドへの書き込み。Bot の発言は無視)', () => {
  const base = { id: 'm2', channel_id: 'c1', content: ' はい ', author: { id: '111', username: 'me' }, message_reference: { message_id: 'm1' } };
  assert.deepEqual(parseReply(base), { refMessageId: 'm1', channelId: 'c1', messageId: 'm2', authorId: '111', authorName: 'me', content: 'はい' });
  assert.equal(parseReply({ ...base, author: { id: '2', bot: true } }), null);
  // 返信ではない書き込み(スレッド内など)は返信先なし
  assert.equal(parseReply({ ...base, message_reference: undefined })?.refMessageId, null);
  assert.equal(parseReply(null), null);
});

test('Bot: 続けての質問にはそれまでのやり取りを渡す', () => {
  assert.ok(!btwPrompt('Q').includes('やり取り'));
  const p = btwPrompt('次は?', [
    { q: '何を直した?', a: 'ログインを直しました' },
    { q: 'テストは?', a: '通っています' },
  ]);
  assert.ok(p.includes('Q: 何を直した?') && p.includes('A: 通っています'));
  assert.ok(p.endsWith('次は?'));
  // 古いやり取りは HISTORY_TURNS 件まで
  const many = Array.from({ length: 10 }, (_, i) => ({ q: `q${i}`, a: `a${i}` }));
  const p2 = btwPrompt('x', many);
  assert.ok(!p2.includes('Q: q0') && p2.includes(`Q: q${10 - 1}`) && p2.includes(`Q: q${10 - HISTORY_TURNS}`));
});

test('Bot: 長い答えは分けて送る', () => {
  assert.deepEqual(splitMessage('短い'), ['短い']);
  const long = Array.from({ length: 100 }, (_, i) => `${i} ${'x'.repeat(60)}`).join('\n');
  const parts = splitMessage(long, 1000, 3);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 1000 + 30));
  assert.ok(parts[2].endsWith('(長いので省略しました)'));
});

test('Bot: 返信はすべて横からの質問(先頭の /btw は取り除く)', () => {
  const info = (status: string) => ({ id: 's', name: 'n', status, approval: null }) as any;
  assert.deepEqual(decideReply(undefined, 'x'), { kind: 'missing' });
  assert.deepEqual(decideReply(info('awaiting_input'), ' 続けて '), { kind: 'btw', text: '続けて' });
  assert.deepEqual(decideReply(info('awaiting_approval'), '1'), { kind: 'btw', text: '1' });
  assert.deepEqual(decideReply(info('running'), '/btw 今なにしてる?'), { kind: 'btw', text: '今なにしてる?' });
  assert.deepEqual(decideReply(info('stopped'), '/BTW'), { kind: 'btw', text: '' });
  assert.ok(btwPrompt('Q').endsWith('Q'));
});

test('Bot: 設定(トークンは暗号化 / 形式チェック / 削除 / トークン無しでは有効にできない)', async () => {
  const enc = async (p: string) => `enc:${p}`;
  const token = 'test-fake-bot-token-0000.dummy.not-a-real-secret-0000';
  const s1 = await mergeUpdate(defaultSettings(), { bot: { enabled: true, token: `Bot ${token}`, allowedUserIds: '123456789012345678, abc' } }, enc);
  assert.equal(s1.bot.tokenEnc, `enc:${token}`);
  assert.deepEqual(s1.bot.allowedUserIds, ['123456789012345678']);
  assert.deepEqual(toPublic(s1).bot, { enabled: true, allowedUserIds: ['123456789012345678'], hasToken: true, approvalChannelId: '' });
  assert.ok(!JSON.stringify(toPublic(s1)).includes(token));
  // token を送らなければ据え置き
  const s2 = await mergeUpdate(s1, { bot: { enabled: false } }, enc);
  assert.equal(s2.bot.tokenEnc, s1.bot.tokenEnc);
  assert.equal(s2.bot.enabled, false);
  // bot を送らなければ全部据え置き
  assert.deepEqual((await mergeUpdate(s1, { throttleSeconds: 5 }, enc)).bot, s1.bot);
  await assert.rejects(mergeUpdate(s1, { bot: { token: 'not-a-token' } }, enc));
  await assert.rejects(mergeUpdate(defaultSettings(), { bot: { enabled: true } }, enc));
  const s3 = await mergeUpdate(s1, { bot: { enabled: false, clearToken: true } }, enc);
  assert.equal(s3.bot.tokenEnc, '');
  assert.deepEqual(loadStored(JSON.parse(JSON.stringify(s1))).bot, s1.bot);
});

// ------------------------------------------------------------ 承認ボタン(アップロード / Firebase デプロイ)
const job = (o: Partial<DeployJob> = {}): DeployJob =>
  ({
    id: 'j1',
    serverId: 'sv',
    serverName: 'ポートフォリオ本番',
    localDir: 'D:/site/dist',
    requestedBy: { kind: 'claude', sessionId: 's1', sessionName: 'login-fix' },
    note: '修正を反映',
    state: 'pending_approval',
    buildCommand: null,
    plan: null,
    progress: null,
    log: [],
    error: null,
    createdAt: 1,
    finishedAt: null,
    url: null,
    ...o,
  }) as DeployJob;

test('承認ボタン: custom_id とボタン・本文', () => {
  assert.deepEqual(parseCustomId(customId('approve', 'abc:1')), { action: 'approve', jobId: 'abc:1' });
  assert.equal(parseCustomId('other:x'), null);
  assert.equal(parseCustomId('cchub:deploy:drop:j1'), null);
  const b = buttons(job()) as any[];
  assert.deepEqual(b[0].components.map((c: any) => c.label), ['承認', '却下']);
  const fb = job({ state: 'preview_ready', firebase: { projectId: 'p', projectDir: 'd', targets: ['hosting'], preview: true, channel: 'c', previewUrl: 'https://p--c.web.app', previewExpiresAt: null, promoted: false } });
  assert.deepEqual((buttons(fb) as any[])[0].components.map((c: any) => c.label), ['本番に反映', 'やめる']);
  assert.ok(cardText(job()).includes('アップロードの承認'));
  assert.ok(cardText(job()).includes('login-fix'));
  assert.ok(cardText(fb).includes('https://p--c.web.app'));
  assert.deepEqual(parseInteraction({ type: 3, id: 'i', token: 't', channel_id: 'c', message: { id: 'm' }, data: { custom_id: 'x' }, member: { user: { id: '1', username: 'me' } } }), {
    kind: 'button', id: 'i', token: 't', customId: 'x', command: '', userId: '1', userName: 'me', channelId: 'c', messageId: 'm',
  });
  assert.equal(parseInteraction({ type: 4, id: 'i', token: 't' }), null);
});

test('承認ボタン: 投稿 → 押して承認 / 許可されていない人 / CC Hub で先に操作', async () => {
  const posts: any[] = [];
  const edits: any[] = [];
  const responses: any[] = [];
  const calls: string[] = [];
  const ap = new DeployApprovals({
    channelId: () => 'C1',
    allowed: (u) => u === 'me',
    post: async (ch, body) => {
      posts.push({ ch, body });
      return `m${posts.length}`;
    },
    edit: async (ch, id, body) => {
      edits.push({ ch, id, body });
    },
    respond: async (_i, type, data) => {
      responses.push({ type, data });
    },
  });
  ap.setActions({
    approve: (id) => (calls.push(`approve:${id}`), job({ id, state: 'planning' })),
    reject: (id) => (calls.push(`reject:${id}`), job({ id, state: 'rejected' })),
    promote: (id) => (calls.push(`promote:${id}`), job({ id, state: 'uploading' })),
    cancel: (id) => (calls.push(`cancel:${id}`), job({ id, state: 'cancelled' })),
  });
  const flush = () => new Promise((r) => setTimeout(r, 10));
  ap.onState({ t: 'deploy.upsert', deploy: job() });
  ap.onState({ t: 'deploy.upsert', deploy: job() }); // 同じ状態では投稿し直さない
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].ch, 'C1');
  const click = (customIdStr: string, userId: string) =>
    ap.onInteraction({ kind: 'button', command: '', id: 'i', token: 't', customId: customIdStr, userId, userName: userId, channelId: 'C1', messageId: 'm1' });
  // 許可されていない人 → 本人にだけ見えるメッセージ、操作しない
  await click(customId('approve', 'j1'), 'other');
  assert.equal(calls.length, 0);
  assert.equal(responses[0].type, 4);
  assert.equal(responses[0].data.flags, 64);
  // 承認 → メッセージを書き換えてボタンを外す
  await click(customId('approve', 'j1'), 'me');
  assert.deepEqual(calls, ['approve:j1']);
  assert.equal(responses[1].type, 7);
  assert.deepEqual(responses[1].data.components, []);
  assert.ok(responses[1].data.content.includes('承認しました'));
  // その後の状態の変化ではメッセージを書き換えない
  ap.onState({ t: 'deploy.upsert', deploy: job({ state: 'uploading' }) });
  await flush();
  assert.equal(edits.length, 0);
  // 別の申請を CC Hub で却下 → Discord のボタンを外す
  ap.onState({ t: 'deploy.upsert', deploy: job({ id: 'j2' }) });
  await flush();
  ap.onState({ t: 'deploy.upsert', deploy: job({ id: 'j2', state: 'rejected' }) });
  await flush();
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].body.components, []);
  assert.ok(edits[0].body.content.includes('CC Hub で操作'));
  // 操作に失敗(状態が変わっていた)→ 本人にだけエラー
  ap.setActions({ ...{ approve: () => { throw new Error('承認待ちではありません'); } }, reject: () => null, promote: () => null, cancel: () => null } as any);
  await click(customId('approve', 'j3'), 'me');
  assert.equal(responses[2].type, 4);
  assert.ok(responses[2].data.content.includes('承認待ちではありません'));
});

test('承認ボタン: チャンネル ID の設定', async () => {
  const enc = async (p: string) => `enc:${p}`;
  const s1 = await mergeUpdate(defaultSettings(), { bot: { approvalChannelId: ' 123456789012345678 ' } }, enc);
  assert.equal(s1.bot.approvalChannelId, '123456789012345678');
  assert.equal(toPublic(s1).bot?.approvalChannelId, '123456789012345678');
  assert.equal((await mergeUpdate(s1, { bot: { approvalChannelId: 'abc' } }, enc)).bot.approvalChannelId, '');
  assert.equal((await mergeUpdate(s1, { bot: { enabled: false } }, enc)).bot.approvalChannelId, '123456789012345678');
});

// ------------------------------------------------------------ /status と再起動の予約
test('/status: セッションを状態ごとにまとめ、アップロードの承認待ちと再起動の予約も出す', () => {
  const s = (name: string, status: string, o: any = {}) => ({ id: name, name, status, lastEventAt: 0, currentTool: null, approval: null, ...o }) as any;
  const text = formatStatus({
    sessions: [
      s('A', 'running', { currentTool: { name: 'Edit', target: 'a.ts' } }),
      s('B', 'awaiting_approval', { approval: { question: 'Bash を実行しますか?' } }),
      s('C', 'awaiting_input', { lastEventAt: 0 }),
      s('D', 'stopped'),
    ],
    deploys: [job()],
    restart: { state: 'waiting', build: true, requestedAt: 1, busy: ['A'], error: null },
    now: 30 * 60_000,
  });
  assert.ok(text.includes('⏳ 承認待ち 1') && text.includes('Bash を実行しますか?'));
  assert.ok(text.includes('▶ 実行中 1') && text.includes('Edit: a.ts'));
  assert.ok(text.includes('💬 入力待ち 1') && text.includes('30 分前'));
  assert.ok(!text.includes('**D**'));
  assert.ok(text.includes('📦 アップロードの承認待ち 1'));
  assert.ok(text.includes('再起動の予約') && text.includes('(A)'));
  assert.ok(formatStatus({ sessions: [], deploys: [], restart: null, now: 0 }).includes('動いているセッションはありません'));
});

test('/status: スラッシュコマンドの解析', () => {
  const i = parseInteraction({ type: 2, id: 'i', token: 't', channel_id: 'c', data: { name: 'status' }, member: { user: { id: '1', username: 'me' } } });
  assert.equal(i?.kind, 'command');
  assert.equal(i?.command, 'status');
  assert.equal(BOT_COMMANDS[0].name, 'status');
});

test('再起動の予約: 作業が無い状態が続いたら再起動 / 取り消し / すぐ', async () => {
  let busy = ['A'];
  const launched: boolean[] = [];
  const r = new RestartScheduler({ busy: () => busy, script: process.execPath, logFile: 'x.log', launch: (_s, build) => launched.push(build) });
  assert.equal(r.status().state, 'idle');
  r.request({ when: 'idle', build: false });
  assert.equal(r.status().state, 'waiting');
  assert.deepEqual(r.status().busy, ['A']);
  (r as any).tick();
  assert.equal(launched.length, 0);
  busy = [];
  (r as any).tick(); // request 直後の 1 回 + ここで 2 回目 → まだ(作業中だったのでリセット済み)
  assert.equal(launched.length, 0);
  (r as any).tick();
  assert.deepEqual(launched, [false]);
  assert.equal(r.status().state, 'restarting');
  assert.throws(() => r.cancel());
  const r2 = new RestartScheduler({ busy: () => ['B'], script: process.execPath, logFile: 'x.log', launch: () => launched.push(true) });
  r2.request({ when: 'idle' });
  assert.equal(r2.cancel().state, 'idle');
  r2.request({ when: 'now' });
  assert.equal(launched.length, 2);
  assert.throws(() => new RestartScheduler({ busy: () => [], script: 'Z:/none.ps1', logFile: 'x.log', launch: () => undefined }).request({}));
  r.stop();
  r2.stop();
});

test('artifact: 公開の hooks から URL・タイトルを取り出す', () => {
  const url = 'https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab';
  const base = { hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: { file_path: 'C:/x/report-page.html', description: '説明' } };
  const a = artifactFromHook({ ...base, tool_response: { content: [{ type: 'text', text: `Published: ${url}` }] } });
  assert.deepEqual(a, { url, title: 'report-page', description: '説明', filePath: 'C:/x/report-page.html' });
  assert.equal(artifactFromHook({ ...base, tool_response: `ok ${url}` })?.url, url);
  // 公開以外(read / 素材のアップロード)・別のツール・URL なしは対象外
  assert.equal(artifactFromHook({ ...base, tool_input: { action: 'read', url }, tool_response: url }), null);
  assert.equal(artifactFromHook({ ...base, tool_input: { url, asset: true, file_path: 'a.png' }, tool_response: url }), null);
  assert.equal(artifactFromHook({ ...base, tool_name: 'Write', tool_response: url }), null);
  assert.equal(artifactFromHook({ ...base, tool_response: 'failed' }), null);
});

test('artifact: HTML から本文を取り出す', () => {
  const r = htmlToText('<html><head><title>週報 &amp; 計画</title><style>p{}</style></head><body><h1>見出し</h1><script>x()</script><p>本文 &lt;1&gt;</p><ul><li>A</li></ul></body></html>');
  assert.equal(r.title, '週報 & 計画');
  assert.equal(r.text, '見出し\n本文 <1>\n・A');
});

test('artifact: 既存の Discord 送信先に種類を足し、本文は長めに載せる', () => {
  const old = loadStored({ discord: [{ id: 'a', name: 'x', webhookMasked: '', webhookEnc: 'e', repoIds: [], topics: ['approval'] }] });
  assert.deepEqual(old.discord[0].topics, ['approval', 'artifact']);
  const kept = loadStored({ topicsRev: 2, discord: [{ id: 'a', name: 'x', webhookMasked: '', webhookEnc: 'e', repoIds: [], topics: ['approval'] }] });
  assert.deepEqual(kept.discord[0].topics, ['approval']);
  const url = 'https://claude.ai/code/artifact/abc';
  const p = buildPayload({ kind: 'done', sessionId: 's', title: 'アーティファクト: t', body: 'あ'.repeat(1000), ts: 1 }, { topic: 'artifact', url, descriptionMax: 2000 }) as any;
  assert.equal(p.embeds[0].url, url);
  assert.equal(p.embeds[0].description.length, 1000);
  assert.equal(topicOf({ kind: 'done', sessionId: 's', title: 't', body: '', ts: 1 }, { topic: 'artifact' }), 'artifact');
});

void Promise.all(pending).then(() => console.log(`\nnotify: ${passed} passed`));
