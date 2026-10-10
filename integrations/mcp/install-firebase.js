#!/usr/bin/env node
// Firebase 公式の MCP サーバー(firebase mcp)を Claude Code のユーザースコープに登録する。
// Claude が Firestore / Auth / Hosting / ログなどを調べるのに使う(デプロイは CC Hub の request_firebase_deploy で承認制)。
//
//   node install-firebase.js              … ドライラン(実行するコマンドを表示するだけ。既定)
//   node install-firebase.js --apply      … claude mcp add --scope user firebase -- cmd /c firebase mcp を実行する
//                                           (既にあれば先に remove して入れ直す)
//   node install-firebase.js --uninstall  … 登録を外すコマンドを表示(--apply と併用で実行)
//   node install-firebase.js --name <名前> … 登録名(既定 firebase)
//   node install-firebase.js --claude <path> … claude のパス(既定: CC Hub の config.json の claudePath → claude)
//
// firebase CLI は事前に npm i -g firebase-tools と firebase login が必要。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = flag('--apply');
const UNINSTALL = flag('--uninstall');
const NAME = opt('--name') || 'firebase';
const HOME = process.env.USERPROFILE || os.homedir();

function dataDir() {
  if (process.env.CC_HUB_DATA_DIR) return path.resolve(process.env.CC_HUB_DATA_DIR);
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return path.join(appData, 'cc-hub');
}

function readConfig(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

/** firebase CLI(npm のグローバル)があるか */
function firebaseInstalled() {
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  if (fs.existsSync(path.join(appData, 'npm', 'firebase.cmd'))) return true;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, 'firebase.cmd')) || fs.existsSync(path.join(d, 'firebase.exe')));
}

function main() {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(NAME)) {
    console.error('--name は英数字・_・- で指定してください');
    process.exit(2);
  }
  const cfg = readConfig(dataDir());
  const claude = opt('--claude') || cfg.claudePath || 'claude';
  const removeArgs = ['mcp', 'remove', '--scope', 'user', NAME];
  // firebase は .cmd なので cmd /c で起動する(Claude Code は .cmd を直接 spawn できない)
  const addArgs = ['mcp', 'add', '--scope', 'user', NAME, '--', 'cmd', '/c', 'firebase', 'mcp'];
  const show = (args) => [claude, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');

  console.log(`Firebase MCP サーバー: cmd /c firebase mcp(登録名 ${NAME}、ユーザースコープ)`);
  if (!UNINSTALL && !firebaseInstalled()) console.warn('注意: firebase CLI が見つかりません。npm i -g firebase-tools と firebase login を先に行ってください。');
  if (UNINSTALL) {
    console.log(`\n実行するコマンド:\n  ${show(removeArgs)}`);
  } else {
    console.log(`\n実行するコマンド:\n  ${show(removeArgs)}   (既にあれば。無くてもエラーは無視)\n  ${show(addArgs)}`);
  }
  if (!APPLY) {
    console.log('\nドライランです。登録するには --apply を付けて実行してください。');
    return;
  }
  const run = (args, quiet) => {
    // シェルを通さず直接実行する。CLAUDE* の環境変数は渡さない
    const r = spawnSync(claude, args, { encoding: 'utf8', windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))) });
    if (!quiet) {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
    if (r.error) console.error(`${claude} を実行できません: ${r.error.message}`);
    return r.status;
  };
  run(removeArgs, !UNINSTALL);
  if (UNINSTALL) {
    console.log('登録を外しました。');
    return;
  }
  const code = run(addArgs, false);
  if (code !== 0) {
    console.error(`claude mcp add に失敗しました (code ${code})`);
    process.exit(code || 1);
  }
  console.log(`登録しました。claude mcp list で ${NAME} が Connected になることを確認してください。`);
}

main();
