// SQLite ストア(better-sqlite3)。セッション・エージェント・認証トークン・設定値を保存する。
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AgentNode, RepoInfo, SessionInfo, SessionMode, SessionStatus, WorktreeInfo } from '@cc-hub/shared';

export interface SessionRow {
  id: string;
  name: string;
  cwd: string;
  mode: SessionMode;
  status: SessionStatus;
  managed: number;
  created_at: number;
  ended_at: number | null;
  last_event_at: number;
  context_pct: number | null;
  cost_usd: number | null;
  model: string | null;
  permission_mode: string | null;
  last_message: string | null;
  exit_code: number | null;
  repo_id: string | null;
  worktree_id: string | null;
  branch: string | null;
  /** /clear・compact 等で変わった claude 側の session_id(--resume に使う)。null = id と同じ */
  claude_session_id: string | null;
}

/** worktree の内部情報(WorktreeInfo に含めないもの) */
export interface WorktreeRow extends WorktreeInfo {
  /** 依存インストール時の lockfile のハッシュ */
  installHash: string | null;
  /** 削除の連続失敗回数 */
  failCount: number;
}

export class Store {
  readonly db: Database.Database;

  constructor(dir: string) {
    this.db = new Database(path.join(dir, 'hub.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, managed INTEGER NOT NULL, created_at INTEGER NOT NULL,
        ended_at INTEGER, last_event_at INTEGER NOT NULL, context_pct REAL, cost_usd REAL,
        model TEXT, permission_mode TEXT, last_message TEXT, exit_code INTEGER,
        repo_id TEXT, worktree_id TEXT, pr_number INTEGER
      );
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_agent_id TEXT,
        type TEXT NOT NULL, description TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, depth INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id);
      CREATE TABLE IF NOT EXISTS auth_tokens (
        hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
        base_dir TEXT NOT NULL, default_branch TEXT NOT NULL, kind TEXT NOT NULL, install_cmd TEXT,
        keep_dirs_json TEXT NOT NULL, seed_library_from TEXT, pool_min INTEGER NOT NULL,
        pool_max INTEGER NOT NULL, trusted INTEGER NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
        state TEXT NOT NULL, branch TEXT, session_id TEXT, last_used_at INTEGER NOT NULL,
        progress TEXT, error TEXT, install_hash TEXT, fail_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS worktrees_repo ON worktrees(repo_id);
    `);
    // フェーズ 1 の DB に無い列を足す(既存 DB を壊さないよう ADD COLUMN のみ)
    this.addColumn('sessions', 'branch', 'TEXT');
    this.addColumn('sessions', 'claude_session_id', 'TEXT');
  }

  private addColumn(table: string, col: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

  // ------------------------------------------------------------ sessions
  saveSession(s: SessionInfo, endedAt: number | null, claudeSessionId: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, cwd, mode, status, managed, created_at, ended_at, last_event_at,
           context_pct, cost_usd, model, permission_mode, last_message, exit_code,
           repo_id, worktree_id, branch, claude_session_id)
         VALUES (@id, @name, @cwd, @mode, @status, @managed, @created_at, @ended_at, @last_event_at,
           @context_pct, @cost_usd, @model, @permission_mode, @last_message, @exit_code,
           @repo_id, @worktree_id, @branch, @claude_session_id)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, cwd=excluded.cwd, mode=excluded.mode,
           status=excluded.status, managed=excluded.managed, ended_at=excluded.ended_at,
           last_event_at=excluded.last_event_at, context_pct=excluded.context_pct,
           cost_usd=excluded.cost_usd, model=excluded.model, permission_mode=excluded.permission_mode,
           last_message=excluded.last_message, exit_code=excluded.exit_code,
           repo_id=excluded.repo_id, worktree_id=excluded.worktree_id, branch=excluded.branch,
           claude_session_id=excluded.claude_session_id`,
      )
      .run({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        mode: s.mode,
        status: s.status,
        managed: s.managed ? 1 : 0,
        created_at: s.createdAt,
        ended_at: endedAt,
        last_event_at: s.lastEventAt,
        context_pct: s.contextPct,
        cost_usd: s.costUsd,
        model: s.model,
        permission_mode: s.permissionMode,
        last_message: s.lastMessage,
        exit_code: s.exitCode,
        repo_id: s.repoId,
        worktree_id: s.worktreeId,
        branch: s.branch,
        claude_session_id: claudeSessionId,
      });
  }

  loadSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as SessionRow[];
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM agents WHERE session_id = ?').run(id);
  }

  // ------------------------------------------------------------ repos / worktrees(フェーズ 2)
  saveRepo(r: RepoInfo): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO repos (id, url, owner, name, base_dir, default_branch, kind, install_cmd,
           keep_dirs_json, seed_library_from, pool_min, pool_max, trusted, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.url, r.owner, r.name, r.baseDir, r.defaultBranch, r.kind, r.installCmd, JSON.stringify(r.keepDirs),
        r.seedLibraryFrom, r.poolMin, r.poolMax, r.trusted ? 1 : 0, r.status, r.error, r.createdAt);
  }

  loadRepos(): RepoInfo[] {
    const rows = this.db.prepare('SELECT * FROM repos ORDER BY created_at').all() as Record<string, any>[];
    return rows.map((r) => {
      let keepDirs: string[] = [];
      try {
        keepDirs = JSON.parse(r.keep_dirs_json);
      } catch {
        /* 壊れていたら空 */
      }
      return {
        id: r.id,
        url: r.url,
        owner: r.owner,
        name: r.name,
        baseDir: r.base_dir,
        defaultBranch: r.default_branch,
        kind: r.kind,
        installCmd: r.install_cmd ?? null,
        keepDirs: Array.isArray(keepDirs) ? keepDirs.map(String) : [],
        seedLibraryFrom: r.seed_library_from ?? null,
        poolMin: Number(r.pool_min),
        poolMax: Number(r.pool_max),
        trusted: !!r.trusted,
        status: r.status,
        error: r.error ?? null,
        createdAt: Number(r.created_at),
      } as RepoInfo;
    });
  }

  deleteRepo(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM worktrees WHERE repo_id = ?').run(id);
  }

  saveWorktree(w: WorktreeRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO worktrees (id, repo_id, name, path, state, branch, session_id, last_used_at,
           progress, error, install_hash, fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.id, w.repoId, w.name, w.path, w.state, w.branch, w.sessionId, w.lastUsedAt, w.progress, w.error, w.installHash, w.failCount);
  }

  loadWorktrees(): WorktreeRow[] {
    const rows = this.db.prepare('SELECT * FROM worktrees ORDER BY id').all() as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      repoId: r.repo_id,
      name: r.name,
      path: r.path,
      state: r.state,
      branch: r.branch ?? null,
      sessionId: r.session_id ?? null,
      lastUsedAt: Number(r.last_used_at),
      progress: r.progress ?? null,
      error: r.error ?? null,
      installHash: r.install_hash ?? null,
      failCount: Number(r.fail_count) || 0,
    }));
  }

  deleteWorktree(id: string): void {
    this.db.prepare('DELETE FROM worktrees WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ agents
  deleteAgent(agentId: string): void {
    this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
  }

  saveAgent(a: AgentNode): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agents (agent_id, session_id, parent_agent_id, type, description, model,
           status, started_at, ended_at, depth)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.agentId, a.sessionId, a.parentAgentId, a.type, a.description, a.model, a.status, a.startedAt, a.endedAt, a.depth);
  }

  loadAgents(): AgentNode[] {
    const rows = this.db.prepare('SELECT * FROM agents').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      agentId: String(r.agent_id),
      sessionId: String(r.session_id),
      parentAgentId: (r.parent_agent_id as string) ?? null,
      type: String(r.type),
      description: String(r.description),
      model: (r.model as string) ?? null,
      status: r.status as AgentNode['status'],
      currentTool: null,
      startedAt: Number(r.started_at),
      endedAt: (r.ended_at as number) ?? null,
      depth: Number(r.depth),
    }));
  }

  // ------------------------------------------------------------ auth tokens(sha256 のみ保存)
  addAuthToken(hash: string): void {
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO auth_tokens (hash, created_at, last_used_at) VALUES (?, ?, ?)').run(hash, now, now);
  }

  loadAuthTokens(): string[] {
    // 30 日以上使われていないものは捨てる
    this.db.prepare('DELETE FROM auth_tokens WHERE last_used_at < ?').run(Date.now() - 30 * 86400_000);
    return (this.db.prepare('SELECT hash FROM auth_tokens').all() as { hash: string }[]).map((r) => r.hash);
  }

  touchAuthToken(hash: string): void {
    this.db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE hash = ?').run(Date.now(), hash);
  }

  // ------------------------------------------------------------ settings(key-value)
  getSetting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.value_json) as T;
    } catch {
      return null;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
}
