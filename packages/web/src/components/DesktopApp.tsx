// デスクトップレイアウト(幅 900px 以上): 上部バー / 左サイドバー / 中央ターミナル / 右パネル
// 中央はセッション / ゲーム / リポジトリ(リポジトリ表示中は右パネルを畳んで中央を広げる)
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
import { RegisterRepoForm, RepoListPage, RepoPage, SidebarRepos } from './Repos';

function ApprovalDrawer() {
  const open = useHub((s) => s.approvalDrawer);
  const setOpen = useHub((s) => s.setApprovalDrawer);
  const openSession = useHub((s) => s.open);
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
              openSession(id);
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
  const repo = useHub((s) => (session?.repoId ? s.repos[session.repoId] : undefined));
  const loaded = useHub((s) => s.loaded);
  const openSession = useHub((s) => s.open);
  const view = useHub((s) => s.deskView);
  const setView = useHub((s) => s.setDeskView);
  const repoRoute = useHub((s) => s.repoRoute);

  // Ctrl+1..9: セッション切替 / Ctrl+Shift+A: 承認キュー
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const st = useHub.getState();
        const s = orderedSessions(st.sessions, st.repos)[parseInt(e.key, 10) - 1];
        if (s) {
          e.preventDefault();
          e.stopPropagation();
          st.open(s.id);
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

  const wide = view === 'repos';

  return (
    <div className="desk">
      <TopBar />
      <div className={`desk-body ${wide ? 'wide' : ''}`}>
        <aside className="sidebar">
          <SessionList onPick={openSession} activeOnlyInSessionView={view !== 'session'} />
          <SidebarRepos />
          <div className="sidebar-foot">
            <button className={`btn ghost ${view === 'game' ? 'on' : ''}`} onClick={() => setView(view === 'game' ? 'session' : 'game')}>
              ゲームキャプチャ
            </button>
          </div>
        </aside>
        <main className="center">
          {view === 'game' ? (
            <GameView />
          ) : view === 'repos' ? (
            <div className="repo-scroll">
              {repoRoute.page === 'register' ? (
                <RegisterRepoForm />
              ) : repoRoute.page === 'repo' ? (
                <RepoPage key={repoRoute.id} id={repoRoute.id} />
              ) : (
                <RepoListPage />
              )}
            </div>
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
                  {session.branch && (
                    <span className="pane-branch mono" title={repo ? `${repo.id} / ${session.branch}` : session.branch}>
                      {repo && <span className="pane-repo">{repo.name}</span>}
                      {session.branch}
                    </span>
                  )}
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
        {!wide && (
          <aside className="rightpanel">
            {session && view === 'session' ? (
              <>
                <AgentTree session={session} />
                <SessionDetails session={session} />
              </>
            ) : null}
          </aside>
        )}
      </div>
      <ApprovalDrawer />
    </div>
  );
}
