// Firebase 連携のテスト: firebase.json / .firebaserc の読み取り、対象 → CLI 名、チャンネル名、CLI の --json 出力の読み取り、
// firebase CLI の起動方法の決定、デプロイの手順と状態遷移(偽の CLI 実行器で。本物の firebase は呼ばない)。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeployJob } from '@cc-hub/shared';
import {
  checkChannel,
  cliOnly,
  configuredOf,
  defaultChannelName,
  explainFirebaseError,
  findProjectDir,
  hostingSites,
  normalizeTargets,
  parseChannelDeploy,
  parseChannelList,
  parseFirebaseJson,
  parseFirebaseRc,
  parseFunctionsList,
  parseLoginList,
  parseProjectsList,
  parseSitesList,
  targetConfigured,
} from '../src/firebase/config';
import { SAFE_ARG_RE, resolveFirebaseCommand, type CliOptions, type CliResult, type FirebaseRunner } from '../src/firebase/cli';
import { planFirebase, stepArgs } from '../src/firebase/pipeline';
import { infoSummary } from '../src/firebase/info';
import { DeployService } from '../src/deploy/service';

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      console.log(`FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`);
      process.exitCode = 1;
    }
  };
  pending.push((pending.length ? pending[pending.length - 1] : Promise.resolve()).then(run));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-fb-'));

// ------------------------------------------------------------ 設定ファイル
test('firebase.json: hosting がオブジェクト / 配列(site・target)、functions / firestore / storage', () => {
  const a = parseFirebaseJson(JSON.stringify({ hosting: { public: 'dist', predeploy: 'npm run build' } }));
  assert.deepEqual(a.hosting, [{ site: null, target: null, public: 'dist', predeploy: ['npm run build'] }]);
  assert.equal(a.functions, false);
  assert.equal(a.firestore, null);
  assert.deepEqual(configuredOf(a), { hosting: true, functions: false, firestore: false, storage: false });
  const b = parseFirebaseJson(
    '\uFEFF' +
      JSON.stringify({
        hosting: [
          { site: 'my-blog', public: 'blog' },
          { target: 'app', public: 'app' },
        ],
        functions: [{ source: 'functions', codebase: 'default' }],
        firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
        storage: { rules: 'storage.rules' },
      }),
  );
  assert.equal(b.hosting.length, 2);
  assert.equal(b.hosting[0].site, 'my-blog');
  assert.equal(b.hosting[1].target, 'app');
  assert.equal(b.functions, true);
  assert.deepEqual(b.firestore, { rules: true, indexes: true });
  assert.equal(b.storage, true);
  for (const t of ['hosting', 'functions', 'firestore:rules', 'firestore:indexes', 'storage'] as const) assert.equal(targetConfigured(b, t), true);
  const c = parseFirebaseJson(JSON.stringify({ firestore: { rules: 'r' } }));
  assert.equal(targetConfigured(c, 'firestore:rules'), true);
  assert.equal(targetConfigured(c, 'firestore:indexes'), false);
  assert.equal(targetConfigured(c, 'hosting'), false);
  assert.throws(() => parseFirebaseJson('{oops'), /firebase\.json を読めません/);
  assert.throws(() => parseFirebaseJson('[]'), /形式が不正/);
});

test('.firebaserc: default・別名・hosting の targets → サイト名', () => {
  const rc = parseFirebaseRc(
    JSON.stringify({
      projects: { default: 'proj-dev', prod: 'proj-prod' },
      targets: { 'proj-dev': { hosting: { app: ['proj-dev-app'] } } },
      etags: {},
    }),
  );
  assert.equal(rc.default, 'proj-dev');
  assert.deepEqual(rc.aliases, { prod: 'proj-prod' });
  assert.deepEqual(rc.hostingTargets, { 'proj-dev': { app: ['proj-dev-app'] } });
  assert.deepEqual(parseFirebaseRc(null), { default: null, aliases: {}, hostingTargets: {} });
  const json = parseFirebaseJson(JSON.stringify({ hosting: [{ site: 'blog' }, { target: 'app' }, { public: 'x' }] }));
  assert.deepEqual(hostingSites(json, rc, 'proj-dev', 'proj-dev'), ['blog', 'proj-dev-app', 'proj-dev']);
  // 別のプロジェクトには target の対応が無い
  assert.deepEqual(hostingSites(json, rc, 'proj-prod', 'proj-prod'), ['blog', 'proj-prod']);
});

test('findProjectDir: 上のフォルダの firebase.json を探す', () => {
  const root = path.join(tmp, 'find');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'firebase.json'), '{}');
  assert.equal(findProjectDir(path.join(root, 'src', 'deep')), root);
  assert.equal(findProjectDir(root), root);
});

test('対象の検証と firebase deploy --only の名前', () => {
  assert.deepEqual(normalizeTargets(['functions', 'hosting', 'hosting']), ['hosting', 'functions']);
  assert.deepEqual(normalizeTargets('storage,firestore:rules'), ['firestore:rules', 'storage']);
  assert.throws(() => normalizeTargets(['database']), /不明な対象です: database/);
  assert.throws(() => normalizeTargets([]), /targets を指定/);
  assert.equal(cliOnly(['storage', 'functions', 'firestore:indexes', 'firestore:rules']), 'functions,firestore:rules,firestore:indexes,storage');
  assert.equal(cliOnly(['hosting']), 'hosting');
});

test('チャンネル名: 既定は cchub-<yyyymmdd>-<hhmm>、live や記号は不可', () => {
  assert.equal(defaultChannelName(new Date(2026, 0, 5, 9, 7)), 'cchub-20260105-0907');
  assert.match(defaultChannelName(), /^cchub-\d{8}-\d{4}$/);
  assert.equal(checkChannel('feature-x'), 'feature-x');
  assert.throws(() => checkChannel('live'), /live は不可/);
  assert.throws(() => checkChannel('a b'), /チャンネル名が不正/);
  assert.throws(() => checkChannel('x&calc'), /チャンネル名が不正/);
  assert.throws(() => checkChannel('x'.repeat(41)), /チャンネル名が不正/);
});

// ------------------------------------------------------------ CLI の出力(実物の形)
test('hosting:channel:deploy --json(複数サイト・期限)', () => {
  const out = JSON.stringify(
    {
      status: 'success',
      result: {
        'my-site': { site: 'my-site', url: 'https://my-site--cchub-20260105-0907-ab12cd34.web.app', version: 'sites/my-site/versions/abc', expireTime: '2026-01-12T00:07:00.000Z' },
        app: { target: 'app', site: 'proj-app', url: 'https://proj-app--cchub-20260105-0907-zz.web.app', expireTime: '' },
      },
    },
    null,
    2,
  );
  const r = parseChannelDeploy(`i  hosting: preparing\n${out}\n`);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { key: 'my-site', site: 'my-site', url: 'https://my-site--cchub-20260105-0907-ab12cd34.web.app', expireAt: Date.parse('2026-01-12T00:07:00.000Z') });
  assert.equal(r[1].site, 'proj-app');
  assert.equal(r[1].expireAt, null);
  assert.throws(() => parseChannelDeploy(JSON.stringify({ status: 'error', error: 'Failed to get Firebase project fake. Please make sure the project exists' })), /Failed to get Firebase project/);
  assert.throws(() => parseChannelDeploy(JSON.stringify({ status: 'success', result: {} })), /URL を取得できません/);
  assert.throws(() => parseChannelDeploy('not json'), /読めませんでした/);
});

test('hosting:channel:list / hosting:sites:list / projects:list / functions:list / login:list', () => {
  // zemi-3rd-exhibition の実際の出力と同じ形
  const ch = parseChannelList(
    JSON.stringify({
      status: 'success',
      result: {
        channels: [
          {
            name: 'projects/zemi-3rd-exhibition/sites/zemi-3rd-exhibition/channels/live',
            url: 'https://zemi-3rd-exhibition.web.app',
            createTime: '2026-10-05T12:07:05.067524261Z',
            updateTime: '2026-10-05T12:07:05.067524261Z',
            retainedReleaseCount: 2147483647,
          },
          {
            name: 'projects/zemi-3rd-exhibition/sites/zemi-3rd-exhibition/channels/cchub-20261010-1200',
            url: 'https://zemi-3rd-exhibition--cchub-20261010-1200-x1y2z3.web.app',
            expireTime: '2026-10-17T03:00:00Z',
            updateTime: '2026-10-10T03:00:00Z',
          },
        ],
      },
    }),
    'fallback',
  );
  assert.equal(ch.length, 2);
  assert.deepEqual(ch[0], { site: 'zemi-3rd-exhibition', channel: 'live', url: 'https://zemi-3rd-exhibition.web.app', expireAt: null, updatedAt: Date.parse('2026-10-05T12:07:05.067524261Z') });
  assert.equal(ch[1].channel, 'cchub-20261010-1200');
  assert.equal(ch[1].expireAt, Date.parse('2026-10-17T03:00:00Z'));
  assert.throws(() => parseChannelList(JSON.stringify({ status: 'error', error: 'Not in a Firebase app directory (could not locate firebase.json)' }), 'x'), /firebase\.json/);

  const sites = parseSitesList(
    JSON.stringify({
      status: 'success',
      result: {
        sites: [
          { name: 'projects/p/sites/p-blog', defaultUrl: 'https://p-blog.web.app', type: 'USER_SITE' },
          { name: 'projects/p/sites/p', defaultUrl: 'https://p.web.app', type: 'DEFAULT_SITE' },
        ],
      },
    }),
  );
  assert.deepEqual(sites, [
    { site: 'p', url: 'https://p.web.app' },
    { site: 'p-blog', url: 'https://p-blog.web.app' },
  ]);

  const projects = parseProjectsList(
    JSON.stringify({
      status: 'success',
      result: [
        { projectId: 'fir-practice-fc1e3', projectNumber: '336328218922', displayName: 'FirebasePractice', name: 'projects/fir-practice-fc1e3', resources: { hostingSite: 'fir-practice-fc1e3' }, state: 'ACTIVE' },
        { projectId: 'no-hosting', displayName: '' },
      ],
    }),
  );
  assert.deepEqual(projects, [
    { projectId: 'fir-practice-fc1e3', displayName: 'FirebasePractice', hostingSite: 'fir-practice-fc1e3' },
    { projectId: 'no-hosting', displayName: null, hostingSite: null },
  ]);

  const fns = parseFunctionsList(
    JSON.stringify({
      status: 'success',
      result: [
        { id: 'api', region: 'asia-northeast1', platform: 'gcfv2', runtime: 'nodejs20', httpsTrigger: {}, state: 'ACTIVE' },
        { id: 'onUserCreate', region: 'us-central1', platform: 'gcfv1', runtime: 'nodejs18', eventTrigger: { eventType: 'providers/firebase.auth/eventTypes/user.create' } },
        { id: 'nightly', region: 'us-central1', scheduleTrigger: { schedule: 'every day 00:00' } },
      ],
    }),
  );
  assert.deepEqual(fns[0], { name: 'api', region: 'asia-northeast1', runtime: 'nodejs20', state: 'ACTIVE', trigger: 'https' });
  assert.equal(fns[1].trigger, 'providers/firebase.auth/eventTypes/user.create');
  assert.equal(fns[2].trigger, 'schedule');
  assert.deepEqual(parseFunctionsList(JSON.stringify({ status: 'success', result: [] })), []);

  assert.equal(parseLoginList('Logged in as someone@example.com\n'), 'someone@example.com');
  assert.equal(parseLoginList('\x1b[33m⚠\x1b[39m  No authorized accounts, run "firebase login"'), null);
});

test('エラーの説明(日本語)', () => {
  assert.match(explainFirebaseError('Error: Failed to authenticate, have you run firebase login?'), /firebase login が必要/);
  assert.match(explainFirebaseError("'firebase' is not recognized as an internal or external command"), /CLI が見つかりません/);
  assert.match(explainFirebaseError('Error: HTTP Error: 403, The caller does not have permission'), /アクセスできません/);
  assert.match(explainFirebaseError('{"status":"error","error":"Something odd"}'), /Something odd/);
});

test('firebase CLI の起動方法: .cjs は node、.cmd は隣の本体を node、無ければ cmd /c(引数を限定)', () => {
  const r1 = resolveFirebaseCommand('D:\\x\\fake-firebase.cjs');
  assert.equal(r1.file, process.execPath);
  assert.deepEqual(r1.prefix, ['D:\\x\\fake-firebase.cjs']);
  const npmDir = path.join(tmp, 'npm');
  const js = path.join(npmDir, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '');
  fs.writeFileSync(path.join(npmDir, 'firebase.cmd'), '@echo off');
  const r2 = resolveFirebaseCommand(path.join(npmDir, 'firebase.cmd'));
  assert.deepEqual([r2.file, r2.prefix, r2.viaCmd], [process.execPath, [js], false]);
  // 自動: APPDATA\npm の firebase-tools
  const r3 = resolveFirebaseCommand('', { APPDATA: tmp, PATH: '' });
  assert.deepEqual([r3.file, r3.prefix], [process.execPath, [js]]);
  // 何も無ければ cmd.exe /d /c firebase(引数は SAFE_ARG_RE のみ)
  const r4 = resolveFirebaseCommand('', { APPDATA: path.join(tmp, 'none'), PATH: '', ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.deepEqual([r4.file, r4.prefix, r4.viaCmd], ['C:\\Windows\\system32\\cmd.exe', ['/d', '/c', 'firebase'], true]);
  assert.ok(SAFE_ARG_RE.test('cchub-20260105-0907'));
  assert.ok(SAFE_ARG_RE.test('functions,firestore:rules'));
  assert.ok(SAFE_ARG_RE.test('site:live'));
  assert.ok(!SAFE_ARG_RE.test('a&calc'));
  assert.ok(!SAFE_ARG_RE.test('a|b'));
  assert.ok(!SAFE_ARG_RE.test('%PATH%'));
});

// ------------------------------------------------------------ 手順
test('手順: Hosting + preview / Hosting + functions / preview なし / Hosting 以外だけ', () => {
  const a = planFirebase({ targets: ['hosting'], preview: true, channel: 'ch1', buildCommand: null });
  assert.deepEqual(a, { first: [{ kind: 'channel', channel: 'ch1' }], stopAtPreview: true, onPromote: [{ kind: 'clone', channel: 'ch1' }] });
  const b = planFirebase({ targets: ['hosting', 'functions', 'firestore:rules'], preview: true, channel: 'ch1', buildCommand: 'npm run build' });
  assert.deepEqual(b.first, [{ kind: 'build', command: 'npm run build' }, { kind: 'channel', channel: 'ch1' }]);
  assert.deepEqual(b.onPromote, [{ kind: 'deploy', targets: ['functions', 'firestore:rules'] }, { kind: 'clone', channel: 'ch1' }]);
  const c = planFirebase({ targets: ['hosting', 'functions'], preview: false, channel: 'ch1', buildCommand: null });
  assert.deepEqual(c, { first: [{ kind: 'deploy', targets: ['hosting', 'functions'] }], stopAtPreview: false, onPromote: [] });
  const d = planFirebase({ targets: ['functions'], preview: true, channel: 'ch1', buildCommand: null });
  assert.equal(d.stopAtPreview, false);
  assert.deepEqual(d.first, [{ kind: 'deploy', targets: ['functions'] }]);
  assert.deepEqual(stepArgs({ kind: 'channel', channel: 'ch1' }, 'p1'), ['hosting:channel:deploy', 'ch1', '--expires', '7d', '--json', '--project', 'p1', '--non-interactive']);
  assert.deepEqual(stepArgs({ kind: 'deploy', targets: ['functions', 'storage'] }, 'p1'), ['deploy', '--only', 'functions,storage', '--json', '--project', 'p1', '--non-interactive']);
  assert.deepEqual(stepArgs({ kind: 'clone', channel: 'ch1' }, 'p1', 'site1'), ['hosting:clone', 'site1:ch1', 'site1:live', '--project', 'p1', '--non-interactive']);
});

test('infoSummary: 期限切れ・live のチャンネルは出さない', () => {
  const s = infoSummary({
    projectDir: 'D:\\p',
    projectId: 'p',
    aliases: {},
    configured: { hosting: true, functions: true, firestore: false, storage: false },
    sites: [{ site: 'p', url: 'https://p.web.app' }],
    channels: [
      { site: 'p', channel: 'live', url: 'https://p.web.app', expireAt: null, updatedAt: 1 },
      { site: 'p', channel: 'old', url: 'https://old', expireAt: 1, updatedAt: 1 },
      { site: 'p', channel: 'new', url: 'https://new', expireAt: Date.now() + 1e6, updatedAt: 2 },
    ],
    functions: [{ name: 'api', region: 'us-central1', runtime: 'nodejs20', state: null, trigger: 'https' }],
    account: 'a@b.c',
    projects: [],
    checkedAt: 0,
    error: null,
  });
  assert.deepEqual(s.previewChannels.map((c) => c.channel), ['new']);
  assert.deepEqual(s.deployableTargets, ['hosting', 'functions']);
  assert.deepEqual(s.liveUrls, ['https://p.web.app']);
});

// ------------------------------------------------------------ 状態遷移(偽の CLI)
function fakeStore() {
  const rows = new Map<string, string>();
  return {
    db: {
      exec: () => undefined,
      prepare: (sql: string) => ({
        all: () => [],
        get: () => undefined,
        run: (...a: any[]) => {
          if (/INSERT OR REPLACE INTO deploys/.test(sql)) rows.set(a[0], a[2]);
          if (/DELETE FROM deploys/.test(sql)) rows.delete(a[0]);
        },
      }),
    },
    rows,
  };
}

/** 偽の firebase 実行器。calls に引数を記録。fail = 失敗させるコマンド(先頭の引数)。gate = 終わらせるまで待たせる */
function fakeRunner(o: { fail?: string; slow?: boolean } = {}) {
  const calls: string[][] = [];
  const gates: (() => void)[] = [];
  const run: FirebaseRunner = (args: string[], opt: CliOptions) => {
    calls.push(args);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    if (o.slow) gates.push(release);
    else release();
    const done = gate.then((): CliResult => {
      opt.onLine?.(`fake: ${args[0]}`, 'stderr');
      if (o.fail && args[0] === o.fail) return { code: 1, stdout: '', stderr: 'Error: HTTP Error: 400, Build failed', timedOut: false };
      if (args[0] === 'hosting:channel:deploy') {
        const ch = args[1];
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'success', result: { 'fake-proj': { site: 'fake-proj', url: `https://fake-proj--${ch}-abc123.web.app`, expireTime: '2030-01-08T00:00:00Z' } } }),
          stderr: '',
          timedOut: false,
        };
      }
      if (args[0] === 'deploy') return { code: 0, stdout: JSON.stringify({ status: 'success', result: {} }), stderr: '', timedOut: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    });
    return { done, kill: () => release() };
  };
  return { run, calls, gates };
}

function makeProject(name: string, json: object): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'fake-proj' } }));
  return dir;
}

async function waitState(svc: DeployService, id: string, states: DeployJob['state'][]): Promise<DeployJob> {
  for (let i = 0; i < 200; i++) {
    const j = svc.job(id)!;
    if (states.includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`状態が ${states.join('/')} になりません: ${svc.job(id)?.state} ${svc.job(id)?.error ?? ''}`);
}

function svcWith(run: FirebaseRunner): DeployService {
  return new DeployService({ store: fakeStore() as any, secrets: {} as any, sessionName: () => 'sess', firebase: { run, info: null } });
}

test('ユーザー: Hosting プレビュー → preview_ready → promote → done(本番 URL)', async () => {
  const dir = makeProject('p-user', { hosting: { public: 'public' } });
  const f = fakeRunner();
  const svc = svcWith(f.run);
  const job = svc.createFirebaseUserJob({ cwd: path.join(dir, 'public'), targets: ['hosting'], channel: 'ch-test' });
  assert.equal(job.serverId, '');
  assert.equal(job.serverName, 'Firebase: fake-proj');
  assert.equal(job.firebase?.projectDir, dir);
  const pr = await waitState(svc, job.id, ['preview_ready', 'failed']);
  assert.equal(pr.state, 'preview_ready');
  assert.equal(pr.firebase?.previewUrl, 'https://fake-proj--ch-test-abc123.web.app');
  assert.equal(pr.url, pr.firebase?.previewUrl);
  assert.equal(pr.firebase?.previewExpiresAt, Date.parse('2030-01-08T00:00:00Z'));
  assert.deepEqual(f.calls, [['hosting:channel:deploy', 'ch-test', '--expires', '7d', '--json', '--project', 'fake-proj', '--non-interactive']]);
  assert.ok(pr.log.some((l) => l.includes('fake: hosting:channel:deploy')));
  assert.throws(() => svc.approve(job.id), /承認待ちではありません/);
  svc.promote(job.id);
  const done = await waitState(svc, job.id, ['done', 'failed']);
  assert.equal(done.state, 'done');
  assert.equal(done.firebase?.promoted, true);
  assert.equal(done.url, 'https://fake-proj.web.app');
  assert.deepEqual(f.calls[1], ['hosting:clone', 'fake-proj:ch-test', 'fake-proj:live', '--project', 'fake-proj', '--non-interactive']);
  assert.throws(() => svc.promote(job.id), /プレビューの確認待ちではありません/);
});

test('Claude: Hosting + functions → 承認 → プレビュー(functions はまだ)→ promote で functions → clone', async () => {
  const dir = makeProject('p-claude', { hosting: { public: 'public' }, functions: { source: 'functions' } });
  const f = fakeRunner();
  const svc = svcWith(f.run);
  const job = svc.requestFirebaseFromClaude({ cwd: dir, targets: ['functions', 'hosting'], note: '公開します', sessionId: null });
  assert.equal(job.state, 'pending_approval');
  assert.deepEqual(job.firebase?.targets, ['hosting', 'functions']);
  assert.equal(job.firebase?.channel, null);
  assert.equal(f.calls.length, 0);
  svc.approve(job.id);
  const pr = await waitState(svc, job.id, ['preview_ready', 'failed']);
  assert.equal(pr.state, 'preview_ready');
  assert.match(pr.firebase!.channel!, /^cchub-\d{8}-\d{4}$/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'hosting:channel:deploy');
  svc.promote(job.id);
  const done = await waitState(svc, job.id, ['done', 'failed']);
  assert.equal(done.state, 'done');
  assert.deepEqual(f.calls.slice(1).map((c) => c.slice(0, 3)), [
    ['deploy', '--only', 'functions'],
    ['hosting:clone', `fake-proj:${pr.firebase!.channel}`, 'fake-proj:live'],
  ]);
});

test('promote で functions が失敗したら Hosting は本番に反映しない', async () => {
  const dir = makeProject('p-fail', { hosting: { public: 'public' }, functions: { source: 'functions' } });
  const f = fakeRunner({ fail: 'deploy' });
  const svc = svcWith(f.run);
  const job = svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting', 'functions'] });
  await waitState(svc, job.id, ['preview_ready']);
  svc.promote(job.id);
  const j = await waitState(svc, job.id, ['done', 'failed']);
  assert.equal(j.state, 'failed');
  assert.ok(!f.calls.some((c) => c[0] === 'hosting:clone'));
  assert.equal(j.firebase?.promoted, false);
  assert.ok(j.error);
});

test('Hosting 以外だけ / preview なしは deploy --only で直接 done', async () => {
  const dir = makeProject('p-direct', { hosting: { public: 'public' }, functions: {}, firestore: { rules: 'r', indexes: 'i' }, storage: { rules: 's' } });
  const f = fakeRunner();
  const svc = svcWith(f.run);
  const a = svc.createFirebaseUserJob({ cwd: dir, targets: ['storage', 'functions', 'firestore:rules', 'firestore:indexes'] });
  const ja = await waitState(svc, a.id, ['done', 'failed']);
  assert.equal(ja.state, 'done');
  assert.equal(ja.url, null);
  assert.deepEqual(f.calls[0], ['deploy', '--only', 'functions,firestore:rules,firestore:indexes,storage', '--json', '--project', 'fake-proj', '--non-interactive']);
  const b = svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting'], preview: false });
  assert.equal(b.firebase?.channel, null);
  const jb = await waitState(svc, b.id, ['done', 'failed']);
  assert.equal(jb.state, 'done');
  assert.equal(jb.url, 'https://fake-proj.web.app');
  assert.deepEqual(f.calls[1].slice(0, 3), ['deploy', '--only', 'hosting']);
});

test('入力の検証と、同じプロジェクトは同時に 1 本だけ', async () => {
  const dir = makeProject('p-busy', { hosting: { public: 'public' } });
  const f = fakeRunner({ slow: true });
  const svc = svcWith(f.run);
  assert.throws(() => svc.createFirebaseUserJob({ cwd: 'relative', targets: ['hosting'] }), /絶対パス/);
  assert.throws(() => svc.createFirebaseUserJob({ cwd: tmp, targets: ['hosting'] }), /firebase\.json が見つかりません/);
  assert.throws(() => svc.createFirebaseUserJob({ cwd: dir, targets: ['functions'] }), /firebase\.json に設定がありません: functions/);
  assert.throws(() => svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting'], channel: 'live' }), /live は不可/);
  assert.throws(() => svc.requestFirebaseFromClaude({ cwd: dir, targets: ['hosting'], note: ' ', sessionId: null }), /note/);
  const a = svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting'] });
  await waitState(svc, a.id, ['uploading']);
  assert.throws(() => svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting'] }), /進行中/);
  const c = svc.requestFirebaseFromClaude({ cwd: dir, targets: ['hosting'], note: '公開', sessionId: null });
  assert.throws(() => svc.approve(c.id), /進行中/);
  // 中止すると CLI を止め、次を受け付ける
  svc.cancel(a.id);
  assert.equal(svc.job(a.id)?.state, 'cancelled');
  svc.approve(c.id);
  await waitState(svc, c.id, ['uploading']);
  for (const g of f.gates) g();
  await waitState(svc, c.id, ['preview_ready']);
  // preview_ready は実行中ではないので、次のデプロイを受け付ける
  const d = svc.createFirebaseUserJob({ cwd: dir, targets: ['hosting'] });
  assert.ok(['planning', 'uploading'].includes(d.state));
  // 確認待ちのプレビューとはチャンネル名を重ねない
  assert.notEqual(d.firebase?.channel, svc.job(c.id)?.firebase?.channel);
  svc.cancel(d.id);
});

void Promise.all(pending).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} 件成功${process.exitCode ? '(失敗あり)' : ''}`);
});
