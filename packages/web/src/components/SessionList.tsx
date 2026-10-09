// セッション一覧(リポジトリ / cwd ごとにグループ化)。デスクトップのサイドバーとモバイルの一覧で共用
import type { SessionInfo } from '@cc-hub/shared';
import { groupSessions, useHub } from '../store';
import { STATUS_LABEL, projectLabel } from '../util';
import { needsRelease, useSessionWorktree } from '../repo';
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
  const wt = useSessionWorktree(s);
  const release = needsRelease(s, wt);
  const sub = s.status === 'awaiting_approval' ? s.approval?.question ?? STATUS_LABEL[s.status] : toolText(s);
  return (
    <button className={`srow st-${s.status} ${active ? 'active' : ''}`} onClick={onClick} aria-current={active}>
      <StatusDot status={s.status} />
      <span className="srow-main">
        <span className="srow-top">
          <span className="srow-name">{s.name}</span>
          {!s.managed && <span className="ro-tag">読み取り専用</span>}
          {release && <span className="need-release">要解放</span>}
        </span>
        {s.branch && (
          <span className="srow-branch mono" title={wt ? `${s.branch}(${wt.name})` : s.branch}>
            {s.branch}
          </span>
        )}
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

export function SessionList({
  onPick,
  activeOnlyInSessionView = false,
}: {
  onPick: (id: string) => void;
  /** true = 選択中の強調を出さない(デスクトップでセッション以外を表示中) */
  activeOnlyInSessionView?: boolean;
}) {
  const sessions = useHub((s) => s.sessions);
  const repos = useHub((s) => s.repos);
  const selectedId = useHub((s) => s.selectedId);
  const groups = groupSessions(Object.values(sessions), repos);
  if (groups.length === 0) return <div className="empty">セッションがありません</div>;
  let idx = 0;
  return (
    <nav className="slist" aria-label="セッション">
      {groups.map((g) => (
        <div className="sgroup" key={g.key}>
          <div className="sgroup-title" title={g.sub}>
            {g.repoId ? (
              <>
                <span className="sgroup-repo-ico" aria-hidden="true">
                  ⑂
                </span>
                {g.label}
                <span className="sgroup-path">{g.sub}</span>
              </>
            ) : (
              <>
                {projectLabel(g.cwd ?? '')}
                <span className="sgroup-path">{g.cwd}</span>
              </>
            )}
          </div>
          {g.sessions.map((s) => {
            const i = idx++;
            return (
              <SessionRow
                key={s.id}
                s={s}
                index={i}
                active={!activeOnlyInSessionView && s.id === selectedId}
                onClick={() => onPick(s.id)}
              />
            );
          })}
        </div>
      ))}
    </nav>
  );
}
