// worktree をつかんでいるプロセスの判定(matchLockers / lockerMessage)のテスト。
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import { lockerMessage, matchLockers, type ProcRow } from '../src/repo/lockers';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const UNITY = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.32f1\\Editor\\Unity.exe';
const procs: ProcRow[] = [
  { pid: 13592, name: 'Unity.exe', cmd: `"${UNITY}" -projectPath D:\\WorkTree\\TomsLands\\wt-05`, title: 'wt-05 - TomsShop - Windows, Mac, Linux - Unity 6' },
  { pid: 55780, name: 'Unity.exe', cmd: `"${UNITY}" "-adb2" "-batchMode" "-noUpm" "-name" "AssetImportWorker0" "-projectPath" "D:/WorkTree/TomsLands/wt-02" "-logFile"`, title: '' },
  { pid: 46412, name: 'Unity.exe', cmd: `"${UNITY}" -projectPath D:\\WorkTree\\TomsLands\\wt-02`, title: 'wt-02 - TitleScene - Unity 6' },
  { pid: 11224, name: 'tail.exe', cmd: '"C:\\Program Files\\Git\\usr\\bin\\tail.exe" -n +1 -f C:/Users/x/AppData/Local/Temp/claude/D--WorkTree-TomsLands-wt-01/54657ce2/scratchpad/compile.log', title: '' },
  { pid: 777, name: 'Unity.exe', cmd: `"${UNITY}" -projectPath D:\\WorkTree\\TomsLands\\wt-10`, title: 'wt-10' },
  { pid: 888, name: 'svchost.exe', cmd: '', title: '' },
  { pid: 45524, name: 'Unity Hub.exe', cmd: '"C:\\Unity\\Unity Hub\\Unity Hub.exe" "--" "--silent" "--" "-projectPath" "D:\\WorkTree\\TomsLands\\wt-05"', title: '' },
];

test('Unity エディタ(-projectPath にバックスラッシュ)を見つける', () => {
  const l = matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-05', 1);
  assert.deepEqual(l.map((x) => [x.pid, x.kind]), [[13592, 'unity']]);
  assert.match(l[0].label, /TomsShop/);
});

test('エディタ本体を子プロセス(アセット取り込み)より先に並べる', () => {
  const l = matchLockers(procs, 'D:/WorkTree/TomsLands/wt-02/', 1);
  assert.deepEqual(l.map((x) => [x.pid, x.kind]), [[46412, 'unity'], [55780, 'unity_worker']]);
});

test('Claude の作業用フォルダ名(D--WorkTree-…-wt-01)でつかんでいる tail を見つける', () => {
  const l = matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-01', 1);
  assert.deepEqual(l.map((x) => [x.pid, x.kind]), [[11224, 'process']]);
});

test('wt-1 が wt-10 に当たらない・自分自身は除く', () => {
  assert.deepEqual(matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-1', 1), []);
  assert.deepEqual(matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-10', 777), []);
});

test('lockerMessage: Unity なら「保存して閉じて」と案内する', () => {
  assert.match(lockerMessage(matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-05', 1)), /Unity を保存して閉じて/);
  assert.match(lockerMessage(matchLockers(procs, 'D:\\WorkTree\\TomsLands\\wt-01', 1)), /終了してから/);
});

console.log(`\n${passed} passed`);
