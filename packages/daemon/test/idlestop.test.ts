// 使っていないセッションの自動停止の判定のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { DEFAULT_IDLE_STOP, isIdleTooLong, normalizeIdleStop } from '../src/session/idlestop';

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

const H = 3600_000;
const now = 100 * H;
const cfg = { enabled: true, hours: 3 };
const s = (o: Partial<{ managed: boolean; status: any; approval: any; lastEventAt: number }> = {}) => ({
  managed: true,
  status: 'awaiting_input' as const,
  approval: null,
  lastEventAt: now - 4 * H,
  ...o,
});

test('入力待ちのまま 3 時間を超えたら止める', () => {
  assert.equal(isIdleTooLong(s(), now, cfg), true);
  assert.equal(isIdleTooLong(s({ status: 'idle' }), now, cfg), true);
});

test('3 時間たっていなければ止めない', () => {
  assert.equal(isIdleTooLong(s({ lastEventAt: now - 2 * H }), now, cfg), false);
});

test('作業中・承認待ち・起動中・停止済みは止めない', () => {
  for (const status of ['running', 'awaiting_approval', 'starting', 'stopped', 'error']) {
    assert.equal(isIdleTooLong(s({ status }), now, cfg), false, status);
  }
  assert.equal(isIdleTooLong(s({ approval: { question: 'q' } }), now, cfg), false);
});

test('外部セッション・無効のときは止めない', () => {
  assert.equal(isIdleTooLong(s({ managed: false }), now, cfg), false);
  assert.equal(isIdleTooLong(s(), now, { enabled: false, hours: 3 }), false);
});

test('設定の正規化: 不正な値は既定値', () => {
  assert.deepEqual(normalizeIdleStop(null), DEFAULT_IDLE_STOP);
  assert.deepEqual(normalizeIdleStop({ enabled: false, hours: 6 }), { enabled: false, hours: 6 });
  assert.deepEqual(normalizeIdleStop({ hours: 0 }), DEFAULT_IDLE_STOP);
  assert.deepEqual(normalizeIdleStop({ hours: 'x' }), DEFAULT_IDLE_STOP);
});

console.log(`\nidlestop: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
