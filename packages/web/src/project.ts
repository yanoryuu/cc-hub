// フォルダ(プロジェクト)ごとの管理画面: API / データ取得フック / 表示用ヘルパー
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Artifact,
  FileChangeStatus,
  GitTarget,
  ProjectOverview,
  ProjectTokens,
  SessionInfo,
} from '@cc-hub/shared';
import { api, pick } from './api';
import { type ProjectRoute, useHub } from './store';
import { baseName, projectLabel } from './util';

const enc = encodeURIComponent;

/** ?repoId= / ?cwd= */
export function projectQuery(p: Pick<ProjectRoute, 'repoId' | 'cwd'>): string {
  return p.repoId ? `repoId=${enc(p.repoId)}` : `cwd=${enc(p.cwd ?? '')}`;
}

/** 管理画面の識別キー(同じプロジェクトかどうかの比較用) */
export function projectKey(p: Pick<ProjectRoute, 'repoId' | 'cwd'> | null): string {
  if (!p) return '';
  return p.repoId ? `repo:${p.repoId}` : `cwd:${normPath(p.cwd ?? '')}`;
}

/** パスの比較用(区切りと大文字小文字、末尾の区切りを揃える) */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
}

/** 管理画面の表示名(取得前の仮表示にも使う) */
export function projectTitle(p: ProjectRoute, repos: Record<string, { name: string }>): string {
  if (p.repoId) return repos[p.repoId]?.name ?? p.repoId;
  return projectLabel(p.cwd ?? '') || baseName(p.cwd ?? '');
}

// ---------------------------------------------------------------- REST

export interface CommitReq {
  target: string;
  message: string;
  paths?: string[];
  force?: boolean;
}

export const projectApi = {
  overview: async (p: ProjectRoute): Promise<ProjectOverview | undefined> =>
    pick<ProjectOverview>(await api(`/api/project?${projectQuery(p)}`), 'project'),
  /** ファイルの中身の URL(画像はそのまま <img src> に使える) */
  fileUrl: (target: string, path: string) => `/api/project/file?target=${enc(target)}&path=${enc(path)}`,
  diff: async (target: string, path: string, staged: boolean): Promise<string> => {
    const r = await api(`/api/project/diff?target=${enc(target)}&path=${enc(path)}${staged ? '&staged=1' : ''}`);
    const d = pick<string>(r, 'diff');
    return typeof d === 'string' ? d : '';
  },
  stage: (target: string, paths: string[], unstage = false) =>
    api('/api/git/stage', unstage ? { target, paths, unstage: true } : { target, paths }),
  commit: (req: CommitReq) => api('/api/git/commit', req),
  push: (target: string, force = false) => api('/api/git/push', force ? { target, force: true } : { target }),
};

/** テキストファイルの中身を取得(エラー時は {ok:false} の JSON をメッセージにする) */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (type.includes('json')) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (j?.error) msg = j.error;
    }
    if (res.status === 401) useHub.getState().setAuth('need_pin');
    throw new Error(msg);
  }
  // デーモンはテキストを JSON {ok, text, binary, truncated} で返す(画像以外)。素のテキストにも対応しておく
  if (type.includes('json')) {
    const j = (await res.json()) as { text?: string | null; binary?: boolean; truncated?: boolean };
    if (j.binary || j.text == null) throw new Error('バイナリファイルのため表示できません');
    return j.truncated ? `${j.text}\n\n…(512KB を超えるため途中まで表示しています)` : j.text;
  }
  return res.text();
}

// ---------------------------------------------------------------- データ取得フック

/** 定期取得の間隔(表示中のみ) */
const POLL_MS = 3000;
/** WS の更新を受けてから取り直すまでの待ち(連続した更新をまとめる) */
const DEBOUNCE_MS = 700;

export interface ProjectData {
  data: ProjectOverview | null;
  error: string | null;
  loading: boolean;
  /** 最後に取得できた時刻 */
  fetchedAt: number | null;
  reload: () => void;
}

/**
 * GET /api/project を表示中だけ 3 秒ごとに取得し、関係するセッション / worktree / PR の WS 更新でも(間引いて)取り直す。
 * 画面が非表示(タブ裏)の間は止める。
 */
export function useProjectOverview(p: ProjectRoute): ProjectData {
  const [data, setData] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const key = projectKey(p);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  const route = useRef(p);
  route.current = p;

  const run = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) {
      again.current = true;
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule(POLL_MS);
      return;
    }
    inflight.current = true;
    const k = projectKey(route.current);
    try {
      const d = await projectApi.overview(route.current);
      if (!alive.current || k !== projectKey(route.current)) return;
      if (d) {
        setData(d);
        setError(null);
        setFetchedAt(Date.now());
      } else setError('管理画面の情報を取得できませんでした');
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error && e.message ? e.message : '取得に失敗しました');
    } finally {
      inflight.current = false;
      if (alive.current) {
        setLoading(false);
        if (again.current) {
          again.current = false;
          schedule(50);
        } else schedule(POLL_MS);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function schedule(ms: number) {
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), ms);
  }

  // プロジェクトが変わったら最初から
  useEffect(() => {
    alive.current = true;
    setData(null);
    setError(null);
    setLoading(true);
    setFetchedAt(null);
    void run();
    const onVis = () => {
      if (document.visibilityState === 'visible') schedule(50);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 関係する WS 更新(状態・worktree・PR の変化)で取り直す。トークン数だけの更新では取り直さない
  useEffect(() => {
    let prev = signature(useHub.getState(), route.current);
    return useHub.subscribe((st) => {
      const sig = signature(st, route.current);
      if (sig === prev) return;
      prev = sig;
      schedule(DEBOUNCE_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { data, error, loading, fetchedAt, reload: () => schedule(0) };
}

/** 取り直しが必要な変化だけを拾うための要約文字列 */
function signature(st: ReturnType<typeof useHub.getState>, p: ProjectRoute): string {
  const parts: string[] = [];
  for (const s of Object.values(st.sessions)) {
    if (!sessionInProject(s, p)) continue;
    parts.push(`${s.id}:${s.status}:${s.branch ?? ''}:${s.worktreeId ?? ''}`);
  }
  for (const w of Object.values(st.worktrees)) {
    if (!p.repoId || w.repoId !== p.repoId) continue;
    parts.push(`${w.id}:${w.state}:${w.sessionId ?? ''}:${w.git?.updatedAt ?? 0}`);
  }
  for (const pr of Object.values(st.prs)) {
    if (p.repoId && pr.repoId !== p.repoId) continue;
    if (!p.repoId && !(pr.sessionId && st.sessions[pr.sessionId] && sessionInProject(st.sessions[pr.sessionId], p))) continue;
    parts.push(`${pr.id}:${pr.state}:${pr.checks}:${pr.updatedAt}`);
  }
  return parts.sort().join('|');
}

/** セッションがこのプロジェクトのものか(リポジトリ = repoId 一致 / フォルダ = cwd 一致) */
export function sessionInProject(s: SessionInfo, p: Pick<ProjectRoute, 'repoId' | 'cwd'>): boolean {
  if (p.repoId) return s.repoId === p.repoId;
  return !s.repoId && !!p.cwd && normPath(s.cwd) === normPath(p.cwd);
}

/** プロジェクトのセッション(ストアの最新 + 管理画面の取得結果にしか無いもの)。新しい順 */
export function useProjectSessions(p: ProjectRoute, data: ProjectOverview | null): SessionInfo[] {
  const sessions = useHub((s) => s.sessions);
  return useMemo(() => {
    const ids = new Set<string>(data?.sessionIds ?? []);
    for (const s of Object.values(sessions)) if (sessionInProject(s, p)) ids.add(s.id);
    const list: SessionInfo[] = [];
    for (const id of ids) if (sessions[id]) list.push(sessions[id]);
    return list.sort((a, b) => b.createdAt - a.createdAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, data?.sessionIds, p.repoId, p.cwd]);
}

// ---------------------------------------------------------------- トークン

export interface TokenRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

export const ZERO_TOKENS: TokenRow = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

export function tokenTotal(t: TokenRow): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** セッションの使用量: WS で届く session.tokens(リアルタイム)を優先し、無ければ管理画面の集計 */
export function sessionTokens(s: SessionInfo, overview: ProjectTokens | null | undefined): TokenRow | null {
  const fb = overview?.bySession?.[s.id];
  if (s.tokens) {
    return {
      input: s.tokens.input,
      output: s.tokens.output,
      cacheRead: s.tokens.cacheRead,
      cacheCreation: s.tokens.cacheCreation,
      costUsd: s.costUsd ?? fb?.costUsd ?? 0,
    };
  }
  if (fb) return { ...fb, costUsd: s.costUsd ?? fb.costUsd };
  return null;
}

export interface LiveTokens {
  total: TokenRow;
  /** sessionId → 使用量(セッションが一覧に無いもの = 管理画面の集計のみ も含む) */
  bySession: Record<string, TokenRow>;
  /** true = ストアのセッションからリアルタイムに集計 / false = 管理画面の集計そのまま */
  live: boolean;
}

/** プロジェクトのトークン使用量をリアルタイムに集計(セッションの tokens が無ければ overview.tokens) */
export function computeLiveTokens(sessions: SessionInfo[], overview: ProjectTokens | null | undefined): LiveTokens {
  const bySession: Record<string, TokenRow> = {};
  let live = false;
  for (const s of sessions) {
    const t = sessionTokens(s, overview);
    if (s.tokens) live = true;
    if (t) bySession[s.id] = t;
  }
  // ストアから消えたセッション(一覧から削除済み)の分も合計に含める
  for (const [id, t] of Object.entries(overview?.bySession ?? {})) if (!bySession[id]) bySession[id] = { ...t };
  if (!live && overview) {
    const { input, output, cacheRead, cacheCreation, costUsd } = overview;
    return { total: { input, output, cacheRead, cacheCreation, costUsd }, bySession, live: false };
  }
  const total = { ...ZERO_TOKENS };
  for (const t of Object.values(bySession)) {
    total.input += t.input;
    total.output += t.output;
    total.cacheRead += t.cacheRead;
    total.cacheCreation += t.cacheCreation;
    total.costUsd += t.costUsd;
  }
  return { total, bySession, live };
}

/** 12 / 950 / 12.3k / 1.2M */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 10_000 ? 2 : a < 100_000 ? 1 : 0).replace(/\.0+$/, '')}k`;
  if (a < 1_000_000_000) return `${(n / 1_000_000).toFixed(a < 10_000_000 ? 2 : 1).replace(/\.0+$/, '')}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** 区切り付きの正確な数(title / 読み上げ用) */
export function fmtExact(n: number): string {
  return Math.round(n).toLocaleString('ja-JP');
}

// ---------------------------------------------------------------- ファイル / 変更

export const CHANGE_LABEL: Record<FileChangeStatus, string> = {
  A: '追加',
  M: '変更',
  D: '削除',
  R: '名前変更',
  U: '競合',
  '?': '未追跡',
};

export const KIND_LABEL: Record<Artifact['kind'], string> = {
  image: '画像',
  markdown: 'Markdown',
  code: 'コード',
  data: 'データ',
  other: 'その他',
};

/** 種別のアイコン(色ではなく文字で区別できるように短いラベル) */
export const KIND_ICON: Record<Artifact['kind'], string> = {
  image: 'IMG',
  markdown: 'MD',
  code: '</>',
  data: '{ }',
  other: 'FILE',
};

/** 1.2 KB / 3.4 MB */
export function fmtSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** ターゲットの変更数(ステージ済み + 未ステージ + 未追跡) */
export function changeCount(t: GitTarget): number {
  return t.staged.length + t.unstaged.length + t.untracked.length;
}

/** ターゲットの +/− 合計(未追跡は数えない) */
export function diffTotals(t: GitTarget): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of [...t.staged, ...t.unstaged]) {
    add += f.additions;
    del += f.deletions;
  }
  return { add, del };
}

/** セッションが動いている(Claude が作業中でコミットと衝突しうる) */
export function isWorking(s: SessionInfo | undefined | null): boolean {
  return !!s && (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting_approval');
}

/** ターゲットの短い説明: "wt-01 · feat/login-fix" */
export function targetText(t: GitTarget): string {
  return t.branch ? `${t.label} · ${t.branch}` : t.label;
}
