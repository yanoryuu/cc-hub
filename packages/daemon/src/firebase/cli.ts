// firebase CLI の実行。デーモン内の firebase 呼び出しはすべてここを通す(config.firebasePath で差し替え可能)。
// - シェルは使わない。npm のグローバル(firebase.cmd)なら、その隣の node_modules\firebase-tools\lib\bin\firebase.js を node で実行する
// - .js / .cjs / .mjs を指定すると node で実行する(検証用の偽 firebase CLI)
// - どうしても cmd.exe を通す場合(firebase.cmd の中身が見つからない)は、引数を安全な文字だけに限る(シェルの注入を防ぐ)
// - 環境変数から CLAUDE* を除く。出力は行ごとに onLine へ流す。タイムアウトでプロセスツリーごと止める
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanEnv } from '../repo/exec';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CliOptions {
  cwd: string;
  timeoutMs: number;
  /** 出力の各行(stdout / stderr とも) */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** 実行中のコマンド(kill で止める) */
export interface CliRun {
  done: Promise<CliResult>;
  kill: () => void;
}

export type FirebaseRunner = (args: string[], o: CliOptions) => CliRun;

export interface ResolvedCommand {
  file: string;
  prefix: string[];
  /** cmd.exe /c 経由か(引数を厳しく検証する) */
  viaCmd: boolean;
}

/** cmd.exe を通すときに許す引数(英数字と . _ : , @ - / = だけ) */
export const SAFE_ARG_RE = /^[A-Za-z0-9._:,@\-/=]+$/;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** firebase.cmd の隣にある firebase-tools 本体(firebase.js) */
function scriptBeside(cmdPath: string): string | null {
  const js = path.join(path.dirname(cmdPath), 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  return isFile(js) ? js : null;
}

/** PATH から firebase.cmd / firebase.exe を探す */
function findOnPath(env: NodeJS.ProcessEnv): string | null {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const name of ['firebase.cmd', 'firebase.exe']) {
      const p = path.join(d, name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** 実行するコマンドを決める。firebasePath: '' = 自動 / .js 系 = node / .cmd = 隣の本体を node / それ以外 = 直接 */
export function resolveFirebaseCommand(firebasePath: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  const node = process.execPath;
  const p = String(firebasePath ?? '').trim();
  if (p && /\.(c|m)?js$/i.test(p)) return { file: node, prefix: [p], viaCmd: false };
  if (p && /\.(cmd|bat)$/i.test(p)) {
    const js = scriptBeside(p);
    if (js) return { file: node, prefix: [js], viaCmd: false };
    return { file: env.ComSpec || 'cmd.exe', prefix: ['/d', '/c', p], viaCmd: true };
  }
  if (p && p.toLowerCase() !== 'firebase') return { file: p, prefix: [], viaCmd: false };
  // 自動: npm のグローバル → PATH の firebase.cmd の隣 → PATH の firebase.exe → cmd /c firebase
  const appData = env.APPDATA;
  if (appData) {
    const js = path.join(appData, 'npm', 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    if (isFile(js)) return { file: node, prefix: [js], viaCmd: false };
  }
  const found = findOnPath(env);
  if (found && /\.exe$/i.test(found)) return { file: found, prefix: [], viaCmd: false };
  if (found) {
    const js = scriptBeside(found);
    if (js) return { file: node, prefix: [js], viaCmd: false };
  }
  return { file: env.ComSpec || 'cmd.exe', prefix: ['/d', '/c', 'firebase'], viaCmd: true };
}

/** ログに出す形(空白を含む引数は "" で囲む) */
export function showArgs(args: string[]): string {
  return ['firebase', ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 実行器を作る */
export function createRunner(firebasePath: string): FirebaseRunner {
  return (args, o) => {
    const cmd = resolveFirebaseCommand(firebasePath);
    if (cmd.viaCmd) {
      const bad = args.find((a) => !SAFE_ARG_RE.test(a));
      if (bad !== undefined) {
        return { done: Promise.resolve({ code: -1, stdout: '', stderr: `引数に使えない文字があります: ${bad}`, timedOut: false }), kill: () => undefined };
      }
    }
    let kill: () => void = () => undefined;
    const done = new Promise<CliResult>((resolve) => {
      let out = '';
      let err = '';
      let finished = false;
      let timedOut = false;
      const child = spawn(cmd.file, [...cmd.prefix, ...args], {
        cwd: o.cwd,
        env: cleanEnv({ NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const killTree = () => {
        if (child.pid && child.exitCode == null) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
        }
      };
      kill = killTree;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, o.timeoutMs);
      const lineBuf = { stdout: '', stderr: '' };
      const feed = (stream: 'stdout' | 'stderr', chunk: string, flush = false) => {
        lineBuf[stream] += chunk;
        const parts = lineBuf[stream].replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        lineBuf[stream] = flush ? '' : (parts.pop() ?? '');
        for (const l of parts) {
          const t = l.replace(ANSI_RE, '');
          if (t.trim()) o.onLine?.(t, stream);
        }
      };
      child.stdout.on('data', (c: Buffer) => {
        const s = c.toString('utf8');
        out += s;
        feed('stdout', s);
      });
      child.stderr.on('data', (c: Buffer) => {
        const s = c.toString('utf8');
        err += s;
        feed('stderr', s);
      });
      const finish = (code: number, extra = '') => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        feed('stdout', '\n', true);
        feed('stderr', '\n', true);
        resolve({ code, stdout: out, stderr: err + extra, timedOut });
      };
      child.on('error', (e) => finish(-1, `\n${e.message}`));
      child.on('close', (code) => finish(code ?? -1));
    });
    return { done, kill: () => kill() };
  };
}
