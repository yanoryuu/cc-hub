// プロジェクトの共通の指示(行数・警告・キー・書き直しの依頼文)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import path from 'node:path';
import { INSTRUCTIONS_LINE_LIMIT } from '@cc-hub/shared';
import { ancestors, cleanProposal, countLines, fileNameFor, keyString, lineWarning, normDir, rewritePrompt } from '../src/project/instructions';

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

const lines = (n: number) => Array.from({ length: n }, (_, i) => `- ルール ${i + 1}`).join('\n');

test('countLines: 末尾の改行は数えない / 空は 0 / CRLF', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('   \n\n'), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\n\n\n'), 1);
  assert.equal(countLines('a\r\nb\r\n'), 2);
  assert.equal(countLines('a\n\nb'), 3);
  assert.equal(countLines(lines(230)), 230);
});

test('lineWarning: 90% 以上で注意、上限超えで要点を絞る', () => {
  assert.equal(INSTRUCTIONS_LINE_LIMIT, 200);
  assert.equal(lineWarning(0), null);
  assert.equal(lineWarning(179), null);
  assert.equal(lineWarning(180), '200 行に近づいています(180 行)');
  assert.equal(lineWarning(200), '200 行に近づいています(200 行)');
  assert.equal(lineWarning(201), '200 行を超えています(201 行)。要点を絞ってください');
  assert.equal(lineWarning(countLines(lines(230))), '200 行を超えています(230 行)。要点を絞ってください');
});

test('keyString / fileNameFor: repoId 優先、フォルダは大文字小文字・区切り・末尾を揃える', () => {
  assert.equal(keyString({ repoId: 'Owner/Repo', cwd: 'D:\\x' }), 'r:owner/repo');
  assert.equal(keyString({ repoId: null, cwd: 'D:\\AITEST\\P7\\' }), keyString({ repoId: null, cwd: 'd:/aitest/p7' }));
  assert.equal(normDir('D:\\'), 'd:\\');
  assert.throws(() => keyString({ repoId: null, cwd: null }));
  const f = fileNameFor('d:\\aitest\\p7');
  assert.match(f, /^[0-9a-f]{24}\.md$/);
  assert.equal(f, fileNameFor('d:\\aitest\\p7'));
  assert.notEqual(f, fileNameFor('d:\\aitest\\p8'));
});

test('ancestors: 近い順にドライブまで', () => {
  const a = ancestors('D:\\AITEST\\p7\\site');
  assert.deepEqual(a, [path.resolve('D:\\AITEST\\p7\\site'), path.resolve('D:\\AITEST\\p7'), path.resolve('D:\\AITEST'), 'D:\\']);
});

test('rewritePrompt / cleanProposal', () => {
  const p = rewritePrompt('- 既存のルール', 'テストは必ず書く');
  assert.ok(p.includes('<current>\n- 既存のルール\n</current>'));
  assert.ok(p.includes('<request>\nテストは必ず書く\n</request>'));
  assert.ok(p.includes('200 行以内'));
  assert.ok(rewritePrompt('', 'x').includes('(まだ何も書かれていません)'));
  assert.equal(cleanProposal('```markdown\n- a\n- b\n```'), '- a\n- b\n');
  assert.equal(cleanProposal('\r\n- a\r\n'), '- a\n');
});

console.log(`\ninstructions: ${passed} passed`);
