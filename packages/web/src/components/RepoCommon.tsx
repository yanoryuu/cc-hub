// リポジトリ / プール画面の小さな共通部品(プールチップ / 状態バッジ / 確認ダイアログ)
import { useEffect } from 'react';
import type { RepoInfo, RepoStatus, WorktreeInfo, WorktreeState } from '@cc-hub/shared';
import { REPO_STATUS_LABEL, WT_STATE_LABEL, poolCounts } from '../repo';

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? '処理中'} />;
}

export function WtBadge({ state }: { state: WorktreeState }) {
  const busy = state === 'creating' || state === 'warming' || state === 'releasing' || state === 'deleting';
  return (
    <span className={`wtbadge wt-${state}`}>
      {busy ? <Spinner /> : <span className="wtdot" aria-hidden="true" />}
      {WT_STATE_LABEL[state]}
    </span>
  );
}

export function RepoStatusBadge({ status }: { status: RepoStatus }) {
  return (
    <span className={`wtbadge rs-${status}`}>
      {status === 'cloning' ? <Spinner /> : <span className="wtdot" aria-hidden="true" />}
      {REPO_STATUS_LABEL[status]}
    </span>
  );
}

/** プールの状況を短いチップで: 待機 1/3 · 準備中 1 · 使用中 2 · エラー 1 */
export function PoolChips({ repo, worktrees }: { repo: RepoInfo; worktrees: WorktreeInfo[] }) {
  if (repo.status === 'cloning') {
    return (
      <span className="pool-chips">
        <span className="pchip cloning">
          <Spinner /> クローン中
        </span>
      </span>
    );
  }
  if (repo.status === 'error' && worktrees.length === 0) {
    return (
      <span className="pool-chips">
        <span className="pchip broken">エラー</span>
      </span>
    );
  }
  const c = poolCounts(worktrees);
  // 目標を満たす: 緑 / 不足だが準備中・待機が少しある: 黄 / 待機も準備中もない: 赤
  const tone = c.idle >= repo.poolMin ? '' : c.idle === 0 && c.preparing === 0 ? 'zero' : 'short';
  return (
    <span className="pool-chips">
      {/* 目標を超えている間(返却直後など)は「4/3」と出すと不自然なので本数だけ出す。余剰は一定時間後に自動で削除される */}
      <span
        className={`pchip idle ${tone}`}
        title={c.idle > repo.poolMin ? `待機 ${c.idle} 本(目標 ${repo.poolMin} 本。余った分はしばらく使われなければ削除)` : `待機中 / 目標 ${repo.poolMin} 本`}
      >
        待機 {c.idle > repo.poolMin ? c.idle : `${c.idle}/${repo.poolMin}`}
      </span>
      {c.preparing > 0 && <span className="pchip preparing">準備中 {c.preparing}</span>}
      {c.assigned > 0 && <span className="pchip assigned">使用中 {c.assigned}</span>}
      {c.cleaning > 0 && <span className="pchip cleaning">初期化中 {c.cleaning}</span>}
      {c.broken > 0 && <span className="pchip broken">エラー {c.broken}</span>}
    </span>
  );
}

/** 確認ダイアログ(ネイティブの confirm では足りないとき: 追加オプションや強い警告がある場合) */
export function ConfirmModal({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  confirmDisabled,
  wide,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** true = 確認ボタンを押せない(チェックの同意待ちなど) */
  confirmDisabled?: boolean;
  /** true = 入力欄があるダイアログ用に少し広く */
  wide?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? '' : 'narrow'}`} role="alertdialog" aria-modal="true" aria-labelledby="cf-title">
        <div className="modal-head">
          <h2 id="cf-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body form">
          {children}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy || confirmDisabled} onClick={onConfirm}>
              {busy ? '処理中…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
