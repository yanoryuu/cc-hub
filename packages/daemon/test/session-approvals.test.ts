// Discord のセッション承認ボタン(選択肢をボタンにする・古いボタンは答えない)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { Approval, SessionInfo } from '@cc-hub/shared';
import { SessionApprovals, buttons, choices, parseCustomId } from '../src/notify/session-approvals';

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  const p = (async () => {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}\n     ${(e as Error).message}`);
      process.exitCode = 1;
    }
  })();
  pending.push(p);
}

const opts: Approval = {
  type: 'options',
  question: 'Do you want to proceed?',
  options: [
    { n: '1', label: 'Yes', selected: true },
    { n: '2', label: "Yes, and don't ask again for git commands", selected: false },
    { n: '3', label: 'No, and tell Claude what to do differently', selected: false },
  ],
};

test('選択肢をボタンにする(はい = 緑 / いいえ = 赤 / それ以外 = 灰)', () => {
  const rows = buttons('sid-1', 7, opts) as any[];
  assert.equal(rows.length, 1);
  const b = rows[0].components;
  assert.deepEqual(b.map((x: any) => x.label), ['1. Yes', "2. Yes, and don't ask again for git commands", '3. No, and tell Claude what to do differently']);
  assert.deepEqual(b.map((x: any) => x.style), [3, 3, 4]);
  assert.deepEqual(parseCustomId(b[1].custom_id), { sessionId: 'sid-1', seq: 7, n: '2' });
  assert.deepEqual(choices({ type: 'yn', question: 'q', options: [] }).map((c) => c.n), ['y', 'n']);
  const many: Approval = { type: 'options', question: 'q', options: Array.from({ length: 7 }, (_, i) => ({ n: String(i + 1), label: `opt ${i}`, selected: false })) };
  assert.equal((buttons('s', 1, many) as any[]).length, 2);
});

test('承認待ちで投稿し、押したら答える。古いボタンは答えない', async () => {
  const s: SessionInfo = { id: 'sid-1', name: 'demo', managed: true, status: 'awaiting_approval', approval: opts } as any;
  const posts: any[] = [];
  const edits: any[] = [];
  const responds: any[] = [];
  const answered: string[] = [];
  const sa = new SessionApprovals({
    channelId: () => '123',
    allowed: (u) => u === 'me',
    session: () => s,
    post: async (_ch, body) => {
      posts.push(body);
      return `m${posts.length}`;
    },
    edit: async (_ch, id, body) => void edits.push({ id, body }),
    respond: async (_i, type, data) => void responds.push({ type, data }),
  });
  sa.setApprove((id, n) => void answered.push(`${id}:${n}`));
  sa.onState({ t: 'session.upsert', session: s });
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(posts.length, 1);
  const id = (posts[0].components[0].components[0] as any).custom_id;
  const click = (customId: string, userId = 'me') => sa.onInteraction({ kind: 'button', id: 'i', token: 't', customId, command: '', userId, userName: 'u', channelId: '123', messageId: 'm1' });
  await click(id, 'other');
  assert.equal(answered.length, 0);
  await click(id);
  assert.deepEqual(answered, ['sid-1:1']);
  assert.match(responds.at(-1).data.content, /「1\. Yes」を選びました/);
  // 同じボタンをもう一度押しても答えない
  await click(id);
  assert.equal(answered.length, 1);
  // 答えた直後に同じ承認が残っていても、もう一度は出さない
  sa.onState({ t: 'session.upsert', session: s });
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(posts.length, 1);
  // 次の承認待ちは出す。終わったらボタンを外す
  s.approval = { ...opts, question: 'Run npm test?' };
  sa.onState({ t: 'session.upsert', session: s });
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(posts.length, 2);
  sa.onState({ t: 'session.upsert', session: { ...s, status: 'running', approval: null } as any });
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].body.components, []);
  sa.stop();
});

void Promise.all(pending).then(() => console.log(`\nsession-approvals: ${passed} passed`));
