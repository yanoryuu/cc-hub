// 承認検出のテスト(実際の画面から採ったフィクスチャ)。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { approvalKeys, detectApproval } from '../src/session/approval';

const pad = (n: number) => Array.from({ length: n }, () => '');
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

// AskUserQuestion: 選択肢の下に空行が 20 行以上あり、最下行にセッション名の罫線がある(末尾 25 行だけでは見えない)
const askUser = [
  ' ▐▛███▛█   Claude Code v2.1.295',
  '❯ AskUserQuestion ツールを使って、赤と青のどちらが好きか私に質問してください。',
  '─'.repeat(100),
  ' ☐ 好きな色 ',
  '',
  '赤と青、どちらが好きですか？',
  '',
  '❯ 1. 赤',
  '     赤を選びます',
  '  2. 青',
  '     青を選びます',
  '  3. Type something.',
  '─'.repeat(100),
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ...pad(22),
  '─'.repeat(70) + ' ask-user-red-or-blue-preference ─',
];

test('AskUserQuestion の選択肢と質問文を取り出す', () => {
  const a = detectApproval(askUser, 'D:\\WorkTree\\x\\wt-01');
  assert.ok(a, '検出されない');
  assert.equal(a.question, '赤と青、どちらが好きですか？');
  assert.deepEqual(
    a.options.map((o) => o.label),
    ['赤', '青', 'Type something.', 'Chat about this'],
  );
  assert.deepEqual(approvalKeys(a, '2'), ['2']);
});

const trust = [
  '─'.repeat(100),
  ' Accessing workspace:',
  ' D:\\WorkTree\\is-odd\\wt-01',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
  ...pad(30),
];

test('信頼ダイアログ(番号なし)を検出し、Yes はカーソル移動 + Enter', () => {
  const a = detectApproval(trust, 'D:\\WorkTree\\is-odd\\wt-01');
  assert.ok(a);
  assert.match(a.question, /信頼/);
  assert.equal(a.numbered, false);
  assert.deepEqual(approvalKeys(a, 'y'), ['\x1b[B', '\r']);
});

const permission = [
  '╭' + '─'.repeat(60) + '╮',
  '│ Bash command                                               │',
  '│   npm test -- --watch=false                                │',
  '│ Do you want to proceed?                                    │',
  '│ ❯ 1. Yes                                                   │',
  "│   2. Yes, and don't ask again for npm test commands        │",
  '│   3. No, and tell Claude what to do differently (esc)      │',
  '╰' + '─'.repeat(60) + '╯',
];

test('許可プロンプト(枠付き)を検出する', () => {
  const a = detectApproval(permission, 'C:\\x');
  assert.ok(a);
  assert.equal(a.question, 'Do you want to proceed?');
  assert.equal(a.options.length, 3);
});

const transcript = [
  '● 手順は次のとおりです。',
  '  1. 依存を入れる',
  '  2. テストを走らせる',
  '  3. コミットする',
  '',
  '─'.repeat(100),
  '❯ ',
  '─'.repeat(100),
  ...pad(20),
];

test('会話中の番号付きリストは承認と誤検知しない', () => {
  assert.equal(detectApproval(transcript, 'C:\\x'), null);
});

const answeredLater = [
  '❯ 1. 赤',
  '  2. 青',
  '● 青ですね。',
  '',
  '─'.repeat(100),
  '❯ ',
  '─'.repeat(100),
];

test('ヒントも質問文もない「❯ 1.」の残骸は検出しない', () => {
  assert.equal(detectApproval(answeredLater, 'C:\\x'), null);
});

console.log(`\n${passed} passed`);
