// アプリ全体の状態(zustand)。デーモンが唯一の正なので、ここはその写し + UI 状態だけ。
import { create } from 'zustand';
import type { AgentNode, DeployJob, HubState, NotifyEvent, PrInfo, RepoInfo, ServerInfo, SessionInfo, SessionStatus, Usage, WorktreeInfo } from '@cc-hub/shared';
import { resolveNotifyPr } from './pr';
import { readLocal, writeLocal } from './util';

export type AuthState = 'checking' | 'need_pin' | 'ok';
export type MobileTab = 'projects' | 'sessions' | 'approvals' | 'prs' | 'more';
/** 上部ナビ(デスクトップの上部タブ / モバイルの下タブ)の大分類 */
export type TopView = 'projects' | 'sessions' | 'history' | 'prs';
export const TOP_VIEW_LABEL: Record<TopView, string> = { projects: 'プロジェクト', sessions: 'セッション', history: '履歴', prs: 'PR' };
/** モバイル「その他」タブの中身 */
export type MoreView = 'menu' | 'history' | 'skills' | 'mcp' | 'game' | 'settings';
/** デスクトップ中央の表示 */
export type DeskView = 'home' | 'history' | 'session' | 'game' | 'repos' | 'prs' | 'skills' | 'mcp' | 'project' | 'settings';
/** 設定画面のセクション */
export type SettingsTab = 'notify' | 'servers' | 'mcp';

/** 中央の表示 → 上部ナビの大分類(スキル / MCP / ゲームはどれにも属さないので null) */
export function topOf(v: DeskView): TopView | null {
  if (v === 'home' || v === 'project' || v === 'repos') return 'projects';
  if (v === 'prs') return 'prs';
  if (v === 'history') return 'history';
  if (v === 'session') return 'sessions';
  return null;
}
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
/** フォルダ(プロジェクト)の管理画面。repoId(プールのリポジトリ)か cwd(フォルダ)のどちらか */
export interface ProjectRoute {
  kind: 'project';
  repoId: string | null;
  cwd: string | null;
}
/** 管理画面のタブ */
export type ProjectTab =
  | 'overview'
  | 'sessions'
  | 'worktrees'
  | 'artifacts'
  | 'prs'
  | 'git'
  | 'tokens'
  | 'history'
  | 'instructions'
  | 'publish'
  | 'settings';

/** アップロードのダイアログ(サーバーのカード / 管理画面の「公開」/ 承認カードから開く) */
export interface DeployDialogState {
  /** 最初に選んでおくサーバー(なければ選ばせる) */
  serverId: string | null;
  /** アップロード元の初期値(なければサーバーの既定) */
  localDir: string | null;
  /** 既存のアップロードを見る(進み具合 / 結果) */
  deployId: string | null;
  /** 管理画面の「公開」から開いたときのプロジェクトのフォルダ(アップロード元の初期値に使う) */
  projectPath: string | null;
}

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
  /** アップロード先のサーバー(古いデーモンは返さないので {}) */
  servers: Record<string, ServerInfo>;
  /** アップロード(申請中 / 実行中 / 最近のもの) */
  deploys: Record<string, DeployJob>;
  usage: Usage | null;
  daemon: HubState['daemon'] | null;
  /** 初回の状態を受け取ったか */
  loaded: boolean;

  selectedId: string | null;
  /** 上部ナビで選ばれている大分類(最後の表示を localStorage に保存) */
  topView: TopView;
  deskView: DeskView;
  repoRoute: RepoRoute;
  prRoute: PrRoute;
  /** 開いている管理画面(なければ null) */
  project: ProjectRoute | null;
  projectTab: ProjectTab;
  /** モバイルで管理画面を全画面表示中か */
  mobileProject: boolean;
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
  /** 新規セッションダイアログの「フォルダを指定」に最初から入れておくパス */
  newSessionCwd: string | null;
  /** 「GitHub からクローンして追加」のダイアログ */
  cloneOpen: boolean;
  settingsTab: SettingsTab;
  deployDialog: DeployDialogState | null;
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
  upsertServer(s: ServerInfo): void;
  removeServer(id: string): void;
  upsertDeploy(d: DeployJob): void;
  /** 設定画面を開く(デスクトップ: 中央 / モバイル: その他 → 設定) */
  openSettings(tab?: SettingsTab): void;
  setSettingsTab(t: SettingsTab): void;
  openDeployDialog(d: Partial<DeployDialogState> | null): void;
  /** 承認キューを開く(デスクトップ: ドロワー / モバイル: 承認タブ) */
  openApprovals(): void;
  setUsage(u: Usage): void;
  select(id: string | null): void;
  /** セッションを開く(モバイルでは詳細画面へ遷移、デスクトップではセッション表示へ) */
  open(id: string): void;
  setDeskView(v: DeskView): void;
  /** 上部ナビの切り替え(プロジェクト = ホーム / セッション / PR 一覧) */
  setTopView(t: TopView): void;
  setCloneOpen(v: boolean): void;
  /** リポジトリ画面を開く(デスクトップ / モバイル共通) */
  openRepos(r: RepoRoute): void;
  /** PR 画面を開く(id を渡すと詳細) */
  openPr(id?: string | null): void;
  /** フォルダ(プロジェクト)の管理画面を開く(デスクトップ: 中央 / モバイル: 全画面) */
  openProject(key: { repoId?: string | null; cwd?: string | null }, tab?: ProjectTab): void;
  /** モバイルの管理画面を閉じる */
  closeProject(): void;
  setProjectTab(t: ProjectTab): void;
  setMobileTab(t: MobileTab): void;
  /** モバイル「その他」の中身を開く(タブも切り替える) */
  openMore(v: MoreView): void;
  setRightTab(t: RightTab): void;
  setSortOpts(o: Partial<SortOptions>): void;
  setMobileDetail(v: boolean): void;
  setApprovalDrawer(v: boolean): void;
  setNewSessionOpen(v: boolean, repoId?: string | null, cwd?: string | null): void;
  pushToast(e: NotifyEvent): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

const initialTop = readTopView();
const MOBILE_OF_TOP: Record<TopView, MobileTab> = { projects: 'projects', sessions: 'sessions', history: 'more', prs: 'prs' };
const DESK_OF_TOP: Record<TopView, DeskView> = { projects: 'home', sessions: 'session', history: 'history', prs: 'prs' };

/** 中央の表示を変えるときの共通部分: 大分類も追従させる(スキル / MCP / ゲームは直前の大分類のまま) */
function deskNav(deskView: DeskView, cur: TopView): { deskView: DeskView; topView: TopView } {
  return { deskView, topView: topOf(deskView) ?? cur };
}

export const useHub = create<Store>((set, get) => ({
  auth: 'checking',
  connected: false,
  sessions: {},
  agents: {},
  repos: {},
  worktrees: {},
  prs: {},
  servers: {},
  deploys: {},
  usage: null,
  daemon: null,
  loaded: false,

  selectedId: null,
  // 起動時は前回の大分類(初回はプロジェクト一覧)。セッションを直接開かないので、古い外部セッションに飛ばない
  topView: initialTop,
  deskView: DESK_OF_TOP[initialTop],
  repoRoute: { page: 'list' },
  prRoute: { page: 'list' },
  project: null,
  projectTab: 'overview',
  mobileProject: false,
  mobileTab: MOBILE_OF_TOP[initialTop],
  moreView: initialTop === 'history' ? 'history' : 'menu',
  rightTab: readRightTab(),
  sortOpts: readSortOpts(),
  mobileDetail: false,
  approvalDrawer: false,
  newSessionOpen: false,
  newSessionRepo: null,
  newSessionCwd: null,
  cloneOpen: false,
  settingsTab: 'notify',
  deployDialog: null,
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
        servers: s.servers ?? {},
        deploys: s.deploys ?? {},
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
  upsertServer: (sv) => set((st) => ({ servers: { ...st.servers, [sv.id]: sv } })),
  removeServer: (id) =>
    set((st) => {
      if (!st.servers[id]) return {};
      const servers = { ...st.servers };
      delete servers[id];
      return { servers };
    }),
  upsertDeploy: (d) => set((st) => ({ deploys: { ...st.deploys, [d.id]: d } })),
  openSettings: (tab) =>
    set((st) => ({
      settingsTab: tab ?? st.settingsTab,
      ...deskNav('settings', st.topView),
      moreView: 'settings',
      mobileTab: 'more',
      mobileProject: false,
    })),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  openDeployDialog: (d) =>
    set({
      deployDialog: d
        ? { serverId: d.serverId ?? null, localDir: d.localDir ?? null, deployId: d.deployId ?? null, projectPath: d.projectPath ?? null }
        : null,
    }),
  openApprovals: () => {
    const mobile = typeof window !== 'undefined' && window.innerWidth < 900;
    if (mobile) set({ mobileTab: 'approvals', mobileProject: false, mobileDetail: false });
    else set({ approvalDrawer: true });
  },
  setUsage: (usage) => set({ usage }),
  select: (selectedId) => set({ selectedId }),
  open: (id) =>
    set({ selectedId: id, deskView: 'session', topView: 'sessions', mobileTab: 'sessions', mobileDetail: true, mobileProject: false }),
  setDeskView: (deskView) => set((st) => deskNav(deskView, st.topView)),
  setTopView: (t) =>
    set((st) => {
      const out: Partial<Store> = { topView: t, deskView: DESK_OF_TOP[t], mobileTab: MOBILE_OF_TOP[t], mobileProject: false };
      // PR 表示中にもう一度 PR を押したら一覧へ
      if (t === 'prs' && st.deskView === 'prs') out.prRoute = { page: 'list' };
      if (t === 'projects') out.repoRoute = { page: 'list' };
      // モバイルの履歴は「その他」の中
      if (t === 'history') out.moreView = 'history';
      if (t === 'sessions' && (!st.selectedId || !st.sessions[st.selectedId])) {
        out.selectedId = firstSessionId(st.sessions, st.repos, st.sortOpts);
      }
      return out;
    }),
  setCloneOpen: (cloneOpen) => set({ cloneOpen }),
  // リポジトリ一覧はホーム(プロジェクト一覧)に統合した。登録フォームはダイアログで開く
  openRepos: (repoRoute) =>
    set((st) =>
      repoRoute.page === 'register'
        ? { cloneOpen: true }
        : {
            repoRoute,
            ...deskNav(repoRoute.page === 'list' ? 'home' : 'repos', st.topView),
            mobileTab: 'projects',
            mobileProject: false,
          },
    ),
  openPr: (id) =>
    set({
      prRoute: id ? { page: 'pr', id } : { page: 'list' },
      deskView: 'prs',
      topView: 'prs',
      mobileTab: 'prs',
      mobileProject: false,
    }),
  openProject: (key, tab) =>
    set((st) => {
      const project: ProjectRoute = { kind: 'project', repoId: key.repoId ?? null, cwd: key.repoId ? null : key.cwd ?? null };
      const same = !!st.project && st.project.repoId === project.repoId && st.project.cwd === project.cwd;
      // 別のプロジェクトを開いたら概要から。設定タブはリポジトリのときだけ
      let projectTab: ProjectTab = tab ?? (same ? st.projectTab : 'overview');
      if (projectTab === 'settings' && !project.repoId) projectTab = 'overview';
      return { project, projectTab, deskView: 'project', topView: 'projects', mobileProject: true };
    }),
  // 管理画面を閉じたらプロジェクト一覧へ(デスクトップ / モバイル共通)
  closeProject: () =>
    set((st) => ({
      mobileProject: false,
      mobileTab: 'projects',
      repoRoute: { page: 'list' },
      ...(st.deskView === 'project' ? deskNav('home', st.topView) : { topView: 'projects' as TopView }),
    })),
  setProjectTab: (projectTab) => set({ projectTab }),
  setMobileTab: (mobileTab) =>
    set((st) => ({
      mobileTab,
      mobileProject: false,
      topView: mobileTab === 'projects' || mobileTab === 'sessions' || mobileTab === 'prs' ? mobileTab : st.topView,
      // プロジェクトタブをもう一度押したら一覧(ホーム)へ
      repoRoute: mobileTab === 'projects' && st.mobileTab === 'projects' ? { page: 'list' } : st.repoRoute,
    })),
  openMore: (moreView) =>
    set((st) => ({ moreView, mobileTab: 'more', mobileProject: false, topView: moreView === 'history' ? 'history' : st.topView })),
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
  setNewSessionOpen: (newSessionOpen, repoId = null, cwd = null) =>
    set({ newSessionOpen, newSessionRepo: repoId, newSessionCwd: repoId ? null : cwd }),
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
    // PR / アップロードの通知とセッションの通知は別枠(PR の CI 通知で承認待ちの通知が消えないように)
    const lane = (k: NotifyEvent['kind']) => (k === 'pr' || k === 'deploy' ? k : 'session');
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.event.sessionId !== event.sessionId || lane(t.event.kind) !== lane(event.kind)).slice(-2),
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

function readTopView(): TopView {
  const v = readLocal('cchub_top_view', 'projects');
  return v === 'sessions' || v === 'prs' || v === 'history' ? v : 'projects';
}

// 最後に見ていた大分類を保存(次回の起動時に復元)
useHub.subscribe((s, p) => {
  if (s.topView !== p.topView) writeLocal('cchub_top_view', s.topView);
});

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
