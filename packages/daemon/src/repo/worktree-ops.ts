// worktree の rebase・削除の判定(純粋関数。pool.ts とテストから使う)。
import type { RebaseResult, WorktreeState } from '@cc-hub/shared';
import type { RunResult } from './exec';

export const IN_USE_REBASE_MSG = 'セッションが動いているので rebase できません。止めてから実行してください';
export const IN_USE_DELETE_MSG = 'セッションが動いているので削除できません。止めてから実行してください';
export const DIRTY_MSG = '未コミットの変更があります。コミットするか取り消してから rebase してください';

/** 準備・初期化・削除の途中の状態(この間は使用中扱い) */
const TRANSIENT: WorktreeState[] = ['creating', 'warming', 'releasing', 'deleting'];

/**
 * 使用中か: 準備・初期化・削除の途中、または割り当て先のセッションが動いている
 * (PTY が生きている / 起動準備中 / PowerShell に移して動いている)
 */
export function computeInUse(state: WorktreeState, sessionId: string | null, sessionLive: (id: string) => boolean): boolean {
  if (TRANSIENT.includes(state)) return true;
  if (state === 'assigned' && sessionId) return sessionLive(sessionId);
  return false;
}

/** git diff --name-only --diff-filter=U の出力 → 衝突ファイル */
export function parseConflictFiles(out: string): string[] {
  return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/** エラー表示用に出力の末尾を短くまとめる */
function tailText(r: RunResult, n = 600): string {
  const s = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/**
 * git rebase の結果を分類する。code 0 → rebased、衝突ファイルがある(または出力に CONFLICT)→ conflict、それ以外 → failed。
 * before / after / pulled は呼ぶ側で埋める
 */
export function classifyRebase(r: RunResult, conflicts: string[], base: string): Pick<RebaseResult, 'result' | 'conflicts' | 'message'> {
  if (r.code === 0) return { result: 'rebased', conflicts: [], message: `${base} の最新を取り込みました` };
  const text = `${r.stdout}\n${r.stderr}`;
  if (conflicts.length || /^CONFLICT \(/m.test(text) || /could not apply/i.test(text)) {
    return {
      result: 'conflict',
      conflicts,
      message: `${base} と衝突したので rebase を中止して元に戻しました${conflicts.length ? `(衝突: ${conflicts.join(', ')})` : ''}。Claude に解消を頼むか、手で直してください`,
    };
  }
  return { result: 'failed', conflicts: [], message: `rebase に失敗したので中止して元に戻しました: ${tailText(r) || `終了コード ${r.code}`}` };
}

/** rev-list --count の出力 → 数(読めなければ 0) */
export function parseCount(out: string): number {
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
