// 小さな共通部品
import type { SessionInfo, SessionStatus } from '@cc-hub/shared';
import { STATUS_LABEL } from '../util';

export function StatusDot({ status, title }: { status: SessionStatus; title?: string }) {
  return <span className={`sdot st-${status}`} title={title ?? STATUS_LABEL[status]} aria-hidden="true" />;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`sbadge st-${status}`}>
      <span className={`sdot st-${status}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CtxMeter({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const v = Math.max(0, Math.min(100, pct));
  const tone = v >= 85 ? 'hot' : v >= 65 ? 'warm' : '';
  return (
    <span className={`ctx ${tone}`} title={`コンテキスト使用率 ${Math.round(v)}%`}>
      <span className="ctx-bar">
        <span style={{ width: `${v}%` }} />
      </span>
      <span className="ctx-num">{Math.round(v)}%</span>
    </span>
  );
}

export function toolText(s: Pick<SessionInfo, 'currentTool'>): string {
  const t = s.currentTool;
  if (!t) return '';
  return t.target ? `${t.name} ${t.target}` : t.name;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
