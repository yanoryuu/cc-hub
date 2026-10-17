// 「最新の main」: 閲覧用の作業ツリー(<baseDir>\main)を origin/<default> の最新に合わせてから Unity / フォルダで開く。
// プロジェクト画面の上部に置く。押すたびに最新に合わせ直す(この作業ツリーでの変更は消える)
import { useEffect, useRef, useState } from 'react';
import type { MainViewOpen, MainViewStatus, RepoInfo } from '@cc-hub/shared';
import { api, errText, pick } from '../api';
import { fmtAgo } from '../pr';
import { useNow } from '../util';
import { Spinner } from './RepoCommon';

const enc = encodeURIComponent;
const busyPhase = (s: MainViewStatus | null) => s?.phase === 'updating' || s?.phase === 'copying';

export function MainViewButton({ repo }: { repo: RepoInfo }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<MainViewStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const now = useNow(30000);
  const def = repo.defaultBranch || 'main';
  const isUnity = repo.kind === 'unity';

  const load = async () => {
    try {
      setSt(pick<MainViewStatus>(await api(`/api/repos/${enc(repo.id)}/main`), 'main') ?? null);
      setErr(null);
    } catch (e) {
      setErr(errText(e, '状態を読めませんでした'));
    }
  };

  // 開いたら状態を読む。合わせている間は 1.5 秒ごとに読み直す
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo.id]);
  useEffect(() => {
    if (!busyPhase(st)) return;
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  // 外側のクリック / Esc で閉じる(処理は裏で続く)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (how: MainViewOpen) => {
    setStarting(true);
    setErr(null);
    try {
      setSt(pick<MainViewStatus>(await api(`/api/repos/${enc(repo.id)}/main`, { open: how }), 'main') ?? null);
    } catch (e) {
      setErr(errText(e, '最新の main を用意できませんでした'));
    } finally {
      setStarting(false);
    }
  };

  const busy = starting || busyPhase(st);
  const ready = repo.status === 'ready';

  return (
    <div className="mainview" ref={box}>
      <button
        type="button"
        className="btn ghost sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!ready}
        title={ready ? `最新の ${def} を確認用に開きます` : 'リポジトリの準備ができていません'}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Spinner /> : <span aria-hidden="true">⎇</span>} 最新の {def}
      </button>
      {open && (
        <div className="mainview-pop" role="dialog" aria-label={`最新の ${def}`}>
          <div className="mainview-title">最新の {def} を開く</div>
          <p className="hint">
            確認用の作業ツリーを <span className="mono">origin/{def}</span> の最新に合わせてから開きます。押すたびに最新になります。
            ここで変更した内容は次に合わせたときに消えるので、作業はセッションで行ってください。
          </p>
          {st?.exists && st.head && (
            <div className="mainview-head">
              <span className="mono">{st.head}</span> <span className="mainview-subject">{st.subject}</span>
              {st.committedAt && <span className="muted small"> ・{fmtAgo(st.committedAt, now)}</span>}
            </div>
          )}
          {st && <div className="mono small muted break">{st.path}</div>}
          {busy && (
            <div className="rp-alert info" role="status">
              <Spinner /> {st?.progress ?? '準備中…'}
            </div>
          )}
          {!busy && st?.phase === 'ready' && st.updatedAt && (
            <div className="ok-text small" role="status">
              ✓ 最新にしました({st.pulled > 0 ? `${st.pulled} 件のコミットを取り込み` : '変更なし'}){st.openMessage ? ` — ${st.openMessage}` : ''}
            </div>
          )}
          {st?.phase === 'error' && st.error && <div className="form-error">{st.error}</div>}
          {err && <div className="form-error">{err}</div>}
          <div className="mainview-actions">
            {isUnity && (
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => void run('unity')}>
                Unity で開く
              </button>
            )}
            <button type="button" className={`btn sm ${isUnity ? '' : 'primary'}`} disabled={busy} onClick={() => void run('folder')}>
              フォルダを開く
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void run('none')}>
              最新にするだけ
            </button>
          </div>
          {isUnity && !st?.exists && (
            <p className="hint small">初回は作業ツリーの作成と Library のコピーで数分かかります。</p>
          )}
        </div>
      )}
    </div>
  );
}
