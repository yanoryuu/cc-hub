// 外部コマンド(git / gh / 依存インストール)の実行ヘルパーと、直列化用のミューテックス。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** ミリ秒。超えたらプロセスを kill して code=-1 */
  timeout?: number;
  /** true = 文字列コマンドをシェル(cmd.exe)で実行する(依存インストール用) */
  shell?: boolean;
  /** 出力を追記するログファイル */
  logFile?: string;
}

/** claude / git / インストールに渡す環境変数。CLAUDE* と CLAUDECODE は取り除く(検証 X2) */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^CLAUDE/i.test(k)) continue;
    env[k] = v;
  }
  // git が認証などで対話入力を待って固まらないようにする
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return { ...env, ...extra };
}

/** コマンドを実行して結果を返す(失敗しても reject しない。code を見ること) */
export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let log: fs.WriteStream | null = null;
    if (o.logFile) {
      try {
        fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
        log = fs.createWriteStream(o.logFile, { flags: 'a' });
        log.write(`\n[${new Date().toISOString()}] $ ${[cmd, ...args].join(' ')}  (cwd: ${o.cwd ?? ''})\n`);
      } catch {
        log = null;
      }
    }
    let out = '';
    let err = '';
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (code: number, extraErr = '') => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (extraErr) err += extraErr;
      if (log) {
        log.write(`[exit ${code}]\n`);
        log.end();
      }
      resolve({ code, stdout: out, stderr: err });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        env: cleanEnv(),
        windowsHide: true,
        shell: !!o.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(-1, String((e as Error).message));
      return;
    }
    const pid = child.pid;
    if (o.timeout) {
      timer = setTimeout(() => {
        err += `\n[timeout ${o.timeout}ms]`;
        killTree(pid);
        finish(-1);
      }, o.timeout);
    }
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 2e6) out += c.toString('utf8');
      log?.write(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 2e6) err += c.toString('utf8');
      log?.write(c);
    });
    child.on('error', (e) => finish(-1, String(e.message)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Windows: 子プロセスごと終了させる(npm などはシェルの下に孫がいる) */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* 無視 */
  }
}

/** エラーメッセージ用に出力を短くまとめる */
export function tail(r: RunResult, n = 400): string {
  const s = (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(-n) : s;
}

export async function git(args: string[], o: RunOptions = {}): Promise<RunResult> {
  return run('git', args, { timeout: 10 * 60_000, ...o });
}

/** git を実行し、失敗したら例外にする */
export async function gitOk(args: string[], o: RunOptions = {}): Promise<string> {
  const r = await git(args, o);
  if (r.code !== 0) throw new Error(`git ${args.filter((a) => a !== '-C').slice(0, 3).join(' ')} に失敗: ${tail(r)}`);
  return r.stdout;
}

/** パス比較用の正規化(大文字小文字・区切り文字を揃える) */
export function normPath(p: string): string {
  return path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 直列化用のミューテックス(リポジトリごとの git 操作に使う) */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.last.then(fn, fn);
    this.last = p.catch(() => undefined);
    return p;
  }
}

/** 同時実行数を制限する(リポジトリごとのウォームアップは 1 本ずつ) */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** ドライブの空き容量(GB)。取得できなければ null */
export async function freeDiskGB(p: string): Promise<number | null> {
  const root = path.parse(path.resolve(p)).root;
  try {
    const st = await fs.promises.statfs(root);
    return (Number(st.bavail) * Number(st.bsize)) / 1024 ** 3;
  } catch {
    return null;
  }
}
