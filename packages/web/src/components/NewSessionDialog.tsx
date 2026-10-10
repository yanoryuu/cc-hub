// 新規セッションダイアログ(プロジェクトから(worktree)/ フォルダで直接 / 履歴から再開)
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, SessionInfo, SessionMode, StartSessionRequest } from '@cc-hub/shared';
import { api, errText, pick, repoApi } from '../api';
import { useHub } from '../store';
import { fmtAgo, fmtDate, projectLabel } from '../util';
import { matchQuery, useProjectCatalog, useRecentProjects } from '../home';
import { normPath } from '../project';
import { FolderInput } from './FolderPicker';
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
  // 指定が無ければ、開いている管理画面のプロジェクトを最初から選んでおく
  const [{ presetRepo, presetCwd }] = useState(() => {
    const st = useHub.getState();
    if (st.newSessionRepo || st.newSessionCwd) return { presetRepo: st.newSessionRepo, presetCwd: st.newSessionCwd };
    if (st.deskView === 'project' || st.mobileProject) {
      return { presetRepo: st.project?.repoId ?? null, presetCwd: st.project?.repoId ? null : st.project?.cwd ?? null };
    }
    return { presetRepo: null, presetCwd: null };
  });
  const repos = useRepoList();
  const readyRepos = repos.filter((r) => r.status === 'ready');
  // 管理画面の「+ セッション」(フォルダ)から開いたときは「フォルダを指定」をそのパスで
  const [tab, setTab] = useState<Tab>(() => (presetCwd ? 'folder' : presetRepo || readyRepos.length > 0 ? 'repo' : 'folder'));
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
        <div className="seg ns-tabs" role="tablist" aria-label="始め方">
          {tabBtn('repo', 'プロジェクトから(worktree)')}
          {tabBtn('folder', 'フォルダで直接')}
          {tabBtn('history', '履歴から再開')}
        </div>

        {tab === 'repo' ? (
          <RepoTab preset={presetRepo} busy={busy} err={err} setErr={setErr} start={start} onClose={onClose} />
        ) : tab === 'folder' ? (
          <FolderTab preset={presetCwd} busy={busy} err={err} setErr={setErr} start={start} onClose={onClose} />
        ) : (
          <HistoryTab onClose={onClose} />
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
  const [q, setQ] = useState('');
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
        <span className="ns-step">
          <b>1</b> プロジェクトを選ぶ
          <span className="muted small">(登録リポジトリ。空いている worktree で始めるので並行作業できます)</span>
        </span>
        {ready.length > 4 && (
          <input
            type="search"
            className="ns-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="リポジトリを検索"
            aria-label="リポジトリを検索"
          />
        )}
        <div className="repo-pick ns-pick" role="radiogroup" aria-label="リポジトリ">
          {ready.filter((r) => r.id === repo.id || matchQuery(q, r.id, r.baseDir)).map((r) => {
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
                <span className="repo-opt-name">
                  {r.name} <span className="muted small">{r.owner}</span>
                </span>
                <span className="repo-opt-sub">
                  {KIND_LABEL[r.kind]} · 待機 <b className={c.idle === 0 ? 'zero' : ''}>{c.idle}</b>
                  {c.preparing > 0 && ` · 準備中 ${c.preparing}`}
                </span>
              </button>
            );
          })}
        </div>
        <span className="hint">
          フォルダでそのまま始めるなら「フォルダで直接」、新しいリポジトリは{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              onClose();
              openRepos({ page: 'register' });
            }}
          >
            GitHub からクローンして追加
          </button>
        </span>
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
        <span className="ns-step">
          <b>2</b> 指示
        </span>
        <textarea
          rows={4}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={mode === 'commander' ? '/commander に渡す指示(例: ログイン後のリダイレクトを直して)' : '最初のプロンプト'}
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

// ---------------------------------------------------------------- フォルダで直接

function FolderTab({ preset, busy, err, setErr, start, onClose }: TabProps & { preset: string | null }) {
  const cat = useProjectCatalog();
  const recent = useRecentProjects();
  const [cwd, setCwd] = useState(preset ?? '');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<SessionMode>('commander');
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');

  // 候補: ホームのフォルダ(セッションのあるフォルダ + 最近のプロジェクト)。先頭を自動選択はしない
  // (意図しない実プロジェクトで起動してしまうのを防ぐ)
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; last: number; active: number }[] = [];
    const add = (p: string, last: number, active: number) => {
      const k = normPath(p);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ path: p, last, active });
    };
    for (const f of cat.folders) add(f.path, f.lastActivity, f.active.length);
    for (const p of recent ?? []) add(p.path, p.lastUsed, 0);
    return out.filter((o) => matchQuery(q, o.path)).slice(0, 20);
  }, [cat.folders, recent, q]);

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
      <div className="field">
        <span className="ns-step">
          <b>1</b> フォルダを選ぶ
          <span className="muted small">(worktree は使わず、このフォルダで直接動きます)</span>
        </span>
        <FolderInput value={cwd} onChange={setCwd} label="作業ディレクトリ" />
        <input
          type="search"
          className="ns-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="最近のフォルダを検索"
          aria-label="最近のフォルダを検索"
        />
        <div className="ns-folders" role="radiogroup" aria-label="最近のフォルダ">
          {recent === null && options.length === 0 ? (
            <span className="muted small">読み込み中…</span>
          ) : options.length === 0 ? (
            <span className="muted small">{q ? '一致するフォルダがありません' : '最近のフォルダはありません。「参照…」から選べます'}</span>
          ) : (
            options.map((o) => {
              const on = normPath(cwd) === normPath(o.path);
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  key={o.path}
                  className={`of-row ${on ? 'on' : ''}`}
                  onClick={() => setCwd(o.path)}
                  title={o.path}
                >
                  <span className="of-name">{projectLabel(o.path)}</span>
                  <span className="of-path mono">{o.path}</span>
                  <span className="of-time muted">
                    {o.active > 0 ? `${o.active} 件動作中 · ` : ''}
                    {o.last ? fmtAgo(o.last) : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
      <label className="field">
        <span className="ns-step">
          <b>2</b> 指示
        </span>
        <textarea
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={mode === 'commander' ? '/commander に渡す指示' : '最初のプロンプト(任意)'}
        />
      </label>
      <ModeSeg mode={mode} setMode={setMode} />
      <label className="field">
        <span>名前(任意)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: login-fix" />
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          キャンセル
        </button>
        <button type="submit" className="btn primary" disabled={busy || !cwd.trim()}>
          {busy ? '起動中…' : '起動'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 履歴から再開(最近の数件 + 履歴画面へのリンク)

function HistoryTab({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setTopView = useHub((s) => s.setTopView);
  useEffect(() => {
    api('/api/history?limit=8')
      .then((r) => setHistory(pick<HistoryEntry[]>(r, 'sessions') ?? []))
      .catch(() => setHistory([]));
  }, []);
  const resume = async (h: HistoryEntry) => {
    setBusy(h.id);
    setErr(null);
    try {
      const r = await api(`/api/history/${encodeURIComponent(h.id)}/open`, { target: 'hub' });
      const s = pick<SessionInfo>(r, 'session');
      const st = useHub.getState();
      if (s && s.id) {
        st.upsertSession(s);
        st.open(s.id);
      }
      onClose();
    } catch (e) {
      setErr(errText(e, '再開できませんでした'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="modal-body">
      <div className="ns-hist-head">
        <span className="muted small">最近の会話(タップで CC Hub で再開)</span>
        <button
          className="btn sm"
          onClick={() => {
            onClose();
            setTopView('history');
          }}
        >
          すべての履歴を見る →
        </button>
      </div>
      {history === null ? (
        <div className="empty">読み込み中…</div>
      ) : history.length === 0 ? (
        <div className="empty">履歴がありません</div>
      ) : (
        <div className="hist-list">
          {history.map((h) => (
            <button key={h.id} className="hist-item" disabled={!!busy} onClick={() => void resume(h)}>
              <span className="hist-title">{busy === h.id ? '再開中…' : h.title || '(無題)'}</span>
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
