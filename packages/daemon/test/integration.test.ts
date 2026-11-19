// 外部連携(連携トークン・スコープ・起動の回数制限・SSE・Webhook)のテスト。本物の Claude は起動しない
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { HistoryMessage, SessionInfo, StartSessionRequest } from '@cc-hub/shared';
import { bus } from '../src/bus';
import { IntegrationTokens } from '../src/integration/tokens';
import { IntegrationEvents, type WebhookPost } from '../src/integration/events';
import { INTEGRATION_START_MAX, handleIntegration, lastAssistantText, resetIntegrationStartLog, type IntegrationDeps } from '../src/integration/api';
import { HttpError } from '../src/util';

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

const parent = fs.existsSync('D:\\AITEST') ? 'D:\\AITEST' : os.tmpdir();
const dir = fs.mkdtempSync(path.join(parent, 'cchub-integ-'));
const FOLDER = path.join(dir, 'proj');
fs.mkdirSync(FOLDER);

function sess(id: string, status: SessionInfo['status'], extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name: `s-${id}`, cwd: FOLDER, status, createdAt: 1, lastEventAt: 2, lastMessage: 'hi', managed: true, ...extra } as SessionInfo;
}

async function main(): Promise<void> {
  const tokens = new IntegrationTokens(dir);
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fakePost: WebhookPost = async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  const sessions: Record<string, SessionInfo> = { a: sess('a', 'idle') };
  const events = new IntegrationEvents(tokens, Object.values(sessions), fakePost);
  const started: StartSessionRequest[] = [];
  const msgs: HistoryMessage[] = [
    { role: 'user', text: '直して', ts: 1 },
    { role: 'assistant', text: '直しました。', ts: 2 },
    { role: 'tool', text: 'Edit', ts: 3 },
    { role: 'assistant', text: '詳細はこちら', ts: 4 },
  ];
  const deps: IntegrationDeps = {
    tokens,
    events,
    sessions: () => Object.values(sessions),
    session: (id) => sessions[id],
    repos: () => [{ id: 'cc-hub', name: 'cc-hub', status: 'ready' } as never, { id: 'dup1', name: 'Dup', status: 'ready' } as never, { id: 'dup2', name: 'dup', status: 'ready' } as never],
    folders: () => [{ path: FOLDER, addedAt: 1 }],
    modes: () => [{ id: 'plain', label: '通常', description: '', prompt: '' } as never],
    start: (req) => {
      started.push(req);
      const s = sess(`n${started.length}`, 'starting', { cwd: req.cwd, repoId: req.repoId ?? null, name: req.name ?? 'x' });
      sessions[s.id] = s;
      return s;
    },
    messages: () => msgs,
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    handleIntegration(deps, req, res, url)
      .then((h) => {
        if (!h) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((e) => {
        res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const call = async (p: string, token: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await fetch(base + p, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  let full = '';
  let readOnly = '';
  let startOnly = '';

  try {
    await test('発行: 名前とスコープを検査し、トークンは一度だけ返して保存はハッシュのみ', () => {
      assert.throws(() => tokens.create({ name: '', scopes: ['state:read'] }), /名前/);
      assert.throws(() => tokens.create({ name: 'x', scopes: ['admin'] }), /scopes/);
      assert.throws(() => tokens.create({ name: 'x', scopes: ['state:read'], webhookUrl: 'file:///c:/x' }), /http/);
      const a = tokens.create({ name: 'ジャービス', scopes: ['sessions:start', 'state:read'], webhookUrl: 'http://127.0.0.1:9/hook' });
      full = a.token;
      assert.match(full, /^cch_[0-9a-f]{4}_/);
      assert.ok(a.webhookSecret);
      readOnly = tokens.create({ name: '見るだけ', scopes: ['state:read'] }).token;
      startOnly = tokens.create({ name: '起動だけ', scopes: ['sessions:start'] }).token;
      const file = fs.readFileSync(path.join(dir, 'integrations.json'), 'utf8');
      assert.ok(!file.includes(full) && !file.includes(readOnly));
      const listed = JSON.stringify(tokens.list());
      assert.ok(!listed.includes('hash') && !listed.includes('Secret'));
      // 作り直しても読める
      assert.equal(new IntegrationTokens(dir).list().length, 3);
    });

    await test('認証: トークンなし・違うトークンは 401、プロキシ経由は 403、スコープ外は 403', async () => {
      assert.equal((await call('/api/integration/sessions', null)).status, 401);
      assert.equal((await call('/api/integration/sessions', 'cch_0000_nope')).status, 401);
      assert.equal((await call('/api/integration/sessions', full, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
      assert.equal((await call('/api/integration/sessions', startOnly)).status, 403);
      assert.equal((await call('/api/integration/sessions', readOnly, { body: { project: 'cc-hub', instruction: 'x' } })).status, 403);
    });

    await test('読み取り: プロジェクト・セッション一覧・1 件・最後の発言', async () => {
      const pj = await call('/api/integration/projects', readOnly);
      assert.equal(pj.status, 200);
      assert.deepEqual(pj.body.folders, [{ path: FOLDER }]);
      const ls = await call('/api/integration/sessions', readOnly);
      assert.equal(ls.body.sessions[0].id, 'a');
      assert.ok(!('managed' in ls.body.sessions[0]));
      assert.equal((await call('/api/integration/sessions/a', readOnly)).body.session.status, 'idle');
      assert.equal((await call('/api/integration/sessions/zzz', readOnly)).status, 404);
      const lm = await call('/api/integration/sessions/a/last-message', readOnly);
      assert.equal(lm.body.text, '直しました。\n\n詳細はこちら');
      assert.equal(lm.body.at, 4);
    });

    await test('lastAssistantText: 最後のユーザー発言より後だけ / 無ければ null', () => {
      assert.deepEqual(lastAssistantText([{ role: 'user', text: 'q', ts: 1 }]), { text: null, at: null });
      assert.equal(lastAssistantText([{ role: 'assistant', text: 'old', ts: 1 }, { role: 'user', text: 'q', ts: 2 }, { role: 'assistant', text: 'new', ts: 3 }]).text, 'new');
    });

    await test('起動: 登録済みのプロジェクトだけ・引数の検査・回数制限', async () => {
      resetIntegrationStartLog();
      assert.equal((await call('/api/integration/sessions', full, { body: { project: 'C:\\Windows', instruction: 'x' } })).status, 404);
      assert.equal((await call('/api/integration/sessions', full, { body: { project: 'dup', instruction: 'x' } })).status, 400);
      assert.equal((await call('/api/integration/sessions', full, { body: { project: 'cc-hub', instruction: '' } })).status, 400);
      assert.equal((await call('/api/integration/sessions', full, { body: { project: 'cc-hub', instruction: 'x', mode: 'evil' } })).status, 400);
      assert.equal((await call('/api/integration/sessions', full, { body: { project: 'cc-hub', instruction: 'x', model: 'gpt' } })).status, 400);
      assert.equal(started.length, 0);
      const r1 = await call('/api/integration/sessions', full, { body: { project: 'CC-HUB', instruction: 'README を直して', name: 'jarvis' } });
      assert.equal(r1.status, 200);
      assert.equal(started[0].repoId, 'cc-hub');
      assert.equal(started[0].mode, 'plain');
      const r2 = await call('/api/integration/sessions', startOnly, { body: { project: FOLDER.toUpperCase() + '\\', instruction: 'y' } });
      assert.equal(r2.status, 200);
      assert.equal(started[1].cwd, FOLDER);
      assert.equal(started[1].repoId, undefined);
      // full はあと 4 回で上限、6 回目は 429。startOnly は別に数える
      for (let i = 1; i < INTEGRATION_START_MAX; i++) assert.equal((await call('/api/integration/sessions', full, { body: { project: 'cc-hub', instruction: 'z' } })).status, 200);
      const over = await call('/api/integration/sessions', full, { body: { project: 'cc-hub', instruction: 'z' } });
      assert.equal(over.status, 429);
      assert.match(over.body.error, /多すぎます/);
      assert.equal((await call('/api/integration/sessions', startOnly, { body: { project: 'cc-hub', instruction: 'w' } })).status, 200);
    });

    await test('SSE: hello で一覧、status が変わったときだけ session.status が届く', async () => {
      const ctl = new AbortController();
      const r = await fetch(`${base}/api/integration/events`, { headers: { Authorization: `Bearer ${readOnly}` }, signal: ctl.signal });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = r.body!.getReader();
      let buf = '';
      const until = async (re: RegExp) => {
        const t0 = Date.now();
        while (!re.test(buf)) {
          if (Date.now() - t0 > 3000) throw new Error(`timeout waiting ${re}: ${buf}`);
          const { value } = await reader.read();
          buf += new TextDecoder().decode(value);
        }
      };
      await until(/event: hello/);
      assert.equal(events.subscribers, 1);
      posts.length = 0;
      bus.state({ t: 'session.upsert', session: sess('a', 'idle') }); // 変化なし
      bus.state({ t: 'session.upsert', session: sess('a', 'running') });
      await until(/event: session\.status/);
      const data = JSON.parse(/event: session\.status\nid: [^\n]+\ndata: (.+)\n/.exec(buf)![1]);
      assert.equal(data.previousStatus, 'idle');
      assert.equal(data.session.status, 'running');
      assert.equal((buf.match(/event: session\.status/g) ?? []).length, 1);
      ctl.abort();
      await new Promise((r2) => setTimeout(r2, 100));
      assert.equal(events.subscribers, 0);
    });

    await test('Webhook: state:read を持つトークンにだけ、HMAC 署名付きで送る', async () => {
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(posts.length, 1);
      const p = posts[0];
      assert.equal(p.url, 'http://127.0.0.1:9/hook');
      assert.equal(p.headers['X-CC-Hub-Event'], 'session.status');
      // 秘密鍵は発行時にしか返らないので、作り直して検証する
      const id = tokens.list().find((t) => t.name === 'ジャービス')!.id;
      const { webhookSecret } = tokens.setWebhook(id, 'http://127.0.0.1:9/hook2');
      posts.length = 0;
      bus.state({ t: 'session.upsert', session: sess('a', 'awaiting_input') });
      await new Promise((r) => setTimeout(r, 50));
      const sig = crypto.createHmac('sha256', webhookSecret!).update(posts[0].body).digest('hex');
      assert.equal(posts[0].headers['X-CC-Hub-Signature-256'], `sha256=${sig}`);
      assert.equal(JSON.parse(posts[0].body).session.status, 'awaiting_input');
    });

    await test('無効化したトークンは 401', async () => {
      const id = tokens.list().find((t) => t.name === '見るだけ')!.id;
      tokens.revoke(id);
      assert.equal((await call('/api/integration/sessions', readOnly)).status, 401);
      assert.throws(() => tokens.revoke(id), /見つかりません/);
    });
  } finally {
    events.dispose();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nintegration: ${passed} passed`);
}

main().catch((e) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
