# CC Hub 技術設計書 v0.1

> 対象: [requirements.md](requirements.md) v1.0
> 作成: 2026-10-10 / 前提: Claude Code 2.1.295、Node.js 20.12、Windows 11

---

## 1. 全体構成

```
┌──────────────────────────── デスクトップ (Windows) ────────────────────────────┐
│                                                                                  │
│  claude (PTY) × N ──hooks(http)──┐      ┌──statusLine(command)── claude × N     │
│        ▲                         ▼      ▼                                        │
│  ┌─────┴──────────────── Hub デーモン (Node.js, 127.0.0.1:7860) ─────────────┐   │
│  │ SessionManager ─ PtyHost ─ ScreenModel(xterm headless) ─ ApprovalDetector │   │
│  │ EventIngest(hooks/statusLine) ─ TranscriptWatcher ─ AgentTree ─ Usage     │   │
│  │ RepoManager ─ WorktreePool ─ GitWatcher ─ GitHubWatcher(gh)               │   │
│  │ Notifier(toast / WebPush / Discord) ─ GameCapture(移植) ─ Store(SQLite)   │   │
│  │ API: REST + WebSocket                                                     │   │
│  └───────────────▲──────────────────────────────────▲────────────────────────┘   │
│                  │ ws://127.0.0.1 (ローカルトークン)  │ (PIN Cookie)             │
│        Electron アプリ (デスクトップ UI)             │                           │
│                                                     tailscale serve (HTTPS)      │
└─────────────────────────────────────────────────────┼────────────────────────────┘
                                                      ▼
                                              スマホ PWA (同じ Web UI)
```

### 設計方針
- **UI は 1 つの React アプリにまとめる。** デーモンが Web UI を配信し、Electron はそれをデスクトップ向けレイアウトで、スマホはモバイル向けレイアウトで表示する。画面を二重に実装しない
- Electron が担当するのはネイティブ機能だけ(トレイ、トースト通知、グローバルショートカット、デーモンの起動)
- **デーモンを唯一の正(single source of truth)にする。** UI は状態を持たず、WebSocket で購読する
- 既存の CC Remote の資産(PTY 管理、承認検知、スクロール制御、ゲームキャプチャ)は TypeScript に移して再利用する

---

## 2. リポジトリ構成

```
C:\Users\yanor\cc-hub\           (npm workspaces, TypeScript)
├─ packages/
│  ├─ shared/        型定義・API スキーマ(zod)・イベント型
│  ├─ daemon/        Hub デーモン(cc-remote/server.js の後継)
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ api/            REST ルート, WebSocket ハブ, 認証
│  │  │  ├─ session/        SessionManager, PtyHost, ScreenModel, ApprovalDetector
│  │  │  ├─ ingest/         hooks 受信, statusLine 受信, TranscriptWatcher
│  │  │  ├─ agents/         AgentTree
│  │  │  ├─ repo/           RepoManager, WorktreePool, GitWatcher
│  │  │  ├─ github/         GitHubWatcher(gh CLI ラッパ)
│  │  │  ├─ notify/         Notifier(toast / webpush / discord)
│  │  │  ├─ game/           GameCapture(移植)
│  │  │  └─ store/          SQLite(better-sqlite3)
│  │  └─ native/gamecap.exe (移植)
│  ├─ web/           React + Vite(デスクトップ/モバイル両レイアウト、PWA)
│  └─ desktop/       Electron(main / preload のみ。renderer は web を読み込む)
├─ integrations/
│  ├─ statusline/    statusline.js(既存表示を維持 + デーモンへ転送)
│  ├─ hooks/         settings.json に入れる hooks の雛形とインストーラ
│  └─ skills/commander/   汎用 commander スキル
├─ scripts/          install.ps1, migrate-from-cc-remote.ps1, watchdog.ps1, cc-hub.vbs
└─ docs/
```

### 主要ライブラリ
| 用途 | ライブラリ |
|---|---|
| PTY | `@lydell/node-pty`(CC Remote で実績あり) |
| 画面状態 | `@xterm/headless` + `@xterm/addon-serialize` |
| HTTP / WS | Node `http` + `ws`(フレームワークは使わず軽量に) |
| DB | `better-sqlite3` |
| スキーマ | `zod` |
| Web Push | `web-push`(VAPID) |
| UI | React 18, Vite, Zustand, `@xterm/xterm`, Tailwind |
| デスクトップ | Electron, electron-builder |
| トースト(デーモン単体時) | `node-notifier`(SnoreToast) |

---

## 3. プロセスと起動

| プロセス | 起動方法 | 備考 |
|---|---|---|
| デーモン | ログイン時に `cc-hub.vbs`(非表示)、5 分ごとに Watchdog が死活監視 | CC Remote の仕組みをそのまま置き換える。ポート 7860 も引き継ぐ |
| Electron | ユーザーが起動 / スタートアップ(任意) | デーモンが落ちていたら起動する。閉じてもトレイに常駐 |
| claude | デーモンが node-pty で起動 | デーモンの子プロセス |

### デーモン再起動時の扱い
ConPTY の子プロセスはデーモンと一緒に終了するため、**デーモンの再起動を挟んでセッションを生かし続けることはできない。** その代わりに次の方法で復旧する。
1. 起動したセッションの `session_id`・cwd・名前・状態を SQLite に保存しておく
2. デーモン起動時に、前回「実行中」だったセッションを `claude --resume <id>` で自動再開する(設定で無効化可)
3. 計画的な再起動(更新など)のときは、各セッションがアイドルになるのを待ってから再起動する

---

## 4. セッション管理

### 4.1 識別
- デーモンが UUID を生成し、`--session-id <uuid>` で起動する。hooks・statusLine・transcript の `session_id` と一致するため、これで紐付けられる
- 環境変数 `CC_HUB_SESSION=<uuid>` も渡す(http hook のヘッダー・command hook・statusLine に引き継がれることを確認済み、V4)
- 起動時の環境変数からは `CLAUDE*` / `CLAUDECODE` を取り除く(X2)
- 未知の `session_id` から hooks が届いた場合は**外部セッション**として読み取り専用で登録する

### 4.2 起動コマンド
```
claude --session-id <uuid> --permission-mode auto -n "<表示名>" "/commander <初回指示>"
```
- `--permission-mode auto` が有効な値であることは公式ドキュメントで確認済み
- slash コマンドを初回プロンプトとして渡すとスキルが起動することを確認済み(V1)。`/commander` と `/hub-commander` の使い分けは §13
- 初回だけ信頼ダイアログが出るので、登録済みリポジトリの worktree ならデーモンが「Yes」を選ぶ(X1)
- 通常モードで起動する場合は `/commander` を付けない

### 4.3 状態遷移
```
starting ──(SessionStart)──▶ running ◀──(UserPromptSubmit / PreToolUse)──┐
   │                          │  │                                         │
   │                          │  └─(Notification: permission_prompt)─▶ awaiting_approval
   │                          │                                            │(PostToolUse / 承認)
   │                          └─(Stop)──▶ awaiting_input ─(idle_prompt)─▶ idle
   │                                                                       │
   └──────(PTY 終了 / SessionEnd)──────────────────────────────▶ stopped / error
```
- 状態判定の主な情報源は hooks。画面解析(ApprovalDetector)は承認ボタンの選択肢を作るためと、hooks が届かない場合の保険として使う
- `StopFailure` / `PostToolUseFailure` / PTY の異常終了で `error` にする

### 4.4 承認
- **MVP**:CC Remote 方式。`Notification(permission_prompt)` を合図に画面を解析し、選択肢を承認キューに出す。押されたら PTY に番号キーを送る
- **フェーズ 2 以降の候補**:`PermissionRequest` hook(http)で、デーモンが判断を保留し、UI の回答を `hookSpecificOutput.decision`(`allow` / `deny`)として返す。画面解析が不要になる。ただし http hook のレスポンスが判断として解釈されるかは**要検証**
- auto mode で動くため、承認キューに上がるのは auto mode が自分で判断できない操作だけになる想定

---

## 5. イベント収集

### 5.1 hooks(グローバル設定)
`~/.claude/settings.json` にインストーラが追記する。既存の設定は保持し、追記部分は `cc-hub` の印を付けて識別できるようにする。

```jsonc
"hooks": {
  "<イベント名>": [{ "hooks": [{
    "type": "http",
    "url": "http://127.0.0.1:7860/ingest/hook",
    "headers": { "X-CC-Hub-Token": "$CC_HUB_INGEST_TOKEN" },
    "allowedEnvVars": ["CC_HUB_INGEST_TOKEN"],
    "timeout": 2
  }]}]
}
```
- 対象イベント: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `CwdChanged`
- **デーモンが落ちていても Claude の動作を妨げないこと**:タイムアウトは短くし、受信側は即座に 200 を返して処理は非同期に行う。接続失敗しても遅延はないが、stderr に警告が 1 行出る(V2)。TUI で邪魔になる場合は `command` 型 +`async: true` の中継スクリプト(fire-and-forget)に切り替える
- `PermissionRequest` は MVP では登録しない(登録すると承認の流れが変わるため)

### 5.2 statusLine
既存の `claude-statusline.ps1` を `integrations/statusline/statusline.js` に置き換える。
- **表示は今と同じ**(`Session: xx% | Context: yy%`)
- 受け取った JSON をデーモンの `POST /ingest/statusline` に送る(タイムアウト 300ms、失敗しても無視)
- PowerShell より起動が速くなるという副次効果もある
- 取得する主な項目:
  - `rate_limits.five_hour` / `seven_day` の `used_percentage`, `resets_at`(Unix 秒)
  - `context_window.used_percentage`, `context_window_size`
  - `cost.total_cost_usd`, `model.display_name`, `workspace.git_worktree`, `pr`
- `rate_limits` はアカウント共通なので、**最後に受信した値**を全体の残量として表示する

### 5.3 transcript の監視
- `~/.claude/projects/<proj>/<session>.jsonl` と `<session>/subagents/agent-*.jsonl` を tail する(CC Remote の live 同期と同じ方式)
- 用途: 直近のメッセージ要約、hooks の取りこぼしの補完、外部セッションの発見

---

## 6. サブエージェントの親子ツリー

### 情報源
| 情報 | 取得元 |
|---|---|
| 開始・終了 | `SubagentStart` / `SubagentStop` hooks(`agent_id`, `agent_type`) |
| 説明・深さ・親の tool_use | `subagents/agent-<id>.meta.json`(`agentType`, `description`, `toolUseId`, `spawnDepth`) |
| 中で実行中のツール | `agent_id` 付きで届く `PreToolUse` / `PostToolUse` |
| 使用モデル | Agent tool の `tool_input.model`(親の `PreToolUse`) |

### 親の決定方法
公式の `parent_agent_id` はないため、次の手順で決める。
1. `meta.json` の `toolUseId` を取得する
2. その `tool_use_id` を持つ Agent 呼び出しが、どの transcript に記録されているかを探す
   - メインの `<session>.jsonl` にあれば、親はメインセッション
   - `agent-<X>.jsonl` にあれば、親はエージェント X(ネスト)
3. `PreToolUse(tool_name=Agent)` の hook に `agent_id` が付いていれば、それだけで親が分かる(付くことを確認済み、V3。**これを主な方法にする**)

### データ構造
```ts
interface AgentNode {
  agentId: string; sessionId: string; parentAgentId: string | null; // null = メイン
  type: string; description: string; model?: string;
  status: 'running' | 'done' | 'error';
  currentTool?: { name: string; target: string; since: number };
  startedAt: number; endedAt?: number; depth: number;
}
```

---

## 7. リポジトリと Worktree プール

### 7.1 配置
```
C:\wt\
└─ <repo>\
   ├─ .base\        ← gh repo clone 先(worktree の親リポジトリ)
   ├─ wt-01\        ← worktree
   ├─ wt-02\
   └─ ...
```
- **Unity リポジトリは `D:\wt\<repo>\`、それ以外は `C:\wt\<repo>\`**(Unity の `Library` が大きいため。リポジトリごとに変更可能)
- `C:\wt` は短いパスにしてあるので、Windows のパス長制限を避けやすい。加えて `core.longpaths=true` を設定する

### 7.2 登録(URL 入力)
1. URL を正規化する(`https://github.com/o/r(.git)` / `git@...` / `o/r`)
2. `gh repo clone o/r C:\wt\<r>\.base`
3. 既定ブランチを判定する(`gh repo view --json defaultBranchRef`)
4. **プロジェクト種別を判定**して、依存インストールと保持ディレクトリを決める

| 種別 | 判定 | 依存インストール | 初期化時に残すもの |
|---|---|---|---|
| Node | `package.json` + lockfile | `npm ci` / `pnpm i --frozen-lockfile` / `yarn` | `node_modules` |
| Python | `pyproject.toml` / `requirements.txt` | `uv sync` など | `.venv` |
| **Unity** | `ProjectSettings/ProjectVersion.txt` | なし(初回オープンで生成) | `Library`(再生成に時間がかかるため) |
| その他 | ― | なし | ― |

すべてリポジトリの設定画面で上書きできる。

### 7.3 worktree の状態
```
creating → warming → idle ⇄ assigned → releasing → idle
                       └──(余剰で 30 分未使用)──▶ deleting → (削除)
任意の状態 ──(失敗)──▶ broken(UI で再作成/削除)
```

| 操作 | 処理 |
|---|---|
| 作成 | `git -C .base worktree add --detach wt-NN origin/<base>` → 依存インストール → `idle` |
| 割当 | `git fetch origin` → slug 生成 → `git switch -c feat/<slug> origin/<base>` → 依存ファイルが変わっていたら再インストール → セッション起動 |
| 解放(保持) | push 済みか確認 → `git switch --detach` |
| 解放(PR 作成) | push → `gh pr create`(セッションに説明を書かせる)→ 上と同じ |
| 解放(破棄) | `git switch --detach` → `git branch -D feat/<slug>` |
| 初期化(共通) | `git reset --hard` → `git clean -fdx -e <残すもの>` → `git switch --detach origin/<base>` → `idle` |
| 削除 | `git worktree remove --force` → 失敗したら(ファイルロック)リトライし、それでも駄目なら `broken` |

### 7.4 自動増減
- **目標**: `idle + warming + creating >= 3`(リポジトリごと)
- 割当で不足したら、すぐに作成を開始する
- 総数の上限は 10(設定可能)。上限に達したら新規セッションは待ち行列に入る
- `idle` が 3 本を超えていて 30 分使われていないものは削除する
- 各リポジトリの git 操作は**ミューテックスで直列化**する(`.base` の `index.lock` の競合を避けるため)
- ブランチの `<slug>`:`claude -p --model haiku` で最初の指示から英語の kebab-case(最大 40 文字)を生成し、重複したら `-2` を付ける。UI で編集できる

### 7.5 注意点
- **Unity リポジトリは `Library` が大きい**(実測: TomsLands で 7.4GB。待機 3 本 + 使用中 2 本で約 37GB)。C ドライブの空きは 129GB、D ドライブは 463GB なので、**worktree のルートはリポジトリごとに変更可能にし、Unity は D ドライブに置くことを推奨**する。待機 3 本分のディスクを消費するので、リポジトリごとにプール数を変えられるようにし、空き容量が閾値を下回ったら補充を止めて警告する
- Unity エディタで開いている worktree はファイルロックで削除に失敗するので、解放時に警告する

---

## 8. ブランチ / PR

### GitWatcher(ローカル)
- 使用中の各 worktree の変更を `fs.watch` で検知し、500ms デバウンスして `git status --porcelain=v2 -b` と `git diff --stat` を取得する
- ブランチ一覧は 30 秒ごと:`git for-each-ref refs/heads refs/remotes --format=...` と、base との ahead/behind(`git rev-list --left-right --count`)

### GitHubWatcher(gh)
| 取得 | コマンド | 間隔 |
|---|---|---|
| 自分の PR | `gh pr list --author @me --state all --limit 50 --json number,title,headRefName,state,isDraft,reviewDecision,mergeable,statusCheckRollup,updatedAt,url` | 90 秒 |
| レビュー依頼 | `gh pr list --search "review-requested:@me" --json ...` | 90 秒 |
| セッションの PR | 使用中の worktree のブランチで `gh pr view <branch> --json ...` | 60 秒 |
| 詳細 | `gh pr view N --json body,comments,reviews,files` / `gh pr diff N` | 開いたとき |
| CI ログ | `gh run view <id> --log-failed` | 「直して」を押したとき |

- 前回との差分を取り、CI 失敗・新しいコメント・マージなどのイベントを Notifier に送る
- UI がフォーカスされたときと手動更新ボタンで即時に再取得する

### 操作
| 操作 | 実装 |
|---|---|
| 修正を指示 | レビューコメントや失敗ログを整形し、該当セッションに `/commander <指示>` として送る |
| PR から新規セッション | プールから worktree を割り当てて `gh pr checkout N` |
| マージ | 確認ダイアログ → `gh pr merge N --squash --delete-branch`(方式は設定可能)→ worktree を初期化 |

---

## 9. 通知

| 経路 | 実装 | 条件 |
|---|---|---|
| Windows トースト | Electron 起動中は Electron の `Notification`。起動していなければデーモンが `node-notifier` で表示 | 常時 |
| PWA プッシュ | `web-push` + VAPID 鍵(初回起動時に生成)。購読情報は SQLite に保存 | スマホで購読を許可したとき |
| Discord | Webhook URL に embed を POST。リポジトリごとに URL を設定可能 | 設定したとき |

- **重複防止**: Electron がフォアグラウンドで、そのセッションを表示中ならトーストのみ。PWA と Discord には送らない
- **間引き**: 同じセッションの同じ種類の通知は 30 秒に 1 回まで
- Webhook URL と VAPID の秘密鍵は `%APPDATA%\cc-hub\secrets.json` に保存し、API やログには出さない

---

## 10. API

### 認証
| クライアント | 方式 |
|---|---|
| Electron | `%APPDATA%\cc-hub\local-token` を main プロセスが読み、`Authorization: Bearer` で送る |
| スマホ / ブラウザ | 既存と同じ PIN → HttpOnly Cookie。**トークンは SQLite に永続化**する(今はメモリだけなので、再起動でログアウトされる) |
| hooks / statusLine | `X-CC-Hub-Token`(ingest 専用トークン。環境変数経由) |

- 待ち受けは 127.0.0.1 のみ(変更しない)
- PIN の試行制限(5 回で 5 分ロック)は継承する

### REST(主要なもの)
```
POST /auth                       PIN ログイン
GET  /api/state                  全体スナップショット(セッション, エージェント, プール, 使用率)
POST /api/sessions               {repoId, instruction, mode:'commander'|'plain', name?} → 割当+起動
POST /api/sessions/:id/input     {data, submit?}
POST /api/sessions/:id/resize    {cols, rows}
POST /api/sessions/:id/control   {action:'stop'|'restart'|'resume'}
POST /api/sessions/:id/approve   {option}
POST /api/sessions/:id/release   {mode:'keep'|'pr'|'discard'}
GET  /api/repos | POST /api/repos {url} | PATCH/DELETE /api/repos/:id
GET  /api/repos/:id/branches
GET  /api/prs | GET /api/prs/:repo/:n | POST /api/prs/:repo/:n/{fix|open-session|merge|close}
GET  /api/settings | PATCH /api/settings
POST /api/push/subscribe
POST /ingest/hook | POST /ingest/statusline      (ingest トークン)
GET  /game/windows | /game/stream | POST /game/input   (移植。パスは変えない)
```

### WebSocket `/ws`
1 本の接続で多重化する(SSE は HTTP/1.1 の同時接続数の制限に引っかかるため、WebSocket に移行する)。
```ts
// client → server
{ t: 'sub', topics: ['state', 'term:<sessionId>'] }
{ t: 'unsub', topics: [...] }
// server → client
{ t: 'state.full' } / { t: 'session.upsert' } / { t: 'agent.upsert' } / { t: 'usage' }   // 詳細は packages/shared
{ t: 'term.snapshot', sid, data }              // 購読開始時(serialize)
{ t: 'term.data', sid, data }                  // PTY 出力
{ t: 'notify', event }
```
- ターミナル出力は**購読しているセッションの分だけ**送る(スマホの通信量対策)

---

## 11. データモデル(SQLite)

```sql
repos(id, url, owner, name, base_dir, default_branch, kind, install_cmd, keep_dirs_json, pool_min, created_at)
worktrees(id, repo_id, path, state, branch, session_id, last_used_at, error)
sessions(id /*= claude session_id*/, repo_id, worktree_id, name, mode, status, managed /*0=外部*/,
         cwd, created_at, ended_at, last_event_at, context_pct, cost_usd, pr_number)
agents(agent_id, session_id, parent_agent_id, type, description, model, status, started_at, ended_at, depth)
events(id, session_id, agent_id, kind, payload_json, ts)          -- 直近 N 日分のみ保持
usage(id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, ts)
push_subscriptions(id, endpoint, keys_json, created_at)
auth_tokens(hash, created_at, last_used_at)
settings(key, value_json)
```

---

## 12. UI

### デスクトップ(Electron)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ [5h ███▒▒ 62% 残1:40] [週 ██▒▒▒ 35%]   承認待ち(2) 🔔      [+新規セッション] │
├───────────────┬──────────────────────────────────────┬───────────────────┤
│ ▼ TomsLands   │  #3 feat/login-fix  ● 実行中           │ ▼ エージェント     │
│   ● #3 login  │ ┌──────────────────────────────────┐ │ commander (main)  │
│   ◐ #4 shop   │ │                                  │ │ ├ Explore haiku ✓ │
│ ▼ cc-hub      │ │      xterm (セッション #3)         │ │ ├ impl opus ●     │
│   ○ #5 docs   │ │                                  │ │ │  └ Edit foo.ts  │
│ ─────────     │ └──────────────────────────────────┘ │ └ test sonnet ●   │
│ プール        │  入力欄 [                          ] │ ▼ ブランチ / PR   │
│ TomsLands 3/3 │                                      │ +12 -3, 2 commits │
│ cc-hub   2/3⟳ │                                      │ PR #42 CI ✗ [直す]│
├───────────────┴──────────────────────────────────────┴───────────────────┤
│ タブ: セッション | PR | ブランチ | プール | 設定                           │
└──────────────────────────────────────────────────────────────────────────┘
```
- 左: リポジトリ → セッションの一覧(状態アイコン、コンテキスト使用率)
- 中央: ターミナル。複数セッションを並べる分割表示にも対応(フェーズ 2)
- 右: エージェントツリー、ブランチ / PR の状態
- `Ctrl+1..9` でセッション切替、`Ctrl+Shift+A` で承認キュー

### スマホ(PWA)
下タブ: **セッション / 承認 / PR / ゲーム**
- セッション一覧 → 詳細(ターミナル表示。CC Remote のチャット表示とタッチスクロールを継承)
- 承認: 全セッションの承認待ちをカードで表示し、ワンタップで承認・拒否
- 新規: リポジトリを選ぶ → 指示を入力 → commander で起動

---

## 13. 汎用 commander スキル

- 配置: `~/.claude/skills/hub-commander/SKILL.md`(ユーザースキル)。同名だとユーザースキルがプロジェクトスキルより優先されるため(V5)、`commander` という名前は使わない
- デーモンは起動時に、リポジトリに `.claude/skills/commander` があれば `/commander`、なければ `/hub-commander` を使う
- 内容: TomsLands 版の共通部分を抜き出す
  - 分解 → 規模判定 → 難易度によるモデル割当(opus / sonnet / haiku)→ 衝突チェック → 並列委譲 → 検証 → 統合報告
- プロジェクト固有の情報は、各リポジトリの `CLAUDE.md` と既存のプロジェクトスキルから読む
- worktree の中で動くことを前提に、「サブエージェントの `isolation: worktree` は原則使わない(すでに隔離されているため)」というルールを追加する

---

## 14. CC Remote からの移行

1. cc-hub のデーモンを別のポート(7861)で起動し、スマホから並行して動作確認する
2. 問題がなければ、旧サーバーを止めて新デーモンを 7860 で起動する
3. スタートアップの `cc-remote.vbs` と Watchdog タスクの実行先を cc-hub に切り替える(`scripts/migrate-from-cc-remote.ps1`)
4. `tailscale serve` の設定は 7860 のままなので変更しない
5. `config.json` の PIN と `claudePath` を引き継ぐ
6. 旧 `cc-remote` のフォルダは削除せず、しばらく残しておく(切り戻し用)
7. メモリと `/cc-remote-recover` スキルを新しい構成に更新する

---

## 15. 検証結果(2026-10-10 実施、Claude Code 2.1.295)

| # | 項目 | 結果 | 設計への反映 |
|---|---|---|---|
| V1 | 初回プロンプトに `/スキル名` を渡すとスキルが起動するか | ✅ 起動する | `claude ... "/commander <指示>"` で起動する |
| V2b | SessionStart の http hook | ❌ **発火しない**(実装時に判明) | SessionStart だけ command 型の中継スクリプト(relay.js、async)で送る |
| V2 | デーモン停止中の http hook | ⚠ 遅延なし(+0.2 秒)。ただし `SessionEnd hook [...] failed: connect ECONNREFUSED` が stderr に出る | http hook を使う。TUI に警告が出て邪魔な場合だけ command 型 + `async` に切り替える |
| V3 | サブエージェント内の hooks に `agent_id` が付くか | ✅ 付く。ネストでも、子が起動したエージェントの `PreToolUse(Agent)` に親の `agent_id` が付き、`PostToolUse(Agent)` の `tool_response.agentId` で子の ID が分かる | **親子関係は hooks だけで確定できる**。meta.json は補助 |
| V4 | 環境変数が hooks / statusLine に引き継がれるか | ✅ http hook のヘッダー(`allowedEnvVars`)、command hook、statusLine のすべてに引き継がれる | `CC_HUB_SESSION` を正式に使う |
| V5 | ユーザースキルとプロジェクトスキルが同名の場合 | ⚠ **ユーザースキルが優先**される | 汎用版は `hub-commander` という名前にする。リポジトリに `commander` があればそちらを使う |
| V6 | `PermissionRequest` の http 応答(フェーズ 2) | 未実施 | フェーズ 2 で検証 |
| V7 | `rate_limits` が届くか | ✅ `five_hour` / `seven_day` の `used_percentage` と `resets_at`(Unix 秒) | 設計どおり |

### 検証で見つかった追加事項
| # | 内容 | 対応 |
|---|---|---|
| X1 | **新しいフォルダでは毎回「このフォルダを信頼しますか」ダイアログが出る**(初期選択は「No, exit」)。親フォルダを信頼しても、`.git` を持つ子フォルダには引き継がれない | 信頼の記録は worktree のパスごと。リポジトリ登録時にユーザーが信頼を確認し、以降はデーモンがそのリポジトリの worktree に限ってダイアログに「Yes」と答える。プールの worktree はパス(`wt-01` など)を使い回すので、ダイアログが出るのは各パスで初回だけ |
| X2 | 親プロセスの `CLAUDE_CODE_CHILD_SESSION` などを引き継ぐと「Transcript saving is off」になり、会話ログが保存されない | デーモンは claude を起動するときに **`CLAUDE*` と `CLAUDECODE` の環境変数をすべて取り除く** |
| X3 | Git Bash から `/xxx` という引数を渡すと、Windows のパスに変換される | デーモンは Node から直接起動するので影響なし。スクリプトから試すときは `MSYS_NO_PATHCONV=1` を付ける |

---

## 16. 実装計画

### フェーズ 1(MVP)
| # | タスク | 内容 |
|---|---|---|
| 1 | 検証スパイク | §15 の V1〜V5, V7 |
| 2 | モノレポの雛形 | workspaces、TypeScript、lint、ビルド |
| 3 | デーモンの土台 | HTTP / WS、認証(PIN + ローカルトークン)、SQLite |
| 4 | マルチセッション PTY | SessionManager / PtyHost / ScreenModel / ApprovalDetector(CC Remote から移植) |
| 5 | イベント収集 | hooks / statusLine の受信、インストーラ、statusline.js |
| 6 | Web UI(最小限) | セッション一覧、ターミナル、状態表示、承認キュー、使用率。モバイルレイアウトも |
| 7 | CC Remote の機能移植 | ゲームキャプチャ、PIN、PWA、タッチスクロール |
| 8 | Electron | デーモンの起動、トレイ、トースト |
| 9 | 移行 | §14 の手順 |

### フェーズ 2
リポジトリ登録、worktree プール、commander 起動と汎用 commander スキル、エージェントツリー

### フェーズ 3
ブランチ / PR(閲覧 → 修正指示・PR 作成・マージ)

### フェーズ 4
通知(PWA プッシュ、Discord)、外部セッションの監視、`PermissionRequest` による承認、分割表示
