// CC Hub デーモン: 複数の Claude Code セッション(PTY)を管理し、REST + WebSocket で UI に配信する。
// CC Remote(server.js)の後継。待ち受けは 127.0.0.1 のみ(スマホは tailscale serve 経由)。
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
import { setGhPath } from './github/gh';
import { createServer } from './api/server';
import { WsHub } from './api/ws';
import { stopCapture } from './game/capture';

const VERSION = '0.1.0';

function main(): void {
  const { dir, config, localToken, ingestToken } = loadConfig();
  const store = new Store(dir);
  const auth = new Auth(store, config.pin, localToken, ingestToken);
  const agents = new AgentTree(store);
  const usage = new UsageTracker(store);
  const sessions = new SessionManager(config, store, agents, usage);
  setGhPath(config.ghPath, dir);
  const repos = new RepoManager(config, store, dir, sessions);
  const gitStat = new GitStatWatcher(repos.pool, (id) => repos.all()[id]);
  const github = new GitHubWatcher({
    pollMs: config.prPollSeconds * 1000,
    repos: () => Object.values(repos.all()),
    pool: repos.pool,
    sessions: () => sessions.all(),
  });
  const prs = new PrActions(repos, sessions, github);
  const startedAt = Date.now();

  const getState = (): HubState => ({
    sessions: sessions.all(),
    agents: agents.all(),
    repos: repos.all(),
    worktrees: repos.pool.all(),
    prs: github.all(),
    usage: usage.usage,
    daemon: { version: VERSION, startedAt, port: config.port },
  });

  const server = createServer({
    auth,
    sessions,
    repos,
    github,
    prs,
    claudePath: config.claudePath,
    getState,
    onIngestHook: (body, hubHeader) => sessions.handleHook(body, hubHeader),
    onIngestStatusline: (body) => {
      // statusline.js は {hub_session, data} で送る。素の statusLine JSON が来ても受け付ける
      if (body && typeof body === 'object' && 'data' in body) sessions.handleStatusline(body.hub_session, body.data);
      else sessions.handleStatusline(null, body);
    },
  });
  const ws = new WsHub(auth, sessions, getState);
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head));

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

  let exiting = false;
  const shutdown = (sig: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`[daemon] ${sig} を受けたので終了します`);
    sessions.shutdown();
    repos.stop();
    gitStat.stop();
    github.stop();
    stopCapture();
    ws.closeAll();
    server.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('uncaughtException', (err) => console.error('[daemon] uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('[daemon] unhandledRejection', err));
}

main();
