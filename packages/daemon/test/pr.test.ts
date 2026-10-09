// PR まわりの純粋ロジックのテスト(チェック状態の集計 / 差分 → 通知 / run id / 修正指示 / git 出力の解析)。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { PrInfo } from '@cc-hub/shared';
import {
  FIX_MAX_BYTES,
  buildCreatePrInstruction,
  buildFixInstruction,
  diffPrEvents,
  extractRunId,
  keepPr,
  mapChecks,
  toPrInfo,
  trimLog,
} from '../src/github/pr';
import { parseLeftRight, parseShortstat, parseStatusV2 } from '../src/repo/gitstat';
import { parseRefs } from '../src/repo/branches';

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

// ---------------------------------------------------------------- statusCheckRollup → CheckState
const run = (name: string, status: string, conclusion: string, id = 111) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/999`,
  workflowName: 'CI',
});
const ctx = (context: string, state: string) => ({ __typename: 'StatusContext', context, state, targetUrl: 'https://ci.example.com/x' });

test('チェックが無い → none', () => {
  assert.deepEqual(mapChecks([]), { checks: 'none', summary: { passed: 0, failed: 0, pending: 0 }, failed: [] });
  assert.equal(mapChecks(null).checks, 'none');
});

test('全部成功(SKIPPED / NEUTRAL も成功扱い)→ success', () => {
  const r = mapChecks([run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'SKIPPED'), ctx('ext', 'SUCCESS'), run('n', 'COMPLETED', 'NEUTRAL')]);
  assert.equal(r.checks, 'success');
  assert.deepEqual(r.summary, { passed: 4, failed: 0, pending: 0 });
});

test('実行中がある → pending(失敗が無い場合)', () => {
  const r = mapChecks([run('build', 'IN_PROGRESS', ''), run('lint', 'COMPLETED', 'SUCCESS'), ctx('ext', 'PENDING')]);
  assert.equal(r.checks, 'pending');
  assert.deepEqual(r.summary, { passed: 1, failed: 0, pending: 2 });
});

test('失敗が 1 つでもあれば failure(pending より優先)。失敗一覧に run id', () => {
  const r = mapChecks([run('build', 'COMPLETED', 'FAILURE', 4242), run('lint', 'QUEUED', ''), ctx('ext', 'ERROR'), run('t', 'COMPLETED', 'TIMED_OUT', 7)]);
  assert.equal(r.checks, 'failure');
  assert.deepEqual(r.summary, { passed: 0, failed: 3, pending: 1 });
  assert.deepEqual(
    r.failed.map((f) => [f.name, f.runId]),
    [['build', 4242], ['ext', null], ['t', 7]],
  );
});

test('CANCELLED は失敗として数える', () => {
  assert.equal(mapChecks([run('a', 'COMPLETED', 'CANCELLED')]).checks, 'failure');
});

// ---------------------------------------------------------------- run id
test('detailsUrl から run id を取り出す', () => {
  assert.equal(extractRunId('https://github.com/o/r/actions/runs/123456789/job/987'), 123456789);
  assert.equal(extractRunId('https://github.com/o/r/actions/runs/55'), 55);
  assert.equal(extractRunId('https://github.com/o/r/actions/runs/55?check_suite_focus=true'), 55);
  assert.equal(extractRunId('https://ci.example.com/build/1'), null);
  assert.equal(extractRunId(undefined), null);
});

// ---------------------------------------------------------------- gh JSON → PrInfo
const ghPr = (o: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'ログイン修正',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/login-fix',
  baseRefName: 'main',
  author: { login: 'me' },
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [run('build', 'COMPLETED', 'SUCCESS')],
  updatedAt: '2026-10-10T00:00:00Z',
  comments: [{ body: 'a' }],
  reviews: [],
  ...o,
});

test('toPrInfo: 基本の変換', () => {
  const p = toPrInfo('o/r', ghPr(), { mine: true });
  assert.equal(p.id, 'o/r#7');
  assert.equal(p.checks, 'success');
  assert.equal(p.reviewDecision, null); // 空文字は null
  assert.equal(p.commentCount, 1);
  assert.equal(p.mine, true);
  assert.equal(p.updatedAt, Date.parse('2026-10-10T00:00:00Z'));
});

test('toPrInfo: me と author が一致すれば mine', () => {
  assert.equal(toPrInfo('o/r', ghPr(), { me: 'ME' }).mine, true);
  assert.equal(toPrInfo('o/r', ghPr(), { me: 'other' }).mine, false);
});

test('keepPr: OPEN と 3 日以内に閉じたものだけ残す', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const base = toPrInfo('o/r', ghPr());
  assert.equal(keepPr({ ...base, state: 'OPEN', updatedAt: 0 }, now), true);
  assert.equal(keepPr({ ...base, state: 'MERGED', updatedAt: now - 2 * 86400_000 }, now), true);
  assert.equal(keepPr({ ...base, state: 'CLOSED', updatedAt: now - 4 * 86400_000 }, now), false);
});

// ---------------------------------------------------------------- 差分 → 通知
const P = (o: Partial<PrInfo> = {}): PrInfo => ({ ...toPrInfo('o/r', ghPr(), { mine: true }), ...o });
const titles = (a: PrInfo | undefined, b: PrInfo) => diffPrEvents(a, b).map((e) => e.title);

test('初回(前回なし)は通知しない', () => {
  assert.deepEqual(titles(undefined, P({ checks: 'failure' })), []);
});

test('checks → failure で通知。failure のままなら出さない', () => {
  assert.deepEqual(titles(P({ checks: 'pending' }), P({ checks: 'failure' })), ['CI が失敗しました']);
  assert.deepEqual(titles(P({ checks: 'failure' }), P({ checks: 'failure' })), []);
});

test('reviewDecision → CHANGES_REQUESTED / APPROVED で通知。REVIEW_REQUIRED は出さない', () => {
  assert.deepEqual(titles(P(), P({ reviewDecision: 'CHANGES_REQUESTED' })), ['修正を依頼されました']);
  assert.deepEqual(titles(P({ reviewDecision: 'CHANGES_REQUESTED' }), P({ reviewDecision: 'APPROVED' })), ['PR が承認されました']);
  assert.deepEqual(titles(P(), P({ reviewDecision: 'REVIEW_REQUIRED' })), []);
});

test('自分の PR のコメント増で通知(他人の PR では出さない)', () => {
  assert.deepEqual(titles(P({ commentCount: 1 }), P({ commentCount: 3 })), ['新しいコメント / レビュー']);
  assert.equal(diffPrEvents(P({ commentCount: 1 }), P({ commentCount: 3 }))[0].body.includes('+2'), true);
  assert.deepEqual(titles(P({ commentCount: 1, mine: false }), P({ commentCount: 3, mine: false })), []);
  assert.deepEqual(titles(P({ commentCount: 3 }), P({ commentCount: 2 })), []);
});

test('MERGED への変化は 1 件だけ通知(同時の他の変化は出さない)', () => {
  assert.deepEqual(titles(P(), P({ state: 'MERGED', checks: 'failure', commentCount: 5 })), ['PR がマージされました']);
  assert.deepEqual(titles(P({ state: 'MERGED' }), P({ state: 'MERGED' })), []);
});

test('複数の変化はまとめて通知', () => {
  assert.deepEqual(titles(P(), P({ checks: 'failure', reviewDecision: 'CHANGES_REQUESTED', commentCount: 2 })), [
    'CI が失敗しました',
    '修正を依頼されました',
    '新しいコメント / レビュー',
  ]);
});

// ---------------------------------------------------------------- 修正指示
const prRef = { number: 7, title: 'ログイン修正', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/login-fix' };

test('修正指示: レビューコメント(作者・file:line・本文)と補足', () => {
  const t = buildFixInstruction({
    pr: prRef,
    comments: [
      { author: 'alice', body: 'ここは null チェックが必要\n2 行目', createdAt: 0, path: 'src/a.ts', line: 12 },
      { author: 'bob', body: '全体的に OK', createdAt: 0 },
    ],
    checkLogs: [],
    note: 'テストも追加して',
  });
  assert.match(t, /PR #7「ログイン修正」/);
  assert.match(t, /\*\*alice\*\* \(src\/a\.ts:12\):/);
  assert.match(t, /> ここは null チェックが必要\n  > 2 行目/);
  assert.match(t, /\*\*bob\*\* \(会話\):/);
  assert.match(t, /## 補足の指示\nテストも追加して/);
  assert.doesNotMatch(t, /失敗したチェック/);
});

test('修正指示: 失敗ログは末尾 200 行に切り、gh の前置き(job / step / 時刻)を落とす', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `build\tRun tests\t2026-10-10T01:02:03.4567890Z line ${i}`);
  const t = buildFixInstruction({ pr: prRef, comments: [], checkLogs: [{ name: 'build', runId: 42, log: lines.join('\n') }] });
  assert.ok(t.includes('### build(run 42)'), 'run id 付きの見出しが無い');
  assert.match(t, /line 499\n```/);
  assert.doesNotMatch(t, /line 299\n/);
  assert.match(t, /line 300\n/);
  assert.doesNotMatch(t, /Run tests\t/);
  assert.match(t, /先頭 300 行を省略/);
});

test('修正指示: 全体は 30KB 以内(大きなログが複数でも)', () => {
  const big = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(400)} ${i}`).join('\n');
  const t = buildFixInstruction({
    pr: prRef,
    comments: Array.from({ length: 50 }, (_, i) => ({ author: 'a', body: 'コメント'.repeat(50) + i, createdAt: 0, path: 'f.ts', line: i + 1 })),
    checkLogs: [1, 2, 3].map((n) => ({ name: `job${n}`, runId: n, log: big })),
  });
  assert.ok(Buffer.byteLength(t, 'utf8') <= FIX_MAX_BYTES, `大きすぎる: ${Buffer.byteLength(t, 'utf8')}`);
  for (const n of [1, 2, 3]) assert.match(t, new RegExp(`### job${n}`));
  // 末尾(最新の行)は残る
  assert.match(t, / 199\n```/);
});

test('trimLog: ANSI エスケープを落とし、末尾の空行は除く', () => {
  assert.equal(trimLog('\x1b[31merror\x1b[0m\n\n'), 'error');
});

test('PR 作成の指示: push と gh pr create(draft 指定)', () => {
  const t = buildCreatePrInstruction({ base: 'main', draft: true });
  assert.match(t, /git push -u origin HEAD/);
  assert.match(t, /gh pr create --base main --draft/);
  assert.doesNotMatch(t, /\n/);
  assert.doesNotMatch(buildCreatePrInstruction({ base: 'master', draft: false }), /--draft/);
});

// ---------------------------------------------------------------- git 出力の解析
test('status --porcelain=v2 -b: 変更数と upstream', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +1 -0',
    '1 .M N... 100644 100644 100644 a b README.md',
    '? new.txt',
    '',
  ].join('\n');
  assert.deepEqual(parseStatusV2(out), { changed: 2, upstream: 'origin/feat/x', head: 'feat/x' });
  assert.deepEqual(parseStatusV2('# branch.head (detached)\n'), { changed: 0, upstream: null, head: '(detached)' });
});

test('diff --shortstat / rev-list --left-right', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), { insertions: 10, deletions: 2 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)\n'), { insertions: 1, deletions: 0 });
  assert.deepEqual(parseShortstat(''), { insertions: 0, deletions: 0 });
  assert.deepEqual(parseLeftRight('2\t5\n'), [2, 5]);
});

test('for-each-ref: ローカル / origin(HEAD は除く)', () => {
  const S = '\x1f';
  const out = [
    ['refs/heads/main', 'a1', 'init', 'me', '1700000000', 'origin/main'].join(S),
    ['refs/heads/feat/x', 'b2', 'wip', 'me', '1700000100', ''].join(S),
    ['refs/remotes/origin/HEAD', 'a1', 'init', 'me', '1700000000', ''].join(S),
    ['refs/remotes/origin/main', 'a1', 'init', 'me', '1700000000', ''].join(S),
  ].join('\n');
  const r = parseRefs(out);
  assert.deepEqual([...r.local.keys()], ['main', 'feat/x']);
  assert.deepEqual([...r.remote.keys()], ['main']);
  assert.equal(r.local.get('feat/x')!.date, 1700000100_000);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
