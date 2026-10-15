// worktree の使用中(inUse)の判定と、rebase の結果の分類のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { classifyRebase, computeInUse, parseConflictFiles, parseCount } from '../src/repo/worktree-ops';

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

const live = new Set(['running-session']);
const isLive = (id: string) => live.has(id);

test('inUse: 割り当て先のセッションが動いていれば true、止まっていれば false', () => {
  assert.equal(computeInUse('assigned', 'running-session', isLive), true);
  assert.equal(computeInUse('assigned', 'stopped-session', isLive), false);
  assert.equal(computeInUse('assigned', null, isLive), false);
});

test('inUse: 準備・初期化・削除の途中は true', () => {
  for (const s of ['creating', 'warming', 'releasing', 'deleting'] as const) assert.equal(computeInUse(s, null, isLive), true, s);
});

test('inUse: 待機中と broken は false(セッション ID が残っていても)', () => {
  assert.equal(computeInUse('idle', null, isLive), false);
  assert.equal(computeInUse('broken', 'running-session', isLive), false);
});

test('衝突ファイルの一覧(重複・空行は除く)', () => {
  assert.deepEqual(parseConflictFiles('README.md\r\nsrc/a.ts\n\nsrc/a.ts\n'), ['README.md', 'src/a.ts']);
  assert.deepEqual(parseConflictFiles(''), []);
});

test('rev-list --count の読み取り', () => {
  assert.equal(parseCount('3\n'), 3);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount('fatal'), 0);
});

const res = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });

test('rebase の分類: 成功 → rebased', () => {
  const c = classifyRebase(res(0, '', 'Successfully rebased and updated refs/heads/feat/x.\n'), [], 'origin/main');
  assert.equal(c.result, 'rebased');
  assert.deepEqual(c.conflicts, []);
});

test('rebase の分類: 衝突 → conflict(ファイル一覧つき)', () => {
  const out = 'Auto-merging README.md\nCONFLICT (content): Merge conflict in README.md\n';
  const err = 'error: could not apply 1a2b3c4... edit readme\nhint: Resolve all conflicts manually\n';
  const c = classifyRebase(res(1, out, err), ['README.md'], 'origin/main');
  assert.equal(c.result, 'conflict');
  assert.deepEqual(c.conflicts, ['README.md']);
  assert.match(c.message, /中止して元に戻しました/);
  assert.match(c.message, /README\.md/);
  // ファイル一覧が取れなくても、出力に CONFLICT があれば conflict
  assert.equal(classifyRebase(res(1, out, err), [], 'origin/main').result, 'conflict');
});

test('rebase の分類: それ以外の失敗 → failed(stderr の末尾つき)', () => {
  const c = classifyRebase(res(128, '', 'fatal: invalid upstream \'origin/main\'\n'), [], 'origin/main');
  assert.equal(c.result, 'failed');
  assert.match(c.message, /invalid upstream/);
  const long = classifyRebase(res(1, '', 'x'.repeat(2000) + 'TAIL'), [], 'origin/main');
  assert.equal(long.result, 'failed');
  assert.match(long.message, /TAIL$/);
  assert.ok(long.message.length < 800);
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILED' : ''}`);
