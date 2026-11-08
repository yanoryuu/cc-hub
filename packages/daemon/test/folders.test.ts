// フォルダのプロジェクト(Git なしでもよい)の登録のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { FolderProjects } from '../src/project/folders';

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

const mem = new Map<string, unknown>();
const store = { getSetting: (k: string) => (mem.get(k) ?? null) as any, setSetting: (k: string, v: unknown) => void mem.set(k, v) } as any;
const DIR = 'D:/AITEST/folder-proj/no-git';

test('Git の無いフォルダも登録できる。同じフォルダ(書き方違い)は重ねない', () => {
  const f = new FolderProjects(store);
  assert.equal(f.add(DIR, 1).length, 1);
  assert.equal(f.add(String.raw`d:\AITEST\folder-proj\NO-GIT\ `.trim(), 2).length, 1);
  assert.equal(f.list()[0].addedAt, 1);
});

test('無いフォルダ・相対パス・空は断る', () => {
  const f = new FolderProjects(store);
  assert.throws(() => f.add('D:/AITEST/folder-proj/none'), /見つかりません/);
  assert.throws(() => f.add('relative/dir'), /絶対パス/);
  assert.throws(() => f.add(''), /指定してください/);
});

test('登録を外す(書き方が違っても外れる)', () => {
  const f = new FolderProjects(store);
  assert.equal(f.remove(String.raw`D:\AITEST\folder-proj\no-git`).length, 0);
});

console.log(`folders: ${passed} passed`);
