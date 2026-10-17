// WorktreePool: リポジトリごとの worktree プール(design §7.3 / §7.4)。
//
//   creating → warming → idle ⇄ assigned → releasing → idle
//                          └─(余剰で idleTtl 分未使用)─▶ deleting → (削除)
//   任意の状態 ─(失敗)─▶ broken(UI から再作成 / 削除)
//
// - .base に触れる git 操作(fetch / worktree add・remove・prune / ブランチ作成・削除)はリポジトリごとのミューテックスで直列化する
// - worktree のディレクトリは <baseDir>\wt-01..、空いている一番小さい番号を使い回す(パスが同じなら信頼の記録が残るため)
// - ウォームアップ(依存インストール / Library コピー)はリポジトリごとに 1 本ずつ
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RebaseResult, ReleaseMode, RepoInfo, WorktreeGitStat, WorktreeInfo, WorktreeLocker, WorktreeState } from '@cc-hub/shared';
import { bus } from '../bus';
import type { HubConfig } from '../config';
import type { Store, WorktreeRow } from '../store/db';
import { HttpError } from '../util';
import { Mutex, Semaphore, freeDiskGB, git, gitOk, normPath, run, tail } from './exec';
import { installCommand, lockHash } from './kind';
import { findLockers, lockerMessage } from './lockers';
import { DIRTY_MSG, IN_USE_DELETE_MSG, IN_USE_REBASE_MSG, classifyRebase, computeInUse, parseConflictFiles, parseCount } from './worktree-ops';

const RECONCILE_MS = 30_000;
const FETCH_FRESH_MS = 30_000;
/** git fetch をやり直すまでの待ち時間(一時的なネットワークの不調向け) */
const FETCH_RETRY = [3_000, 10_000];
/** 待機中の worktree を最新の main に合わせる間隔 */
const REFRESH_MS = 15 * 60_000;
/** worktree の作成に失敗したら、この間は新しく作らない(失敗が続いて上限まで増えるのを防ぐ) */
const BROKEN_COOLDOWN_MS = 5 * 60_000;
const INSTALL_TIMEOUT = 30 * 60_000;
const ROBOCOPY_TIMEOUT = 2 * 3600_000;
const DELETE_MAX_FAIL = 3;
/** 開かれていて削除を見送った待機中の worktree を、次に確かめるまでの間隔 */
const LOCKED_RETRY_MS = 10 * 60_000;
export const DISK_WARN_PREFIX = 'ディスクの空きが不足';

interface Waiter {
  sessionId: string;
  resolve: (w: WorktreeRow) => void;
  reject: (e: Error) => void;
}

interface RepoRuntime {
  mutex: Mutex;
  warm: Semaphore;
  waiters: Waiter[];
  reconciling: boolean;
  again: boolean;
  removed: boolean;
  lastFetch: number;
  /** 待機中の worktree を最新の main に合わせた時刻 */
  lastRefresh: number;
  /** 最後に worktree の作成に失敗した時刻 */
  brokenAt: number;
}

export interface PoolDeps {
  cfg: HubConfig;
  store: Store;
  dataDir: string;
  getRepo: (id: string) => RepoInfo | undefined;
  /** リポジトリの警告を設定 / 解除する(ディスク不足など) */
  setRepoError: (id: string, error: string | null) => void;
  /** そのハブセッションが存在するか(起動時の復旧で使う) */
  sessionExists: (id: string) => boolean;
  /** そのセッションが動いているか(PTY が生きている / 起動準備中 / PowerShell で動作中)。inUse の判定に使う */
  sessionLive?: (id: string) => boolean;
}

export function baseOf(repo: RepoInfo): string {
  return path.join(repo.baseDir, '.base');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class WorktreePool {
  private readonly wts = new Map<string, WorktreeRow>();
  private readonly rts = new Map<string, RepoRuntime>();
  /** 処理中の worktree(二重に作業を始めないため) */
  private readonly busy = new Set<string>();
  /** 余剰の削除を見送った worktree → 次に確かめる時刻 */
  private readonly lockedUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: PoolDeps) {
    for (const w of d.store.loadWorktrees()) this.wts.set(w.id, w);
  }

  // ================================================================ 参照
  all(): Record<string, WorktreeInfo> {
    const out: Record<string, WorktreeInfo> = {};
    for (const [id, w] of this.wts) out[id] = this.pub(w);
    return out;
  }

  list(): WorktreeInfo[] {
    return [...this.wts.values()].map((w) => this.pub(w));
  }

  get(id: string): WorktreeRow | undefined {
    return this.wts.get(id);
  }

  forRepo(repoId: string): WorktreeRow[] {
    return [...this.wts.values()].filter((w) => w.repoId === repoId).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** cwd がプールの worktree ならそれを返す */
  byPath(p: string): WorktreeRow | undefined {
    const n = normPath(p);
    for (const w of this.wts.values()) if (normPath(w.path) === n) return w;
    return undefined;
  }

  private pub(w: WorktreeRow): WorktreeInfo {
    const { installHash: _h, failCount: _f, ...info } = w;
    // 変更状況(フェーズ 3)は assigned の間だけ見せる
    return { ...info, git: w.state === 'assigned' ? (w.git ?? null) : null, inUse: this.isInUse(w) };
  }

  /** フォルダをつかんでいるプロセス(調べられなければ null) */
  async lockers(id: string): Promise<WorktreeLocker[] | null> {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    return findLockers(w.path);
  }

  /** 使用中か(rebase・削除できない) */
  isInUse(w: WorktreeRow): boolean {
    return computeInUse(w.state, w.sessionId, (id) => this.d.sessionLive?.(id) ?? false);
  }

  /** セッションの動作状態が変わった: そのセッションの worktree を配信し直す(inUse が変わるため) */
  republishForSession(sessionId: string): void {
    for (const w of this.wts.values()) {
      if (w.sessionId === sessionId) bus.state({ t: 'worktree.upsert', worktree: this.pub(w) });
    }
  }

  /** 変更状況を更新して配信する(DB には保存しない)。assigned でなければ何もしない */
  setGitStat(id: string, git: WorktreeGitStat | null): void {
    const w = this.wts.get(id);
    if (!w || w.state !== 'assigned') return;
    w.git = git;
    bus.state({ t: 'worktree.upsert', worktree: this.pub(w) });
  }

  /** .base の refs に触れる操作をリポジトリのミューテックスで直列化して実行する */
  withLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    return this.rt(repoId).mutex.run(fn);
  }

  /** git fetch --prune(前回から 30 秒以内なら省略)。ミューテックス内で実行する */
  async fetchBase(repoId: string, force = false): Promise<void> {
    const repo = this.d.getRepo(repoId);
    if (!repo) return;
    await this.withLock(repoId, () => this.fetch(repo, force));
  }

  private rt(repoId: string): RepoRuntime {
    let r = this.rts.get(repoId);
    if (!r) {
      r = { mutex: new Mutex(), warm: new Semaphore(1), waiters: [], reconciling: false, again: false, removed: false, lastFetch: 0, lastRefresh: Date.now(), brokenAt: 0 };
      this.rts.set(repoId, r);
    }
    return r;
  }

  private logFile(w: WorktreeRow): string {
    return path.join(this.d.dataDir, 'worktree-logs', `${w.repoId.replace(/[\\/]/g, '__')}_${w.name}.log`);
  }

  /** 変更を保存して配信する */
  private set(w: WorktreeRow, patch: Partial<WorktreeRow>): void {
    Object.assign(w, patch);
    if (this.wts.get(w.id) !== w) return; // 既に取り除かれた
    this.d.store.saveWorktree(w);
    bus.state({ t: 'worktree.upsert', worktree: this.pub(w) });
  }

  private drop(w: WorktreeRow): void {
    if (this.wts.get(w.id) !== w) return;
    this.wts.delete(w.id);
    this.d.store.deleteWorktree(w.id);
    bus.state({ t: 'worktree.remove', id: w.id });
  }

  private broken(w: WorktreeRow, error: string): void {
    console.error(`[pool] ${w.id} → broken: ${error}`);
    this.rt(w.repoId).brokenAt = Date.now();
    this.set(w, { state: 'broken', progress: null, error: error.slice(0, 500) });
  }

  /** worktree 単位の作業を 1 本だけ走らせる */
  private task(w: WorktreeRow, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(w.id)) return Promise.resolve();
    this.busy.add(w.id);
    return fn()
      .catch((e) => console.error(`[pool] ${w.id}`, errMsg(e)))
      .finally(() => {
        this.busy.delete(w.id);
        this.kick(w.repoId);
      });
  }

  // ================================================================ 起動・定期処理
  start(): void {
    this.timer = setInterval(() => this.reconcileAll(), RECONCILE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  reconcileAll(): void {
    for (const id of this.rts.keys()) this.kick(id);
    for (const w of this.wts.values()) this.kick(w.repoId);
  }

  /** 非同期で reconcile を走らせる */
  kick(repoId: string): void {
    this.reconcile(repoId).catch((e) => console.error(`[pool] reconcile ${repoId}`, errMsg(e)));
  }

  /** 目標本数を保つ(不足なら作成、余剰で長く使われていない待機は削除、削除失敗のリトライ) */
  async reconcile(repoId: string): Promise<void> {
    const rt = this.rt(repoId);
    if (rt.reconciling) {
      rt.again = true;
      return;
    }
    rt.reconciling = true;
    try {
      do {
        rt.again = false;
        await this.reconcileOnce(repoId);
      } while (rt.again);
    } finally {
      rt.reconciling = false;
    }
  }

  private async reconcileOnce(repoId: string): Promise<void> {
    const repo = this.d.getRepo(repoId);
    const rt = this.rt(repoId);
    if (!repo || repo.status !== 'ready' || rt.removed) return;
    const list = this.forRepo(repoId);

    // 削除のリトライ
    for (const w of list) if (w.state === 'deleting' && !this.busy.has(w.id)) void this.task(w, () => this.destroy(w));
    // 待機中の worktree を最新の main に合わせる(ときどき)
    this.refreshIdle(repo);

    const isReady = (s: WorktreeState) => s === 'creating' || s === 'warming' || s === 'idle';
    const ready = list.filter((w) => isReady(w.state)).length;
    const need = repo.poolMin + rt.waiters.length;
    let toCreate = Math.min(need - ready, repo.poolMax - list.length);
    // 直前に作成に失敗していたら少し待つ(同じ原因で失敗し続けて上限まで増えないように)
    if (toCreate > 0 && Date.now() - rt.brokenAt < BROKEN_COOLDOWN_MS) toCreate = 0;

    if (toCreate > 0) {
      const free = await freeDiskGB(repo.baseDir);
      if (free != null && free < this.d.cfg.minFreeDiskGB) {
        const msg = `${DISK_WARN_PREFIX}(${free.toFixed(1)}GB < ${this.d.cfg.minFreeDiskGB}GB)のため補充を停止しています`;
        if (repo.error !== msg) {
          console.warn(`[pool] ${repoId}: ${msg}`);
          this.d.setRepoError(repoId, msg);
        }
        toCreate = 0;
      } else if (repo.error?.startsWith(DISK_WARN_PREFIX)) {
        this.d.setRepoError(repoId, null);
      }
      if (rt.removed) return;
      for (let i = 0; i < toCreate; i++) {
        const w = this.newRow(repo);
        console.log(`[pool] ${repoId}: ${w.name} を作成します`);
        void this.task(w, () => this.build(w));
      }
    }

    // 待っているセッションに渡せる見込みが無い(上限・ディスク不足・作成失敗)なら諦めさせる
    const after = this.forRepo(repoId);
    if (rt.waiters.length && !after.some((w) => w.state === 'creating' || w.state === 'warming')) {
      const waiters = rt.waiters.splice(0);
      for (const wt of waiters) wt.reject(new HttpError(409, `空いている worktree がありません(上限 ${repo.poolMax} 本)`));
    }

    // 縮小: 余剰の待機で idleTtl 分使われていないものを削除
    const excess = after.filter((w) => isReady(w.state)).length - need;
    if (excess > 0) {
      const ttl = this.d.cfg.idleTtlMinutes * 60_000;
      const now = Date.now();
      const victims = after
        .filter((w) => w.state === 'idle' && !this.busy.has(w.id) && now - w.lastUsedAt > ttl)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || b.name.localeCompare(a.name))
        .slice(0, excess);
      for (const w of victims) {
        if ((this.lockedUntil.get(w.id) ?? 0) > now) continue;
        void this.task(w, async () => {
          // Unity などで開かれている待機中のものは消さない(消し切れずに壊れるため)。しばらくしてから見直す
          const lockers = await findLockers(w.path);
          if (lockers?.length) {
            this.lockedUntil.set(w.id, Date.now() + LOCKED_RETRY_MS);
            console.log(`[pool] ${repoId}: 余剰の ${w.name} は使われているので削除を見送ります: ${lockers.map((l) => l.label).join('、')}`);
            return;
          }
          console.log(`[pool] ${repoId}: 余剰の ${w.name} を削除します`);
          await this.destroy(w);
        });
      }
    }
  }

  /** 空いている一番小さい番号で新しい行を作る(状態 creating) */
  private newRow(repo: RepoInfo): WorktreeRow {
    const used = new Set(this.forRepo(repo.id).map((w) => w.name));
    let n = 1;
    const nameOf = (i: number) => `wt-${String(i).padStart(2, '0')}`;
    while (used.has(nameOf(n))) n++;
    const name = nameOf(n);
    const w: WorktreeRow = {
      id: `${repo.id}#${name}`,
      repoId: repo.id,
      name,
      path: path.join(repo.baseDir, name),
      state: 'creating',
      branch: null,
      sessionId: null,
      lastUsedAt: Date.now(),
      progress: '作成待ち',
      error: null,
      installHash: null,
      failCount: 0,
    };
    this.wts.set(w.id, w);
    this.set(w, {});
    return w;
  }

  // ================================================================ 起動時の復旧
  /** DB とディスク(git worktree list)を突き合わせ、中断された作業をやり直す */
  async recover(repoId: string): Promise<void> {
    const repo = this.d.getRepo(repoId);
    if (!repo || repo.status !== 'ready') return;
    const base = baseOf(repo);
    if (!fs.existsSync(base)) {
      this.d.setRepoError(repoId, `.base が見つかりません: ${base}`);
      return;
    }
    const listed = await this.rt(repoId).mutex.run(async () => {
      await git(['-C', base, 'worktree', 'prune']);
      return listWorktrees(base);
    });
    const known = new Set<string>();
    for (const w of this.forRepo(repoId)) {
      const onDisk = listed.has(normPath(w.path));
      known.add(normPath(w.path));
      if (w.state !== 'broken' && (!onDisk || !['idle', 'assigned'].includes(w.state))) {
        console.log(`[pool] 復旧: ${w.id} (${w.state}${onDisk ? '' : '、ディスクに無し'})`);
      }
      switch (w.state) {
        case 'idle':
          if (!onDisk) void this.task(w, () => this.build(w));
          break;
        case 'assigned':
          if (!onDisk) this.broken(w, 'worktree がディスクに見つかりません');
          else if (!w.sessionId || !this.d.sessionExists(w.sessionId)) {
            // セッションが消えている → ブランチは残して待機に戻す
            void this.task(w, () => this.doRelease(w, 'keep'));
          }
          break;
        case 'creating':
          void this.task(w, () => this.build(w));
          break;
        case 'warming':
          void this.task(w, () => (onDisk ? this.warm(w) : this.build(w)));
          break;
        case 'releasing':
          void this.task(w, () => (onDisk ? this.doRelease(w, 'keep') : this.build(w)));
          break;
        case 'deleting':
          void this.task(w, () => this.destroy(w));
          break;
        case 'broken':
          break;
      }
      if ((w.state === 'idle' || w.state === 'assigned' || w.state === 'broken') && !this.busy.has(w.id) && w.progress) {
        this.set(w, { progress: null });
      }
    }
    // DB に無い wt-NN が残っていれば取り込む(初期化して待機に)
    for (const p of listed) {
      if (known.has(p)) continue;
      const name = path.basename(p);
      if (normPath(path.dirname(p)) !== normPath(repo.baseDir) || !/^wt-\d+$/i.test(name)) continue;
      const w: WorktreeRow = {
        id: `${repoId}#${name}`,
        repoId,
        name,
        path: path.join(repo.baseDir, name),
        state: 'releasing',
        branch: null,
        sessionId: null,
        lastUsedAt: Date.now(),
        progress: '既存の worktree を取り込み中',
        error: null,
        installHash: null,
        failCount: 0,
      };
      if (this.wts.has(w.id)) continue;
      this.wts.set(w.id, w);
      this.set(w, {});
      console.log(`[pool] ${repoId}: 既存の ${name} を取り込みます`);
      void this.task(w, () => this.doRelease(w, 'keep'));
    }
    this.kick(repoId);
  }

  // ================================================================ 作成・ウォームアップ
  /**
   * git fetch --prune。一時的なネットワークの不調(DNS など)に備えて少し間を空けて 3 回まで試し、
   * それでも失敗したら、前回取得済みの origin/<default> があればそれを使って続ける(無ければ例外)
   */
  private async fetch(repo: RepoInfo, force: boolean, logFile?: string): Promise<void> {
    const rt = this.rt(repo.id);
    if (!force && Date.now() - rt.lastFetch < FETCH_FRESH_MS) return;
    let last: unknown = null;
    for (let i = 0; i <= FETCH_RETRY.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, FETCH_RETRY[i - 1]));
      try {
        await gitOk(['-C', baseOf(repo), 'fetch', 'origin', '--prune'], { logFile, timeout: 5 * 60_000 });
        rt.lastFetch = Date.now();
        return;
      } catch (e) {
        last = e;
      }
    }
    const have = await git(['-C', baseOf(repo), 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${repo.defaultBranch}`]);
    if (have.code !== 0) throw last;
    console.warn(`[pool] ${repo.id}: git fetch に失敗したため、前回取得した origin/${repo.defaultBranch} で続けます: ${errMsg(last)}`);
  }

  /** 待機中の worktree を origin/<default> の最新に合わせる(前回から REFRESH_MS 以上たっていれば) */
  private refreshIdle(repo: RepoInfo): void {
    const rt = this.rt(repo.id);
    if (Date.now() - rt.lastRefresh < REFRESH_MS) return;
    rt.lastRefresh = Date.now();
    for (const w of this.forRepo(repo.id)) {
      if (w.state !== 'idle' || this.busy.has(w.id)) continue;
      void this.task(w, async () => {
        if (w.state !== 'idle') return;
        const logFile = this.logFile(w);
        await this.rt(repo.id).mutex.run(async () => {
          await this.fetch(repo, false, logFile);
          const [head, latest] = await Promise.all([
            git(['-C', w.path, 'rev-parse', 'HEAD']),
            git(['-C', baseOf(repo), 'rev-parse', `refs/remotes/origin/${repo.defaultBranch}`]),
          ]);
          if (head.code !== 0 || latest.code !== 0 || head.stdout.trim() === latest.stdout.trim()) return;
          await gitOk(['-C', w.path, 'reset', '--hard'], { logFile });
          await gitOk(['-C', w.path, 'switch', '--detach', `origin/${repo.defaultBranch}`], { logFile });
          console.log(`[pool] ${w.id} を origin/${repo.defaultBranch} の最新に合わせました`);
        });
      });
    }
  }

  /** worktree を(作り直しも含めて)作成し、ウォームアップして idle にする */
  private async build(w: WorktreeRow): Promise<void> {
    const repo = this.d.getRepo(w.repoId);
    if (!repo) return;
    const base = baseOf(repo);
    const logFile = this.logFile(w);
    this.set(w, { state: 'creating', progress: 'worktree を作成中', error: null, branch: null, sessionId: null, installHash: null });
    try {
      await this.rt(repo.id).mutex.run(async () => {
        await this.fetch(repo, false, logFile);
        await this.removePath(base, w.path, logFile);
        await gitOk(['-C', base, 'worktree', 'add', '--detach', w.path, `origin/${repo.defaultBranch}`], { logFile });
      });
    } catch (e) {
      this.broken(w, errMsg(e));
      return;
    }
    await this.warm(w);
  }

  /** 依存インストール(+ Unity の Library コピー)→ idle */
  private async warm(w: WorktreeRow): Promise<void> {
    const repo = this.d.getRepo(w.repoId);
    if (!repo) return;
    const logFile = this.logFile(w);
    this.set(w, { state: 'warming', progress: 'ウォームアップ待ち', error: null });
    try {
      await this.rt(repo.id).warm.run(async () => {
        if (this.wts.get(w.id) !== w || w.state !== 'warming') return;
        await this.install(repo, w, logFile);
        const src = repo.seedLibraryFrom;
        if (repo.kind === 'unity' && src) {
          if (!fs.existsSync(src)) throw new Error(`Library のコピー元がありません: ${src}`);
          this.set(w, { progress: 'Library をコピー中' });
          const r = await run('robocopy', [src, path.join(w.path, 'Library'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], {
            timeout: ROBOCOPY_TIMEOUT,
            logFile,
          });
          // robocopy は 0〜7 が成功(8 以上が失敗)
          if (r.code < 0 || r.code >= 8) throw new Error(`robocopy に失敗 (code ${r.code}): ${tail(r)}`);
        }
      });
    } catch (e) {
      this.broken(w, errMsg(e));
      return;
    }
    if (this.wts.get(w.id) !== w || w.state !== 'warming') return;
    this.set(w, { state: 'idle', progress: null, error: null, lastUsedAt: Date.now(), failCount: 0 });
    this.onIdle(w);
  }

  /** 依存インストール。lockfile のハッシュを記録する */
  private async install(repo: RepoInfo, w: WorktreeRow, logFile: string): Promise<void> {
    const cmd = installCommand(repo, w.path);
    const hash = lockHash(w.path);
    // lockfile を持たない Node リポジトリで npm install すると package-lock.json が生成される。
    // セッションが誤ってコミットしないよう、共通の .git/info/exclude に入れておく(全 worktree に効く)
    if (cmd === 'npm install') {
      try {
        const exclude = path.join(repo.baseDir, '.base', '.git', 'info', 'exclude');
        const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        if (!/^\/?package-lock\.json$/m.test(cur)) {
          fs.mkdirSync(path.dirname(exclude), { recursive: true });
          fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# CC Hub: npm install が生成する lockfile\n/package-lock.json\n`);
        }
      } catch {
        /* 除外できなくても致命的ではない */
      }
    }
    if (cmd) {
      this.set(w, { progress: `${cmd} 実行中` });
      const r = await run(cmd, [], { cwd: w.path, shell: true, timeout: INSTALL_TIMEOUT, logFile });
      if (r.code !== 0) throw new Error(`${cmd} に失敗 (code ${r.code}): ${tail(r)}(ログ: ${logFile})`);
    }
    this.set(w, { installHash: hash });
  }

  /** パスに登録済みの worktree / 残骸ディレクトリがあれば消す(ミューテックス内で呼ぶ) */
  private async removePath(base: string, p: string, logFile?: string): Promise<void> {
    const listed = await listWorktrees(base);
    if (listed.has(normPath(p))) await git(['-C', base, 'worktree', 'remove', '--force', '--force', p], { logFile });
    if (fs.existsSync(p)) {
      try {
        await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      } catch (e) {
        throw new Error(`ディレクトリを削除できません(ファイルロック?): ${p}: ${errMsg(e)}`);
      }
    }
    await git(['-C', base, 'worktree', 'prune'], { logFile });
    if (fs.existsSync(p)) throw new Error(`ディレクトリを削除できません: ${p}`);
  }

  /** worktree を削除する。失敗したら後でリトライし、3 回続けて失敗したら broken */
  private async destroy(w: WorktreeRow): Promise<void> {
    const repo = this.d.getRepo(w.repoId);
    if (!repo) {
      this.drop(w);
      return;
    }
    this.set(w, { state: 'deleting', progress: '削除中' });
    try {
      await this.rt(repo.id).mutex.run(() => this.removePath(baseOf(repo), w.path, this.logFile(w)));
      this.drop(w);
      console.log(`[pool] ${w.id} を削除しました`);
    } catch (e) {
      const failCount = w.failCount + 1;
      // つかんでいるプログラムが分かれば、理由として先頭に出す
      const lockers = await findLockers(w.path).catch(() => null);
      const msg = lockers?.length ? `${lockerMessage(lockers)} / ${errMsg(e)}` : errMsg(e);
      if (failCount >= DELETE_MAX_FAIL) {
        this.set(w, { failCount });
        this.broken(w, `削除に ${failCount} 回失敗しました: ${msg}`);
      } else {
        this.set(w, { failCount, progress: `削除に失敗(${failCount} 回目)。後でやり直します`, error: msg.slice(0, 500) });
      }
    }
  }

  // ================================================================ 割当
  /** 新しいセッション用に worktree を確保できるか(今すぐ判定できる失敗だけ投げる) */
  checkAvailable(repoId: string): void {
    const repo = this.d.getRepo(repoId);
    if (!repo) throw new HttpError(404, 'リポジトリが見つかりません');
    if (repo.status !== 'ready') throw new HttpError(409, `リポジトリの準備ができていません(${repo.status})`);
    const list = this.forRepo(repoId);
    if (list.some((w) => w.state === 'idle' && !this.busy.has(w.id))) return;
    if (list.some((w) => w.state === 'creating' || w.state === 'warming')) return;
    if (list.length >= repo.poolMax) throw new HttpError(409, `空いている worktree がありません(上限 ${repo.poolMax} 本に達しています)`);
    if (repo.error?.startsWith(DISK_WARN_PREFIX)) throw new HttpError(409, repo.error);
  }

  /**
   * セッションに worktree を割り当て、feat/<slug> ブランチを作る。
   * 待機が無ければ作成を待つ。戻り値の worktree は assigned(sessionId / branch 設定済み)。
   */
  async acquire(
    repoId: string,
    sessionId: string,
    slug: string,
    onProgress: (text: string) => void,
    /** 指定するとブランチ作成の代わりに呼ぶ(ミューテックス内・fetch 済み)。戻り値 = チェックアウトしたブランチ名(PR の checkout 用) */
    setup?: (wt: WorktreeRow, logFile: string) => Promise<string>,
  ): Promise<WorktreeRow> {
    const repo = this.d.getRepo(repoId);
    if (!repo) throw new HttpError(404, 'リポジトリが見つかりません');
    const rt = this.rt(repoId);
    let w = this.forRepo(repoId).find((x) => x.state === 'idle' && !this.busy.has(x.id));
    if (w) {
      this.set(w, { state: 'assigned', sessionId, branch: null, progress: '割り当て中', lastUsedAt: Date.now(), git: null });
      this.kick(repoId); // すぐに補充
    } else {
      onProgress('待機中の worktree が無いので、作成を待っています…');
      w = await new Promise<WorktreeRow>((resolve, reject) => {
        rt.waiters.push({ sessionId, resolve, reject });
        this.kick(repoId);
      });
    }
    const wt = w;
    this.busy.add(wt.id);
    try {
      onProgress(`${wt.name} を割り当てました。ブランチを${setup ? '準備' : '作成'}しています…`);
      const branch = await rt.mutex.run(async () => {
        await this.fetch(repo, true, this.logFile(wt));
        if (setup) return setup(wt, this.logFile(wt));
        const b = await uniqueBranch(baseOf(repo), `feat/${slug}`);
        // --no-track: origin/<default> を upstream にしない(push 状況の判定と git push の既定動作のため)
        await gitOk(['-C', wt.path, 'switch', '--no-track', '-c', b, `origin/${repo.defaultBranch}`], { logFile: this.logFile(wt) });
        return b;
      });
      this.set(wt, { branch, progress: null });
      // 依存ファイルが変わっていたら(または未インストールなら)入れ直す
      const cmd = installCommand(repo, wt.path);
      if (cmd && lockHash(wt.path) !== wt.installHash) {
        onProgress(`依存ファイルが変わっているので再インストールします: ${cmd}`);
        await this.install(repo, wt, this.logFile(wt));
        this.set(wt, { progress: null });
      }
      this.set(wt, { lastUsedAt: Date.now() });
      return wt;
    } catch (e) {
      // 失敗したら初期化してプールに戻す
      const msg = errMsg(e);
      console.error(`[pool] ${wt.id} の割り当てに失敗: ${msg}`);
      void this.doRelease(wt, 'discard').catch(() => undefined);
      throw new HttpError(500, `worktree の準備に失敗しました: ${msg}`);
    } finally {
      this.busy.delete(wt.id);
    }
  }

  /** idle になった worktree を待っているセッションに渡す */
  private onIdle(w: WorktreeRow): void {
    const rt = this.rt(w.repoId);
    const waiter = rt.waiters.shift();
    if (waiter) {
      this.set(w, { state: 'assigned', sessionId: waiter.sessionId, branch: null, progress: '割り当て中', lastUsedAt: Date.now(), git: null });
      waiter.resolve(w);
    }
    this.kick(w.repoId);
  }

  // ================================================================ 解放
  /** セッション終了後に初期化してプールに戻す(keep = ブランチを残す / discard = ブランチを削除) */
  async release(id: string, mode: ReleaseMode, sessionId: string): Promise<WorktreeRow> {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    if (w.state !== 'assigned' || w.sessionId !== sessionId) throw new HttpError(409, 'この worktree は既に解放されています');
    if (this.busy.has(w.id)) throw new HttpError(409, 'worktree は処理中です');
    this.busy.add(w.id);
    try {
      await this.doRelease(w, mode);
    } finally {
      this.busy.delete(w.id);
      this.kick(w.repoId);
    }
    if ((w.state as WorktreeState) === 'broken') throw new HttpError(500, `初期化に失敗しました: ${w.error ?? ''}`);
    return w;
  }

  /** 初期化: reset --hard → clean -fdx(keepDirs は残す)→ fetch → switch --detach origin/<base> →(discard なら branch -D)→ idle */
  private async doRelease(w: WorktreeRow, mode: ReleaseMode): Promise<void> {
    const repo = this.d.getRepo(w.repoId);
    if (!repo) return;
    const branch = w.branch;
    const logFile = this.logFile(w);
    this.set(w, { state: 'releasing', progress: '初期化中', error: null });
    try {
      await gitOk(['-C', w.path, 'reset', '--hard'], { logFile });
      const ex = repo.keepDirs.filter(Boolean).flatMap((k) => ['-e', k]);
      await gitOk(['-C', w.path, 'clean', '-fdx', ...ex], { logFile });
      await this.rt(repo.id).mutex.run(async () => {
        await this.fetch(repo, true, logFile);
        await gitOk(['-C', w.path, 'switch', '--detach', `origin/${repo.defaultBranch}`], { logFile });
        if (mode === 'discard' && branch) {
          const r = await git(['-C', baseOf(repo), 'branch', '-D', branch], { logFile });
          if (r.code !== 0) console.warn(`[pool] ${w.id}: ブランチ ${branch} の削除に失敗: ${tail(r)}`);
        }
      });
    } catch (e) {
      this.set(w, { sessionId: null });
      this.broken(w, errMsg(e));
      return;
    }
    console.log(`[pool] ${w.id} を解放しました (${mode}${branch ? `, ${branch}` : ''})`);
    this.set(w, { state: 'idle', progress: null, error: null, branch: null, sessionId: null, lastUsedAt: Date.now() });
    this.onIdle(w);
  }

  // ================================================================ 個別操作(UI)
  /** broken などを作り直す */
  rebuild(id: string): void {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    if (w.state === 'assigned') throw new HttpError(409, '使用中の worktree は作り直せません。先に解放してください');
    if (this.busy.has(w.id)) throw new HttpError(409, 'worktree は処理中です');
    void this.task(w, () => this.build(w));
  }

  /**
   * worktree を削除する: 待機中 / broken / 割り当て済み(セッションが止まっている)。使用中は 409。
   * 割り当て済みのものはブランチを残す(worktree remove はブランチを消さない)。戻り値 = 割り当てていたセッション(解放済みにする)
   */
  async remove(id: string): Promise<string | null> {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    if (this.isInUse(w)) throw new HttpError(409, w.state === 'assigned' ? IN_USE_DELETE_MSG : `準備・初期化の途中(${w.state})なので削除できません`);
    if (w.state !== 'idle' && w.state !== 'broken' && w.state !== 'assigned') {
      throw new HttpError(409, `この状態(${w.state})の worktree は削除できません`);
    }
    if (this.busy.has(w.id)) throw new HttpError(409, 'worktree は処理中です');
    // Unity などがフォルダを開いたままだと消し切れずに壊れた状態になるので、先に止める
    const lockers = await findLockers(w.path);
    if (lockers?.length) throw new HttpError(409, lockerMessage(lockers));
    const sessionId = w.state === 'assigned' ? w.sessionId : null;
    if (w.state === 'assigned') {
      console.log(`[pool] ${w.id} を削除します(割り当て先のセッションは停止中${w.branch ? `、ブランチ ${w.branch} は残す` : ''})`);
      // セッションとの紐付けを外す(解放と同じ扱い。削除に失敗して broken になっても、セッションは解放済みになる)
      this.set(w, { sessionId: null, branch: null, git: null });
    }
    await this.task(w, () => this.destroy(w));
    if (this.wts.has(id)) throw new HttpError(500, `削除に失敗しました: ${w.error ?? ''}`);
    return sessionId;
  }

  // ================================================================ rebase(UI)
  /**
   * 最新の origin/<default> を取り込む。使用中は 409。
   * - 待機中(detached): fetch して switch --detach origin/<default>
   * - 割り当て済み(セッション停止中): 未コミットの変更があれば 409。git rebase origin/<default>。衝突・失敗したら --abort で元に戻す
   */
  async rebase(id: string): Promise<RebaseResult> {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    if (this.isInUse(w)) throw new HttpError(409, w.state === 'assigned' ? IN_USE_REBASE_MSG : `準備・初期化の途中(${w.state})なので rebase できません`);
    if (w.state !== 'idle' && w.state !== 'assigned') throw new HttpError(409, `この状態(${w.state})の worktree は rebase できません`);
    if (this.busy.has(w.id)) throw new HttpError(409, 'worktree は処理中です');
    const repo = this.d.getRepo(w.repoId);
    if (!repo) throw new HttpError(404, 'リポジトリが見つかりません');
    const base = `origin/${repo.defaultBranch}`;
    const logFile = this.logFile(w);
    const head = async () => {
      const r = await git(['-C', w.path, 'rev-parse', 'HEAD']);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    this.busy.add(w.id);
    let result: RebaseResult;
    try {
      result = await this.rt(repo.id).mutex.run(async (): Promise<RebaseResult> => {
        // ミューテックスを待つ間にセッションが再開されていないか
        if (this.isInUse(w)) throw new HttpError(409, IN_USE_REBASE_MSG);
        try {
          await this.fetch(repo, true, logFile);
        } catch (e) {
          throw new HttpError(502, `git fetch に失敗しました: ${errMsg(e)}`);
        }
        const before = await head();
        const behind = parseCount((await git(['-C', w.path, 'rev-list', '--count', `HEAD..${base}`])).stdout);
        if (w.state === 'idle') {
          const latest = await git(['-C', w.path, 'rev-parse', base]);
          if (latest.code === 0 && latest.stdout.trim() === before) {
            return { result: 'up_to_date', conflicts: [], before, after: before, pulled: 0, message: `既に ${base} の最新です` };
          }
          // 待機中は作業内容を持たない(解放時に初期化済み)ので、そのまま最新に付け替える
          await gitOk(['-C', w.path, 'reset', '--hard'], { logFile });
          await gitOk(['-C', w.path, 'switch', '--detach', base], { logFile });
          return { result: 'rebased', conflicts: [], before, after: await head(), pulled: behind, message: `${base} の最新に合わせました` };
        }
        // 割り当て済み: 未コミットの変更があれば何もしない(stash はしない)
        const st = await git(['-C', w.path, 'status', '--porcelain']);
        if (st.code !== 0) throw new HttpError(500, `git status に失敗しました: ${tail(st)}`);
        if (st.stdout.trim()) throw new HttpError(409, DIRTY_MSG);
        for (const name of ['rebase-merge', 'rebase-apply']) {
          const gp = await git(['-C', w.path, 'rev-parse', '--git-path', name]);
          if (gp.code === 0 && fs.existsSync(path.resolve(w.path, gp.stdout.trim()))) {
            throw new HttpError(409, 'rebase の途中の状態です。git rebase --continue / --abort で終わらせてから実行してください');
          }
        }
        if (behind === 0) return { result: 'up_to_date', conflicts: [], before, after: before, pulled: 0, message: `既に ${base} の最新を取り込んでいます` };
        const r = await git(['-C', w.path, 'rebase', base], { logFile, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
        let conflicts: string[] = [];
        if (r.code !== 0) {
          conflicts = parseConflictFiles((await git(['-C', w.path, 'diff', '--name-only', '--diff-filter=U'])).stdout);
          const ab = await git(['-C', w.path, 'rebase', '--abort'], { logFile });
          if (ab.code !== 0) console.warn(`[pool] ${w.id}: rebase --abort に失敗: ${tail(ab)}`);
        }
        const c = classifyRebase(r, conflicts, base);
        return { ...c, before, after: await head(), pulled: c.result === 'rebased' ? behind : 0 };
      });
    } finally {
      this.busy.delete(w.id);
    }
    console.log(`[pool] rebase ${w.name} (${w.id}): ${result.result}${result.conflicts.length ? ` [${result.conflicts.join(', ')}]` : ''}${result.result === 'failed' ? ` ${result.message}` : ''}`);
    // 配信し直す(待機中の HEAD が変わった / 割り当て済みの変更状況は呼ぶ側で更新する)
    this.set(w, {});
    return result;
  }

  /** リポジトリの登録解除: 補充を止めて全 worktree を削除する(使用中があれば呼ぶ側で 409) */
  async removeRepo(repoId: string): Promise<void> {
    const rt = this.rt(repoId);
    rt.removed = true;
    for (const wt of rt.waiters.splice(0)) wt.reject(new HttpError(409, 'リポジトリが登録解除されました'));
    const list = this.forRepo(repoId);
    // 作業中のものが終わるのを少し待つ
    for (let i = 0; i < 600 && list.some((w) => this.busy.has(w.id)); i++) await new Promise((r) => setTimeout(r, 500));
    for (const w of list) {
      if (!this.wts.has(w.id)) continue;
      this.busy.add(w.id);
      try {
        for (let i = 0; i < DELETE_MAX_FAIL && this.wts.has(w.id); i++) await this.destroy(w);
      } finally {
        this.busy.delete(w.id);
      }
    }
    const left = this.forRepo(repoId);
    if (left.length) {
      rt.removed = false;
      throw new HttpError(500, `削除できない worktree があります: ${left.map((w) => w.name).join(', ')}`);
    }
    this.rts.delete(repoId);
  }

  /** 使用中(assigned)の worktree */
  inUse(repoId: string): WorktreeRow[] {
    return this.forRepo(repoId).filter((w) => w.state === 'assigned');
  }
}

/** git worktree list --porcelain のパス集合(正規化済み) */
async function listWorktrees(base: string): Promise<Set<string>> {
  const r = await git(['-C', base, 'worktree', 'list', '--porcelain']);
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) out.add(normPath(line.slice(9).trim()));
  }
  return out;
}

/** 既存のローカル / リモートブランチと被らない名前(-2, -3 …を付ける) */
async function uniqueBranch(base: string, name: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const b = i === 1 ? name : `${name}-${i}`;
    const local = await git(['-C', base, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`]);
    const remote = await git(['-C', base, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]);
    if (local.code !== 0 && remote.code !== 0) return b;
  }
  return `${name}-${crypto.randomBytes(3).toString('hex')}`;
}
