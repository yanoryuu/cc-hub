// 作業ツリーの解放: セッション停止後、割り当てられた worktree をプールに戻す(ブランチ保持 / 破棄)
import { useState } from 'react';
import type { ReleaseMode, SessionInfo } from '@cc-hub/shared';
import { errText, isConflict, repoApi } from '../api';
import { canRelease, useSessionWorktree } from '../repo';
import { ConfirmModal, Spinner } from './RepoCommon';

export function ReleaseBanner({ session, compact = false }: { session: SessionInfo; compact?: boolean }) {
  const wt = useSessionWorktree(session);
  const [busy, setBusy] = useState<ReleaseMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (!wt) return null;
  // 初期化中(解放リクエスト後)
  if (wt.state === 'releasing' && wt.sessionId === session.id) {
    return (
      <div className={`release-banner busy ${compact ? 'compact' : ''}`}>
        <Spinner />
        <span className="release-busy-text">
          作業ツリー {wt.name} を初期化しています{wt.progress ? `(${wt.progress})` : '…'}
        </span>
      </div>
    );
  }
  if (!canRelease(session, wt)) return null;

  const branch = wt.branch ?? session.branch ?? '(ブランチ不明)';

  const release = async (mode: ReleaseMode) => {
    setBusy(mode);
    setErr(null);
    try {
      await repoApi.release(session.id, mode);
      setConfirmDiscard(false);
    } catch (e) {
      setErr(
        isConflict(e)
          ? `${errText(e)}(セッションが実行中の場合は停止してから解放してください)`
          : errText(e, '解放に失敗しました'),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`release-banner ${compact ? 'compact' : ''}`} role="region" aria-label="作業ツリーを解放">
      <div className="release-text">
        <strong>作業ツリーを解放</strong>
        <span>
          セッションは停止しています。<span className="mono">{wt.name}</span>(
          <span className="mono">{branch}</span>)はまだこのセッションに割り当てられています。解放するとプールに戻り、次のセッションで使えます。{session.idleStopped ? '(続きから作業するなら解放せず「再開」してください)' : ''}
        </span>
      </div>
      <div className="release-buttons">
        <button className="btn primary" disabled={busy !== null} onClick={() => void release('keep')}>
          {busy === 'keep' ? '解放中…' : 'ブランチを残して解放'}
        </button>
        <button className="btn danger" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
          ブランチを破棄して解放
        </button>
      </div>
      {err && !confirmDiscard && <div className="form-error">{err}</div>}
      {confirmDiscard && (
        <ConfirmModal
          title="ブランチを破棄して解放"
          confirmLabel="破棄して解放"
          danger
          busy={busy !== null}
          error={err}
          onConfirm={() => void release('discard')}
          onClose={() => {
            setConfirmDiscard(false);
            setErr(null);
          }}
        >
          <p>
            ブランチ <span className="mono strong">{branch}</span> を削除し、{wt.name} を初期化してプールに戻します。
          </p>
          <p className="warn-text">push していないコミットや未コミットの変更は失われます。この操作は取り消せません。</p>
        </ConfirmModal>
      )}
    </div>
  );
}
