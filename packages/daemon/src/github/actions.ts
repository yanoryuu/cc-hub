// PR まわりの操作(F5-3): 詳細取得 / PR 作成の指示 / 「直して」/ PR から新規セッション / マージ / クローズ。
// GitHub を変更する gh 呼び出しは必ず ghMutate を通す(ログ "[gh] <args>")。
import type { MergeMethod, PrComment, PrDetail, PrInfo, RepoInfo, SessionInfo, SessionMode } from '@cc-hub/shared';
import type { RepoManager } from '../repo/manager';
import { deliverInstruction } from '../repo/manager';
import type { SessionManager } from '../session/manager';
import { HttpError } from '../util';
import { tail } from '../repo/exec';
import { ghJson, ghMutate, ghRun } from './gh';
import { PR_VIEW_FIELDS, buildCreatePrInstruction, buildFixInstruction, toPrDetail, toPrInfo, type FixInput } from './pr';
import type { GitHubWatcher } from './watcher';

/** fix の結果。session = 指示を受けた / 起動したセッション */
export interface FixResult {
  ok: true;
  session: SessionInfo;
  action: 'sent' | 'resumed' | 'started';
}

const METHODS = new Set<MergeMethod>(['squash', 'merge', 'rebase']);

/** レビュースレッド(未解決のみ使う) */
const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:30){nodes{author{login} body createdAt url}}}}}}}`;

function isBot(login: string): boolean {
  return /\[bot\]$|^github-actions$|bot$/i.test(login);
}

export class PrActions {
  constructor(
    private readonly repos: RepoManager,
    private readonly sessions: SessionManager,
    private readonly watcher: GitHubWatcher,
  ) {}

  private repo(id: string): RepoInfo {
    return this.repos.require(id);
  }

  private num(n: unknown): number {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, 'PR 番号が不正です');
    return v;
  }

  // ================================================================ 詳細
  async detail(repoId: string, n: unknown): Promise<PrDetail> {
    const repo = this.repo(repoId);
    const num = this.num(n);
    let j: any;
    try {
      j = await ghJson(['pr', 'view', String(num), '--repo', repo.id, '--json', PR_VIEW_FIELDS]);
    } catch (e) {
      throw new HttpError((e as any).kind === 'notfound' ? 404 : 502, (e as Error).message);
    }
    let line: any[] = [];
    try {
      line = (await ghJson<any[]>(['api', `repos/${repo.id}/pulls/${num}/comments?per_page=100`])) ?? [];
    } catch (e) {
      console.warn(`[github] ${repo.id}#${num}: 行コメントを取得できません: ${(e as Error).message}`);
    }
    const known = this.watcher.get(repo.id, num);
    const base = toPrInfo(repo.id, j, { mine: known?.mine, reviewRequested: known?.reviewRequested });
    return toPrDetail(repo.id, j, line, { ...base, sessionId: known?.sessionId ?? null, worktreeId: known?.worktreeId ?? null });
  }

  /** PR に紐付いたセッション(watcher の紐付けが無ければ worktree / セッションのブランチから探す) */
  private linked(repo: RepoInfo, pr: { number: number; headRefName: string }): SessionInfo | null {
    const known = this.watcher.get(repo.id, pr.number);
    const all = this.sessions.all();
    if (known?.sessionId && all[known.sessionId]) return all[known.sessionId];
    const wt = this.repos.pool.forRepo(repo.id).find((w) => w.state === 'assigned' && w.branch === pr.headRefName);
    if (wt?.sessionId && all[wt.sessionId]) return all[wt.sessionId];
    return (
      Object.values(all)
        .filter((s) => s.managed && s.repoId === repo.id && s.branch === pr.headRefName)
        .sort((a, b) => b.lastEventAt - a.lastEventAt)[0] ?? null
    );
  }

  /** セッションがまだ worktree を持っているか */
  private holds(s: SessionInfo): boolean {
    if (!s.worktreeId) return false;
    const w = this.repos.pool.get(s.worktreeId);
    return !!w && w.state === 'assigned' && w.sessionId === s.id;
  }

  // ================================================================ PR 作成(セッションに指示)
  createPr(sessionId: string, draft: boolean): { ok: true; sessionId: string; branch: string } {
    const s = this.sessions.info(sessionId);
    if (!s) throw new HttpError(404, 'セッションが見つかりません');
    if (!this.sessions.isLive(sessionId)) throw new HttpError(409, 'セッションが起動していません');
    if (!s.repoId || !s.branch) throw new HttpError(409, 'リポジトリのブランチで動いているセッションではありません');
    const repo = this.repo(s.repoId);
    const text = this.sessions.promptFor(sessionId, buildCreatePrInstruction({ base: repo.defaultBranch, draft }));
    const branch = s.branch;
    this.sessions
      .sendInstruction(sessionId, text)
      .then(() => this.watcher.burst(repo, branch))
      .catch((e) => console.error(`[pr] PR 作成の指示を送れませんでした (${s.name}): ${(e as Error).message}`));
    return { ok: true, sessionId, branch };
  }

  // ================================================================ 直して
  /** 「直して」の指示文を作る(レビューコメント / 失敗ログ) */
  async buildFix(repo: RepoInfo, d: PrDetail, o: { comments: boolean; checks: boolean; note?: string }): Promise<string> {
    const input: FixInput = { pr: d, comments: [], checkLogs: [], note: o.note };
    if (o.comments) input.comments = await this.unresolvedComments(repo, d);
    if (o.checks) {
      const seen = new Set<number>();
      for (const c of d.failedChecks) {
        if (c.runId == null) {
          input.checkLogs.push({ name: c.name, runId: null, log: `(GitHub Actions 以外のチェックのためログを取得できません: ${c.url})` });
          continue;
        }
        if (seen.has(c.runId)) continue;
        seen.add(c.runId);
        const r = await ghRun(['run', 'view', String(c.runId), '--repo', repo.id, '--log-failed'], { timeout: 120_000 });
        const log = r.code === 0 ? r.stdout : `(ログを取得できませんでした: ${tail(r, 300)})`;
        input.checkLogs.push({ name: c.name, runId: c.runId, log });
      }
    }
    if (!input.comments.length && !input.checkLogs.length && !o.note?.trim()) {
      throw new HttpError(409, '送る内容がありません(未解決のレビューコメントも失敗したチェックもありません)');
    }
    return buildFixInstruction(input);
  }

  /** 未解決のレビュースレッド(GraphQL)+ レビュー本文 + 会話コメント(PR 作成者・bot 以外) */
  private async unresolvedComments(repo: RepoInfo, d: PrDetail): Promise<PrComment[]> {
    const out: PrComment[] = [];
    let threadsOk = false;
    try {
      const j = await ghJson([
        'api', 'graphql',
        '-f', `query=${THREADS_QUERY}`,
        '-f', `owner=${repo.owner}`,
        '-f', `name=${repo.name}`,
        '-F', `n=${d.number}`,
      ]);
      const nodes = j?.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (Array.isArray(nodes)) {
        threadsOk = true;
        for (const t of nodes) {
          if (t.isResolved) continue;
          for (const c of t.comments?.nodes ?? []) {
            out.push({
              author: String(c.author?.login ?? ''),
              body: String(c.body ?? ''),
              createdAt: Date.parse(c.createdAt) || 0,
              path: t.path ?? undefined,
              line: Number(t.line ?? t.originalLine) || undefined,
              url: c.url ?? undefined,
            });
          }
        }
      }
    } catch (e) {
      console.warn(`[pr] ${repo.id}#${d.number}: レビュースレッドを取得できません(行コメントを全部送ります): ${(e as Error).message}`);
    }
    if (!threadsOk) out.push(...d.comments.filter((c) => c.path));
    for (const r of d.reviews) {
      if (r.body.trim() && r.author !== d.author && !isBot(r.author)) out.push({ author: r.author, body: `[${r.state}] ${r.body}`, createdAt: r.submittedAt });
    }
    for (const c of d.comments) {
      if (!c.path && c.body.trim() && c.author !== d.author && !isBot(c.author)) out.push(c);
    }
    return out;
  }

  async fix(repoId: string, n: unknown, body: any): Promise<FixResult> {
    const repo = this.repo(repoId);
    const d = await this.detail(repo.id, n);
    const wantComments = body?.comments !== undefined ? !!body.comments : true;
    const wantChecks = body?.checks !== undefined ? !!body.checks : true;
    const note = typeof body?.note === 'string' ? body.note.slice(0, 4000) : undefined;
    const text = await this.buildFix(repo, d, { comments: wantComments, checks: wantChecks, note });
    return this.deliver(repo, d, text, `pr-${d.number}-fix`, undefined);
  }

  /** PR から新規セッション(ユーザーの指示付き) */
  openSession(repoId: string, n: unknown, body: any): Promise<{ ok: true; session: SessionInfo }> {
    return (async () => {
      const repo = this.repo(repoId);
      const num = this.num(n);
      const pr = this.watcher.get(repo.id, num) ?? (await this.detail(repo.id, num));
      if (pr.state !== 'OPEN') throw new HttpError(409, `この PR は ${pr.state} です`);
      const mode: SessionMode = body?.mode === 'commander' ? 'commander' : 'plain';
      const instruction = typeof body?.instruction === 'string' && body.instruction.trim() ? body.instruction.trim() : undefined;
      const session = this.repos.startPrSession({ repoId: repo.id, number: num, headRefName: pr.headRefName, mode, instruction, name: `PR #${num}` });
      return { ok: true as const, session };
    })();
  }

  /**
   * 指示を届ける: 動いている紐付きセッション → そのまま送る / 停止中だが worktree を持っている → 再開して送る /
   * それ以外 → プールの worktree で gh pr checkout して新しいセッション
   */
  private async deliver(
    repo: RepoInfo,
    pr: PrInfo,
    text: string,
    tag: string,
    mode: SessionMode | undefined,
  ): Promise<FixResult> {
    if (pr.state !== 'OPEN') throw new HttpError(409, `この PR は ${pr.state} です`);
    const s = this.linked(repo, pr);
    if (s && this.sessions.isLive(s.id)) {
      const msg = this.sessions.promptFor(s.id, deliverInstruction(repo, s.cwd, tag, text));
      this.sessions.sendInstruction(s.id, msg).catch((e) => console.error(`[pr] 指示を送れませんでした (${s.name}): ${(e as Error).message}`));
      console.log(`[pr] ${pr.id}: 紐付いたセッション ${s.name} に指示を送ります`);
      return { ok: true, session: this.sessions.info(s.id) ?? s, action: 'sent' };
    }
    if (s && !this.sessions.isRunning(s.id) && this.holds(s)) {
      this.sessions.control(s.id, 'resume');
      const msg = this.sessions.promptFor(s.id, deliverInstruction(repo, s.cwd, tag, text));
      this.sessions.sendInstruction(s.id, msg).catch((e) => console.error(`[pr] 指示を送れませんでした (${s.name}): ${(e as Error).message}`));
      console.log(`[pr] ${pr.id}: 停止中のセッション ${s.name} を再開して指示を送ります`);
      return { ok: true, session: this.sessions.info(s.id) ?? s, action: 'resumed' };
    }
    const session = this.repos.startPrSession({
      repoId: repo.id,
      number: pr.number,
      headRefName: pr.headRefName,
      mode: mode ?? 'plain',
      instruction: text,
      name: `PR #${pr.number} 修正`,
    });
    console.log(`[pr] ${pr.id}: 新しいセッションで修正します`);
    return { ok: true, session, action: 'started' };
  }

  // ================================================================ マージ / クローズ
  async merge(repoId: string, n: unknown, method: unknown): Promise<{ ok: true; released: string | null }> {
    const repo = this.repo(repoId);
    const num = this.num(n);
    const m = String(method || 'squash') as MergeMethod;
    if (!METHODS.has(m)) throw new HttpError(400, "method は 'squash' / 'merge' / 'rebase' のいずれかです");
    const r = await ghMutate(['pr', 'merge', String(num), '--repo', repo.id, `--${m}`, '--delete-branch'], { timeout: 120_000 });
    if (r.code !== 0) throw new HttpError(409, `マージできませんでした: ${tail(r, 500)}`);
    console.log(`[pr] ${repo.id}#${num} をマージしました (${m})`);
    const before = this.watcher.get(repo.id, num);
    await this.watcher.poll(repo, true);
    // 紐付いたセッションが停止済みなら worktree を解放する(ブランチは keep。マージ済みなので後で一括削除できる)
    const pr = this.watcher.get(repo.id, num) ?? before;
    let released: string | null = null;
    const s = pr ? this.linked(repo, pr) : null;
    if (s && !this.sessions.isRunning(s.id) && this.holds(s)) {
      try {
        const w = await this.repos.release(s.id, 'keep');
        released = w.id;
      } catch (e) {
        console.warn(`[pr] マージ後の worktree 解放に失敗: ${(e as Error).message}`);
      }
    }
    return { ok: true, released };
  }

  async close(repoId: string, n: unknown): Promise<{ ok: true }> {
    const repo = this.repo(repoId);
    const num = this.num(n);
    const r = await ghMutate(['pr', 'close', String(num), '--repo', repo.id], { timeout: 60_000 });
    if (r.code !== 0) throw new HttpError(409, `クローズできませんでした: ${tail(r, 500)}`);
    await this.watcher.poll(repo, true);
    return { ok: true };
  }
}
