// フォルダの選択: パス入力欄 + 「参照…」。デスクトップ版(Electron)は Windows のフォルダ選択ダイアログ、
// ブラウザ / スマホは /api/fs/dirs を使ったアプリ内のフォルダブラウザを開く
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DirEntry } from '@cc-hub/shared';
import { api, errText } from '../api';
import { Spinner } from './RepoCommon';

interface DirList {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

async function fetchDirs(path: string): Promise<DirList> {
  const r = await api<{ path?: string; parent?: string | null; dirs?: DirEntry[] }>(
    `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  );
  return { path: r.path ?? path, parent: r.parent ?? null, dirs: r.dirs ?? [] };
}

/** "D:\WorkTree\shop-web" → [["D:\", "D:\"], ["WorkTree", "D:\WorkTree"], ["shop-web", "D:\WorkTree\shop-web"]] */
function crumbs(p: string): [string, string][] {
  const t = p.replace(/[\\/]+$/, '');
  if (!t) return [];
  const sep = t.includes('\\') || /^[a-z]:/i.test(t) ? '\\' : '/';
  const parts = t.split(/[\\/]+/);
  const out: [string, string][] = [];
  let acc = '';
  parts.forEach((part, i) => {
    if (i === 0) {
      acc = /^[a-z]:$/i.test(part) ? `${part}\\` : part === '' ? '/' : part;
      out.push([acc, acc]);
      return;
    }
    acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
    out.push([part, acc]);
  });
  return out;
}

/** 「参照…」: Electron のダイアログがあればそれ、なければアプリ内のブラウザ */
export function BrowseButton({
  value,
  onPick,
  className = 'btn',
}: {
  value: string;
  onPick: (path: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const browse = async () => {
    const native = window.ccHub?.pickFolder;
    if (native) {
      try {
        const p = await native();
        if (p) onPick(p);
        return;
      } catch {
        /* 失敗したらアプリ内のブラウザで */
      }
    }
    setOpen(true);
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void browse()} title="フォルダを選ぶ">
        参照…
      </button>
      {open && (
        <FolderBrowserModal
          initial={value}
          onPick={(p) => {
            onPick(p);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** パスの入力欄 + 「参照…」 */
export function FolderInput({
  value,
  onChange,
  placeholder = 'C:\\Users\\yanor\\project',
  autoFocus,
  label,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  label?: string;
  onEnter?: () => void;
}) {
  return (
    <div className="folder-input">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mono"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus={autoFocus}
        aria-label={label ?? 'フォルダのパス'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <BrowseButton value={value} onPick={onChange} />
    </div>
  );
}

/** アプリ内のフォルダブラウザ(/api/fs/dirs)。ドライブとホームのショートカット / パンくず / 上へ / 絞り込み */
export function FolderBrowserModal({
  initial,
  onPick,
  onClose,
}: {
  initial?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string>(initial?.trim() ?? '');
  const [data, setData] = useState<DirList | null>(null);
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  // ドライブ / ホーム(ショートカット用)
  useEffect(() => {
    fetchDirs('')
      .then((r) => setRoots(r.dirs))
      .catch(() => setRoots([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetchDirs(path)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setFilter('');
      })
      .catch((e) => {
        if (!alive) return;
        setErr(errText(e, 'フォルダを読み込めませんでした'));
        // 最初に渡されたパスが無ければドライブ一覧から
        if (!data && path) setPath('');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Esc はこのダイアログだけを閉じる(下のダイアログまで閉じないように捕捉段階で止める)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const cur = data?.path ?? '';
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const dirs = data?.dirs ?? [];
    return q ? dirs.filter((d) => d.name.toLowerCase().includes(q)) : dirs;
  }, [data, filter]);

  return createPortal(
    <div className="modal-backdrop fb-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fb-modal" role="dialog" aria-modal="true" aria-labelledby="fb-title">
        <div className="modal-head">
          <h2 id="fb-title">フォルダを選ぶ</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body fb-body">
          {roots.length > 0 && (
            <div className="fb-roots" aria-label="ドライブとホーム">
              {roots.map((r) => (
                <button
                  type="button"
                  key={r.path}
                  className={`chip ${cur === r.path ? 'on' : ''}`}
                  onClick={() => setPath(r.path)}
                  title={r.path}
                >
                  {/^[a-z]:\\?$/i.test(r.path) ? `◫ ${r.name}` : `⌂ ${r.name}`}
                </button>
              ))}
            </div>
          )}
          <div className="fb-nav">
            <button
              type="button"
              className="btn sm"
              disabled={!cur}
              onClick={() => setPath(data?.parent ?? '')}
              aria-label="ひとつ上のフォルダへ"
              title="ひとつ上へ"
            >
              ↑ 上へ
            </button>
            <nav className="fb-crumbs mono" aria-label="現在のフォルダ">
              {cur ? (
                crumbs(cur).map(([label, p], i, a) => (
                  <span key={p} className="fb-crumb">
                    {i > 0 && <span className="fb-sep" aria-hidden="true">›</span>}
                    {i === a.length - 1 ? (
                      <span className="fb-here" aria-current="location">
                        {label}
                      </span>
                    ) : (
                      <button type="button" className="link-btn" onClick={() => setPath(p)}>
                        {label}
                      </button>
                    )}
                  </span>
                ))
              ) : (
                <span className="muted">ドライブとホーム</span>
              )}
            </nav>
          </div>
          <input
            className="fb-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="このフォルダ内を絞り込み"
            aria-label="フォルダ名で絞り込み"
          />
          <div className="fb-list" role="list">
            {loading && !data ? (
              <div className="empty">
                <Spinner /> 読み込み中…
              </div>
            ) : err ? (
              <div className="form-error">{err}</div>
            ) : list.length === 0 ? (
              <div className="empty">{filter ? '一致するフォルダがありません' : 'サブフォルダはありません'}</div>
            ) : (
              list.map((d) => (
                <div key={d.path} className="fb-row" role="listitem">
                  <button type="button" className="fb-open" onClick={() => setPath(d.path)} title={`${d.path} を開く`}>
                    <span className="fb-ico" aria-hidden="true">
                      ▸
                    </span>
                    <span className="fb-name">{d.name}</span>
                    {d.isGitRepo && <span className="fb-badge git">Git</span>}
                    {d.hasClaude && <span className="fb-badge claude">Claude</span>}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => onPick(d.path)} aria-label={`${d.name} を選ぶ`}>
                    選ぶ
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="modal-foot">
            <span className="fb-cur mono muted" title={cur}>
              {cur || '—'}
            </span>
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="btn primary" disabled={!cur} onClick={() => onPick(cur)}>
              このフォルダを選ぶ
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
