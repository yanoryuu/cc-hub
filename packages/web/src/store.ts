// アプリ全体の状態(zustand)。デーモンが唯一の正なので、ここはその写し + UI 状態だけ。
import { create } from 'zustand';
import type { AgentNode, HubState, NotifyEvent, PrInfo, RepoInfo, SessionInfo, SessionStatus, Usage, WorktreeInfo } from '@cc-hub/shared';
import { resolveNotifyPr } from './pr';
import { readLocal, writeLocal } from './util';

export type AuthState = 'checking' | 'need_pin' | 'ok';
export type MobileTab = 'sessions' | 'approvals' | 'prs' | 'repos' | 'more';
/** モバイル「その他」タブの中身 */
export type MoreView = 'menu' | 'skills' | 'mcp' | 'game';
/** デスクトップ中央の表示 */
export type DeskView = 'session' | 'game' | 'repos' | 'prs' | 'skills' | 'mcp';
/** デスクトップ右パネルのタブ */
export type RightTab = 'details' | 'skills' | 'mcp';
/** セッション一覧の並び順 */
export type SortMode = 'attention' | 'recent' | 'created' | 'name';
export interface SortOptions {
  sort: SortMode;
  /** true = リポジトリ(なければ cwd)ごとにまとめる */
  group: boolean;
}
export const SORT_LABEL: Record<SortMode, string> = {
  attention: '要対応順',
  recent: '最近の動き順',
  created: '作成順',
  name: '名前順',
};
/** リポジトリ画面の表示(一覧 / 登録フォーム / リポジトリ詳細) */
export type RepoRoute = { page: 'list' } | { page: 'register' } | { page: 'repo'; id: string };
/** PR 画面の表示(一覧 / 詳細)。id = PrInfo.id("<repoId>#<number>") */
export type PrRoute = { page: 'list' } | { page: 'pr'; id: string };

export interface Toast {
  id: number;
  event: NotifyEvent;
}

interface Store {
  auth: AuthState;
  connected: boolean;
  sessions: Record<string, SessionInfo>;
  agents: Record<string, AgentNode>;
  repos: Record<string, RepoInfo>;
  worktrees: Record<string, WorktreeInfo>;
  /** フェーズ 3。古いデーモンは返さないので {} */
  prs: Record<string, PrInfo>;
  usage: Usage | null;
  daemon: HubState['daemon'] | null;
  /** 初回の状態を受け取ったか */
  loaded: boolean;

  selectedId: string | null;
  deskView: DeskView;
  repoRoute: RepoRoute;
  prRoute: PrRoute;
  mobileTab: MobileTab;
  moreView: MoreView;
  rightTab: RightTab;
  sortOpts: SortOptions;
  /** モバイルでセッション詳細を開いているか */
  mobileDetail: boolean;
  approvalDrawer: boolean;
  newSessionOpen: boolean;
  /** 新規セッションダイアログで最初に選んでおくリポジトリ */
  newSessionRepo: string | null;
  toasts: Toast[];

  setAuth(a: AuthState): void;
  setConnected(c: boolean): void;
  applyFull(s: HubState): void;
  upsertSession(s: SessionInfo): void;
  removeSession(id: string): void;
  upsertAgent(a: AgentNode): void;
  removeAgent(agentId: string): void;
  upsertRepo(r: RepoInfo): void;
  removeRepo(id: string): void;
  upsertWorktree(w: WorktreeInfo): void;
  removeWorktree(id: string): void;
  upsertPr(p: PrInfo): void;
  removePr(id: string): void;
  setUsage(u: Usage): void;
  select(id: string | null): void;
  /** セッションを開く(モバイルでは詳細画面へ遷移、デスクトップではセッション表示へ) */
  open(id: string): void;
  setDeskView(v: DeskView): void;
  /** リポジトリ画面を開く(デスクトップ / モバイル共通) */
  openRepos(r: RepoRoute): void;
  /** PR 画面を開く(id を渡すと詳細) */
  openPr(id?: string | null): void;
  setMobileTab(t: MobileTab): void;
  /** モバイル「その他」の中身を開く(タブも切り替える) */
  openMore(v: MoreView): void;
  setRightTab(t: RightTab): void;
  setSortOpts(o: Partial<SortOptions>): void;
  setMobileDetail(v: boolean): void;
  setApprovalDrawer(v: boolean): void;
  setNewSessionOpen(v: boolean, repoId?: string | null): void;
  pushToast(e: NotifyEvent): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

export const useHub = create<Store>((set, get) => ({
  auth: 'checking',
  connected: false,
  sessions: {},
  agents: {},
  repos: {},
  worktrees: {},
  prs: {},
  usage: null,
  daemon: null,
  loaded: false,

  selectedId: null,
  deskView: 'session',
  repoRoute: { page: 'list' },
  prRoute: { page: 'list' },
  mobileTab: 'sessions',
  moreView: 'menu',
  rightTab: readRightTab(),
  sortOpts: readSortOpts(),
  mobileDetail: false,
  approvalDrawer: false,
  newSessionOpen: false,
  newSessionRepo: null,
  toasts: [],

  setAuth: (auth) => set({ auth }),
  setConnected: (connected) => set({ connected }),
  applyFull: (s) =>
    set((st) => {
      const selectedId =
        st.selectedId && s.sessions[st.selectedId] ? st.selectedId : firstSessionId(s.sessions, s.repos ?? {}, st.sortOpts);
      // 古いデーモン(フェーズ 1)は repos / worktrees を返さない
      const repos = s.repos ?? {};
      const repoRoute: RepoRoute =
        st.repoRoute.page === 'repo' && !repos[st.repoRoute.id] ? { page: 'list' } : st.repoRoute;
      return {
        sessions: s.sessions,
        agents: s.agents,
        repos,
        worktrees: s.worktrees ?? {},
        prs: s.prs ?? {},
        usage: s.usage,
        daemon: s.daemon,
        loaded: true,
        selectedId,
        repoRoute,
      };
    }),
  upsertSession: (s) =>
    set((st) => ({
      sessions: { ...st.sessions, [s.id]: s },
      selectedId: st.selectedId ?? s.id,
    })),
  removeSession: (id) =>
    set((st) => {
      if (!st.sessions[id]) return {};
      const sessions = { ...st.sessions };
      delete sessions[id];
      const agents: Record<string, AgentNode> = {};
      for (const [k, a] of Object.entries(st.agents)) if (a.sessionId !== id) agents[k] = a;
      const wasSelected = st.selectedId === id;
      return {
        sessions,
        agents,
        selectedId: wasSelected ? firstSessionId(sessions, st.repos, st.sortOpts) : st.selectedId,
        mobileDetail: wasSelected ? false : st.mobileDetail,
      };
    }),
  upsertAgent: (a) => set((st) => ({ agents: { ...st.agents, [a.agentId]: a } })),
  removeAgent: (agentId) =>
    set((st) => {
      if (!st.agents[agentId]) return {};
      const agents = { ...st.agents };
      delete agents[agentId];
      return { agents };
    }),
  upsertRepo: (r) => set((st) => ({ repos: { ...st.repos, [r.id]: r } })),
  removeRepo: (id) =>
    set((st) => {
      if (!st.repos[id]) return {};
      const repos = { ...st.repos };
      delete repos[id];
      const worktrees: Record<string, WorktreeInfo> = {};
      for (const [k, w] of Object.entries(st.worktrees)) if (w.repoId !== id) worktrees[k] = w;
      const repoRoute: RepoRoute = st.repoRoute.page === 'repo' && st.repoRoute.id === id ? { page: 'list' } : st.repoRoute;
      return { repos, worktrees, repoRoute };
    }),
  upsertWorktree: (w) => set((st) => ({ worktrees: { ...st.worktrees, [w.id]: w } })),
  removeWorktree: (id) =>
    set((st) => {
      if (!st.worktrees[id]) return {};
      const worktrees = { ...st.worktrees };
      delete worktrees[id];
      return { worktrees };
    }),
  upsertPr: (p) => set((st) => ({ prs: { ...st.prs, [p.id]: p } })),
  removePr: (id) =>
    set((st) => {
      if (!st.prs[id]) return {};
      const prs = { ...st.prs };
      delete prs[id];
      return { prs };
    }),
  setUsage: (usage) => set({ usage }),
  select: (selectedId) => set({ selectedId }),
  open: (id) => set({ selectedId: id, deskView: 'session', mobileTab: 'sessions', mobileDetail: true }),
  setDeskView: (deskView) => set({ deskView }),
  openRepos: (repoRoute) => set({ repoRoute, deskView: 'repos', mobileTab: 'repos' }),
  openPr: (id) => set({ prRoute: id ? { page: 'pr', id } : { page: 'list' }, deskView: 'prs', mobileTab: 'prs' }),
  setMobileTab: (mobileTab) => set({ mobileTab }),
  openMore: (moreView) => set({ moreView, mobileTab: 'more' }),
  setRightTab: (rightTab) => {
    writeLocal('cchub_right_tab', rightTab);
    set({ rightTab });
  },
  setSortOpts: (o) =>
    set((st) => {
      const sortOpts = { ...st.sortOpts, ...o };
      writeLocal('cchub_sort', JSON.stringify(sortOpts));
      return { sortOpts };
    }),
  setMobileDetail: (mobileDetail) => set({ mobileDetail }),
  setApprovalDrawer: (approvalDrawer) => set({ approvalDrawer }),
  setNewSessionOpen: (newSessionOpen, repoId = null) => set({ newSessionOpen, newSessionRepo: repoId }),
  pushToast: (event) => {
    const st = get();
    // いま見ているセッションの通知は画面に出ているので出さない(スマホでは承認バナーを隠してしまうため)
    const mobile = typeof window !== 'undefined' && window.innerWidth < 900;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const viewing =
      st.selectedId === event.sessionId &&
      (mobile ? st.mobileTab === 'sessions' && st.mobileDetail : st.deskView === 'session') &&
      visible;
    if (viewing) return;
    // PR の通知は、その PR の詳細を表示中なら出さない
    if (event.kind === 'pr' && visible && st.prRoute.page === 'pr' && (mobile ? st.mobileTab === 'prs' : st.deskView === 'prs')) {
      if (resolveNotifyPr(event, st.prs, st.sessions) === st.prRoute.id) return;
    }
    const id = toastSeq++;
    // 同じセッションの古い通知は置き換える(承認待ち → 入力待ち と積み重ならないように)
    // PR の通知とセッションの通知は別枠(PR の CI 通知で承認待ちの通知が消えないように)
    const isPr = event.kind === 'pr';
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.event.sessionId !== event.sessionId || (t.event.kind === 'pr') !== isPr).slice(-2),
        { id, event },
      ],
    }));
    setTimeout(() => get().dismissToast(id), mobile ? 5000 : 8000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

function firstSessionId(
  sessions: Record<string, SessionInfo>,
  repos: Record<string, RepoInfo>,
  opts?: SortOptions,
): string | null {
  return orderedSessions(sessions, repos, {}, opts)[0]?.id ?? null;
}

function readSortOpts(): SortOptions {
  const def: SortOptions = { sort: 'attention', group: true };
  try {
    const o = JSON.parse(readLocal('cchub_sort', '{}')) as Partial<SortOptions>;
    return {
      sort: o.sort && o.sort in SORT_LABEL ? o.sort : def.sort,
      group: typeof o.group === 'boolean' ? o.group : def.group,
    };
  } catch {
    return def;
  }
}

function readRightTab(): RightTab {
  const v = readLocal('cchub_right_tab', 'details');
  return v === 'skills' || v === 'mcp' ? v : 'details';
}

export interface SessionGroup {
  /** グループのキー("repo:<id>" / "cwd:<path>" / "all") */
  key: string;
  /** リポジトリのグループなら repoId */
  repoId: string | null;
  /** cwd のグループならそのパス */
  cwd: string | null;
  label: string;
  /** 補足(リポジトリなら owner/name、cwd ならフルパス) */
  sub: string;
  sessions: SessionInfo[];
}

/** 要対応順の優先度(小さいほど上): 承認待ち → 入力待ち → エラー → 実行中 → アイドル → 起動中 → 停止 */
const ATTENTION_RANK: Record<SessionStatus, number> = {
  awaiting_approval: 0,
  awaiting_input: 1,
  error: 2,
  running: 3,
  idle: 4,
  starting: 5,
  stopped: 6,
};

/** セッションの比較関数(並び順ごと) */
export function sessionComparator(sort: SortMode): (a: SessionInfo, b: SessionInfo) => number {
  switch (sort) {
    case 'attention':
      return (a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status] || b.lastEventAt - a.lastEventAt;
    case 'recent':
      return (a, b) => b.lastEventAt - a.lastEventAt || a.createdAt - b.createdAt;
    case 'name':
      return (a, b) => a.name.localeCompare(b.name, 'ja') || a.createdAt - b.createdAt;
    case 'created':
    default:
      return (a, b) => a.createdAt - b.createdAt;
  }
}

/**
 * セッションのグループ化: repoId があればリポジトリごと(worktree が違っても 1 グループ)、なければ cwd ごと。
 * opts.group=false なら 1 グループ(key "all")にまとめる。グループ内は opts.sort の順。
 * グループの順: 要対応順 = いちばん対応が必要なセッションのあるグループが上 / 最近の動き順 = 最後に動いたグループが上 /
 * 作成順・名前順 = リポジトリのグループを先に、それぞれ名前順
 */
export function groupSessions(
  list: SessionInfo[],
  repos: Record<string, RepoInfo>,
  opts: SortOptions = { sort: 'created', group: true },
): SessionGroup[] {
  const cmp = sessionComparator(opts.sort);
  if (!opts.group) {
    return [{ key: 'all', repoId: null, cwd: null, label: '', sub: '', sessions: [...list].sort(cmp) }];
  }
  const byKey = new Map<string, SessionGroup>();
  for (const s of list) {
    const key = s.repoId ? `repo:${s.repoId}` : `cwd:${s.cwd}`;
    let g = byKey.get(key);
    if (!g) {
      if (s.repoId) {
        const r = repos[s.repoId];
        g = { key, repoId: s.repoId, cwd: null, label: r?.name ?? s.repoId, sub: s.repoId, sessions: [] };
      } else {
        g = { key, repoId: null, cwd: s.cwd, label: '', sub: s.cwd, sessions: [] };
      }
      byKey.set(key, g);
    }
    g.sessions.push(s);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.sessions.sort(cmp);
  const byName = (a: SessionGroup, b: SessionGroup) => {
    if (!!a.repoId !== !!b.repoId) return a.repoId ? -1 : 1;
    return (a.repoId ?? a.cwd ?? '').localeCompare(b.repoId ?? b.cwd ?? '');
  };
  if (opts.sort === 'attention' || opts.sort === 'recent') {
    // グループ内は並べ済みなので先頭が代表
    groups.sort((a, b) => cmp(a.sessions[0], b.sessions[0]) || byName(a, b));
  } else {
    groups.sort(byName);
  }
  return groups;
}

/**
 * 終了済みで、もう操作の必要がないセッション(停止 / エラー かつ 解放待ちの worktree を持たない)。
 * 一覧では「終了したセッション」に畳んで表示する。
 */
export function isFinished(s: SessionInfo, worktrees: Record<string, WorktreeInfo>): boolean {
  if (s.status !== 'stopped' && s.status !== 'error') return false;
  const w = s.worktreeId ? worktrees[s.worktreeId] : undefined;
  return !(w && w.state === 'assigned' && w.sessionId === s.id);
}

/** 表示順に並べたセッション一覧(Ctrl+1..9 用。終了済みは含めない)。opts は一覧の並び順の設定 */
export function orderedSessions(
  sessions: Record<string, SessionInfo>,
  repos: Record<string, RepoInfo> = {},
  worktrees: Record<string, WorktreeInfo> = {},
  opts: SortOptions = { sort: 'attention', group: true },
): SessionInfo[] {
  const live = Object.values(sessions).filter((s) => !isFinished(s, worktrees));
  return groupSessions(live, repos, opts).flatMap((g) => g.sessions);
}
