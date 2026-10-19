// Claude が Discord で見せたい画像(スクリーンショット・モックなど。MCP の send_images)。
// すぐには送らず、セッションごとに預かる。そのターンが終わった通知(入力待ち / エラー)を Discord に送ったら、
// その通知のスレッドに投稿する(NotifyService)
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../util';

/** Discord の 1 メッセージの添付の上限 */
export const IMAGES_MAX = 10;
/** 1 枚の上限(Discord の既定の上限 10MB より少し小さく) */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** 1 回に送る合計の上限 */
export const IMAGES_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
/** 預かったまま送られなかった画像を捨てるまでの時間 */
export const PENDING_TTL_MS = 6 * 3600_000;
const CAPTION_MAX = 1500;

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface ImageFile {
  name: string;
  type: string;
  data: Buffer;
}

export interface PendingImages {
  files: ImageFile[];
  captions: string[];
  at: number;
}

/** 画像を読み込む(相対パスは cwd 基準)。形式・大きさ・枚数が合わなければ 400 */
export function loadImages(paths: string[], cwd: string | null): ImageFile[] {
  if (!paths.length) throw new HttpError(400, '送る画像のパスを指定してください');
  if (paths.length > IMAGES_MAX) throw new HttpError(400, `画像は 1 回 ${IMAGES_MAX} 枚までです`);
  const out: ImageFile[] = [];
  let total = 0;
  for (const raw of paths) {
    if (!path.isAbsolute(raw) && !cwd) throw new HttpError(400, `相対パスを使うときは cwd を指定してください: ${raw}`);
    const p = path.isAbsolute(raw) ? raw : path.resolve(cwd!, raw);
    const type = TYPES[path.extname(p).toLowerCase()];
    if (!type) throw new HttpError(400, `画像(png / jpg / gif / webp)ではありません: ${p}`);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      throw new HttpError(400, `ファイルが見つかりません: ${p}`);
    }
    if (!st.isFile()) throw new HttpError(400, `ファイルではありません: ${p}`);
    if (st.size > IMAGE_MAX_BYTES) throw new HttpError(400, `画像が大きすぎます(${mb(st.size)}。1 枚 ${mb(IMAGE_MAX_BYTES)} まで): ${p}`);
    total += st.size;
    if (total > IMAGES_TOTAL_MAX_BYTES) throw new HttpError(400, `画像の合計が大きすぎます(${mb(IMAGES_TOTAL_MAX_BYTES)} まで)`);
    out.push({ name: safeName(path.basename(p), out.length), type, data: fs.readFileSync(p) });
  }
  return out;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 添付のファイル名(Discord で表示される。英数字以外は _ に。重ならないように番号を付ける) */
export function safeName(name: string, i: number): string {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image';
  return `${String(i + 1).padStart(2, '0')}_${base}${ext}`;
}

/** セッションごとに預かる画像 */
export class ImageQueue {
  private readonly pending = new Map<string, PendingImages>();

  /** 預ける。前に預けた分に足す(合わせて IMAGES_MAX 枚まで)。戻り値 = 預かっている枚数 */
  add(sessionId: string, files: ImageFile[], caption: string, now = Date.now()): number {
    this.prune(now);
    const cur = this.pending.get(sessionId) ?? { files: [], captions: [], at: now };
    if (cur.files.length + files.length > IMAGES_MAX) {
      throw new HttpError(400, `このターンで送れる画像は ${IMAGES_MAX} 枚までです(預かり済み ${cur.files.length} 枚)`);
    }
    const total = [...cur.files, ...files].reduce((n, f) => n + f.data.length, 0);
    if (total > IMAGES_TOTAL_MAX_BYTES) throw new HttpError(400, `このターンで送る画像の合計が大きすぎます(${mb(IMAGES_TOTAL_MAX_BYTES)} まで)`);
    const offset = cur.files.length;
    cur.files.push(...files.map((f, i) => ({ ...f, name: f.name.replace(/^\d+_/, `${String(offset + i + 1).padStart(2, '0')}_`) })));
    const c = caption.trim().slice(0, CAPTION_MAX);
    if (c) cur.captions.push(c);
    cur.at = now;
    this.pending.set(sessionId, cur);
    return cur.files.length;
  }

  /** 取り出す(預かりは消える) */
  take(sessionId: string, now = Date.now()): PendingImages | null {
    this.prune(now);
    const p = this.pending.get(sessionId) ?? null;
    this.pending.delete(sessionId);
    return p;
  }

  count(sessionId: string): number {
    return this.pending.get(sessionId)?.files.length ?? 0;
  }

  private prune(now: number): void {
    for (const [k, v] of this.pending) if (now - v.at > PENDING_TTL_MS) this.pending.delete(k);
  }
}

/** 画像に添える文章(説明を並べる。Discord の上限に収める) */
export function imagesContent(header: string, p: PendingImages): string {
  const t = [header, ...p.captions].filter(Boolean).join('\n');
  return t.length > 1900 ? t.slice(0, 1899) + '…' : t;
}

/** Discord の multipart(payload_json + files[n]) */
export function imagesForm(payload: Record<string, unknown>, files: ImageFile[]): FormData {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)], { type: f.type }), f.name));
  return form;
}
