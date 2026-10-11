// ProjectService: フォルダ(プロジェクト)ごとの管理画面(GET /api/project ほか)と、画面からの git 操作(stage / commit / push)。
// - プロジェクト = 登録リポジトリ(repoId: .base + 使用中の worktree)または普通のフォルダ(cwd)
// - 読み取りはミューテックスを使わない(git status / diff / log は並列に走らせてよい)。結果は 3 秒キャッシュ
// - 書き込み(stage / commit / push)は .base(と push)をリポジトリのミューテックスで直列化する
// - 操作後はキャッシュを捨て、worktree の変更状況(gitstat)と PR(push 時)を取り直す
import fs from 'node:fs';
import path from 'node:path';
import type {
  Artifact,
  CommitInfo,
  FileChangeStatus,
  GitBranchItem,
  GitTarget,
  ProjectOverview,
  ProjectTokens,
  RepoInfo,
  SessionInfo,
} from '@cc-hub/shared';
import type { SessionManager } from '../session/manager';
import type { RepoManager } from '../repo/manager';
import { normalizeRepoUrl } from '../repo/manager';
import type { GitStatWatcher } from '../repo/gitstat';
import type { GitHubWatcher } from '../github/watcher';
import { baseOf } from '../repo/pool';
import { Semaphore, git, normPath, tail, type RunResult } from '../repo/exec';
import { HttpError } from '../util';
import {
  LOG_FORMAT,
  artifactKind,
  isArtifactExcluded,
  isInside,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusV2Z,
  resolveTargetPath,
  splitStatus,
  toRel,
} from './parse';

const CACHE_MS = 3_000;
const TARGET_PARALLEL = 3;
const GIT_TIMEOUT = 60_000;
const PUSH_TIMEOUT = 3 * 60_000;
const UNTRACKED_MAX = 500;
const ARTIFACT_MAX = 300;
const COMMITS_MAX = 50;
const COMMITS_NO_BASE = 20;
const UNPUSHED_SCAN = 500;
export const TEXT_MAX = 512 * 1024;
export const IMAGE_MAX = 20 * 1024 * 1024;
export const DIFF_MAX = 200 * 1024;

/** そのまま返す画像(SVG は CSP 付き) */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** セッションが作業中とみなす状態(コミットを止める) */
const BUSY: SessionInfo['status'][] = ['running', 'awaiting_approval'];

export interface ProjectDeps {
  sessions: SessionManager;
  repos: RepoManager;
  github: GitHubWatcher;
  gitStat: GitStatWatcher | null;
}

/** 解決済みのターゲット(内部用) */
interface Target {
  id: string;
  kind: GitTarget['kind'];
  label: string;
  path: string;
  repo: RepoInfo | null;
  worktreeId: string | null;
  /** worktree に割り当てられたセッション(dir / base はパスから推定) */
  sessionId: string | null;
}

export type FileResult =
  | { type: 'json'; body: { ok: true; path: string; size: number; mtime: number; binary: boolean; truncated: boolean; text: string | null } }
  | { type: 'raw'; mime: string; data: Buffer; svg: boolean };

function eqi(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 読み取り専用の git(-C <path>、パスの「:」などを pathspec の魔法として解釈させない) */
function g(cwd: string, args: string[], timeout = GIT_TIMEOUT, input?: string): Promise<RunResult> {
  return git(['--literal-pathspecs', '-C', cwd, ...args], { timeout, input });
}

/** 存在する一番近い祖先を realpath して、root(realpath)の中にあるか確認する(ジャンクション / シンボリックリンク対策) */
async function realInside(root: string, abs: string): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
  } catch {
    return false;
  }
  let p = abs;
  for (let i = 0; i < 100; i++) {
    try {
      const real = await fs.promises.realpath(p);
      return isInside(rootReal, real);
    } catch {
      const up = path.dirname(p);
      if (up === p) return false;
      p = up;
    }
  }
  return false;
}

export class ProjectService {
  private readonly cache = new Map<string, { at: number; p: Promise<ProjectOverview> }>();

  constructor(private readonly d: ProjectDeps) {}

  /** キャッシュを捨てる(git 操作の後) */
  invalidate(): void {
    this.cache.clear();
  }

  // ================================================================ 概要
  async overview(q: { repoId?: string | null; cwd?: string | null }): Promise<ProjectOverview> {
    let key: string;
    let build: () => Promise<ProjectOverview>;
    if (q.repoId) {
      const repo = this.d.repos.require(q.repoId);
      key = `r:${repo.id}`;
      build = () => this.buildRepo(repo);
    } else if (q.cwd) {
      const cwd = path.resolve(q.cwd);
      if (!isDir(cwd)) throw new HttpError(400, `ディレクトリが存在しません: ${q.cwd}`);
      key = `d:${cwd.toLowerCase()}`;
      build = () => this.buildDir(cwd);
    } else {
      throw new HttpError(400, 'repoId か cwd を指定してください');
    }
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.p;
    const p = build();
    this.cache.set(key, { at: now, p });
    p.catch(() => {
      if (this.cache.get(key)?.p === p) this.cache.delete(key);
    });
    return p;
  }

  private async buildRepo(repo: RepoInfo): Promise<ProjectOverview> {
    const all = Object.values(this.d.sessions.all());
    const sessions = all
      .filter(
        (s) =>
          eqi(s.repoId, repo.id) ||
          (!!s.cwd && (isInside(repo.baseDir, s.cwd) || (repo.linkedDirs ?? []).some((d) => isInside(d, s.cwd)))),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    const list: { t: Target; idle: boolean }[] = [];
    for (const w of this.d.repos.pool.forRepo(repo.id)) {
      if (w.state !== 'assigned' && w.state !== 'idle') continue;
      if (!isDir(w.path)) continue;
      list.push({
        t: {
          id: `wt:${w.id}`,
          kind: 'worktree',
          label: w.name,
          path: w.path,
          repo,
          worktreeId: w.id,
          sessionId: w.state === 'assigned' ? w.sessionId : null,
        },
        idle: w.state === 'idle',
      });
    }
    const base = baseOf(repo);
    if (repo.status === 'ready' && isDir(base)) {
      list.push({ t: { id: `base:${repo.id}`, kind: 'base', label: '.base', path: base, repo, worktreeId: null, sessionId: this.guessSession(base, all) }, idle: false });
    }
    // 紐付けたクローン済みのフォルダ(再スキャンで見つけたもの)。プールの外なので dir として扱う
    for (const dir of repo.linkedDirs ?? []) {
      if (!isDir(dir)) continue;
      const top = path.resolve(dir);
      list.push({
        t: { id: `dir:${top}`, kind: 'dir', label: path.basename(top) || top, path: top, repo: null, worktreeId: null, sessionId: this.guessSession(top, all) },
        idle: false,
      });
    }
    const sem = new Semaphore(TARGET_PARALLEL);
    const computed = await Promise.all(
      list.map(({ t, idle }) =>
        sem.run(async () => {
          const r = await this.compute(t).catch((e) => {
            console.warn(`[project] ${t.id}: ${(e as Error).message}`);
            return null;
          });
          // 待機中の worktree は変更があるときだけ出す
          if (r && idle && !r.target.staged.length && !r.target.unstaged.length && !r.target.untracked.length) return null;
          return r;
        }),
      ),
    );
    const ok = computed.filter((x): x is NonNullable<typeof x> => !!x);
    const prIds = this.d.github
      .list()
      .filter((p) => eqi(p.repoId, repo.id))
      .map((p) => p.id);
    return {
      key: { repoId: repo.id, cwd: null },
      name: repo.id,
      path: repo.baseDir,
      sessionIds: sessions.map((s) => s.id),
      targets: ok.map((x) => x.target),
      artifacts: ok.flatMap((x) => x.artifacts),
      prIds,
      tokens: sumTokens(sessions),
      updatedAt: Date.now(),
    };
  }

  private async buildDir(cwd: string): Promise<ProjectOverview> {
    const all = Object.values(this.d.sessions.all());
    const sessions = all.filter((s) => !!s.cwd && isInside(cwd, s.cwd)).sort((a, b) => b.createdAt - a.createdAt);
    const top = await this.toplevel(cwd);
    let target: Awaited<ReturnType<ProjectService['compute']>> | null = null;
    let originId: string | null = null;
    if (top) {
      const t: Target = { id: `dir:${top}`, kind: 'dir', label: path.basename(top) || top, path: top, repo: this.repoForPath(top), worktreeId: null, sessionId: null };
      t.sessionId = this.guessSession(top, all);
      const [r, origin] = await Promise.all([this.compute(t), g(top, ['remote', 'get-url', 'origin'])]);
      target = r;
      if (origin.code === 0) {
        const o = normalizeRepoUrl(origin.stdout.trim());
        if (o) originId = `${o.owner}/${o.name}`;
      }
    }
    // PR は origin が同じリポジトリのもの(origin が GitHub でなければ無し)
    const prIds = originId
      ? this.d.github
          .list()
          .filter((p) => eqi(p.repoId, originId))
          .map((p) => p.id)
      : [];
    return {
      key: { repoId: null, cwd },
      name: path.basename(cwd) || cwd,
      path: cwd,
      sessionIds: sessions.map((s) => s.id),
      targets: target ? [target.target] : [],
      artifacts: target ? target.artifacts : [],
      prIds,
      tokens: sumTokens(sessions),
      updatedAt: Date.now(),
    };
  }

  /** フォルダの git のトップ(git リポジトリでなければ null) */
  private async toplevel(cwd: string): Promise<string | null> {
    const r = await g(cwd, ['rev-parse', '--show-toplevel'], 30_000);
    if (r.code !== 0) return null;
    const p = r.stdout.trim();
    return p ? path.resolve(p) : null;
  }

  /** パスが登録リポジトリの .base / worktree ならそのリポジトリ */
  private repoForPath(p: string): RepoInfo | null {
    const w = this.d.repos.pool.byPath(p);
    const all = this.d.repos.all();
    if (w) return all[w.repoId] ?? null;
    return Object.values(all).find((r) => isInside(baseOf(r), p) && isInside(p, baseOf(r))) ?? null;
  }

  /** パスの中で動いているセッション(作業中を優先し、次に新しいもの) */
  private guessSession(p: string, all: SessionInfo[]): string | null {
    const inside = all.filter((s) => !!s.cwd && isInside(p, s.cwd) && s.status !== 'stopped');
    inside.sort((a, b) => Number(BUSY.includes(b.status)) - Number(BUSY.includes(a.status)) || b.lastEventAt - a.lastEventAt);
    return inside[0]?.id ?? null;
  }

  // ================================================================ ターゲット 1 つ分
  private async defaultBranch(t: Target): Promise<string | null> {
    if (t.repo) return t.repo.defaultBranch;
    const r = await g(t.path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 30_000);
    if (r.code === 0 && r.stdout.trim().startsWith('origin/')) return r.stdout.trim().slice(7);
    for (const b of ['main', 'master']) {
      const v = await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], 30_000);
      if (v.code === 0) return b;
    }
    return null;
  }

  private async compute(t: Target): Promise<{ target: GitTarget; artifacts: Artifact[] }> {
    const [st, cachedNum, wtNum, defBranch] = await Promise.all([
      g(t.path, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
      g(t.path, ['diff', '--cached', '--numstat', '-z', '-M']),
      g(t.path, ['diff', '--numstat', '-z']),
      this.defaultBranch(t),
    ]);
    if (st.code !== 0) throw new Error(`git status に失敗: ${tail(st, 200)}`);
    const s = parseStatusV2Z(st.stdout);
    const split = splitStatus(s.entries, parseNumstatZ(cachedNum.stdout), parseNumstatZ(wtNum.stdout), UNTRACKED_MAX);
    const hasHead = !!s.oid;

    // 比較対象(origin/<default>)
    let baseRef: string | null = null;
    if (defBranch && hasHead) {
      const v = await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defBranch}`], 30_000);
      if (v.code === 0) baseRef = `origin/${defBranch}`;
    }
    // upstream: 既定ブランチを upstream にしている(switch -c で自動設定された)ものは無いものとみなす
    let upstream: string | null = s.upstream && s.upstream !== baseRef ? s.upstream : null;
    if (upstream && hasHead) {
      const v = await g(t.path, ['rev-parse', '--verify', '--quiet', upstream], 30_000);
      if (v.code !== 0) upstream = null; // upstream が消えた(gone)
    }
    if (!upstream && s.head && hasHead && s.head !== defBranch) {
      const v = await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${s.head}`], 30_000);
      if (v.code === 0) upstream = `origin/${s.head}`;
    }
    if (!upstream && s.head && s.head === defBranch && baseRef) upstream = baseRef;

    let ahead = 0;
    let behind = 0;
    const jobs: Promise<unknown>[] = [];
    let unpushedOut = '';
    let logOut = '';
    let committedOut = '';
    if (hasHead) {
      if (baseRef) {
        jobs.push(
          g(t.path, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]).then((r) => {
            const m = /(\d+)\s+(\d+)/.exec(r.stdout);
            if (r.code === 0 && m) {
              behind = Number(m[1]);
              ahead = Number(m[2]);
            }
          }),
        );
        jobs.push(
          g(t.path, ['diff', '--name-status', '-z', '-M', `${baseRef}...HEAD`]).then((r) => {
            if (r.code === 0) committedOut = r.stdout;
          }),
        );
      }
      // push していないコミット: upstream があれば upstream..HEAD、無ければどのリモートにも無いもの
      const unpushedArgs = upstream ? ['rev-list', `--max-count=${UNPUSHED_SCAN}`, `${upstream}..HEAD`] : ['rev-list', `--max-count=${UNPUSHED_SCAN}`, 'HEAD', '--not', '--remotes'];
      jobs.push(
        g(t.path, unpushedArgs).then((r) => {
          if (r.code === 0) unpushedOut = r.stdout;
        }),
      );
      // 既定ブランチ上では baseRef..HEAD は「未 push 分」だけになるので、直近のコミットを出す
      const logArgs = baseRef && s.head !== defBranch
        ? ['log', `--format=${LOG_FORMAT}`, `--max-count=${COMMITS_MAX}`, `${baseRef}..HEAD`]
        : ['log', `--format=${LOG_FORMAT}`, `--max-count=${COMMITS_NO_BASE}`, 'HEAD'];
      jobs.push(
        g(t.path, logArgs).then((r) => {
          if (r.code === 0) logOut = r.stdout;
        }),
      );
    }
    await Promise.all(jobs);
    const unpushedSet = new Set(unpushedOut.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    const commits: CommitInfo[] = parseLog(logOut, unpushedSet);
    const now = Date.now();
    const target: GitTarget = {
      id: t.id,
      kind: t.kind,
      label: t.label,
      path: t.path,
      unity: fs.existsSync(path.join(t.path, 'ProjectSettings', 'ProjectVersion.txt')),
      branch: s.head,
      baseRef,
      upstream,
      ahead,
      behind,
      unpushed: unpushedSet.size,
      staged: split.staged,
      unstaged: split.unstaged,
      untracked: split.untracked,
      commits,
      sessionId: t.sessionId,
      updatedAt: now,
    };
    const artifacts = await this.artifacts(t, target, committedOut);
    return { target, artifacts };
  }

  /** baseRef...HEAD の変更(コミット済み)+ 未コミット(staged / unstaged / 未追跡) */
  private async artifacts(t: Target, target: GitTarget, committedOut: string): Promise<Artifact[]> {
    const map = new Map<string, { status: FileChangeStatus; committed: boolean }>();
    for (const c of parseNameStatusZ(committedOut)) map.set(c.path, { status: c.status, committed: true });
    // 未コミットの変更が優先(今の状態はまだコミットされていない)
    for (const c of [...target.unstaged, ...target.staged]) map.set(c.path, { status: c.status, committed: false });
    for (const p of target.untracked) map.set(p, { status: '?', committed: false });
    const list = [...map.entries()].filter(([p]) => !isArtifactExcluded(p)).slice(0, ARTIFACT_MAX);
    return Promise.all(
      list.map(async ([p, v]): Promise<Artifact> => {
        let size = 0;
        let mtime = 0;
        if (v.status !== 'D') {
          try {
            const st = await fs.promises.stat(path.join(t.path, p));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            /* 消えている */
          }
        }
        return { targetId: t.id, sessionId: t.sessionId, path: p, status: v.status, kind: artifactKind(p), size, mtime: Math.round(mtime), committed: v.committed };
      }),
    );
  }

  // ================================================================ ターゲットの解決
  private async resolve(id: unknown): Promise<Target> {
    const s = String(id ?? '');
    if (s.startsWith('wt:')) {
      const w = this.d.repos.pool.get(s.slice(3));
      if (!w || (w.state !== 'assigned' && w.state !== 'idle') || !isDir(w.path)) throw new HttpError(404, 'worktree が見つかりません');
      const repo = this.d.repos.all()[w.repoId] ?? null;
      return { id: s, kind: 'worktree', label: w.name, path: w.path, repo, worktreeId: w.id, sessionId: w.state === 'assigned' ? w.sessionId : null };
    }
    if (s.startsWith('base:')) {
      const repo = this.d.repos.require(s.slice(5));
      const base = baseOf(repo);
      if (repo.status !== 'ready' || !isDir(base)) throw new HttpError(409, `リポジトリの準備ができていません(${repo.status})`);
      return { id: `base:${repo.id}`, kind: 'base', label: '.base', path: base, repo, worktreeId: null, sessionId: this.guessSession(base, Object.values(this.d.sessions.all())) };
    }
    if (s.startsWith('dir:')) {
      const p = path.resolve(s.slice(4));
      if (!s.slice(4) || !isDir(p)) throw new HttpError(404, `ディレクトリが存在しません: ${s.slice(4)}`);
      const top = await this.toplevel(p);
      if (!top) throw new HttpError(400, 'git リポジトリではありません');
      return { id: `dir:${top}`, kind: 'dir', label: path.basename(top) || top, path: top, repo: this.repoForPath(top), worktreeId: null, sessionId: this.guessSession(top, Object.values(this.d.sessions.all())) };
    }
    throw new HttpError(400, 'target は "wt:<id>" / "base:<repoId>" / "dir:<path>" のいずれかです');
  }

  /** 相対パスを検査して絶対パスにする(.git 配下・ターゲット外は 400) */
  private async checkPath(t: Target, rel: unknown): Promise<{ abs: string; rel: string }> {
    const abs = resolveTargetPath(t.path, rel);
    if (!abs || !(await realInside(t.path, abs))) throw new HttpError(400, `不正なパスです: ${String(rel ?? '')}`);
    return { abs, rel: toRel(t.path, abs) };
  }

  /** 書き込みに使うミューテックス(.base とそれを指す dir)。null = 直列化しない */
  private lockRepo(t: Target, forPush = false): string | null {
    if (!t.repo) return null;
    if (t.kind === 'base' || forPush) return t.repo.id;
    if (t.kind === 'dir' && isInside(baseOf(t.repo), t.path) && isInside(t.path, baseOf(t.repo))) return t.repo.id;
    return null;
  }

  private withLock<T>(t: Target, forPush: boolean, fn: () => Promise<T>): Promise<T> {
    const id = this.lockRepo(t, forPush);
    return id ? this.d.repos.pool.withLock(id, fn) : fn();
  }

  /** 操作の後: キャッシュを捨て、worktree の変更状況を取り直す */
  private after(t: Target): void {
    this.invalidate();
    if (t.worktreeId) void this.d.gitStat?.refresh(t.worktreeId).catch(() => undefined);
  }

  // ================================================================ ファイル / diff
  async file(targetId: unknown, rel: unknown): Promise<FileResult> {
    const t = await this.resolve(targetId);
    const { abs, rel: r } = await this.checkPath(t, rel);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      throw new HttpError(404, 'ファイルがありません');
    }
    if (!st.isFile()) throw new HttpError(400, 'ファイルではありません');
    const ext = path.extname(abs).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime) {
      if (st.size > IMAGE_MAX) throw new HttpError(413, `画像が大きすぎます(${st.size} バイト)`);
      return { type: 'raw', mime, data: await fs.promises.readFile(abs), svg: ext === '.svg' };
    }
    const len = Math.min(st.size, TEXT_MAX);
    const buf = Buffer.alloc(len);
    const fh = await fs.promises.open(abs, 'r');
    let n = 0;
    try {
      ({ bytesRead: n } = await fh.read(buf, 0, len, 0));
    } finally {
      await fh.close();
    }
    const data = buf.subarray(0, n);
    const binary = data.subarray(0, 8000).includes(0);
    return {
      type: 'json',
      body: { ok: true, path: r, size: st.size, mtime: Math.round(st.mtimeMs), binary, truncated: st.size > TEXT_MAX, text: binary ? null : data.toString('utf8') },
    };
  }

  /**
   * 1 ファイルの unified diff。staged=1 は index と HEAD の差。それ以外は作業ツリーと index の差で、
   * 空なら未追跡ファイルは /dev/null との差、コミット済みの変更(アーティファクト)は baseRef...HEAD の差を返す
   */
  async diff(targetId: unknown, rel: unknown, staged: boolean): Promise<{ diff: string; truncated: boolean }> {
    const t = await this.resolve(targetId);
    const { rel: r } = await this.checkPath(t, rel);
    let out = '';
    if (staged) {
      out = (await g(t.path, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', r])).stdout;
    } else {
      out = (await g(t.path, ['diff', '--no-color', '--no-ext-diff', '--', r])).stdout;
      if (!out) {
        const u = await g(t.path, ['ls-files', '--others', '--exclude-standard', '-z', '--', r]);
        if (u.code === 0 && u.stdout.split('\0').includes(r)) {
          // 未追跡: /dev/null との差(差があると終了コード 1)
          out = (await g(t.path, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', r])).stdout;
        }
      }
      if (!out) {
        const def = await this.defaultBranch(t);
        if (def) {
          const v = await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def}`], 30_000);
          if (v.code === 0) out = (await g(t.path, ['diff', '--no-color', '--no-ext-diff', '-M', `origin/${def}...HEAD`, '--', r])).stdout;
        }
      }
    }
    const truncated = Buffer.byteLength(out, 'utf8') > DIFF_MAX;
    if (truncated) out = Buffer.from(out, 'utf8').subarray(0, DIFF_MAX).toString('utf8');
    return { diff: out, truncated };
  }

  // ================================================================ stage / commit / push
  private async checkPaths(t: Target, paths: unknown): Promise<string[]> {
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths(相対パスの配列)を指定してください');
    if (paths.length > 2000) throw new HttpError(400, 'paths が多すぎます');
    const out: string[] = [];
    for (const p of paths) out.push((await this.checkPath(t, p)).rel);
    return [...new Set(out)];
  }

  async stage(body: any): Promise<GitTarget> {
    const t = await this.resolve(body?.target);
    const paths = await this.checkPaths(t, body?.paths);
    const unstage = body?.unstage === true;
    await this.withLock(t, false, async () => {
      let r: RunResult;
      if (unstage) {
        r = await g(t.path, ['restore', '--staged', '--', ...paths]);
        // まだコミットが無いリポジトリでは restore --staged が使えない
        if (r.code !== 0 && /could not resolve HEAD|invalid reference|bad revision 'HEAD'/i.test(r.stderr)) r = await g(t.path, ['rm', '--cached', '-r', '-q', '--', ...paths]);
      } else {
        r = await g(t.path, ['add', '-A', '--', ...paths]);
      }
      if (r.code !== 0) throw new HttpError(409, `git ${unstage ? 'restore --staged' : 'add'} に失敗しました: ${tail(r)}`);
    });
    console.log(`[git] ${unstage ? 'unstage' : 'stage'} ${t.id} (${paths.length} 件)`);
    this.after(t);
    return (await this.compute(t)).target;
  }

  /** そのターゲットで作業中(running / 承認待ち)のセッション */
  private busySession(t: Target): SessionInfo | null {
    const all = Object.values(this.d.sessions.all());
    for (const s of all) {
      const linked = (t.sessionId && s.id === t.sessionId) || (!!s.cwd && isInside(t.path, s.cwd));
      if (!linked || !BUSY.includes(s.status)) continue;
      // CC Hub のセッションは PTY が動いているときだけ(外部セッションは hooks の状態を信じる)
      if (s.managed && !this.d.sessions.isLive(s.id)) continue;
      return s;
    }
    return null;
  }

  async commit(body: any): Promise<CommitInfo> {
    const t = await this.resolve(body?.target);
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!message.trim()) throw new HttpError(400, 'コミットメッセージを入力してください');
    if (message.length > 100_000) throw new HttpError(400, 'コミットメッセージが長すぎます');
    const paths = body?.paths != null ? await this.checkPaths(t, body.paths) : null;
    if (body?.force !== true) {
      const busy = this.busySession(t);
      if (busy) throw new HttpError(409, `セッションが作業中です(${busy.name})。Claude の作業と衝突しないよう、止まってからコミットするか強制してください`);
    }
    const commit = await this.withLock(t, false, async () => {
      if (paths) {
        const a = await g(t.path, ['add', '-A', '--', ...paths]);
        if (a.code !== 0) throw new HttpError(409, `git add に失敗しました: ${tail(a)}`);
      }
      const q = await g(t.path, ['diff', '--cached', '--quiet']);
      if (q.code === 0) throw new HttpError(409, 'ステージされた変更がありません');
      // メッセージは標準入力で渡す(シェルを通さない・複数行をそのまま)
      const r = await g(t.path, ['commit', '-F', '-', '--cleanup=strip'], GIT_TIMEOUT, message);
      if (r.code !== 0) throw new HttpError(409, `git commit に失敗しました: ${tail(r)}`);
      const l = await g(t.path, ['log', '-1', `--format=${LOG_FORMAT}`, 'HEAD']);
      const c = parseLog(l.stdout, new Set())[0];
      if (!c) throw new HttpError(500, 'コミットの情報を取得できませんでした');
      return { ...c, pushed: false };
    });
    console.log(`[git] commit ${t.id} ${commit.sha.slice(0, 8)} ${commit.subject.slice(0, 80)}`);
    this.after(t);
    return commit;
  }

  // ================================================================ ブランチの切り替え
  /** 切り替え先の候補: ローカルのブランチ + origin にだけあるブランチ(新しい順) */
  async branches(targetId: unknown): Promise<GitBranchItem[]> {
    const t = await this.resolve(targetId);
    const fmt = '%(refname)%09%(HEAD)%09%(upstream:short)%09%(committerdate:unix)';
    const [refs, wl] = await Promise.all([
      g(t.path, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes/origin'], 30_000),
      g(t.path, ['worktree', 'list', '--porcelain'], 30_000),
    ]);
    if (refs.code !== 0) throw new HttpError(409, `ブランチの一覧を取得できませんでした: ${tail(refs)}`);
    // 別の作業ツリーでチェックアウト中のブランチ
    const elsewhere = new Map<string, string>();
    let wtPath = '';
    for (const line of wl.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wtPath = path.resolve(line.slice(9).trim());
      const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
      if (m && normPath(wtPath) !== normPath(t.path)) elsewhere.set(m[1], wtPath);
    }
    const local = new Map<string, GitBranchItem>();
    const remote: GitBranchItem[] = [];
    for (const line of refs.stdout.split(/\r?\n/)) {
      const [ref, head, upstream, date] = line.split('\t');
      if (!ref) continue;
      const item = (name: string, isLocal: boolean): GitBranchItem => ({
        name,
        current: head === '*',
        local: isLocal,
        upstream: upstream || null,
        date: Number(date) * 1000 || 0,
        checkedOutAt: isLocal ? elsewhere.get(name) ?? null : null,
      });
      if (ref.startsWith('refs/heads/')) local.set(ref.slice(11), item(ref.slice(11), true));
      else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') remote.push(item(ref.slice(20), false));
    }
    const list = [...local.values(), ...remote.filter((r) => !local.has(r.name))];
    return list.sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date);
  }

  /** ブランチを切り替える(create = 今の位置から新しいブランチを作る) */
  async switchBranch(body: any): Promise<GitTarget> {
    const t = await this.resolve(body?.target);
    if (t.kind !== 'dir') {
      throw new HttpError(409, 'CC Hub の作業ツリーと .base のブランチは CC Hub が管理しているため切り替えられません(セッションごとにブランチが決まります)');
    }
    const name = typeof body?.branch === 'string' ? body.branch.trim() : '';
    if (!name) throw new HttpError(400, 'ブランチ名を指定してください');
    const create = body?.create === true;
    const valid = await g(t.path, ['check-ref-format', '--branch', name], 30_000);
    if (valid.code !== 0 || name.startsWith('-')) throw new HttpError(400, `ブランチ名に使えない文字が含まれています: ${name}`);
    if (body?.force !== true) {
      const busy = this.busySession(t);
      if (busy) throw new HttpError(409, `セッションが作業中です(${busy.name})。Claude の作業中にブランチを変えると混乱するので、止まってから切り替えるか強制してください`);
    }
    const dirty = await g(t.path, ['status', '--porcelain', '--untracked-files=no'], 30_000);
    if (dirty.stdout.trim()) throw new HttpError(409, 'コミットしていない変更があります。先にコミットするか、変更を戻してから切り替えてください');
    await this.withLock(t, false, async () => {
      let args: string[];
      if (create) {
        args = ['switch', '-c', name];
      } else {
        const hasLocal = await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], 30_000);
        const hasRemote = hasLocal.code === 0 ? null : await g(t.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], 30_000);
        if (hasLocal.code !== 0 && hasRemote?.code !== 0) throw new HttpError(404, `ブランチが見つかりません: ${name}`);
        args = hasLocal.code === 0 ? ['switch', name] : ['switch', '-c', name, '--track', `origin/${name}`];
      }
      const r = await g(t.path, args);
      if (r.code !== 0) {
        const msg = tail(r);
        if (/already (checked out|used by worktree)/i.test(msg)) throw new HttpError(409, `このブランチは別の作業ツリーで使われているため切り替えられません: ${msg}`);
        throw new HttpError(409, `git switch に失敗しました: ${msg}`);
      }
    });
    console.log(`[git] switch ${t.id} → ${name}${create ? '(新規)' : ''}`);
    this.after(t);
    return (await this.compute(t)).target;
  }

  async push(body: any): Promise<{ branch: string; output: string }> {
    const t = await this.resolve(body?.target);
    const head = await g(t.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 30_000);
    const branch = head.code === 0 ? head.stdout.trim() : '';
    if (!branch) throw new HttpError(409, 'ブランチがチェックアウトされていません(detached HEAD)');
    const def = await this.defaultBranch(t);
    const isDefault = def ? branch === def : branch === 'main' || branch === 'master';
    if (isDefault && body?.force !== true) {
      throw new HttpError(409, `既定ブランチ(${branch})への直接 push はできません。強制する場合は force を指定してください`);
    }
    console.log(`[git] push ${t.id} ${branch}`);
    const r = await this.withLock(t, true, () => g(t.path, ['push', '-u', 'origin', 'HEAD'], PUSH_TIMEOUT));
    const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n').slice(-4000);
    if (r.code !== 0) throw new HttpError(409, `git push に失敗しました: ${tail(r, 1000)}`);
    this.after(t);
    // PR の紐付けを取り直す(このブランチの PR があれば)
    const repo = t.repo ?? (await this.originRepo(t.path));
    if (repo) void this.d.github.pollHead(repo, branch).catch(() => undefined);
    return { branch, output };
  }

  /** origin が登録リポジトリならそれ */
  private async originRepo(p: string): Promise<RepoInfo | null> {
    const r = await g(p, ['remote', 'get-url', 'origin'], 30_000);
    const o = r.code === 0 ? normalizeRepoUrl(r.stdout.trim()) : null;
    if (!o) return null;
    return Object.values(this.d.repos.all()).find((x) => eqi(x.id, `${o.owner}/${o.name}`) && x.status === 'ready') ?? null;
  }
}

/** プロジェクトのセッションのトークン合計 */
export function sumTokens(sessions: SessionInfo[]): ProjectTokens {
  const out: ProjectTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, bySession: {} };
  for (const s of sessions) {
    const t = s.tokens;
    const row = { input: t?.input ?? 0, output: t?.output ?? 0, cacheRead: t?.cacheRead ?? 0, cacheCreation: t?.cacheCreation ?? 0, costUsd: s.costUsd ?? 0 };
    if (!t && !s.costUsd) continue;
    out.bySession[s.id] = row;
    out.input += row.input;
    out.output += row.output;
    out.cacheRead += row.cacheRead;
    out.cacheCreation += row.cacheCreation;
    out.costUsd += row.costUsd;
  }
  return out;
}
