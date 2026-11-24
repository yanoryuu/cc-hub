// 「新しく作る」(GitHub にリポジトリを作ってフォルダの中身をプッシュ)のテスト。
// GitHub には繋がない: gh は偽物、プッシュ先は D:\AITEST のローカルの bare リポジトリ。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RegisterRepoRequest, RepoInfo } from '@cc-hub/shared';
import { type CreateDeps, createRepo, excludePattern, inspectNewRepoFolder, suggestRepoName } from '../src/repo/create';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${(e as Error).stack}`);
    process.exitCode = 1;
  }
}

// コミットの作者(このテストの中だけ)
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'cc-hub-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'cc-hub-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

const ROOT = 'D:/AITEST/newrepo-test';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const TMP = path.join(ROOT, '_tmp');
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** 中身のあるフォルダ: .gitignore された *.log、node_modules、11 MB と 120 MB のファイル(疎ファイル) */
function makeFolder(name: string, opts: { huge?: boolean } = {}): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(dir, 'debug.log'), 'ignored');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1');
  const big = fs.openSync(path.join(dir, 'big [1].bin'), 'w');
  fs.ftruncateSync(big, 11 * 1024 * 1024);
  fs.closeSync(big);
  if (opts.huge) {
    const h = fs.openSync(path.join(dir, 'huge.bin'), 'w');
    fs.ftruncateSync(h, 120 * 1024 * 1024);
    fs.closeSync(h);
  }
  return dir;
}

function fakeDeps() {
  const calls: { gh: string[][]; register: RegisterRepoRequest[] } = { gh: [], register: [] };
  const deps: CreateDeps = {
    ghMutate: async (args) => {
      calls.gh.push(args);
      const id = args[2].includes('/') ? args[2] : `me/${args[2]}`;
      const bare = path.join(ROOT, '_remotes', id.replace('/', '__') + '.git');
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', bare]);
      return { code: 0, stdout: `https://github.com/${id}\n`, stderr: '' };
    },
    ghRead: async () => ({ code: 0, stdout: 'me\n', stderr: '' }),
    remoteUrl: (id) => path.join(ROOT, '_remotes', id.replace('/', '__') + '.git'),
    register: async (r) => {
      calls.register.push(r);
      return { id: 'me/x' } as RepoInfo;
    },
    isRegistered: () => false,
    tmpDir: TMP,
  };
  return { deps, calls };
}

void (async () => {
  await test('suggestRepoName / excludePattern', () => {
    assert.equal(suggestRepoName('D:/x/My Game!'), 'My-Game');
    assert.equal(suggestRepoName('D:/x/日本語'), 'new-project');
    assert.equal(excludePattern('a/big [1].bin'), '/a/big \\[1\\].bin');
    assert.equal(excludePattern('#x*'), '/\\#x\\*');
  });

  await test('inspect: .gitignore に従って数え、10 MB 以上と node_modules を知らせる。フォルダには書かない', async () => {
    const dir = makeFolder('inspect');
    const r = await inspectNewRepoFolder(dir, TMP);
    assert.equal(r.exists, true);
    assert.equal(r.isGit, false);
    assert.equal(r.fileCount, 4); // .gitignore, src/a.txt, node_modules/x/i.js, big [1].bin
    assert.deepEqual(r.large.map((f) => f.path), ['big [1].bin']);
    assert.deepEqual(r.heavyDirs, ['node_modules']);
    assert.equal(r.suggestedName, 'inspect');
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  });

  await test('inspect: 無いフォルダ / 親が Git のリポジトリ', async () => {
    assert.equal((await inspectNewRepoFolder(path.join(ROOT, 'none'), TMP)).exists, false);
    const parent = path.join(ROOT, 'parent');
    fs.mkdirSync(path.join(parent, 'child'), { recursive: true });
    g(parent, 'init', '-q');
    const r = await inspectNewRepoFolder(path.join(parent, 'child'), TMP);
    assert.ok(r.parentRepo && path.normalize(r.parentRepo).toLowerCase() === path.normalize(parent).toLowerCase());
    await assert.rejects(
      createRepo({ name: 'c', visibility: 'private', localPath: path.join(parent, 'child'), push: true, excludeLarge: true, trusted: true }, fakeDeps().deps),
      /親フォルダ/,
    );
  });

  await test('作成 + プッシュ: 10 MB 以上を除いてコミットし、プッシュしてから登録する', async () => {
    const dir = makeFolder('push');
    const { deps, calls } = fakeDeps();
    await createRepo({ name: 'push', visibility: 'private', description: 'd\nx', localPath: dir, push: true, excludeLarge: true, trusted: true, poolMin: 1 }, deps);
    assert.deepEqual(calls.gh[0], ['repo', 'create', 'push', '--private', '--description', 'd x']);
    const remote = deps.remoteUrl('me/push');
    const files = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(files, ['.gitignore', 'node_modules/x/i.js', 'src/a.txt']);
    assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /\/big \\\[1\\\]\.bin/);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.log\n'); // .gitignore は変えない
    assert.equal(g(dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.deepEqual(calls.register, [{ url: '', localPath: path.normalize(dir), trusted: true, poolMin: 1 }]);
  });

  await test('作成 + プッシュ: 除かないなら 10 MB のファイルも送る。100 MB 以上があれば GitHub に作る前に断る', async () => {
    const a = makeFolder('keep-large');
    const { deps, calls } = fakeDeps();
    await createRepo({ name: 'keep-large', owner: 'org1', visibility: 'public', localPath: a, push: true, excludeLarge: false, trusted: true }, deps);
    assert.deepEqual(calls.gh[0], ['repo', 'create', 'org1/keep-large', '--public']);
    const files = execFileSync('git', ['--git-dir', deps.remoteUrl('org1/keep-large'), 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(files, /big \[1\]\.bin/);

    const b = makeFolder('huge', { huge: true });
    const f2 = fakeDeps();
    await assert.rejects(
      createRepo({ name: 'huge', visibility: 'private', localPath: b, push: true, excludeLarge: false, trusted: true }, f2.deps),
      /100 MB/,
    );
    assert.equal(f2.calls.gh.length, 0);
    assert.equal(fs.existsSync(path.join(b, '.git')), false);
  });

  await test('origin があるフォルダは断る(クローン済みとして登録する)。信頼の確認・名前も確かめる', async () => {
    const dir = makeFolder('has-origin');
    g(dir, 'init', '-q');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/someone/thing.git');
    const { deps, calls } = fakeDeps();
    await assert.rejects(createRepo({ name: 'x', visibility: 'private', localPath: dir, push: true, excludeLarge: true, trusted: true }, deps), /origin/);
    await assert.rejects(createRepo({ name: 'x', visibility: 'private', push: false, excludeLarge: true, trusted: false }, deps), /信頼/);
    await assert.rejects(createRepo({ name: 'a b', visibility: 'private', push: false, excludeLarge: true, trusted: true }, deps), /リポジトリ名/);
    assert.equal(calls.gh.length, 0);
  });

  await test('プッシュしない: README だけのリポジトリを作って URL で登録する', async () => {
    const { deps, calls } = fakeDeps();
    await createRepo({ name: 'empty', visibility: 'private', push: false, excludeLarge: true, trusted: true }, deps);
    assert.deepEqual(calls.gh[0], ['repo', 'create', 'empty', '--private', '--add-readme']);
    assert.deepEqual(calls.register, [{ url: 'me/empty', trusted: true, poolMin: undefined }]);
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`newrepo: ${passed} passed`);
})();
