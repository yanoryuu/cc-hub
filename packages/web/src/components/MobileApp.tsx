// モバイルレイアウト(幅 900px 未満): 下タブ セッション / 承認 / PR / リポジトリ / その他(スキル・MCP・ゲーム)
import { useState } from 'react';
import { type MoreView, useHub } from '../store';
import { SessionList, SortControl } from './SessionList';
import { SessionPane } from './SessionPane';
import { ApprovalList, useApprovalSessions } from './Approval';
import { GameView } from './GameView';
import { AgentTree } from './AgentTree';
import { SessionDetails } from './SessionDetails';
import { SkillsView } from './Skills';
import { McpView } from './Mcp';
import { mcpCounts, useMcp, useScopeCwd } from '../ext';
import { ConnDot, UsageMeters } from './TopBar';
import { STATUS_ICON, STATUS_LABEL } from '../util';
import { RegisterRepoForm, RepoListPage, RepoPage } from './Repos';
import { PrDetailPage, PrListPage, RefreshPrsButton } from './Prs';
import { SessionGit } from './SessionGit';
import { needsAttention, usePrGroups } from '../pr';
import { ProjectScreen } from './Project';

/** PR タブ: 一覧 → 詳細 */
function PrMobileScreen() {
  const route = useHub((s) => s.prRoute);
  const pr = useHub((s) => (route.page === 'pr' ? s.prs[route.id] : undefined));
  const openPr = useHub((s) => s.openPr);
  if (route.page === 'pr') {
    return (
      <div className="m-screen">
        <div className="m-head">
          <button className="icon-btn back" onClick={() => openPr(null)} aria-label="一覧へ戻る">
            ‹
          </button>
          <span className="m-title">
            {pr ? `PR #${pr.number}` : 'PR'}
            <span className="m-sub muted">{pr?.repoId ?? route.id}</span>
          </span>
          <RefreshPrsButton compact />
        </div>
        <div className="m-scroll">
          <PrDetailPage key={route.id} id={route.id} mobile />
        </div>
      </div>
    );
  }
  return (
    <div className="m-screen">
      <div className="m-head">
        <span className="m-title">PR</span>
        <RefreshPrsButton compact />
      </div>
      <div className="m-scroll">
        <PrListPage mobile />
      </div>
    </div>
  );
}

/** リポジトリタブ: 一覧 → 詳細 / 登録 */
function RepoScreen() {
  const route = useHub((s) => s.repoRoute);
  const repo = useHub((s) => (route.page === 'repo' ? s.repos[route.id] : undefined));
  const openRepos = useHub((s) => s.openRepos);
  const back = (
    <button className="icon-btn back" onClick={() => openRepos({ page: 'list' })} aria-label="一覧へ戻る">
      ‹
    </button>
  );
  if (route.page === 'register') {
    return (
      <div className="m-screen">
        <div className="m-head">
          {back}
          <span className="m-title">リポジトリを登録</span>
        </div>
        <div className="m-scroll">
          <RegisterRepoForm mobile />
        </div>
      </div>
    );
  }
  if (route.page === 'repo') {
    return (
      <div className="m-screen">
        <div className="m-head">
          {back}
          <span className="m-title">
            {repo?.name ?? route.id}
            {repo && <span className="m-sub muted">{repo.owner}</span>}
          </span>
        </div>
        <div className="m-scroll">
          <RepoPage key={route.id} id={route.id} mobile />
        </div>
      </div>
    );
  }
  return (
    <div className="m-screen">
      <div className="m-head">
        <span className="m-title">リポジトリ</span>
        <button className="btn primary sm" onClick={() => openRepos({ page: 'register' })}>
          + 登録
        </button>
      </div>
      <div className="m-scroll">
        <RepoListPage mobile />
      </div>
    </div>
  );
}

function SessionDetailView() {
  const session = useHub((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined));
  const setDetail = useHub((s) => s.setMobileDetail);
  const [info, setInfo] = useState(false);
  if (!session) {
    return (
      <div className="m-screen">
        <div className="m-head">
          <button className="icon-btn back" onClick={() => setDetail(false)} aria-label="一覧へ戻る">
            ‹
          </button>
          <span className="m-title">セッションが見つかりません</span>
        </div>
      </div>
    );
  }
  return (
    <SessionPane
      key={session.id}
      session={session}
      desktop={false}
      header={(fontCtl) => (
        <>
          <div className="m-head">
            <button className="icon-btn back" onClick={() => setDetail(false)} aria-label="一覧へ戻る">
              ‹
            </button>
            <span className="m-title">
              {session.name}
              <span className={`m-sub st-${session.status}`}>
                <span aria-hidden="true">{STATUS_ICON[session.status]}</span> {STATUS_LABEL[session.status]}
                {!session.managed && (session.handedOff ? ' · PowerShell で実行中' : ' · 外部セッション')}
              </span>
            </span>
            {fontCtl}
            <button
              className={`icon-btn ${info ? 'on' : ''}`}
              onClick={() => setInfo((v) => !v)}
              aria-label="詳細"
              aria-expanded={info}
            >
              ⓘ
            </button>
          </div>
          {info && (
            <div className="m-info">
              <AgentTree session={session} />
              <SessionGit session={session} />
              <SessionDetails session={session} />
            </div>
          )}
        </>
      )}
    />
  );
}

const MORE_ITEMS: { v: Exclude<MoreView, 'menu'>; label: string; ico: string; desc: string }[] = [
  { v: 'skills', label: 'スキル', ico: '✦', desc: '使えるスキルとコマンドの一覧。タップで入力欄に入れる' },
  { v: 'mcp', label: 'MCP の接続状況', ico: '⛁', desc: 'MCP サーバーがつながっているか' },
  { v: 'game', label: 'ゲームキャプチャ', ico: '▶', desc: 'PC のウィンドウを見ながら操作' },
];

/** 「その他」タブ: メニュー → スキル / MCP / ゲーム */
function MoreScreen() {
  const view = useHub((s) => s.moreView);
  const openMore = useHub((s) => s.openMore);
  const cwd = useScopeCwd();
  const mcp = useMcp(cwd);
  if (view === 'game') {
    return (
      <div className="m-screen">
        <div className="m-head">
          <button className="icon-btn back" onClick={() => openMore('menu')} aria-label="その他へ戻る">
            ‹
          </button>
          <span className="m-title">ゲームキャプチャ</span>
        </div>
        <GameView />
      </div>
    );
  }
  if (view === 'skills' || view === 'mcp') {
    return (
      <div className="m-screen">
        <div className="m-head">
          <button className="icon-btn back" onClick={() => openMore('menu')} aria-label="その他へ戻る">
            ‹
          </button>
          <span className="m-title">{view === 'skills' ? 'スキル' : 'MCP の接続状況'}</span>
        </div>
        <div className="m-scroll">{view === 'skills' ? <SkillsView cwd={cwd} compact /> : <McpView cwd={cwd} compact />}</div>
      </div>
    );
  }
  const c = mcpCounts(mcp.data?.servers ?? []);
  return (
    <div className="m-screen">
      <div className="m-head">
        <span className="m-title">その他</span>
      </div>
      <div className="m-scroll">
        <ul className="more-list">
          {MORE_ITEMS.map((it) => (
            <li key={it.v}>
              <button className="more-item" onClick={() => openMore(it.v)}>
                <span className="more-ico" aria-hidden="true">
                  {it.ico}
                </span>
                <span className="more-main">
                  <span className="more-label">{it.label}</span>
                  <span className="more-desc">
                    {it.v === 'mcp' && mcp.data
                      ? `${c.connected}/${c.total} 接続${c.failed ? ` · 失敗 ${c.failed}` : ''}${c.needs_auth ? ` · 要認証 ${c.needs_auth}` : ''}`
                      : it.desc}
                  </span>
                </span>
                <span className="more-go" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function MobileApp() {
  const tab = useHub((s) => s.mobileTab);
  const setTab = useHub((s) => s.setMobileTab);
  const openMore = useHub((s) => s.openMore);
  const detail = useHub((s) => s.mobileDetail);
  const projectOpen = useHub((s) => s.mobileProject);
  const open = useHub((s) => s.open);
  const setNew = useHub((s) => s.setNewSessionOpen);
  const approvals = useApprovalSessions();
  const prGroups = usePrGroups();
  // PR タブのバッジ: 対応が必要な自分の PR + レビュー依頼
  const prBadge = prGroups.mine.filter(needsAttention).length + prGroups.review.length;

  let body: React.ReactNode;
  if (projectOpen) {
    // 管理画面(全画面。戻るで元のタブへ)
    body = <ProjectScreen mobile />;
  } else if (tab === 'sessions' && detail) {
    body = <SessionDetailView />;
  } else if (tab === 'sessions') {
    body = (
      <div className="m-screen">
        <div className="m-head">
          <ConnDot />
          <span className="m-title">CC Hub</span>
          <button className="btn primary sm" onClick={() => setNew(true)}>
            + 新規
          </button>
        </div>
        <div className="m-scroll">
          <div className="m-usage">
            <UsageMeters compact />
          </div>
          <div className="m-sort">
            <SortControl />
          </div>
          <SessionList onPick={open} />
        </div>
      </div>
    );
  } else if (tab === 'approvals') {
    body = (
      <div className="m-screen">
        <div className="m-head">
          <span className="m-title">承認待ち</span>
        </div>
        <div className="m-scroll pad">
          <ApprovalList onOpen={open} />
        </div>
      </div>
    );
  } else if (tab === 'prs') {
    body = <PrMobileScreen />;
  } else if (tab === 'repos') {
    body = <RepoScreen />;
  } else {
    body = <MoreScreen />;
  }

  const tabBtn = (t: typeof tab, label: string, badge?: React.ReactNode) => (
    <button
      className={tab === t ? 'active' : ''}
      aria-current={tab === t ? 'page' : undefined}
      onClick={() => (t === 'more' && tab === 'more' ? openMore('menu') : setTab(t))}
    >
      {label}
      {badge}
    </button>
  );

  return (
    <div className="mobile">
      <div className="m-body">{body}</div>
      <nav className="tabbar" aria-label="画面の切り替え">
        {tabBtn('sessions', 'セッション')}
        {tabBtn('approvals', '承認', approvals.length > 0 && <span className="tab-badge">{approvals.length}</span>)}
        {tabBtn('prs', 'PR', prBadge > 0 && <span className="tab-badge pr">{prBadge}</span>)}
        {tabBtn('repos', 'リポジトリ')}
        {tabBtn('more', 'その他')}
      </nav>
    </div>
  );
}
