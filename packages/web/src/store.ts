// アプリ全体の状態(zustand)。デーモンが唯一の正なので、ここはその写し + UI 状態だけ。
import { create } from 'zustand';
import type { AgentNode, HubState, NotifyEvent, SessionInfo, Usage } from '@cc-hub/shared';

export type AuthState = 'checking' | 'need_pin' | 'ok';
export type MobileTab = 'sessions' | 'approvals' | 'game';

export interface Toast {
  id: number;
  event: NotifyEvent;
}

interface Store {
  auth: AuthState;
  connected: boolean;
  sessions: Record<string, SessionInfo>;
  agents: Record<string, AgentNode>;
  usage: Usage | null;
  daemon: HubState['daemon'] | null;
  /** 初回の状態を受け取ったか */
  loaded: boolean;

  selectedId: string | null;
  mobileTab: MobileTab;
  /** モバイルでセッション詳細を開いているか */
  mobileDetail: boolean;
  approvalDrawer: boolean;
  newSessionOpen: boolean;
  toasts: Toast[];

  setAuth(a: AuthState): void;
  setConnected(c: boolean): void;
  applyFull(s: HubState): void;
  upsertSession(s: SessionInfo): void;
  removeSession(id: string): void;
  upsertAgent(a: AgentNode): void;
  removeAgent(agentId: string): void;
  setUsage(u: Usage): void;
  select(id: string | null): void;
  /** セッションを開く(モバイルでは詳細画面へ遷移) */
  open(id: string): void;
  setMobileTab(t: MobileTab): void;
  setMobileDetail(v: boolean): void;
  setApprovalDrawer(v: boolean): void;
  setNewSessionOpen(v: boolean): void;
  pushToast(e: NotifyEvent): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

export const useHub = create<Store>((set, get) => ({
  auth: 'checking',
  connected: false,
  sessions: {},
  agents: {},
  usage: null,
  daemon: null,
  loaded: false,

  selectedId: null,
  mobileTab: 'sessions',
  mobileDetail: false,
  approvalDrawer: false,
  newSessionOpen: false,
  toasts: [],

  setAuth: (auth) => set({ auth }),
  setConnected: (connected) => set({ connected }),
  applyFull: (s) =>
    set((st) => {
      const selectedId =
        st.selectedId && s.sessions[st.selectedId] ? st.selectedId : firstSessionId(s.sessions);
      return {
        sessions: s.sessions,
        agents: s.agents,
        usage: s.usage,
        daemon: s.daemon,
        loaded: true,
        selectedId,
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
        selectedId: wasSelected ? firstSessionId(sessions) : st.selectedId,
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
  setUsage: (usage) => set({ usage }),
  select: (selectedId) => set({ selectedId }),
  open: (id) => set({ selectedId: id, mobileTab: 'sessions', mobileDetail: true }),
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setMobileDetail: (mobileDetail) => set({ mobileDetail }),
  setApprovalDrawer: (approvalDrawer) => set({ approvalDrawer }),
  setNewSessionOpen: (newSessionOpen) => set({ newSessionOpen }),
  pushToast: (event) => {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, event }] }));
    setTimeout(() => get().dismissToast(id), 8000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

function firstSessionId(sessions: Record<string, SessionInfo>): string | null {
  return orderedSessions(sessions)[0]?.id ?? null;
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

/** 表示順に並べたセッション一覧(Ctrl+1..9 用) */
export function orderedSessions(sessions: Record<string, SessionInfo>): SessionInfo[] {
  return groupByCwd(Object.values(sessions)).flatMap((g) => g.sessions);
}
