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
  /**
   * CC Hub から PowerShell に移したセッション(managed=false で動いているが worktree は保持したまま)。
   * 「CC Hub に戻す」(takeover)で再び CC Hub の PTY で再開できる
   */
  handedOff?: boolean;
  /** 最初の指示(何の作業か)。CC Hub 起動時の instruction、無ければ最初の UserPromptSubmit。先頭 300 文字 */
  task?: string | null;
  /** トークン使用量(statusLine と transcript から。リアルタイムに更新) */
  tokens?: SessionTokens | null;
}

export interface SessionTokens {
  /** セッション累計(statusLine の context_window.total_input_tokens / total_output_tokens) */
  input: number;
  output: number;
  /** transcript の usage から集計したキャッシュ分(取れない場合は 0) */
  cacheRead: number;
  cacheCreation: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- スキル / MCP

export type SkillSource = 'user' | 'project' | 'plugin';

export interface SkillInfo {
  /** 呼び出し名(/<name>)。プラグインのスキルは "<plugin>:<name>" */
  name: string;
  description: string;
  source: SkillSource;
  /** 'skill' = skills/<name>/SKILL.md、'command' = commands/<name>.md */
  kind: 'skill' | 'command';
  plugin?: string;
  path: string;
}

export type McpStatus = 'connected' | 'needs_auth' | 'failed' | 'unknown';

export interface McpServerInfo {
  name: string;
  /** 接続先(URL またはコマンド) */
  target: string;
  status: McpStatus;
  /** claude mcp list の状態表示そのまま(例: "Connected", "Needs authentication") */
  statusText: string;
  /** "claude.ai ..." で始まるものは claude.ai のコネクタ */
  origin: 'claude.ai' | 'local';
}

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
  /**
   * CC Hub の置き場所(baseDir)の外にある、同じリポジトリのフォルダ(クローン済みのフォルダとその worktree)。
   * 中で動くセッションはこのリポジトリのものとして扱う。登録時と「再スキャン」で更新する
   */
  linkedDirs?: string[];
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
  /** フェーズ 3: assigned 中の変更状況(数秒ごとに更新)。それ以外の状態では null */
  git?: WorktreeGitStat | null;
}

/** worktree の変更状況(git status / diff --stat / rev-list) */
export interface WorktreeGitStat {
  /** 未コミットの変更ファイル数(未追跡を含む) */
  changed: number;
  /** base(origin/<default>)からのコミット差分 */
  insertions: number;
  deletions: number;
  /** origin/<default> より進んでいるコミット数 */
  ahead: number;
  /** origin/<default> より遅れているコミット数(rebase が必要かの目安) */
  behind: number;
  /** push していないコミット数(upstream が無ければ ahead と同じ) */
  unpushed: number;
  /** upstream(origin/feat/...)があるか = 一度でも push したか */
  pushed: boolean;
  updatedAt: number;
}

export type ReleaseMode = 'keep' | 'discard'; // PR を作るときは先に POST /api/sessions/:id/create-pr

// ---------------------------------------------------------------- ブランチ / PR(フェーズ 3)

export interface BranchInfo {
  repoId: string;
  name: string; // "feat/login-fix"(リモートのみのものは "origin/..." ではなくブランチ名で、isLocal=false)
  isLocal: boolean;
  hasRemote: boolean;
  /** origin/<default> との差 */
  ahead: number;
  behind: number;
  /** upstream に push していないコミット数(upstream が無いローカルブランチは ahead と同じ) */
  unpushed: number;
  lastCommit: { sha: string; subject: string; author: string; date: number };
  /** origin/<default> にマージ済み(ahead=0 かつ default 以外) */
  merged: boolean;
  /** このブランチを使っている worktree / セッション */
  worktreeId: string | null;
  sessionId: string | null;
  prNumber: number | null;
}

export type CheckState = 'pending' | 'success' | 'failure' | 'none';
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PrInfo {
  id: string; // "<repoId>#<number>"
  repoId: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks: CheckState;
  checksSummary: { passed: number; failed: number; pending: number };
  /** レビューコメント + 会話コメントの数 */
  commentCount: number;
  updatedAt: number;
  /** 自分の PR か / 自分にレビュー依頼が来ているか */
  mine: boolean;
  reviewRequested: boolean;
  /** headRefName が CC Hub のセッション / worktree のブランチと一致した場合 */
  sessionId: string | null;
  worktreeId: string | null;
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: number;
  /** レビューコメントの場合のファイルと行 */
  path?: string;
  line?: number;
  url?: string;
}

export interface PrDetail extends PrInfo {
  body: string;
  comments: PrComment[];
  reviews: { author: string; state: string; body: string; submittedAt: number }[];
  files: { path: string; additions: number; deletions: number }[];
  /** 失敗したチェック(「直して」でログを送る対象) */
  failedChecks: { name: string; url: string; runId: number | null }[];
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';
/** GitHub に送るレビュー(gh pr review --approve / --request-changes / --comment) */
export type PrReviewEvent = 'approve' | 'request_changes' | 'comment';

/** POST /api/repos/:id/rescan の結果 */
export interface RescanResult {
  repo: RepoInfo;
  /** 新しく見つかったフォルダ */
  addedDirs: string[];
  /** このリポジトリに紐付けたセッションの数 */
  linkedSessions: number;
}

// ---------------------------------------------------------------- フォルダ(プロジェクト)ごとの管理画面

export type FileChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U' | '?';

export interface FileChange {
  path: string; // 作業ツリーからの相対パス(/ 区切り)
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** R のときの元のパス */
  from?: string;
}

/** GET /api/git/branches の 1 件(切り替え先の候補) */
export interface GitBranchItem {
  name: string;
  /** いまチェックアウトしているブランチ */
  current: boolean;
  /** ローカルにある(false = origin にだけある。切り替えると追跡ブランチを作る) */
  local: boolean;
  upstream: string | null;
  /** 最後のコミットの日時(epoch ms) */
  date: number;
  /** 別の作業ツリーでチェックアウト中(git の仕様で切り替えられない)。そのパス */
  checkedOutAt: string | null;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: number;
  /** origin に push 済みか */
  pushed: boolean;
}

/** git 操作の対象(worktree / プールのベース / 普通のフォルダ) */
export interface GitTarget {
  id: string; // "wt:<worktreeId>" / "base:<repoId>" / "dir:<path>"
  kind: 'worktree' | 'base' | 'dir';
  label: string; // "wt-01" / ".base" / フォルダ名
  path: string;
  /** Unity のプロジェクトか(「Unity で開く」を出す) */
  unity?: boolean;
  branch: string | null;
  /** 比較対象(origin/<default>) */
  baseRef: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  unpushed: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  /** baseRef..HEAD のコミット(新しい順、最大 50)。baseRef が無ければ直近 20 件 */
  commits: CommitInfo[];
  /** このターゲットを使っているセッション */
  sessionId: string | null;
  updatedAt: number;
}

/** セッションが作成・変更したファイル(baseRef からの差分 + 未コミット + 未追跡) */
export interface Artifact {
  targetId: string;
  sessionId: string | null;
  path: string;
  status: FileChangeStatus;
  /** 'image' | 'markdown' | 'code' | 'data' | 'other'(拡張子から) */
  kind: 'image' | 'markdown' | 'code' | 'data' | 'other';
  size: number;
  mtime: number;
  committed: boolean;
}

export interface ProjectTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
  /** セッションごと(sessionId → 使用量)。並びは使用量の多い順で UI 側が決める */
  bySession: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number }>;
}

export interface ProjectOverview {
  key: { repoId: string | null; cwd: string | null };
  name: string;
  path: string;
  /** このプロジェクトのセッション ID(終了済みも含む。新しい順) */
  sessionIds: string[];
  targets: GitTarget[];
  artifacts: Artifact[];
  /** このプロジェクトの PR(HubState.prs のキー) */
  prIds: string[];
  tokens: ProjectTokens;
  updatedAt: number;
}

export interface RegisterRepoRequest {
  /** https / git@ / "owner/name" のいずれか(localPath を指定した場合は空でよい) */
  url: string;
  /**
   * クローン済みのフォルダ。指定すると origin の URL からリポジトリを判別し、
   * そのフォルダからローカルで複製して CC Hub 用のクローンを作る(フォルダ自体には書き込まない)
   */
  localPath?: string;
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
  /** フェーズ 3: 自分の PR / レビュー依頼 / セッションに紐付いた PR。key = PrInfo.id */
  prs?: Record<string, PrInfo>;
  /** アップロード先のサーバー(秘密情報は含まない) */
  servers?: Record<string, ServerInfo>;
  /** 直近のアップロード(申請中 / 実行中 / 最近 50 件) */
  deploys?: Record<string, DeployJob>;
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
  /** 以下は GET /api/history で付く(ある場合) */
  createdAt?: number;
  /** ユーザー発言の数(おおよその長さ) */
  messageCount?: number;
  /** 最後のアシスタント発言の先頭 */
  lastMessage?: string | null;
  gitBranch?: string | null;
  /** CC Hub 上のセッション(一覧に残っていれば)。あればその画面を開ける */
  hubSessionId?: string | null;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  ts: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  /** .claude フォルダや CLAUDE.md がある */
  hasClaude: boolean;
}

// ---------------------------------------------------------------- 通知イベント

export type NotifyKind = 'approval' | 'input' | 'done' | 'error' | 'pr' | 'deploy';

// ---------------------------------------------------------------- 通知の設定

export type NotifyChannel = 'windows' | 'discord';

/** 通知の種類(NotifyKind をさらに細かく分けたもの。設定画面のチェック項目) */
export type NotifyTopic =
  | 'approval' // 承認待ち
  | 'input' // 入力待ち(ターンが終わった)
  | 'error'
  | 'pr_ci_failed'
  | 'pr_review' // レビュー / コメント / 変更依頼 / 承認
  | 'pr_merged'
  | 'deploy_request' // Claude からのアップロード申請(承認待ち)
  | 'deploy_done' // アップロード完了 / 失敗
  | 'test';

export interface DiscordTarget {
  id: string;
  name: string; // 例: 「全体」「TomsLands」
  /** 設定画面では末尾 6 文字だけ見せる("…abc123")。保存時はフル URL を送る */
  webhookMasked: string;
  /** 対象のリポジトリ(空 = すべて) */
  repoIds: string[];
  topics: NotifyTopic[];
  enabled: boolean;
}

export interface NotifySettings {
  windows: { enabled: boolean; topics: NotifyTopic[]; /** アプリが前面でそのセッションを表示中なら出さない */ suppressWhenViewing: boolean };
  discord: DiscordTarget[];
  /** 同じセッション・同じ種類の通知の最短間隔(秒) */
  throttleSeconds: number;
  /** Discord の通知への返信を受け取る Bot(無い場合は無効) */
  bot?: DiscordBotSettings;
}

/**
 * Discord Bot: Webhook で送った通知に Discord で返信すると、そのセッションに届ける。
 * 返信は横からの質問(/btw のように)として、作業を止めずに会話の写しで答えて返信する(セッションには送らない)。
 * approvalChannelId を設定すると、アップロード / Firebase デプロイの承認待ちを Bot がボタン付きで投稿し、押すだけで承認・却下できる
 */
export interface DiscordBotSettings {
  enabled: boolean;
  /** 返信を受け付ける Discord のユーザー ID(これ以外の人の返信は受け付けない) */
  allowedUserIds: string[];
  /** トークンが保存されているか(トークン自体は返さない)。PUT では token に新しい値を入れたときだけ更新、clearToken: true で削除 */
  hasToken: boolean;
  /** アップロード / Firebase デプロイの承認ボタンを Bot が投稿するチャンネルの ID('' = 出さない) */
  approvalChannelId: string;
  /** 接続状態(読み取り専用) */
  status?: DiscordBotStatus;
}

export interface DiscordBotStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  /** 接続中の Bot の名前 */
  user: string | null;
  error: string | null;
}

// ---------------------------------------------------------------- Unity エディタ

/** GET /api/unity?cwd= / MCP の unity_status */
export interface UnityStatus {
  /** Unity プロジェクトのフォルダ(cwd かその上位) */
  projectPath: string;
  /** ProjectVersion.txt の m_EditorVersion */
  editorVersion: string | null;
  /** そのバージョンのエディタ(インストールされていなければ null) */
  editorPath: string | null;
  installedVersions: string[];
  /** このプロジェクトを開いているエディタのプロセス ID(開いていなければ null) */
  runningPid: number | null;
}

// ---------------------------------------------------------------- CC Hub の再起動の予約

/** GET /api/restart */
export interface RestartStatus {
  /** idle = 予約なし / waiting = 作業が終わるのを待っている / restarting = 再起動を始めた */
  state: 'idle' | 'waiting' | 'restarting';
  /** 再起動の前にビルドするか */
  build: boolean;
  requestedAt: number | null;
  /** 待っている作業(セッション名やアップロード) */
  busy: string[];
  /** 前回の再起動の失敗 */
  error: string | null;
}

// ---------------------------------------------------------------- アップロード先のサーバー(レンタルサーバー FTP / SFTP)

export type ServerProtocol = 'ftp' | 'ftps' | 'sftp';

export interface ServerInfo {
  id: string;
  name: string; // 例: 「ポートフォリオ本番」
  protocol: ServerProtocol;
  host: string;
  port: number;
  username: string;
  /** パスワード / 秘密鍵の有無だけ(中身は返さない) */
  auth: { type: 'password' | 'key'; hasSecret: boolean; keyPath?: string };
  /** アップロード先(例: /public_html/portfolio) */
  remoteDir: string;
  /** 公開 URL(例: https://example.com/portfolio/) */
  publicUrl: string | null;
  /** 既定のアップロード元(プロジェクトのフォルダ。ビルド出力なら dist など)。空 = 毎回指定 */
  defaultLocalDir: string | null;
  /** アップロード前に実行するビルドコマンド(例: npm run build)。空 = なし */
  buildCommand: string | null;
  /** 送らないもの(.git, node_modules, .cc-hub は常に除外) */
  exclude: string[];
  /** リモートにあってローカルに無いファイルを消す(既定 false) */
  deleteExtra: boolean;
  note: string;
  lastDeployAt: number | null;
  lastTest: { ok: boolean; message: string; at: number } | null;
}

export type DeployState =
  | 'pending_approval' // Claude からの申請、ユーザーの承認待ち
  | 'planning' // 差分計算中(ビルドを含む)
  | 'ready' // 差分が出た(ユーザーの確認待ち)
  | 'uploading'
  | 'preview_ready' // Firebase Hosting: プレビュー URL に公開済み。「本番に反映」(promote)待ち
  | 'done'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface DeployPlan {
  upload: { path: string; size: number; reason: 'new' | 'changed' }[];
  delete: string[];
  unchanged: number;
  totalBytes: number;
}

export interface DeployJob {
  id: string;
  serverId: string;
  serverName: string;
  localDir: string;
  /** 申請者: 'user' か Claude のセッション */
  requestedBy: { kind: 'user' } | { kind: 'claude'; sessionId: string | null; sessionName: string | null };
  /** Claude が書いた申請理由 */
  note: string | null;
  state: DeployState;
  buildCommand: string | null;
  plan: DeployPlan | null;
  progress: { done: number; total: number; bytes: number; current: string | null } | null;
  /** ビルド / アップロードのログ末尾 */
  log: string[];
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  url: string | null;
  /** Firebase へのデプロイのとき(serverId は '' 、serverName は "Firebase: <projectId>") */
  firebase?: FirebaseDeploy | null;
}

// ---------------------------------------------------------------- Firebase

export type FirebaseTarget = 'hosting' | 'functions' | 'firestore:rules' | 'firestore:indexes' | 'storage';

export interface FirebaseDeploy {
  projectId: string;
  /** firebase.json のあるフォルダ */
  projectDir: string;
  targets: FirebaseTarget[];
  /** Hosting をまずプレビューチャンネルに出すか(既定 true) */
  preview: boolean;
  channel: string | null;
  previewUrl: string | null;
  previewExpiresAt: number | null;
  /** 本番(live)に反映済みか */
  promoted: boolean;
}

export interface FirebaseInfo {
  /** firebase.json のあるフォルダ(cwd から上へ探す)。見つからなければ null */
  projectDir: string | null;
  /** .firebaserc の default と別名 */
  projectId: string | null;
  aliases: Record<string, string>;
  /** firebase.json に設定のあるサービス */
  configured: { hosting: boolean; functions: boolean; firestore: boolean; storage: boolean };
  /** Hosting の公開先 URL(https://<site>.web.app) */
  sites: { site: string; url: string }[];
  channels: { site: string; channel: string; url: string; expireAt: number | null; updatedAt: number | null }[];
  functions: { name: string; region: string; runtime: string | null; state: string | null; trigger: string | null }[];
  /** ログイン中のアカウント(取れない場合 null)と、見えるプロジェクト一覧 */
  account: string | null;
  projects: { projectId: string; displayName: string | null }[];
  checkedAt: number;
  error: string | null;
}

export interface NotifyEvent {
  kind: NotifyKind;
  /** kind 'pr' で紐付くセッションが無い場合は '' */
  sessionId: string;
  title: string;
  body: string;
  ts: number;
  /** kind 'pr' のとき対象の PR(PrInfo.id = "<repoId>#<number>")。クリックで PR を開くのに使う */
  prId?: string;
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
  | { t: 'pr.upsert'; pr: PrInfo }
  | { t: 'pr.remove'; id: string }
  | { t: 'server.upsert'; server: ServerInfo }
  | { t: 'server.remove'; id: string }
  | { t: 'deploy.upsert'; deploy: DeployJob }
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
//   GET  /api/history?limit=30&offset=0&q=<検索>&cwd=<フォルダ(配下も含む)>  → {sessions: HistoryEntry[], total}
//                                                        (~/.claude/projects の全 transcript。新しい順。q はタイトル / 最初の発言 / cwd を部分一致)
//   GET  /api/history/:id                                → {ok, entry: HistoryEntry, messages: HistoryMessage[]}(直近 200 件。サブエージェントは除く)
//   POST /api/history/:id/open {target: 'hub' | 'terminal'}  → {ok, session}
//          hub: CC Hub の PTY で claude --resume(その会話の cwd で。既に CC Hub 上にあれば takeover / restart と同じ扱い)
//          terminal: 新しい PowerShell で claude --resume(handedOff のセッションとして一覧に載る)
//   GET  /api/fs/dirs?path=<フォルダ>                    → {ok, path, parent, dirs: DirEntry[]}(path 省略時はドライブ一覧とホーム。隠しフォルダ・node_modules 等は除く)
//   Electron(デスクトップ)では window.ccHub.pickFolder(): Promise<string | null> で Windows のフォルダ選択ダイアログを使う
//   --- Unity エディタ ---
//   GET  /api/unity?cwd=                                 → {ok, unity: UnityStatus}(Unity プロジェクトでなければ 404)
//   POST /api/unity/launch {cwd}                         → {ok, unity: UnityStatus & {launched}}(既に開いていれば launched: false)
//   --- CC Hub の再起動 ---
//   GET  /api/restart                                    → {ok, restart: RestartStatus}
//   POST /api/restart {when: 'idle' | 'now', build?: boolean}  予約(idle = 作業中のセッションが無くなったら)。build 既定 true
//   POST /api/restart/cancel                             予約を取り消す
//   --- 通知 ---
//   GET  /api/notify/settings                            → {ok, settings: NotifySettings}
//   PUT  /api/notify/settings  NotifySettings(discord[].webhookUrl に新しい URL を入れたときだけ更新。空なら据え置き)
//   POST /api/notify/test {channel: 'windows' | 'discord' | 'approval', targetId?}  テスト送信(approval = 押しても何も起きない承認ボタンを承認用チャンネルへ)
//   (Windows 通知: デスクトップアプリが接続中ならアプリが出す。未接続ならデーモンが自分で出す)
//   --- アップロード先のサーバー ---
//   POST /api/servers  {…ServerInfo の編集項目, secret?: string}  → {ok, server}   secret = パスワード or 秘密鍵のパスフレーズ。DPAPI で暗号化して保存
//   PATCH /api/servers/:id {…, secret?} / DELETE /api/servers/:id
//   POST /api/servers/:id/test                           接続してリモートフォルダを確認 → {ok, message, entries?: string[]}
//   Discord Bot: PUT /api/notify/settings の bot: {enabled, allowedUserIds, token?: string, clearToken?: boolean}
//     トークンは DPAPI で暗号化して保存。Webhook の通知(?wait=true で送ってメッセージ ID を記録)への返信を Gateway で受け取る
//   POST /api/deploys {serverId, localDir?, buildCommand?, dryRun?: boolean}  ユーザーからのアップロード → {ok, deploy}
//          まず planning(ビルド → 差分計算)→ ready。ready で POST /api/deploys/:id/start すると送信(dryRun なら ready で止まる)
//   POST /api/deploys/:id/approve   Claude の申請(pending_approval)を承認 → planning → ready → 自動で送信
//   POST /api/deploys/:id/reject {reason?} / POST /api/deploys/:id/cancel / POST /api/deploys/:id/start
//   --- Claude から使う MCP サーバー(CC Hub 自身)---
//   POST /mcp(Streamable HTTP、Authorization: Bearer <mcp トークン>)。ツール:
//     list_servers()                                       名前・URL・既定フォルダなど(秘密は含まない)
//     request_deploy({server, localDir?, note})            承認キューに申請を出す → {deployId, state}
//     get_deploy_status({deployId})                        状態・URL・エラー
//     list_sessions() / get_session({id})                  CC Hub のセッション状況(読み取りのみ)
//     firebase_status({cwd})                               そのフォルダの Firebase プロジェクト・設定・プレビュー URL・Functions
//     request_firebase_deploy({cwd, targets, note, preview?})  承認キューに申請 → {deployId, state}(Hosting は承認後まずプレビュー URL へ)
//     get_project_instructions({cwd?})                     プロジェクトの共通の指示(cwd 省略時は呼び出し元セッションのプロジェクト)
//     update_project_instructions({cwd?, content})         全文を置き換える → {lineCount, limit, warning?}(200 行超は保存した上で警告)
//   ユーザースコープに `claude mcp add --transport http cc-hub http://127.0.0.1:<port>/mcp --header "Authorization: Bearer …"` で登録する
//   --- プロジェクトの共通の指示 ---
//   GET  /api/project/instructions?<proj>               → {ok, instructions: ProjectInstructions}
//   PUT  /api/project/instructions?<proj> {content}     → {ok, instructions}(200 行超も保存するが warning を返す)
//   POST /api/project/instructions/rewrite?<proj> {request}  → {ok, proposal: string, lineCount}
//          Claude(claude -p)に「この依頼に沿って共通の指示を書き直して」と頼み、案を返す(保存はしない。UI で差分を見て保存)
//   CC Hub がそのプロジェクトで起動するセッションには --append-system-prompt-file で自動的に渡す
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
//                                  localPath 指定時はそのフォルダから複製(Unity なら seedLibraryFrom にそのフォルダの Library を入れる)
//   PATCH /api/repos/:id           Partial<Pick<RepoInfo,'poolMin'|'poolMax'|'installCmd'|'keepDirs'|'seedLibraryFrom'|'trusted'>>
//   DELETE /api/repos/:id?purge=1  登録解除。待機 worktree を削除。purge=1 で .base も削除(使用中の worktree があれば 409)
//   POST /api/repos/:id/refill     補充を即時実行
//   POST /api/repos/:id/rescan     → RescanResult & {ok}  同じリポジトリのフォルダ(セッションの cwd / git worktree list)を探して linkedDirs に加え、
//                                  その中のセッションをこのリポジトリに紐付ける。{addWorktrees?: number} で待機 worktree の目標本数を増やす
//   POST /api/worktrees/:id/rebuild  broken などを作り直す
//   DELETE /api/worktrees/:id      待機中 / broken の worktree を削除
//   (:id の "/" と "#" は encodeURIComponent する)
//   --- フェーズ 3(ブランチ / PR)---
//   GET  /api/repos/:id/branches                        → {ok, branches: BranchInfo[]}(取得時に git fetch --prune)
//   POST /api/repos/:id/branches/cleanup {names}        マージ済みのローカルブランチを削除(リモートは消さない。使用中は 409)
//   POST /api/prs/refresh                               PR 一覧を今すぐ取り直す(画面のフォーカス時・手動更新)
//   GET  /api/prs/:repo/:n                              → {ok, pr: PrDetail}   (:repo は encodeURIComponent("o/r"))
//   POST /api/prs/:repo/:n/fix {comments?: boolean, checks?: boolean, note?: string}
//          紐付いたセッションにレビューコメント / 失敗したチェックのログを送って直させる。
//          セッションが動いていなければ、プールの worktree でブランチを checkout して新しいセッションを起動する
//   POST /api/prs/:repo/:n/open-session {instruction?, mode?}  PR のブランチで新しいセッション(gh pr checkout)
//   POST /api/prs/:repo/:n/merge {method: MergeMethod}  gh pr merge --<method> --delete-branch。紐付いた worktree は停止済みなら解放(keep)
//   POST /api/prs/:repo/:n/close
//   POST /api/prs/:repo/:n/review {event: PrReviewEvent, body?: string}  gh pr review(request_changes / comment は body 必須)
//   POST /api/prs/:repo/:n/resolve-conflicts {note?, mode?}  base とのコンフリクトの解消を PR を作ったセッションに指示する
//                                              (fix と同じ届け方: 動いていれば送る / 停止中で worktree を持っていれば再開 / 無ければ新しいセッション)。
//                                              → FixResult。コンフリクトしていない PR は 409
//   POST /api/prs/:repo/:n/ai-review {note?, post?: boolean, mode?}  PR のブランチで Claude にレビューさせるセッションを起動。
//                                  post=true ならレビュー結果を GitHub にコメントとして投稿させる
//   POST /api/sessions/:id/create-pr {draft?: boolean}  実行中のセッションに「push して gh pr create して」と指示する。
//          PR ができると headRefName で自動的に紐付く
//   --- 指示・PowerShell・スキル・MCP ---
//   POST /api/sessions/:id/open-terminal                CC Hub の PTY を止め、新しい PowerShell ウィンドウで claude --resume して続きを開く
//                                                        (handedOff=true / managed=false。worktree は保持。hooks は同じセッションに紐付く)
//   POST /api/sessions/:id/takeover {force?: boolean}   外部 / PowerShell に移したセッションを CC Hub の PTY で --resume して引き取る。
//                                                        相手が実行中(running / awaiting_approval)なら force なしは 409
//   POST /api/sessions/:id/attach {name, mime, dataBase64}  → {ok, path}  画像などを <cwd>\.cc-hub\attachments\ に保存
//                                                        (.git/info/exclude 済み)。path は cwd からの相対パス(指示に "@path" で入れる)
//   GET  /api/skills?cwd=<path>                          → {ok, skills: SkillInfo[]}(ユーザー / プロジェクト / 有効なプラグイン)
//   GET  /api/mcp?cwd=<path>&refresh=1                   → {ok, servers: McpServerInfo[], checkedAt}(claude mcp list。2 分キャッシュ)
//   --- フォルダ(プロジェクト)ごとの管理画面 ---
//   プロジェクトの指定(以下 <proj>): repoId=<o/r>(プールのリポジトリ: .base と全 worktree が対象)または cwd=<path>(フォルダ)
//   GET  /api/project?<proj>                            → {ok, project: ProjectOverview}
//   GET  /api/project/file?target=<GitTarget.id>&path=<相対パス>  ファイルの中身(テキストは 512KB まで、画像はそのまま)
//   GET  /api/project/diff?target=&path=&staged=1       → {ok, diff: string}(unified diff。200KB まで)
//   POST /api/git/stage   {target, paths: string[], unstage?: boolean}
//   POST /api/git/commit  {target, message, paths?: string[]}   paths があれば先に stage。空コミットは 409
//                          そのセッションが実行中なら {force: true} が無い限り 409(Claude の作業と衝突しないように)
//   POST /api/git/push    {target}   git push -u origin HEAD(既定ブランチへの直接 push は {force: true} が無い限り 409)
//   GET  /api/git/branches?target=  → {ok, branches: GitBranchItem[]}(ローカル + origin だけにあるもの。新しい順)
//   POST /api/git/switch  {target, branch, create?: boolean, force?: boolean}  → {ok, target: GitTarget}
//                          dir のターゲットだけ(CC Hub の作業ツリーと .base はブランチを CC Hub が管理するので 409)。
//                          未コミットの変更があれば 409。作業中のセッションがあれば {force: true} が無い限り 409
//   GitTarget.id: "wt:<worktreeId>" / "base:<repoId>" / "dir:<path>"
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

// ---------------------------------------------------------------- プロジェクトの共通の指示

/** 共通の指示の推奨上限(行)。超えたら警告する */
export const INSTRUCTIONS_LINE_LIMIT = 200;

export interface ProjectInstructions {
  key: { repoId: string | null; cwd: string | null };
  content: string;
  lineCount: number;
  limit: number;
  /** 上限を超えている / 近い(90% 以上)ときの注意文。問題なければ null */
  warning: string | null;
  updatedAt: number | null;
  /** 最後に書き換えたのは誰か */
  updatedBy: 'user' | 'claude' | null;
}

// Firebase の REST(上の MCP ツールと同じ処理)
//   GET  /api/firebase?cwd=<path>&refresh=1   → {ok, info: FirebaseInfo}(1 分キャッシュ。firebase CLI を使う)
//   POST /api/firebase/deploy {cwd, targets: FirebaseTarget[], preview?: boolean, channel?: string, buildCommand?: string}
//          → {ok, deploy: DeployJob}   ユーザーからのデプロイ。Hosting + preview なら preview_ready で止まる
//   POST /api/deploys/:id/promote               preview_ready のプレビューを本番(live)へ(firebase hosting:clone。再ビルドしない)
//   (Claude からの申請は MCP の request_firebase_deploy → pending_approval → POST /api/deploys/:id/approve)
// Firebase 公式の MCP サーバー(Claude が Firestore / Auth / ログ等を調べる)は integrations/mcp/install-firebase.js で
//   `claude mcp add --scope user firebase -- cmd /c firebase mcp` として登録する
