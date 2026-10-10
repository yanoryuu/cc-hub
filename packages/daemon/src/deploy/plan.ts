// アップロードの差分計算(純粋関数 + ローカルの走査)。
// - 除外: .git / node_modules / .cc-hub は常に除外 + サーバーごとの exclude(glob)
// - 変更の判定: リモートに <remoteDir>/.cc-hub-deploy.json(前回送った各ファイルの size + sha1)があればそれを優先し、
//   無いファイルはサイズ + 更新時刻(取れない場合はサイズだけ)で比べる
// - リモートのパスは常に / 区切り(posix)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DeployPlan } from '@cc-hub/shared';

export const MANIFEST_NAME = '.cc-hub-deploy.json';
/** アップロード中の一時ファイルの印(<名前>.cc-hub-tmp-<乱数>) */
export const TMP_MARK = '.cc-hub-tmp-';
export const ALWAYS_EXCLUDE = ['.git', 'node_modules', '.cc-hub'];
/** 走査するファイル数の上限(誤って巨大なフォルダを指定したときの安全装置) */
export const MAX_FILES = 20_000;
/** 更新時刻の比較の許容差(FTP の時刻の丸め・時計のずれ) */
export const MTIME_SLACK_MS = 2_000;

export interface LocalFile {
  rel: string; // / 区切り
  abs: string;
  size: number;
  mtime: number;
  sha1?: string;
}

export interface RemoteFile {
  size: number;
  /** 取れない場合(FTP で MLSD が無い)は null */
  mtime: number | null;
}

export interface Manifest {
  version: 1;
  updatedAt: number;
  files: Record<string, { size: number; sha1: string }>;
}

// ------------------------------------------------------------ パス
/** リモートのフォルダの正規化(\ → /、重複・末尾の / を除く)。空は不可 */
export function normRemoteDir(dir: string): string {
  let s = String(dir ?? '').trim().replace(/\\/g, '/');
  if (!s) throw new Error('アップロード先のフォルダ(remoteDir)を指定してください');
  if (s.split('/').includes('..')) throw new Error('remoteDir に .. は使えません');
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/** 相対パスの検証と正規化(/ 区切り。.. や絶対パスは不可) */
export function normRel(rel: string): string {
  const s = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) throw new Error(`相対パスではありません: ${rel}`);
  const parts = s.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new Error(`不正なパス: ${rel}`);
  return s;
}

/** リモートのフォルダ + 相対パス(posix) */
export function joinRemote(dir: string, rel: string): string {
  const d = normRemoteDir(dir);
  const r = normRel(rel);
  return d === '/' ? `/${r}` : `${d}/${r}`;
}

/** 相対パスの親フォルダ('' = 直下) */
export function relDir(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

// ------------------------------------------------------------ 除外
function globToRe(g: string): string {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // **/ = 0 個以上のフォルダ、末尾の ** = 何でも
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/**
 * exclude パターン。/ を含まないもの(例: "*.map", "drafts")はどの階層の名前にも一致し、
 * / を含むもの(例: "assets/raw", "/secret.txt")は localDir からの相対パスに一致する。フォルダに一致したら中身も除外
 */
export function compileExcludes(patterns: string[]): (rel: string) => boolean {
  const all = [...ALWAYS_EXCLUDE, MANIFEST_NAME, ...patterns.map((p) => String(p ?? '').trim()).filter(Boolean)];
  const nameRes: RegExp[] = [];
  const pathRes: RegExp[] = [];
  for (let p of all) {
    p = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p) continue;
    if (p.includes('/')) pathRes.push(new RegExp(`^${globToRe(p.replace(/^\/+/, ''))}(?:/.*)?$`, 'i'));
    else nameRes.push(new RegExp(`^${globToRe(p)}$`, 'i'));
  }
  return (rel: string) => {
    if (rel.includes(TMP_MARK)) return true;
    const parts = rel.split('/');
    if (parts.some((seg) => nameRes.some((re) => re.test(seg)))) return true;
    return pathRes.some((re) => re.test(rel));
  };
}

// ------------------------------------------------------------ ローカルの走査
export async function walkLocal(root: string, isExcluded: (rel: string) => boolean): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (isExcluded(rel)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // リンクは辿らない(ループと意図しない送信を避ける)
      if (ent.isDirectory()) await walk(abs, rel);
      else if (ent.isFile()) {
        const st = await fs.promises.stat(abs);
        out.push({ rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
        if (out.length > MAX_FILES) throw new Error(`ファイルが多すぎます(${MAX_FILES} 件超)。localDir か exclude を見直してください`);
      }
    }
  };
  await walk(root, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

export function sha1File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// ------------------------------------------------------------ 差分
export function parseManifest(text: string | null): Manifest | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (!j || j.version !== 1 || typeof j.files !== 'object' || !j.files) return null;
    const files: Manifest['files'] = {};
    for (const [k, v] of Object.entries(j.files as Record<string, any>)) {
      if (v && Number.isFinite(v.size) && typeof v.sha1 === 'string') files[k] = { size: Number(v.size), sha1: v.sha1 };
    }
    return { version: 1, updatedAt: Number(j.updatedAt) || 0, files };
  } catch {
    return null;
  }
}

export function buildManifest(local: LocalFile[], now = Date.now()): Manifest {
  const files: Manifest['files'] = {};
  for (const f of local) if (f.sha1) files[f.rel] = { size: f.size, sha1: f.sha1 };
  return { version: 1, updatedAt: now, files };
}

export interface PlanInput {
  local: LocalFile[];
  /** リモートのファイル(相対パス → サイズ・時刻。マニフェスト自身は含めない) */
  remote: Map<string, RemoteFile>;
  manifest: Manifest | null;
  deleteExtra: boolean;
  isExcluded: (rel: string) => boolean;
}

/** 差分を出す。ファイル名の大文字小文字は区別する(Linux のサーバーが多いため) */
export function computePlan(i: PlanInput): DeployPlan {
  const upload: DeployPlan['upload'] = [];
  let unchanged = 0;
  let totalBytes = 0;
  const localSet = new Set<string>();
  for (const f of i.local) {
    localSet.add(f.rel);
    const r = i.remote.get(f.rel);
    let reason: 'new' | 'changed' | null;
    if (!r) reason = 'new';
    else {
      const m = i.manifest?.files[f.rel];
      if (m && f.sha1) {
        // マニフェスト優先: 内容(sha1)が同じで、リモートのサイズも前回送ったときのまま
        reason = m.sha1 === f.sha1 && m.size === f.size && r.size === m.size ? null : 'changed';
      } else if (r.size !== f.size) reason = 'changed';
      else if (r.mtime != null && f.mtime > r.mtime + MTIME_SLACK_MS) reason = 'changed';
      else reason = null;
    }
    if (reason) {
      upload.push({ path: f.rel, size: f.size, reason });
      totalBytes += f.size;
    } else unchanged++;
  }
  const del: string[] = [];
  if (i.deleteExtra) {
    for (const rel of i.remote.keys()) {
      if (localSet.has(rel) || rel === MANIFEST_NAME || i.isExcluded(rel)) continue;
      del.push(rel);
    }
    del.sort();
  }
  return { upload, delete: del, unchanged, totalBytes };
}
