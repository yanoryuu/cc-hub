// 上部バー: 使用率メーター / 承認待ち / 新規セッション
import type { RateWindow } from '@cc-hub/shared';
import { useHub } from '../store';
import { fmtUntil, useNow } from '../util';
import { useApprovalSessions } from './Approval';

function Meter({ label, w, now }: { label: string; w: RateWindow | null; now: number }) {
  if (!w) {
    return (
      <div className="meter" title={`${label}: データなし`}>
        <span className="meter-label">{label}</span>
        <span className="meter-bar">
          <span style={{ width: 0 }} />
        </span>
        <span className="meter-num muted">—</span>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, w.pct));
  const tone = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  const until = w.resetsAt - now;
  return (
    <div
      className={`meter ${tone}`}
      title={`${label} 使用率 ${Math.round(pct)}% / リセット ${new Date(w.resetsAt).toLocaleString('ja-JP')}`}
    >
      <span className="meter-label">{label}</span>
      <span className="meter-bar" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-num">{Math.round(pct)}%</span>
      <span className="meter-reset">残{fmtUntil(until)}</span>
    </div>
  );
}

export function UsageMeters({ compact = false }: { compact?: boolean }) {
  const usage = useHub((s) => s.usage);
  const now = useNow(30000);
  return (
    <div className={`meters ${compact ? 'compact' : ''}`}>
      <Meter label="5時間" w={usage?.fiveHour ?? null} now={now} />
      <Meter label="週" w={usage?.sevenDay ?? null} now={now} />
    </div>
  );
}

export function ConnDot() {
  const connected = useHub((s) => s.connected);
  return (
    <span
      className={`conn ${connected ? 'on' : 'off'}`}
      title={connected ? 'デーモンに接続中' : '切断中(再接続しています)'}
      aria-label={connected ? '接続中' : '切断中'}
    />
  );
}

export function TopBar() {
  const approvals = useApprovalSessions();
  const setDrawer = useHub((s) => s.setApprovalDrawer);
  const drawer = useHub((s) => s.approvalDrawer);
  const setNew = useHub((s) => s.setNewSessionOpen);
  return (
    <header className="topbar">
      <div className="brand">
        <ConnDot />
        CC Hub
      </div>
      <UsageMeters />
      <div className="spacer" />
      <button
        className={`btn appr-btn ${approvals.length > 0 ? 'has' : ''}`}
        onClick={() => setDrawer(!drawer)}
        title="承認キュー(Ctrl+Shift+A)"
      >
        承認待ち <span className="count">{approvals.length}</span>
      </button>
      <button className="btn primary" onClick={() => setNew(true)}>
        + 新規セッション
      </button>
    </header>
  );
}
