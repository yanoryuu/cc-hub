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
import type { ReleaseMode, RepoInfo, WorktreeInfo, WorktreeState } from '@cc-hub/shared';
import { bus } from '../bus';
import type { HubConfig } from '../config';
import type { Store, WorktreeRow } from '../store/db';
import { HttpError } from '../util';
import { Mutex, Semaphore, freeDiskGB, git, gitOk, normPath, run, tail } from './exec';
import { installCommand, lockHash } from './kind';

const RECONCILE_MS = 30_000;
const FETCH_FRESH_MS = 30_000;
const INSTALL_TIMEOUT = 30 * 60_000;
const ROBOCOPY_TIMEOUT = 2 * 3600_000;
const DELETE_MAX_FAIL = 3;
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
    return { ...info };
  }

  private rt(repoId: string): RepoRuntime {
    let r = this.rts.get(repoId);
    if (!r) {
      r = { mutex: new Mutex(), warm: new Semaphore(1), waiters: [], reconciling: false, again: false, removed: false, lastFetch: 0 };
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

    const isReady = (s: WorktreeState) => s === 'creating' || s === 'warming' || s === 'idle';
    const ready = list.filter((w) => isReady(w.state)).length;
    const need = repo.poolMin + rt.waiters.length;
    let toCreate = Math.min(need - ready, repo.poolMax - list.length);

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
        console.log(`[pool] ${repoId}: 余剰の ${w.name} を削除します`);
        void this.task(w, () => this.destroy(w));
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
  private async fetch(repo: RepoInfo, force: boolean, logFile?: string): Promise<void> {
    const rt = this.rt(repo.id);
    if (!force && Date.now() - rt.lastFetch < FETCH_FRESH_MS) return;
    await gitOk(['-C', baseOf(repo), 'fetch', 'origin', '--prune'], { logFile, timeout: 5 * 60_000 });
    rt.lastFetch = Date.now();
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
      if (failCount >= DELETE_MAX_FAIL) {
        this.set(w, { failCount });
        this.broken(w, `削除に ${failCount} 回失敗しました: ${errMsg(e)}`);
      } else {
        this.set(w, { failCount, progress: `削除に失敗(${failCount} 回目)。後でやり直します`, error: errMsg(e).slice(0, 500) });
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
  async acquire(repoId: string, sessionId: string, slug: string, onProgress: (text: string) => void): Promise<WorktreeRow> {
    const repo = this.d.getRepo(repoId);
    if (!repo) throw new HttpError(404, 'リポジトリが見つかりません');
    const rt = this.rt(repoId);
    let w = this.forRepo(repoId).find((x) => x.state === 'idle' && !this.busy.has(x.id));
    if (w) {
      this.set(w, { state: 'assigned', sessionId, branch: null, progress: '割り当て中', lastUsedAt: Date.now() });
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
      onProgress(`${wt.name} を割り当てました。ブランチを作成しています…`);
      const branch = await rt.mutex.run(async () => {
        await this.fetch(repo, true, this.logFile(wt));
        const b = await uniqueBranch(baseOf(repo), `feat/${slug}`);
        await gitOk(['-C', wt.path, 'switch', '-c', b, `origin/${repo.defaultBranch}`], { logFile: this.logFile(wt) });
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
      this.set(w, { state: 'assigned', sessionId: waiter.sessionId, branch: null, progress: '割り当て中', lastUsedAt: Date.now() });
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

  /** 待機中 / broken の worktree を削除する */
  async remove(id: string): Promise<void> {
    const w = this.wts.get(id);
    if (!w) throw new HttpError(404, 'worktree が見つかりません');
    if (w.state !== 'idle' && w.state !== 'broken' && w.state !== 'deleting') {
      throw new HttpError(409, `この状態(${w.state})の worktree は削除できません`);
    }
    if (this.busy.has(w.id)) throw new HttpError(409, 'worktree は処理中です');
    await this.task(w, () => this.destroy(w));
    if (this.wts.has(id)) throw new HttpError(500, `削除に失敗しました: ${w.error ?? ''}`);
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
