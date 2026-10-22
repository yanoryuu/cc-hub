# CC Hub

複数の Claude Code セッションを 1 つの画面でまとめて扱う Windows 用のアプリです。

## インストール(Windows)

1. 先に次の 2 つを入れておきます。
   - **Claude Code**: PowerShell で `irm https://claude.ai/install.ps1 | iex` を実行し、一度 `claude` を起動してログインします。
   - **Git**: [Git for Windows](https://git-scm.com/download/win) を既定の設定のまま入れます。
   - (任意)PR の機能を使うなら [GitHub CLI](https://cli.github.com/) を入れて `gh auth login` しておきます。
2. Releases から `CC-Hub-Setup-<バージョン>.exe` をダウンロードして実行します。
   - 署名していないため「Windows によって PC が保護されました」と出ることがあります。「詳細情報」→「実行」で進めてください。
3. インストールが終わると CC Hub が起動し、Claude Code との連携を自動で設定します。

Node.js のインストールや、コマンドでの設定は要りません。

### インストール時に自動で行うこと

- CC Hub 本体(デーモン)の起動と、ログイン時の自動起動(トレイの「ログイン時に起動」で切り替え)
- 本体が止まったときの自動の起こし直し
- Claude Code への登録(`~/.claude/settings.json` は書き換える前にバックアップを作ります)
  - hooks(ターミナルや VS Code で使っている Claude Code もこの画面に表示するため)
  - statusLine(未設定のときだけ)
  - MCP サーバー「cc-hub」
  - スキル `hub-commander`

設定の記録は `%APPDATA%\cc-hub\setup.log` にあります。

### アンインストール

「設定」→「アプリ」→「CC Hub」→「アンインストール」。Claude Code に登録した hooks と MCP も外します。
セッションの記録や設定(`%APPDATA%\cc-hub`)は残ります。

## インストーラーの作り方(開発者向け)

```
npm install
npm run dist
```

`release\CC-Hub-Setup-<バージョン>.exe` ができます。インストーラーには、ビルドに使った node.exe とネイティブモジュールをそのまま同梱します(`scripts\stage-hub.cjs`)。

設計は `docs\design.md`、要件は `docs\requirements.md` にあります。
