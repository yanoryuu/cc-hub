// 承認カード(承認キュー / モバイル承認タブ / セッション詳細の承認バナーで共用)
import { useEffect, useState } from 'react';
import type { DeployJob, SessionInfo } from '@cc-hub/shared';
import { sessionApi } from '../api';
import { optionTone, optionValue } from '../util';
import { useHub } from '../store';
import { useAttentionDeploys } from '../ops';
import { DeployRequestCard, useClaudeDeploysInFlight } from './Deploy';
import { FirebaseJobCard } from './Firebase';

/** アップロード / Firebase のカードを出し分ける */
function DeployCard({ d }: { d: DeployJob }) {
  return d.firebase ? <FirebaseJobCard d={d} /> : <DeployRequestCard d={d} />;
}

export function ApprovalButtons({ session }: { session: SessionInfo }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const a = session.approval;
  if (!a) return null;

  const send = async (value: string) => {
    setBusy(value);
    setErr(null);
    try {
      await sessionApi.approve(session.id, value);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '送信に失敗しました');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="appr-buttons">
        {a.type === 'yn' ? (
          <>
            <button className="btn approve" disabled={busy !== null} onClick={() => send('y')}>
              はい (y)
            </button>
            <button className="btn deny" disabled={busy !== null} onClick={() => send('n')}>
              いいえ (n)
            </button>
          </>
        ) : (
          a.options.map((opt, i) => {
            const v = optionValue(opt, i);
            return (
              <button
                key={`${i}-${opt.n}`}
                className={`btn ${optionTone(opt.label)} ${opt.selected ? 'selected' : ''}`}
                disabled={busy !== null}
                onClick={() => send(v)}
              >
                {opt.n ? <span className="opt-n">{opt.n}</span> : null}
                <span className="opt-label">{opt.label}</span>
              </button>
            );
          })
        )}
      </div>
      {err && <div className="form-error">{err}</div>}
    </>
  );
}

export function ApprovalCard({ session, onOpen }: { session: SessionInfo; onOpen?: () => void }) {
  return (
    <div className="appr-card">
      <div className="appr-head">
        <button className="link appr-name" onClick={onOpen} title="セッションを開く">
          {session.name}
        </button>
        <span className="appr-cwd" title={session.cwd}>
          {session.cwd}
        </span>
      </div>
      <div className="appr-q">{session.approval?.question}</div>
      <ApprovalButtons session={session} />
    </div>
  );
}

/**
 * セッション詳細の承認の帯。overlay = 端末の上に重ねる(スマホ。端末の高さを変えないため)。
 * 重ねたときは、後ろの端末を見られるように畳める
 */
export function ApprovalBanner({ session, overlay = false }: { session: SessionInfo; overlay?: boolean }) {
  const [folded, setFolded] = useState(false);
  const q = session.approval?.question;
  // 新しい質問が来たら開き直す
  useEffect(() => setFolded(false), [q]);
  if (!session.approval) return null;
  if (!overlay) {
    return (
      <div className="appr-banner" role="alert">
        <div className="appr-q">{session.approval.question}</div>
        <ApprovalButtons session={session} />
      </div>
    );
  }
  return (
    <div className={`appr-banner overlay ${folded ? 'folded' : ''}`} role="alert">
      <div className="appr-overlay-head">
        <div className="appr-q">{session.approval.question}</div>
        <button
          type="button"
          className="btn ghost sm appr-fold"
          aria-expanded={!folded}
          onClick={() => setFolded((v) => !v)}
          title={folded ? '選択肢を表示する' : '畳んで後ろのターミナルを見る'}
        >
          {folded ? '選択肢 ▾' : '畳む ▴'}
        </button>
      </div>
      {!folded && <ApprovalButtons session={session} />}
    </div>
  );
}

/** 承認待ちのセッション一覧(古い順) */
export function useApprovalSessions(): SessionInfo[] {
  const sessions = useHub((s) => s.sessions);
  return Object.values(sessions)
    .filter((s) => s.approval != null)
    .sort((a, b) => a.lastEventAt - b.lastEventAt);
}

/** 承認待ちの件数(セッションの承認 + Claude からのアップロード / Firebase の申請 + Firebase のプレビュー確認待ち) */
export function useApprovalCount(): number {
  return useApprovalSessions().length + useAttentionDeploys().length;
}

export function ApprovalList({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useApprovalSessions();
  const attention = useAttentionDeploys();
  const deploys = attention.filter((d) => d.state === 'pending_approval');
  const previews = attention.filter((d) => d.state === 'preview_ready');
  const running = useClaudeDeploysInFlight();
  if (list.length === 0 && attention.length === 0 && running.length === 0) return <div className="empty">承認待ちはありません</div>;
  return (
    <div className="appr-list">
      {deploys.map((d) => (
        <DeployCard key={d.id} d={d} />
      ))}
      {previews.length > 0 && (
        <>
          <h3 className="sec-title appr-sub">本番への反映待ち(Firebase のプレビュー)</h3>
          {previews.map((d) => (
            <DeployCard key={d.id} d={d} />
          ))}
        </>
      )}
      {list.map((s) => (
        <ApprovalCard key={s.id} session={s} onOpen={() => onOpen(s.id)} />
      ))}
      {running.length > 0 && (
        <>
          <h3 className="sec-title appr-sub">承認したアップロード・デプロイ</h3>
          {running.map((d) => (
            <DeployCard key={d.id} d={d} />
          ))}
        </>
      )}
    </div>
  );
}
