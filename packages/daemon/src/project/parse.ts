// フォルダ(プロジェクト)管理画面の純粋ロジック: git 出力の解析・アーティファクトの種別・パスの検査。
// (単体テスト: test/project.test.ts)
import path from 'node:path';
import type { Artifact, CommitInfo, FileChange, FileChangeStatus } from '@cc-hub/shared';

// ---------------------------------------------------------------- git status --porcelain=v2 -z

export interface StatusEntry {
  /** 作業ツリーからの相対パス(/ 区切り) */
  path: string;
  /** リネーム / コピーの元のパス */
  from?: string;
  /** index 側(X)/ 作業ツリー側(Y)の状態文字。'.' = 変更なし */
  x: string;
  y: string;
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
}

export interface StatusV2 {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  /** branch.ab(upstream に対する +ahead -behind)。upstream が無ければ null */
  ab: { ahead: number; behind: number } | null;
  entries: StatusEntry[];
}

/**
 * git status --porcelain=v2 -z [--branch] の出力を解析する。
 * -z ではレコードは NUL 区切りで、リネーム(2)は「… <path>\0<origPath>\0」の 2 フィールドになる
 */
export function parseStatusV2Z(out: string): StatusV2 {
  const r: StatusV2 = { head: null, oid: null, upstream: null, ab: null, entries: [] };
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const t = rec[0];
    if (t === '#') {
      const m = /^# (branch\.\w+) (.*)$/.exec(rec);
      if (!m) continue;
      if (m[1] === 'branch.head') r.head = m[2] === '(detached)' ? null : m[2];
      else if (m[1] === 'branch.oid') r.oid = m[2] === '(initial)' ? null : m[2];
      else if (m[1] === 'branch.upstream') r.upstream = m[2];
      else if (m[1] === 'branch.ab') {
        const ab = /^\+(\d+) -(\d+)/.exec(m[2]);
        if (ab) r.ab = { ahead: Number(ab[1]), behind: Number(ab[2]) };
      }
    } else if (t === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = splitN(rec, 9);
      r.entries.push({ path: f[8], x: f[1][0], y: f[1][1], kind: 'changed' });
    } else if (t === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = splitN(rec, 10);
      const from = recs[++i] ?? '';
      r.entries.push({ path: f[9], from, x: f[1][0], y: f[1][1], kind: 'renamed' });
    } else if (t === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitN(rec, 11);
      r.entries.push({ path: f[10], x: f[1][0], y: f[1][1], kind: 'unmerged' });
    } else if (t === '?') {
      r.entries.push({ path: rec.slice(2), x: '?', y: '?', kind: 'untracked' });
    } else if (t === '!') {
      r.entries.push({ path: rec.slice(2), x: '!', y: '!', kind: 'ignored' });
    }
  }
  return r;
}

/** 先頭から n-1 個の空白で区切り、最後のフィールドは残り全部(パスに空白を含んでよい) */
function splitN(s: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let k = 0; k < n - 1; k++) {
    const sp = rest.indexOf(' ');
    if (sp < 0) break;
    out.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  out.push(rest);
  while (out.length < n) out.push('');
  return out;
}

/** porcelain の状態文字 → FileChangeStatus。'.' は null(その側に変更なし) */
export function statusChar(c: string): FileChangeStatus | null {
  switch (c) {
    case 'A':
    case 'C':
      return 'A';
    case 'M':
    case 'T':
      return 'M';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'U':
      return 'U';
    case '?':
      return '?';
    default:
      return null;
  }
}

// ---------------------------------------------------------------- git diff --numstat -z

export interface NumstatEntry {
  path: string;
  from?: string;
  /** バイナリは null */
  additions: number | null;
  deletions: number | null;
}

/**
 * git diff --numstat -z の出力。通常は「add\tdel\tpath\0」、リネームは「add\tdel\t\0from\0to\0」。
 * バイナリファイルは add / del が "-"
 */
export function parseNumstatZ(out: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i].replace(/^\r?\n/, '');
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    const additions = m[1] === '-' ? null : Number(m[1]);
    const deletions = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      const from = recs[++i] ?? '';
      const to = recs[++i] ?? '';
      if (to) map.set(to, { path: to, from, additions, deletions });
    } else {
      map.set(m[3], { path: m[3], additions, deletions });
    }
  }
  return map;
}

export interface SplitStatus {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
}

/** status の各エントリを staged / unstaged / untracked に分け、numstat の行数を付ける */
export function splitStatus(
  entries: StatusEntry[],
  stagedNum: Map<string, NumstatEntry>,
  unstagedNum: Map<string, NumstatEntry>,
  untrackedMax = 500,
): SplitStatus {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: string[] = [];
  const lines = (m: Map<string, NumstatEntry>, p: string) => {
    const n = m.get(p);
    return { additions: n?.additions ?? 0, deletions: n?.deletions ?? 0 };
  };
  for (const e of entries) {
    if (e.kind === 'ignored') continue;
    if (e.kind === 'untracked') {
      if (untracked.length < untrackedMax) untracked.push(e.path);
      continue;
    }
    if (e.kind === 'unmerged') {
      unstaged.push({ path: e.path, status: 'U', ...lines(unstagedNum, e.path) });
      continue;
    }
    const xs = statusChar(e.x);
    const ys = statusChar(e.y);
    if (xs) {
      const fc: FileChange = { path: e.path, status: xs, ...lines(stagedNum, e.path) };
      if (xs === 'R' && e.from) fc.from = e.from;
      staged.push(fc);
    }
    if (ys) {
      const fc: FileChange = { path: e.path, status: ys, ...lines(unstagedNum, e.path) };
      if (ys === 'R' && e.from) fc.from = e.from;
      unstaged.push(fc);
    }
  }
  return { staged, unstaged, untracked };
}

// ---------------------------------------------------------------- git diff --name-status -z

/** git diff --name-status -z の出力(「M\0path\0」、リネームは「R100\0from\0to\0」) */
export function parseNameStatusZ(out: string): { path: string; status: FileChangeStatus; from?: string }[] {
  const recs = out.split('\0');
  const list: { path: string; status: FileChangeStatus; from?: string }[] = [];
  for (let i = 0; i < recs.length; i++) {
    const code = recs[i].replace(/^\r?\n/, '');
    if (!code) continue;
    const c = code[0];
    if (c === 'R' || c === 'C') {
      const from = recs[++i] ?? '';
      const to = recs[++i] ?? '';
      if (to) list.push(c === 'R' ? { path: to, status: 'R', from } : { path: to, status: 'A' });
    } else {
      const p = recs[++i] ?? '';
      if (p) list.push({ path: p, status: statusChar(c) ?? 'M' });
    }
  }
  return list;
}

// ---------------------------------------------------------------- git log

/** git log の書式(フィールド \x1f、レコード \x1e) */
export const LOG_FORMAT = '%H%x1f%s%x1f%an%x1f%ct%x1e';

export function parseLog(out: string, unpushed: Set<string>): CommitInfo[] {
  const list: CommitInfo[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const [sha, subject, author, ct] = r.split('\x1f');
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) continue;
    list.push({ sha, subject: subject ?? '', author: author ?? '', date: Number(ct) * 1000 || 0, pushed: !unpushed.has(sha) });
  }
  return list;
}

// ---------------------------------------------------------------- アーティファクト

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff']);
const MD_EXT = new Set(['md', 'markdown', 'mdx', 'mdown']);
const DATA_EXT = new Set(['json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini', 'cfg', 'conf', 'env', 'lock', 'sql', 'sqlite', 'db', 'parquet', 'xlsx', 'xls', 'asset', 'meta', 'unity', 'prefab', 'mat']);
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'pyi', 'cs', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp',
  'm', 'mm', 'rb', 'php', 'lua', 'dart', 'scala', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'clj', 'fs', 'vb', 'pl', 'ps1', 'psm1', 'sh', 'bash', 'zsh', 'bat', 'cmd',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro', 'shader', 'hlsl', 'glsl', 'cginc', 'compute', 'uxml', 'uss', 'gradle', 'cmake', 'mk', 'dockerfile', 'tf', 'graphql', 'proto',
]);

/** 拡張子からアーティファクトの種別を決める */
export function artifactKind(p: string): Artifact['kind'] {
  const base = p.split(/[\\/]/).pop() ?? '';
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return 'code';
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 && !lower.startsWith('.')) return 'other';
  const ext = lower.slice(dot + 1);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (MD_EXT.has(ext)) return 'markdown';
  if (CODE_EXT.has(ext)) return 'code';
  if (DATA_EXT.has(ext)) return 'data';
  return 'other';
}

/** アーティファクトから除外するパス(.cc-hub / node_modules / Library 配下) */
export function isArtifactExcluded(p: string): boolean {
  return /(^|\/)(\.cc-hub|node_modules|Library)(\/|$)/.test(p.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------- パスの検査

/**
 * API で受け取った相対パスを検査して、ターゲット内の絶対パスにする。不正なら null。
 * - 絶対パス・ドライブ指定・空・NUL は不可
 * - 正規化後にターゲットの外に出るもの(..)は不可
 * - .git 配下(大文字小文字を区別しない)は不可
 * ※ シンボリックリンク / ジャンクションは呼び出し側で realpath して isInside で再確認する
 */
export function resolveTargetPath(root: string, rel: unknown): string | null {
  if (typeof rel !== 'string') return null;
  const r = rel.trim();
  if (!r || r.includes('\0')) return null;
  if (path.isAbsolute(r) || /^[a-zA-Z]:/.test(r) || r.startsWith('\\\\') || r.startsWith('//')) return null;
  const abs = path.resolve(root, r);
  if (!isInside(root, abs) || sameDir(root, abs)) return null;
  const relNorm = path.relative(path.resolve(root), abs);
  if (relNorm.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git')) return null;
  return abs;
}

function canon(p: string): string {
  return path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function sameDir(a: string, b: string): boolean {
  return canon(a) === canon(b);
}

/** child が root の中(root 自身を含む)にあるか。Windows なので大文字小文字は区別しない */
export function isInside(root: string, child: string): boolean {
  const r = canon(root);
  const c = canon(child);
  return c === r || c.startsWith(r.endsWith('\\') ? r : r + '\\');
}

/** 作業ツリーからの相対パス(/ 区切り) */
export function toRel(root: string, abs: string): string {
  return path.relative(path.resolve(root), path.resolve(abs)).replace(/\\/g, '/');
}
