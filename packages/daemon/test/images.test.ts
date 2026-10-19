// Discord に送る画像(send_images → ターンの終わりの通知のスレッドへ)のテスト。本物の Discord には送らない
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NotifyEvent } from '@cc-hub/shared';
import { IMAGES_MAX, ImageQueue, imagesForm, loadImages, safeName } from '../src/notify/images';
import { DiscordSender } from '../src/notify/discord';
import { NotifyService } from '../src/notify/service';
import { emitNotify } from '../src/notify/emit';
import { callTool, listToolsResult } from '../src/mcp/tools';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-img-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
fs.writeFileSync(path.join(tmp, 'ログイン画面.png'), PNG);
fs.writeFileSync(path.join(tmp, 'mock.jpg'), PNG);
fs.writeFileSync(path.join(tmp, 'note.txt'), 'x');

const flush = () => new Promise((r) => setTimeout(r, 40));
const ev = (o: Partial<NotifyEvent>): NotifyEvent => ({ kind: 'input', sessionId: 's1', title: '入力待ち: ui-fix', body: '終わりました', ts: Date.now(), ...o });

async function main(): Promise<void> {
  await test('loadImages: 相対パスは cwd 基準・形式と存在を確かめる', () => {
    const files = loadImages(['ログイン画面.png', path.join(tmp, 'mock.jpg')], tmp);
    assert.deepEqual(
      files.map((f) => [f.name, f.type, f.data.length]),
      [
        ['01_image.png', 'image/png', PNG.length],
        ['02_mock.jpg', 'image/jpeg', PNG.length],
      ],
    );
    assert.throws(() => loadImages(['note.txt'], tmp), /画像/);
    assert.throws(() => loadImages(['none.png'], tmp), /見つかりません/);
    assert.throws(() => loadImages(['mock.jpg'], null), /cwd/);
    assert.throws(() => loadImages(Array(IMAGES_MAX + 1).fill('mock.jpg'), tmp), /枚まで/);
  });

  await test('safeName: 英数字以外は _ にして番号を付ける', () => {
    assert.equal(safeName('my shot (1).PNG', 2), '03_my_shot_1.png');
  });

  await test('ImageQueue: 何度か預けると足され、番号が続く。取り出すと消える', () => {
    const q = new ImageQueue();
    const f = loadImages(['mock.jpg'], tmp);
    assert.equal(q.add('s1', f, 'ひとつめ'), 1);
    assert.equal(q.add('s1', f, ''), 2);
    assert.throws(() => q.add('s1', Array(IMAGES_MAX - 1).fill(f[0]), ''), /枚まで/);
    const p = q.take('s1')!;
    assert.deepEqual(p.files.map((x) => x.name), ['01_mock.jpg', '02_mock.jpg']);
    assert.deepEqual(p.captions, ['ひとつめ']);
    assert.equal(q.take('s1'), null);
    // 古い預かりは捨てる
    q.add('s2', f, '', 0);
    assert.equal(q.take('s2', 7 * 3600_000), null);
  });

  await test('imagesForm: payload_json と files[n]', () => {
    const form = imagesForm({ content: 'x' }, loadImages(['mock.jpg', 'ログイン画面.png'], tmp));
    const pj = JSON.parse(String(form.get('payload_json')));
    assert.deepEqual(pj.attachments, [
      { id: 0, filename: '01_mock.jpg' },
      { id: 1, filename: '02_image.png' },
    ]);
    assert.ok(form.get('files[1]') instanceof Blob);
  });

  // ------------------------------------------------------------ NotifyService
  const posts: { u: string; json: any; form: FormData | null }[] = [];
  let nextId = 100;
  const sender = new DiscordSender(async (u, init) => {
    const form = init.body instanceof FormData ? init.body : null;
    posts.push({ u, json: form ? JSON.parse(String(form.get('payload_json'))) : JSON.parse(init.body as string), form });
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: String(nextId++), channel_id: '777' }) };
  });
  const bot = {
    connected: true,
    threads: [] as string[][],
    forms: [] as [string, FormData][],
    failPost: false,
  };
  const fakeBot = {
    onInteraction: null,
    connected: () => bot.connected,
    status: () => ({ state: bot.connected ? 'connected' : 'off', user: null, error: null }),
    start: () => undefined,
    stop: () => undefined,
    startThread: async (ch: string, msg: string, name: string) => {
      bot.threads.push([ch, msg, name]);
      return msg;
    },
    postForm: async (ch: string, form: FormData) => {
      if (bot.failPost) throw new Error('Discord が 403 を返しました');
      bot.forms.push([ch, form]);
      return 'm1';
    },
  } as any;
  const kv = new Map<string, unknown>();
  const svc = new NotifyService({
    store: { getSetting: (k: string) => kv.get(k) ?? null, setSetting: (k: string, v: unknown) => kv.set(k, v) } as any,
    secrets: { protect: async (p) => `enc:${Buffer.from(p).toString('base64')}`, unprotect: async (b) => Buffer.from(b.slice(4), 'base64').toString() },
    session: (id) => (id === 's1' ? ({ id, name: 'ui-fix', repoId: 'o/r', branch: 'feat/x' } as any) : undefined),
    desktopClients: () => 0,
    toaster: async () => undefined,
    sender,
    makeBot: () => fakeBot,
  });
  process.env.CC_HUB_TEST = '1';

  await test('送信先が無ければ預からない(409)', () => {
    assert.throws(() => svc.queueImages('s1', loadImages(['mock.jpg'], tmp), ''), /Discord の送信先/);
  });

  await svc.putSettings({
    windows: { enabled: false, topics: [], suppressWhenViewing: true },
    throttleSeconds: 0,
    discord: [{ id: 'd', name: 'D', webhookUrl: 'http://127.0.0.1:1/hook', topics: ['input', 'error'] }],
  });

  await test('入力待ちの通知を送ったら、その通知からスレッドを作って画像を置く(Bot)', async () => {
    posts.length = 0;
    assert.equal(svc.queueImages('s1', loadImages(['ログイン画面.png', 'mock.jpg'], tmp), 'ログイン画面のモックです'), 2);
    // 承認待ちでは送らない(ターンの途中)
    emitNotify(ev({ kind: 'approval', title: '承認待ち: ui-fix' }));
    await flush();
    assert.equal(bot.forms.length, 0);
    emitNotify(ev({}));
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].form, null);
    assert.deepEqual(bot.threads, [['777', '100', 'ui-fix の画像']]);
    assert.equal(bot.forms.length, 1);
    assert.equal(bot.forms[0][0], '100');
    const pj = JSON.parse(String(bot.forms[0][1].get('payload_json')));
    assert.equal(pj.content, '🖼 ui-fix の画像(2 枚)\nログイン画面のモックです');
    assert.equal(pj.attachments.length, 2);
    // 次のターンには残らない
    emitNotify(ev({ title: '入力待ち 2' }));
    await flush();
    assert.equal(bot.forms.length, 1);
  });

  await test('Bot が使えなければ、通知の直後に同じ Webhook で画像を送る', async () => {
    posts.length = 0;
    bot.connected = false;
    svc.queueImages('s1', loadImages(['mock.jpg'], tmp), '');
    emitNotify(ev({}));
    await flush();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].form, null);
    assert.ok(posts[1].form);
    assert.equal(posts[1].u, 'http://127.0.0.1:1/hook?wait=true');
    assert.equal(posts[1].json.attachments[0].filename, '01_mock.jpg');
    bot.connected = true;
  });

  await test('スレッドに送れなければ Webhook で送る', async () => {
    posts.length = 0;
    bot.failPost = true;
    svc.queueImages('s1', loadImages(['mock.jpg'], tmp), '');
    emitNotify(ev({ kind: 'error', title: 'エラー: ui-fix' }));
    await flush();
    assert.equal(posts.length, 2);
    assert.ok(posts[1].form);
    bot.failPost = false;
  });

  await test('通知を送らなかったとき(画面の前にいる)は画像だけ送る', async () => {
    posts.length = 0;
    svc.setFocus({ sessionId: 's1', focused: true, active: true });
    svc.queueImages('s1', loadImages(['mock.jpg'], tmp), 'これだけ');
    emitNotify(ev({}));
    await flush();
    assert.equal(posts.length, 1);
    assert.ok(posts[0].form);
    assert.match(posts[0].json.content, /これだけ/);
    svc.setFocus({ sessionId: null, focused: false });
  });

  await test('MCP の send_images: 一覧に出て、セッションに預ける', async () => {
    const t = (listToolsResult().tools as any[]).find((x) => x.name === 'send_images');
    assert.deepEqual(t.inputSchema.properties.paths.items, { type: 'string' });
    const queued: unknown[] = [];
    const deps = {
      sessions: () => ({ s1: { id: 's1', name: 'ui-fix', cwd: tmp, status: 'running', lastEventAt: 1 } }),
      images: { queue: (...a: unknown[]) => (queued.push(a), 3) },
    } as any;
    const r: any = await callTool('send_images', { cwd: tmp, paths: ['mock.jpg'], caption: '見て' }, deps, { sessionId: null });
    assert.equal(r.queued, 3);
    assert.deepEqual(queued, [['s1', ['mock.jpg'], tmp, '見て']]);
    await assert.rejects(callTool('send_images', { cwd: tmp, paths: Array(IMAGES_MAX + 1).fill('a.png') }, deps, { sessionId: null }), /個まで/);
  });

  svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nimages: ${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
