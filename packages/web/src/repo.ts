// リポジトリ / worktree プールの表示用ヘルパー
import { useMemo } from 'react';
import type { RepoInfo, RepoKind, RepoStatus, SessionInfo, WorktreeInfo, WorktreeState } from '@cc-hub/shared';
import { useHub } from './store';

export const WT_STATE_LABEL: Record<WorktreeState, string> = {
  creating: '作成中',
  warming: '準備中',
  idle: '待機',
  assigned: '使用中',
  releasing: '初期化中',
  deleting: '削除中',
  broken: 'エラー',
};

export const REPO_STATUS_LABEL: Record<RepoStatus, string> = {
  cloning: 'クローン中',
  ready: '利用可能',
  error: 'エラー',
};

export const KIND_LABEL: Record<RepoKind, string> = {
  node: 'Node',
  python: 'Python',
  unity: 'Unity',
  other: 'その他',
};

/** 種別ごとの自動判定コマンド(installCmd が null のときのプレースホルダー表示用) */
export const KIND_INSTALL_HINT: Record<RepoKind, string> = {
  node: 'npm ci / pnpm i --frozen-lockfile / yarn',
  python: 'uv sync など',
  unity: 'なし(初回オープンで生成)',
  other: 'なし',
};

export interface PoolCounts {
  idle: number;
  /** creating + warming */
  preparing: number;
  assigned: number;
  /** releasing + deleting */
  cleaning: number;
  broken: number;
  total: number;
}

export function poolCounts(wts: WorktreeInfo[]): PoolCounts {
  const c: PoolCounts = { idle: 0, preparing: 0, assigned: 0, cleaning: 0, broken: 0, total: wts.length };
  for (const w of wts) {
    if (w.state === 'idle') c.idle++;
    else if (w.state === 'creating' || w.state === 'warming') c.preparing++;
    else if (w.state === 'assigned') c.assigned++;
    else if (w.state === 'releasing' || w.state === 'deleting') c.cleaning++;
    else if (w.state === 'broken') c.broken++;
  }
  return c;
}

/** worktree を名前順に */
export function sortWorktrees(list: WorktreeInfo[]): WorktreeInfo[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** リポジトリを名前順で */
export function useRepoList(): RepoInfo[] {
  const repos = useHub((s) => s.repos);
  return useMemo(() => Object.values(repos).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [repos]);
}

/** repoId → worktree 一覧(名前順) */
export function useWorktreesByRepo(): Record<string, WorktreeInfo[]> {
  const worktrees = useHub((s) => s.worktrees);
  return useMemo(() => {
    const out: Record<string, WorktreeInfo[]> = {};
    for (const w of Object.values(worktrees)) (out[w.repoId] ??= []).push(w);
    for (const k of Object.keys(out)) out[k] = sortWorktrees(out[k]);
    return out;
  }, [worktrees]);
}

/**
 * セッションに割り当てられた worktree。セッション停止後も解放されるまで assigned のまま残る。
 * worktree 側の sessionId が別セッションに変わっていたら(解放→再割当済み)null。
 */
export function useSessionWorktree(session: SessionInfo): WorktreeInfo | null {
  const wt = useHub((s) => (session.worktreeId ? s.worktrees[session.worktreeId] : undefined));
  if (!wt || wt.sessionId !== session.id) return null;
  return wt;
}

/** 停止済みで、worktree がまだこのセッションに割り当てられている = 解放できる */
export function canRelease(session: SessionInfo, wt: WorktreeInfo | null): boolean {
  return !!wt && wt.state === 'assigned' && (session.status === 'stopped' || session.status === 'error');
}

/** 解放を促す(「要解放」の印)。使っていないので自動で止めたセッションは「再開」で続ける前提なので促さない */
export function needsRelease(session: SessionInfo, wt: WorktreeInfo | null): boolean {
  return !session.idleStopped && canRelease(session, wt);
}
