// 指示まわりの純粋ロジックのテスト(MCP 一覧の解析 / frontmatter / PowerShell の引用 / 添付ファイル名)。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { parseMcpLine, parseMcpList } from '../src/mcp';
import { firstTextLine, parseFrontmatter } from '../src/skills';
import { buildPsCommand, buildTerminalArgv, launcherCommand, psArg, psQuote, terminalEnv, windowTitle } from '../src/session/terminal';
import { isAllowedMime, sanitizeAttachmentName } from '../src/session/attach';
import { activeBackgroundTasks } from '../src/util';
import { overlaps } from '../src/repo/exec';

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

// ---------------------------------------------------------------- claude mcp list
test('mcp: claude.ai のコネクタ(接続済み)', () => {
  assert.deepEqual(parseMcpLine('claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected'), {
    name: 'claude.ai Claude Docs',
    target: 'https://api.anthropic.com/v1/pages/mcp',
    status: 'connected',
    statusText: 'Connected',
    origin: 'claude.ai',
  });
});

test('mcp: 認証が必要', () => {
  const s = parseMcpLine('claude.ai Sentry: https://mcp.sentry.dev/mcp - ! Needs authentication')!;
  assert.equal(s.name, 'claude.ai Sentry');
  assert.equal(s.status, 'needs_auth');
  assert.equal(s.statusText, 'Needs authentication');
  assert.equal(s.origin, 'claude.ai');
});

test('mcp: ローカル(コマンドに " -y " を含む)', () => {
  assert.deepEqual(parseMcpLine('image-gen: npx -y @lpenguin/openai-image-mcp - ✔ Connected'), {
    name: 'image-gen',
    target: 'npx -y @lpenguin/openai-image-mcp',
    status: 'connected',
    statusText: 'Connected',
    origin: 'local',
  });
  const u = parseMcpLine('unity-editor-mcp: unity mcp - ✔ Connected')!;
  assert.equal(u.name, 'unity-editor-mcp');
  assert.equal(u.target, 'unity mcp');
  assert.equal(u.status, 'connected');
});

test('mcp: 失敗 / 異体字セレクタ / 未知の記号', () => {
  const f = parseMcpLine('broken: node C:\\x\\server.js - ✗ Failed to connect')!;
  assert.equal(f.status, 'failed');
  assert.equal(f.statusText, 'Failed to connect');
  assert.equal(f.target, 'node C:\\x\\server.js');
  assert.equal(parseMcpLine('w: https://x.example/mcp (HTTP) - ⚠️ Needs authentication')!.status, 'needs_auth');
  assert.equal(parseMcpLine('a: b - ✘ Failed')!.status, 'failed');
  assert.equal(parseMcpLine('a: b - ✓ Connected')!.status, 'connected');
  assert.equal(parseMcpLine('a: b - … Pending')!.status, 'unknown');
});

test('mcp: 一覧全体(見出し行や空行は無視)', () => {
  const out = [
    'Checking MCP server health...',
    '',
    'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
    'claude.ai Sentry: https://mcp.sentry.dev/mcp - ! Needs authentication',
    'image-gen: npx -y @lpenguin/openai-image-mcp - ✔ Connected',
    'unity-editor-mcp: unity mcp - ✔ Connected',
    'broken: node server.js - ✗ Failed to connect',
    '',
  ].join('\r\n');
  const list = parseMcpList(out);
  assert.equal(list.length, 5);
  assert.deepEqual(
    list.map((s) => s.status),
    ['connected', 'needs_auth', 'connected', 'connected', 'failed'],
  );
  assert.deepEqual(list.map((s) => s.origin), ['claude.ai', 'claude.ai', 'local', 'local', 'local']);
});

// ---------------------------------------------------------------- frontmatter
test('frontmatter: 1 行の値と引用符', () => {
  const r = parseFrontmatter('---\nname: hub-commander\ndescription: "司令官: 並列で進める"\nother: \'it\'\'s\'\n---\n\n# 見出し\n本文\n');
  assert.equal(r.data.name, 'hub-commander');
  assert.equal(r.data.description, '司令官: 並列で進める');
  assert.equal(r.data.other, "it's");
  assert.equal(firstTextLine(r.body), '本文');
});

test('frontmatter: > で折り返し / | で改行保持 / CRLF', () => {
  const r = parseFrontmatter(
    '---\r\nname: x\r\ndescription: >\r\n  一行目\r\n  二行目\r\n\r\n  段落\r\nnotes: |-\r\n  a\r\n    b\r\nlast: z\r\n---\r\nbody',
  );
  assert.equal(r.data.description, '一行目 二行目\n段落');
  assert.equal(r.data.notes, 'a\n  b');
  assert.equal(r.data.last, 'z');
  assert.equal(r.body, 'body');
});

test('frontmatter: 折り返されたプレーンな値 / frontmatter なし', () => {
  const r = parseFrontmatter('---\ndescription: long text\n  continues here\nname: y\n---\n');
  assert.equal(r.data.description, 'long text continues here');
  assert.equal(r.data.name, 'y');
  const n = parseFrontmatter('# Title\n\n```\ncode\n```\nFirst real line\n');
  assert.deepEqual(n.data, {});
  assert.equal(firstTextLine(n.body), 'First real line');
});

// ---------------------------------------------------------------- PowerShell の引用
test('PowerShell: 単一引用符(アポストロフィ・$・`・空白)', () => {
  assert.equal(psQuote("C:\\Users\\O'Brien\\my dir"), "'C:\\Users\\O''Brien\\my dir'");
  assert.equal(psQuote('$env:X `n'), "'$env:X `n'");
  assert.equal(psQuote('a’b'), "'a’’b'");
  assert.equal(psArg('--model'), '--model');
  assert.equal(psArg('0b1c2d3e-0000-4000-8000-000000000000'), '0b1c2d3e-0000-4000-8000-000000000000');
  assert.equal(psArg('D:/AITEST/p4/hooks.json'), 'D:/AITEST/p4/hooks.json');
  assert.equal(psArg('project,local'), "'project,local'");
  assert.equal(psArg('@x'), "'@x'");
  assert.equal(psArg('a b'), "'a b'");
});

test('PowerShell: コマンドの組み立て', () => {
  const cmd = buildPsCommand({
    cwd: "D:\\Work Tree\\it's",
    claudePath: 'C:\\Users\\me\\.local\\bin\\claude.exe',
    resumeId: '11111111-2222-4333-8444-555555555555',
    extraArgs: ['--permission-mode', 'auto', '--setting-sources', 'project,local'],
  });
  assert.equal(
    cmd,
    "Set-Location -LiteralPath 'D:\\Work Tree\\it''s'; & 'C:\\Users\\me\\.local\\bin\\claude.exe' --resume 11111111-2222-4333-8444-555555555555 --permission-mode auto --setting-sources 'project,local'",
  );
});

test('ランチャー: 既定は cmd.exe /c start、偽ランチャーには同じ argv を渡す', () => {
  const argv = buildTerminalArgv({ name: 'feat "x" & y', cwd: 'D:\\w', claudePath: 'C:\\c.exe', resumeId: 'id', extraArgs: [] });
  assert.deepEqual(argv.slice(0, 7), ['cmd.exe', '/c', 'start', 'CC Hub: feat x y', 'powershell.exe', '-NoExit', '-Command']);
  assert.equal(argv[7], "Set-Location -LiteralPath 'D:\\w'; & 'C:\\c.exe' --resume id");
  assert.deepEqual(launcherCommand('', argv), { file: 'cmd.exe', args: argv.slice(1) });
  const fake = launcherCommand('D:\\AITEST\\p4\\fake-terminal.cjs', argv);
  assert.equal(fake.file, process.execPath);
  assert.deepEqual(fake.args, ['D:\\AITEST\\p4\\fake-terminal.cjs', ...argv]);
  assert.equal(windowTitle(''), 'CC Hub:');
  assert.throws(() => buildTerminalArgv({ name: 'x', cwd: 'D:\\%PATH%\\x', claudePath: 'c', resumeId: 'i', extraArgs: [] }));
});

test('ランチャー: 環境変数(CLAUDE* を除き CC_HUB_SESSION を付ける)', () => {
  const env = terminalEnv('hub-1', { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_x: 'y', CC_HUB_SESSION: 'old', NO_COLOR: '1' });
  assert.deepEqual(env, { PATH: 'p', CC_HUB_SESSION: 'hub-1' });
});

// ---------------------------------------------------------------- 添付ファイル名
test('添付: ファイル名の無害化', () => {
  assert.equal(sanitizeAttachmentName('screen shot 1.png', 'image/png'), 'screen_shot_1.png');
  assert.equal(sanitizeAttachmentName('..\\..\\evil/../a?b*c.PNG', 'image/png'), 'a_b_c.png');
  assert.equal(sanitizeAttachmentName('CON.txt', 'text/plain'), '_CON.txt');
  assert.equal(sanitizeAttachmentName('', 'image/jpeg'), 'file.jpg');
  assert.equal(sanitizeAttachmentName('...', 'application/pdf'), 'file.pdf');
  assert.equal(sanitizeAttachmentName('画面 (1).webp', 'image/webp'), '画面_1_.webp');
  assert.equal(sanitizeAttachmentName('noext', 'image/png'), 'noext.png');
  assert.equal(sanitizeAttachmentName('a\u0000b\nc.md', 'text/markdown'), 'a_b_c.md');
  const long = sanitizeAttachmentName('x'.repeat(200) + '.png', 'image/png');
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('.png'));
});

test('添付: MIME の許可', () => {
  assert.ok(isAllowedMime('image/png'));
  assert.ok(isAllowedMime('text/plain; charset=utf-8'));
  assert.ok(isAllowedMime('application/pdf'));
  assert.ok(!isAllowedMime('application/x-msdownload'));
  assert.ok(!isAllowedMime('application/zip'));
  assert.ok(!isAllowedMime(''));
});

test('activeBackgroundTasks: 終わった状態のタスクは数えない', () => {
  assert.equal(activeBackgroundTasks(undefined), 0);
  assert.equal(activeBackgroundTasks([]), 0);
  assert.equal(activeBackgroundTasks([{ id: 'a' }, 'x']), 2); // 状態が無いものは実行中とみなす
  assert.equal(activeBackgroundTasks([{ status: 'running' }, { status: 'completed' }, { status: 'Failed' }, { status: 'killed' }]), 1);
});

test('overlaps: 同じフォルダか、片方がもう片方の中', () => {
  assert.ok(overlaps('D:\\WorkTree\\game', 'd:/worktree/game/'));
  assert.ok(overlaps('D:\\WorkTree\\game\\sub', 'D:\\WorkTree\\game'));
  assert.ok(overlaps('D:\\WorkTree', 'D:\\WorkTree\\game'));
  assert.ok(!overlaps('D:\\WorkTree\\game', 'D:\\WorkTree\\game-hub'));
  assert.ok(!overlaps('D:\\Unity\\game', 'D:\\WorkTree\\game'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
