// フォルダ(プロジェクト)ごとの管理画面: セッション / 作業ツリーで何をしているか / アーティファクト / PR / Git / トークン
// デスクトップは中央の表示(右パネルは畳む)、モバイルは全画面のページ(戻るボタン付き)
import { useEffect, useMemo, useState } from 'react';
import type { GitTarget, PrInfo, ProjectOverview, SessionInfo } from '@cc-hub/shared';
import { type ProjectRoute, type ProjectTab, isFinished, useHub } from '../store';
import {
  type LiveTokens,
  changeCount,
  computeLiveTokens,
  diffTotals,
  fmtExact,
  fmtTokens,
  projectTitle,
  sessionTokens,
  useProjectOverview,
  useProjectSessions,
} from '../project';
import { fmtAgo, findSessionPr, needsAttention } from '../pr';
import { needsRelease } from '../repo';
import { STATUS_ICON, fmtCost, fmtDate, useNow } from '../util';
import { StatusBadge, toolText } from './common';
import { Spinner } from './RepoCommon';
import { CheckIcon, PrChip, PrRow } from './Prs';
import { RepoPage } from './Repos';
import { ArtifactsTab } from './ProjectArtifacts';
import { GitTab } from './ProjectGit';
import { TokenTotals, TokensTab } from './ProjectTokens';
import { HistoryView } from './History';

const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: '概要' },
  { id: 'sessions', label: 'セッション' },
  { id: 'worktrees', label: '作業ツリー' },
  { id: 'artifacts', label: 'アーティファクト' },
  { id: 'prs', label: 'PR' },
  { id: 'git', label: 'Git' },
  { id: 'tokens', label: 'トークン' },
  { id: 'history', label: '履歴' },
  { id: 'settings', label: '設定' },
];

/** 管理画面(ストアの project を表示)。モバイルは戻るボタン付きの全画面 */
export function ProjectScreen({ mobile = false }: { mobile?: boolean }) {
  const route = useHub((s) => s.project);
  const close = useHub((s) => s.closeProject);
  if (!route) {
    return (
      <div className="empty big">
        管理画面を開くフォルダがありません
        {mobile && (
          <button className="btn" onClick={close}>
            戻る
          </button>
        )}
      </div>
    );
  }
  return <ProjectDashboard key={`${route.repoId ?? ''}|${route.cwd ?? ''}`} route={route} mobile={mobile} />;
}

function ProjectDashboard({ route, mobile }: { route: ProjectRoute; mobile: boolean }) {
  const repos = useHub((s) => s.repos);
  const storeSessions = useHub((s) => s.sessions);
  const worktrees = useHub((s) => s.worktrees);
  const prsAll = useHub((s) => s.prs);
  const tab = useHub((s) => s.projectTab);
  const setTab = useHub((s) => s.setProjectTab);
  const close = useHub((s) => s.closeProject);
  const setNew = useHub((s) => s.setNewSessionOpen);
  const { data, error, loading, fetchedAt, reload } = useProjectOverview(route);
  const sessions = useProjectSessions(route, data);
  const repo = route.repoId ? repos[route.repoId] : undefined;
  const [gitTarget, setGitTarget] = useState('');

  const tokens = useMemo(() => computeLiveTokens(sessions, data?.tokens), [sessions, data?.tokens]);
  const active = sessions.filter((s) => !isFinished(s, worktrees));
  // PR: 管理画面の prIds + (リポジトリなら)同じリポジトリの PR / (フォルダなら)セッションに紐付いた PR
  const prs = useMemo(() => {
    const ids = new Set(data?.prIds ?? []);
    for (const p of Object.values(prsAll)) {
      if (route.repoId ? p.repoId === route.repoId : p.sessionId && sessions.some((s) => s.id === p.sessionId)) ids.add(p.id);
    }
    return [...ids]
      .map((id) => prsAll[id])
      .filter((p): p is PrInfo => !!p)
      .sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.updatedAt - a.updatedAt);
  }, [data?.prIds, prsAll, route.repoId, sessions]);
  const openPrs = prs.filter((p) => p.state === 'OPEN');
  const wtInUse = data ? data.targets.filter((t) => t.kind === 'worktree' && t.sessionId).length : 0;
  const changes = data ? data.targets.reduce((n, t) => n + changeCount(t), 0) : 0;
  const name = data?.name || projectTitle(route, repos);
  const path = data?.path || repo?.baseDir || route.cwd || '';

  // Git タブの対象: 未選択なら変更のあるターゲット → 先頭
  useEffect(() => {
    if (!data || data.targets.length === 0) return;
    if (gitTarget && data.targets.some((t) => t.id === gitTarget)) return;
    const withChanges = data.targets.find((t) => changeCount(t) > 0);
    setGitTarget((withChanges ?? data.targets[0]).id);
  }, [data, gitTarget]);

  const tabs = TABS.filter((t) => t.id !== 'settings' || !!route.repoId);
  const badge = (id: ProjectTab): string | null => {
    if (!data) return null;
    if (id === 'sessions') return String(active.length);
    if (id === 'artifacts') return String(data.artifacts.length);
    if (id === 'prs') return String(openPrs.length);
    if (id === 'git') return changes ? String(changes) : null;
    if (id === 'worktrees') return String(data.targets.length);
    return null;
  };

  const newSession = () => (route.repoId ? setNew(true, route.repoId) : setNew(true, null, route.cwd));
  const gotoGit = (targetId: string) => {
    setGitTarget(targetId);
    setTab('git');
  };

  const stats = (
    <div className="pj-stats" role="list" aria-label="概要の数値">
      <PjStat label="動いているセッション" value={String(active.length)} onClick={() => setTab('sessions')} />
      {route.repoId && <PjStat label="使用中の作業ツリー" value={String(wtInUse)} onClick={() => setTab('worktrees')} />}
      <PjStat label="Open の PR" value={String(openPrs.length)} onClick={() => setTab('prs')} />
      <PjStat label="未コミットの変更" value={String(changes)} onClick={() => setTab('git')} />
      <div className="pj-stat pj-tokens" role="listitem">
        <button className="pj-stat-btn" onClick={() => setTab('tokens')} aria-label={`トークン 合計 ${fmtExact(tokens.total.input + tokens.total.output)}(入力+出力)。トークンタブを開く`}>
          <TokenTotals t={tokens.total} live={tokens.live} compact />
        </button>
      </div>
    </div>
  );

  const tabBar = (
    <div className={`pj-tabs ${mobile ? 'is-mobile' : ''}`} role="tablist" aria-label="管理画面のタブ">
      {tabs.map((t) => {
        const b = badge(t.id);
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`pj-tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {b !== null && <span className="pj-tab-n">{b}</span>}
          </button>
        );
      })}
    </div>
  );

  let body: React.ReactNode;
  if (tab === 'history') {
    // リポジトリはベースディレクトリ(worktree を含む)配下の会話
    body = <HistoryView cwd={repo?.baseDir ?? route.cwd ?? path} mobile={mobile} embedded />;
  } else if (tab === 'settings' && route.repoId) {
    body = <RepoPage id={route.repoId} mobile={mobile} embedded />;
  } else if (!data) {
    body = error ? (
      <div className="rp-alert error" role="alert">
        <span className="rp-alert-ico" aria-hidden="true">
          !
        </span>
        <span>
          {error}{' '}
          <button className="link-btn" onClick={reload}>
            再試行
          </button>
        </span>
      </div>
    ) : (
      <div className="empty">{loading ? <><Spinner /> 読み込み中…</> : 'データがありません'}</div>
    );
  } else if (tab === 'overview') {
    body = <OverviewTab data={data} sessions={sessions} prs={prs} tokens={tokens} gotoGit={gotoGit} />;
  } else if (tab === 'sessions') {
    body = <SessionsTab sessions={sessions} data={data} tokens={tokens} mobile={mobile} />;
  } else if (tab === 'worktrees') {
    body = <WorktreesTab data={data} gotoGit={gotoGit} />;
  } else if (tab === 'artifacts') {
    body = <ArtifactsTab data={data} sessions={storeSessions} mobile={mobile} />;
  } else if (tab === 'prs') {
    body = <PrsTab prs={prs} />;
  } else if (tab === 'git') {
    body = <GitTab data={data} targetId={gitTarget} setTargetId={setGitTarget} sessions={storeSessions} reload={reload} mobile={mobile} />;
  } else {
    body = <TokensTab tokens={tokens} sessions={sessions} mobile={mobile} />;
  }

  const stale = error && data ? (
    <div className="pj-stale" role="status">
      ⚠ 最新の情報を取得できませんでした({error})。{fetchedAt ? `${fmtAgo(fetchedAt)}の情報を表示しています。` : ''}
    </div>
  ) : null;

  if (mobile) {
    return (
      <div className="m-screen pj-mobile">
        <div className="m-head">
          <button className="btn ghost sm pj-back" onClick={close} aria-label="プロジェクト一覧へ戻る">
            ← 一覧
          </button>
          <span className="m-title">
            {name}
            <span className="m-sub muted mono">{route.repoId ?? path}</span>
          </span>
          <button className="btn primary sm" onClick={newSession} disabled={!!repo && repo.status !== 'ready'}>
            + セッション
          </button>
        </div>
        {tabBar}
        <div className="m-scroll">
          <div className="pj-page is-mobile">
            {tab === 'overview' && stats}
            {stale}
            {body}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="repo-scroll">
      <div className="pj-page">
        <button className="btn ghost sm pj-back" onClick={close} title="プロジェクト一覧へ(Alt+1)">
          ← プロジェクト一覧
        </button>
        <div className="rp-head wrap pj-head">
          <span className="pj-ico" aria-hidden="true">
            {route.repoId ? '⑂' : '▤'}
          </span>
          <h2 className="rp-title">
            {name}
            {repo && <span className="rp-owner">{repo.owner}</span>}
          </h2>
          <span className="pj-path mono muted" title={path}>
            {path}
          </span>
          <span className="spacer" />
          {repo && (
            <a className="btn ghost sm" href={repo.url} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          )}
          <button className="btn primary" onClick={newSession} disabled={!!repo && repo.status !== 'ready'}>
            + セッション
          </button>
        </div>
        {stats}
        {tabBar}
        {stale}
        <div className="pj-body" role="tabpanel">
          {body}
        </div>
      </div>
    </div>
  );
}

function PjStat({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <div className="pj-stat" role="listitem">
      <button className="pj-stat-btn" onClick={onClick}>
        <span className="pj-stat-num">{value}</span>
        <span className="pj-stat-label">{label}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 概要

interface AttnItem {
  key: string;
  tone: 'approval' | 'input' | 'error' | 'release';
  ico: string;
  label: string;
  title: string;
  sub: string;
  action: string;
  go: () => void;
}

function OverviewTab({
  data,
  sessions,
  prs,
  tokens,
  gotoGit,
}: {
  data: ProjectOverview;
  sessions: SessionInfo[];
  prs: PrInfo[];
  tokens: LiveTokens;
  gotoGit: (id: string) => void;
}) {
  const worktrees = useHub((s) => s.worktrees);
  const open = useHub((s) => s.open);
  const openPr = useHub((s) => s.openPr);
  const prsAll = useHub((s) => s.prs);
  const now = useNow(15000);
  const active = sessions.filter((s) => !isFinished(s, worktrees));
  const targetOf = (s: SessionInfo): GitTarget | undefined =>
    data.targets.find((t) => t.sessionId === s.id) ?? data.targets.find((t) => s.worktreeId && t.id === `wt:${s.worktreeId}`);

  const attn: AttnItem[] = [];
  for (const s of sessions) {
    const wt = s.worktreeId ? worktrees[s.worktreeId] : undefined;
    const w = wt && wt.sessionId === s.id ? wt : null;
    if (s.status === 'awaiting_approval')
      attn.push({ key: `a${s.id}`, tone: 'approval', ico: STATUS_ICON.awaiting_approval, label: '承認待ち', title: s.name, sub: s.approval?.question.split('\n')[0] ?? '', action: '承認する', go: () => open(s.id) });
    else if (s.status === 'awaiting_input')
      attn.push({ key: `i${s.id}`, tone: 'input', ico: STATUS_ICON.awaiting_input, label: '入力待ち', title: s.name, sub: s.lastMessage ?? '', action: '指示する', go: () => open(s.id) });
    else if (s.status === 'error')
      attn.push({ key: `e${s.id}`, tone: 'error', ico: STATUS_ICON.error, label: 'エラー', title: s.name, sub: s.lastMessage ?? '', action: '開く', go: () => open(s.id) });
    if (needsRelease(s, w))
      attn.push({ key: `r${s.id}`, tone: 'release', ico: '⟲', label: '要解放', title: s.name, sub: '停止済み。作業ツリーを解放してプールに戻せます', action: '開く', go: () => open(s.id) });
  }
  for (const p of prs) {
    if (p.state === 'OPEN' && p.checks === 'failure')
      attn.push({ key: `p${p.id}`, tone: 'error', ico: '✗', label: 'CI 失敗', title: `#${p.number} ${p.title}`, sub: `${p.checksSummary.failed} 件のチェックが失敗`, action: 'PR を開く', go: () => openPr(p.id) });
    else if (needsAttention(p))
      attn.push({ key: `p${p.id}`, tone: 'approval', ico: '!', label: p.mergeable === 'CONFLICTING' ? 'コンフリクト' : '修正依頼', title: `#${p.number} ${p.title}`, sub: p.headRefName, action: 'PR を開く', go: () => openPr(p.id) });
  }

  return (
    <div className="pj-overview">
      <section className="rp-sec">
        <h3 className="sec-title">
          要対応 <span className="count-pill">{attn.length}</span>
        </h3>
        {attn.length === 0 ? (
          <div className="pj-ok muted">✓ 対応が必要なものはありません</div>
        ) : (
          <ul className="attn-list">
            {attn.map((a) => (
              <li key={a.key} className={`attn-row t-${a.tone}`}>
                <span className="attn-kind">
                  <span aria-hidden="true">{a.ico}</span> {a.label}
                </span>
                <span className="attn-main">
                  <span className="attn-title">{a.title}</span>
                  {a.sub && <span className="attn-sub">{a.sub}</span>}
                </span>
                <button className="btn sm" onClick={a.go}>
                  {a.action}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rp-sec">
        <h3 className="sec-title">
          いまの作業 <span className="count-pill">{active.length}</span>
        </h3>
        {active.length === 0 ? (
          <div className="empty small">動いているセッションはありません。「+ セッション」から始められます。</div>
        ) : (
          <div className="work-cards">
            {active.map((s) => (
              <WorkCard
                key={s.id}
                s={s}
                t={targetOf(s)}
                pr={findSessionPr(prsAll, s)}
                tok={tokens.bySession[s.id] ?? sessionTokens(s, data.tokens)}
                now={now}
                onOpen={() => open(s.id)}
                onOpenPr={(id) => openPr(id)}
                onGit={gotoGit}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkCard({
  s,
  t,
  pr,
  tok,
  now,
  onOpen,
  onOpenPr,
  onGit,
}: {
  s: SessionInfo;
  t: GitTarget | undefined;
  pr: PrInfo | null;
  tok: ReturnType<typeof sessionTokens>;
  now: number;
  onOpen: () => void;
  onOpenPr: (id: string) => void;
  onGit: (id: string) => void;
}) {
  const tool = toolText(s);
  const d = t ? diffTotals(t) : null;
  const n = t ? changeCount(t) : 0;
  return (
    <article className={`work-card st-${s.status}`}>
      <header className="work-head">
        <StatusBadge status={s.status} />
        <button className="work-name" onClick={onOpen} title="セッションを開く">
          {s.name}
        </button>
        <span className="spacer" />
        <span className="muted small" title={fmtDate(s.lastEventAt)}>
          {fmtAgo(s.lastEventAt, now)}
        </span>
      </header>
      <div className="work-task">
        <span className="work-k">作業</span>
        <span className="work-v">{s.task || <span className="muted">(最初の指示はまだありません)</span>}</span>
      </div>
      {tool && (
        <div className="work-tool">
          <span className="work-k">ツール</span>
          <span className="work-v mono" title={tool}>
            {tool}
          </span>
        </div>
      )}
      {s.lastMessage && (
        <div className="work-msg">
          <span className="work-k">最後の発言</span>
          <span className="work-v">{s.lastMessage}</span>
        </div>
      )}
      <footer className="work-foot">
        {(s.branch || t) && (
          <span className="work-branch mono" title={t?.path ?? s.cwd}>
            {t && t.kind !== 'dir' && <span className="work-wt">{t.label}</span>}
            {s.branch ?? t?.branch}
          </span>
        )}
        {t && (
          <button className="work-chg" onClick={() => onGit(t.id)} title="Git タブで見る">
            変更 <b>{n}</b>
            {d && (d.add > 0 || d.del > 0) && (
              <span className="diffstat">
                {' '}
                <span className="add">+{d.add}</span> <span className="del">−{d.del}</span>
              </span>
            )}
            {t.unpushed > 0 && <span className="work-unp"> · 未 push {t.unpushed}</span>}
          </button>
        )}
        {pr && <PrChip pr={pr} onClick={() => onOpenPr(pr.id)} />}
        <span className="spacer" />
        {tok && (
          <span className="work-tok mono" title={`入力 ${fmtExact(tok.input)} / 出力 ${fmtExact(tok.output)} / キャッシュ ${fmtExact(tok.cacheRead + tok.cacheCreation)}`}>
            入 {fmtTokens(tok.input)} · 出 {fmtTokens(tok.output)} · {fmtCost(tok.costUsd)}
          </span>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------- セッション

function SessionsTab({
  sessions,
  data,
  tokens,
  mobile,
}: {
  sessions: SessionInfo[];
  data: ProjectOverview;
  tokens: LiveTokens;
  mobile: boolean;
}) {
  const open = useHub((s) => s.open);
  const now = useNow(30000);
  const targetOf = (s: SessionInfo) => data.targets.find((t) => t.sessionId === s.id);
  if (sessions.length === 0) return <div className="rp-empty">このフォルダのセッションはまだありません。</div>;
  if (mobile) {
    return (
      <ul className="pj-sess-cards">
        {sessions.map((s) => {
          const tok = tokens.bySession[s.id];
          const t = targetOf(s);
          return (
            <li key={s.id}>
              <button className="pj-sess-card" onClick={() => open(s.id)}>
                <span className="pj-sess-top">
                  <StatusBadge status={s.status} />
                  <span className="pj-sess-name">{s.name}</span>
                </span>
                {s.task && <span className="pj-sess-task">{s.task}</span>}
                <span className="pj-sess-meta">
                  {(s.branch || t) && <span className="mono accent">{t && t.kind === 'worktree' ? `${t.label} · ` : ''}{s.branch ?? t?.branch}</span>}
                  <span className="muted">{fmtAgo(s.lastEventAt, now)}</span>
                  {tok && (
                    <span className="mono">
                      入 {fmtTokens(tok.input)} / 出 {fmtTokens(tok.output)} · {fmtCost(tok.costUsd)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="wt-table-wrap">
      <table className="wt-table pj-sess-table">
        <thead>
          <tr>
            <th>状態</th>
            <th>名前</th>
            <th>作業内容</th>
            <th>ブランチ / 作業ツリー</th>
            <th>開始</th>
            <th>最終</th>
            <th className="num">入力</th>
            <th className="num">出力</th>
            <th className="num">コスト</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const tok = tokens.bySession[s.id];
            const t = targetOf(s);
            return (
              <tr key={s.id}>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="strong">{s.name}</td>
                <td className="pj-task-cell" title={s.task ?? ''}>
                  {s.task ?? <span className="dim">—</span>}
                </td>
                <td className="mono wt-branch">
                  {s.branch ?? t?.branch ?? <span className="dim">—</span>}
                  {t && t.kind === 'worktree' && <div className="muted small">{t.label}</div>}
                </td>
                <td className="muted nowrap">{fmtDate(s.createdAt)}</td>
                <td className="muted nowrap" title={fmtDate(s.lastEventAt)}>
                  {fmtAgo(s.lastEventAt, now)}
                </td>
                <td className="num mono">{fmtTokens(tok?.input)}</td>
                <td className="num mono">{fmtTokens(tok?.output)}</td>
                <td className="num mono">{fmtCost(tok?.costUsd ?? s.costUsd)}</td>
                <td className="wt-actions">
                  <button className="btn sm" onClick={() => open(s.id)}>
                    開く
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 作業ツリー

function WorktreesTab({ data, gotoGit }: { data: ProjectOverview; gotoGit: (id: string) => void }) {
  const sessions = useHub((s) => s.sessions);
  const open = useHub((s) => s.open);
  const now = useNow(30000);
  if (data.targets.length === 0) return <div className="rp-empty">作業ツリーはありません。</div>;
  const KIND = { worktree: '作業ツリー', base: 'ベース', dir: 'フォルダ' } as const;
  return (
    <div className="wtree-cards">
      {data.targets.map((t) => {
        const s = t.sessionId ? sessions[t.sessionId] : undefined;
        const d = diffTotals(t);
        return (
          <article key={t.id} className="wtree-card">
            <header className="wtree-head">
              <span className="mono strong">{t.label}</span>
              <span className="tag">{KIND[t.kind]}</span>
              {t.branch ? <span className="mono accent wtree-branch">{t.branch}</span> : <span className="muted">ブランチなし</span>}
              <span className="spacer" />
              <span className="muted small" title={fmtDate(t.updatedAt)}>
                更新 {fmtAgo(t.updatedAt, now)}
              </span>
            </header>
            <div className="wtree-stats">
              <span className="gstat" title={`${t.baseRef ?? 'base'} より進んでいる / 遅れている`}>
                ↑{t.ahead} ↓{t.behind}
              </span>
              <span className={`gstat ${t.unpushed > 0 ? 'warn' : ''}`}>未 push {t.unpushed}</span>
              <span className="gstat">ステージ済み {t.staged.length}</span>
              <span className="gstat">未ステージ {t.unstaged.length}</span>
              <span className="gstat">未追跡 {t.untracked.length}</span>
              <span className="diffstat">
                <span className="add">+{d.add}</span> <span className="del">−{d.del}</span>
              </span>
            </div>
            {s ? (
              <div className="wtree-sess">
                <button className="wt-session" onClick={() => open(s.id)} title="セッションを開く">
                  <StatusBadge status={s.status} />
                  <span className="pr-session-name">{s.name}</span>
                </button>
                <span className="wtree-task">{s.task ?? <span className="muted">(作業内容なし)</span>}</span>
              </div>
            ) : (
              <div className="muted small">セッションは使っていません</div>
            )}
            {t.behind > 0 && <div className="git-behind">⚠ base から {t.behind} コミット遅れ(rebase 推奨)</div>}
            <div className="ctl-row">
              <button className="btn sm" onClick={() => gotoGit(t.id)}>
                Git を開く
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- PR

function PrsTab({ prs }: { prs: PrInfo[] }) {
  const now = useNow(30000);
  if (prs.length === 0)
    return (
      <div className="rp-empty">
        <p>このフォルダの PR はまだありません。</p>
        <p className="muted small">セッションの「PR を作成」から作るか、GitHub で作成すると数分以内に表示されます。</p>
      </div>
    );
  const open = prs.filter((p) => p.state === 'OPEN');
  const closed = prs.filter((p) => p.state !== 'OPEN');
  const failed = open.filter((p) => p.checks === 'failure').length;
  return (
    <div className="pr-page">
      <div className="pj-pr-sum">
        <span className="gstat">Open {open.length}</span>
        {failed > 0 && (
          <span className="gstat warn">
            <CheckIcon checks="failure" /> CI 失敗 {failed}
          </span>
        )}
        <span className="gstat">マージ / クローズ {closed.length}</span>
      </div>
      {open.length > 0 && (
        <section className="pr-group">
          <h3 className="sec-title">
            Open <span className="count-pill">{open.length}</span>
          </h3>
          <div className="pr-list">
            {open.map((p) => (
              <PrRow key={p.id} pr={p} now={now} />
            ))}
          </div>
        </section>
      )}
      {closed.length > 0 && (
        <section className="pr-group">
          <h3 className="sec-title">
            マージ / クローズ <span className="count-pill">{closed.length}</span>
          </h3>
          <div className="pr-list">
            {closed.map((p) => (
              <PrRow key={p.id} pr={p} now={now} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
