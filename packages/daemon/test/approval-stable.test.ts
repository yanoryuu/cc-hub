// 承認の検出を落ち着かせる処理(stabilizeApproval)のテスト。
// スマホで端末が低いと、ダイアログの一部しか見えず選択肢が減ったり消えたりして見える(承認の帯がガクガクする)
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { APPROVAL_HOLD_MS, stabilizeApproval, type DetectedApproval } from '../src/session/approval';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const Q = '好きな季節は？';
const opt = (n: string, label: string, selected = false) => ({ n, label, selected });
const full: DetectedApproval = {
  type: 'options',
  question: Q,
  numbered: true,
  options: [opt('1', '春', true), opt('2', '夏'), opt('3', '秋'), opt('4', '冬'), opt('5', 'Type something.'), opt('6', 'Chat about this')],
};
// 検証環境で端末を 13 行にしたときに実際に見えたもの
const partial: DetectedApproval = { ...full, options: [opt('1', '春', true), opt('6', 'Chat about this')] };

test('一部しか見えなくても、前に見えた全部の選択肢を保つ', () => {
  const r = stabilizeApproval(full, partial, 1000, null, false);
  assert.equal(r.value?.options.length, 6);
  assert.equal(r.recheckMs, null);
});

test('保つときも、選択中の位置は新しい画面に合わせる', () => {
  const moved: DetectedApproval = { ...full, options: [opt('1', '春'), opt('6', 'Chat about this', true)] };
  const r = stabilizeApproval(full, moved, 1000, null, false);
  assert.deepEqual(r.value?.options.filter((o) => o.selected).map((o) => o.n), ['6']);
});

test('一瞬消えて見えても、猶予の間は取り下げずに見直しを予約する', () => {
  const r1 = stabilizeApproval(full, null, 1000, null, false);
  assert.equal(r1.value, full);
  assert.equal(r1.missSince, 1000);
  assert.equal(r1.recheckMs, APPROVAL_HOLD_MS);
  // 猶予中に戻ってきた
  const r2 = stabilizeApproval(r1.value, full, 1300, r1.missSince, false);
  assert.equal(r2.value, full);
  assert.equal(r2.missSince, null);
});

test('消えたままなら猶予のあとで取り下げる', () => {
  const r = stabilizeApproval(full, null, 1000 + APPROVAL_HOLD_MS, 1000, false);
  assert.equal(r.value, null);
  assert.equal(r.missSince, null);
});

test('答えた直後は、保たずに画面のとおりにする', () => {
  assert.equal(stabilizeApproval(full, null, 1000, null, true).value, null);
  assert.equal(stabilizeApproval(full, partial, 1000, null, true).value, partial);
});

test('質問が変わった・選択肢が違うときは、新しいものに置き換える', () => {
  const other: DetectedApproval = { ...full, question: '好きな色は？', options: [opt('1', '赤', true), opt('2', '青')] };
  assert.equal(stabilizeApproval(full, other, 1000, null, false).value, other);
  const changed: DetectedApproval = { ...full, options: [opt('1', '春', true), opt('2', '梅雨')] };
  assert.equal(stabilizeApproval(full, changed, 1000, null, false).value, changed);
});

test('前が無ければそのまま', () => {
  assert.equal(stabilizeApproval(null, partial, 1000, null, false).value, partial);
  assert.equal(stabilizeApproval(null, null, 1000, null, false).value, null);
});

console.log(`\napproval-stable: ${passed} passed`);
