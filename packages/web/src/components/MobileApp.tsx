// モバイルレイアウト(幅 900px 未満): 下タブ セッション / 承認 / PR / リポジトリ / ゲーム
import { useState } from 'react';
import { useHub } from '../store';
import { SessionList } from './SessionList';
import { SessionPane } from './SessionPane';
import { ApprovalList, useApprovalSessions } from './Approval';
import { GameView } from './GameView';
import { AgentTree } from './AgentTree';
import { SessionDetails } from './SessionDetails';
import { StatusDot } from './common';
import { ConnDot, UsageMeters } from './TopBar';
import { STATUS_LABEL } from '../util';
import { RegisterRepoForm, RepoListPage, RepoPage } from './Repos';
import { PrDetailPage, PrListPage, RefreshPrsButton } from './Prs';
import { SessionGit } from './SessionGit';
import { needsAttention, usePrGroups } from '../pr';

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
            <StatusDot status={session.status} />
            <span className="m-title">
              {session.name}
              <span className={`m-sub st-${session.status}`}>
                {STATUS_LABEL[session.status]}
                {!session.managed && ' · 読み取り専用'}
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

export function MobileApp() {
  const tab = useHub((s) => s.mobileTab);
  const setTab = useHub((s) => s.setMobileTab);
  const detail = useHub((s) => s.mobileDetail);
  const open = useHub((s) => s.open);
  const setNew = useHub((s) => s.setNewSessionOpen);
  const approvals = useApprovalSessions();
  const prGroups = usePrGroups();
  // PR タブのバッジ: 対応が必要な自分の PR + レビュー依頼
  const prBadge = prGroups.mine.filter(needsAttention).length + prGroups.review.length;

  let body: React.ReactNode;
  if (tab === 'sessions' && detail) {
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
    body = (
      <div className="m-screen">
        <GameView />
      </div>
    );
  }

  return (
    <div className="mobile">
      <div className="m-body">{body}</div>
      <nav className="tabbar">
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
          セッション
        </button>
        <button className={tab === 'approvals' ? 'active' : ''} onClick={() => setTab('approvals')}>
          承認
          {approvals.length > 0 && <span className="tab-badge">{approvals.length}</span>}
        </button>
        <button className={tab === 'prs' ? 'active' : ''} onClick={() => setTab('prs')}>
          PR
          {prBadge > 0 && <span className="tab-badge pr">{prBadge}</span>}
        </button>
        <button className={tab === 'repos' ? 'active' : ''} onClick={() => setTab('repos')}>
          リポジトリ
        </button>
        <button className={tab === 'game' ? 'active' : ''} onClick={() => setTab('game')}>
          ゲーム
        </button>
      </nav>
    </div>
  );
}
