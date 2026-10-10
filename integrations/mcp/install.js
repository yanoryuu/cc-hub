#!/usr/bin/env node
// CC Hub の MCP サーバー(/mcp)を Claude Code のユーザースコープに登録する。
//
//   node install.js              … ドライラン(実行するコマンドを表示するだけ。トークンは伏せ字。既定)
//   node install.js --apply      … claude mcp add --scope user ... を実行する(既にあれば先に remove して入れ直す)
//   node install.js --uninstall  … 登録を外すコマンドを表示(--apply と併用で実行)
//   node install.js --name <名前> … 登録名(既定 cc-hub)
//   node install.js --claude <path> … claude のパス(既定: デーモンの config.json の claudePath → claude)
//
// ポートとトークンはデーモンのデータディレクトリ(%APPDATA%\cc-hub、環境変数 CC_HUB_DATA_DIR で変更可)の
// config.json と mcp-token から読む。トークンは画面に出さない。
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
const NAME = opt('--name') || 'cc-hub';
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

function main() {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(NAME)) {
    console.error('--name は英数字・_・- で指定してください');
    process.exit(2);
  }
  const dir = dataDir();
  const cfg = readConfig(dir);
  const port = Number(cfg.port) || 7861;
  const claude = opt('--claude') || cfg.claudePath || 'claude';
  let token = '';
  try {
    token = fs.readFileSync(path.join(dir, 'mcp-token'), 'utf8').trim();
  } catch (_) {
    /* 下で案内 */
  }
  if (!UNINSTALL && token.length < 32) {
    console.error(`mcp-token が見つかりません: ${path.join(dir, 'mcp-token')}`);
    console.error('CC Hub のデーモンを一度起動すると作られます。');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/mcp`;
  const header = (t) => `Authorization: Bearer ${t}`;
  const removeArgs = ['mcp', 'remove', '--scope', 'user', NAME];
  const addArgs = (t) => ['mcp', 'add', '--scope', 'user', '--transport', 'http', NAME, url, '--header', header(t)];
  const show = (args) => [claude, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
  const masked = token ? `${token.slice(0, 4)}…(伏せ字)` : '';

  console.log(`データディレクトリ: ${dir}`);
  console.log(`MCP サーバー: ${url}(登録名 ${NAME}、ユーザースコープ)`);
  if (UNINSTALL) {
    console.log(`\n実行するコマンド:\n  ${show(removeArgs)}`);
  } else {
    console.log(`\n実行するコマンド:\n  ${show(removeArgs)}   (既にあれば。無くてもエラーは無視)\n  ${show(addArgs(masked))}`);
  }
  if (!APPLY) {
    console.log('\nドライランです。登録するには --apply を付けて実行してください。');
    return;
  }
  const run = (args, quiet) => {
    // トークンを含む引数はログに出さない。シェルを通さず直接実行する
    const r = spawnSync(claude, args, { encoding: 'utf8', windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))) });
    if (!quiet) {
      if (r.stdout) process.stdout.write(r.stdout.split(token).join(masked));
      if (r.stderr) process.stderr.write(r.stderr.split(token).join(masked));
    }
    return r.status;
  };
  run(removeArgs, !UNINSTALL);
  if (UNINSTALL) {
    console.log('登録を外しました。');
    return;
  }
  const code = run(addArgs(token), false);
  if (code !== 0) {
    console.error(`claude mcp add に失敗しました (code ${code})`);
    process.exit(code || 1);
  }
  console.log(`登録しました。claude mcp list で ${NAME} が Connected になることを確認してください。`);
}

main();
