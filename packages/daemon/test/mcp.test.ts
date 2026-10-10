// CC Hub の MCP サーバーのツール定義と入力の検証のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import type { SessionInfo } from '@cc-hub/shared';
import { TOOLS, ToolInputError, callTool, listToolsResult, sessionForCwd, validateArgs } from '../src/mcp/tools';

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

void Promise.all(pending).then(() => console.log(`\nmcp: ${passed} passed`));
