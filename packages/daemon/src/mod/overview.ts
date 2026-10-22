// Claude Code の mod「cc-hub」(integrations/mod/cc-hub)に渡す、CC Hub の状況のまとめ(GET /api/mod/overview)。
// mod はセッションの中で数秒おきにこれを読み、入力欄の上の帯・パネル・ステータスライン・トーストを描く。
// 重い /api/state の代わりに、描くのに要るものだけを返す。
import type { Approval, PrInfo, SessionInfo, SessionStatus } from '@cc-hub/shared';

/** 止まってからこの間はほかのセッションとして一覧に残す(終わったことが分かるように) */
export const RECENT_STOPPED_MS = 30 * 60_000;
const LAST_MESSAGE_MAX = 160;

export interface ModSession {
  id: string;
  name: string;
  status: SessionStatus;
  managed: boolean;
  repoId: string | null;
  branch: string | null;
  lastMessage: string | null;
  lastEventAt: number;
  /** 承認待ちの質問(managed のときだけ、ボタンで答えられる) */
  approval: Approval | null;
  pr: { number: number; url: string; state: string; checks: string } | null;
}

export interface ModOverview {
  /** この mod が動いているセッション(CC Hub が知らなければ null) */
  me: {
    id: string;
    name: string;
    repoId: string | null;
    branch: string | null;
    /** CC Hub の作業ツリーの中なら、その名前と、同じフォルダで動いているほかのセッション */
    worktree: { name: string; occupants: string[] } | null;
  } | null;
  /** ほかのセッション(動いているもの + 最近止まったもの)。承認待ちが先 */
  sessions: ModSession[];
  /** 承認待ちのほかのセッションの数 */
  approvals: number;
  now: number;
}

export interface OverviewDeps {
  sessions: SessionInfo[];
  /** claude の session_id / ハブの ID → ハブの ID */
  hubIdFor: (id: string) => string | null;
  worktreeByPath: (cwd: string) => { id: string; name: string } | undefined;
  occupants: (worktreeId: string, exceptSessionId: string) => string[];
  prs: PrInfo[];
}

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

export function buildOverview(d: OverviewDeps, q: { session?: string | null; cwd?: string | null }, now = Date.now()): ModOverview {
  const meId = q.session ? (d.hubIdFor(q.session) ?? q.session) : null;
  const meInfo = meId ? d.sessions.find((s) => s.id === meId) : undefined;
  const prFor = (s: SessionInfo) => {
    const p = s.branch ? d.prs.find((x) => x.repoId === s.repoId && x.headRefName === s.branch && x.state !== 'CLOSED') : undefined;
    return p ? { number: p.number, url: p.url, state: p.state, checks: p.checks } : null;
  };
  const cwd = meInfo?.cwd || q.cwd || '';
  const wt = cwd ? d.worktreeByPath(cwd) : undefined;
  const me: ModOverview['me'] = meInfo
    ? {
        id: meInfo.id,
        name: meInfo.name,
        repoId: meInfo.repoId,
        branch: meInfo.branch,
        worktree: wt ? { name: wt.name, occupants: d.occupants(wt.id, meInfo.id) } : null,
      }
    : null;
  const others = d.sessions
    .filter((s) => s.id !== meId)
    .filter((s) => s.status !== 'stopped' || now - s.lastEventAt < RECENT_STOPPED_MS)
    .map(
      (s): ModSession => ({
        id: s.id,
        name: s.name,
        status: s.status,
        managed: s.managed,
        repoId: s.repoId,
        branch: s.branch,
        lastMessage: clip(s.lastMessage, LAST_MESSAGE_MAX),
        lastEventAt: s.lastEventAt,
        approval: s.status === 'awaiting_approval' && s.managed ? s.approval : null,
        pr: prFor(s),
      }),
    )
    .sort((a, b) => Number(b.status === 'awaiting_approval') - Number(a.status === 'awaiting_approval') || b.lastEventAt - a.lastEventAt);
  return { me, sessions: others, approvals: others.filter((s) => s.status === 'awaiting_approval').length, now };
}
