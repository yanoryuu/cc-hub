// 添付ファイル(画像など)を <cwd>\.cc-hub\attachments\ に保存する。指示に "@.cc-hub/attachments/<名前>" で入れて Claude に読ませる。
// .cc-hub/ は .git/info/exclude に入れてコミットされないようにする(worktree は共通の git dir の exclude)。
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../util';
import { git } from '../repo/exec';

export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
};

/** 拡張子 → MIME。Windows のブラウザは .md などの MIME を空で渡す(→ application/octet-stream)ので、そのときは拡張子で決める */
const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/** MIME が空・不明(application/octet-stream)なら、ファイル名の拡張子から決める */
export function resolveMime(name: string, mime: string): string {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m && m !== 'application/octet-stream') return m;
  const ext = path.extname(String(name ?? '').split(/[\\/]/).pop() ?? '').toLowerCase();
  return MIME_BY_EXT[ext] ?? m;
}

/** zip の MIME(Windows の Chrome / Edge は application/x-zip-compressed で渡す) */
const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed', 'application/x-zip']);

/** 受け付ける MIME(image/* と text/* と application/pdf と zip) */
export function isAllowedMime(mime: string): boolean {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  return /^image\/[a-z0-9.+-]+$/.test(m) || /^text\/[a-z0-9.+-]+$/.test(m) || m === 'application/pdf' || ZIP_MIMES.has(m);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * ファイル名を安全にする: パスを除き、Windows で使えない文字・制御文字・空白を _ に。
 * 先頭末尾の . と空白を落とし、予約名(CON など)は _ を付ける。拡張子が無ければ MIME から付ける。最大 80 文字(拡張子は残す)
 */
export function sanitizeAttachmentName(name: string, mime = ''): string {
  let n = String(name ?? '').split(/[\\/]/).pop() ?? '';
  n = n
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*%#@`$&'()[\]{};!^=+,~]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._\s]+$/g, '');
  let ext = path.extname(n).toLowerCase();
  let stem = ext ? n.slice(0, -ext.length) : n;
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) {
    stem = n;
    ext = '';
  }
  const mimeExt = EXT_BY_MIME[String(mime).toLowerCase().split(';')[0].trim()] ?? '';
  if (!ext) {
    ext = mimeExt;
    stem = stem.replace(/\.+$/, '');
  }
  if (!stem) stem = 'file';
  if (RESERVED.test(stem)) stem = `_${stem}`;
  const max = 80 - ext.length;
  if (stem.length > max) stem = stem.slice(0, max).replace(/[._]+$/, '') || 'file';
  return stem + ext;
}

/** yyyymmdd-hhmmss(ローカル時刻) */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * cwd が git リポジトリの中なら、.cc-hub/ を共通の git dir(worktree でも本体)の info/exclude に入れる。
 * relFile(cwd からの相対パス)が既に無視されていれば何もしない
 */
export async function ensureCcHubExcluded(cwd: string, relFile: string): Promise<boolean> {
  const r = await git(['-C', cwd, 'rev-parse', '--git-common-dir'], { timeout: 15_000 });
  if (r.code !== 0) return false; // git リポジトリではない
  const ignored = await git(['-C', cwd, 'check-ignore', '-q', '--', relFile], { timeout: 15_000 });
  if (ignored.code === 0) return true;
  const commonDir = path.resolve(cwd, r.stdout.trim());
  const exclude = path.join(commonDir, 'info', 'exclude');
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  // cwd がリポジトリのサブフォルダでも効くよう、先頭の / を付けない(どの階層の .cc-hub/ にも一致)
  if (!/^\.cc-hub\/?\s*$/m.test(cur)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# CC Hub: 添付ファイル・指示ファイル\n.cc-hub/\n`);
  }
  return true;
}

export interface AttachRequest {
  name?: unknown;
  mime?: unknown;
  dataBase64?: unknown;
}

/** 添付を保存して cwd からの相対パス(/ 区切り)を返す */
export async function saveAttachment(cwd: string, body: AttachRequest): Promise<string> {
  const mime = resolveMime(String(body?.name ?? ''), String(body?.mime ?? ''));
  if (!isAllowedMime(mime))
    throw new HttpError(415, `この種類のファイルは添付できません: ${mime || '(不明)'}(画像・テキスト(.md など)・PDF・zip のみ)`);
  const b64 = String(body?.dataBase64 ?? '').replace(/^data:[^,]*,/, '');
  if (!b64) throw new HttpError(400, 'dataBase64 が空です');
  if (b64.length > Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 8) throw new HttpError(413, '10 MB を超えるファイルは添付できません');
  const data = Buffer.from(b64, 'base64');
  if (!data.length) throw new HttpError(400, 'ファイルが空です');
  if (data.length > ATTACH_MAX_BYTES) throw new HttpError(413, '10 MB を超えるファイルは添付できません');
  let st: fs.Stats;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new HttpError(400, `ディレクトリが存在しません: ${cwd}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `ディレクトリが存在しません: ${cwd}`);
  const dir = path.join(cwd, '.cc-hub', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${stamp()}-${sanitizeAttachmentName(String(body?.name ?? ''), mime)}`;
  let file = base;
  for (let i = 1; fs.existsSync(path.join(dir, file)); i++) {
    const ext = path.extname(base);
    file = `${base.slice(0, base.length - ext.length)}-${i}${ext}`;
  }
  fs.writeFileSync(path.join(dir, file), data, { flag: 'wx' });
  const rel = `.cc-hub/attachments/${file}`;
  try {
    await ensureCcHubExcluded(cwd, rel);
  } catch (e) {
    console.error('[attach] .git/info/exclude に追加できませんでした', (e as Error).message);
  }
  return rel;
}
