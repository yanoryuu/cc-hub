// アップロードの差分計算(マニフェスト / サイズ + 時刻 / 除外 / deleteExtra)とリモートのパス(posix)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_NAME,
  buildManifest,
  compileExcludes,
  computePlan,
  joinRemote,
  normRel,
  normRemoteDir,
  parseManifest,
  relDir,
  sha1File,
  walkLocal,
  type LocalFile,
  type RemoteFile,
} from '../src/deploy/plan';
import { explainError } from '../src/deploy/remote';
import { checkLocalDir, projectRootFor, pushLog } from '../src/deploy/service';

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

const L = (rel: string, size: number, mtime: number, sha1?: string): LocalFile => ({ rel, abs: `C:\\x\\${rel}`, size, mtime, sha1 });
const none = () => false;

// ------------------------------------------------------------ パス
test('joinRemote: posix で結合し、\\ と末尾の / を正規化する', () => {
  assert.equal(joinRemote('/public_html/site/', 'a/b.html'), '/public_html/site/a/b.html');
  assert.equal(joinRemote('\\public_html\\site', 'a\\b.html'), '/public_html/site/a/b.html');
  assert.equal(joinRemote('/', 'index.html'), '/index.html');
  assert.equal(joinRemote('public_html', 'x.css'), 'public_html/x.css');
  assert.equal(joinRemote('/a//b/', 'c'), '/a/b/c');
  assert.throws(() => joinRemote('/a', '../etc/passwd'));
  assert.throws(() => joinRemote('/a', '/abs'));
  assert.throws(() => joinRemote('/a', 'C:/x'));
  assert.throws(() => joinRemote('/a', 'b//c'));
  assert.throws(() => normRemoteDir(''));
  assert.throws(() => normRemoteDir('/a/../../b'));
  assert.equal(normRel('./a/b'), 'a/b');
  assert.equal(relDir('a/b/c.png'), 'a/b');
  assert.equal(relDir('c.png'), '');
});

// ------------------------------------------------------------ 除外
test('compileExcludes: 常に除外 + 名前 / パスの glob', () => {
  const ex = compileExcludes(['*.map', 'drafts', 'assets/raw', '/secret.txt', '**/*.psd']);
  assert.equal(ex('.git/config'), true);
  assert.equal(ex('sub/node_modules/x/y.js'), true);
  assert.equal(ex('.cc-hub/attachments/a.png'), true);
  assert.equal(ex(MANIFEST_NAME), true);
  assert.equal(ex('js/app.js.map'), true);
  assert.equal(ex('blog/drafts/a.md'), true);
  assert.equal(ex('assets/raw/big.png'), true);
  assert.equal(ex('x/assets/raw/big.png'), false); // / を含むパターンは先頭から
  assert.equal(ex('secret.txt'), true);
  assert.equal(ex('sub/secret.txt'), false);
  assert.equal(ex('a/b/c.psd'), true);
  assert.equal(ex('index.html'), false);
  assert.equal(ex('img/logo.png.cc-hub-tmp-1234'), true); // 送信途中の一時ファイル
});

// ------------------------------------------------------------ 差分
test('computePlan: マニフェスト無し = サイズ + 更新時刻(時刻が無ければサイズだけ)', () => {
  const local = [L('index.html', 100, 10_000), L('a.css', 50, 10_000), L('new.js', 10, 10_000), L('img/p.png', 2000, 50_000), L('same.txt', 5, 10_000)];
  const remote = new Map<string, RemoteFile>([
    ['index.html', { size: 100, mtime: 20_000 }], // 同じ(リモートが新しい)
    ['a.css', { size: 60, mtime: 20_000 }], // サイズ違い
    ['img/p.png', { size: 2000, mtime: 20_000 }], // ローカルが新しい
    ['same.txt', { size: 5, mtime: null }], // 時刻なし(FTP の LIST)→ サイズだけ
    ['old.html', { size: 1, mtime: 1 }],
  ]);
  const p = computePlan({ local, remote, manifest: null, deleteExtra: false, isExcluded: none });
  assert.deepEqual(
    p.upload.map((u) => `${u.path}:${u.reason}`),
    ['a.css:changed', 'new.js:new', 'img/p.png:changed'],
  );
  assert.equal(p.unchanged, 2);
  assert.equal(p.totalBytes, 50 + 10 + 2000);
  assert.deepEqual(p.delete, []);
  // 時刻の許容差(2 秒)以内は同じとみなす
  const p2 = computePlan({ local: [L('x', 1, 21_500)], remote: new Map([['x', { size: 1, mtime: 20_000 }]]), manifest: null, deleteExtra: false, isExcluded: none });
  assert.equal(p2.upload.length, 0);
});

test('computePlan: マニフェストがあれば sha1 で比べる(時刻は見ない)', () => {
  const local = [L('index.html', 100, 99_999_999, 'h1'), L('a.css', 50, 1, 'h2-new'), L('b.js', 7, 1, 'h3'), L('gone-remote.txt', 3, 1, 'h4')];
  const remote = new Map<string, RemoteFile>([
    ['index.html', { size: 100, mtime: 1 }],
    ['a.css', { size: 50, mtime: 99_999_999 }],
    ['b.js', { size: 8, mtime: 1 }], // リモートで書き換えられた(サイズがマニフェストと違う)
  ]);
  const manifest = parseManifest(
    JSON.stringify({ version: 1, updatedAt: 1, files: { 'index.html': { size: 100, sha1: 'h1' }, 'a.css': { size: 50, sha1: 'h2' }, 'b.js': { size: 7, sha1: 'h3' }, 'gone-remote.txt': { size: 3, sha1: 'h4' } } }),
  );
  assert.ok(manifest);
  const p = computePlan({ local, remote, manifest, deleteExtra: false, isExcluded: none });
  assert.deepEqual(
    p.upload.map((u) => `${u.path}:${u.reason}`),
    ['a.css:changed', 'b.js:changed', 'gone-remote.txt:new'],
  );
  assert.equal(p.unchanged, 1);
});

test('computePlan: deleteExtra はリモートだけにあるものを消す(除外・マニフェストは消さない)', () => {
  const ex = compileExcludes(['uploads']);
  const remote = new Map<string, RemoteFile>([
    ['index.html', { size: 1, mtime: 1 }],
    ['old/page.html', { size: 1, mtime: 1 }],
    ['uploads/user.jpg', { size: 1, mtime: 1 }],
    ['z.txt', { size: 1, mtime: 1 }],
  ]);
  const local = [L('index.html', 1, 1)];
  assert.deepEqual(computePlan({ local, remote, manifest: null, deleteExtra: true, isExcluded: ex }).delete, ['old/page.html', 'z.txt']);
  assert.deepEqual(computePlan({ local, remote, manifest: null, deleteExtra: false, isExcluded: ex }).delete, []);
});

test('parseManifest: 壊れた / 版違いは null、buildManifest は sha1 のあるものだけ', () => {
  assert.equal(parseManifest('{'), null);
  assert.equal(parseManifest(JSON.stringify({ version: 2, files: {} })), null);
  assert.equal(parseManifest(null), null);
  const m = buildManifest([L('a', 1, 1, 'x'), L('b', 2, 2)], 5);
  assert.deepEqual(m, { version: 1, updatedAt: 5, files: { a: { size: 1, sha1: 'x' } } });
});

// ------------------------------------------------------------ ローカルの走査(一時フォルダ)
test('walkLocal: 除外を守り / 区切りで返す。sha1File', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-deploy-'));
  try {
    fs.mkdirSync(path.join(root, 'img', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), 'hello');
    fs.writeFileSync(path.join(root, 'img', 'sub', 'a.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, 'app.js.map'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'x');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'x');
    const files = await walkLocal(root, compileExcludes(['*.map']));
    assert.deepEqual(
      files.map((f) => `${f.rel}:${f.size}`),
      ['img/sub/a.png:3', 'index.html:5'],
    );
    assert.equal(await sha1File(path.join(root, 'index.html')), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    // checkLocalDir / projectRootFor
    assert.equal(checkLocalDir(root), path.resolve(root));
    assert.throws(() => checkLocalDir('relative/dir'), /絶対パス/);
    assert.throws(() => checkLocalDir('C:\\'), /ドライブ直下/);
    assert.throws(() => checkLocalDir(path.join(root, 'nope')), /存在しません/);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.equal(projectRootFor(path.join(root, 'img', 'sub')), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pushLog は末尾 200 行を保つ / explainError は認証失敗を分かりやすく', () => {
  const log: string[] = [];
  pushLog(log, Array.from({ length: 250 }, (_, i) => `line${i}`).join('\r\n'));
  assert.equal(log.length, 200);
  assert.equal(log[0], 'line50');
  assert.match(explainError(new Error('530 Login incorrect.')), /認証に失敗/);
  assert.match(explainError(new Error('All configured authentication methods failed')), /認証に失敗/);
  assert.match(explainError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })), /拒否/);
});

void Promise.all(pending).then(() => console.log(`\ndeploy: ${passed} passed`));
