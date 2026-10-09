// CC Hub 共通型定義 — デーモンと UI(Web / Electron)の契約。
// ここを変えるときは daemon と web の両方を合わせて直すこと。

// ---------------------------------------------------------------- セッション

export type SessionStatus =
  | 'starting' // PTY 起動直後、SessionStart hook 待ち
  | 'running' // ツール実行中・応答生成中
  | 'awaiting_approval' // 許可プロンプト表示中
  | 'awaiting_input' // Stop 後、ユーザーの次の指示待ち
  | 'idle' // 入力待ちのまま放置(Notification: idle_prompt)
  | 'error'
  | 'stopped';

export type SessionMode = 'commander' | 'plain';

export interface ApprovalOption {
  n: string; // 画面上の番号("1" など)
  label: string;
  selected: boolean;
}

export interface Approval {
  type: 'options' | 'yn';
  question: string;
  options: ApprovalOption[];
}

export interface CurrentTool {
  name: string; // "Edit", "Bash" など
  target: string; // ファイルパスやコマンドの要約
  since: number; // epoch ms
}

export interface SessionInfo {
  id: string; // = claude の session_id(UUID)
  name: string;
  cwd: string;
  mode: SessionMode;
  /** true = CC Hub が起動した PTY を持つ。false = 外部セッション(読み取り専用) */
  managed: boolean;
  status: SessionStatus;
  createdAt: number;
  lastEventAt: number;
  currentTool: CurrentTool | null;
  /** 直近のアシスタント発言の要約(先頭 200 文字程度) */
  lastMessage: string | null;
  contextPct: number | null;
  costUsd: number | null;
  model: string | null;
  permissionMode: string | null;
  approval: Approval | null;
  /** PTY の現在サイズ(managed のみ) */
  cols: number;
  rows: number;
  exitCode: number | null;
  // フェーズ 2 以降で使う
  repoId: string | null;
  worktreeId: string | null;
  branch: string | null;
}

// ---------------------------------------------------------------- サブエージェント

export type AgentStatus = 'running' | 'done' | 'error';

export interface AgentNode {
  agentId: string;
  sessionId: string;
  /** null = メインセッション直下 */
  parentAgentId: string | null;
  type: string; // agent_type("general-purpose", "Explore" など)
  description: string;
  model: string | null;
  status: AgentStatus;
  currentTool: CurrentTool | null;
  startedAt: number;
  endedAt: number | null;
  depth: number; // メイン直下 = 1
}

// ---------------------------------------------------------------- 使用量

export interface RateWindow {
  pct: number; // 0-100
  resetsAt: number; // epoch ms
}

export interface Usage {
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  updatedAt: number;
}

// ---------------------------------------------------------------- 全体状態

export interface HubState {
  sessions: Record<string, SessionInfo>;
  agents: Record<string, AgentNode>;
  usage: Usage | null;
  daemon: { version: string; startedAt: number; port: number };
}

// ---------------------------------------------------------------- 起動リクエスト

export interface StartSessionRequest {
  cwd: string;
  name?: string;
  mode: SessionMode;
  /** commander モードでは `/commander <instruction>` として渡す。plain では初回プロンプト */
  instruction?: string;
  /** 既存セッションの再開 */
  resume?: string;
}

export interface ProjectEntry {
  path: string;
  lastUsed: number;
}

export interface HistoryEntry {
  id: string;
  cwd: string;
  title: string;
  mtime: number;
}

// ---------------------------------------------------------------- 通知イベント

export type NotifyKind = 'approval' | 'input' | 'done' | 'error';

export interface NotifyEvent {
  kind: NotifyKind;
  sessionId: string;
  title: string;
  body: string;
  ts: number;
}

// ---------------------------------------------------------------- WebSocket プロトコル(/ws)

/** 購読トピック: 'state'(全体状態) / `term:${sessionId}`(ターミナル出力) */
export type Topic = 'state' | `term:${string}`;

export type ClientMessage =
  | { t: 'sub'; topics: Topic[] }
  | { t: 'unsub'; topics: Topic[] }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'state.full'; state: HubState }
  | { t: 'session.upsert'; session: SessionInfo }
  | { t: 'session.remove'; id: string }
  | { t: 'agent.upsert'; agent: AgentNode }
  | { t: 'agent.remove'; agentId: string }
  | { t: 'usage'; usage: Usage }
  | { t: 'term.snapshot'; sid: string; data: string; cols: number; rows: number }
  | { t: 'term.data'; sid: string; data: string }
  | { t: 'term.resize'; sid: string; cols: number; rows: number }
  | { t: 'notify'; event: NotifyEvent }
  | { t: 'pong' };

// ---------------------------------------------------------------- REST(MVP)
//
// 認証不要:
//   POST /auth                         {pin}            → Set-Cookie: ccr_token
//   GET  / と静的ファイル(packages/web/dist)
// 認証(Cookie ccr_token / Cookie hub_local / Authorization: Bearer <local-token>):
//   GET  /api/state                                      → HubState
//   GET  /api/projects                                   → {projects: ProjectEntry[]}
//   GET  /api/history?limit=30                           → {sessions: HistoryEntry[]}
//   POST /api/sessions          StartSessionRequest      → {ok, session}
//   POST /api/sessions/:id/input   {data, submit?}
//   POST /api/sessions/:id/resize  {cols, rows}
//   POST /api/sessions/:id/control {action: 'stop'|'restart'|'remove'}
//   POST /api/sessions/:id/approve {option: string}      (番号 / 'y' / 'n')
//   POST /api/sessions/:id/rename  {name}
//   GET  /game/windows | GET /game/stream?hwnd= | POST /game/input   (CC Remote から移植、仕様そのまま)
// ingest(ingest トークン: ヘッダ X-CC-Hub-Token。tailscale 経由=X-Forwarded-For 付きは拒否):
//   POST /ingest/hook        hooks の stdin JSON をそのまま
//   POST /ingest/statusline  statusLine の stdin JSON をそのまま
//
// 共通レスポンス形式: { ok: true, ...フィールドを直下に展開 } / { ok: false, error: string }
//   例: GET /api/state → { ok: true, ...HubState }、POST /api/sessions → { ok: true, session }
//   (ingest は hook の出力として解釈されるため {} を返す)
// approve の option: 番号付きの選択肢は画面上の番号、番号なし(信頼ダイアログ等)は 1 始まりの位置、yn は 'y' / 'n'
// control の action: 'resume' は 'restart' の別名
// SessionStart hook は http 型では発火しないため、command 型(integrations/hooks/relay.js)で送る

export interface ApiOk<T = unknown> {
  ok: true;
  data?: T;
}
export interface ApiErr {
  ok: false;
  error: string;
}

export const DEFAULT_PORT = 7861; // 移行完了までは 7861。移行後に 7860 へ
