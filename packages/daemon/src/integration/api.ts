// 外部連携の API(/api/integration/*)。認証は Authorization: Bearer cch_...(連携トークン)だけで、
// PIN / ローカルトークンの Cookie は使わない。tailscale serve 経由(プロキシヘッダ付き)は拒否する(このPCの中からだけ)。
//
//   GET  /api/integration/projects                  state:read     起動できるプロジェクトの一覧
//   GET  /api/integration/sessions                  state:read     セッションの一覧
//   GET  /api/integration/sessions/:id              state:read     セッション 1 件
//   GET  /api/integration/sessions/:id/last-message state:read     最後のアシスタント発言の全文
//   GET  /api/integration/events                    state:read     status の変化(SSE)
//   POST /api/integration/sessions                  sessions:start セッションを起動(登録済みのプロジェクトのみ・回数制限あり)
import path from 'node:path';
import type http from 'node:http';
import { SESSION_MODELS, type FolderProject, type HistoryMessage, type ModePreset, type RepoInfo, type SessionInfo, type StartSessionRequest } from '@cc-hub/shared';
import { HttpError, json, readBody } from '../util';
import { type IntegrationEvents, toIntegrationSession } from './events';
import type { IntegrationScope, IntegrationTokenInfo, IntegrationTokens } from './tokens';

export const INTEGRATION_START_MAX = 5;
export const INTEGRATION_START_WINDOW_MS = 10 * 60_000;
const INSTRUCTION_MAX = 20_000;
const NAME_MAX = 80;

export interface IntegrationDeps {
  tokens: IntegrationTokens;
  events: IntegrationEvents;
  sessions: () => SessionInfo[];
  session: (id: string) => SessionInfo | undefined;
  repos: () => RepoInfo[];
  folders: () => FolderProject[];
  modes: () => ModePreset[];
  start: (req: StartSessionRequest) => SessionInfo;
  /** その セッションの transcript の直近のメッセージ(時系列順) */
  messages: (id: string) => HistoryMessage[];
}

const startLog = new Map<string, number[]>();
export function resetIntegrationStartLog(): void {
  startLog.clear();
}

function norm(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function need(t: IntegrationTokenInfo, scope: IntegrationScope): void {
  if (!t.scopes.includes(scope)) throw new HttpError(403, `このトークンには ${scope} の権限がありません`);
}

/** project(リポジトリの id / 名前、または登録済みフォルダのパス)を起動先にする */
function resolveProject(d: IntegrationDeps, project: unknown): { repoId: string } | { cwd: string } {
  if (typeof project !== 'string' || !project.trim()) throw new HttpError(400, 'project を指定してください(GET /api/integration/projects の id か path)');
  const p = project.trim();
  const repos = d.repos();
  const byId = repos.find((r) => r.id.toLowerCase() === p.toLowerCase());
  if (byId) return { repoId: byId.id };
  const byName = repos.filter((r) => r.name.toLowerCase() === p.toLowerCase());
  if (byName.length > 1) throw new HttpError(400, `同じ名前のリポジトリが複数あります。id で指定してください: ${byName.map((r) => r.id).join(', ')}`);
  if (byName.length === 1) return { repoId: byName[0].id };
  if (path.isAbsolute(p)) {
    const f = d.folders().find((x) => norm(x.path) === norm(p));
    if (f) return { cwd: f.path };
  }
  throw new HttpError(404, `登録されていないプロジェクトです: ${p}(CC Hub で登録したリポジトリかフォルダだけ起動できます)`);
}

function startSession(d: IntegrationDeps, t: IntegrationTokenInfo, body: unknown): SessionInfo {
  const b = (body ?? {}) as Record<string, unknown>;
  const instruction = typeof b.instruction === 'string' ? b.instruction.trim() : '';
  if (!instruction) throw new HttpError(400, 'instruction(最初の指示)を入れてください');
  if (instruction.length > INSTRUCTION_MAX) throw new HttpError(400, `instruction は ${INSTRUCTION_MAX} 文字までです`);
  if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > NAME_MAX)) throw new HttpError(400, `name は ${NAME_MAX} 文字までの文字列です`);
  if (b.mode !== undefined && (typeof b.mode !== 'string' || !d.modes().some((m) => m.id === b.mode))) {
    throw new HttpError(400, `mode が不正です(${d.modes().map((m) => m.id).join(' / ')})`);
  }
  const models = SESSION_MODELS.map((m) => m.id) as string[];
  if (b.model !== undefined && (typeof b.model !== 'string' || !models.includes(b.model))) throw new HttpError(400, `model が不正です(${models.join(' / ')})`);
  const target = resolveProject(d, b.project);

  // 回数制限(トークンごと)。成功したときだけ数える
  const now = Date.now();
  const log = (startLog.get(t.id) ?? []).filter((x) => now - x < INTEGRATION_START_WINDOW_MS);
  if (log.length >= INTEGRATION_START_MAX) {
    const wait = Math.ceil((INTEGRATION_START_WINDOW_MS - (now - log[0])) / 60_000);
    throw new HttpError(429, `起動が多すぎます(${INTEGRATION_START_WINDOW_MS / 60_000} 分に ${INTEGRATION_START_MAX} 回まで)。約 ${wait} 分後にやり直してください`);
  }
  const s = d.start({
    cwd: 'cwd' in target ? target.cwd : '',
    ...('repoId' in target ? { repoId: target.repoId } : {}),
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined,
    mode: typeof b.mode === 'string' ? b.mode : 'plain',
    model: typeof b.model === 'string' ? (b.model as StartSessionRequest['model']) : undefined,
    instruction,
  } as StartSessionRequest);
  log.push(now);
  startLog.set(t.id, log);
  return s;
}

/** 最後のユーザー発言より後のアシスタント発言をつなげたもの */
export function lastAssistantText(msgs: HistoryMessage[]): { text: string | null; at: number | null } {
  const out: HistoryMessage[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') {
      if (out.length) break;
      continue;
    }
    if (m.role === 'assistant') out.unshift(m);
  }
  if (!out.length) return { text: null, at: null };
  return { text: out.map((m) => m.text).join('\n\n'), at: out[out.length - 1].ts };
}

/** /api/integration/* なら処理して true */
export async function handleIntegration(d: IntegrationDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/integration/')) return false;
  if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers['x-forwarded-host']) {
    json(res, 403, { ok: false, error: '外部連携の API はこの PC の中からだけ使えます' });
    return true;
  }
  const t = d.tokens.authenticate(req);
  if (!t) {
    json(res, 401, { ok: false, error: '連携トークンが無効です(Authorization: Bearer cch_...)' });
    return true;
  }
  const method = req.method || 'GET';

  if (p === '/api/integration/projects' && method === 'GET') {
    need(t, 'state:read');
    json(res, 200, {
      ok: true,
      repos: d.repos().map((r) => ({ id: r.id, name: r.name, status: r.status })),
      folders: d.folders().map((f) => ({ path: f.path })),
      modes: d.modes().map((m) => ({ id: m.id, label: m.label })),
      models: SESSION_MODELS.map((m) => m.id),
    });
    return true;
  }

  if (p === '/api/integration/sessions' && method === 'GET') {
    need(t, 'state:read');
    const list = d.sessions().sort((a, b) => (b.lastEventAt ?? b.createdAt) - (a.lastEventAt ?? a.createdAt));
    json(res, 200, { ok: true, sessions: list.map(toIntegrationSession) });
    return true;
  }

  if (p === '/api/integration/sessions' && method === 'POST') {
    need(t, 'sessions:start');
    const s = startSession(d, t, await readBody(req));
    json(res, 200, { ok: true, session: toIntegrationSession(s) });
    return true;
  }

  if (p === '/api/integration/events' && method === 'GET') {
    need(t, 'state:read');
    d.events.subscribe(req, res, d.sessions());
    return true;
  }

  const m = /^\/api\/integration\/sessions\/([^/]+)(\/last-message)?$/.exec(p);
  if (m && method === 'GET') {
    need(t, 'state:read');
    const id = decodeURIComponent(m[1]);
    const s = d.session(id);
    if (!s) throw new HttpError(404, 'セッションが見つかりません');
    if (!m[2]) {
      json(res, 200, { ok: true, session: toIntegrationSession(s) });
      return true;
    }
    const r = lastAssistantText(d.messages(id));
    json(res, 200, { ok: true, sessionId: id, status: s.status, text: r.text, at: r.at });
    return true;
  }

  throw new HttpError(404, 'not found');
}
