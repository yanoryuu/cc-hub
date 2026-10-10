// フォルダ(プロジェクト)管理画面の純粋ロジックのテスト(git 出力の解析 / アーティファクト種別 / パス検査 / トークン集計)。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  artifactKind,
  isArtifactExcluded,
  isInside,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusV2Z,
  resolveTargetPath,
  splitStatus,
} from '../src/project/parse';
import { UsageTally, combineTokens, parseUsageLine } from '../src/session/tokens';
import { sumTokens } from '../src/project/service';
import { taskText } from '../src/util';

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

// ---------------------------------------------------------------- git status --porcelain=v2 -z
const H = '0123456789abcdef0123456789abcdef01234567';
const STATUS = [
  `# branch.oid ${H}`,
  '# branch.head feat/x',
  '# branch.upstream origin/feat/x',
  '# branch.ab +2 -1',
  `1 M. N... 100644 100644 100644 ${H} ${H} src/staged.ts`,
  `1 .M N... 100644 100644 100644 ${H} ${H} src/dir with space/file.ts`,
  `1 MM N... 100644 100644 100644 ${H} ${H} both.md`,
  `1 A. N... 000000 100644 100644 ${H} ${H} added.txt`,
  `1 .D N... 100644 100644 000000 ${H} ${H} gone.txt`,
  `2 R. N... 100644 100644 100644 ${H} ${H} R100 new/name.ts`,
  'old/name.ts',
  `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  '? untracked file.png',
  '? docs/new.md',
  '! ignored.log',
  '',
].join('\0');

test('porcelain v2 -z: ヘッダ', () => {
  const s = parseStatusV2Z(STATUS);
  assert.equal(s.head, 'feat/x');
  assert.equal(s.oid, H);
  assert.equal(s.upstream, 'origin/feat/x');
  assert.deepEqual(s.ab, { ahead: 2, behind: 1 });
});

test('porcelain v2 -z: リネーム・空白入りパス・未追跡', () => {
  const s = parseStatusV2Z(STATUS);
  const ren = s.entries.find((e) => e.kind === 'renamed')!;
  assert.equal(ren.path, 'new/name.ts');
  assert.equal(ren.from, 'old/name.ts');
  assert.ok(s.entries.some((e) => e.path === 'src/dir with space/file.ts' && e.y === 'M'));
  assert.deepEqual(
    s.entries.filter((e) => e.kind === 'untracked').map((e) => e.path),
    ['untracked file.png', 'docs/new.md'],
  );
  assert.equal(s.entries.filter((e) => e.kind === 'unmerged').length, 1);
});

test('porcelain v2 -z: detached / initial', () => {
  const s = parseStatusV2Z(['# branch.oid (initial)', '# branch.head (detached)', ''].join('\0'));
  assert.equal(s.head, null);
  assert.equal(s.oid, null);
  assert.equal(s.upstream, null);
});

// ---------------------------------------------------------------- numstat -z
const NUMSTAT_CACHED = ['3\t1\tsrc/staged.ts', '10\t0\tadded.txt', '-\t-\timage.png', '2\t2\t', 'old/name.ts', 'new/name.ts', '5\t0\tboth.md', ''].join('\0');
const NUMSTAT_WT = ['0\t4\tgone.txt', '7\t2\tsrc/dir with space/file.ts', '1\t1\tboth.md', ''].join('\0');

test('numstat -z: 通常 / バイナリ / リネーム', () => {
  const m = parseNumstatZ(NUMSTAT_CACHED);
  assert.deepEqual(m.get('src/staged.ts'), { path: 'src/staged.ts', additions: 3, deletions: 1 });
  assert.deepEqual(m.get('image.png'), { path: 'image.png', additions: null, deletions: null });
  assert.deepEqual(m.get('new/name.ts'), { path: 'new/name.ts', from: 'old/name.ts', additions: 2, deletions: 2 });
  assert.equal(m.has('old/name.ts'), false);
});

test('splitStatus: staged / unstaged / untracked に分けて行数を付ける', () => {
  const s = parseStatusV2Z(STATUS);
  const r = splitStatus(s.entries, parseNumstatZ(NUMSTAT_CACHED), parseNumstatZ(NUMSTAT_WT));
  assert.deepEqual(
    r.staged.map((f) => `${f.status} ${f.path} +${f.additions}-${f.deletions}${f.from ? ` <${f.from}` : ''}`),
    ['M src/staged.ts +3-1', 'M both.md +5-0', 'A added.txt +10-0', 'R new/name.ts +2-2 <old/name.ts'],
  );
  assert.deepEqual(
    r.unstaged.map((f) => `${f.status} ${f.path} +${f.additions}-${f.deletions}`),
    ['M src/dir with space/file.ts +7-2', 'M both.md +1-1', 'D gone.txt +0-4', 'U conflict.ts +0-0'],
  );
  assert.deepEqual(r.untracked, ['untracked file.png', 'docs/new.md']);
});

test('splitStatus: 未追跡の上限', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}`, x: '?', y: '?', kind: 'untracked' as const }));
  assert.equal(splitStatus(entries, new Map(), new Map(), 3).untracked.length, 3);
});

test('name-status -z: リネーム / コピー / 削除', () => {
  const out = ['M', 'a.ts', 'R087', 'old.ts', 'new.ts', 'C100', 'src.ts', 'copy.ts', 'D', 'del.ts', 'A', 'add.md', ''].join('\0');
  assert.deepEqual(parseNameStatusZ(out), [
    { path: 'a.ts', status: 'M' },
    { path: 'new.ts', status: 'R', from: 'old.ts' },
    { path: 'copy.ts', status: 'A' },
    { path: 'del.ts', status: 'D' },
    { path: 'add.md', status: 'A' },
  ]);
});

test('git log の解析と pushed', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const out = `${a}\x1fsubject 1\x1fAlice\x1f1700000000\x1e\n${b}\x1fsub|2\x1fBob\x1f1700000100\x1e\n`;
  const list = parseLog(out, new Set([a]));
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { sha: a, subject: 'subject 1', author: 'Alice', date: 1700000000000, pushed: false });
  assert.equal(list[1].pushed, true);
});

// ---------------------------------------------------------------- アーティファクト
test('artifactKind: 拡張子 → 種別', () => {
  assert.equal(artifactKind('img/shot.PNG'), 'image');
  assert.equal(artifactKind('a/b.svg'), 'image');
  assert.equal(artifactKind('README.md'), 'markdown');
  assert.equal(artifactKind('src/main.ts'), 'code');
  assert.equal(artifactKind('Assets/Player.cs'), 'code');
  assert.equal(artifactKind('Dockerfile'), 'code');
  assert.equal(artifactKind('package.json'), 'data');
  assert.equal(artifactKind('data/x.csv'), 'data');
  assert.equal(artifactKind('notes.txt'), 'other');
  assert.equal(artifactKind('LICENSE'), 'other');
  assert.equal(artifactKind('bin/app.exe'), 'other');
});

test('アーティファクトの除外(.cc-hub / node_modules / Library)', () => {
  assert.equal(isArtifactExcluded('.cc-hub/attachments/a.png'), true);
  assert.equal(isArtifactExcluded('node_modules/x/index.js'), true);
  assert.equal(isArtifactExcluded('packages/web/node_modules/y.js'), true);
  assert.equal(isArtifactExcluded('Library/ScriptAssemblies/a.dll'), true);
  assert.equal(isArtifactExcluded('src/Library.ts'), false);
  assert.equal(isArtifactExcluded('docs/libraryx/a.md'), false);
});

// ---------------------------------------------------------------- パスの検査
const ROOT = path.resolve('D:/WorkTree/_test/repo/wt-01');
test('resolveTargetPath: 通常のパス', () => {
  assert.equal(resolveTargetPath(ROOT, 'src/a.ts'), path.join(ROOT, 'src', 'a.ts'));
  assert.equal(resolveTargetPath(ROOT, 'src\\b.ts'), path.join(ROOT, 'src', 'b.ts'));
  assert.equal(resolveTargetPath(ROOT, 'a/../b.ts'), path.join(ROOT, 'b.ts'));
});

test('resolveTargetPath: トラバーサル・絶対パス・.git を拒否', () => {
  for (const bad of [
    '..\\..\\Windows\\win.ini',
    '../wt-02/secret.txt',
    '../wt-01x/a',
    'C:\\Windows\\win.ini',
    'C:Windows',
    '/etc/passwd',
    '\\\\server\\share\\x',
    '.git/config',
    '.GIT\\config',
    'sub/.git/HEAD',
    '',
    '.',
    'a\0b',
  ]) {
    assert.equal(resolveTargetPath(ROOT, bad), null, bad);
  }
  assert.equal(resolveTargetPath(ROOT, 42 as unknown), null);
  // .gitignore などは .git ではない
  assert.ok(resolveTargetPath(ROOT, '.gitignore'));
  assert.ok(resolveTargetPath(ROOT, 'a/.github/workflows/ci.yml'));
});

test('isInside: 大文字小文字・前方一致の誤判定なし', () => {
  assert.equal(isInside('C:\\Users\\yanor\\cc-hub', 'c:\\users\\YANOR\\cc-hub\\packages'), true);
  assert.equal(isInside('C:\\Users\\yanor\\cc-hub', 'C:\\Users\\yanor\\cc-hub'), true);
  assert.equal(isInside('C:\\Users\\yanor\\cc-hub', 'C:\\Users\\yanor\\cc-hub2'), false);
  assert.equal(isInside('C:\\Users\\yanor\\cc-hub\\', 'C:/Users/yanor/cc-hub/x'), true);
});

// ---------------------------------------------------------------- transcript の usage 集計
const line = (id: string, u: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', usage: u }, ...extra });

test('parseUsageLine: アシスタント以外・usage 無しは null', () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: { content: 'usage' } })), null);
  assert.equal(parseUsageLine('{broken "usage"'), null);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: { id: 'x', usage: { input_tokens: 1 } } })), null);
  const p = parseUsageLine(line('m1', { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }));
  assert.deepEqual(p, { id: 'm1', usage: { input: 3, output: 5, cacheRead: 100, cacheCreation: 7 } });
});

test('UsageTally: 同じ message.id は 1 回だけ(ストリーミング中の書き直しは最大値)', () => {
  const t = new UsageTally();
  const u1 = { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 };
  assert.equal(t.addLine(line('msg_A', u1), false), true);
  assert.equal(t.addLine(line('msg_A', u1), false), false); // 同じ内容の重複
  assert.equal(t.addLine(line('msg_A', { ...u1, output_tokens: 120 }), false), true); // 出力が伸びた
  t.addLine(line('msg_B', { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 }), false);
  t.addLine(line('msg_S', { input_tokens: 4, output_tokens: 40, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 }), true);
  t.addLine(line('msg_S', { input_tokens: 4, output_tokens: 40, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 }), true);
  t.addLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }), false);
  assert.deepEqual(t.main, { input: 3, output: 130, cacheRead: 2500, cacheCreation: 500 });
  assert.deepEqual(t.sub, { input: 4, output: 40, cacheRead: 200, cacheCreation: 300 });
  assert.equal(t.size, 3);
});

test('combineTokens: メインは statusLine と transcript の大きい方 + サブエージェント', () => {
  const t = new UsageTally();
  t.add('m', { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 }, false);
  t.add('s', { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }, true);
  const a = combineTokens({ input: 1000, output: 2000 }, t, 1);
  assert.deepEqual(a, { input: 1001, output: 2002, cacheRead: 33, cacheCreation: 44, updatedAt: 1 });
  const b = combineTokens(null, t, 2);
  assert.deepEqual(b, { input: 11, output: 22, cacheRead: 33, cacheCreation: 44, updatedAt: 2 });
  // statusLine の出力が古い(最後の応答の後に再描画されない)場合は transcript を使う
  const c = combineTokens({ input: 1000, output: 5 }, t, 3);
  assert.deepEqual(c, { input: 1001, output: 22, cacheRead: 33, cacheCreation: 44, updatedAt: 3 });
});

test('sumTokens: プロジェクトの合計', () => {
  const s = (id: string, tokens: any, costUsd: number | null) => ({ id, tokens, costUsd }) as any;
  const r = sumTokens([
    s('a', { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, updatedAt: 0 }, 0.5),
    s('b', { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, updatedAt: 0 }, null),
    s('c', null, null),
  ]);
  assert.equal(r.input, 11);
  assert.equal(r.cacheCreation, 44);
  assert.equal(r.costUsd, 0.5);
  assert.deepEqual(Object.keys(r.bySession), ['a', 'b']);
});

// ---------------------------------------------------------------- task
test('taskText: スラッシュコマンド名を除く・300 文字', () => {
  assert.equal(taskText('/commander ログイン画面を直して'), 'ログイン画面を直して');
  assert.equal(taskText('/hub-commander\n  複数行\nの指示'), '複数行 の指示');
  assert.equal(taskText('/clear'), null);
  assert.equal(taskText('<command-name>/clear</command-name>'), null);
  assert.equal(taskText('  普通の指示  '), '普通の指示');
  assert.equal(taskText(undefined), null);
  assert.equal(taskText('x'.repeat(500))!.length, 300);
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILED' : ''}`);
