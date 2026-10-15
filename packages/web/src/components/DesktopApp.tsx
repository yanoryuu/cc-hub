// デスクトップレイアウト(幅 900px 以上): 上部バー / 左サイドバー / 中央ターミナル / 右パネル
// 中央はセッション / ゲーム / リポジトリ / PR / スキル / MCP(セッション以外の表示中は右パネルを畳んで中央を広げる)
import { useEffect } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { type RightTab, orderedSessions, useHub } from '../store';
import { TopBar } from './TopBar';
import { SessionList, SortControl } from './SessionList';
import { SessionPane } from './SessionPane';
import { ShellScreen } from './Shell';
import { AgentTree } from './AgentTree';
import { SessionDetails } from './SessionDetails';
import { LauncherBar } from './Launchers';
import { ApprovalList, useApprovalCount } from './Approval';
import { useClaudeDeploysInFlight } from './Deploy';
import { SettingsScreen } from './Settings';
import { StatusBadge, WhereTag } from './common';
import { GameView } from './GameView';
import { RegisterRepoForm, RepoListPage, RepoPage, SidebarRepos } from './Repos';
import { PrScreen, SidebarPrs } from './Prs';
import { SessionGit } from './SessionGit';
import { SkillsView } from './Skills';
import { McpView } from './Mcp';
import { PowerShellButton, TakeoverButton } from './Handoff';
import { useScopeCwd } from '../ext';
import { ProjectScreen } from './Project';
import { HomeScreen } from './Home';
import { HistoryView } from './History';
import { TOP_ORDER } from './TopBar';

function ApprovalDrawer() {
  const open = useHub((s) => s.approvalDrawer);
  const setOpen = useHub((s) => s.setApprovalDrawer);
  const openSession = useHub((s) => s.open);
  // Claude のアップロード申請と、承認後に進んでいるアップロードも数える(進み具合を見ている間は閉じない)
  const pending = useApprovalCount() + useClaudeDeploysInFlight().filter((d) => d.state !== 'done' && d.state !== 'failed').length;
  // 最後の承認に答えて空になったら、少し間を置いて自動で閉じる(空のドロワーが出しっぱなしになるのを防ぐ)
  useEffect(() => {
    if (!open || pending > 0) return;
    const t = setTimeout(() => setOpen(false), 1200);
    return () => clearTimeout(t);
  }, [open, pending, setOpen]);
  // Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
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

const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'details', label: '詳細' },
  { id: 'skills', label: 'スキル' },
  { id: 'mcp', label: 'MCP' },
];

/** 右パネル: 詳細(エージェント / ブランチ / セッション)・スキル・MCP のタブ */
function RightPanel({ session }: { session: SessionInfo }) {
  const tab = useHub((s) => s.rightTab);
  const setTab = useHub((s) => s.setRightTab);
  return (
    <>
      <div className="rp-tabs" role="tablist" aria-label="右パネル">
        {RIGHT_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`rp-tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'skills' ? (
        <SkillsView cwd={session.cwd} compact />
      ) : tab === 'mcp' ? (
        <McpView cwd={session.cwd} compact />
      ) : (
        <>
          <AgentTree session={session} />
          <SessionGit session={session} />
          <SessionDetails session={session} />
        </>
      )}
    </>
  );
}

/** サイドバー下部のナビ(スキル / MCP / ゲーム) */
function SideNav() {
  const view = useHub((s) => s.deskView);
  const setView = useHub((s) => s.setDeskView);
  const item = (v: 'skills' | 'mcp' | 'game' | 'shell', label: string, ico: string) => (
    <button
      className={`side-nav-btn ${view === v ? 'on' : ''}`}
      aria-current={view === v ? 'page' : undefined}
      onClick={() => setView(view === v ? 'session' : v)}
    >
      <span className="side-nav-ico" aria-hidden="true">
        {ico}
      </span>
      {label}
    </button>
  );
  return (
    <nav className="sidebar-foot side-nav" aria-label="その他の画面">
      {item('skills', 'スキル', '✦')}
      {item('mcp', 'MCP', '⛁')}
      {item('game', 'ゲーム', '▶')}
      {item('shell', 'PowerShell', '›_')}
    </nav>
  );
}

export function DesktopApp() {
  const selectedId = useHub((s) => s.selectedId);
  const session = useHub((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined));
  const repo = useHub((s) => (session?.repoId ? s.repos[session.repoId] : undefined));
  const loaded = useHub((s) => s.loaded);
  const openSession = useHub((s) => s.open);
  const view = useHub((s) => s.deskView);
  const repoRoute = useHub((s) => s.repoRoute);
  const scopeCwd = useScopeCwd();

  // Ctrl+1..9: セッション切替(一覧に表示している順) / Ctrl+Shift+A: 承認キュー
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+1〜4: 上部の大分類(プロジェクト / セッション / 履歴 / PR)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const m = /^Digit([1-4])$/.exec(e.code) ?? /^([1-4])$/.exec(e.key);
        if (m) {
          e.preventDefault();
          e.stopPropagation();
          useHub.getState().setTopView(TOP_ORDER[parseInt(m[1], 10) - 1]);
        }
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const st = useHub.getState();
        const s = orderedSessions(st.sessions, st.repos, st.worktrees, st.sortOpts)[parseInt(e.key, 10) - 1];
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

  // セッション以外(リポジトリ / PR / スキル / MCP)の表示中は右パネルを畳んで中央を広げる
  const wide = view !== 'session' && view !== 'game';
  const setTopView = useHub((s) => s.setTopView);

  return (
    <div className="desk">
      <TopBar />
      <div className={`desk-body ${wide ? 'wide' : ''}`}>
        <aside className="sidebar">
          <div className="side-head">
            <span className="side-head-title">セッション</span>
            <SortControl />
          </div>
          <SessionList onPick={openSession} activeOnlyInSessionView={view !== 'session'} />
          <SidebarPrs />
          <SidebarRepos />
          <SideNav />
        </aside>
        <main className="center">
          {view === 'game' ? (
            <GameView />
          ) : view === 'shell' ? (
            <ShellScreen />
          ) : view === 'home' || (view === 'repos' && repoRoute.page === 'list') ? (
            <div className="repo-scroll">
              <HomeScreen />
            </div>
          ) : view === 'settings' ? (
            <div className="repo-scroll">
              <SettingsScreen />
            </div>
          ) : view === 'history' ? (
            <HistoryView />
          ) : view === 'project' ? (
            <ProjectScreen />
          ) : view === 'skills' ? (
            <div className="repo-scroll">
              <div className="repo-page ext-page">
                <SkillsView cwd={scopeCwd} />
              </div>
            </div>
          ) : view === 'mcp' ? (
            <div className="repo-scroll">
              <div className="repo-page ext-page">
                <McpView cwd={scopeCwd} />
              </div>
            </div>
          ) : view === 'prs' ? (
            <div className="repo-scroll">
              <PrScreen />
            </div>
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
                  <span className="pane-name" title={session.name}>
                    {session.name}
                  </span>
                  <StatusBadge status={session.status} />
                  <WhereTag session={session} />
                  {session.branch ? (
                    <span className="pane-branch mono" title={`${repo ? `${repo.id} / ` : ''}${session.branch}\n${session.cwd}`}>
                      {repo && <span className="pane-repo">{repo.name}</span>}
                      {session.branch}
                    </span>
                  ) : (
                    <span className="pane-cwd mono" title={session.cwd}>
                      {session.cwd}
                    </span>
                  )}
                  <span className="spacer" />
                  <LauncherBar session={session} />
                  {session.managed ? (
                    <PowerShellButton session={session} className="btn ghost sm head-act" />
                  ) : (
                    <TakeoverButton session={session} className="btn primary sm head-act" />
                  )}
                  {fontCtl}
                </div>
              )}
            />
          ) : (
            <div className="empty big">
              {loaded ? (selectedId ? 'セッションが見つかりません' : 'セッションがありません。「+ 新規セッション」から起動できます') : '読み込み中…'}
              {loaded && (
                <button className="btn" onClick={() => setTopView('projects')}>
                  プロジェクト一覧へ
                </button>
              )}
            </div>
          )}
        </main>
        {!wide && <aside className="rightpanel">{session && view === 'session' ? <RightPanel session={session} /> : null}</aside>}
      </div>
      <ApprovalDrawer />
    </div>
  );
}
