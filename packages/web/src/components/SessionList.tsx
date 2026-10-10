// セッション一覧(並び順を選べる / リポジトリ・cwd ごとにまとめる)。デスクトップのサイドバーとモバイルの一覧で共用
import { useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { api, sessionApi } from '../api';
import { SORT_LABEL, type SortMode, groupSessions, isFinished, useHub } from '../store';
import { STATUS_ICON, STATUS_LABEL, projectLabel } from '../util';
import { needsRelease, useSessionWorktree } from '../repo';
import { fmtTokens, projectKey } from '../project';
import { CtxMeter, WhereTag, toolText } from './common';

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
  const sub = s.status === 'awaiting_approval' ? s.approval?.question ?? '' : toolText(s);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    const live = s.managed && s.status !== 'stopped' && s.status !== 'error';
    if (!window.confirm(`「${s.name}」を一覧から削除しますか?(会話の記録は残ります)${live ? '\n実行中のプロセスも終了します。' : ''}`)) return;
    setRemoving(true);
    try {
      await sessionApi.control(s.id, 'remove');
    } catch (e) {
      window.alert(`削除できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      setRemoving(false);
    }
  };
  return (
    <div className="srow-wrap">
    <button className={`srow st-${s.status} ${active ? 'active' : ''}`} onClick={onClick} aria-current={active}>
      <span className="srow-main">
        <span className="srow-top">
          <span className="srow-name">{s.name}</span>
          {release && <span className="need-release">要解放</span>}
        </span>
        {s.branch && (
          <span className="srow-branch mono" title={wt ? `${s.branch}(${wt.name})` : s.branch}>
            {s.branch}
          </span>
        )}
        <span className="srow-sub">
          <span className={`srow-status st-${s.status}`}>
            <span className="srow-ico" aria-hidden="true">
              {STATUS_ICON[s.status]}
            </span>
            {STATUS_LABEL[s.status]}
          </span>
          {sub && (
            <span className="srow-tool" title={sub}>
              {sub}
            </span>
          )}
        </span>
        {!s.managed && (
          <span className="srow-tags">
            <WhereTag session={s} />
          </span>
        )}
      </span>
      <span className="srow-right">
        <CtxMeter pct={s.contextPct} />
        {s.tokens && (
          <span
            className="srow-tok"
            title={`トークン: 入力 ${s.tokens.input.toLocaleString('ja-JP')} / 出力 ${s.tokens.output.toLocaleString('ja-JP')}`}
          >
            {fmtTokens(s.tokens.input + s.tokens.output)} tok
          </span>
        )}
        {index < 9 && (
          <kbd className="srow-key" title={`Ctrl+${index + 1} で開く`}>
            Ctrl+{index + 1}
          </kbd>
        )}
      </span>
    </button>
      <button
        type="button"
        className="srow-del"
        onClick={() => void remove()}
        disabled={removing}
        title="一覧から削除"
        aria-label={`「${s.name}」を一覧から削除`}
      >
        ×
      </button>
    </div>
  );
}

/** 並び順とグループの切り替え(設定は保存される) */
export function SortControl() {
  const opts = useHub((s) => s.sortOpts);
  const setOpts = useHub((s) => s.setSortOpts);
  return (
    <div className="sort-ctl" role="group" aria-label="セッションの並び順">
      <label className="sort-sel">
        <span className="sr-only">並び順</span>
        <select value={opts.sort} onChange={(e) => setOpts({ sort: e.target.value as SortMode })} aria-label="並び順">
          {(Object.keys(SORT_LABEL) as SortMode[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={`grp-toggle ${opts.group ? 'on' : ''}`}
        aria-pressed={opts.group}
        onClick={() => setOpts({ group: !opts.group })}
        title={opts.group ? 'リポジトリごとにまとめています(クリックでまとめない)' : 'まとめずに並べています(クリックでリポジトリごと)'}
      >
        {opts.group ? '⑂ リポジトリごと' : '≡ まとめない'}
      </button>
    </div>
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
  const opts = useHub((s) => s.sortOpts);
  const openProject = useHub((s) => s.openProject);
  // いま開いている管理画面のグループを強調する
  const activeProject = useHub((s) => (s.deskView === 'project' || s.mobileProject ? projectKey(s.project) : ''));
  const [showDone, setShowDone] = useState(false);
  const [clearing, setClearing] = useState(false);
  const all = Object.values(sessions);
  const done = all.filter((s) => isFinished(s, worktrees)).sort((a, b) => b.lastEventAt - a.lastEventAt);
  const groups = groupSessions(
    all.filter((s) => !isFinished(s, worktrees)),
    repos,
    opts,
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
      {groups.every((g) => g.sessions.length === 0) && <div className="empty small">動いているセッションはありません</div>}
      {groups.map((g) =>
        g.sessions.length === 0 ? null : (
          <div className="sgroup" key={g.key}>
            {g.key !== 'all' && (
              <button
                className={`sgroup-title sgroup-link ${activeProject && activeProject === projectKey(g) ? 'on' : ''}`}
                title={`${g.sub}\nクリックで管理画面を開く`}
                aria-label={`${g.repoId ? g.label : projectLabel(g.cwd ?? '')} の管理画面を開く(${g.sessions.length} セッション)`}
                onClick={() => openProject(g.repoId ? { repoId: g.repoId } : { cwd: g.cwd })}
              >
                {g.repoId ? (
                  <>
                    <span className="sgroup-repo-ico" aria-hidden="true">
                      ⑂
                    </span>
                    <span className="sgroup-label">{g.label}</span>
                  </>
                ) : (
                  <span className="sgroup-label">{projectLabel(g.cwd ?? '')}</span>
                )}
                <span className="sgroup-count">{g.sessions.length}</span>
                <span className="spacer" />
                <span className="sgroup-go" aria-hidden="true">
                  管理画面 ›
                </span>
              </button>
            )}
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
        ),
      )}
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
