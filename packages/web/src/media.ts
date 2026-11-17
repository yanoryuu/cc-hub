// メディアビューア: セッションのフォルダの画像・動画・3D モデルの一覧取得と URL
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem, MediaKind } from '@cc-hub/shared';
import { api, errText } from './api';

const enc = encodeURIComponent;

/** ファイル本体の URL(パス形式。glTF の .bin / テクスチャを相対 URL で解決できる) */
export function mediaRawUrl(sessionId: string, rel: string, version?: number): string {
  const u = `/api/sessions/${enc(sessionId)}/raw/${rel.split('/').map(enc).join('/')}`;
  return version ? `${u}?v=${version}` : u;
}

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = { image: '画像', video: '動画', model: '3D' };
export const MEDIA_KIND_ICON: Record<MediaKind, string> = { image: '▣', video: '▶', model: '◆' };

/** 拡張子(小文字、ドットなし) */
export function extOf(p: string): string {
  const b = p.slice(p.lastIndexOf('/') + 1);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

export interface MediaList {
  items: MediaItem[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 表示中だけ取得する。タブに戻ったときと 20 秒ごとにも取り直す(Claude が作ったファイルを拾うため) */
export function useMediaList(sessionId: string): MediaList {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);

  const load = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    api<{ items?: MediaItem[]; truncated?: boolean }>(`/api/sessions/${enc(sessionId)}/media`)
      .then((r) => {
        if (!alive.current) return;
        setItems(r.items ?? []);
        setTruncated(!!r.truncated);
        setError(null);
      })
      .catch((e) => alive.current && setError(errText(e, 'ファイルの一覧を取得できませんでした')))
      .finally(() => {
        inflight.current = false;
        if (alive.current) setLoading(false);
      });
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setItems([]);
    load();
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 20_000);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [load]);

  return { items, truncated, loading, error, reload: load };
}
