// CC Hub の MCP サーバーのツール定義と入力の検証のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { SessionInfo } from '@cc-hub/shared';
import { START_MAX, TOOLS, ToolInputError, callTool, listToolsResult, resetStartLog, sessionForCwd, validateArgs } from '../src/mcp/tools';

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

test('ツールの一覧は契約どおり', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [
      'list_servers',
      'request_deploy',
      'get_deploy_status',
      'list_sessions',
      'get_session',
      'firebase_status',
      'request_firebase_deploy',
      'get_project_instructions',
      'update_project_instructions',
      'unity_status',
      'launch_unity',
      'set_app_launcher',
      'remove_app_launcher',
      'list_projects',
      'register_project',
      'start_session',
      'send_images',
    ],
  );
  const r = listToolsResult() as any;
  const rd = r.tools.find((t: any) => t.name === 'request_deploy');
  assert.deepEqual(rd.inputSchema.required, ['server', 'note']);
  assert.equal(rd.inputSchema.additionalProperties, false);
  assert.ok(rd.description.includes('承認'));
  // cwd を受け取るツールの説明は「作業ディレクトリを渡す」ことを求める
  for (const t of r.tools) if (t.inputSchema.properties.cwd) assert.match(t.inputSchema.properties.cwd.description, /作業ディレクトリ/);
  const up = r.tools.find((t: any) => t.name === 'update_project_instructions');
  assert.match(up.description, /200 行/);
  assert.match(up.description, /既存の内容は残す/);
});

test('validateArgs: 必須・型・未知の引数・長さ・cwd の絶対パス', () => {
  assert.deepEqual(validateArgs('list_servers', undefined), {});
  assert.deepEqual(validateArgs('request_deploy', { server: '本番', note: '公開', cwd: 'D:\\x' }), { server: '本番', note: '公開', cwd: 'D:\\x' });
  assert.throws(() => validateArgs('request_deploy', { server: '本番' }), /note を指定/);
  assert.throws(() => validateArgs('request_deploy', { server: '本番', note: '   ' }), /note を指定/);
  assert.throws(() => validateArgs('request_deploy', { server: 1, note: 'x' }), /文字列/);
  assert.throws(() => validateArgs('request_deploy', { server: 'a', note: 'x', force: 'yes' }), /不明な引数です: force/);
  assert.throws(() => validateArgs('request_deploy', { server: 'a', note: 'x'.repeat(2001) }), /長すぎます/);
  assert.throws(() => validateArgs('get_project_instructions', { cwd: 'relative\\dir' }), /絶対パス/);
  assert.throws(() => validateArgs('get_deploy_status', {}), /deployId/);
  assert.throws(() => validateArgs('list_servers', []), /オブジェクト/);
  assert.throws(() => validateArgs('nope', {}), ToolInputError);
  // null は省略扱い
  assert.deepEqual(validateArgs('request_deploy', { server: 'a', note: 'b', localDir: null }), { server: 'a', note: 'b' });
});

test('validateArgs: request_firebase_deploy(配列・真偽値・選べる値)', () => {
  const ok = validateArgs('request_firebase_deploy', { cwd: 'D:\\site', targets: ['hosting', 'functions', 'hosting'], note: '公開', preview: false });
  assert.deepEqual(ok, { cwd: 'D:\\site', targets: ['hosting', 'functions'], note: '公開', preview: false });
  assert.throws(() => validateArgs('request_firebase_deploy', { cwd: 'D:\\s', targets: [], note: 'x' }), /targets を指定/);
  assert.throws(() => validateArgs('request_firebase_deploy', { cwd: 'D:\\s', targets: 'hosting', note: 'x' }), /配列/);
  assert.throws(() => validateArgs('request_firebase_deploy', { cwd: 'D:\\s', targets: ['database'], note: 'x' }), /使えない値です: database/);
  assert.throws(() => validateArgs('request_firebase_deploy', { cwd: 'D:\\s', targets: ['hosting'], note: 'x', preview: 'no' }), /true \/ false/);
  assert.throws(() => validateArgs('request_firebase_deploy', { targets: ['hosting'], note: 'x' }), /cwd を指定/);
  assert.throws(() => validateArgs('firebase_status', { cwd: 'rel' }), /絶対パス/);
  const r = listToolsResult() as any;
  const fd = r.tools.find((t: any) => t.name === 'request_firebase_deploy');
  assert.deepEqual(fd.inputSchema.required, ['cwd', 'targets', 'note']);
  assert.equal(fd.inputSchema.properties.targets.type, 'array');
  assert.deepEqual(fd.inputSchema.properties.targets.items.enum, ['hosting', 'functions', 'firestore:rules', 'firestore:indexes', 'storage']);
  assert.equal(fd.inputSchema.properties.preview.type, 'boolean');
  assert.match(fd.description, /承認/);
  assert.match(fd.description, /プレビュー/);
  assert.equal(r.tools.find((t: any) => t.name === 'firebase_status').annotations.readOnlyHint, true);
});

const S = (o: Partial<SessionInfo>): SessionInfo => ({ id: 'x', name: 'x', cwd: '', status: 'running', lastEventAt: 0, ...o }) as SessionInfo;

test('sessionForCwd: いちばん深い cwd、動いているもの、新しいもの', () => {
  const all = [
    S({ id: 'root', cwd: 'D:\\p', lastEventAt: 5 }),
    S({ id: 'site-old', cwd: 'D:\\p\\site', lastEventAt: 1 }),
    S({ id: 'site-new', cwd: 'D:\\p\\site', lastEventAt: 2 }),
    S({ id: 'site-stopped', cwd: 'D:\\p\\site', status: 'stopped', lastEventAt: 9 }),
    S({ id: 'other', cwd: 'D:\\q', lastEventAt: 9 }),
  ];
  assert.equal(sessionForCwd(all, 'D:\\P\\Site\\src')?.id, 'site-new');
  assert.equal(sessionForCwd(all, 'D:\\p\\docs')?.id, 'root');
  assert.equal(sessionForCwd(all, 'E:\\none'), null);
  // D:\pp は D:\p の中ではない
  assert.equal(sessionForCwd(all, 'D:\\pp'), null);
});

test('callTool: 引数の誤りは ToolInputError、cwd が無いと共通の指示は読めない', async () => {
  const deps = {
    deploy: { serverList: () => [], job: () => null } as any,
    sessions: () => ({}),
    instructions: {} as any,
    repoIdForCwd: () => null,
  };
  await assert.rejects(callTool('get_project_instructions', {}, deps, { sessionId: null }), /cwd/);
  await assert.rejects(callTool('get_deploy_status', { deployId: 'nope' }, deps, { sessionId: null }), /見つかりません/);
  await assert.rejects(callTool('request_deploy', { server: 'a', note: 'b', localDir: 'dist' }, deps, { sessionId: null }), /cwd も指定/);
  assert.deepEqual(await callTool('list_servers', {}, deps, { sessionId: null }), { servers: [] });
});

/** プロジェクトの機能の偽物(起動したリクエストと登録したフォルダを記録する) */
function projectDeps(sessions: Record<string, SessionInfo> = {}) {
  const started: any[] = [];
  let folders: { path: string; addedAt: number }[] = [{ path: 'D:\\AITEST\\known', addedAt: 1 }];
  const deps = {
    deploy: {} as any,
    sessions: () => sessions,
    instructions: {} as any,
    // D:\wt\game の中はリポジトリ me/game
    repoIdForCwd: (cwd: string) => (/^d:\\wt\\game(\\|$)/i.test(cwd) ? 'me/game' : null),
    projects: {
      repos: () => [{ id: 'me/game', name: 'game', status: 'ready', baseDir: 'D:\\wt\\game', kind: 'unity' } as any],
      folders: () => folders,
      addFolder: (p: string) => {
        if (!folders.some((f) => f.path.toLowerCase() === p.toLowerCase())) folders = [...folders, { path: p, addedAt: 2 }];
        return folders;
      },
      modes: () => [{ id: 'plain', label: 'plain', description: 'ふつう' } as any],
      start: (req: any) => {
        started.push(req);
        return S({ id: `new-${started.length}`, name: req.name || 'auto', status: 'starting', cwd: req.cwd });
      },
    },
  };
  return { deps, started };
}

test('list_projects: リポジトリ・フォルダ・モード・モデル', async () => {
  const { deps } = projectDeps();
  const r = (await callTool('list_projects', {}, deps, { sessionId: null })) as any;
  assert.equal(r.repos[0].id, 'me/game');
  assert.equal(r.folders[0].path, 'D:\\AITEST\\known');
  assert.equal(r.modes[0].id, 'plain');
  assert.ok(r.models.some((m: any) => m.id === 'opus'));
  // 機能が無ければエラー
  await assert.rejects(callTool('list_projects', {}, { ...deps, projects: null }, { sessionId: null }), /使えません/);
});

test('register_project: 省略時は cwd、登録済み・リポジトリの中は何もしない', async () => {
  const { deps } = projectDeps();
  const a = (await callTool('register_project', { cwd: 'D:\\AITEST\\newproj' }, deps, { sessionId: null })) as any;
  assert.equal(a.registered, true);
  assert.ok(a.folders.includes('D:\\AITEST\\newproj'));
  const b = (await callTool('register_project', { cwd: 'D:\\x', path: 'D:\\AITEST\\known' }, deps, { sessionId: null })) as any;
  assert.equal(b.registered, false);
  const c = (await callTool('register_project', { cwd: 'D:\\wt\\game\\wt-01' }, deps, { sessionId: null })) as any;
  assert.equal(c.registered, false);
  assert.equal(c.repoId, 'me/game');
  await assert.rejects(callTool('register_project', { cwd: 'D:\\x', path: 'rel' }, deps, { sessionId: null }), /絶対パス/);
});

test('start_session: プロジェクトの決め方(id・名前・フォルダ・呼び出し元と同じ)', async () => {
  resetStartLog();
  const caller = S({ id: '11111111-1111-1111-1111-111111111111', cwd: 'D:\\wt\\game\\wt-02', repoId: 'me/game', worktreeId: 'w2' } as any);
  const { deps, started } = projectDeps({ [caller.id]: caller });
  const ctx = { sessionId: caller.id };
  // 省略 = 呼び出し元のリポジトリ(worktree を新しく用意する)
  const r = (await callTool('start_session', { cwd: caller.cwd, instruction: 'テストを書く' }, deps, ctx)) as any;
  assert.equal(started[0].repoId, 'me/game');
  assert.equal(started[0].mode, 'plain');
  assert.equal(started[0].instruction, 'テストを書く');
  assert.equal(r.sessionId, 'new-1');
  // 名前でも選べる
  await callTool('start_session', { cwd: 'D:\\x', instruction: 'a', project: 'GAME', name: '修正' }, deps, ctx);
  assert.equal(started[1].repoId, 'me/game');
  assert.equal(started[1].name, '修正');
  // フォルダの絶対パスならそのフォルダで直接
  await callTool('start_session', { cwd: 'D:\\x', instruction: 'a', project: 'D:\\AITEST\\known', mode: 'commander', model: 'sonnet' }, deps, ctx);
  assert.equal(started[2].repoId, undefined);
  assert.equal(started[2].cwd, 'D:\\AITEST\\known');
  assert.equal(started[2].mode, 'commander');
  assert.equal(started[2].model, 'sonnet');
  // 見つからない名前はエラー
  await assert.rejects(callTool('start_session', { cwd: 'D:\\x', instruction: 'a', project: 'nope' }, deps, ctx), /見つかりません/);
  // フォルダのセッションから省略すると、そのフォルダ
  const { deps: d2, started: s2 } = projectDeps();
  await callTool('start_session', { cwd: 'D:\\AITEST\\plainproj', instruction: 'a' }, d2, { sessionId: null });
  assert.equal(s2[0].cwd, 'D:\\AITEST\\plainproj');
  assert.equal(s2[0].repoId, undefined);
  assert.throws(() => validateArgs('start_session', { cwd: 'D:\\x' }), /instruction を指定/);
});

test('start_session: 呼び出し元ごとの回数制限', async () => {
  resetStartLog();
  const { deps, started } = projectDeps();
  const ctx = { sessionId: null };
  for (let i = 0; i < START_MAX; i++) await callTool('start_session', { cwd: 'D:\\AITEST\\a', instruction: 'x' }, deps, ctx);
  await assert.rejects(callTool('start_session', { cwd: 'D:\\AITEST\\a', instruction: 'x' }, deps, ctx), /起動しすぎ/);
  assert.equal(started.length, START_MAX);
  // 別の呼び出し元は数えない
  await callTool('start_session', { cwd: 'D:\\AITEST\\b', instruction: 'x' }, deps, ctx);
  assert.equal(started.length, START_MAX + 1);
  resetStartLog();
});

void Promise.all(pending).then(() => console.log(`\nmcp: ${passed} passed`));
