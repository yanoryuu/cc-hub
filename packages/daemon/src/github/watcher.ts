// GitHubWatcher: 登録リポジトリの PR を gh で定期取得し、HubState.prs として配信する(design §8 GitHubWatcher)。
// - リポジトリごとに 90 秒(config.prPollSeconds)ごと: 自分の PR / レビュー依頼 / 使用中 worktree のブランチの PR
// - 前回との差分で pr.upsert / pr.remove を配信し、CI 失敗・レビュー・コメント増・マージを notify(kind 'pr')する
// - gh のエラー(認証切れ・レート制限など)はリポジトリ単位でバックオフし、警告ログは状態が変わったときだけ出す
// - PR ↔ worktree / セッションの紐付けは headRefName = worktree.branch(無ければ同じブランチのセッション)
import type { PrInfo, RepoInfo, ServerMessage, SessionInfo } from '@cc-hub/shared';
import { bus } from '../bus';
import type { WorktreePool } from '../repo/pool';
import { GhError, ghJson, ghLogin } from './gh';
import { PR_LIST_FIELDS, diffPrEvents, keepPr, mergePr, toPrInfo } from './pr';

const TICK_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const BURST_EVERY_MS = 15_000;
const BURST_TIMES = 20; // 15 秒 × 20 = 5 分

interface RepoRt {
  nextAt: number;
  backoffMs: number;
  polling: Promise<void> | null;
  /** 実行中の取得の後にもう一度取る予約(force の要求をまとめる) */
  queued: Promise<void> | null;
  /** 直近の警告(同じ内容を繰り返し出さない) */
  warned: string | null;
}

export interface WatcherDeps {
  pollMs: number;
  repos: () => RepoInfo[];
  pool: WorktreePool;
  sessions: () => Record<string, SessionInfo>;
}

export class GitHubWatcher {
  private readonly prs = new Map<string, PrInfo>();
  private readonly rts = new Map<string, RepoRt>();
  private readonly bursts = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private relinkTimer: NodeJS.Timeout | null = null;
  private readonly onBus = (msg: ServerMessage) => {
    // worktree / セッションのブランチが変わったら紐付けを取り直す(少しまとめてから)
    if (msg.t === 'worktree.upsert' || msg.t === 'worktree.remove' || msg.t === 'session.upsert' || msg.t === 'session.remove') {
      if (this.relinkTimer) return;
      this.relinkTimer = setTimeout(() => {
        this.relinkTimer = null;
        this.relink();
      }, 500);
    } else if (msg.t === 'repo.remove') {
      this.dropRepo(msg.id);
    }
  };

  constructor(private readonly d: WatcherDeps) {}

  // ================================================================ 参照
  all(): Record<string, PrInfo> {
    const out: Record<string, PrInfo> = {};
    for (const [id, p] of this.prs) out[id] = { ...p };
    return out;
  }

  list(): PrInfo[] {
    return [...this.prs.values()];
  }

  get(repoId: string, n: number): PrInfo | undefined {
    return this.prs.get(`${repoId}#${n}`);
  }

  // ================================================================ 起動・定期処理
  start(): void {
    bus.on('state', this.onBus);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => this.tick(), 3_000).unref();
  }

  stop(): void {
    bus.off('state', this.onBus);
    if (this.timer) clearInterval(this.timer);
    for (const t of this.bursts.values()) clearInterval(t);
    this.bursts.clear();
  }

  private rt(repoId: string): RepoRt {
    let r = this.rts.get(repoId);
    if (!r) {
      r = { nextAt: 0, backoffMs: 0, polling: null, queued: null, warned: null };
      this.rts.set(repoId, r);
    }
    return r;
  }

  private tick(): void {
    const now = Date.now();
    for (const repo of this.d.repos()) {
      if (repo.status !== 'ready') continue;
      const rt = this.rt(repo.id);
      if (!rt.polling && now >= rt.nextAt) void this.poll(repo);
    }
  }

  /** 全リポジトリを今すぐ取り直す(POST /api/prs/refresh)。最大 waitMs 待つ */
  async refreshAll(waitMs = 20_000): Promise<void> {
    const jobs = this.d.repos().filter((r) => r.status === 'ready').map((r) => this.poll(r, true));
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, waitMs))]);
  }

  /** 1 リポジトリを取り直す(実行中ならそれを待つ)。force = バックオフ中でも実行 */
  poll(repo: RepoInfo, force = false): Promise<void> {
    const rt = this.rt(repo.id);
    if (rt.polling) {
      if (!force) return rt.polling;
      // 実行中の取得は操作(マージなど)より前に始まったかもしれないので、終わってからもう一度取る(複数の要求は 1 回にまとめる)
      if (!rt.queued) {
        rt.queued = rt.polling.then(() => {
          rt.queued = null;
          return this.poll(repo, true);
        });
      }
      return rt.queued;
    }
    if (!force && Date.now() < rt.nextAt) return Promise.resolve();
    rt.polling = this.pollOnce(repo)
      .then(() => {
        if (rt.warned) console.log(`[github] ${repo.id}: PR の取得が回復しました`);
        rt.warned = null;
        rt.backoffMs = 0;
        rt.nextAt = Date.now() + this.d.pollMs;
      })
      .catch((e) => this.onError(repo, rt, e))
      .finally(() => {
        rt.polling = null;
      });
    return rt.polling;
  }

  private onError(repo: RepoInfo, rt: RepoRt, e: unknown): void {
    const kind = e instanceof GhError ? e.kind : 'other';
    rt.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(this.d.pollMs * 2, rt.backoffMs * 2));
    rt.nextAt = Date.now() + rt.backoffMs;
    const label = kind === 'auth' ? 'gh の認証エラー(gh auth login が必要?)' : kind === 'rate' ? 'GitHub のレート制限' : 'gh の実行エラー';
    const key = `${kind}`;
    if (rt.warned !== key) {
      rt.warned = key;
      console.warn(`[github] ${repo.id}: ${label}。${Math.round(rt.backoffMs / 1000)} 秒後にやり直します: ${(e as Error).message}`);
    }
  }

  private async pollOnce(repo: RepoInfo): Promise<void> {
    const me = await ghLogin();
    const base = ['pr', 'list', '--repo', repo.id, '--json', PR_LIST_FIELDS];
    const mine = await ghJson<any[]>([...base, '--author', '@me', '--state', 'all', '--limit', '30']);
    const review = await ghJson<any[]>([...base, '--search', 'review-requested:@me', '--state', 'open', '--limit', '30']);
    const found = new Map<string, PrInfo>();
    const add = (p: PrInfo) => found.set(p.id, mergePr(found.get(p.id), p));
    for (const j of mine ?? []) add(toPrInfo(repo.id, j, { mine: true }));
    for (const j of review ?? []) add(toPrInfo(repo.id, j, { reviewRequested: true, me }));
    // 使用中 worktree のブランチ(自分の PR 一覧に無いものだけ)
    const heads = new Set<string>();
    for (const w of this.d.pool.forRepo(repo.id)) if (w.state === 'assigned' && w.branch) heads.add(w.branch);
    for (const p of found.values()) heads.delete(p.headRefName);
    for (const h of heads) {
      const list = await ghJson<any[]>([...base, '--head', h, '--state', 'all', '--limit', '5']);
      for (const j of list ?? []) add(toPrInfo(repo.id, j, { me }));
    }
    this.apply(repo.id, [...found.values()], true);
  }

  /** ブランチの PR だけ取り直す(PR 作成直後の追跡用) */
  async pollHead(repo: RepoInfo, branch: string): Promise<PrInfo[]> {
    const me = await ghLogin();
    const list = await ghJson<any[]>(['pr', 'list', '--repo', repo.id, '--json', PR_LIST_FIELDS, '--head', branch, '--state', 'all', '--limit', '5']);
    const prs = (list ?? []).map((j) => toPrInfo(repo.id, j, { me }));
    this.apply(repo.id, prs, false);
    return prs;
  }

  /** PR 作成を指示した後、ブランチの PR が見つかるまで 15 秒ごとに数分間取り直す */
  burst(repo: RepoInfo, branch: string): void {
    const key = `${repo.id}\n${branch}`;
    const old = this.bursts.get(key);
    if (old) clearInterval(old);
    let n = 0;
    const t = setInterval(() => {
      n++;
      this.pollHead(repo, branch)
        .then((prs) => {
          if (prs.some((p) => p.state === 'OPEN') || n >= BURST_TIMES) this.stopBurst(key);
        })
        .catch(() => {
          if (n >= BURST_TIMES) this.stopBurst(key);
        });
    }, BURST_EVERY_MS);
    t.unref();
    this.bursts.set(key, t);
  }

  private stopBurst(key: string): void {
    const t = this.bursts.get(key);
    if (t) clearInterval(t);
    this.bursts.delete(key);
  }

  // ================================================================ 差分の反映
  /**
   * 取得結果を反映する。full = そのリポジトリの全取得(結果に無い PR は消す)。
   * 前回の値と比べて変わったものだけ配信し、通知イベントを出す
   */
  apply(repoId: string, list: PrInfo[], full: boolean): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const raw of list) {
      const prev = this.prs.get(raw.id);
      // head だけの取得では mine / reviewRequested が分からないので前回の値を引き継ぐ
      const merged = full ? raw : { ...raw, mine: raw.mine || !!prev?.mine, reviewRequested: raw.reviewRequested || !!prev?.reviewRequested };
      const next = this.link(merged);
      if (!keepPr(next, now)) continue;
      seen.add(next.id);
      for (const ev of diffPrEvents(prev, next)) {
        bus.state({
          t: 'notify',
          event: { kind: 'pr', sessionId: next.sessionId ?? '', prId: next.id, title: `${ev.title}: ${next.id}`, body: ev.body, ts: now },
        });
      }
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
        this.prs.set(next.id, next);
        bus.state({ t: 'pr.upsert', pr: { ...next } });
      }
    }
    for (const [id, p] of this.prs) {
      if (p.repoId !== repoId || seen.has(id)) continue;
      // full で見えなくなった PR / 期限切れの閉じた PR は消す
      if (full || !keepPr(p, now)) {
        this.prs.delete(id);
        bus.state({ t: 'pr.remove', id });
      }
    }
  }

  /** headRefName から worktree / セッションを紐付ける */
  private link(p: PrInfo): PrInfo {
    const wt = this.d.pool.forRepo(p.repoId).find((w) => w.state === 'assigned' && w.branch === p.headRefName);
    let sessionId = wt?.sessionId ?? null;
    if (!sessionId && p.headRefName) {
      const s = Object.values(this.d.sessions())
        .filter((x) => x.repoId === p.repoId && x.branch === p.headRefName && x.managed)
        .sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
      sessionId = s?.id ?? null;
    }
    return { ...p, worktreeId: wt?.id ?? null, sessionId };
  }

  private relink(): void {
    for (const [id, p] of this.prs) {
      const next = this.link(p);
      if (next.sessionId !== p.sessionId || next.worktreeId !== p.worktreeId) {
        this.prs.set(id, next);
        bus.state({ t: 'pr.upsert', pr: { ...next } });
      }
    }
  }

  private dropRepo(repoId: string): void {
    for (const [id, p] of this.prs) {
      if (p.repoId !== repoId) continue;
      this.prs.delete(id);
      bus.state({ t: 'pr.remove', id });
    }
    this.rts.delete(repoId);
  }
}
