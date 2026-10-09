// gh(GitHub CLI)の実行。デーモン内の gh 呼び出しはすべてここを通す(config.ghPath で差し替え可能)。
// - 読み取り: ghRun / ghJson
// - GitHub を変更する操作(pr create / merge / close など): ghMutate。必ず "[gh] <args>" をログに出す
// - cwd は git リポジトリではない場所(データディレクトリ)にする。gh pr merge --delete-branch が
//   カレントのリポジトリのローカルブランチまで触らないようにするため(gh pr checkout だけは worktree 内で実行する)
import fs from 'node:fs';
import os from 'node:os';
import { run, type RunOptions, type RunResult, tail } from '../repo/exec';

const GH_TIMEOUT = 60_000;
let ghPath = 'gh';
let neutralCwd = os.tmpdir();

export function setGhPath(p: string, cwd?: string): void {
  ghPath = p || 'gh';
  if (cwd && fs.existsSync(cwd)) neutralCwd = cwd;
}

export function getGhPath(): string {
  return ghPath;
}

/** gh を実行する(失敗しても reject しない) */
export function ghRun(args: string[], o: RunOptions = {}): Promise<RunResult> {
  const opts: RunOptions = {
    timeout: GH_TIMEOUT,
    cwd: neutralCwd,
    ...o,
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', ...(o.env ?? {}) },
  };
  // 検証用: .js / .cjs / .mjs なら node で実行する(.cmd は shell 無しでは spawn できないため)
  if (/\.(c|m)?js$/i.test(ghPath)) return run(process.execPath, [ghPath, ...args], opts);
  return run(ghPath, args, opts);
}

/** GitHub を変更する gh 操作。ログに "[gh] <args>" を必ず出す */
export async function ghMutate(args: string[], o: RunOptions = {}): Promise<RunResult> {
  console.log(`[gh] ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = await ghRun(args, o);
  if (r.code !== 0) console.warn(`[gh] 失敗 (code ${r.code}): ${tail(r, 300)}`);
  return r;
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate' | 'notfound' | 'other',
  ) {
    super(message);
  }
}

/** gh のエラー出力を分類する(バックオフの判断用) */
export function classifyGhError(r: RunResult): GhError['kind'] {
  const s = `${r.stderr}\n${r.stdout}`.toLowerCase();
  if (/rate limit|secondary rate|abuse detection|http 403.*limit/.test(s)) return 'rate';
  if (/gh auth login|not logged in|bad credentials|http 401|requires authentication|authentication required/.test(s)) return 'auth';
  if (/could not resolve to a|not found|http 404|no pull requests? found/.test(s)) return 'notfound';
  return 'other';
}

/** gh を実行して JSON を返す。失敗したら GhError */
export async function ghJson<T = any>(args: string[], o: RunOptions = {}): Promise<T> {
  const r = await ghRun(args, o);
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 3).join(' ')} に失敗: ${tail(r, 300)}`, classifyGhError(r));
  const text = r.stdout.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GhError(`gh ${args.slice(0, 3).join(' ')} の出力を JSON として読めません: ${text.slice(0, 200)}`, 'other');
  }
}

/** 自分のログイン名(キャッシュ)。取れなければ null */
let meCache: { login: string | null; at: number } | null = null;
export async function ghLogin(): Promise<string | null> {
  if (meCache && (meCache.login || Date.now() - meCache.at < 300_000)) return meCache.login;
  try {
    const j = await ghJson<{ login?: string }>(['api', 'user']);
    meCache = { login: j?.login ? String(j.login) : null, at: Date.now() };
  } catch {
    meCache = { login: null, at: Date.now() };
  }
  return meCache.login;
}
