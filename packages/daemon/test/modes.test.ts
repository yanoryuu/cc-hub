// 新規セッションのモード(プリセット)のテスト: 一覧の検証・最初の指示の組み立て。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { DEFAULT_MODES, type ModePreset } from '@cc-hub/shared';
import { buildModePrompt, normalizeModes, READ_ONLY_ARG } from '../src/session/modes';

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

const mode = (id: string): ModePreset => DEFAULT_MODES.find((m) => m.id === id)!;

test('既定のモードは 6 つ(commander / plain / plan / review / fix / marketing)', () => {
  assert.deepEqual(DEFAULT_MODES.map((m) => m.id), ['commander', 'plain', 'plan', 'review', 'fix', 'marketing']);
  assert.deepEqual(normalizeModes(DEFAULT_MODES), DEFAULT_MODES);
});

test('commander: 自前の commander スキルが無ければ /hub-commander', () => {
  assert.equal(buildModePrompt(mode('commander'), 'ログインを直して', true), '/commander ログインを直して');
  assert.equal(buildModePrompt(mode('commander'), 'ログインを直して', false), '/hub-commander ログインを直して');
  assert.equal(buildModePrompt(mode('commander'), '', false), '/hub-commander');
});

test('plain / plan は指示をそのまま(空なら指示なし)', () => {
  assert.equal(buildModePrompt(mode('plain'), ' やること ', false), 'やること');
  assert.equal(buildModePrompt(mode('plain'), '', false), undefined);
  assert.equal(buildModePrompt(mode('plan'), 'やること', false), 'やること');
  assert.equal(buildModePrompt(undefined, 'やること', false), 'やること');
});

test('review はスラッシュコマンドの後ろに付ける / fix・marketing は {{instruction}} に入れる', () => {
  assert.equal(buildModePrompt(mode('review'), '', false), '/code-review');
  assert.equal(buildModePrompt(mode('review'), '#12', false), '/code-review #12');
  const fix = buildModePrompt(mode('fix'), '保存できない', false)!;
  assert.ok(fix.startsWith('次の不具合を直してください。') && fix.endsWith('不具合: 保存できない'));
  assert.ok(!fix.includes('{{instruction}}'));
});

test('一覧の検証: commander / plain は消せない、id の重複・不正な値は 400', () => {
  const only = normalizeModes([{ id: 'mine', label: 'マイ', prompt: '/foo', permissionMode: 'plan', model: 'haiku', readOnly: 1 }]);
  assert.deepEqual(only.map((m) => m.id), ['mine', 'commander', 'plain']);
  assert.equal(only[0].readOnly, true);
  assert.equal(only[0].permissionMode, 'plan');
  const bad = (b: unknown) => assert.throws(() => normalizeModes(b), (e: any) => e.status === 400);
  bad({});
  bad([{ id: 'Bad ID' }]);
  bad([{ id: 'a' }, { id: 'a' }]);
  bad([{ id: 'a', permissionMode: 'bypassPermissions' }]);
  bad([{ id: 'a', model: 'gpt-5' }]);
});

test('書き換え禁止は = 付きの 1 引数(空白区切りだと後ろの指示まで飲み込まれる)', () => {
  assert.equal(READ_ONLY_ARG, '--disallowedTools=Edit,Write,NotebookEdit');
});

console.log(`\nmodes: ${passed} passed`);
