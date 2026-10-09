// セッション一覧(cwd ごとにグループ化)。デスクトップのサイドバーとモバイルの一覧で共用
import type { SessionInfo } from '@cc-hub/shared';
import { groupByCwd, useHub } from '../store';
import { STATUS_LABEL, projectLabel } from '../util';
import { CtxMeter, StatusDot, toolText } from './common';

function SessionRow({
  s,
  index,
  active,
  onClick,
}: {
  s: SessionInfo;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const sub = s.status === 'awaiting_approval' ? s.approval?.question ?? STATUS_LABEL[s.status] : toolText(s);
  return (
    <button className={`srow st-${s.status} ${active ? 'active' : ''}`} onClick={onClick} aria-current={active}>
      <StatusDot status={s.status} />
      <span className="srow-main">
        <span className="srow-top">
          <span className="srow-name">{s.name}</span>
          {!s.managed && <span className="ro-tag">読み取り専用</span>}
        </span>
        <span className="srow-sub">
          <span className={`srow-status st-${s.status}`}>{STATUS_LABEL[s.status]}</span>
          {sub && <span className="srow-tool">{sub}</span>}
        </span>
      </span>
      <span className="srow-right">
        <CtxMeter pct={s.contextPct} />
        {index < 9 && <kbd className="srow-key">^{index + 1}</kbd>}
      </span>
    </button>
  );
}

export function SessionList({ onPick }: { onPick: (id: string) => void }) {
  const sessions = useHub((s) => s.sessions);
  const selectedId = useHub((s) => s.selectedId);
  const groups = groupByCwd(Object.values(sessions));
  if (groups.length === 0) return <div className="empty">セッションがありません</div>;
  let idx = 0;
  return (
    <nav className="slist" aria-label="セッション">
      {groups.map((g) => (
        <div className="sgroup" key={g.cwd}>
          <div className="sgroup-title" title={g.cwd}>
            {projectLabel(g.cwd)}
            <span className="sgroup-path">{g.cwd}</span>
          </div>
          {g.sessions.map((s) => {
            const i = idx++;
            return <SessionRow key={s.id} s={s} index={i} active={s.id === selectedId} onClick={() => onPick(s.id)} />;
          })}
        </div>
      ))}
    </nav>
  );
}
