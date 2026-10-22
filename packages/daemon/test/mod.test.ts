// mod「cc-hub」に渡す状況のまとめ(GET /api/mod/overview)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { PrInfo, SessionInfo } from '@cc-hub/shared';
import { RECENT_STOPPED_MS, buildOverview } from '../src/mod/overview';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const NOW = 10_000_000;
const s = (o: Partial<SessionInfo>): SessionInfo =>
  ({ id: 'x', name: 'x', cwd: '', mode: 'plain', managed: true, status: 'running', createdAt: 0, lastEventAt: NOW, currentTool: null, lastMessage: null, contextPct: null, costUsd: null, model: null, permissionMode: null, approval: null, cols: 80, rows: 24, exitCode: null, repoId: null, worktreeId: null, branch: null, ...o }) as SessionInfo;

const approval = { type: 'options' as const, question: '消しますか?', options: [{ n: '1', label: 'はい', selected: true }] };
const sessions = [
  s({ id: 'me', name: 'ui-fix', cwd: 'D:\\WorkTree\\P\\wt-02', repoId: 'o/r', branch: 'feat/ui' }),
  s({ id: 'a', name: 'api', status: 'awaiting_approval', approval, repoId: 'o/r', branch: 'feat/api', lastEventAt: NOW - 5 }),
  s({ id: 'ext', name: 'ext', managed: false, status: 'awaiting_approval', approval, lastEventAt: NOW - 1 }),
  s({ id: 'old', name: 'old', status: 'stopped', lastEventAt: NOW - RECENT_STOPPED_MS - 1 }),
  s({ id: 'done', name: 'done', status: 'stopped', lastEventAt: NOW - 1000 }),
];
const prs = [{ repoId: 'o/r', number: 7, url: 'u', state: 'OPEN', checks: 'SUCCESS', headRefName: 'feat/api' } as unknown as PrInfo];
const deps = {
  sessions,
  hubIdFor: (id: string) => (id === 'claude-me' ? 'me' : null),
  worktreeByPath: (cwd: string) => (cwd.endsWith('wt-02') ? { id: 'o/r#wt-02', name: 'wt-02' } : undefined),
  occupants: (_w: string, except: string) => (except === 'me' ? ['もう一つ'] : []),
  prs,
};

test('自分(claude の session_id からハブ ID に直す)と作業ツリーの同居', () => {
  const o = buildOverview(deps, { session: 'claude-me' }, NOW);
  assert.equal(o.me?.name, 'ui-fix');
  assert.deepEqual(o.me?.worktree, { name: 'wt-02', occupants: ['もう一つ'] });
});

test('ほかのセッション: 承認待ちが先、古い停止は出さない、PR を付ける、承認のボタンは managed だけ', () => {
  const o = buildOverview(deps, { session: 'me' }, NOW);
  assert.deepEqual(o.sessions.map((x) => x.id), ['ext', 'a', 'done']);
  assert.equal(o.approvals, 2);
  assert.equal(o.sessions.find((x) => x.id === 'a')?.pr?.number, 7);
  assert.equal(o.sessions.find((x) => x.id === 'a')?.approval?.question, '消しますか?');
  assert.equal(o.sessions.find((x) => x.id === 'ext')?.approval, null);
});

test('CC Hub が知らないセッション: me は null、cwd から作業ツリーは見ない', () => {
  const o = buildOverview(deps, { session: 'unknown', cwd: 'C:\\x' }, NOW);
  assert.equal(o.me, null);
  assert.equal(o.sessions.length, 4);
});

console.log(`\nmod: ${passed} passed${process.exitCode ? ', FAILED' : ''}`);
