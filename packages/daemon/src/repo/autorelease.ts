// 作業が終わった worktree の自動解放: セッションが止まっていて、失うものが無い worktree を解放して最新の main に戻す(ブランチは残す)。
// 解放の条件(すべて):
// - セッションが止まっている(停止 / エラー / 削除済み)
// - 未コミットの変更が無い
// - main より進んだコミットが無い、または push 済みでそのブランチの PR がマージされている
// 未 push のコミットや変更が残っているものは解放しない(管理画面に「要解放」として残る)
// 使っていないので自動で止めたセッション(idleStopped)の worktree も解放しない(「再開」で続けられるように)
import type { PrInfo, SessionInfo, WorktreeGitStat, WorktreeInfo } from '@cc-hub/shared';

const CHECK_MS = 60_000;

export function shouldAutoRelease(o: { git: WorktreeGitStat | null | undefined; sessionEnded: boolean; prMerged: boolean }): boolean {
  if (!o.sessionEnded || !o.git) return false;
  if (o.git.changed > 0) return false;
  if (o.git.ahead === 0) return true;
  return o.prMerged && o.git.unpushed === 0;
}

export interface AutoReleaseDeps {
  worktrees: () => WorktreeInfo[];
  session: (id: string) => SessionInfo | undefined;
  isRunning: (id: string) => boolean;
  prs: () => PrInfo[];
  release: (sessionId: string) => Promise<unknown>;
}

export function startAutoRelease(d: AutoReleaseDeps): () => void {
  const pending = new Set<string>();
  const check = () => {
    const prs = d.prs();
    for (const w of d.worktrees()) {
      if (w.state !== 'assigned' || !w.sessionId || pending.has(w.id)) continue;
      const s = d.session(w.sessionId);
      // 使っていないので自動で止めたセッションは「再開」で続けられるよう作業ツリーを残す
      if (s?.idleStopped) continue;
      const sessionEnded = !s || ((s.status === 'stopped' || s.status === 'error') && !d.isRunning(s.id));
      const prMerged = !!w.branch && prs.some((p) => p.repoId === w.repoId && p.headRefName === w.branch && p.state === 'MERGED');
      if (!shouldAutoRelease({ git: w.git, sessionEnded, prMerged })) continue;
      pending.add(w.id);
      const sid = w.sessionId;
      console.log(`[pool] ${w.id}: 作業が終わったので解放して最新の main に戻します(ブランチ ${w.branch ?? 'なし'} は残します)`);
      void d
        .release(sid)
        .catch((e) => console.warn(`[pool] ${w.id} の自動解放に失敗: ${(e as Error).message}`))
        .finally(() => pending.delete(w.id));
    }
  };
  const timer = setInterval(check, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
