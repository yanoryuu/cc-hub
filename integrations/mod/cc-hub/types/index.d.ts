// mod「cc-hub」の $.state の型(CC Hub の GET /api/mod/overview の形。packages/daemon/src/mod/overview.ts と合わせる)

export type HubSessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'idle' | 'stopped' | 'error' | (string & {});

export type HubApproval = {
  type: 'options' | 'yn';
  question: string;
  options: { n: string; label: string; selected: boolean }[];
};

export type HubSession = {
  id: string;
  name: string;
  status: HubSessionStatus;
  managed: boolean;
  repoId: string | null;
  branch: string | null;
  lastMessage: string | null;
  lastEventAt: number;
  approval: HubApproval | null;
  pr: { number: number; url: string; state: string; checks: string } | null;
};

export type HubOverview = {
  me: {
    id: string;
    name: string;
    repoId: string | null;
    branch: string | null;
    worktree: { name: string; occupants: string[] } | null;
  } | null;
  sessions: HubSession[];
  approvals: number;
  now: number;
};

declare module 'claude-code' {
  interface PluginState {
    'cc-hub': {
      /** CC Hub の状況(つながらなければ null) */
      overview: HubOverview | null;
      /** CC Hub につながっているか */
      isOnline: boolean;
      /** 帯を閉じたときの中身(同じ中身の間は出さない) */
      bandHidden: string | null;
    };
  }
}
