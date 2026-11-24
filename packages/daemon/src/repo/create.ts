// 「プロジェクトを追加 → 新しく作る」: GitHub にリポジトリを作り、選んだフォルダの中身をプッシュして CC Hub に登録する。
// - フォルダの中身は .gitignore に従って数え、10 MB 以上のファイルを警告する(100 MB 以上は GitHub が受け付けない)
// - 調べるときはフォルダに何も書かない(Git でなければ一時的な bare リポジトリを --git-dir にして ls-files する)
// - プッシュするときだけ、そのフォルダで git init / add / commit / remote add / push する。
//   大きいファイルを除くときは .gitignore ではなく .git/info/exclude に入れる(フォルダのファイルは変えない)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CreateRepoRequest, NewRepoInspect, RegisterRepoRequest, RepoInfo } from '@cc-hub/shared';
import { HttpError, clampInt } from '../util';
import { type RunResult, git, normPath, tail } from './exec';
import { normalizeRepoUrl } from './manager';

export const LARGE_FILE_BYTES = 10 * 1024 * 1024;
/** GitHub はこれ以上のファイルをプッシュできない */
export const GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 100_000;
const PUSH_TIMEOUT = 60 * 60_000;

/** どの階層にあってもふつうはコミットしないフォルダ */
const HEAVY_ANY = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
/** 一番上にあるときにふつうはコミットしないフォルダ(Unity / .NET / ビルド出力) */
const HEAVY_TOP = new Set(['Library', 'Temp', 'Logs', 'obj', 'bin', 'dist', 'build', '.next', 'target']);

export interface CreateDeps {
  /** GitHub を変更する gh(ghMutate) */
  ghMutate: (args: string[]) => Promise<RunResult>;
  /** 読み取りの gh(ghRun) */
  ghRead: (args: string[]) => Promise<RunResult>;
  /** プッシュ先の URL(本番は https://github.com/<id>.git。テストはローカルの bare リポジトリ) */
  remoteUrl: (id: string) => string;
  register: (req: RegisterRepoRequest) => Promise<RepoInfo>;
  isRegistered: (id: string) => boolean;
  /** 一時ファイルの置き場所 */
  tmpDir?: string;
}

/** フォルダ名 → GitHub のリポジトリ名に使える形 */
export function suggestRepoName(dir: string): string {
  const base = path.basename(path.resolve(dir));
  const s = base
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s.slice(0, 100) || 'new-project';
}

export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name);
}

/** git の除外パターン用に、パスの特殊文字をエスケープして先頭に / を付ける(そのファイルだけに一致) */
export function excludePattern(rel: string): string {
  return '/' + rel.replace(/\\/g, '/').replace(/([*?[\]!#\\])/g, '\\$1').replace(/^(\s)/, '\\$1').replace(/(\s)$/, '\\$1');
}

function cleanPath(input: string): string {
  const p = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!p || !path.isAbsolute(p)) throw new HttpError(400, 'フォルダを絶対パスで指定してください');
  return path.normalize(p).replace(/[\\/]+$/, '') || path.normalize(p);
}

/** プッシュの対象になるファイル(.gitignore を反映)。フォルダには書き込まない */
async function listFiles(dir: string, isGit: boolean, tmpRoot: string): Promise<string[]> {
  let r: RunResult;
  if (isGit) {
    r = await git(['-C', dir, '-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z'], { timeout: 120_000 });
  } else {
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'inspect-'));
    try {
      const init = await git(['init', '-q', '--bare', tmp]);
      if (init.code !== 0) throw new HttpError(500, `一時リポジトリを作れません: ${tail(init)}`);
      r = await git(['--git-dir', tmp, '--work-tree', dir, '-c', 'core.quotepath=false', 'ls-files', '-o', '--exclude-standard', '-z'], {
        timeout: 120_000,
        cwd: dir,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (r.code !== 0) throw new HttpError(500, `ファイルの一覧を取れません: ${tail(r)}`);
  return r.stdout.split('\0').filter(Boolean);
}

export async function inspectNewRepoFolder(input: string, tmpRoot = os.tmpdir()): Promise<NewRepoInspect> {
  const dir = cleanPath(input);
  const out: NewRepoInspect = {
    dir,
    exists: false,
    isGit: false,
    origin: null,
    parentRepo: null,
    fileCount: 0,
    totalBytes: 0,
    large: [],
    truncated: false,
    heavyDirs: [],
    suggestedName: suggestRepoName(dir),
  };
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return out;
  }
  if (!st.isDirectory()) throw new HttpError(400, `フォルダではありません: ${dir}`);
  out.exists = true;
  const top = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (top.code === 0) {
    const t = path.normalize(top.stdout.trim());
    if (normPath(t) === normPath(dir)) out.isGit = true;
    else {
      out.parentRepo = t;
      return out;
    }
  }
  if (out.isGit) {
    const o = await git(['-C', dir, 'remote', 'get-url', 'origin']);
    if (o.code === 0 && o.stdout.trim()) out.origin = o.stdout.trim();
  }
  const files = await listFiles(dir, out.isGit, tmpRoot);
  const heavy = new Set<string>();
  const large: { path: string; bytes: number }[] = [];
  for (const rel of files) {
    if (out.fileCount >= MAX_FILES) {
      out.truncated = true;
      break;
    }
    const segs = rel.split('/');
    segs.slice(0, -1).forEach((s, i) => {
      if (HEAVY_ANY.has(s) || (i === 0 && HEAVY_TOP.has(s))) heavy.add(segs.slice(0, i + 1).join('/'));
    });
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, rel)).size;
    } catch {
      continue; // 一覧のあとで消えたファイル
    }
    out.fileCount++;
    out.totalBytes += size;
    if (size >= LARGE_FILE_BYTES) large.push({ path: rel, bytes: size });
  }
  large.sort((a, b) => b.bytes - a.bytes);
  out.large = large;
  // node_modules が入れ子で何十個も出ないよう、上の階層にまとめる
  out.heavyDirs = [...heavy].filter((h) => ![...heavy].some((o) => o !== h && h.startsWith(o + '/'))).sort().slice(0, 20);
  return out;
}

/** 自分のログイン名 + 所属する組織 */
export async function listOwners(ghRead: CreateDeps['ghRead']): Promise<string[]> {
  const me = await ghRead(['api', 'user', '--jq', '.login']);
  if (me.code !== 0) throw new HttpError(502, `GitHub のアカウントを取得できません(gh auth login が必要かもしれません): ${tail(me, 200)}`);
  const owners = [me.stdout.trim()].filter(Boolean);
  const orgs = await ghRead(['api', 'user/orgs', '--jq', '.[].login']);
  if (orgs.code === 0) owners.push(...orgs.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  return [...new Set(owners)];
}

async function gitStep(args: string[], what: string, o: { timeout?: number } = {}): Promise<RunResult> {
  const r = await git(args, o);
  if (r.code !== 0) throw new Error(`${what}に失敗しました: ${tail(r, 300)}`);
  return r;
}

/** GitHub にリポジトリを作り、(選んでいれば)フォルダの中身をプッシュして登録する */
export async function createRepo(req: CreateRepoRequest, deps: CreateDeps): Promise<RepoInfo> {
  const name = String(req?.name ?? '').trim();
  if (!validRepoName(name)) throw new HttpError(400, 'リポジトリ名は英数字と . _ - だけで 100 文字までにしてください');
  const owner = String(req?.owner ?? '').trim();
  if (owner && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) throw new HttpError(400, `作る場所(owner)の形式が正しくありません: ${owner}`);
  if (req?.trusted !== true) throw new HttpError(400, 'リポジトリを信頼することの確認(trusted: true)が必要です');
  const visibility = req?.visibility === 'public' ? 'public' : 'private';
  const description = String(req?.description ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 350);
  const poolMin = req?.poolMin == null ? undefined : clampInt(req.poolMin, 0, 10);
  const push = req?.push === true && !!String(req?.localPath ?? '').trim();

  // プッシュする場合は、GitHub に作る前にフォルダを確かめる(作ってから失敗しないように)
  let info: NewRepoInspect | null = null;
  if (push) {
    info = await inspectNewRepoFolder(String(req.localPath), deps.tmpDir);
    if (!info.exists) throw new HttpError(400, `フォルダが見つかりません: ${info.dir}`);
    if (info.parentRepo) throw new HttpError(400, `親フォルダが Git のリポジトリです: ${info.parentRepo}(そのリポジトリを登録してください)`);
    if (info.origin) throw new HttpError(409, `このフォルダには既に origin があります: ${info.origin}(「クローン済みのフォルダ」で登録してください)`);
    const pushable = req.excludeLarge ? info.large.length < info.fileCount : info.fileCount > 0;
    if (!pushable) throw new HttpError(400, 'プッシュするファイルがありません(フォルダが空か、すべて除外されています)');
    const tooBig = info.large.filter((f) => f.bytes >= GITHUB_MAX_FILE_BYTES);
    if (!req.excludeLarge && tooBig.length)
      throw new HttpError(400, `100 MB 以上のファイルは GitHub にプッシュできません: ${tooBig.map((f) => f.path).slice(0, 5).join(', ')}`);
  }

  const target = owner ? `${owner}/${name}` : name;
  if (owner && deps.isRegistered(target)) throw new HttpError(409, `既に登録されています: ${target}`);
  const args = ['repo', 'create', target, `--${visibility}`];
  if (description) args.push('--description', description);
  if (!push) args.push('--add-readme'); // 空のリポジトリだと worktree を作れないので README を入れる
  const made = await deps.ghMutate(args);
  if (made.code !== 0) throw new HttpError(400, `GitHub にリポジトリを作れませんでした: ${tail(made, 300)}`);
  const url = (made.stdout.match(/https:\/\/github\.com\/\S+/) ?? [])[0] ?? '';
  const parsed = normalizeRepoUrl(url) ?? (owner ? { owner, name } : null);
  if (!parsed) throw new HttpError(500, `作ったリポジトリの URL が分かりません: ${made.stdout.trim().slice(0, 200)}`);
  const id = `${parsed.owner}/${parsed.name}`;
  console.log(`[repo] GitHub に作成: ${id} (${visibility})${push ? ` ← ${info!.dir}` : ''}`);

  if (!push) return deps.register({ url: id, trusted: true, poolMin });

  const dir = info!.dir;
  try {
    if (!info!.isGit) await gitStep(['-C', dir, 'init', '-b', 'main'], 'git init');
    if (req.excludeLarge && info!.large.length) {
      const gitDir = (await gitStep(['-C', dir, 'rev-parse', '--absolute-git-dir'], 'git dir の確認')).stdout.trim();
      const exclude = path.join(gitDir, 'info', 'exclude');
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(
        exclude,
        `${cur && !cur.endsWith('\n') ? '\n' : ''}# CC Hub: 10 MB 以上のファイル(新しく作るときに除外)\n${info!.large.map((f) => excludePattern(f.path)).join('\n')}\n`,
      );
    }
    await gitStep(['-C', dir, 'add', '-A'], 'git add', { timeout: 30 * 60_000 });
    const hasHead = (await git(['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    const staged = (await git(['-C', dir, 'diff', '--cached', '--quiet'])).code === 1;
    if (staged) await gitStep(['-C', dir, 'commit', '-q', '-m', hasHead ? 'CC Hub: 作業中の変更' : 'Initial commit'], 'コミット', { timeout: 10 * 60_000 });
    else if (!hasHead) throw new Error('コミットするファイルがありません');
    await gitStep(['-C', dir, 'remote', 'add', 'origin', deps.remoteUrl(id)], 'origin の追加');
    const branch = (await gitStep(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 'ブランチの確認')).stdout.trim() || 'main';
    await gitStep(['-C', dir, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`], 'プッシュ', { timeout: PUSH_TIMEOUT });
  } catch (e) {
    throw new HttpError(
      500,
      `GitHub に ${id} を作りましたが、フォルダの中身を送れませんでした: ${(e as Error).message}。` +
        'フォルダの問題を直してから、そのフォルダで git push するか、「クローン済みのフォルダ」で登録してください',
    );
  }
  return deps.register({ url: '', localPath: dir, trusted: true, poolMin });
}
