// プロジェクト一覧(ホーム)用: 登録リポジトリとフォルダのカードの集計 / 最近のプロジェクトの取得
import { useEffect, useMemo, useState } from 'react';
import type { CheckState, PrInfo, ProjectEntry, RepoInfo, SessionInfo, WorktreeInfo } from '@cc-hub/shared';
import { api, pick } from './api';
import { isFinished, useHub } from './store';
import { normPath, tokenTotal } from './project';
import { useRepoList, useWorktreesByRepo } from './repo';
import { baseName } from './util';

// ---------------------------------------------------------------- 最近のプロジェクト(GET /api/projects)

let recentCache: ProjectEntry[] | null = null;

/** 最近のプロジェクト(取得前は null。失敗したら [])。マウントのたびに取り直す */
export function useRecentProjects(): ProjectEntry[] | null {
  const [list, setList] = useState<ProjectEntry[] | null>(recentCache);
  useEffect(() => {
    let alive = true;
    api('/api/projects')
      .then((r) => {
        recentCache = pick<ProjectEntry[]>(r, 'projects') ?? [];
        if (alive) setList(recentCache);
      })
      .catch(() => alive && setList((cur) => cur ?? []));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

// ---------------------------------------------------------------- パスの整理

/** 検証用・一時フォルダは一覧に出さない(D:\WorkTree\_test-* / D:\AITEST / %TEMP%\claude\...) */
export function isHiddenPath(p: string): boolean {
  const n = normPath(p);
  return /^d:\\worktree\\_test-/.test(n) || /^d:\\aitest(\\|$)/.test(n) || /\\appdata\\local\\temp\\/.test(n);
}

/** worktree(…\wt-NN / …\.base)のパスは親(リポジトリのフォルダ)にまとめる */
export function folderRoot(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const m = t.match(/^(.*)[\\/](wt-\d+|\.base)$/i);
  return m ? m[1] : t;
}

/** パスが登録リポジトリ(baseDir の下)のものなら repoId */
function repoOfPath(p: string, baseDirs: [string, string][]): string | null {
  const n = normPath(p);
  for (const [base, id] of baseDirs) if (n === base || n.startsWith(`${base}\\`)) return id;
  return null;
}

// ---------------------------------------------------------------- カードのデータ

export interface CardStats {
  /** 終了済みを含むすべてのセッション */
  sessions: SessionInfo[];
  /** 動いている(終了済みでない)セッション。要対応順 */
  active: SessionInfo[];
  /** トークン(入力 + 出力 + キャッシュ)。セッションの tokens が無ければ null */
  tokensTotal: number | null;
  /** 今日作成したセッションの分 */
  tokensToday: number | null;
  /** 最後に動いた時刻(無ければ 0) */
  lastActivity: number;
}

export interface RepoCardData extends CardStats {
  kind: 'repo';
  key: string;
  repo: RepoInfo;
  worktrees: WorktreeInfo[];
  openPrs: PrInfo[];
  /** Open な PR の CI をまとめた状態(失敗 > 実行中 > 成功)。PR が無ければ null */
  ci: CheckState | null;
}

export interface FolderCardData extends CardStats {
  kind: 'folder';
  key: string;
  path: string;
  name: string;
  /** /api/projects(最近使ったフォルダ)に含まれる */
  recent: boolean;
}

const RANK: Record<SessionInfo['status'], number> = {
  awaiting_approval: 0,
  awaiting_input: 1,
  error: 2,
  running: 3,
  idle: 4,
  starting: 5,
  stopped: 6,
};

function stats(list: SessionInfo[], worktrees: Record<string, WorktreeInfo>, extraLast = 0): CardStats {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let total: number | null = null;
  let todayT: number | null = null;
  let last = extraLast;
  for (const s of list) {
    last = Math.max(last, s.lastEventAt);
    if (!s.tokens) continue;
    const t = tokenTotal({ ...s.tokens, costUsd: 0 });
    total = (total ?? 0) + t;
    if (s.createdAt >= today.getTime()) todayT = (todayT ?? 0) + t;
    else if (todayT === null) todayT = 0;
  }
  const active = list
    .filter((s) => !isFinished(s, worktrees))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.lastEventAt - a.lastEventAt);
  return { sessions: list, active, tokensTotal: total, tokensToday: todayT, lastActivity: last };
}

function worstCi(prs: PrInfo[]): CheckState | null {
  if (prs.length === 0) return null;
  if (prs.some((p) => p.checks === 'failure')) return 'failure';
  if (prs.some((p) => p.checks === 'pending')) return 'pending';
  if (prs.some((p) => p.checks === 'success')) return 'success';
  return 'none';
}

export interface Catalog {
  repos: RepoCardData[];
  folders: FolderCardData[];
  /** 最近のプロジェクトを取得中 */
  loadingRecent: boolean;
}

/** フォルダの最大件数(セッションのあるフォルダは常に出す。最近のプロジェクトはこの数まで) */
const RECENT_MAX = 12;

/**
 * ホームのカード: 登録リポジトリ + フォルダ(セッションのある cwd と最近のプロジェクト)。
 * worktree のパス(D:\WorkTree\<name>\wt-NN)はリポジトリが登録済みならそのリポジトリに、未登録なら <name> フォルダにまとめる。
 */
export function useProjectCatalog(): Catalog {
  const repoList = useRepoList();
  const wtByRepo = useWorktreesByRepo();
  const sessions = useHub((s) => s.sessions);
  const worktrees = useHub((s) => s.worktrees);
  const prs = useHub((s) => s.prs);
  const recent = useRecentProjects();

  return useMemo(() => {
    // 置き場所と、紐付けたクローン済みのフォルダ
    const baseDirs: [string, string][] = repoList.flatMap((r) => [r.baseDir, ...(r.linkedDirs ?? [])].map((d): [string, string] => [normPath(d), r.id]));
    const repoSessions: Record<string, SessionInfo[]> = {};
    const folderMap = new Map<string, { path: string; sessions: SessionInfo[]; lastUsed: number; recent: boolean }>();
    const addFolder = (path: string) => {
      const k = normPath(path);
      let f = folderMap.get(k);
      if (!f) {
        f = { path, sessions: [], lastUsed: 0, recent: false };
        folderMap.set(k, f);
      }
      return f;
    };

    for (const s of Object.values(sessions)) {
      const rid = s.repoId && repoList.some((r) => r.id === s.repoId) ? s.repoId : repoOfPath(s.cwd, baseDirs);
      if (rid) {
        (repoSessions[rid] ??= []).push(s);
        continue;
      }
      if (isHiddenPath(s.cwd)) continue;
      addFolder(folderRoot(s.cwd)).sessions.push(s);
    }

    // 最近のプロジェクト: 新しい順に、まとめたあとのフォルダで RECENT_MAX 件まで
    let added = 0;
    const seen = new Set<string>();
    for (const p of [...(recent ?? [])].sort((a, b) => b.lastUsed - a.lastUsed)) {
      if (isHiddenPath(p.path) || repoOfPath(p.path, baseDirs)) continue;
      const root = folderRoot(p.path);
      const k = normPath(root);
      if (seen.has(k)) continue;
      seen.add(k);
      const exists = folderMap.has(k);
      if (!exists && added >= RECENT_MAX) continue;
      if (!exists) added++;
      const f = addFolder(root);
      f.recent = true;
      f.lastUsed = Math.max(f.lastUsed, p.lastUsed);
    }

    const repos: RepoCardData[] = repoList.map((r) => {
      const wts = wtByRepo[r.id] ?? [];
      const openPrs = Object.values(prs)
        .filter((p) => p.repoId === r.id && p.state === 'OPEN')
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const wtLast = wts.reduce((m, w) => Math.max(m, w.lastUsedAt ?? 0), 0);
      return {
        kind: 'repo',
        key: `repo:${r.id}`,
        repo: r,
        worktrees: wts,
        openPrs,
        ci: worstCi(openPrs),
        ...stats(repoSessions[r.id] ?? [], worktrees, wtLast),
      };
    });

    const folders: FolderCardData[] = [...folderMap.values()]
      .map((f) => ({
        kind: 'folder' as const,
        key: `cwd:${normPath(f.path)}`,
        path: f.path,
        name: baseName(f.path),
        recent: f.recent,
        ...stats(f.sessions, worktrees, f.lastUsed),
      }))
      // 動いているセッションがあるフォルダを先に、あとは最後に使った順
      .sort((a, b) => Number(b.active.length > 0) - Number(a.active.length > 0) || b.lastActivity - a.lastActivity);

    return { repos, folders, loadingRecent: recent === null };
  }, [repoList, wtByRepo, sessions, worktrees, prs, recent]);
}

/** 検索語に一致するか(名前 / owner / パス。空白区切りはすべて含む) */
export function matchQuery(q: string, ...fields: (string | null | undefined)[]): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
