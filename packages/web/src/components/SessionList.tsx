// セッション一覧(並び順を選べる / リポジトリ・cwd ごとにまとめる)。デスクトップのサイドバーとモバイルの一覧で共用
import { useMemo, useState } from 'react';
import type { AgentNode, SessionInfo } from '@cc-hub/shared';
import { api, errText, isConflict, repoApi, sessionApi } from '../api';
import { SORT_LABEL, type SortMode, groupSessions, isFinished, useHub } from '../store';
import { STATUS_ICON, STATUS_LABEL, projectLabel, useNow } from '../util';
import { needsRelease, useSessionWorktree } from '../repo';
import { fmtTokens, projectKey } from '../project';
import { CtxMeter, WhereTag, toolText } from './common';
import { AgentRow, buildTree, countTree } from './AgentTree';

// ---------------------------------------------------------------- 開閉の記憶
// プロジェクト(グループ)は既定で開く → 閉じたものを覚える。セッションのサブエージェントは既定で閉じる → 開いたものを覚える
const GROUPS_KEY = 'cchub.slist.closedGroups';
const AGENTS_KEY = 'cchub.slist.openAgents';
function loadSet(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s].slice(-200)));
  } catch {
    /* 保存できなくても表示は切り替える */
  }
}
function useToggleSet(key: string): [Set<string>, (id: string) => void] {
  const [set, setSet] = useState(() => loadSet(key));
  const toggle = (id: string) =>
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveSet(key, next);
      return next;
    });
  return [set, toggle];
}

/** 開く / 閉じるの矢印(エージェントのツリーと同じ形) */
function Caret({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="agent-caret slist-caret" onClick={onClick} aria-expanded={open} aria-label={label} title={label}>
      {open ? '▾' : '▸'}
    </button>
  );
}

/** セッションの下のサブエージェント(開いているときだけ描く) */
function SessionAgents({ agents }: { agents: AgentNode[] }) {
  const now = useNow(1000);
  const tree = useMemo(() => buildTree(agents), [agents]);
  return (
    <ul className="agent-tree srow-agents">
      {tree.map((n) => (
        <AgentRow key={n.agent.agentId} node={n} now={now} />
      ))}
    </ul>
  );
}

function SessionRow({
  s,
  index,
  active,
  onClick,
  agents = [],
  agentsOpen = false,
  onToggleAgents,
}: {
  s: SessionInfo;
  index: number;
  active: boolean;
  onClick: () => void;
  /** このセッションのサブエージェント */
  agents?: AgentNode[];
  agentsOpen?: boolean;
  onToggleAgents?: () => void;
}) {
  const wt = useSessionWorktree(s);
  const release = needsRelease(s, wt);
  // 何の作業か(最初の指示の 1 行目)。名前と同じなら出さない
  const title = (s.task ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const showTitle = title && title !== s.name ? title : '';
  const sub = s.status === 'awaiting_approval' ? s.approval?.question ?? '' : toolText(s);
  const [removing, setRemoving] = useState(false);
  const [acting, setActing] = useState(false);
  // 停止 / 再開(CC Hub が起動したセッションだけ。会話は残るので、止めても「再開」で続きから)
  const live = s.managed && s.status !== 'stopped' && s.status !== 'error';
  const lostWorktree = !!s.worktreeId && !(wt && wt.state === 'assigned' && wt.sessionId === s.id);
  const canResume = s.managed && !live && !lostWorktree;
  const toggleRun = async () => {
    if (live && !window.confirm(`「${s.name}」を停止しますか?(会話は残ります。「再開」で続きから)`)) return;
    setActing(true);
    try {
      await sessionApi.control(s.id, live ? 'stop' : 'restart');
    } catch (e) {
      window.alert(`${live ? '停止' : '再開'}できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActing(false);
    }
  };
  const remove = async () => {
    // 作業ツリーを持ったままでは削除できない(409)ので、ブランチを残して解放してから削除する
    const holds = !!wt && wt.state === 'assigned' && wt.sessionId === s.id;
    const dirty = holds ? wt?.git?.changed ?? 0 : 0;
    const msg = [
      `「${s.name}」を一覧から削除しますか?(会話の記録は残ります)`,
      live ? '実行中のプロセスも終了します。' : '',
      holds ? `作業ツリー ${wt?.name} も解放します(ブランチ ${wt?.branch ?? s.branch ?? ''} は残ります)。` : '',
      dirty > 0 ? `※ コミットしていない変更 ${dirty} ファイルは消えます。` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (!window.confirm(msg)) return;
    setRemoving(true);
    try {
      if (holds) {
        if (live) await sessionApi.control(s.id, 'stop');
        // 停止直後はまだプロセスが残っていることがあるので、少し待って解放をやり直す
        for (let i = 0; ; i++) {
          try {
            await repoApi.release(s.id, 'keep');
            break;
          } catch (e) {
            if (!isConflict(e) || i >= 10) throw e;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      await sessionApi.control(s.id, 'remove');
    } catch (e) {
      window.alert(`削除できませんでした: ${errText(e)}`);
      setRemoving(false);
    }
  };
  const hasAgents = agents.length > 0 && !!onToggleAgents;
  const agentCount = hasAgents ? countTree(buildTree(agents)) : null;
  return (
    <>
    <div className={`srow-wrap ${hasAgents ? 'has-agents' : ''}`}>
      {hasAgents && (
        <Caret
          open={agentsOpen}
          onClick={onToggleAgents!}
          label={`${agentsOpen ? 'サブエージェントを閉じる' : 'サブエージェントを開く'}(${agentCount!.total} 件${agentCount!.running ? `、${agentCount!.running} 実行中` : ''})`}
        />
      )}
    <button className={`srow st-${s.status} ${active ? 'active' : ''}`} onClick={onClick} aria-current={active}>
      <span className="srow-main">
        <span className="srow-top">
          <span className="srow-name">{s.name}</span>
          {release && <span className="need-release">要解放</span>}
        </span>
        {showTitle && (
          <span className="srow-title" title={s.task ?? ''}>
            {showTitle}
          </span>
        )}
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
            {s.idleStopped && s.status === 'stopped' && (
              <span className="muted" title="入力待ちのまま長く使われていなかったので、メモリを空けるため CC Hub が停止しました。「再開」で続きからできます">
                (未使用のため)
              </span>
            )}
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
      {(live && s.managed) || canResume ? (
        <button
          type="button"
          className={`srow-act ${live ? 'stop' : 'resume'}`}
          onClick={() => void toggleRun()}
          disabled={acting || s.status === 'starting'}
          title={live ? '停止(会話は残ります)' : '再開(続きから)'}
          aria-label={`「${s.name}」を${live ? '停止' : '再開'}`}
        >
          {live ? '■' : '▶'}
        </button>
      ) : null}
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
      {hasAgents && agentsOpen && <SessionAgents agents={agents} />}
    </>
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
  const [closedGroups, toggleGroup] = useToggleSet(GROUPS_KEY);
  const [openAgents, toggleAgents] = useToggleSet(AGENTS_KEY);
  const agents = useHub((s) => s.agents);
  const agentsBySession = useMemo(() => {
    const m = new Map<string, AgentNode[]>();
    for (const a of Object.values(agents)) {
      const l = m.get(a.sessionId);
      if (l) l.push(a);
      else m.set(a.sessionId, [a]);
    }
    return m;
  }, [agents]);
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
      {groups.map((g) => {
        if (g.sessions.length === 0) return null;
        const grouped = g.key !== 'all';
        const open = !grouped || !closedGroups.has(g.key);
        const label = g.repoId ? g.label : projectLabel(g.cwd ?? '');
        // 閉じているあいだも Ctrl+数字 の番号は数える(開いたときに番号がずれないように)
        const startIdx = idx;
        idx += g.sessions.length;
        let rowIdx = startIdx;
        return (
          <div className={`sgroup ${open ? '' : 'closed'}`} key={g.key}>
            {grouped && (
              <div className="sgroup-head">
              <Caret
                open={open}
                onClick={() => toggleGroup(g.key)}
                label={`${label} のセッションを${open ? '閉じる' : '開く'}(${g.sessions.length} 件)`}
              />
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
              </div>
            )}
            {open &&
              g.sessions.map((s) => {
                const i = rowIdx++;
                return (
                  <SessionRow
                    key={s.id}
                    s={s}
                    index={i}
                    active={!activeOnlyInSessionView && s.id === selectedId}
                    onClick={() => onPick(s.id)}
                    agents={agentsBySession.get(s.id)}
                    agentsOpen={openAgents.has(s.id)}
                    onToggleAgents={() => toggleAgents(s.id)}
                  />
                );
              })}
          </div>
        );
      })}
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
