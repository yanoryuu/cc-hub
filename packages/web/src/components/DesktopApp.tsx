// デスクトップレイアウト(幅 900px 以上): 上部バー / 左サイドバー / 中央ターミナル / 右パネル
import { useEffect } from 'react';
import { orderedSessions, useHub } from '../store';
import { TopBar } from './TopBar';
import { SessionList } from './SessionList';
import { SessionPane } from './SessionPane';
import { AgentTree } from './AgentTree';
import { SessionDetails } from './SessionDetails';
import { ApprovalList } from './Approval';
import { StatusBadge } from './common';
import { GameView } from './GameView';
import { useState } from 'react';

function ApprovalDrawer() {
  const open = useHub((s) => s.approvalDrawer);
  const setOpen = useHub((s) => s.setApprovalDrawer);
  const select = useHub((s) => s.select);
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} />
      <aside className="drawer" aria-label="承認キュー">
        <div className="drawer-head">
          <h2>承認キュー</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <ApprovalList
            onOpen={(id) => {
              select(id);
              setOpen(false);
            }}
          />
        </div>
      </aside>
    </>
  );
}

export function DesktopApp() {
  const selectedId = useHub((s) => s.selectedId);
  const session = useHub((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined));
  const loaded = useHub((s) => s.loaded);
  const select = useHub((s) => s.select);
  const [view, setView] = useState<'session' | 'game'>('session');

  // Ctrl+1..9: セッション切替 / Ctrl+Shift+A: 承認キュー
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const list = orderedSessions(useHub.getState().sessions);
        const s = list[parseInt(e.key, 10) - 1];
        if (s) {
          e.preventDefault();
          e.stopPropagation();
          useHub.getState().select(s.id);
          setView('session');
        }
      } else if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        e.stopPropagation();
        const st = useHub.getState();
        st.setApprovalDrawer(!st.approvalDrawer);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="desk">
      <TopBar />
      <div className="desk-body">
        <aside className="sidebar">
          <SessionList
            onPick={(id) => {
              select(id);
              setView('session');
            }}
          />
          <div className="sidebar-foot">
            <button className={`btn ghost ${view === 'game' ? 'on' : ''}`} onClick={() => setView(view === 'game' ? 'session' : 'game')}>
              ゲームキャプチャ
            </button>
          </div>
        </aside>
        <main className="center">
          {view === 'game' ? (
            <GameView />
          ) : session ? (
            <SessionPane
              key={session.id}
              session={session}
              desktop
              header={(fontCtl) => (
                <div className="pane-head">
                  <span className="pane-name">{session.name}</span>
                  <StatusBadge status={session.status} />
                  {!session.managed && <span className="ro-tag">読み取り専用</span>}
                  <span className="pane-cwd mono" title={session.cwd}>
                    {session.cwd}
                  </span>
                  <span className="spacer" />
                  {fontCtl}
                </div>
              )}
            />
          ) : (
            <div className="empty big">
              {loaded ? (selectedId ? 'セッションが見つかりません' : 'セッションがありません。「+ 新規セッション」から起動できます') : '読み込み中…'}
            </div>
          )}
        </main>
        <aside className="rightpanel">
          {session && view === 'session' ? (
            <>
              <AgentTree session={session} />
              <SessionDetails session={session} />
            </>
          ) : null}
        </aside>
      </div>
      <ApprovalDrawer />
    </div>
  );
}
