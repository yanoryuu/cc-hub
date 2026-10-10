// RepoManager: リポジトリの登録(gh repo clone)・設定変更・登録解除と、worktree でのセッション起動 / 解放(design §7)。
import fs from 'node:fs';
import path from 'node:path';
import type { RegisterRepoRequest, ReleaseMode, RepoInfo, RepoKind, SessionInfo, StartSessionRequest, WorktreeInfo } from '@cc-hub/shared';
import { bus } from '../bus';
import type { HubConfig } from '../config';
import type { Store } from '../store/db';
import type { SessionManager } from '../session/manager';
import { HttpError, clampInt } from '../util';
import { git, gitOk, normPath, tail } from './exec';
import { ghRun } from '../github/gh';
import { defaultKeepDirs, detectKind } from './kind';
import { WorktreePool, baseOf, DISK_WARN_PREFIX } from './pool';
import { generateSlug, sanitizeSlug } from './slug';

const CLONE_TIMEOUT = 60 * 60_000;
const GH_TIMEOUT = 30_000;

/** https / git@ / ssh:// / "owner/name" を {owner, name} にする。不正なら null */
export function normalizeRepoUrl(input: string): { owner: string; name: string } | null {
  const s = String(input ?? '').trim();
  const pats = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^(?:github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
  ];
  for (const re of pats) {
    const m = re.exec(s);
    if (!m) continue;
    const owner = m[1];
    const name = m[2];
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null;
    return { owner, name };
  }
  return null;
}

export class RepoManager {
  private readonly repos = new Map<string, RepoInfo>();
  /** 登録処理中の ID(二重登録防止) */
  private readonly registering = new Set<string>();
  readonly pool: WorktreePool;

  constructor(
    private readonly cfg: HubConfig,
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly sessions: SessionManager,
  ) {
    for (const r of store.loadRepos()) this.repos.set(r.id, r);
    this.pool = new WorktreePool({
      cfg,
      store,
      dataDir,
      getRepo: (id) => this.repos.get(id),
      setRepoError: (id, error) => {
        const r = this.repos.get(id);
        if (r && r.error !== error) this.update(r, { error });
      },
      sessionExists: (id) => !!sessions.info(id),
    });
    sessions.setRepoHooks({
      isTrustedPath: (cwd) => {
        const w = this.pool.byPath(cwd);
        return !!w && !!this.repos.get(w.repoId)?.trusted;
      },
      holdsWorktree: (info) => {
        if (!info.worktreeId) return false;
        const w = this.pool.get(info.worktreeId);
        return !!w && w.sessionId === info.id && w.state === 'assigned';
      },
    });
  }

  // ================================================================ 状態
  all(): Record<string, RepoInfo> {
    const out: Record<string, RepoInfo> = {};
    for (const [id, r] of this.repos) out[id] = { ...r, keepDirs: [...r.keepDirs] };
    return out;
  }

  list(): { repos: RepoInfo[]; worktrees: WorktreeInfo[] } {
    return { repos: Object.values(this.all()), worktrees: this.pool.list() };
  }

  /** ID(大文字小文字は区別しない)でリポジトリを引く。無ければ 404 */
  require(id: string): RepoInfo {
    const r = this.repos.get(id) ?? [...this.repos.values()].find((x) => x.id.toLowerCase() === String(id).toLowerCase());
    if (!r) throw new HttpError(404, 'リポジトリが見つかりません');
    return r;
  }

  private update(r: RepoInfo, patch: Partial<RepoInfo>): void {
    Object.assign(r, patch);
    if (this.repos.get(r.id) !== r) return;
    this.store.saveRepo(r);
    bus.state({ t: 'repo.upsert', repo: { ...r, keepDirs: [...r.keepDirs] } });
  }

  private logFile(r: RepoInfo): string {
    return path.join(this.dataDir, 'worktree-logs', `${r.id.replace(/[\\/]/g, '__')}_base.log`);
  }

  // ================================================================ 起動
  /** デーモン起動時: クローン途中だったものはやり直し、ready のものは DB とディスクを突き合わせる */
  init(): void {
    for (const r of this.repos.values()) {
      if (r.status === 'cloning') void this.clone(r);
      else if (r.status === 'ready') this.pool.recover(r.id).catch((e) => console.error(`[repo] recover ${r.id}`, e));
    }
    this.pool.start();
  }

  stop(): void {
    this.pool.stop();
  }

  // ================================================================ 登録
  async register(req: RegisterRepoRequest): Promise<RepoInfo> {
    const parsed = normalizeRepoUrl(req?.url);
    if (!parsed) throw new HttpError(400, 'GitHub のリポジトリ URL(https / git@ / owner/name)を指定してください');
    if (req.trusted !== true) throw new HttpError(400, 'リポジトリを信頼することの確認(trusted: true)が必要です');
    let id = `${parsed.owner}/${parsed.name}`;
    const dup = () => [...this.repos.keys(), ...this.registering].find((x) => x.toLowerCase() === id.toLowerCase());
    if (dup()) throw new HttpError(409, `既に登録されています: ${dup()}`);
    const key = id;
    this.registering.add(key);
    try {
      // 存在確認 + 正式な名前と既定ブランチ
      const view = await ghRun(['repo', 'view', id, '--json', 'nameWithOwner,defaultBranchRef,url'], { timeout: GH_TIMEOUT });
      if (view.code !== 0) throw new HttpError(400, `リポジトリを取得できません: ${tail(view, 200)}`);
      let defaultBranch = 'main';
      let url = `https://github.com/${id}`;
      try {
        const j = JSON.parse(view.stdout);
        if (typeof j.nameWithOwner === 'string' && j.nameWithOwner.includes('/')) id = j.nameWithOwner;
        if (j.defaultBranchRef?.name) defaultBranch = String(j.defaultBranchRef.name);
        if (typeof j.url === 'string') url = j.url;
      } catch {
        /* 既定値のまま */
      }
      if (this.repos.has(id)) throw new HttpError(409, `既に登録されています: ${id}`);
      const [owner, name] = id.split('/');
      // クローン前に Unity かどうかを判定する(置き場所のドライブが変わるため)
      const unity = await ghRun(['api', `repos/${id}/contents/ProjectSettings/ProjectVersion.txt`, '--silent'], { timeout: GH_TIMEOUT });
      const kind: RepoKind = unity.code === 0 ? 'unity' : 'other';
      const root = kind === 'unity' ? this.cfg.worktreeRoots.unity : this.cfg.worktreeRoots.default;
      let baseDir = path.join(root, name);
      if ([...this.repos.values()].some((r) => normPath(r.baseDir) === normPath(baseDir))) baseDir = path.join(root, `${owner}-${name}`);
      const poolMax = this.cfg.defaultPoolMax;
      const repo: RepoInfo = {
        id,
        url,
        owner,
        name,
        baseDir,
        defaultBranch,
        kind,
        installCmd: null,
        keepDirs: defaultKeepDirs(kind),
        seedLibraryFrom: null,
        poolMin: clampInt(req.poolMin ?? this.cfg.defaultPoolMin, 0, poolMax),
        poolMax,
        trusted: true,
        status: 'cloning',
        error: null,
        createdAt: Date.now(),
      };
      this.repos.set(id, repo);
      this.update(repo, {});
      console.log(`[repo] 登録: ${id} (${kind}) → ${baseDir}`);
      void this.clone(repo);
      return { ...repo };
    } finally {
      this.registering.delete(key);
    }
  }

  /** gh repo clone(既に同じリポジトリのクローンがあれば取り込む)→ 種別判定 → ready → プール作成 */
  private async clone(repo: RepoInfo): Promise<void> {
    const base = baseOf(repo);
    const logFile = this.logFile(repo);
    this.update(repo, { status: 'cloning', error: null });
    try {
      let adopt = false;
      if (fs.existsSync(base)) {
        const r = await git(['-C', base, 'remote', 'get-url', 'origin']);
        const o = r.code === 0 ? normalizeRepoUrl(r.stdout.trim()) : null;
        const same = !!o && `${o.owner}/${o.name}`.toLowerCase() === repo.id.toLowerCase();
        if (!same) throw new Error(`既存のディレクトリが別のリポジトリです: ${base}`);
        const head = await git(['-C', base, 'rev-parse', '--verify', 'HEAD']);
        if (head.code === 0) adopt = true;
        else {
          // 途中で止まったクローン → 消してやり直す
          await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 3 });
        }
      }
      if (adopt) {
        console.log(`[repo] 既存のクローンを使います: ${base}`);
        await gitOk(['-C', base, 'fetch', 'origin', '--prune'], { logFile });
      } else {
        fs.mkdirSync(repo.baseDir, { recursive: true });
        const r = await ghRun(['repo', 'clone', repo.id, base, '--', '-c', 'core.longpaths=true'], { timeout: CLONE_TIMEOUT, logFile });
        if (r.code !== 0) throw new Error(`gh repo clone に失敗しました: ${tail(r)}`);
      }
      await gitOk(['-C', base, 'config', 'core.longpaths', 'true']);
      // 既定ブランチ(登録時に取れなかった場合の保険)
      if (!repo.defaultBranch) {
        const r = await git(['-C', base, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        repo.defaultBranch = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : 'main';
      }
      const v = await git(['-C', base, 'rev-parse', '--verify', `origin/${repo.defaultBranch}`]);
      if (v.code !== 0) throw new Error(`origin/${repo.defaultBranch} が見つかりません`);
      // クローン後のファイルで種別を確定(Unity 判定はクローン前の結果を優先)
      const kind = repo.kind === 'unity' ? 'unity' : detectKind(base);
      const patch: Partial<RepoInfo> = { status: 'ready', error: null, kind };
      if (kind !== repo.kind) patch.keepDirs = defaultKeepDirs(kind);
      this.update(repo, patch);
      console.log(`[repo] ${repo.id} の準備ができました (${kind}, ${repo.defaultBranch})`);
      await this.pool.recover(repo.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[repo] ${repo.id} のクローンに失敗: ${msg}`);
      this.update(repo, { status: 'error', error: msg.slice(0, 500) });
    }
  }

  // ================================================================ 設定変更・登録解除・補充
  patch(id: string, body: any): RepoInfo {
    const r = this.require(id);
    const p: Partial<RepoInfo> = {};
    if (!body || typeof body !== 'object') throw new HttpError(400, 'bad request');
    if (body.poolMax !== undefined) p.poolMax = clampInt(body.poolMax, 1, 50);
    const max = p.poolMax ?? r.poolMax;
    if (body.poolMin !== undefined) p.poolMin = clampInt(body.poolMin, 0, max);
    else if (r.poolMin > max) p.poolMin = max;
    if (body.installCmd !== undefined) p.installCmd = body.installCmd === null ? null : String(body.installCmd).slice(0, 1000);
    if (body.keepDirs !== undefined) {
      if (!Array.isArray(body.keepDirs)) throw new HttpError(400, 'keepDirs は配列で指定してください');
      p.keepDirs = body.keepDirs.map((x: unknown) => String(x).trim()).filter((x: string) => x && !/^[-]/.test(x)).slice(0, 20);
    }
    if (body.seedLibraryFrom !== undefined) {
      p.seedLibraryFrom = body.seedLibraryFrom === null || body.seedLibraryFrom === '' ? null : String(body.seedLibraryFrom);
    }
    if (body.trusted !== undefined) p.trusted = body.trusted === true;
    this.update(r, p);
    this.pool.kick(r.id);
    return { ...r };
  }

  async remove(id: string, purge: boolean): Promise<void> {
    const r = this.require(id);
    const used = this.pool.inUse(r.id);
    if (used.length) throw new HttpError(409, `使用中の worktree があります: ${used.map((w) => w.name).join(', ')}`);
    if (r.status === 'cloning') throw new HttpError(409, 'クローン中です。完了してから登録解除してください');
    await this.pool.removeRepo(r.id);
    this.repos.delete(r.id);
    this.store.deleteRepo(r.id);
    bus.state({ t: 'repo.remove', id: r.id });
    console.log(`[repo] 登録解除: ${r.id}${purge ? '(.base も削除)' : ''}`);
    if (purge) {
      try {
        await fs.promises.rm(baseOf(r), { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        if (fs.existsSync(r.baseDir) && fs.readdirSync(r.baseDir).length === 0) fs.rmdirSync(r.baseDir);
      } catch (e) {
        throw new HttpError(500, `.base の削除に失敗しました: ${(e as Error).message}`);
      }
    }
  }

  /** 補充を即時実行。エラーのリポジトリはクローンからやり直す */
  refill(id: string): RepoInfo {
    const r = this.require(id);
    if (r.status === 'error') {
      void this.clone(r);
    } else {
      if (r.error?.startsWith(DISK_WARN_PREFIX)) this.update(r, { error: null });
      this.pool.kick(r.id);
    }
    return { ...r };
  }

  // ================================================================ セッション
  /**
   * repoId 指定のセッション起動。セッションはすぐ返し(starting)、slug 生成・worktree 割当・ブランチ作成は裏で行う。
   * 上限に達しているなど、すぐ判定できる失敗だけ例外にする。
   */
  startSession(req: StartSessionRequest): SessionInfo {
    const repo = this.require(String(req.repoId));
    if (repo.status !== 'ready') throw new HttpError(409, `リポジトリの準備ができていません(${repo.status})`);
    if (req.resume) throw new HttpError(400, 'repoId と resume は同時に指定できません');
    this.pool.checkAvailable(repo.id);
    const userSlug = req.branchSlug ? sanitizeSlug(req.branchSlug) : '';
    const name = String(req.name || '').trim();
    const info = this.sessions.createPending({
      name: name || userSlug || repo.name,
      mode: req.mode === 'commander' ? 'commander' : 'plain',
      repoId: repo.id,
      cwd: repo.baseDir,
      task: req.instruction,
    });
    void this.prepare(info.id, repo, req, userSlug, !name);
    return info;
  }

  private async prepare(sid: string, repo: RepoInfo, req: StartSessionRequest, userSlug: string, nameFromSlug: boolean): Promise<void> {
    try {
      let slug = userSlug;
      if (!slug) {
        this.sessions.progress(sid, 'ブランチ名を生成しています…');
        const g = await generateSlug(String(req.instruction ?? ''), this.cfg.claudePath);
        slug = g.slug;
        console.log(`[repo] slug: ${slug} (${g.source})`);
      }
      if (nameFromSlug) this.sessions.setPendingName(sid, slug);
      const wt = await this.pool.acquire(repo.id, sid, slug, (t) => this.sessions.progress(sid, t));
      this.sessions.bindWorktree(sid, wt.id, wt.path, wt.branch);
      this.sessions.launchPending(sid, { cwd: wt.path, worktreeId: wt.id, branch: wt.branch, instruction: req.instruction });
      console.log(`[repo] セッション開始: ${repo.id} ${wt.name} ${wt.branch}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[repo] セッションの準備に失敗: ${msg}`);
      this.sessions.failPending(sid, msg);
    }
  }

  // ================================================================ フェーズ 3: PR のブランチでセッション
  /**
   * プールの worktree を割り当て、worktree 内で gh pr checkout N してから claude を起動する。
   * instruction は起動時のプロンプト(commander なら前置きが付く)。長い指示は worktree 内のファイルに書いて参照させる
   */
  startPrSession(o: { repoId: string; number: number; headRefName: string; mode?: string; instruction?: string; name?: string }): SessionInfo {
    const repo = this.require(o.repoId);
    if (repo.status !== 'ready') throw new HttpError(409, `リポジトリの準備ができていません(${repo.status})`);
    this.pool.checkAvailable(repo.id);
    const info = this.sessions.createPending({
      name: String(o.name || '').trim() || `PR #${o.number}`,
      mode: o.mode === 'commander' ? 'commander' : 'plain',
      repoId: repo.id,
      cwd: repo.baseDir,
      task: o.instruction,
    });
    void this.preparePr(info.id, repo, o);
    return info;
  }

  private async preparePr(sid: string, repo: RepoInfo, o: { number: number; headRefName: string; instruction?: string }): Promise<void> {
    try {
      const wt = await this.pool.acquire(repo.id, sid, '', (t) => this.sessions.progress(sid, t), async (w, logFile) => {
        this.sessions.progress(sid, `gh pr checkout ${o.number} を実行しています…`);
        console.log(`[repo] gh pr checkout ${o.number} --repo ${repo.id} (${w.path})`);
        const r = await ghRun(['pr', 'checkout', String(o.number), '--repo', repo.id], { cwd: w.path, logFile, timeout: 5 * 60_000 });
        if (r.code !== 0) throw new Error(`gh pr checkout に失敗しました: ${tail(r)}`);
        const b = (await gitOk(['-C', w.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        return b && b !== 'HEAD' ? b : o.headRefName;
      });
      this.sessions.bindWorktree(sid, wt.id, wt.path, wt.branch);
      const instruction = o.instruction ? deliverInstruction(repo, wt.path, `pr-${o.number}`, o.instruction) : undefined;
      this.sessions.launchPending(sid, { cwd: wt.path, worktreeId: wt.id, branch: wt.branch, instruction });
      console.log(`[repo] PR セッション開始: ${repo.id} #${o.number} ${wt.name} ${wt.branch}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[repo] PR セッションの準備に失敗: ${msg}`);
      this.sessions.failPending(sid, msg);
    }
  }

  /** セッション停止後、worktree を初期化してプールに戻す */
  async release(sessionId: string, mode: ReleaseMode): Promise<WorktreeInfo> {
    if (mode !== 'keep' && mode !== 'discard') throw new HttpError(400, "mode は 'keep' か 'discard' です");
    const info = this.sessions.info(sessionId);
    if (!info) throw new HttpError(404, 'セッションが見つかりません');
    if (!info.worktreeId) throw new HttpError(400, 'worktree で動いているセッションではありません');
    if (this.sessions.isHandedOffLive(sessionId)) {
      throw new HttpError(409, 'PowerShell のウィンドウで動作中です。claude を終了するか、CC Hub に戻して停止してから解放してください');
    }
    if (this.sessions.isRunning(sessionId)) throw new HttpError(409, 'セッションが実行中です。先に停止してください');
    const w = await this.pool.release(info.worktreeId, mode, sessionId);
    this.sessions.markReleased(sessionId, mode);
    const { installHash: _h, failCount: _f, ...pub } = w;
    // 変更状況は assigned の間だけ見せる(契約どおり。解放後に古い数字を返さない)
    return { ...pub, git: null };
  }

  // ================================================================ worktree 個別操作
  rebuildWorktree(id: string): void {
    this.pool.rebuild(id);
  }

  async removeWorktree(id: string): Promise<void> {
    await this.pool.remove(id);
  }
}

/** これより長い指示は PTY に直接打ち込まず、worktree 内のファイルに書いて読ませる */
export const INLINE_MAX = 2000;

/**
 * 指示文を送れる形にする。短ければそのまま(改行は空白に)、長ければ <worktree>\.cc-hub\<tag>.md に書いて
 * 「このファイルを読んで従って」という短い指示を返す。.cc-hub は .git/info/exclude に入れてコミットされないようにする
 * (解放時の git clean -fdx で消える)
 */
export function deliverInstruction(repo: RepoInfo, wtPath: string, tag: string, text: string): string {
  if (text.length <= INLINE_MAX) return text.replace(/\r?\n+/g, ' ');
  const dir = path.join(wtPath, '.cc-hub');
  const file = path.join(dir, `${tag.replace(/[^\w.-]/g, '_')}-${Date.now()}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  try {
    const exclude = path.join(baseOf(repo), '.git', 'info', 'exclude');
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!/^\/?\.cc-hub\/?$/m.test(cur)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# CC Hub: セッションへの指示ファイル\n/.cc-hub/\n`);
    }
  } catch {
    /* 除外できなくても致命的ではない */
  }
  const first = text.split(/\r?\n/)[0].slice(0, 200);
  return `${first} 詳細(レビューコメント・失敗ログ)はファイル ${file} に書きました。まずこのファイルを読み、その指示に従って作業してください(このファイル自体はコミットしないこと)。`;
}
