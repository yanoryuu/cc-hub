// セッション一覧(リポジトリ / cwd ごとにグループ化)。デスクトップのサイドバーとモバイルの一覧で共用
import { useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { api } from '../api';
import { groupSessions, isFinished, useHub } from '../store';
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
  const worktrees = useHub((s) => s.worktrees);
  const selectedId = useHub((s) => s.selectedId);
  const [showDone, setShowDone] = useState(false);
  const [clearing, setClearing] = useState(false);
  const all = Object.values(sessions);
  const done = all.filter((s) => isFinished(s, worktrees)).sort((a, b) => b.lastEventAt - a.lastEventAt);
  const groups = groupSessions(
    all.filter((s) => !isFinished(s, worktrees)),
    repos,
  );
  if (all.length === 0) return <div className="empty">セッションがありません</div>;
  let idx = 0;
  const clearDone = async () => {
    if (!window.confirm(`終了したセッション ${done.length} 件を一覧から削除しますか?(会話の記録は残ります)`)) return;
    setClearing(true);
    for (const s of done) {
      try {
        await api(`/api/sessions/${encodeURIComponent(s.id)}/control`, { action: 'remove' });
      } catch {
        /* 個別の失敗は無視して続ける */
      }
    }
    setClearing(false);
  };
  return (
    <nav className="slist" aria-label="セッション">
      {groups.length === 0 && <div className="empty small">動いているセッションはありません</div>}
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
      {done.length > 0 && (
        <div className="sgroup sgroup-done">
          <div className="sgroup-title sgroup-done-head">
            <button className="sgroup-toggle" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
              <span aria-hidden="true">{showDone ? '▾' : '▸'}</span> 終了したセッション
              <span className="sgroup-count">{done.length}</span>
            </button>
            {showDone && (
              <button className="link-btn" onClick={clearDone} disabled={clearing}>
                {clearing ? '削除中…' : 'すべて削除'}
              </button>
            )}
          </div>
          {showDone &&
            done.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                index={99}
                active={!activeOnlyInSessionView && s.id === selectedId}
                onClick={() => onPick(s.id)}
              />
            ))}
        </div>
      )}
    </nav>
  );
}
