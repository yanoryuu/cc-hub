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

// ---------------------------------------------------------------- リポジトリ / worktree プール(フェーズ 2)

export type RepoKind = 'node' | 'python' | 'unity' | 'other';
export type RepoStatus = 'cloning' | 'ready' | 'error';

export interface RepoInfo {
  id: string; // "<owner>/<name>"
  url: string; // https://github.com/<owner>/<name>
  owner: string;
  name: string;
  /** C:\wt\<name>(Unity は D:\wt\<name>)。ベースのクローンは <baseDir>\.base */
  baseDir: string;
  defaultBranch: string;
  kind: RepoKind;
  /** null = 種別から自動判定したコマンドを使う。'' = インストールしない */
  installCmd: string | null;
  /** 初期化(git clean)で残すディレクトリ。例: node_modules / .venv / Library */
  keepDirs: string[];
  /** Unity 用: 待機 worktree 作成時に Library をコピーする元(例: D:\Unity\TomsLands\Library)。null = コピーしない */
  seedLibraryFrom: string | null;
  /** 待機(idle + 準備中)を最低この本数に保つ。既定 3 */
  poolMin: number;
  /** このリポジトリの worktree 総数の上限。既定 10 */
  poolMax: number;
  /** 登録時にユーザーが信頼を確認した = 信頼ダイアログに自動で「Yes」と答えてよい */
  trusted: boolean;
  status: RepoStatus;
  /** エラーや警告(ディスク不足で補充停止 など)。正常時 null */
  error: string | null;
  createdAt: number;
}

export type WorktreeState =
  | 'creating' // git worktree add 中
  | 'warming' // 依存インストール / Library コピー中
  | 'idle' // 待機中(すぐ割り当て可能)
  | 'assigned' // セッションに割り当て中(セッション終了後も解放まではこの状態)
  | 'releasing' // reset / clean 中
  | 'deleting'
  | 'broken';

export interface WorktreeInfo {
  id: string; // "<repoId>#wt-01"
  repoId: string;
  name: string; // "wt-01"
  path: string;
  state: WorktreeState;
  branch: string | null; // assigned 中の feat/<slug>
  sessionId: string | null;
  lastUsedAt: number;
  /** 進行中の作業の説明(例: "npm ci 実行中")。なければ null */
  progress: string | null;
  error: string | null;
}

export type ReleaseMode = 'keep' | 'discard'; // 'pr' はフェーズ 3

export interface RegisterRepoRequest {
  /** https / git@ / "owner/name" のいずれか */
  url: string;
  /** ユーザーが信頼を確認したか(false のままでは登録できない) */
  trusted: boolean;
  poolMin?: number;
}

// ---------------------------------------------------------------- 全体状態

export interface HubState {
  sessions: Record<string, SessionInfo>;
  agents: Record<string, AgentNode>;
  repos: Record<string, RepoInfo>;
  worktrees: Record<string, WorktreeInfo>;
  usage: Usage | null;
  daemon: { version: string; startedAt: number; port: number };
}

// ---------------------------------------------------------------- 起動リクエスト

export interface StartSessionRequest {
  /** repoId を指定した場合は無視され、プールの worktree が cwd になる */
  cwd: string;
  /** フェーズ 2: 指定するとプールから worktree を割り当て、feat/<branchSlug> を作って起動 */
  repoId?: string;
  /** 省略時は instruction から自動生成(POST /api/slug と同じロジック) */
  branchSlug?: string;
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
  | { t: 'repo.upsert'; repo: RepoInfo }
  | { t: 'repo.remove'; id: string }
  | { t: 'worktree.upsert'; worktree: WorktreeInfo }
  | { t: 'worktree.remove'; id: string }
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
//   --- フェーズ 2 ---
//   POST /api/sessions/:id/release {mode: ReleaseMode}  セッション停止後、worktree を初期化してプールに戻す
//                                                         (実行中なら 409。keep=ブランチを残す / discard=ブランチ削除)
//   POST /api/slug                 {instruction}       → {ok, slug}   (ブランチ名の候補。"feat/" は含まない)
//   GET  /api/repos                                     → {ok, repos: RepoInfo[], worktrees: WorktreeInfo[]}
//   POST /api/repos                RegisterRepoRequest  → {ok, repo}   (クローンは非同期。進捗は repo.upsert で届く)
//   PATCH /api/repos/:id           Partial<Pick<RepoInfo,'poolMin'|'poolMax'|'installCmd'|'keepDirs'|'seedLibraryFrom'|'trusted'>>
//   DELETE /api/repos/:id?purge=1  登録解除。待機 worktree を削除。purge=1 で .base も削除(使用中の worktree があれば 409)
//   POST /api/repos/:id/refill     補充を即時実行
//   POST /api/worktrees/:id/rebuild  broken などを作り直す
//   DELETE /api/worktrees/:id      待機中 / broken の worktree を削除
//   (:id の "/" と "#" は encodeURIComponent する)
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
