// プロジェクト一覧・会話履歴(~/.claude.json と ~/.claude/projects/*/*.jsonl)。CC Remote から移植。
// 履歴は transcript ごとに (size, mtime) で解析結果をキャッシュする(メモリ + データフォルダの history-index.json)。
// 大きな transcript は先頭と末尾だけを読む(数千ファイルあっても 2 回目以降はほぼ stat だけで済む)。
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry, HistoryMessage, ProjectEntry } from '@cc-hub/shared';
import { HOME, dataDir } from './config';

export const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const HISTORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  for (const s of indexAll()) {
    if (!s.cwd) continue;
    const ent = seen.get(path.normalize(s.cwd).toLowerCase());
    if (ent && s.mtime > ent.lastUsed) ent.lastUsed = s.mtime;
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

// ================================================================ transcript の解析(純粋関数。テスト対象)

/** 履歴のタイトルにしない組み込みコマンド(引数なしのとき) */
const BUILTIN_COMMANDS = new Set([
  'clear', 'compact', 'login', 'logout', 'mcp', 'model', 'config', 'resume', 'exit', 'quit', 'help', 'status',
  'cost', 'usage', 'context', 'permissions', 'hooks', 'memory', 'doctor', 'agents', 'plugin', 'plugins', 'ide',
  'theme', 'vim', 'export', 'add-dir', 'rewind', 'statusline', 'terminal-setup', 'upgrade', 'release-notes',
  'bug', 'feedback', 'fast', 'effort', 'output-style', 'privacy-settings', 'rename', 'tasks', 'todos', 'skills',
]);

/** 本文中のタグの中身(<command-name>…</command-name> など) */
function tagText(s: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? m[1].trim() : null;
}

/**
 * user 行の本文が「ユーザーが実際に送った指示」ならその表示用テキストを返す。それ以外(ツール結果・
 * <local-command-…>・Caveat・system-reminder・組み込みコマンド・スキル展開(isMeta)など)は null。
 * スラッシュコマンドは "/hub-commander 指示" の形にする
 */
export function userPromptText(o: any): string | null {
  if (!o || o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary || !o.message) return null;
  let c = o.message.content;
  if (Array.isArray(c)) {
    if (c.some((x: any) => x && x.type === 'tool_result')) return null;
    c = c
      .filter((x: any) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x: any) => x.text)
      .join('\n');
  }
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (!s) return null;
  if (s.startsWith('<command-name>') || s.startsWith('<command-message>')) {
    const name = (tagText(s, 'command-name') || '').replace(/^\//, '');
    const args = tagText(s, 'command-args') || '';
    if (!name) return null;
    if (!args && BUILTIN_COMMANDS.has(name.toLowerCase())) return null;
    return args ? `/${name} ${args}` : `/${name}`;
  }
  if (s.startsWith('<') || s.startsWith('Caveat:')) return null;
  return s;
}

/** アシスタント行のテキスト部分(無ければ null) */
function assistantText(o: any): string | null {
  if (!o || o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) return null;
  const t = o.message.content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b: any) => b.text.trim())
    .join('\n');
  return t || null;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function tsOf(o: any): number | null {
  if (typeof o?.timestamp !== 'string') return null;
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : null;
}

/** transcript の一部(先頭 / 末尾)から取り出した情報 */
export interface ChunkInfo {
  cwd: string | null;
  customTitle: string | null;
  summary: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  firstTs: number | null;
  lastTs: number | null;
  /** このチャンクで数えた実際のユーザー発言の数 */
  prompts: number;
  /** turnPosition.promptIndex の最大値(新しい Claude Code が付ける通し番号) */
  maxPromptIndex: number;
  lastAssistant: string | null;
  gitBranch: string | null;
}

/** jsonl のテキスト(行の途中で切れていてもよい。壊れた行は飛ばす)を解析する */
export function parseChunk(text: string): ChunkInfo {
  const r: ChunkInfo = {
    cwd: null,
    customTitle: null,
    summary: null,
    aiTitle: null,
    firstPrompt: null,
    firstTs: null,
    lastTs: null,
    prompts: 0,
    maxPromptIndex: 0,
    lastAssistant: null,
    gitBranch: null,
  };
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'summary' && typeof o.summary === 'string' && !r.summary) r.summary = o.summary;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) r.customTitle = o.customTitle.trim();
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) r.aiTitle = o.aiTitle.trim();
    if (o.isSidechain) continue;
    if (!r.cwd && typeof o.cwd === 'string' && o.cwd) r.cwd = o.cwd;
    if (typeof o.gitBranch === 'string' && o.gitBranch) r.gitBranch = o.gitBranch;
    const ts = tsOf(o);
    if (ts != null) {
      if (r.firstTs == null) r.firstTs = ts;
      r.lastTs = ts;
    }
    if (o.type === 'user') {
      const p = userPromptText(o);
      if (p) {
        r.prompts++;
        if (!r.firstPrompt) r.firstPrompt = p;
      }
      const pi = Number(o.turnPosition?.promptIndex);
      if (Number.isFinite(pi) && pi > r.maxPromptIndex) r.maxPromptIndex = pi;
    } else if (o.type === 'assistant') {
      const t = assistantText(o);
      if (t) r.lastAssistant = t;
    }
  }
  return r;
}

/** 解析済みの transcript(キャッシュの単位) */
export interface IndexedInfo {
  cwd: string;
  title: string;
  createdAt?: number;
  messageCount: number;
  lastMessage: string | null;
  gitBranch: string | null;
}

/** 先頭(と、ファイル全体を読んでいない場合は末尾)のチャンクから 1 件分の情報を作る。実際の発言が無ければ null */
export function combineChunks(head: ChunkInfo, tail: ChunkInfo | null): IndexedInfo | null {
  const cwd = head.cwd || tail?.cwd || null;
  const firstPrompt = head.firstPrompt || tail?.firstPrompt || null;
  if (!cwd || !firstPrompt) return null;
  const customTitle = tail?.customTitle || head.customTitle;
  const title = customTitle || head.summary || tail?.summary || firstPrompt || head.aiTitle || tail?.aiTitle || '(無題セッション)';
  // 全体を読んでいないときは発言数は概数(先頭 + 末尾の数と、通し番号の大きい方)
  const counted = head.prompts + (tail ? tail.prompts : 0);
  const messageCount = Math.max(counted, head.maxPromptIndex, tail?.maxPromptIndex ?? 0);
  const last = tail?.lastAssistant || head.lastAssistant;
  return {
    cwd,
    title: oneLine(title, 120),
    createdAt: head.firstTs ?? tail?.firstTs ?? undefined,
    messageCount,
    lastMessage: last ? oneLine(last, 200) : null,
    gitBranch: tail?.gitBranch || head.gitBranch || null,
  };
}

// ================================================================ 絞り込み(純粋関数。テスト対象)

/** 検証用・一時フォルダのセッション(既定では一覧に出さない) */
export function isTestCwd(cwd: string): boolean {
  const c = cwd.replace(/\//g, '\\');
  return (
    /^d:\\aitest(\\|$)/i.test(c) ||
    /^d:\\worktree\\_test-/i.test(c) ||
    /\\appdata\\local\\temp\\claude\\.*scratchpad(\\|$)/i.test(c)
  );
}

/** パスの比較用(区切りを \ に、末尾の \ を除き、小文字に) */
function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** cwd がフォルダ prefix 自身かその配下か(大文字小文字は区別しない) */
export function underPath(cwd: string, prefix: string): boolean {
  const c = normPath(cwd);
  const p = normPath(prefix);
  if (!p) return true;
  return c === p || c.startsWith(p + '\\');
}

export interface HistoryFilter {
  q?: string | null;
  cwd?: string | null;
  includeTests?: boolean;
}

/** q(タイトル / cwd / 最後の発言の部分一致)と cwd(配下を含む)で絞り込み、新しい順に並べる */
export function filterHistory(entries: HistoryEntry[], f: HistoryFilter): HistoryEntry[] {
  const q = (f.q || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const out = entries.filter((e) => {
    if (!f.includeTests && isTestCwd(e.cwd)) return false;
    if (f.cwd && !underPath(e.cwd, f.cwd)) return false;
    if (words.length) {
      const hay = `${e.title}\n${e.cwd}\n${e.lastMessage ?? ''}\n${e.gitBranch ?? ''}`.toLowerCase();
      // 空白区切りの語はすべて含むこと("CC Hub" は "CC" と "Hub" の両方。連続した "cc hub" でも当たる)
      if (!hay.includes(q) && !words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ================================================================ ファイルの列挙とキャッシュ

interface TranscriptFile {
  fp: string;
  id: string;
  size: number;
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
      // <uuid>.jsonl だけ(<uuid>/subagents/ などのフォルダは対象外)
      if (!UUID_FILE_RE.test(f)) continue;
      const fp = path.join(CLAUDE_PROJECTS_DIR, dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size < 300) continue; // 中身のない空セッションを除外
      files.push({ fp, id: f.slice(0, -6).toLowerCase(), size: st.size, mtime: st.mtimeMs });
    }
  }
  return files;
}

/** これ以下のファイルは全体を読む(正確な発言数)。超えるものは先頭 + 末尾だけ */
const FULL_READ_MAX = 2 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const HEAD_MAX_BYTES = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

function readRange(fd: number, start: number, len: number): string {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString('utf8');
}

/** 1 ファイルを解析する(先頭で cwd / 最初の発言が見つからなければ 1MB まで広げる) */
export function analyzeTranscript(fp: string, size: number): IndexedInfo | null {
  let fd: number;
  try {
    fd = fs.openSync(fp, 'r');
  } catch {
    return null;
  }
  try {
    if (size <= FULL_READ_MAX) return combineChunks(parseChunk(readRange(fd, 0, size)), null);
    let headLen = HEAD_BYTES;
    let head = parseChunk(readRange(fd, 0, headLen));
    while ((!head.cwd || !head.firstPrompt) && headLen < HEAD_MAX_BYTES) {
      headLen = Math.min(headLen * 4, HEAD_MAX_BYTES);
      head = parseChunk(readRange(fd, 0, headLen));
    }
    const tailStart = Math.max(headLen, size - TAIL_BYTES);
    const tail = tailStart < size ? parseChunk(readRange(fd, tailStart, size - tailStart)) : null;
    return combineChunks(head, tail);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

interface CacheRow {
  size: number;
  mtime: number;
  /** null = 実際の発言が無い(一覧に出さない) */
  info: IndexedInfo | null;
  /** 大きな transcript の発言数を裏で数えた結果(to バイト目までの数。追記分だけ数え足す) */
  counted?: { to: number; prompts: number };
}

/** 解析し直す(追記なら数え済みの発言数は引き継ぐ) */
function refreshRow(fp: string, size: number, mtime: number): CacheRow {
  const prev = cache.get(fp);
  if (prev && prev.size === size && prev.mtime === mtime) return prev;
  const row: CacheRow = { size, mtime, info: analyzeTranscript(fp, size) };
  if (prev?.counted && prev.counted.to <= size) row.counted = prev.counted;
  if (row.info && row.counted) row.info.messageCount = Math.max(row.info.messageCount, row.counted.prompts);
  cache.set(fp, row);
  cacheDirty = true;
  if (size > FULL_READ_MAX && (!row.counted || row.counted.to < size)) queueCount(fp);
  return row;
}

// ---------------------------------------------------------------- 大きな transcript の発言数(裏で数える)
const countQueue: string[] = [];
let counting = false;

function queueCount(fp: string): void {
  if (!countQueue.includes(fp)) countQueue.push(fp);
  if (!counting) void runCounts();
}

/** 1 行が実際のユーザー発言か(大きな行は tool_result を含めば JSON を解析せずに飛ばす) */
function isPromptLine(line: string): boolean {
  if (!line.includes('"type":"user"')) return false;
  if (line.length > 64 * 1024 && line.includes('"tool_result"')) return false;
  try {
    return !!userPromptText(JSON.parse(line));
  } catch {
    return false;
  }
}

async function runCounts(): Promise<void> {
  counting = true;
  try {
    for (;;) {
      const fp = countQueue.shift();
      if (!fp) break;
      const row = cache.get(fp);
      if (!row) continue;
      const from = row.counted?.to ?? 0;
      const end = row.size;
      if (from >= end) continue;
      let prompts = row.counted?.prompts ?? 0;
      let pos = from;
      let rest = '';
      try {
        const stream = fs.createReadStream(fp, { start: from, end: end - 1, highWaterMark: 1024 * 1024 });
        for await (const chunk of stream) {
          const text = rest + (chunk as Buffer).toString('latin1');
          const lines = text.split('\n');
          rest = lines.pop() ?? '';
          for (const l of lines) {
            pos += l.length + 1;
            // latin1 で読んでいるのでバイト数 = 文字数。判定するときだけ UTF-8 に戻す
            if (l.includes('"type":"user"') && isPromptLine(Buffer.from(l, 'latin1').toString('utf8'))) prompts++;
          }
        }
      } catch {
        continue; // 読めない(消えた)ファイルは次回に回す
      }
      const cur = cache.get(fp);
      if (!cur) continue;
      cur.counted = { to: pos, prompts };
      if (cur.info) cur.info.messageCount = Math.max(cur.info.messageCount, prompts);
      cacheDirty = true;
      scheduleSave();
      // 数えている間に追記されていれば続きを数える
      if (cur.size > pos + rest.length) queueCount(fp);
    }
  } finally {
    counting = false;
  }
}

const CACHE_VERSION = 2;
const cache = new Map<string, CacheRow>();
let cacheLoaded = false;
let cacheDirty = false;
let saveTimer: NodeJS.Timeout | null = null;

function cacheFile(): string {
  return path.join(dataDir(), 'history-index.json');
}

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (j?.v !== CACHE_VERSION || !j.files || typeof j.files !== 'object') return;
    for (const [fp, row] of Object.entries<any>(j.files)) {
      if (row && Number.isFinite(row.size) && Number.isFinite(row.mtime)) cache.set(fp, row as CacheRow);
    }
  } catch {
    /* 無い・壊れている → 作り直す */
  }
}

function scheduleSave(): void {
  if (!cacheDirty || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    cacheDirty = false;
    try {
      const files: Record<string, CacheRow> = {};
      for (const [fp, row] of cache) files[fp] = row;
      fs.mkdirSync(dataDir(), { recursive: true });
      const tmp = cacheFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, files }));
      fs.renameSync(tmp, cacheFile());
    } catch {
      /* 保存できなくても次回作り直すだけ */
    }
  }, 2000);
  saveTimer.unref?.();
}

/** 全 transcript の一覧(実際の発言があるもの。並びは不定)。hubSessionId は付けない */
export function indexAll(): HistoryEntry[] {
  loadCache();
  const files = listTranscripts();
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const f of files) {
    seen.add(f.fp);
    const row = refreshRow(f.fp, f.size, f.mtime);
    if (!row.info) continue;
    out.push({ id: f.id, mtime: f.mtime, ...row.info });
  }
  // 消えたファイルをキャッシュから除く
  for (const fp of [...cache.keys()]) {
    if (!seen.has(fp)) {
      cache.delete(fp);
      cacheDirty = true;
    }
  }
  scheduleSave();
  return out;
}

export interface HistoryQuery extends HistoryFilter {
  limit: number;
  offset: number;
  /** claude 側の session_id → CC Hub のセッション ID */
  hubIdFor?: (claudeId: string) => string | null;
}

/** GET /api/history */
export function queryHistory(o: HistoryQuery): { sessions: HistoryEntry[]; total: number } {
  const all = filterHistory(indexAll(), o);
  const page = all.slice(o.offset, o.offset + o.limit);
  if (o.hubIdFor) for (const e of page) e.hubSessionId = o.hubIdFor(e.id);
  return { sessions: page, total: all.length };
}

/** 1 件分(実際の発言が無いものでも cwd があれば返す) */
export function historyEntry(id: string, hubIdFor?: (claudeId: string) => string | null): HistoryEntry | null {
  if (!HISTORY_ID_RE.test(id)) return null;
  const fp = findTranscript(id);
  if (!fp) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(fp);
  } catch {
    return null;
  }
  loadCache();
  const row = refreshRow(fp, st.size, st.mtimeMs);
  scheduleSave();
  let info = row.info ? { ...row.info } : null;
  if (!info) {
    // 発言の無い transcript でも cwd だけは取る(開くときに使う)
    let text = '';
    try {
      const fd = fs.openSync(fp, 'r');
      try {
        text = readRange(fd, 0, Math.min(st.size, HEAD_BYTES));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* 読めない */
    }
    const h = parseChunk(text);
    if (!h.cwd) return null;
    info = {
      cwd: h.cwd,
      title: h.customTitle || h.summary || '(無題セッション)',
      createdAt: h.firstTs ?? undefined,
      messageCount: 0,
      lastMessage: null,
      gitBranch: h.gitBranch,
    };
  }
  return { id: id.toLowerCase(), mtime: st.mtimeMs, ...info, hubSessionId: hubIdFor ? hubIdFor(id) : null };
}

// ================================================================ 会話の中身(GET /api/history/:id)

/** jsonl のテキストから表示用のメッセージを取り出す(CC Remote の extractLiveItems 相当) */
export function extractMessages(text: string): HistoryMessage[] {
  const items: HistoryMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.isSidechain) continue;
    const ts = tsOf(o) ?? 0;
    if (o.type === 'user') {
      const p = userPromptText(o);
      if (p) items.push({ role: 'user', text: p.slice(0, 4000), ts });
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          items.push({ role: 'assistant', text: b.text.slice(0, 8000), ts });
        } else if (b.type === 'tool_use') {
          const inp = b.input || {};
          const desc = inp.description || inp.file_path || inp.pattern || inp.command || inp.url || inp.skill || '';
          items.push({ role: 'tool', text: String(b.name || '') + (desc ? `: ${oneLine(String(desc), 120)}` : ''), ts });
        }
      }
    }
  }
  return items;
}

/** 末尾から読んで直近 limit 件(時系列順)。足りなければ読む範囲を広げる(最大 32MB) */
export function readMessages(id: string, limit = 200): HistoryMessage[] {
  if (!HISTORY_ID_RE.test(id)) return [];
  const fp = findTranscript(id);
  if (!fp) return [];
  let fd: number;
  try {
    fd = fs.openSync(fp, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    let len = Math.min(size, 2 * 1024 * 1024);
    for (;;) {
      const start = size - len;
      let text = readRange(fd, start, len);
      // 途中から読んだ場合、最初の(切れた)行は捨てる
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const items = extractMessages(text);
      if (items.length >= limit || start === 0 || len >= 32 * 1024 * 1024) return items.slice(-limit);
      len = Math.min(size, len * 4);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** session_id の transcript が存在するか(--resume できるか) */
export function findTranscript(id: string): string | null {
  if (!HISTORY_ID_RE.test(id)) return null;
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
