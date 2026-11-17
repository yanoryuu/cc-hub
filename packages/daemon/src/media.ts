// セッションのフォルダにあるメディア(画像・動画・3D モデル)の一覧と、ファイル本体の配信(ビューア用)
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { MediaItem, MediaKind } from '@cc-hub/shared';
import { HttpError } from './util';
import { isInside } from './project/parse';

const KIND_BY_EXT: Record<string, MediaKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.mp4': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.ogv': 'video',
  '.fbx': 'model',
  '.stl': 'model',
  '.glb': 'model',
  '.gltf': 'model',
};

/** 配信するときの Content-Type(一覧に出す種類に加えて、glTF が参照する .bin やテクスチャ) */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.stl': 'model/stl',
};

/** 中を見ないフォルダ(依存物・ビルド生成物・Unity のキャッシュなど) */
const SKIP_DIRS = new Set([
  'node_modules',
  'library',
  'temp',
  'logs',
  'obj',
  'usersettings',
  '__pycache__',
  'venv',
  'bower_components',
]);

export const MEDIA_LIST_MAX = 1500;
const SCAN_MAX_ENTRIES = 40_000;
const SCAN_MAX_DEPTH = 10;
const SCAN_TIME_MS = 4_000;

export function mediaKind(p: string): MediaKind | null {
  return KIND_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

/**
 * root 以下のメディアを新しい順に返す。隠しフォルダ(. で始まる)と SKIP_DIRS は見ない。
 * 大きなフォルダで固まらないよう、件数・深さ・時間で打ち切る(truncated)
 */
export async function listMedia(root: string): Promise<{ items: MediaItem[]; truncated: boolean }> {
  const base = path.resolve(root);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(base);
  } catch {
    throw new HttpError(404, `フォルダがありません: ${root}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `フォルダではありません: ${root}`);
  const items: MediaItem[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  const started = Date.now();
  let seen = 0;
  let truncated = false;
  while (queue.length) {
    if (seen > SCAN_MAX_ENTRIES || Date.now() - started > SCAN_TIME_MS) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift()!;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    seen += ents.length;
    const files: string[] = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth + 1 > SCAN_MAX_DEPTH || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile() && mediaKind(e.name)) {
        files.push(abs);
      }
    }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(f).catch(() => null)));
    files.forEach((f, i) => {
      const s = stats[i];
      if (!s) return;
      items.push({ path: path.relative(base, f).replace(/\\/g, '/'), kind: mediaKind(f)!, size: s.size, mtime: Math.round(s.mtimeMs) });
    });
  }
  items.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  if (items.length > MEDIA_LIST_MAX) {
    truncated = true;
    items.length = MEDIA_LIST_MAX;
  }
  return { items, truncated };
}

/** root からの相対パス(/ 区切り)を検査して絶対パスにする。外に出るもの・.git 配下・シンボリックリンクで外を指すものは 400 */
export async function resolveMediaPath(root: string, rel: string): Promise<string> {
  const r = rel.replace(/\\/g, '/');
  if (!r || r.includes('\0') || r.startsWith('/') || /^[a-zA-Z]:/.test(r)) throw new HttpError(400, `不正なパスです: ${rel}`);
  const base = path.resolve(root);
  const abs = path.resolve(base, r);
  if (!isInside(base, abs) || abs === base) throw new HttpError(400, `不正なパスです: ${rel}`);
  if (path.relative(base, abs).split(/[\\/]/).some((s) => s.toLowerCase() === '.git')) throw new HttpError(400, `不正なパスです: ${rel}`);
  try {
    const [rr, ra] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(abs)]);
    if (!isInside(rr, ra)) throw new HttpError(400, `不正なパスです: ${rel}`);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(404, 'ファイルがありません');
  }
  return abs;
}

/** ファイル本体を返す(Range 対応。動画のシーク用)。HTML などとして解釈されないよう nosniff + CSP sandbox を付ける */
export async function sendMediaFile(req: http.IncomingMessage, res: http.ServerResponse, abs: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    throw new HttpError(404, 'ファイルがありません');
  }
  if (!st.isFile()) throw new HttpError(400, 'ファイルではありません');
  const ext = path.extname(abs).toLowerCase();
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  };
  if (req.headers['if-modified-since'] && !req.headers.range) {
    const since = Date.parse(String(req.headers['if-modified-since']));
    if (!Number.isNaN(since) && Math.floor(st.mtimeMs / 1000) <= Math.floor(since / 1000)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  const size = st.size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
