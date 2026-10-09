// 新規セッションダイアログ(リポジトリから / フォルダを指定 / 履歴から再開)
import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry, ProjectEntry, SessionInfo, SessionMode, StartSessionRequest } from '@cc-hub/shared';
import { api, errText, pick, repoApi } from '../api';
import { useHub } from '../store';
import { fmtDate, projectLabel } from '../util';
import { KIND_LABEL, poolCounts, useRepoList, useWorktreesByRepo } from '../repo';
import { Spinner } from './RepoCommon';

type Tab = 'repo' | 'folder' | 'history';

export function NewSessionDialog() {
  const open = useHub((s) => s.newSessionOpen);
  const setOpen = useHub((s) => s.setNewSessionOpen);
  if (!open) return null;
  return <Dialog onClose={() => setOpen(false)} />;
}

function ModeSeg({ mode, setMode }: { mode: SessionMode; setMode: (m: SessionMode) => void }) {
  return (
    <div className="field">
      <span>モード</span>
      <div className="seg small">
        <button type="button" className={mode === 'commander' ? 'on' : ''} onClick={() => setMode('commander')}>
          commander
        </button>
        <button type="button" className={mode === 'plain' ? 'on' : ''} onClick={() => setMode('plain')}>
          plain
        </button>
      </div>
    </div>
  );
}

function Dialog({ onClose }: { onClose: () => void }) {
  const presetRepo = useHub((s) => s.newSessionRepo);
  const repos = useRepoList();
  const readyRepos = repos.filter((r) => r.status === 'ready');
  const [tab, setTab] = useState<Tab>(() => (presetRepo || readyRepos.length > 0 ? 'repo' : 'folder'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const start = async (req: StartSessionRequest) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('/api/sessions', req);
      const s = pick<SessionInfo>(r, 'session');
      const st = useHub.getState();
      if (s && s.id) {
        st.upsertSession(s);
        st.open(s.id);
      }
      onClose();
    } catch (e) {
      setErr(errText(e, '起動に失敗しました'));
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      className={tab === t ? 'on' : ''}
      onClick={() => {
        setTab(t);
        setErr(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title">
        <div className="modal-head">
          <h2 id="ns-title">新規セッション</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="seg" role="tablist">
          {tabBtn('repo', 'リポジトリから')}
          {tabBtn('folder', 'フォルダを指定')}
          {tabBtn('history', '履歴から再開')}
        </div>

        {tab === 'repo' ? (
          <RepoTab preset={presetRepo} busy={busy} err={err} setErr={setErr} start={start} onClose={onClose} />
        ) : tab === 'folder' ? (
          <FolderTab busy={busy} err={err} setErr={setErr} start={start} onClose={onClose} />
        ) : (
          <HistoryTab busy={busy} err={err} start={start} />
        )}
      </div>
    </div>
  );
}

interface TabProps {
  busy: boolean;
  err: string | null;
  setErr: (e: string | null) => void;
  start: (req: StartSessionRequest) => Promise<void>;
  onClose: () => void;
}

// ---------------------------------------------------------------- リポジトリから

function RepoTab({ preset, busy, err, setErr, start, onClose }: TabProps & { preset: string | null }) {
  const repos = useRepoList();
  const wtByRepo = useWorktreesByRepo();
  const openRepos = useHub((s) => s.openRepos);
  const ready = repos.filter((r) => r.status === 'ready');
  const [repoId, setRepoId] = useState<string>(() => {
    if (preset && ready.some((r) => r.id === preset)) return preset;
    // 選択中のセッションと同じリポジトリを優先
    const st = useHub.getState();
    const cur = st.selectedId ? st.sessions[st.selectedId]?.repoId : null;
    if (cur && ready.some((r) => r.id === cur)) return cur;
    return ready[0]?.id ?? '';
  });
  const [mode, setMode] = useState<SessionMode>('commander');
  const [instruction, setInstruction] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugLoading, setSlugLoading] = useState(false);
  /** 候補の取得待ち(入力直後〜応答まで)。この間に起動したら slug は送らずデーモンに任せる */
  const [slugPending, setSlugPending] = useState(false);
  const seq = useRef(0);

  // 指示の入力が止まって 800ms 後にブランチ名の候補を取る(ユーザーが編集したら上書きしない)
  useEffect(() => {
    if (slugEdited) return;
    const text = instruction.trim();
    const my = ++seq.current;
    if (!text) {
      setSlug('');
      setSlugPending(false);
      setSlugLoading(false);
      return;
    }
    setSlugPending(true);
    const t = setTimeout(() => {
      setSlugLoading(true);
      repoApi
        .slug(text)
        .then((r) => {
          if (my !== seq.current) return;
          const v = pick<string>(r, 'slug');
          if (typeof v === 'string') setSlug(v.replace(/^feat\//, ''));
        })
        .catch(() => {
          /* 候補が取れなくても起動はできる(デーモンが生成する) */
        })
        .finally(() => {
          if (my !== seq.current) return;
          setSlugLoading(false);
          setSlugPending(false);
        });
    }, 800);
    return () => clearTimeout(t);
  }, [instruction, slugEdited]);

  if (ready.length === 0) {
    const preparing = repos.filter((r) => r.status === 'cloning');
    return (
      <div className="modal-body">
        <div className="rp-empty in-modal">
          {preparing.length > 0 ? (
            <p>
              <Spinner /> {preparing.map((r) => r.name).join(', ')} をクローンしています。完了するとここから起動できます。
            </p>
          ) : (
            <p>利用できるリポジトリがありません。</p>
          )}
          <button
            className="btn primary"
            onClick={() => {
              onClose();
              openRepos({ page: 'register' });
            }}
          >
            + リポジトリを登録
          </button>
        </div>
      </div>
    );
  }

  const repo = ready.find((r) => r.id === repoId) ?? ready[0];
  const counts = poolCounts(wtByRepo[repo.id] ?? []);
  const slugClean = slug.trim().replace(/^feat\//, '');
  const slugInvalid = slugClean !== '' && !/^[a-z0-9][a-z0-9._/-]*$/i.test(slugClean);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = instruction.trim();
    if (!text && !slugClean) {
      setErr('指示を入力してください(ブランチ名の生成にも使います)');
      return;
    }
    if (slugInvalid) {
      setErr('ブランチ名は英数字と - _ . / だけにしてください');
      return;
    }
    const req: StartSessionRequest = { cwd: '', repoId: repo.id, mode };
    if (text) req.instruction = text;
    if (name.trim()) req.name = name.trim();
    // ユーザーが編集した値か、取得済みの候補があるときだけ送る(取得待ちならデーモンに生成を任せる)
    if (slugClean && (slugEdited || !slugPending)) req.branchSlug = slugClean;
    void start(req);
  };

  return (
    <form className="modal-body form" onSubmit={submit}>
      <div className="field">
        <span>リポジトリ</span>
        <div className="repo-pick" role="radiogroup" aria-label="リポジトリ">
          {ready.map((r) => {
            const c = poolCounts(wtByRepo[r.id] ?? []);
            return (
              <button
                type="button"
                role="radio"
                aria-checked={r.id === repo.id}
                key={r.id}
                className={`repo-opt ${r.id === repo.id ? 'on' : ''}`}
                onClick={() => setRepoId(r.id)}
                title={r.id}
              >
                <span className="repo-opt-name">{r.name}</span>
                <span className="repo-opt-sub">
                  {KIND_LABEL[r.kind]} · 待機 <b className={c.idle === 0 ? 'zero' : ''}>{c.idle}</b>
                  {c.preparing > 0 && ` · 準備中 ${c.preparing}`}
                </span>
              </button>
            );
          })}
        </div>
        {counts.idle === 0 ? (
          <span className="pool-warn">
            待機中の worktree がありません。作成してから起動します
            {counts.preparing > 0 ? `(準備中 ${counts.preparing} 本)` : ''}
          </span>
        ) : (
          <span className="hint">
            待機中の worktree {counts.idle} 本 — すぐに起動できます(<span className="mono">origin/{repo.defaultBranch}</span> から)
          </span>
        )}
        {repo.error && <span className="pool-warn">⚠ {repo.error}</span>}
      </div>
      <label className="field">
        <span>指示</span>
        <textarea
          rows={4}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={mode === 'commander' ? '/commander に渡す指示(例: ログイン後のリダイレクトを直して)' : '最初のプロンプト'}
          autoFocus
        />
      </label>
      <div className="field">
        <span>ブランチ</span>
        <div className="branch-input">
          <span className="branch-prefix mono">feat/</span>
          <input
            className="mono"
            value={slug}
            onChange={(e) => {
              const v = e.target.value;
              setSlug(v);
              setSlugEdited(v.trim() !== '');
            }}
            placeholder={slugLoading ? '候補を生成中…' : '指示から自動生成'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="ブランチ名(feat/ の後ろ)"
          />
          {slugLoading && <Spinner label="ブランチ名を生成中" />}
        </div>
        <span className={`hint ${slugInvalid ? 'warn-text' : ''}`}>
          {slugInvalid
            ? '英数字と - _ . / だけにしてください'
            : slugEdited
              ? '編集した名前を使います(空にすると自動生成に戻ります)'
              : '指示の入力が止まると候補を出します。編集もできます'}
        </span>
      </div>
      <ModeSeg mode={mode} setMode={setMode} />
      <label className="field">
        <span>名前(任意)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="省略時はブランチ名" />
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          キャンセル
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '起動中…' : counts.idle === 0 ? '作成して起動' : '起動'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- フォルダを指定

function FolderTab({ busy, err, setErr, start, onClose }: TabProps) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<SessionMode>('commander');
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');

  useEffect(() => {
    api('/api/projects')
      .then((r) => {
        const list = pick<ProjectEntry[]>(r, 'projects') ?? [];
        setProjects(list);
        if (list[0]) setCwd((c) => c || list[0].path);
      })
      .catch(() => setProjects([]));
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = cwd.trim();
    if (!c) {
      setErr('作業ディレクトリを指定してください');
      return;
    }
    const req: StartSessionRequest = { cwd: c, mode };
    if (name.trim()) req.name = name.trim();
    if (instruction.trim()) req.instruction = instruction.trim();
    void start(req);
  };

  return (
    <form className="modal-body form" onSubmit={submit}>
      <label className="field">
        <span>作業ディレクトリ</span>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="C:\Users\yanor\project"
          className="mono"
          spellCheck={false}
        />
      </label>
      {projects && projects.length > 0 && (
        <div className="proj-chips" aria-label="最近のプロジェクト">
          {projects.slice(0, 12).map((p) => (
            <button
              type="button"
              key={p.path}
              className={`chip ${cwd === p.path ? 'on' : ''}`}
              onClick={() => setCwd(p.path)}
              title={p.path}
            >
              {projectLabel(p.path)}
            </button>
          ))}
        </div>
      )}
      {projects === null && <div className="muted small">プロジェクト一覧を読み込み中…</div>}
      <ModeSeg mode={mode} setMode={setMode} />
      <label className="field">
        <span>名前(任意)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: login-fix" />
      </label>
      <label className="field">
        <span>指示</span>
        <textarea
          rows={4}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={mode === 'commander' ? '/commander に渡す指示' : '最初のプロンプト(任意)'}
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          キャンセル
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '起動中…' : '起動'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 履歴から再開

function HistoryTab({ busy, err, start }: Pick<TabProps, 'busy' | 'err' | 'start'>) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    api('/api/history?limit=30')
      .then((r) => setHistory(pick<HistoryEntry[]>(r, 'sessions') ?? []))
      .catch(() => setHistory([]));
  }, []);
  return (
    <div className="modal-body">
      {history === null ? (
        <div className="empty">読み込み中…</div>
      ) : history.length === 0 ? (
        <div className="empty">履歴がありません</div>
      ) : (
        <div className="hist-list">
          {history.map((h) => (
            <button
              key={h.id}
              className="hist-item"
              disabled={busy}
              onClick={() => void start({ cwd: h.cwd, mode: 'plain', resume: h.id })}
            >
              <span className="hist-title">{h.title || '(無題)'}</span>
              <span className="hist-sub">
                <span className="chip static">{projectLabel(h.cwd)}</span>
                {fmtDate(h.mtime)}
              </span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}
