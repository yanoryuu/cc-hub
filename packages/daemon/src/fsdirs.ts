// フォルダ選択(GET /api/fs/dirs)。スマホ / ブラウザからでも作業フォルダを選べるように、サブフォルダの一覧を返す。
// path 省略時はドライブ一覧 + ホーム / デスクトップ / ドキュメント。
import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry } from '@cc-hub/shared';
import { HOME } from './config';
import { HttpError } from './util';

/** 一覧の上限 */
export const DIRS_MAX = 500;

/** 一覧に出さないフォルダ(隠し・システム・依存物。Windows の隠し属性は Node から取れないので名前で判定) */
const SKIP_NAMES = new Set(
  [
    'node_modules',
    '.git',
    '$recycle.bin',
    'system volume information',
    'recovery',
    'config.msi',
    'msocache',
    'programdata',
    'appdata',
    'documents and settings',
    // ホームにある互換用のジャンクション(開けない)
    'application data',
    'local settings',
    'my documents',
    'nethood',
    'printhood',
    'recent',
    'sendto',
    'start menu',
    'templates',
    'cookies',
    'my music',
    'my pictures',
    'my videos',
  ].map((s) => s.toLowerCase()),
);

/** 一覧から除くフォルダ名か */
export function isSkippedDirName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.') || name.startsWith('$') || name.startsWith('~')) return true;
  return SKIP_NAMES.has(name.toLowerCase());
}

/** フォルダ名の一覧を絞り込んで並べる(大文字小文字を区別しない自然順。上限 max) */
export function filterDirNames(names: string[], max = DIRS_MAX): string[] {
  return names
    .filter((n) => !isSkippedDirName(n))
    .sort((a, b) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' }))
    .slice(0, max);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function dirEntry(p: string, name: string): DirEntry {
  return {
    name,
    path: p,
    isGitRepo: exists(path.join(p, '.git')),
    hasClaude: exists(path.join(p, '.claude')) || exists(path.join(p, 'CLAUDE.md')),
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ドライブ(C:\ など)。A: / B: はフロッピーで待たされることがあるので見ない */
function drives(): string[] {
  const out: string[] = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (exists(root)) out.push(root);
  }
  return out;
}

export interface DirsResult {
  ok: true;
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  /** 読めなかった(アクセス権など)ときの説明。dirs は空 */
  error?: string;
  /** 上限で切った */
  truncated?: boolean;
}

/** path 省略時の一覧(ドライブ + よく使う場所) */
function roots(): DirsResult {
  const dirs: DirEntry[] = drives().map((d) => dirEntry(d, d));
  const places: [string, string][] = [
    [HOME, `ホーム (${path.basename(HOME)})`],
    [path.join(HOME, 'Desktop'), 'デスクトップ'],
    [path.join(HOME, 'OneDrive', 'Desktop'), 'デスクトップ (OneDrive)'],
    [path.join(HOME, 'Documents'), 'ドキュメント'],
    [path.join(HOME, 'OneDrive', 'Documents'), 'ドキュメント (OneDrive)'],
  ];
  for (const [p, name] of places) if (isDir(p)) dirs.push(dirEntry(p, name));
  return { ok: true, path: '', parent: null, dirs };
}

/** GET /api/fs/dirs */
export function listDirs(raw: string | null | undefined): DirsResult {
  const input = String(raw ?? '').trim();
  if (!input) return roots();
  if (input.includes('\0')) throw new HttpError(400, 'パスが不正です');
  // "D:" だけならドライブのルートにする(path.resolve("D:") はそのドライブのカレントになるため)
  const abs = /^[a-zA-Z]:$/.test(input) ? `${input}\\` : path.resolve(input);
  if (!path.isAbsolute(input) && !/^[a-zA-Z]:$/.test(input)) throw new HttpError(400, '絶対パスを指定してください');
  const up = path.dirname(abs);
  const parent = up === abs ? null : up;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // アクセス権が無いだけなら一覧を空にして親へ戻れるようにする
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      return { ok: true, path: abs, parent, dirs: [], error: 'アクセス権がないため開けません' };
    }
    throw new HttpError(404, `フォルダがありません: ${abs}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `フォルダではありません: ${abs}`);
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = code === 'EPERM' || code === 'EACCES' ? 'アクセス権がないため開けません' : `開けません(${code || (e as Error).message})`;
    return { ok: true, path: abs, parent, dirs: [], error: msg };
  }
  const names: string[] = [];
  for (const d of ents) {
    if (d.isDirectory()) names.push(d.name);
    else if (d.isSymbolicLink() && isDir(path.join(abs, d.name))) names.push(d.name); // ジャンクション / リンク先がフォルダ
  }
  const kept = names.filter((n) => !isSkippedDirName(n));
  const picked = filterDirNames(kept);
  const res: DirsResult = { ok: true, path: abs, parent, dirs: picked.map((n) => dirEntry(path.join(abs, n), n)) };
  if (kept.length > picked.length) res.truncated = true;
  return res;
}
