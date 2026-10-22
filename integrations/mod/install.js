#!/usr/bin/env node
// Claude Code の mod「cc-hub」(integrations/mod/cc-hub)を入れる / 外す。
//
//   node install.js --apply             … このフォルダの 2 つ上(.claude-plugin/marketplace.json があるところ)をマーケットプレイス「cc-hub」として
//                                          追加し、cc-hub@cc-hub をユーザースコープに入れる。入ったか確かめて、入っていれば 0 で終わる
//   node install.js --uninstall --apply … cc-hub@cc-hub を外し、マーケットプレイスも外す
//   node install.js                     … ドライラン(実行するコマンドを表示するだけ)
//   node install.js --claude <path>     … claude のパス(既定: デーモンの config.json の claudePath → claude)
//
// マーケットプレイスはフォルダなので、mod はこのフォルダから直接読まれる(インストール版を更新すれば mod も新しくなる)。
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
const HOME = process.env.USERPROFILE || os.homedir();
const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN = 'cc-hub@cc-hub';
const CONFIG = ['guardWorktree=true', 'guardDeploy=true', 'toasts=true'];

function claudePath() {
  if (opt('--claude')) return opt('--claude');
  const dir = process.env.CC_HUB_DATA_DIR || path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'cc-hub');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (cfg.claudePath) return cfg.claudePath;
  } catch (_) {
    /* 既定 */
  }
  return 'claude';
}

function run(claude, args) {
  console.log(`$ claude ${args.join(' ')}`);
  if (!APPLY) return { status: 0, out: '' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
  const r = spawnSync(claude, args, { encoding: 'utf8', windowsHide: true, env, timeout: 120000, input: '' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) console.log(out);
  return { status: r.status, out };
}

function main() {
  const claude = claudePath();
  if (UNINSTALL) {
    run(claude, ['plugin', 'uninstall', PLUGIN]);
    run(claude, ['plugin', 'marketplace', 'remove', 'cc-hub']);
    return;
  }
  if (!fs.existsSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'))) {
    console.error(`マーケットプレイスが見つかりません: ${path.join(ROOT, '.claude-plugin', 'marketplace.json')}`);
    process.exit(1);
  }
  // 既に追加・インストール済みならエラーになるが、最後の一覧で確かめる
  run(claude, ['plugin', 'marketplace', 'add', ROOT]);
  run(claude, ['plugin', 'install', PLUGIN, ...CONFIG.flatMap((c) => ['--config', c])]);
  if (!APPLY) return;
  const list = run(claude, ['plugin', 'list']);
  const ok = list.status === 0 && list.out.includes(PLUGIN) && !/disabled/i.test(list.out.split(PLUGIN)[1]?.split('❯')[0] ?? '');
  console.log(ok ? `${PLUGIN} を入れました` : `${PLUGIN} を入れられませんでした`);
  process.exit(ok ? 0 : 1);
}

main();
