// 新規セッションダイアログ(新規起動 / 履歴から再開)
import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry, ProjectEntry, SessionInfo, SessionMode, StartSessionRequest } from '@cc-hub/shared';
import { api, pick } from '../api';
import { useHub } from '../store';
import { fmtDate, projectLabel } from '../util';

type Tab = 'new' | 'history';

export function NewSessionDialog() {
  const open = useHub((s) => s.newSessionOpen);
  const setOpen = useHub((s) => s.setNewSessionOpen);
  if (!open) return null;
  return <Dialog onClose={() => setOpen(false)} />;
}

function Dialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('new');
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<SessionMode>('commander');
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dlgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api('/api/projects')
      .then((r) => {
        const list = pick<ProjectEntry[]>(r, 'projects') ?? [];
        setProjects(list);
        if (list[0]) setCwd((c) => c || list[0].path);
      })
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (tab !== 'history' || history) return;
    api('/api/history?limit=30')
      .then((r) => setHistory(pick<HistoryEntry[]>(r, 'sessions') ?? []))
      .catch(() => setHistory([]));
  }, [tab, history]);

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
      setErr(e instanceof Error ? e.message : '起動に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const submitNew = (e: React.FormEvent) => {
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title" ref={dlgRef}>
        <div className="modal-head">
          <h2 id="ns-title">新規セッション</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>
            新規起動
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'on' : ''}
            onClick={() => setTab('history')}
          >
            履歴から再開
          </button>
        </div>

        {tab === 'new' ? (
          <form className="modal-body form" onSubmit={submitNew}>
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
        ) : (
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
        )}
      </div>
    </div>
  );
}
