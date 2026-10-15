// 「アプリを開く」ボタンの検証・一覧の更新・{cwd} の置き換え・cmd.exe の引数のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { AppLauncher } from '@cc-hub/shared';
import {
  LAUNCHER_MAX,
  expandCommand,
  launcherEnv,
  normalizeLaunchers,
  removeLauncher,
  startArgs,
  unityMessage,
  upsertLauncher,
  validateLauncherSpec,
} from '../src/session/launchers';
import { HttpError } from '../src/util';
import { TOOLS, callTool, validateArgs } from '../src/mcp/tools';

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}\n     ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };
  pending.push((pending.length ? pending[pending.length - 1] : Promise.resolve()).then(run));
}

function throws400(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400 && re.test(e.message));
}

test('ボタンの検証: label は 1〜30 文字', () => {
  throws400(() => validateLauncherSpec({ label: '  ', command: 'x' }), /名前/);
  throws400(() => validateLauncherSpec({ label: 'a'.repeat(31), command: 'x' }), /30 文字/);
  assert.equal(validateLauncherSpec({ label: ' ' + 'a'.repeat(30) + ' ', command: 'x' }).label.length, 30);
});

test('ボタンの検証: kind は unity / command(省略は command)', () => {
  assert.equal(validateLauncherSpec({ label: 'T', command: 'x' }).kind, 'command');
  throws400(() => validateLauncherSpec({ label: 'T', kind: 'exe', command: 'x' }), /kind/);
  // unity は command 不要(渡されても捨てる)
  assert.deepEqual(validateLauncherSpec({ label: 'Unity', kind: 'unity', command: 'rm -rf /' }), { label: 'Unity', kind: 'unity', command: null });
});

test('ボタンの検証: command は必須・1000 文字まで・改行と NUL は不可', () => {
  throws400(() => validateLauncherSpec({ label: 'T', kind: 'command' }), /command/);
  throws400(() => validateLauncherSpec({ label: 'T', command: 'x'.repeat(1001) }), /1000/);
  throws400(() => validateLauncherSpec({ label: 'T', command: 'a\nb' }), /改行/);
  throws400(() => validateLauncherSpec({ label: 'T', command: 'a\rb' }), /改行/);
  throws400(() => validateLauncherSpec({ label: 'T', command: 'a\0b' }), /NUL/);
  assert.equal(validateLauncherSpec({ label: 'T', command: '  npm run tool  ' }).command, 'npm run tool');
});

test('一覧の保存: 既存の id は lastRunAt / lastError / addedBy を引き継ぎ、新規は id を振って addedBy user', () => {
  const existing: AppLauncher[] = [
    { id: 'aaa', label: 'Old', kind: 'command', command: 'a', addedBy: 'claude', lastRunAt: 123, lastError: 'boom' },
  ];
  const out = normalizeLaunchers(
    [
      { id: 'aaa', label: 'Renamed', kind: 'command', command: 'b', lastRunAt: 999, lastError: null, addedBy: 'user' },
      { label: 'New', kind: 'unity' },
      { id: 'unknown', label: 'Third', command: 'c' },
    ],
    existing,
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: 'aaa', label: 'Renamed', kind: 'command', command: 'b', addedBy: 'claude', lastRunAt: 123, lastError: 'boom' });
  assert.match(out[1].id, /^[0-9a-f]{12}$/);
  assert.equal(out[1].addedBy, 'user');
  assert.equal(out[1].lastRunAt, null);
  assert.notEqual(out[2].id, 'unknown');
  assert.notEqual(out[1].id, out[2].id);
});

test('一覧の保存: 10 個まで・同じ名前は不可・配列以外は不可', () => {
  const many = Array.from({ length: LAUNCHER_MAX + 1 }, (_, i) => ({ label: `L${i}`, command: 'x' }));
  throws400(() => normalizeLaunchers(many), /10 個/);
  assert.equal(normalizeLaunchers(many.slice(0, LAUNCHER_MAX)).length, LAUNCHER_MAX);
  throws400(() => normalizeLaunchers([{ label: 'A', command: 'x' }, { label: 'a', command: 'y' }]), /同じ名前/);
  throws400(() => normalizeLaunchers({ label: 'A' }), /配列/);
  assert.deepEqual(normalizeLaunchers([]), []);
});

test('Claude からの登録: 同じ label は上書き(id は同じ)、新規は addedBy claude、上限で 409', () => {
  let list = upsertLauncher([], { label: 'Tool', command: 'npm run tool' }, 'claude');
  assert.equal(list[0].addedBy, 'claude');
  const id = list[0].id;
  list = upsertLauncher(list, { label: 'tool', kind: 'unity' }, 'claude');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].kind, 'unity');
  assert.equal(list[0].command, null);
  const full = Array.from({ length: LAUNCHER_MAX }, (_, i) => upsertLauncher([], { label: `L${i}`, command: 'x' }, 'user')[0]);
  assert.throws(() => upsertLauncher(full, { label: 'more', command: 'x' }, 'claude'), (e: unknown) => e instanceof HttpError && e.status === 409);
  // 既存の名前なら上限でも上書きできる
  assert.equal(upsertLauncher(full, { label: 'L3', command: 'y' }, 'claude')[3].command, 'y');
});

test('削除: label で取り除く(無ければ 404)', () => {
  const list = upsertLauncher(upsertLauncher([], { label: 'A', command: 'x' }, 'user'), { label: 'B', command: 'y' }, 'user');
  assert.deepEqual(removeLauncher(list, ' a ').map((x) => x.label), ['B']);
  assert.throws(() => removeLauncher(list, 'C'), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test('{cwd} は作業フォルダに置き換わる(何か所でも)', () => {
  assert.equal(expandCommand('"C:\\Tools\\Viewer.exe" "{cwd}\\out" --root {cwd}', 'D:\\WorkTree\\demo\\wt-01'), '"C:\\Tools\\Viewer.exe" "D:\\WorkTree\\demo\\wt-01\\out" --root D:\\WorkTree\\demo\\wt-01');
  assert.equal(expandCommand('npm run tool', 'D:\\x'), 'npm run tool');
});

test('cmd.exe の引数: /d /s /c "start "" <コマンドライン>"(中の引用符はそのまま)', () => {
  const line = `node -e "require('fs').writeFileSync('D:/AITEST/p9/ran.txt', process.cwd())"`;
  assert.deepEqual(startArgs(line), ['/d', '/s', '/c', `"start "" ${line}"`]);
  // /s は最初と最後の " だけを外すので、外したあとが start "" <コマンドライン> になる
  const a = startArgs('"C:\\My Tools\\x.exe" "D:\\a b"')[3];
  assert.equal(a.slice(1, -1), 'start "" "C:\\My Tools\\x.exe" "D:\\a b"');
});

test('起動時の環境変数から CLAUDE* / CLAUDECODE を取り除く', () => {
  const env = launcherEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_x: 'y', CC_HUB_SESSION: 's', USERPROFILE: 'u' });
  assert.deepEqual(env, { PATH: 'p', CC_HUB_SESSION: 's', USERPROFILE: 'u' });
});

test('Unity の起動結果の文', () => {
  const base = { projectPath: 'D:\\u', editorVersion: '6000.0.1f1', editorPath: 'x', installedVersions: [], runningPid: 42 };
  assert.match(unityMessage({ ...base, launched: true }), /6000\.0\.1f1 でプロジェクトを開きました\(PID 42\)/);
  assert.match(unityMessage({ ...base, launched: false }), /既に Unity エディタで開いています/);
});

// ------------------------------------------------------------ MCP
const S = (id: string, cwd: string): any => ({ id, name: id, cwd, status: 'awaiting_input', lastEventAt: 1, managed: true });

test('MCP: set_app_launcher / remove_app_launcher の入力スキーマ', () => {
  const t = TOOLS.find((x) => x.name === 'set_app_launcher')!;
  assert.match(t.description, /CC Hub のボタンからいつでも起動できるようにする/);
  assert.match(t.description, /kind: 'unity'/);
  assert.match(t.description, /\{cwd\} は作業フォルダ/);
  assert.deepEqual(t.required, ['cwd', 'label']);
  assert.throws(() => validateArgs('set_app_launcher', { cwd: 'D:\\x', label: 'T', kind: 'exe' }), /使えない値/);
  assert.equal(validateArgs('set_app_launcher', { cwd: 'D:\\x', label: 'T', kind: 'unity' }).kind, 'unity');
});

test('MCP: cwd からセッションを推定してボタンを登録 / 削除する', async () => {
  const calls: any[] = [];
  let list: AppLauncher[] = [];
  const d: any = {
    sessions: () => ({ a: S('a', 'D:\\WorkTree\\demo\\wt-01'), b: S('b', 'D:\\other') }),
    launchers: {
      upsert: (sid: string, spec: any) => {
        calls.push(['upsert', sid, spec]);
        list = upsertLauncher(list, spec, 'claude');
        return list;
      },
      remove: (sid: string, label: string) => {
        calls.push(['remove', sid, label]);
        list = removeLauncher(list, label);
        return list;
      },
    },
  };
  const r: any = await callTool('set_app_launcher', { cwd: 'D:\\WorkTree\\demo\\wt-01\\tools', label: 'マップ', command: 'npm run map' }, d, { sessionId: null });
  assert.deepEqual(calls[0], ['upsert', 'a', { label: 'マップ', kind: 'command', command: 'npm run map' }]);
  assert.equal(r.launchers[0].addedBy, 'claude');
  const u: any = await callTool('set_app_launcher', { cwd: 'D:\\WorkTree\\demo\\wt-01', label: 'Unity', kind: 'unity', command: 'ignored' }, d, { sessionId: null });
  assert.deepEqual(calls[1][2], { label: 'Unity', kind: 'unity', command: null });
  assert.equal(u.launchers.length, 2);
  const rm: any = await callTool('remove_app_launcher', { cwd: 'D:\\WorkTree\\demo\\wt-01', label: 'マップ' }, d, { sessionId: null });
  assert.deepEqual(rm.launchers.map((x: any) => x.label), ['Unity']);
  await assert.rejects(() => callTool('set_app_launcher', { cwd: 'D:\\nowhere', label: 'X', command: 'y' }, d, { sessionId: null }), /セッションが見つかりません/);
  // command 無しの command は検証で 400
  await assert.rejects(() => callTool('set_app_launcher', { cwd: 'D:\\other', label: 'X' }, d, { sessionId: null }), /command/);
});

void Promise.all(pending).then(() => console.log(`\n${passed} passed${process.exitCode ? ', FAILED' : ''}`));
