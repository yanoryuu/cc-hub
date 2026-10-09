// SQLite ストア(better-sqlite3)。セッション・エージェント・認証トークン・設定値を保存する。
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AgentNode, SessionInfo, SessionMode, SessionStatus } from '@cc-hub/shared';

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
    `);
  }

  // ------------------------------------------------------------ sessions
  saveSession(s: SessionInfo, endedAt: number | null): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, cwd, mode, status, managed, created_at, ended_at, last_event_at,
           context_pct, cost_usd, model, permission_mode, last_message, exit_code)
         VALUES (@id, @name, @cwd, @mode, @status, @managed, @created_at, @ended_at, @last_event_at,
           @context_pct, @cost_usd, @model, @permission_mode, @last_message, @exit_code)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, cwd=excluded.cwd, mode=excluded.mode,
           status=excluded.status, managed=excluded.managed, ended_at=excluded.ended_at,
           last_event_at=excluded.last_event_at, context_pct=excluded.context_pct,
           cost_usd=excluded.cost_usd, model=excluded.model, permission_mode=excluded.permission_mode,
           last_message=excluded.last_message, exit_code=excluded.exit_code`,
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
      });
  }

  loadSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as SessionRow[];
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM agents WHERE session_id = ?').run(id);
  }

  // ------------------------------------------------------------ agents
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
