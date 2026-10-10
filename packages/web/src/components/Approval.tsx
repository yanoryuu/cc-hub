// 承認カード(承認キュー / モバイル承認タブ / セッション詳細の承認バナーで共用)
import { useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { sessionApi } from '../api';
import { optionTone, optionValue } from '../util';
import { useHub } from '../store';
import { usePendingDeploys } from '../ops';
import { DeployRequestCard, useClaudeDeploysInFlight } from './Deploy';

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

export function ApprovalBanner({ session }: { session: SessionInfo }) {
  if (!session.approval) return null;
  return (
    <div className="appr-banner" role="alert">
      <div className="appr-q">{session.approval.question}</div>
      <ApprovalButtons session={session} />
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

/** 承認待ちの件数(セッションの承認 + Claude からのアップロード申請) */
export function useApprovalCount(): number {
  return useApprovalSessions().length + usePendingDeploys().length;
}

export function ApprovalList({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useApprovalSessions();
  const deploys = usePendingDeploys();
  const running = useClaudeDeploysInFlight();
  if (list.length === 0 && deploys.length === 0 && running.length === 0) return <div className="empty">承認待ちはありません</div>;
  return (
    <div className="appr-list">
      {deploys.map((d) => (
        <DeployRequestCard key={d.id} d={d} />
      ))}
      {list.map((s) => (
        <ApprovalCard key={s.id} session={s} onOpen={() => onOpen(s.id)} />
      ))}
      {running.length > 0 && (
        <>
          <h3 className="sec-title appr-sub">承認したアップロード</h3>
          {running.map((d) => (
            <DeployRequestCard key={d.id} d={d} />
          ))}
        </>
      )}
    </div>
  );
}
