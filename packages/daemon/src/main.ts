// CC Hub デーモン: 複数の Claude Code セッション(PTY)を管理し、REST + WebSocket で UI に配信する。
// CC Remote(server.js)の後継。待ち受けは 127.0.0.1 のみ(スマホは tailscale serve 経由)。
import fs from 'node:fs';
import path from 'node:path';
import type { HubState } from '@cc-hub/shared';
import { loadConfig } from './config';
import { Store } from './store/db';
import { Auth } from './api/auth';
import { AgentTree } from './agents/tree';
import { UsageTracker } from './usage';
import { SessionManager } from './session/manager';
import { RepoManager } from './repo/manager';
import { GitStatWatcher } from './repo/gitstat';
import { GitHubWatcher } from './github/watcher';
import { PrActions } from './github/actions';
import { ProjectService } from './project/service';
import { setGhPath } from './github/gh';
import { createServer } from './api/server';
import { WsHub } from './api/ws';
import { ShellManager } from './shell/manager';
import { SessionDrafts } from './session/drafts';
import { stopCapture } from './game/capture';
import { dpapi } from './dpapi';
import { NotifyService } from './notify/service';
import { loadImages } from './notify/images';
import { DeployService } from './deploy/service';
import { InstructionsService } from './project/instructions';
import { ReplyRouter } from './notify/replies';
import { formatStatus } from './notify/status';
import { RestartScheduler, relaunchSelf, waitForPid } from './restart/scheduler';
import { startAutoRelease } from './repo/autorelease';
import { IDLE_CHECK_MS } from './session/idlestop';
import { createRunner } from './firebase/cli';
import { FirebaseInfoService } from './firebase/info';

const VERSION = '0.2.0';

function main(): void {
  const { dir, config, localToken, ingestToken, mcpToken } = loadConfig();
  const store = new Store(dir);
  const auth = new Auth(store, config.pin, localToken, ingestToken);
  const agents = new AgentTree(store);
  const usage = new UsageTracker(store);
  const sessions = new SessionManager(config, store, agents, usage);
  setGhPath(config.ghPath, dir);
  const repos = new RepoManager(config, store, dir, sessions);
  const gitStat = new GitStatWatcher(repos.pool, (id) => repos.all()[id]);
  repos.setGitStatRefresher((id) => void gitStat.refresh(id));
  const github = new GitHubWatcher({
    pollMs: config.prPollSeconds * 1000,
    repos: () => Object.values(repos.all()),
    pool: repos.pool,
    sessions: () => sessions.all(),
  });
  const prs = new PrActions(repos, sessions, github);
  const project = new ProjectService({ sessions, repos, github, gitStat });
  // プロジェクトの共通の指示: CC Hub が起動するセッションに --append-system-prompt-file で渡す
  const instructions = new InstructionsService(store, dir, config.claudePath);
  sessions.setInstructionsResolver((info) => instructions.fileForSession(info));
  // Firebase: firebase CLI(config.firebasePath)で状況の取得とデプロイ(デプロイのジョブは DeployService が持つ)
  const firebaseRun = createRunner(config.firebasePath);
  const firebaseInfo = new FirebaseInfoService(firebaseRun);
  const deploy = new DeployService({
    store,
    secrets: dpapi,
    sessionName: (id) => sessions.info(id)?.name ?? null,
    firebase: { run: firebaseRun, info: firebaseInfo },
  });
  // ws は後で作るので、デスクトップアプリの接続数は遅延参照する
  let ws: WsHub | null = null;
  const notify = new NotifyService({
    store,
    secrets: dpapi,
    session: (id) => sessions.info(id),
    desktopClients: () => ws?.desktopCount() ?? 0,
  });
  // Discord の通知への返信 / スレッドへの書き込み → そのセッションへの横からの質問(作業の指示は CC Hub から行う。承認は承認用チャンネルのボタンで答える)
  const replies = new ReplyRouter({
    info: (id) => sessions.info(id),
    resumeIdFor: (id) => sessions.resumeIdFor(id),
    claudePath: config.claudePath,
  });
  notify.setReplyHandler((req, io) => replies.handle(req, io));
  // アップロード / Firebase デプロイの承認ボタン(Bot が承認用チャンネルに投稿)
  notify.setDeployActions(deploy);
  // セッション中の承認(選択肢)も Discord のボタンで答えられる
  notify.setSessionApprove((id, option) => sessions.approve(id, option));
  // 再起動の予約: CC Hub のセッションに作業中のものが無くなったら scripts/deploy.ps1 で再起動する
  // 作業が終わった worktree(セッション停止・変更なし・コミットなし or PR マージ済み)を解放して最新の main に戻す
  const stopAutoRelease = startAutoRelease({
    worktrees: () => Object.values(repos.pool.all()),
    session: (id) => sessions.info(id),
    isRunning: (id) => sessions.isRunning(id),
    prs: () => github.list(),
    release: (sid) => repos.release(sid, 'keep'),
  });
  // インストール版には deploy.ps1 が無い: 新しいデーモンを起動して自分は終了する(ビルドはしない)
  const deployScript = path.join(__dirname, '..', '..', '..', 'scripts', 'deploy.ps1');
  let exitForRestart: () => void = () => process.exit(0);
  const restart = new RestartScheduler({
    busy: () => [
      ...Object.values(sessions.all())
        .filter((s) => s.managed && ['running', 'awaiting_approval', 'starting'].includes(s.status) && (s.status === 'starting' || sessions.isLive(s.id)))
        .map((s) => s.name),
      ...Object.values(deploy.allJobs())
        .filter((j) => j.state === 'planning' || j.state === 'uploading')
        .map((j) => `アップロード: ${j.serverName}`),
    ],
    script: deployScript,
    logFile: path.join(dir, 'restart.log'),
    relaunch: fs.existsSync(deployScript) ? undefined : () => relaunchSelf(path.join(dir, 'daemon.log'), () => exitForRestart()),
  });
  // Discord の /status
  notify.setStatusProvider(() =>
    formatStatus({ sessions: Object.values(sessions.all()), deploys: Object.values(deploy.allJobs()), restart: restart.status(), now: Date.now() }),
  );
  /** cwd がリポジトリ(.base / worktree / 紐付けたクローン済みのフォルダ)の中なら repoId */
  const repoIdForCwd = (cwd: string): string | null => repos.repoForCwd(cwd)?.id ?? null;
  const startedAt = Date.now();
  // ほかの端末から開く PowerShell(Claude は動かさない端末)
  const shells = new ShellManager();

  const getState = (): HubState => ({
    sessions: sessions.all(),
    agents: agents.all(),
    repos: repos.all(),
    worktrees: repos.pool.all(),
    prs: github.all(),
    servers: deploy.allServers(),
    deploys: deploy.allJobs(),
    usage: usage.usage,
    daemon: { version: VERSION, startedAt, port: config.port },
    shells: shells.list(),
  });

  const server = createServer({
    auth,
    sessions,
    shells,
    drafts: new SessionDrafts(store),
    repos,
    github,
    prs,
    project,
    notify,
    deploy,
    restart,
    firebase: firebaseInfo,
    instructions,
    mcp: {
      auth,
      mcpToken,
      version: VERSION,
      deploy,
      firebase: firebaseInfo,
      instructions,
      sessions: () => sessions.all(),
      repoIdForCwd,
      launchers: {
        upsert: (sessionId, spec) => sessions.upsertLauncher(sessionId, spec, 'claude'),
        remove: (sessionId, label) => sessions.removeLauncher(sessionId, label),
      },
      images: { queue: (sessionId, paths, cwd, caption) => notify.queueImages(sessionId, loadImages(paths, cwd), caption) },
    },
    claudePath: config.claudePath,
    getState,
    onIngestHook: (body, hubHeader) => sessions.handleHook(body, hubHeader),
    onIngestStatusline: (body) => {
      // statusline.js は {hub_session, data} で送る。素の statusLine JSON が来ても受け付ける
      if (body && typeof body === 'object' && 'data' in body) sessions.handleStatusline(body.hub_session, body.data);
      else sessions.handleStatusline(null, body);
    },
  });
  const wsHub = new WsHub(auth, sessions, shells, getState);
  ws = wsHub;
  server.on('upgrade', (req, socket, head) => wsHub.handleUpgrade(req, socket, head));

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[http] listen に失敗しました: ${err.code || err.message}`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(`CC Hub daemon v${VERSION}: http://${config.host}:${config.port}`);
    console.log(`data: ${dir}`);
    console.log(`claude: ${config.claudePath}`);
    // サーバーが立ってから自動再開する(hooks を受けられるように)
    sessions.restore();
    // セッションの復元後に worktree プールを復旧する(割当中の worktree の持ち主を確認するため)
    repos.init();
    // フェーズ 3: worktree の変更状況と PR の監視
    gitStat.start();
    github.start();
  });

  setInterval(() => agents.gc(), 600_000).unref();
  // 入力待ちのまま長く使っていないセッションを止めてメモリを空ける(設定 → CC Hub)
  const idleTimer = setInterval(() => sessions.stopIdle(), IDLE_CHECK_MS);
  idleTimer.unref();

  let exiting = false;
  const shutdown = (sig: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`[daemon] ${sig} を受けたので終了します`);
    sessions.shutdown();
    shells.stopAll();
    repos.stop();
    gitStat.stop();
    github.stop();
    stopCapture();
    notify.stop();
    restart.stop();
    stopAutoRelease();
    clearInterval(idleTimer);
    wsHub.closeAll();
    server.close();
    setTimeout(() => process.exit(0), 500);
  };
  exitForRestart = () => shutdown('restart');
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('uncaughtException', (err) => console.error('[daemon] uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('[daemon] unhandledRejection', err));
}

// 再起動で起動された場合は、前のデーモンが終わって(ポートが空いて)から始める
void waitForPid(process.env.CC_HUB_WAIT_PID).then(main);
