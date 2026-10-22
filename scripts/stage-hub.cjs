#!/usr/bin/env node
// インストール版に同梱するデーモン一式を build/hub に集める(electron-builder の extraResources → resources/hub)。
//
//   build/hub/
//     cc-hub-node.exe                 … いま使っている node.exe の複製(ネイティブモジュールはこの node 用にビルド済みのものをそのまま使う)
//     packages/daemon/dist/main.js    … デーモン本体(esbuild のバンドル)
//     packages/daemon/native/         … gamecap.exe
//     packages/daemon/package.json    … 名前だけ(web/dist やアイコンを探す目印)
//     packages/web/dist/              … Web UI
//     packages/desktop/assets/        … 通知のアイコン
//     integrations/                   … hooks / MCP / statusline / スキル
//     node_modules/                   … デーモンが external にしているモジュールと、その依存
//
// 事前に npm run build(web / daemon / desktop)を済ませておくこと。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'hub');
/** packages/daemon の build で --external にしているもの */
const EXTERNALS = [
  '@lydell/node-pty',
  'better-sqlite3',
  '@xterm/headless',
  '@xterm/addon-serialize',
  'ws',
  'node-notifier',
  'ssh2-sftp-client',
  'ssh2',
  'cpu-features',
];
/** node_modules から持っていかないもの(容量削減。実行には不要) */
const SKIP = /[\\/](\.github|docs?|examples?|test|tests|benchmark|deps[\\/]sqlite3|src[\\/]sqlite3)[\\/]|\.(md|markdown|ts|map|cc|cpp|h|gyp|gypi|pdb|ilk|lib|obj|iobj|ipdb|tlog)$/i;

function copy(src, dst, filter) {
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !filter || !filter(p) });
}

function need(p) {
  if (!fs.existsSync(p)) {
    console.error(`見つかりません: ${p}(先に npm run build を実行してください)`);
    process.exit(1);
  }
  return p;
}

// ------------------------------------------------------------ node_modules の依存の閉包
/** from(パッケージのディレクトリ)から name を Node と同じ順で探す */
function resolvePkg(name, from) {
  let dir = from;
  for (;;) {
    const p = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function closure() {
  const found = new Map(); // パッケージのディレクトリ → true
  const queue = EXTERNALS.map((n) => ({ name: n, from: path.join(ROOT, 'packages', 'daemon'), optional: n === 'cpu-features' }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = resolvePkg(name, from);
    if (!dir) {
      if (!optional) console.warn(`  (無し) ${name}`);
      continue;
    }
    if (found.has(dir)) continue;
    found.set(dir, true);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.dependencies || {})) queue.push({ name: d, from: dir, optional: false });
    for (const d of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: d, from: dir, optional: true });
  }
  return [...found.keys()];
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // node
  fs.copyFileSync(process.execPath, path.join(OUT, 'cc-hub-node.exe'));
  fs.writeFileSync(path.join(OUT, 'node-version.txt'), process.version + '\n');

  // デーモン・Web UI・アイコン・連携
  const daemon = path.join(OUT, 'packages', 'daemon');
  fs.mkdirSync(path.join(daemon, 'dist'), { recursive: true });
  fs.copyFileSync(need(path.join(ROOT, 'packages', 'daemon', 'dist', 'main.js')), path.join(daemon, 'dist', 'main.js'));
  copy(need(path.join(ROOT, 'packages', 'daemon', 'native')), path.join(daemon, 'native'), (p) => /\.cs$/i.test(p));
  fs.writeFileSync(path.join(daemon, 'package.json'), JSON.stringify({ name: '@cc-hub/daemon', private: true, main: 'dist/main.js' }, null, 2));
  copy(need(path.join(ROOT, 'packages', 'web', 'dist')), path.join(OUT, 'packages', 'web', 'dist'));
  copy(need(path.join(ROOT, 'packages', 'desktop', 'assets')), path.join(OUT, 'packages', 'desktop', 'assets'));
  copy(need(path.join(ROOT, 'integrations')), path.join(OUT, 'integrations'));

  // node_modules(リポジトリ内の位置関係のまま、ルートからの相対パスで置く)
  const dirs = closure();
  for (const dir of dirs) {
    const rel = path.relative(ROOT, dir);
    const dst = path.join(OUT, rel.replace(/^packages[\\/]daemon[\\/]/, ''));
    copy(dir, dst, (p) => {
      // 入れ子の node_modules は別のパッケージとして閉包に入っているものだけ持っていく
      const sub = path.relative(dir, p);
      if (/(^|[\\/])node_modules([\\/]|$)/.test(sub)) return true;
      return SKIP.test(p);
    });
  }
  // node-pty: 他の OS 用のバイナリは要らない
  for (const d of fs.readdirSync(path.join(OUT, 'node_modules', '@lydell'))) {
    if (/^node-pty-/.test(d) && d !== 'node-pty-win32-x64') fs.rmSync(path.join(OUT, 'node_modules', '@lydell', d), { recursive: true, force: true });
  }

  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  walk(OUT);
  console.log(`build/hub を作成しました: node ${process.version}、モジュール ${dirs.length} 個、${(bytes / 1024 / 1024).toFixed(0)}MB`);
}

main();
