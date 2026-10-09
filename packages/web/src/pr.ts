// ブランチ / PR(フェーズ 3)の表示用ヘルパー
import { useMemo } from 'react';
import type { CheckState, NotifyEvent, PrInfo, PrState, SessionInfo } from '@cc-hub/shared';
import { useHub } from './store';
import { prApi } from './api';

export const PR_STATE_LABEL: Record<PrState, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  MERGED: 'Merged',
};

export const CHECK_LABEL: Record<CheckState, string> = {
  success: 'CI 成功',
  failure: 'CI 失敗',
  pending: 'CI 実行中',
  none: 'CI なし',
};

export const REVIEW_LABEL: Record<NonNullable<PrInfo['reviewDecision']>, string> = {
  APPROVED: '承認済み',
  CHANGES_REQUESTED: '修正依頼',
  REVIEW_REQUIRED: 'レビュー待ち',
};

/** PR の id("<repoId>#<number>")を分解 */
export function splitPrId(id: string): { repoId: string; number: number } | null {
  const i = id.lastIndexOf('#');
  if (i <= 0) return null;
  const n = parseInt(id.slice(i + 1), 10);
  if (!Number.isFinite(n)) return null;
  return { repoId: id.slice(0, i), number: n };
}

/** リポジトリ名(owner を除いた部分) */
export function repoShort(repoId: string): string {
  const i = repoId.indexOf('/');
  return i >= 0 ? repoId.slice(i + 1) : repoId;
}

/** "3分前" / "2時間前" / "5日前" */
export function fmtAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}日前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}か月前`;
  return `${Math.floor(day / 365)}年前`;
}

/** マージをブロックする理由(空 = マージ可能) */
export function mergeBlockers(pr: PrInfo): string[] {
  const out: string[] = [];
  if (pr.state !== 'OPEN') out.push(pr.state === 'MERGED' ? 'マージ済みです' : 'クローズされています');
  if (pr.isDraft) out.push('ドラフトです');
  if (pr.mergeable === 'CONFLICTING') out.push('コンフリクトがあります');
  else if (pr.mergeable === 'UNKNOWN') out.push('マージ可否を GitHub が計算中です');
  if (pr.checks === 'failure') out.push('CI が失敗しています');
  else if (pr.checks === 'pending') out.push('CI が実行中です');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') out.push('修正依頼が出ています');
  return out;
}

/** マージボタンを押せるか(条件: OPEN・ドラフトでない・MERGEABLE・CI が失敗していない) */
export function canMerge(pr: PrInfo): boolean {
  return pr.state === 'OPEN' && !pr.isDraft && pr.mergeable === 'MERGEABLE' && pr.checks !== 'failure';
}

/** 対応が必要な自分の PR(CI 失敗 / 修正依頼 / コンフリクト) */
export function needsAttention(pr: PrInfo): boolean {
  return (
    pr.state === 'OPEN' &&
    (pr.checks === 'failure' || pr.reviewDecision === 'CHANGES_REQUESTED' || pr.mergeable === 'CONFLICTING')
  );
}

export interface PrGroups {
  mine: PrInfo[];
  review: PrInfo[];
  other: PrInfo[];
  closed: PrInfo[];
}

/** 一覧のグループ分け: 自分の PR(セッション紐付きを含む)/ レビュー依頼 / その他 / 最近クローズ・マージ */
export function groupPrs(prs: Record<string, PrInfo>): PrGroups {
  const g: PrGroups = { mine: [], review: [], other: [], closed: [] };
  for (const pr of Object.values(prs)) {
    if (pr.state !== 'OPEN') g.closed.push(pr);
    // レビュー依頼の PR をセッションで開いても「レビュー依頼」のまま
    else if (pr.mine || (pr.sessionId && !pr.reviewRequested)) g.mine.push(pr);
    else if (pr.reviewRequested) g.review.push(pr);
    else g.other.push(pr);
  }
  // 対応が必要なものを先に、あとは更新順
  const byAttn = (a: PrInfo, b: PrInfo) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.updatedAt - a.updatedAt;
  g.mine.sort(byAttn);
  g.review.sort((a, b) => b.updatedAt - a.updatedAt);
  g.other.sort((a, b) => b.updatedAt - a.updatedAt);
  g.closed.sort((a, b) => b.updatedAt - a.updatedAt);
  return g;
}

export function usePrGroups(): PrGroups {
  const prs = useHub((s) => s.prs);
  return useMemo(() => groupPrs(prs), [prs]);
}

/** セッションに紐付いた PR(sessionId 一致、なければ同じリポジトリ・ブランチ)。OPEN を優先し、なければ最新 */
export function findSessionPr(prs: Record<string, PrInfo>, session: SessionInfo): PrInfo | null {
  const list = Object.values(prs).filter(
    (p) =>
      p.sessionId === session.id ||
      (!!session.branch && !!session.repoId && p.repoId === session.repoId && p.headRefName === session.branch),
  );
  if (list.length === 0) return null;
  list.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.updatedAt - a.updatedAt);
  return list[0];
}

export function useSessionPr(session: SessionInfo): PrInfo | null {
  const prs = useHub((s) => s.prs);
  return useMemo(() => findSessionPr(prs, session), [prs, session]);
}

/**
 * PR 通知(kind 'pr')の対象 PR を探す。
 * sessionId が PR の id そのもの → 本文の "owner/name#N" → "#N"(一意なら)→ セッションに紐付いた PR の順に試す。
 */
export function resolveNotifyPr(ev: NotifyEvent, prs: Record<string, PrInfo>, sessions: Record<string, SessionInfo>): string | null {
  if (ev.prId && prs[ev.prId]) return ev.prId;
  if (prs[ev.sessionId]) return ev.sessionId;
  const text = `${ev.title}\n${ev.body}`;
  const full = text.match(/([\w.-]+\/[\w.-]+)#(\d+)/);
  if (full && prs[`${full[1]}#${full[2]}`]) return `${full[1]}#${full[2]}`;
  const num = text.match(/#(\d+)/);
  if (num) {
    const hits = Object.values(prs).filter((p) => p.number === Number(num[1]));
    const s = sessions[ev.sessionId];
    const hit = hits.length === 1 ? hits[0] : hits.find((p) => s && p.repoId === s.repoId);
    if (hit) return hit.id;
  }
  const s = sessions[ev.sessionId];
  if (s) return findSessionPr(prs, s)?.id ?? null;
  return null;
}

// ---------------------------------------------------------------- PR 一覧の取り直し

/** 自動で取り直す間隔の下限(フォーカス復帰のたびに gh を叩かないように) */
const AUTO_REFRESH_MS = 30_000;
let lastRefreshAt = 0;
let inflight: Promise<void> | null = null;

/**
 * POST /api/prs/refresh。force=false ならフォーカス復帰用(30 秒以内の再実行は省略し、エラーも握りつぶす)。
 * force=true は手動更新ボタン用(エラーは呼び出し側へ)。
 */
export function refreshPrs(force = false): Promise<void> {
  if (inflight) return force ? inflight : inflight.catch(() => undefined);
  if (!force && Date.now() - lastRefreshAt < AUTO_REFRESH_MS) return Promise.resolve();
  lastRefreshAt = Date.now();
  const p = prApi
    .refresh()
    .then(() => undefined)
    .finally(() => {
      inflight = null;
    });
  inflight = p;
  return force ? p : p.catch(() => undefined);
}
