// プロジェクト一覧(ホーム): 起動時の画面。登録リポジトリとフォルダをカードで並べ、
// 「GitHub のリポジトリを追加」「フォルダを開く」から始められるようにする。デスクトップ / モバイル共用
import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { useHub } from '../store';
import { type FolderCardData, type RepoCardData, matchQuery, useProjectCatalog, useRecentProjects } from '../home';
import { KIND_LABEL } from '../repo';
import { fmtTokens, normPath } from '../project';
import { STATUS_LABEL, fmtAgo, fmtDate, projectLabel } from '../util';
import { PoolChips, RepoStatusBadge } from './RepoCommon';
import { StatusBadge, StatusDot } from './common';
import { CheckIcon } from './Prs';
import { RegisterRepoForm } from './Repos';
import { FolderInput } from './FolderPicker';
import { InstructionsChip } from './Instructions';
import { useAttentionDeploys } from '../ops';
import { firebaseCwdFor } from '../firebase';
import { FirebaseChip } from './Firebase';

// ---------------------------------------------------------------- ダイアログ(App 直下に置く)

/** 「GitHub のリポジトリを追加」: 登録フォームをダイアログで */
export function CloneRepoModal() {
  const open = useHub((s) => s.cloneOpen);
  const setOpen = useHub((s) => s.setCloneOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="clone-title">
        <div className="modal-head">
          <h2 id="clone-title">GitHub のリポジトリを追加</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="閉じる">
            ✕
          </button>
        </div>
        <RegisterRepoForm inModal onClose={() => setOpen(false)} />
      </div>
    </div>
  );
}

/** 「フォルダを開く」: パスを入力 / 参照 / 最近のフォルダから選んで管理画面を開く */
function OpenFolderModal({ onClose }: { onClose: () => void }) {
  const openProject = useHub((s) => s.openProject);
  const cat = useProjectCatalog();
  const recent = useRecentProjects();
  const [path, setPath] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 候補: ホームのフォルダ + 最近のプロジェクト(入力で絞り込み)
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; last: number }[] = [];
    const add = (p: string, last: number) => {
      const k = normPath(p);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ path: p, last });
    };
    for (const f of cat.folders) add(f.path, f.lastActivity);
    for (const p of recent ?? []) add(p.path, p.lastUsed);
    const q = path.trim();
    return out.filter((o) => !q || matchQuery(q, o.path)).slice(0, 12);
  }, [cat.folders, recent, path]);

  const go = (p: string) => {
    const v = p.trim();
    if (!v) return;
    openProject({ cwd: v });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="of-title">
        <div className="modal-head">
          <h2 id="of-title">フォルダを開く</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <form
          className="modal-body form"
          onSubmit={(e) => {
            e.preventDefault();
            go(path);
          }}
        >
          <div className="field">
            <span>フォルダのパス</span>
            <FolderInput value={path} onChange={setPath} autoFocus placeholder="C:\Users\yanor\my-app(貼り付け / 参照)" />
            <span className="hint">そのフォルダの管理画面(セッション・Git・アーティファクト・履歴)を開きます。worktree は使いません。</span>
          </div>
          <div className="field">
            <span>最近のフォルダ</span>
            {recent === null && options.length === 0 ? (
              <span className="muted small">読み込み中…</span>
            ) : options.length === 0 ? (
              <span className="muted small">候補はありません</span>
            ) : (
              <div className="of-list" role="list">
                {options.map((o) => (
                  <button type="button" role="listitem" key={o.path} className="of-row" onClick={() => go(o.path)} title={o.path}>
                    <span className="of-name">{projectLabel(o.path)}</span>
                    <span className="of-path mono">{o.path}</span>
                    {o.last > 0 && <span className="of-time muted">{fmtAgo(o.last)}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn primary" disabled={!path.trim()}>
              開く
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ホーム

/** 承認待ち / 入力待ちのセッションへのリンク(ホームの上部) */
function AttentionStrip({ mobile }: { mobile: boolean }) {
  const sessions = useHub((s) => s.sessions);
  const repos = useHub((s) => s.repos);
  const open = useHub((s) => s.open);
  const openApprovals = useHub((s) => s.openApprovals);
  const deploys = useAttentionDeploys();
  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.status === 'awaiting_approval' || s.status === 'awaiting_input')
        .sort((a, b) => Number(b.status === 'awaiting_approval') - Number(a.status === 'awaiting_approval') || b.lastEventAt - a.lastEventAt),
    [sessions],
  );
  if (list.length === 0 && deploys.length === 0) return null;
  const nApproval = list.filter((s) => s.status === 'awaiting_approval').length + deploys.length;
  return (
    <section className={`attn-strip ${nApproval > 0 ? 'has-approval' : ''}`} aria-label="対応が必要なセッション">
      <span className="attn-strip-title">
        対応待ち <b>{list.length + deploys.length}</b>
        {!mobile && <span className="muted small">(承認 {nApproval} / 入力 {list.length + deploys.length - nApproval})</span>}
      </span>
      <div className="attn-strip-list">
        {deploys.map((d) => {
          const fb = d.firebase;
          const preview = d.state === 'preview_ready';
          const label = preview ? 'プレビュー確認待ち' : fb ? 'Firebase デプロイの申請' : 'アップロードの申請';
          const where = fb ? fb.projectId : d.serverName;
          const tip = preview
            ? `プレビューを確認して本番に反映してください: ${where}`
            : `Claude が${fb ? ' Firebase へのデプロイ' : 'アップロード'}を申請しています: ${where}\n${fb ? fb.projectDir : d.localDir}`;
          return (
            <button key={d.id} className={`attn-chip st-deploy ${fb ? 'is-fb' : ''}`} onClick={openApprovals} title={tip}>
              <span className="attn-chip-ico" aria-hidden="true">
                {fb ? '🔥' : '↑'}
              </span>
              <span className="attn-chip-name">{label}</span>
              <span className="attn-chip-where">{where}</span>
            </button>
          );
        })}
        {list.slice(0, mobile ? 4 : 8).map((s) => (
          <button key={s.id} className={`attn-chip st-${s.status}`} onClick={() => open(s.id)} title={`${STATUS_LABEL[s.status]}: ${s.name}\n${s.cwd}`}>
            <StatusDot status={s.status} />
            <span className="attn-chip-name">{s.name}</span>
            <span className="attn-chip-where">{s.repoId ? repos[s.repoId]?.name ?? s.repoId : projectLabel(s.cwd)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** セッションの状態アイコンを並べる(多いときは +N) */
function SessionDots({ list }: { list: SessionInfo[] }) {
  if (list.length === 0) return <span className="muted">動いているセッションなし</span>;
  const shown = list.slice(0, 6);
  return (
    <span className="pc-dots" aria-label={`動いているセッション ${list.length} 件`}>
      <b>{list.length}</b> セッション
      <span className="pc-dot-row">
        {shown.map((s) => (
          <StatusDot key={s.id} status={s.status} title={`${s.name}: ${STATUS_LABEL[s.status]}`} />
        ))}
        {list.length > shown.length && <span className="muted small">+{list.length - shown.length}</span>}
      </span>
    </span>
  );
}

function Tokens({ total, today }: { total: number | null; today: number | null }) {
  if (total === null) return null;
  return (
    <span className="pc-tokens" title="トークン(入力 + 出力 + キャッシュ)。今日 = 今日作成したセッションの分">
      トークン 今日 <b>{fmtTokens(today ?? 0)}</b> / 計 <b>{fmtTokens(total)}</b>
    </span>
  );
}

function RepoCard({ d }: { d: RepoCardData }) {
  const openProject = useHub((s) => s.openProject);
  const setNew = useHub((s) => s.setNewSessionOpen);
  const openPr = useHub((s) => s.openPr);
  const r = d.repo;
  const first = d.active[0];
  return (
    <article className={`pcard ${r.error ? 'has-error' : ''}`} aria-label={`リポジトリ ${r.id}`}>
      <div className="pcard-top">
        <span className="pcard-ico repo" aria-hidden="true">
          ⑂
        </span>
        <button className="pcard-name" onClick={() => openProject({ repoId: r.id })} title={`${r.id} の管理画面を開く`}>
          {r.name}
        </button>
        <span className="pcard-owner">{r.owner}</span>
        <span className="spacer" />
        <span className="kind-tag">{KIND_LABEL[r.kind]}</span>
        {r.status !== 'ready' && <RepoStatusBadge status={r.status} />}
      </div>
      <PoolChips repo={r} worktrees={d.worktrees} />
      {r.error && <span className="repo-card-err">⚠ {r.error}</span>}
      <div className="pcard-line">
        <SessionDots list={d.active} />
      </div>
      {first && (first.status === 'awaiting_approval' || first.status === 'awaiting_input' || first.status === 'error') && (
        <div className="pcard-attn">
          <StatusBadge status={first.status} />
          <span className="pcard-attn-name">{first.name}</span>
        </div>
      )}
      <div className="pcard-line small">
        {d.openPrs.length > 0 ? (
          <button className="pcard-pr" onClick={() => openPr(null)} title="PR 一覧を開く">
            Open の PR <b>{d.openPrs.length}</b>
            {d.ci && <CheckIcon checks={d.ci} />}
          </button>
        ) : (
          <span className="muted">Open の PR なし</span>
        )}
        <Tokens total={d.tokensTotal} today={d.tokensToday} />
        <InstructionsChip project={{ repoId: r.id, cwd: null }} onOpen={() => openProject({ repoId: r.id }, 'instructions')} />
        <FirebaseChip cwd={firebaseCwdFor(r, r.baseDir)} onOpen={() => openProject({ repoId: r.id }, 'firebase')} />
      </div>
      <div className="pcard-foot">
        <span className="muted small" title={d.lastActivity ? fmtDate(d.lastActivity) : undefined}>
          {d.lastActivity ? `最終 ${fmtAgo(d.lastActivity)}` : '未使用'}
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => openProject({ repoId: r.id })}>
          開く
        </button>
        <button className="btn sm primary" disabled={r.status !== 'ready'} onClick={() => setNew(true, r.id)} title={r.status !== 'ready' ? 'クローンが終わると使えます' : 'worktree で新しいセッションを始める'}>
          ＋ セッション
        </button>
      </div>
    </article>
  );
}

function FolderCard({ d }: { d: FolderCardData }) {
  const openProject = useHub((s) => s.openProject);
  const setNew = useHub((s) => s.setNewSessionOpen);
  return (
    <article className="pcard folder" aria-label={`フォルダ ${d.path}`}>
      <div className="pcard-top">
        <span className="pcard-ico" aria-hidden="true">
          ▤
        </span>
        <button className="pcard-name" onClick={() => openProject({ cwd: d.path })} title={`${d.path} の管理画面を開く`}>
          {d.name}
        </button>
        <span className="spacer" />
        {d.sessions.some((s) => !s.managed && !s.handedOff) && <span className="tag ro">外部</span>}
      </div>
      <span className="pcard-path mono" title={d.path}>
        {d.path}
      </span>
      <div className="pcard-line">
        <SessionDots list={d.active} />
      </div>
      <div className="pcard-line small">
        <Tokens total={d.tokensTotal} today={d.tokensToday} />
        <InstructionsChip project={{ repoId: null, cwd: d.path }} onOpen={() => openProject({ cwd: d.path }, 'instructions')} />
        <FirebaseChip cwd={d.path} onOpen={() => openProject({ cwd: d.path }, 'firebase')} />
      </div>
      <div className="pcard-foot">
        <span className="muted small" title={d.lastActivity ? fmtDate(d.lastActivity) : undefined}>
          {d.lastActivity ? `最終 ${fmtAgo(d.lastActivity)}` : ''}
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => openProject({ cwd: d.path })}>
          開く
        </button>
        <button className="btn sm primary" onClick={() => setNew(true, null, d.path)} title="このフォルダで直接セッションを始める">
          ＋ セッション
        </button>
      </div>
    </article>
  );
}

export function HomeScreen({ mobile = false }: { mobile?: boolean }) {
  const cat = useProjectCatalog();
  const loaded = useHub((s) => s.loaded);
  const setClone = useHub((s) => s.setCloneOpen);
  const [folderOpen, setFolderOpen] = useState(false);
  const [q, setQ] = useState('');

  const repos = cat.repos.filter((d) => matchQuery(q, d.repo.id, d.repo.baseDir, KIND_LABEL[d.repo.kind]));
  const folders = cat.folders.filter((d) => matchQuery(q, d.name, d.path));
  const nothing = loaded && cat.repos.length === 0 && cat.folders.length === 0 && !cat.loadingRecent;

  const actions = (
    <div className="home-actions">
      <button className="btn primary lg home-clone" onClick={() => setClone(true)}>
        <span aria-hidden="true">⑂</span> GitHub のリポジトリを追加
      </button>
      <button className="btn lg" onClick={() => setFolderOpen(true)}>
        <span aria-hidden="true">▤</span> フォルダを開く
      </button>
    </div>
  );

  return (
    <div className={`home ${mobile ? 'is-mobile' : ''}`}>
      <AttentionStrip mobile={mobile} />
      <header className="home-head">
        <div className="home-title-wrap">
          <h1 className="home-title">プロジェクト</h1>
          <p className="home-sub">リポジトリ(worktree で並行作業)とフォルダ(その場で作業)から、セッションを始めたり状況を確認したりできます。</p>
        </div>
        {actions}
      </header>

      {nothing ? (
        <div className="home-empty">
          <p>まだプロジェクトがありません。GitHub のリポジトリをクローンするか、PC のフォルダを開いて始めましょう。</p>
          {actions}
        </div>
      ) : (
        <>
          <div className="home-search">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="プロジェクトを検索(名前・パス)"
              aria-label="プロジェクトを検索"
            />
          </div>

          <section className="home-sec" aria-labelledby="home-repos">
            <h2 id="home-repos" className="home-sec-title">
              リポジトリ <span className="count-pill">{cat.repos.length}</span>
              <span className="muted small home-sec-sub">worktree を待機させておき、並行してセッションを走らせます</span>
            </h2>
            {repos.length === 0 ? (
              <div className="home-none">
                {cat.repos.length === 0 ? (
                  <>
                    登録したリポジトリはありません。
                    <button className="link-btn" onClick={() => setClone(true)}>
                      GitHub のリポジトリを追加
                    </button>
                  </>
                ) : (
                  '一致するリポジトリがありません'
                )}
              </div>
            ) : (
              <div className="pcards">
                {repos.map((d) => (
                  <RepoCard key={d.key} d={d} />
                ))}
              </div>
            )}
          </section>

          <section className="home-sec" aria-labelledby="home-folders">
            <h2 id="home-folders" className="home-sec-title">
              フォルダ <span className="count-pill">{cat.folders.length}</span>
              <span className="muted small home-sec-sub">セッションのあるフォルダと最近使ったフォルダ</span>
            </h2>
            {folders.length === 0 ? (
              <div className="home-none">{cat.loadingRecent ? '読み込み中…' : q ? '一致するフォルダがありません' : 'フォルダはまだありません'}</div>
            ) : (
              <div className="pcards">
                {folders.map((d) => (
                  <FolderCard key={d.key} d={d} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {folderOpen && <OpenFolderModal onClose={() => setFolderOpen(false)} />}
    </div>
  );
}
