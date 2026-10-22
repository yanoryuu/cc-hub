#!/usr/bin/env node
// CC Hub hooks インストーラ: ~/.claude/settings.json に CC Hub の http hooks を追記する。
//
//   node install.js                  … ドライラン(変更内容を表示するだけ。既定)
//   node install.js --apply          … 書き込む(先にタイムスタンプ付きバックアップを作る)
//   node install.js --statusline     … statusLine も integrations/statusline/statusline.js に切り替える
//   node install.js --statusline-if-empty … statusLine が未設定のときだけ statusline.js にする(インストール版の初回設定)
//   node install.js --node <exe>     … relay.js / statusline.js を動かす node のパス(既定 PATH の node。インストール版は同梱の node.exe)
//   node install.js --uninstall      … CC Hub の hooks を取り除き、statusLine を元に戻す(--apply と併用で書き込み)
//   node install.js --emit <file>    … CC Hub の hooks だけを含む settings JSON を <file> に書く
//                                      (`claude --settings <file>` でのテスト用。~/.claude/settings.json は触らない)
//   node install.js --settings <file> … 対象の settings.json を変更する(既定 ~/.claude/settings.json)
//
// 既存の設定はすべて保持する。CC Hub の hook は url に "/ingest/hook" を含むもの(SessionStart は relay.js を呼ぶ command)で
// 識別する(何度実行しても同じ結果)。
// ※ SessionStart は http 型 hook が発火しない(検証で確認)ため、command 型 + async で relay.js を呼んで転送する。
// ingest トークンは表示しない。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
];
const MARK = '/ingest/hook';
const HOME = process.env.USERPROFILE || os.homedir();
const STATUSLINE_JS = path.resolve(__dirname, '..', 'statusline', 'statusline.js');
const RELAY_JS = path.resolve(__dirname, 'relay.js');
/** http 型が発火しないため command 型(relay.js)で送るイベント */
const COMMAND_EVENTS = new Set(['SessionStart']);
const PS1_STATUSLINE = {
  type: 'command',
  command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(HOME, '.claude', 'scripts', 'claude-statusline.ps1')}"`,
};

// ------------------------------------------------------------ 引数
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = flag('--apply');
const STATUSLINE_IF_EMPTY = flag('--statusline-if-empty');
const WITH_STATUSLINE = flag('--statusline') || STATUSLINE_IF_EMPTY;
const NODE = opt('--node') ? `"${path.resolve(opt('--node'))}"` : 'node';
const UNINSTALL = flag('--uninstall');
const EMIT = opt('--emit');
const SETTINGS = path.resolve(opt('--settings') || path.join(HOME, '.claude', 'settings.json'));

// ------------------------------------------------------------ デーモンの設定(ポート / ingest トークン)
function dataDir() {
  if (process.env.CC_HUB_DATA_DIR) return path.resolve(process.env.CC_HUB_DATA_DIR);
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return path.join(appData, 'cc-hub');
}

function daemonInfo() {
  const dir = dataDir();
  if (APPLY || EMIT) fs.mkdirSync(dir, { recursive: true });
  let port = 7861;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (Number(cfg.port)) port = Number(cfg.port);
  } catch (_) {
    /* 既定ポート */
  }
  const tokenFile = path.join(dir, 'ingest-token');
  let token = '';
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (_) {
    /* 無ければ作る */
  }
  if (token.length < 32) {
    // デーモンより先に実行された場合もトークンを作っておく(デーモンはこのファイルを読む)
    token = crypto.randomBytes(32).toString('hex');
    if (APPLY || EMIT) fs.writeFileSync(tokenFile, token);
  }
  return { dir, port, token };
}

function hubHook(ev, port, token) {
  if (COMMAND_EVENTS.has(ev)) {
    return { type: 'command', command: `${NODE} "${RELAY_JS}"`, async: true, timeout: 5 };
  }
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${MARK}`,
    headers: { 'X-CC-Hub-Token': token, 'X-CC-Hub-Session': '$CC_HUB_SESSION' },
    allowedEnvVars: ['CC_HUB_SESSION'],
    timeout: 2,
  };
}

const isHubHook = (h) =>
  !!h &&
  ((typeof h.url === 'string' && h.url.includes(MARK)) ||
    (typeof h.command === 'string' && /hub[\\/]+integrations[\\/]+hooks[\\/]+relay\.js/i.test(h.command)));
const isHubStatusline = (s) => !!(s && typeof s.command === 'string' && /statusline[\\/]+statusline\.js/i.test(s.command));

/** CC Hub の hook を取り除いた hooks を返す(空になったグループ・イベントは消す) */
function stripHub(hooks) {
  const out = {};
  const removed = [];
  for (const [ev, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      out[ev] = groups;
      continue;
    }
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const inner = g.hooks.filter((h) => !isHubHook(h));
      if (inner.length !== g.hooks.length) removed.push(ev);
      if (inner.length) kept.push({ ...g, hooks: inner });
    }
    if (kept.length) out[ev] = kept;
  }
  return { hooks: out, removed };
}

function mask(obj) {
  return JSON.stringify(
    obj,
    (k, v) => (k === 'X-CC-Hub-Token' ? '***' : v),
    2,
  );
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.error(`settings.json を読めません: ${SETTINGS} (${e.message})`);
    process.exit(1);
  }
}

/** 直前の statusLine(CC Hub 以外)を探す: 保存ファイル → 最新バックアップ → ps1 */
function previousStatusline(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'statusline-prev.json'), 'utf8'));
    if (s && !isHubStatusline(s)) return s;
  } catch (_) {
    /* 次へ */
  }
  try {
    const base = path.basename(SETTINGS);
    const backups = fs
      .readdirSync(path.dirname(SETTINGS))
      .filter((f) => f.startsWith(`${base}.cc-hub-backup-`))
      .sort()
      .reverse();
    for (const f of backups) {
      const j = JSON.parse(fs.readFileSync(path.join(path.dirname(SETTINGS), f), 'utf8'));
      if (j.statusLine && !isHubStatusline(j.statusLine)) return j.statusLine;
    }
  } catch (_) {
    /* 次へ */
  }
  return PS1_STATUSLINE;
}

function main() {
  const { dir, port, token } = daemonInfo();
  const statusLineCmd = { type: 'command', command: `${NODE} "${STATUSLINE_JS}"` };

  // --emit: テスト用の単独 settings を書く
  if (EMIT) {
    const hooks = {};
    for (const ev of EVENTS) hooks[ev] = [{ hooks: [hubHook(ev, port, token)] }];
    const out = { hooks };
    if (WITH_STATUSLINE) out.statusLine = statusLineCmd;
    fs.writeFileSync(path.resolve(EMIT), JSON.stringify(out, null, 2));
    console.log(`書き出しました: ${path.resolve(EMIT)} (${EVENTS.length} イベント, port ${port})`);
    return;
  }

  const before = readSettings();
  const after = JSON.parse(JSON.stringify(before));
  const { hooks: stripped, removed } = stripHub(before.hooks);
  const summary = [];

  if (UNINSTALL) {
    after.hooks = stripped;
    if (!Object.keys(after.hooks).length) delete after.hooks;
    summary.push(removed.length ? `CC Hub の hook を削除: ${[...new Set(removed)].join(', ')}` : 'CC Hub の hook はありません');
    if (isHubStatusline(before.statusLine)) {
      after.statusLine = previousStatusline(dir);
      summary.push(`statusLine を戻す: ${after.statusLine.command}`);
    }
  } else {
    const hooks = stripped;
    for (const ev of EVENTS) {
      hooks[ev] = [...(hooks[ev] || []), { hooks: [hubHook(ev, port, token)] }];
    }
    after.hooks = hooks;
    const replaced = new Set(removed);
    summary.push(`hook を追加: ${EVENTS.filter((e) => !replaced.has(e)).join(', ') || '(なし)'}`);
    if (replaced.size) summary.push(`hook を更新(既存の CC Hub エントリを置換): ${[...replaced].join(', ')}`);
    summary.push(`送信先: http://127.0.0.1:${port}${MARK}`);
    if (WITH_STATUSLINE && !(STATUSLINE_IF_EMPTY && before.statusLine && !isHubStatusline(before.statusLine))) {
      if (!isHubStatusline(before.statusLine)) {
        summary.push(`statusLine: ${before.statusLine ? before.statusLine.command : '(なし)'} → ${statusLineCmd.command}`);
      }
      after.statusLine = statusLineCmd;
    }
  }

  const changed = JSON.stringify(before) !== JSON.stringify(after);
  console.log(`対象: ${SETTINGS}`);
  for (const s of summary) console.log(`  - ${s}`);
  const otherKeys = Object.keys(before).filter((k) => k !== 'hooks' && k !== 'statusLine');
  if (otherKeys.length) console.log(`  - 保持する既存設定: ${otherKeys.join(', ')}`);

  if (!APPLY) {
    console.log('\n[ドライラン] 書き込み後の hooks / statusLine(トークンは伏せ字):');
    console.log(mask({ hooks: after.hooks, statusLine: after.statusLine }));
    console.log(changed ? '\n書き込むには --apply を付けて実行してください。' : '\n変更はありません。');
    return;
  }
  if (!changed) {
    console.log('変更はありません。');
    return;
  }
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.cc-hub-backup-${timestamp()}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`バックアップ: ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  }
  if (!UNINSTALL && WITH_STATUSLINE && before.statusLine && !isHubStatusline(before.statusLine)) {
    fs.writeFileSync(path.join(dir, 'statusline-prev.json'), JSON.stringify(before.statusLine, null, 2));
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(after, null, 2) + '\n');
  console.log('書き込みました。');
}

main();
