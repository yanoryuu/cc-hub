// 小さな共通部品
import type { SessionInfo, SessionStatus } from '@cc-hub/shared';
import { STATUS_ICON, STATUS_LABEL } from '../util';

/** 状態アイコン(形 + 色)。横にラベルを出さない場所では title と読み上げ用のラベルで補う */
export function StatusDot({ status, title }: { status: SessionStatus; title?: string }) {
  return (
    <span className={`sico st-${status}`} title={title ?? STATUS_LABEL[status]} role="img" aria-label={STATUS_LABEL[status]}>
      {STATUS_ICON[status]}
    </span>
  );
}

/** 状態バッジ: アイコン + ラベル(色が分からなくても読める) */
export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`sbadge st-${status}`}>
      <span className="sbadge-ico" aria-hidden="true">
        {STATUS_ICON[status]}
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** 小さなバッジ(読み取り専用 / PowerShell で実行中 など) */
export function Tag({ tone = '', children, title }: { tone?: string; children: React.ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** セッションの「どこで動いているか」バッジ。CC Hub 管理下なら何も出さない */
export function WhereTag({ session }: { session: Pick<SessionInfo, 'managed' | 'handedOff'> }) {
  if (session.managed) return null;
  if (session.handedOff)
    return (
      <Tag tone="ps" title="PowerShell のウィンドウで実行中。「CC Hub に戻す」でここに戻せます">
        PowerShell で実行中
      </Tag>
    );
  return (
    <Tag tone="ro" title="CC Hub の外で起動されたセッション。「CC Hub で引き継ぐ」で指示を出せるようになります">
      外部・読み取り専用
    </Tag>
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
