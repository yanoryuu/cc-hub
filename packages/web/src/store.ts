// アプリ全体の状態(zustand)。デーモンが唯一の正なので、ここはその写し + UI 状態だけ。
import { create } from 'zustand';
import type { AgentNode, HubState, NotifyEvent, RepoInfo, SessionInfo, Usage, WorktreeInfo } from '@cc-hub/shared';

export type AuthState = 'checking' | 'need_pin' | 'ok';
export type MobileTab = 'sessions' | 'approvals' | 'repos' | 'game';
/** デスクトップ中央の表示 */
export type DeskView = 'session' | 'game' | 'repos';
/** リポジトリ画面の表示(一覧 / 登録フォーム / リポジトリ詳細) */
export type RepoRoute = { page: 'list' } | { page: 'register' } | { page: 'repo'; id: string };

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
  usage: Usage | null;
  daemon: HubState['daemon'] | null;
  /** 初回の状態を受け取ったか */
  loaded: boolean;

  selectedId: string | null;
  deskView: DeskView;
  repoRoute: RepoRoute;
  mobileTab: MobileTab;
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
  setUsage(u: Usage): void;
  select(id: string | null): void;
  /** セッションを開く(モバイルでは詳細画面へ遷移、デスクトップではセッション表示へ) */
  open(id: string): void;
  setDeskView(v: DeskView): void;
  /** リポジトリ画面を開く(デスクトップ / モバイル共通) */
  openRepos(r: RepoRoute): void;
  setMobileTab(t: MobileTab): void;
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
  usage: null,
  daemon: null,
  loaded: false,

  selectedId: null,
  deskView: 'session',
  repoRoute: { page: 'list' },
  mobileTab: 'sessions',
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
        st.selectedId && s.sessions[st.selectedId] ? st.selectedId : firstSessionId(s.sessions, s.repos ?? {});
      // 古いデーモン(フェーズ 1)は repos / worktrees を返さない
      const repos = s.repos ?? {};
      const repoRoute: RepoRoute =
        st.repoRoute.page === 'repo' && !repos[st.repoRoute.id] ? { page: 'list' } : st.repoRoute;
      return {
        sessions: s.sessions,
        agents: s.agents,
        repos,
        worktrees: s.worktrees ?? {},
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
        selectedId: wasSelected ? firstSessionId(sessions, st.repos) : st.selectedId,
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
  setUsage: (usage) => set({ usage }),
  select: (selectedId) => set({ selectedId }),
  open: (id) => set({ selectedId: id, deskView: 'session', mobileTab: 'sessions', mobileDetail: true }),
  setDeskView: (deskView) => set({ deskView }),
  openRepos: (repoRoute) => set({ repoRoute, deskView: 'repos', mobileTab: 'repos' }),
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setMobileDetail: (mobileDetail) => set({ mobileDetail }),
  setApprovalDrawer: (approvalDrawer) => set({ approvalDrawer }),
  setNewSessionOpen: (newSessionOpen, repoId = null) => set({ newSessionOpen, newSessionRepo: repoId }),
  pushToast: (event) => {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, event }] }));
    setTimeout(() => get().dismissToast(id), 8000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

function firstSessionId(sessions: Record<string, SessionInfo>, repos: Record<string, RepoInfo>): string | null {
  return orderedSessions(sessions, repos)[0]?.id ?? null;
}

export interface SessionGroup {
  /** グループのキー("repo:<id>" / "cwd:<path>") */
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

/** cwd でグループ化(グループはパス順、グループ内は作成順) */
export function groupByCwd(list: SessionInfo[]): { cwd: string; sessions: SessionInfo[] }[] {
  const sorted = [...list].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.createdAt - b.createdAt);
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sorted) {
    const g = groups.get(s.cwd);
    if (g) g.push(s);
    else groups.set(s.cwd, [s]);
  }
  return [...groups.entries()].map(([cwd, sessions]) => ({ cwd, sessions }));
}

/**
 * セッションのグループ化: repoId があればリポジトリごと(worktree が違っても 1 グループ)、
 * なければ従来どおり cwd ごと。リポジトリのグループを先に、それぞれ名前順、グループ内は作成順。
 */
export function groupSessions(list: SessionInfo[], repos: Record<string, RepoInfo>): SessionGroup[] {
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
  for (const g of groups) g.sessions.sort((a, b) => a.createdAt - b.createdAt);
  groups.sort((a, b) => {
    if (!!a.repoId !== !!b.repoId) return a.repoId ? -1 : 1;
    return (a.repoId ?? a.cwd ?? '').localeCompare(b.repoId ?? b.cwd ?? '');
  });
  return groups;
}

/** 表示順に並べたセッション一覧(Ctrl+1..9 用) */
export function orderedSessions(sessions: Record<string, SessionInfo>, repos: Record<string, RepoInfo> = {}): SessionInfo[] {
  return groupSessions(Object.values(sessions), repos).flatMap((g) => g.sessions);
}
