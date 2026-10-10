// リポジトリ画面: 一覧 / 登録フォーム / リポジトリ詳細(設定・worktree プール)。デスクトップとモバイルで共用
import { useEffect, useMemo, useState } from 'react';
import type { RegisterRepoRequest, RepoInfo, WorktreeInfo } from '@cc-hub/shared';
import { errText, isConflict, pick, repoApi, type RepoPatch } from '../api';
import { useHub } from '../store';
import { KIND_INSTALL_HINT, KIND_LABEL, needsRelease, useRepoList, useWorktreesByRepo } from '../repo';
import { fmtDate } from '../util';
import { ConfirmModal, PoolChips, RepoStatusBadge, Spinner, WtBadge } from './RepoCommon';
import { StatusDot } from './common';
import { BranchSection } from './Branches';
import { FolderInput } from './FolderPicker';

// ---------------------------------------------------------------- URL の正規化(表示用プレビュー)

/** https / git@ / owner/name → "owner/name"。解釈できなければ null(最終判定はデーモン) */
export function parseRepoUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// ---------------------------------------------------------------- 一覧

/** デスクトップ左サイドバーの「プロジェクト」セクション(登録リポジトリ。名前で管理画面を開く) */
export function SidebarRepos() {
  const repos = useRepoList();
  const wtByRepo = useWorktreesByRepo();
  const deskView = useHub((s) => s.deskView);
  const setTopView = useHub((s) => s.setTopView);
  const setClone = useHub((s) => s.setCloneOpen);
  const openProject = useHub((s) => s.openProject);
  const project = useHub((s) => s.project);
  const projectId = deskView === 'project' ? project?.repoId ?? null : null;
  return (
    <section className="side-repos" aria-label="プロジェクト">
      <div className="side-repos-head">
        <button
          className={`side-repos-title ${deskView === 'home' ? 'on' : ''}`}
          onClick={() => setTopView('projects')}
          title="プロジェクト一覧を開く(Alt+1)"
        >
          プロジェクト
        </button>
        <button className="btn sm ghost side-add" title="GitHub のリポジトリを追加" onClick={() => setClone(true)}>
          ＋ 追加
        </button>
      </div>
      <div className="side-repos-list">
        {repos.length === 0 ? (
          <button className="side-repo empty-row" onClick={() => setClone(true)}>
            まだありません — 「＋ 追加」で GitHub からクローン
          </button>
        ) : (
          repos.map((r) => (
            <div key={r.id} className={`side-repo-row ${projectId === r.id ? 'active' : ''}`}>
              <button
                className={`side-repo ${projectId === r.id ? 'active' : ''} ${r.error ? 'has-error' : ''}`}
                onClick={() => openProject({ repoId: r.id })}
                aria-current={projectId === r.id ? 'page' : undefined}
                title={r.error ?? `${r.id} の管理画面(セッション・作業ツリー・PR・Git・履歴)`}
              >
                <span className="side-repo-name">
                  {r.error && <span className="warn-ico" aria-label="警告">!</span>}
                  {r.name}
                </span>
                <PoolChips repo={r} worktrees={wtByRepo[r.id] ?? []} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** リポジトリ一覧(カード) */
export function RepoListPage({ mobile = false }: { mobile?: boolean }) {
  const repos = useRepoList();
  const wtByRepo = useWorktreesByRepo();
  const openRepos = useHub((s) => s.openRepos);
  const loaded = useHub((s) => s.loaded);
  return (
    <div className="repo-page">
      {!mobile && (
        <div className="rp-head">
          <h2 className="rp-title">リポジトリ</h2>
          <span className="muted small">登録したリポジトリごとに worktree を待機させ、すぐにセッションを始められます</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => openRepos({ page: 'register' })}>
            + リポジトリを登録
          </button>
        </div>
      )}
      {repos.length === 0 ? (
        <div className="rp-empty">
          {loaded ? (
            <>
              <p>まだリポジトリが登録されていません。</p>
              <p className="muted small">GitHub の URL を登録すると、クローンして待機用の worktree を作成します。</p>
              <button className="btn primary" onClick={() => openRepos({ page: 'register' })}>
                + リポジトリを登録
              </button>
            </>
          ) : (
            '読み込み中…'
          )}
        </div>
      ) : (
        <div className="repo-cards">
          {repos.map((r) => (
            <RepoCard key={r.id} repo={r} worktrees={wtByRepo[r.id] ?? []} onOpen={() => openRepos({ page: 'repo', id: r.id })} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoCard({ repo, worktrees, onOpen }: { repo: RepoInfo; worktrees: WorktreeInfo[]; onOpen: () => void }) {
  return (
    <button className={`repo-card ${repo.error ? 'has-error' : ''}`} onClick={onOpen}>
      <span className="repo-card-top">
        <span className="repo-card-name">{repo.name}</span>
        <span className="repo-card-owner">{repo.owner}</span>
        <span className="spacer" />
        <span className="kind-tag">{KIND_LABEL[repo.kind]}</span>
        {repo.status !== 'ready' && <RepoStatusBadge status={repo.status} />}
      </span>
      <PoolChips repo={repo} worktrees={worktrees} />
      {repo.error && <span className="repo-card-err">⚠ {repo.error}</span>}
      <span className="repo-card-path mono">{repo.baseDir}</span>
    </button>
  );
}

// ---------------------------------------------------------------- 登録フォーム

/** inModal = 「GitHub のリポジトリを追加」ダイアログの中身として使う(閉じるのは onClose) */
export function RegisterRepoForm({ mobile = false, inModal = false, onClose }: { mobile?: boolean; inModal?: boolean; onClose?: () => void }) {
  const openRepos = useHub((s) => s.openRepos);
  const setTopView = useHub((s) => s.setTopView);
  const upsertRepo = useHub((s) => s.upsertRepo);
  const repos = useHub((s) => s.repos);
  const [source, setSource] = useState<'url' | 'local'>('url');
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [poolMin, setPoolMin] = useState('3');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const local = source === 'local';
  const parsed = local ? null : parseRepoUrl(url);
  const dup = parsed ? Object.values(repos).find((r) => r.id.toLowerCase() === parsed.toLowerCase()) : undefined;
  const n = parseInt(poolMin, 10);
  const poolOk = Number.isFinite(n) && n >= 0 && n <= 10;
  const filled = local ? !!localPath.trim() : !!url.trim();
  const canSubmit = filled && trusted && poolOk && !busy && !dup;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const req: RegisterRepoRequest = local
        ? { url: '', localPath: localPath.trim(), trusted, poolMin: n }
        : { url: url.trim(), trusted, poolMin: n };
      const r = await repoApi.register(req);
      const repo = pick<RepoInfo>(r, 'repo');
      if (repo && repo.id) upsertRepo(repo);
      if (inModal) {
        // ダイアログ: 閉じてプロジェクト一覧へ(カードにクローンの進み具合が出る)
        onClose?.();
        setTopView('projects');
      } else if (repo && repo.id) {
        openRepos({ page: 'repo', id: repo.id });
      } else {
        openRepos({ page: 'list' });
      }
    } catch (e2) {
      setErr(errText(e2, '登録に失敗しました'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => (inModal ? onClose?.() : openRepos({ page: 'list' }));
  const form = (
      <form className={inModal ? 'modal-body form register-form' : 'rp-card form register-form'} onSubmit={submit}>
        {inModal && (
          <p className="muted small">
            GitHub のリポジトリを CC Hub に登録します。待機用の worktree を用意しておくので、複数のセッションを並行して始められます。
          </p>
        )}
        <div className="field">
          <span>登録のしかた</span>
          <div className="seg small" role="group" aria-label="登録のしかた">
            <button type="button" className={!local ? 'on' : ''} aria-pressed={!local} onClick={() => setSource('url')}>
              GitHub からクローン
            </button>
            <button type="button" className={local ? 'on' : ''} aria-pressed={local} onClick={() => setSource('local')}>
              クローン済みのフォルダ
            </button>
          </div>
        </div>
        {local ? (
          <div className="field">
            <span>クローン済みのフォルダ</span>
            <FolderInput value={localPath} onChange={setLocalPath} label="クローン済みのフォルダ" placeholder="D:\Unity\MyGame" autoFocus={!mobile || inModal} />
            <span className="hint">
              origin の URL からリポジトリを判別し、このフォルダから複製して CC Hub 用のクローンを作ります。このフォルダ自体は変更しません(作業中の変更もそのまま)。Unity なら Library も初期データとして使います。
            </span>
          </div>
        ) : (
        <label className="field">
          <span>GitHub のリポジトリ</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/name / git@github.com:owner/name.git / owner/name"
            className="mono"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            autoFocus={!mobile || inModal}
          />
          <span className="hint">
            {url.trim() === '' ? (
              'https / git@ / owner/name のどれでも入力できます'
            ) : parsed ? (
              dup ? (
                <span className="warn-text">{parsed} は登録済みです</span>
              ) : (
                <>
                  → <span className="mono">{parsed}</span> をクローンします
                </>
              )
            ) : (
              <span className="warn-text">形式を確認してください(デーモン側でも判定します)</span>
            )}
          </span>
        </label>
        )}
        <label className="field">
          <span>待機させる worktree の数</span>
          <input
            type="number"
            min={0}
            max={10}
            value={poolMin}
            onChange={(e) => setPoolMin(e.target.value)}
            className="num-input"
          />
          <span className="hint">クローン後、この本数の worktree を作って依存をインストールしておきます(既定 3)</span>
        </label>
        <label className={`check-field trust ${trusted ? 'on' : ''}`}>
          <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          <span>
            このリポジトリを信頼する(信頼ダイアログに自動で Yes と答えます)
            <span className="hint">
              Claude Code はこのリポジトリのフック・設定・MCP サーバーを実行できるようになります。自分で管理しているリポジトリだけを登録してください。
            </span>
          </span>
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={cancel}>
            キャンセル
          </button>
          <button type="submit" className="btn primary" disabled={!canSubmit}>
            {busy ? '登録中…' : local ? '登録して複製' : '登録してクローン'}
          </button>
        </div>
        {!trusted && filled && <div className="hint right">登録するには「信頼する」にチェックしてください</div>}
      </form>
  );
  if (inModal) return form;
  return (
    <div className="repo-page">
      {!mobile && (
        <div className="rp-head">
          <button className="btn ghost" onClick={() => openRepos({ page: 'list' })}>
            ‹ プロジェクト
          </button>
          <h2 className="rp-title">リポジトリを登録</h2>
        </div>
      )}
      {form}
    </div>
  );
}

// ---------------------------------------------------------------- リポジトリ詳細

/** embedded = 管理画面の「設定」タブとして埋め込む(戻るボタンと「管理画面」ボタンを出さない) */
export function RepoPage({ id, mobile = false, embedded = false }: { id: string; mobile?: boolean; embedded?: boolean }) {
  const repo = useHub((s) => s.repos[id]);
  const wtByRepo = useWorktreesByRepo();
  const openRepos = useHub((s) => s.openRepos);
  const openProject = useHub((s) => s.openProject);
  const setNew = useHub((s) => s.setNewSessionOpen);
  const [refillMsg, setRefillMsg] = useState<string | null>(null);
  const [refilling, setRefilling] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (!repo) {
    return (
      <div className="repo-page">
        <div className="rp-empty">
          リポジトリが見つかりません
          <button className="btn" onClick={() => openRepos({ page: 'list' })}>
            一覧へ
          </button>
        </div>
      </div>
    );
  }
  const worktrees = wtByRepo[repo.id] ?? [];

  const refill = async () => {
    setRefilling(true);
    setRefillMsg(null);
    try {
      await repoApi.refill(repo.id);
      setRefillMsg('補充を開始しました');
    } catch (e) {
      setRefillMsg(errText(e, '補充に失敗しました'));
    } finally {
      setRefilling(false);
      setTimeout(() => setRefillMsg(null), 5000);
    }
  };

  return (
    <div className="repo-page">
      <div className="rp-head wrap">
        {!mobile && !embedded && (
          <button className="btn ghost" onClick={() => openRepos({ page: 'list' })}>
            ‹ リポジトリ
          </button>
        )}
        <h2 className="rp-title">
          {embedded ? 'リポジトリの設定' : repo.name}
          <span className="rp-owner">{repo.owner}</span>
        </h2>
        <RepoStatusBadge status={repo.status} />
        <span className="kind-tag">{KIND_LABEL[repo.kind]}</span>
        <span className="spacer" />
        <div className="rp-actions">
          {!embedded && (
            <button className="btn" onClick={() => openProject({ repoId: repo.id })} title="セッション・作業ツリー・PR・Git・トークンをまとめて見る">
              管理画面
            </button>
          )}
          {!embedded && (
            <button className="btn primary" disabled={repo.status !== 'ready'} onClick={() => setNew(true, repo.id)}>
              + セッション
            </button>
          )}
          <button className="btn" disabled={refilling || repo.status !== 'ready'} onClick={() => void refill()}>
            {refilling ? '補充中…' : '補充'}
          </button>
          <button className="btn danger" onClick={() => setRemoving(true)}>
            登録解除
          </button>
        </div>
      </div>
      {refillMsg && <div className="rp-note">{refillMsg}</div>}

      {repo.status === 'cloning' && (
        <div className="rp-alert info">
          <Spinner /> <span>クローンしています… 完了すると待機用の worktree を {repo.poolMin} 本作成します。</span>
        </div>
      )}
      {repo.error && (
        <div className={`rp-alert ${repo.status === 'error' ? 'error' : 'warn'}`} role="alert">
          <span className="rp-alert-ico" aria-hidden="true">
            !
          </span>
          <span>
            <strong>{repo.status === 'error' ? 'エラー' : '警告'}</strong> {repo.error}
          </span>
        </div>
      )}

      <section className="rp-card">
        <dl className="kv rp-kv">
          <dt>URL</dt>
          <dd className="mono break">{repo.url}</dd>
          <dt>ベースディレクトリ</dt>
          <dd className="mono break">{repo.baseDir}</dd>
          <dt>既定ブランチ</dt>
          <dd className="mono">{repo.defaultBranch || '—'}</dd>
          <dt>プール</dt>
          <dd>
            <PoolChips repo={repo} worktrees={worktrees} />
            <span className="muted small"> 目標 {repo.poolMin} 本 / 上限 {repo.poolMax} 本</span>
          </dd>
        </dl>
      </section>

      <section className="rp-sec">
        <h3 className="sec-title">
          worktree <span className="count-pill">{worktrees.length}</span>
        </h3>
        <WorktreeTable worktrees={worktrees} mobile={mobile} />
      </section>

      <BranchSection repo={repo} mobile={mobile} />

      <section className="rp-sec">
        <h3 className="sec-title">設定</h3>
        <RepoSettings repo={repo} />
      </section>

      {removing && <UnregisterModal repo={repo} onClose={() => setRemoving(false)} />}
    </div>
  );
}

function UnregisterModal({ repo, onClose }: { repo: RepoInfo; onClose: () => void }) {
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const openRepos = useHub((s) => s.openRepos);
  const removeRepo = useHub((s) => s.removeRepo);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await repoApi.remove(repo.id, purge);
      removeRepo(repo.id);
      openRepos({ page: 'list' });
      onClose();
    } catch (e) {
      setErr(
        isConflict(e)
          ? `${errText(e)}。各セッションで「作業ツリーを解放」してから登録解除してください。`
          : errText(e, '登録解除に失敗しました'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal
      title={`${repo.id} の登録解除`}
      confirmLabel={purge ? 'クローンも削除して登録解除' : '登録解除'}
      danger
      busy={busy}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>待機中の worktree を削除し、CC Hub の管理から外します。使用中の worktree がある場合は解除できません。</p>
      <label className={`check-field ${purge ? 'danger-on' : ''}`}>
        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
        <span>
          クローン(<span className="mono">{repo.baseDir}\.base</span>)も削除する
        </span>
      </label>
      {purge && (
        <p className="warn-box">
          ベースのクローンと、そこにしかないローカルブランチ・stash・未 push のコミットはすべて削除されます。再登録するとクローンし直しになります。
        </p>
      )}
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------- worktree 一覧

function WorktreeTable({ worktrees, mobile }: { worktrees: WorktreeInfo[]; mobile: boolean }) {
  if (worktrees.length === 0) return <div className="empty">worktree はまだありません</div>;
  if (mobile) {
    return (
      <div className="wt-cards">
        {worktrees.map((w) => (
          <WorktreeCard key={w.id} w={w} />
        ))}
      </div>
    );
  }
  return (
    <div className="wt-table-wrap">
      <table className="wt-table">
        <thead>
          <tr>
            <th>名前</th>
            <th>状態</th>
            <th>ブランチ</th>
            <th>セッション</th>
            <th>進捗 / エラー</th>
            <th>最終使用</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {worktrees.map((w) => (
            <tr key={w.id} className={`wt-${w.state}`}>
              <td className="mono" title={w.path}>
                {w.name}
              </td>
              <td>
                <WtBadge state={w.state} />
              </td>
              <td className="mono wt-branch">{w.branch ?? <span className="dim">—</span>}</td>
              <td>
                <WtSessionLink w={w} />
              </td>
              <td className="wt-progress">
                <WtProgress w={w} />
              </td>
              <td className="muted nowrap">{w.lastUsedAt ? fmtDate(w.lastUsedAt) : '—'}</td>
              <td className="wt-actions">
                <WtActions w={w} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorktreeCard({ w }: { w: WorktreeInfo }) {
  return (
    <div className={`wt-card wt-${w.state}`}>
      <div className="wt-card-top">
        <span className="mono strong">{w.name}</span>
        <WtBadge state={w.state} />
        <span className="spacer" />
        <span className="muted small">{w.lastUsedAt ? fmtDate(w.lastUsedAt) : ''}</span>
      </div>
      {(w.branch || w.sessionId) && (
        <div className="wt-card-line">
          {w.branch && <span className="mono wt-branch">{w.branch}</span>}
          <WtSessionLink w={w} />
        </div>
      )}
      <WtProgress w={w} />
      <WtActions w={w} />
    </div>
  );
}

function WtSessionLink({ w }: { w: WorktreeInfo }) {
  const s = useHub((st) => (w.sessionId ? st.sessions[w.sessionId] : undefined));
  const open = useHub((st) => st.open);
  if (!w.sessionId) return <span className="dim">—</span>;
  if (!s) return <span className="muted small mono">{w.sessionId.slice(0, 8)}</span>;
  return (
    <button className="wt-session" onClick={() => open(s.id)} title="セッションを開く">
      <StatusDot status={s.status} />
      <span className="wt-session-name">{s.name}</span>
      {needsRelease(s, w) && <span className="need-release">要解放</span>}
    </button>
  );
}

function WtProgress({ w }: { w: WorktreeInfo }) {
  if (w.error) return <span className="wt-error">{w.error}</span>;
  if (w.progress) return <span className="muted">{w.progress}</span>;
  return null;
}

function WtActions({ w }: { w: WorktreeInfo }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(
        isConflict(e)
          ? `${errText(e)}(使用中の worktree は削除できません。先にセッションから解放してください)`
          : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };
  const canRebuild = w.state === 'broken';
  const canDelete = w.state === 'idle' || w.state === 'broken';
  if (!canRebuild && !canDelete && !err) return null;
  return (
    <span className="wt-act">
      {canRebuild && (
        <button className="btn sm" disabled={busy} onClick={() => void run(() => repoApi.rebuildWorktree(w.id))}>
          作り直す
        </button>
      )}
      {canDelete && (
        <button
          className="btn sm danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`${w.name} を削除しますか?\n${w.path}`)) void run(() => repoApi.deleteWorktree(w.id));
          }}
        >
          削除
        </button>
      )}
      {err && <span className="form-error">{err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- 設定フォーム

interface SettingsForm {
  poolMin: string;
  poolMax: string;
  installCmd: string;
  noInstall: boolean;
  keepDirs: string;
  seedLibraryFrom: string;
  trusted: boolean;
}

function formFrom(r: RepoInfo): SettingsForm {
  return {
    poolMin: String(r.poolMin),
    poolMax: String(r.poolMax),
    installCmd: r.installCmd ?? '',
    noInstall: r.installCmd === '',
    keepDirs: r.keepDirs.join(', '),
    seedLibraryFrom: r.seedLibraryFrom ?? '',
    trusted: r.trusted,
  };
}

function splitDirs(s: string): string[] {
  return s
    .split(/[,、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function RepoSettings({ repo }: { repo: RepoInfo }) {
  const base = useMemo(() => formFrom(repo), [repo]);
  const [f, setF] = useState<SettingsForm>(base);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 編集していなければサーバー側の更新に追従する
  useEffect(() => {
    if (!dirty) setF(base);
  }, [base, dirty]);

  const upd = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setDirty(true);
    setMsg(null);
  };

  const min = parseInt(f.poolMin, 10);
  const max = parseInt(f.poolMax, 10);
  let invalid: string | null = null;
  if (!Number.isFinite(min) || min < 0) invalid = '待機数は 0 以上の整数にしてください';
  else if (!Number.isFinite(max) || max < 1) invalid = '上限は 1 以上の整数にしてください';
  else if (min > max) invalid = '待機数は上限以下にしてください';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    const patch: RepoPatch = {};
    if (min !== repo.poolMin) patch.poolMin = min;
    if (max !== repo.poolMax) patch.poolMax = max;
    const install = f.noInstall ? '' : f.installCmd.trim() || null;
    if (install !== repo.installCmd) patch.installCmd = install;
    const dirs = splitDirs(f.keepDirs);
    if (dirs.join('\n') !== repo.keepDirs.join('\n')) patch.keepDirs = dirs;
    if (repo.kind === 'unity') {
      const seed = f.seedLibraryFrom.trim() || null;
      if (seed !== repo.seedLibraryFrom) patch.seedLibraryFrom = seed;
    }
    if (f.trusted !== repo.trusted) patch.trusted = f.trusted;
    if (Object.keys(patch).length === 0) {
      setDirty(false);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await repoApi.patch(repo.id, patch);
      setDirty(false);
      setMsg({ ok: true, text: '保存しました' });
    } catch (e2) {
      setMsg({ ok: false, text: errText(e2, '保存に失敗しました') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rp-card form settings-form" onSubmit={save}>
      <div className="settings-grid">
        <label className="field">
          <span>待機数(poolMin)</span>
          <input type="number" min={0} className="num-input" value={f.poolMin} onChange={(e) => upd('poolMin', e.target.value)} />
          <span className="hint">待機 + 準備中をこの本数に保ちます</span>
        </label>
        <label className="field">
          <span>上限(poolMax)</span>
          <input type="number" min={1} className="num-input" value={f.poolMax} onChange={(e) => upd('poolMax', e.target.value)} />
          <span className="hint">使用中を含めた worktree の総数</span>
        </label>
        <label className="field span2">
          <span>依存インストールコマンド</span>
          <input
            className="mono"
            value={f.noInstall ? '' : f.installCmd}
            disabled={f.noInstall}
            onChange={(e) => upd('installCmd', e.target.value)}
            placeholder={f.noInstall ? 'インストールしない' : `自動判定(${KIND_INSTALL_HINT[repo.kind]})`}
            spellCheck={false}
          />
          <span className="check-inline">
            <input
              type="checkbox"
              id={`noinst-${repo.id}`}
              checked={f.noInstall}
              onChange={(e) => upd('noInstall', e.target.checked)}
            />
            <label htmlFor={`noinst-${repo.id}`}>依存をインストールしない</label>
          </span>
        </label>
        <label className="field span2">
          <span>初期化で残すディレクトリ(カンマ区切り)</span>
          <input
            className="mono"
            value={f.keepDirs}
            onChange={(e) => upd('keepDirs', e.target.value)}
            placeholder="node_modules, .venv"
            spellCheck={false}
          />
        </label>
        {repo.kind === 'unity' && (
          <label className="field span2">
            <span>Library のコピー元(Unity)</span>
            <input
              className="mono"
              value={f.seedLibraryFrom}
              onChange={(e) => upd('seedLibraryFrom', e.target.value)}
              placeholder="例: D:\Unity\TomsLands\Library(空 = コピーしない)"
              spellCheck={false}
            />
            <span className="hint">待機 worktree の作成時に Library をコピーして、初回オープンを速くします</span>
          </label>
        )}
        <label className="check-field span2">
          <input type="checkbox" checked={f.trusted} onChange={(e) => upd('trusted', e.target.checked)} />
          <span>このリポジトリを信頼する(信頼ダイアログに自動で Yes と答えます)</span>
        </label>
      </div>
      {invalid && dirty && <div className="form-error">{invalid}</div>}
      <div className="modal-foot">
        {msg && <span className={msg.ok ? 'ok-text' : 'form-error'}>{msg.text}</span>}
        <span className="spacer" />
        {dirty && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setF(base);
              setDirty(false);
            }}
          >
            元に戻す
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!dirty || busy || !!invalid}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
