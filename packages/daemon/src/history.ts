// プロジェクト一覧・会話履歴(~/.claude.json と ~/.claude/projects/*/*.jsonl)。CC Remote から移植。
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry, ProjectEntry } from '@cc-hub/shared';
import { HOME } from './config';

export const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ~/.claude.json の projects キー = 実パスの一覧
export function listProjects(): ProjectEntry[] {
  let paths: string[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    paths = Object.keys(j.projects || {});
  } catch {
    /* 無ければ空 */
  }
  const seen = new Map<string, ProjectEntry>();
  for (const p of paths) {
    const norm = path.normalize(p);
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    try {
      if (fs.statSync(norm).isDirectory()) seen.set(key, { path: norm, lastUsed: 0 });
    } catch {
      /* 消えたフォルダ */
    }
  }
  // セッションの最終更新時刻で並べ替え
  for (const s of scanSessions(200, false)) {
    if (!s.cwd) continue;
    const ent = seen.get(path.normalize(s.cwd).toLowerCase());
    if (ent && s.mtime > ent.lastUsed) ent.lastUsed = s.mtime;
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

interface TranscriptFile {
  fp: string;
  id: string;
  mtime: number;
}

function listTranscripts(): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let ents: string[] = [];
    try {
      ents = fs.readdirSync(path.join(CLAUDE_PROJECTS_DIR, dir));
    } catch {
      continue;
    }
    for (const f of ents) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(f)) continue;
      const fp = path.join(CLAUDE_PROJECTS_DIR, dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (st.size < 300) continue; // 中身のない空セッションを除外
      files.push({ fp, id: f.slice(0, -6), mtime: st.mtimeMs });
    }
  }
  return files;
}

// ~/.claude/projects/*/<uuid>.jsonl を新しい順にスキャン
export function scanSessions(limit: number, withTitle = true): HistoryEntry[] {
  const files = listTranscripts().sort((a, b) => b.mtime - a.mtime);
  const out: HistoryEntry[] = [];
  for (const f of files.slice(0, limit)) {
    const info = readSessionInfo(f.fp, withTitle);
    if (info && info.cwd) out.push({ id: f.id, mtime: f.mtime, cwd: info.cwd, title: info.title });
  }
  return out;
}

/** session_id の transcript が存在するか(--resume できるか) */
export function findTranscript(id: string): string | null {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const fp = path.join(CLAUDE_PROJECTS_DIR, dir, `${id}.jsonl`);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// jsonl の先頭 64KB から cwd とタイトル(summary or 最初のユーザー発言)を抽出
function readSessionInfo(fp: string, withTitle: boolean): { cwd: string; title: string } | null {
  let text: string;
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    text = buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  }
  let cwd: string | null = null;
  let title: string | null = null;
  let summary: string | null = null;
  for (const line of text.split('\n')) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!summary && o.type === 'summary' && o.summary) summary = o.summary;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!title && o.type === 'user' && !o.isSidechain && o.message) {
      let c = o.message.content;
      if (Array.isArray(c)) c = (c.find((x: any) => x.type === 'text') || {}).text || '';
      if (typeof c === 'string') {
        c = c.trim();
        if (c && !c.startsWith('<') && !c.startsWith('Caveat:')) title = c.slice(0, 120);
      }
    }
    if (cwd && summary && title) break;
    if (!withTitle && cwd) break;
  }
  if (!cwd) return null;
  return { cwd, title: summary || title || '(無題セッション)' };
}
