// 新規セッションのモデル選択(StartSessionRequest.model / 下書きの model)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { DEFAULT_SESSION_MODEL } from '@cc-hub/shared';
import { sessionModel } from '../src/session/model';
import { normalizeDraft } from '../src/session/drafts';

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

test('既定のモデルは opus', () => {
  assert.equal(DEFAULT_SESSION_MODEL, 'opus');
});

test('モデルの指定: 省略は undefined、選べる値はそのまま、知らない値は 400', () => {
  assert.equal(sessionModel(undefined), undefined);
  assert.equal(sessionModel(''), undefined);
  assert.equal(sessionModel('sonnet'), 'sonnet');
  assert.equal(sessionModel('haiku'), 'haiku');
  assert.equal(sessionModel('fable'), 'fable');
  assert.throws(() => sessionModel('--dangerously-skip-permissions'), (e: any) => e.status === 400 || e.code === 400 || /不正/.test(e.message));
  assert.throws(() => sessionModel('gpt-5'));
});

test('下書きはモデルを残す(知らない値・無い場合は持たない)', () => {
  const base = { kind: 'folder', cwd: 'D:/AITEST/x', instruction: 'やること', mode: 'plain' };
  assert.equal(normalizeDraft('a', { ...base, model: 'sonnet' }).model, 'sonnet');
  assert.equal(normalizeDraft('b', { ...base, model: 'nope' }).model, undefined);
  assert.equal(normalizeDraft('c', base).model, undefined);
});

console.log(`\n${passed} passed`);
