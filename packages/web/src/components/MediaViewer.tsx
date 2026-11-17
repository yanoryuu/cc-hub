// メディアビューア: セッションのフォルダの画像・動画・3D モデル(FBX / STL / GLB / glTF)を一覧から開いて見る
// デスクトップは右パネルの「メディア」タブ(上にプレビュー、下に一覧。⤢ で全画面)。スマホはサムネイルの格子から全画面で開く
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaItem, MediaKind, SessionInfo } from '@cc-hub/shared';
import { MEDIA_KIND_ICON, MEDIA_KIND_LABEL, extOf, mediaRawUrl, useMediaList } from '../media';
import type { ModelFormat, ModelHandle, ModelStats } from '../model3d';
import { fmtSize } from '../project';
import { fmtAgo } from '../pr';
import { baseName, fmtDate, useNow } from '../util';
import { Spinner } from './RepoCommon';

type Filter = '' | MediaKind;

/** SF Symbols に寄せた線のアイコン(フォントの記号は環境で形がばらつくため) */
const ICON_PATHS = {
  expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7',
  open: 'M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  reload: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15',
  close: 'M6 6l12 12M18 6 6 18',
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  save: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14',
} as const;
export function Icon({ name, size = 18 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="mv-icon">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  return a >= 100 ? n.toFixed(0) : a >= 1 ? n.toFixed(2) : n.toPrecision(3);
}

// ---------------------------------------------------------------- 3D

/** 3D モデルの表示(three.js は開いたときに初めて読み込む) */
export function ModelViewer({ url, format }: { url: string; format: ModelFormat }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<ModelHandle | null>(null);
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [spin, setSpin] = useState(false);
  const [clip, setClip] = useState(0);
  const [missing, setMissing] = useState(0);

  useEffect(() => {
    let alive = true;
    let h: ModelHandle | null = null;
    setStats(null);
    setErr(null);
    setLoading(true);
    setProgress(null);
    setWire(false);
    setGrid(true);
    setSpin(false);
    setClip(0);
    setMissing(0);
    import('../model3d')
      .then((m) => m.mountModel(box.current!, url, format, { onProgress: (r) => alive && setProgress(r), onMissingTextures: (n) => alive && setMissing(n) }))
      .then((r) => {
        if (!alive) return r.handle.dispose();
        h = r.handle;
        handle.current = r.handle;
        setStats(r.stats);
      })
      .catch((e) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setErr(/draco/i.test(msg) ? 'Draco で圧縮された glTF には対応していません' : `読み込めませんでした: ${msg}`);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      h?.dispose();
      handle.current = null;
    };
  }, [url, format]);

  return (
    <div className="m3d">
      <div className="m3d-stage" ref={box}>
        {loading && (
          <div className="m3d-overlay">
            <Spinner /> 読み込み中…{progress !== null && ` ${Math.round(progress * 100)}%`}
          </div>
        )}
        {err && (
          <div className="m3d-overlay form-error" role="alert">
            {err}
          </div>
        )}
      </div>
      {stats && (
        <div className="m3d-bar">
          <button className="btn sm ghost" onClick={() => handle.current?.resetView()} title="視点を最初の位置に戻す">
            ⟲ 視点
          </button>
          <button
            className={`btn sm ghost ${wire ? 'on' : ''}`}
            aria-pressed={wire}
            onClick={() => {
              handle.current?.setWireframe(!wire);
              setWire(!wire);
            }}
          >
            ワイヤー
          </button>
          <button
            className={`btn sm ghost ${grid ? 'on' : ''}`}
            aria-pressed={grid}
            onClick={() => {
              handle.current?.setGrid(!grid);
              setGrid(!grid);
            }}
          >
            グリッド
          </button>
          <button
            className={`btn sm ghost ${spin ? 'on' : ''}`}
            aria-pressed={spin}
            onClick={() => {
              handle.current?.setAutoRotate(!spin);
              setSpin(!spin);
            }}
          >
            回転
          </button>
          {stats.clips.length > 0 && (
            <select
              className="m3d-clip"
              value={clip}
              aria-label="アニメーション"
              onChange={(e) => {
                const i = Number(e.target.value);
                setClip(i);
                handle.current?.playClip(i);
              }}
            >
              <option value={-1}>アニメーションなし</option>
              {stats.clips.map((c, i) => (
                <option key={i} value={i}>
                  ▶ {c}
                </option>
              ))}
            </select>
          )}
          {missing > 0 && (
            <span className="m3d-warn small" title="モデルが参照しているテクスチャの画像がフォルダ内に見つからないため、素の色で表示しています">
              テクスチャなし {missing}
            </span>
          )}
          <span className="m3d-stats muted small" title={`メッシュ ${stats.meshes} 個`}>
            {stats.triangles.toLocaleString()} 三角形 · {stats.size.map(fmtNum).join(' × ')}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 1 件の表示

function MediaBody({ sessionId, item }: { sessionId: string; item: MediaItem }) {
  const url = mediaRawUrl(sessionId, item.path, item.mtime);
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [url]);
  if (item.kind === 'model') return <ModelViewer key={url} url={url} format={extOf(item.path) as ModelFormat} />;
  if (err)
    return (
      <div className="mv-msg form-error" role="alert">
        {item.kind === 'video' ? 'この動画はブラウザで再生できない形式です(H.264 の MP4 / WebM なら再生できます)' : '画像を表示できませんでした'}
      </div>
    );
  if (item.kind === 'video')
    return <video key={url} className="mv-video" src={url} controls playsInline preload="metadata" onError={() => setErr(true)} />;
  return (
    <div className="mv-img">
      <img src={url} alt={item.path} onError={() => setErr(true)} />
    </div>
  );
}

/** 全画面の表示(Esc で閉じる、← → で前後) */
function MediaLightbox({
  sessionId,
  items,
  index,
  onIndex,
  onClose,
}: {
  sessionId: string;
  items: MediaItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  // 閉じたら開く前にフォーカスがあった要素へ戻す
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  // 画像・動画は左右のスワイプで前後へ(3D はドラッグで回すので対象外)
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swipeable = item?.kind !== 'model';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        // 3D の操作中(キャンバスにフォーカス)でも切り替える。動画のシークは動画にフォーカスがあるときだけ
        if (e.target instanceof HTMLVideoElement) return;
        const n = index + (e.key === 'ArrowLeft' ? -1 : 1);
        if (n >= 0 && n < items.length) onIndex(n);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, items.length, onIndex, onClose]);
  if (!item) return null;
  return createPortal(
    <div className="mv-lightbox" role="dialog" aria-modal="true" aria-label={`${MEDIA_KIND_LABEL[item.kind]}: ${baseName(item.path)}`}>
      <div className="mv-lb-head">
        <span className="mv-lb-name" title={item.path}>
          <span className="mv-lb-file">{baseName(item.path)}</span>
          <span className="mv-lb-dir mono">{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''}</span>
        </span>
        <span className="muted small mv-lb-count">
          {index + 1} / {items.length}
        </span>
        <button className="icon-btn" onClick={() => onIndex(index - 1)} disabled={index <= 0} aria-label="前へ" title="前へ(←)">
          <Icon name="prev" />
        </button>
        <button className="icon-btn" onClick={() => onIndex(index + 1)} disabled={index >= items.length - 1} aria-label="次へ" title="次へ(→)">
          <Icon name="next" />
        </button>
        <a className="icon-btn" href={mediaRawUrl(sessionId, item.path)} download={baseName(item.path)} aria-label="保存" title="保存">
          <Icon name="save" />
        </a>
        <button className="icon-btn" onClick={onClose} aria-label="閉じる" title="閉じる(Esc)" autoFocus>
          <Icon name="close" />
        </button>
      </div>
      <div
        className="mv-lb-body"
        onTouchStart={(e) => {
          if (!swipeable || e.touches.length !== 1) return;
          touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          const t = touch.current;
          touch.current = null;
          if (!t || !swipeable) return;
          const dx = e.changedTouches[0].clientX - t.x;
          const dy = e.changedTouches[0].clientY - t.y;
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          const n = index + (dx > 0 ? -1 : 1);
          if (n >= 0 && n < items.length) onIndex(n);
        }}
      >
        <MediaBody key={item.path} sessionId={sessionId} item={item} />
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- 一覧

function Thumb({ sessionId, item }: { sessionId: string; item: MediaItem }) {
  const [bad, setBad] = useState(false);
  if (item.kind === 'image' && !bad && item.size < 8 * 1024 * 1024) {
    return <img className="mv-thumb" src={mediaRawUrl(sessionId, item.path, item.mtime)} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />;
  }
  return (
    <span className={`mv-thumb mv-thumb-ico k-${item.kind}`} aria-hidden="true">
      {item.kind === 'model' ? extOf(item.path).toUpperCase() : MEDIA_KIND_ICON[item.kind]}
    </span>
  );
}

/** メディアの一覧 + プレビュー。mobile は格子表示で、開くと全画面 */
export function MediaPanel({ session, mobile = false }: { session: SessionInfo; mobile?: boolean }) {
  const { items, truncated, loading, error, reload } = useMediaList(session.id);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<Filter>('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return items.filter((i) => (!filter || i.kind === filter) && (!qq || i.path.toLowerCase().includes(qq)));
  }, [items, filter, q]);
  const counts = useMemo(() => {
    const c = { image: 0, video: 0, model: 0 } as Record<MediaKind, number>;
    for (const i of items) c[i.kind]++;
    return c;
  }, [items]);
  const idx = sel ? list.findIndex((i) => i.path === sel) : -1;
  const selected = idx >= 0 ? list[idx] : null;

  const open = (p: string) => {
    setSel(p);
    if (mobile) setFull(true);
  };

  const filters: { v: Filter; label: string; n: number }[] = [
    { v: '', label: 'すべて', n: items.length },
    { v: 'image', label: '画像', n: counts.image },
    { v: 'video', label: '動画', n: counts.video },
    { v: 'model', label: '3D', n: counts.model },
  ];

  return (
    <div className={`mv ${mobile ? 'mv-mobile' : ''}`}>
      {!mobile && selected && (
        <div className="mv-prev">
          <div className="mv-prev-head">
            <span className={`mv-kind k-${selected.kind}`}>{selected.kind === 'model' ? extOf(selected.path).toUpperCase() : MEDIA_KIND_LABEL[selected.kind]}</span>
            <span className="mv-prev-name" title={selected.path}>
              {baseName(selected.path)}
            </span>
            <button className="icon-btn" onClick={() => setFull(true)} aria-label="全画面で見る" title="全画面で見る">
              <Icon name="expand" />
            </button>
            <a className="icon-btn" href={mediaRawUrl(session.id, selected.path)} target="_blank" rel="noreferrer" aria-label="新しいタブで開く" title="新しいタブで開く">
              <Icon name="open" />
            </a>
            <button className="icon-btn" onClick={() => setSel(null)} aria-label="プレビューを閉じる" title="プレビューを閉じる">
              <Icon name="close" />
            </button>
          </div>
          <div className="mv-prev-body">{!full && <MediaBody key={selected.path} sessionId={session.id} item={selected} />}</div>
        </div>
      )}
      <div className="mv-tools">
        <div className="seg small mv-seg" role="tablist" aria-label="種類">
          {filters.map((f) => (
            <button key={f.v || 'all'} role="tab" aria-selected={filter === f.v} className={filter === f.v ? 'on' : ''} onClick={() => setFilter(f.v)}>
              {f.label}
              <span className="mv-seg-n">{f.n}</span>
            </button>
          ))}
        </div>
        <div className="mv-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ファイル名で絞り込み" spellCheck={false} aria-label="ファイル名で絞り込み" />
          <button className="icon-btn" onClick={reload} aria-label="一覧を更新" title="一覧を更新">
            <Icon name="reload" />
          </button>
        </div>
      </div>
      {error ? (
        <div className="form-error pad" role="alert">
          {error}
        </div>
      ) : loading ? (
        <div className="empty small">
          <Spinner /> 探しています…
        </div>
      ) : items.length === 0 ? (
        <div className="rp-empty">
          このセッションのフォルダには、画像・動画・3D モデル(FBX / STL / GLB / glTF)が見つかりませんでした。
        </div>
      ) : list.length === 0 ? (
        <div className="empty small">条件に合うファイルはありません</div>
      ) : mobile ? (
        <ul className="mv-grid">
          {list.map((i) => (
            <li key={i.path}>
              <button className="mv-tile" onClick={() => open(i.path)} title={i.path}>
                <Thumb sessionId={session.id} item={i} />
                <span className="mv-tile-name">{baseName(i.path)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mv-list">
          {list.map((i) => (
            <li key={i.path}>
              <button className={`mv-row ${sel === i.path ? 'on' : ''}`} aria-current={sel === i.path} onClick={() => (sel === i.path ? setFull(true) : open(i.path))} onDoubleClick={() => { setSel(i.path); setFull(true); }} title={`${i.path}\n${fmtDate(i.mtime)}`}>
                <Thumb sessionId={session.id} item={i} />
                <span className="mv-row-main">
                  <span className="mv-row-name">{baseName(i.path)}</span>
                  <span className="mv-row-dir mono">{i.path.includes('/') ? i.path.slice(0, i.path.lastIndexOf('/')) : './'}</span>
                </span>
                <span className="mv-row-meta muted small">
                  <span>{fmtSize(i.size)}</span>
                  <span>{fmtAgo(i.mtime, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated && <div className="muted small mv-note">ファイルが多いため、新しいものから一部だけ表示しています</div>}
      {full && selected && (
        <MediaLightbox
          sessionId={session.id}
          items={list}
          index={idx}
          onIndex={(n) => list[n] && setSel(list[n].path)}
          onClose={() => {
            setFull(false);
            if (mobile) setSel(null);
          }}
        />
      )}
    </div>
  );
}
