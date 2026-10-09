// REST ヘルパー。401 を受けたら PIN 画面を出し、ログイン成功後に同じリクエストを再試行する。
import type { HubState, RegisterRepoRequest, ReleaseMode, RepoInfo } from '@cc-hub/shared';

export class AuthError extends Error {
  constructor() {
    super('unauthorized');
  }
}

/** API エラー(HTTP ステータス付き。409 = 状態の競合 など) */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type AuthWaiter = () => void;
let authWaiters: AuthWaiter[] = [];
let onNeedAuth: () => void = () => {};

/** store 側から「PIN 画面を出す」処理を登録する */
export function setNeedAuthHandler(fn: () => void): void {
  onNeedAuth = fn;
}

/** PIN ログイン成功時に呼ぶ: 待っていたリクエストを再開させる */
export function resolveAuthWaiters(): void {
  const w = authWaiters;
  authWaiters = [];
  for (const f of w) f();
}

function waitForAuth(): Promise<void> {
  return new Promise((resolve) => authWaiters.push(resolve));
}

export interface ApiOptions {
  /** true なら 401 時に再ログインを待たずに AuthError を投げる */
  noRetry?: boolean;
  /** 省略時は body があれば POST、なければ GET */
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
}

export async function api<T = any>(path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  for (;;) {
    const res = await fetch(path, {
      method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      onNeedAuth();
      if (opts.noRetry) throw new AuthError();
      await waitForAuth();
      continue;
    }
    const j = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as any;
    if (!res.ok && j && j.ok !== false) j.ok = false;
    if (j && j.ok === false) throw new ApiError(j.error || `HTTP ${res.status}`, res.status);
    return j as T;
  }
}

export async function login(pin: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
    credentials: 'same-origin',
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error || (j.ok ? undefined : `ログインに失敗しました (HTTP ${res.status})`) };
}

/** GET /api/state のレスポンスは HubState 直 / {ok, state} / {ok, data} のどれでも受ける */
export function pickState(r: any): HubState | null {
  if (!r || typeof r !== 'object') return null;
  // repos / worktrees はフェーズ 2 以降のデーモンのみ。無ければ store 側で {} 扱い
  if (r.sessions && r.agents) return r as HubState;
  if (r.state?.sessions) return r.state as HubState;
  if (r.data?.sessions) return r.data as HubState;
  return null;
}

/** {ok, key: X} / {ok, data: {key: X}} / {ok, data: X} のどれでも key を取り出す */
export function pick<T>(r: any, key: string): T | undefined {
  if (!r) return undefined;
  if (r[key] !== undefined) return r[key] as T;
  if (r.data && r.data[key] !== undefined) return r.data[key] as T;
  if (r.data !== undefined) return r.data as T;
  return undefined;
}

// セッション操作ショートカット
export const sessionApi = {
  input: (id: string, data: string, submit = false) =>
    api(`/api/sessions/${encodeURIComponent(id)}/input`, submit ? { data, submit: true } : { data }),
  resize: (id: string, cols: number, rows: number) =>
    api(`/api/sessions/${encodeURIComponent(id)}/resize`, { cols, rows }),
  control: (id: string, action: 'stop' | 'restart' | 'remove') =>
    api(`/api/sessions/${encodeURIComponent(id)}/control`, { action }),
  approve: (id: string, option: string) => api(`/api/sessions/${encodeURIComponent(id)}/approve`, { option }),
  rename: (id: string, name: string) => api(`/api/sessions/${encodeURIComponent(id)}/rename`, { name }),
};

// ---------------------------------------------------------------- フェーズ 2: リポジトリ / worktree プール

/** :id の "/" と "#" をエスケープ */
const enc = encodeURIComponent;

export type RepoPatch = Partial<
  Pick<RepoInfo, 'poolMin' | 'poolMax' | 'installCmd' | 'keepDirs' | 'seedLibraryFrom' | 'trusted'>
>;

export const repoApi = {
  register: (req: RegisterRepoRequest) => api('/api/repos', req),
  patch: (id: string, patch: RepoPatch) => api(`/api/repos/${enc(id)}`, patch, { method: 'PATCH' }),
  remove: (id: string, purge: boolean) =>
    api(`/api/repos/${enc(id)}${purge ? '?purge=1' : ''}`, undefined, { method: 'DELETE' }),
  refill: (id: string) => api(`/api/repos/${enc(id)}/refill`, {}),
  rebuildWorktree: (id: string) => api(`/api/worktrees/${enc(id)}/rebuild`, {}),
  deleteWorktree: (id: string) => api(`/api/worktrees/${enc(id)}`, undefined, { method: 'DELETE' }),
  release: (sessionId: string, mode: ReleaseMode) => api(`/api/sessions/${enc(sessionId)}/release`, { mode }),
  slug: (instruction: string) => api('/api/slug', { instruction }),
};

/** エラーを表示用の文字列にする */
export function errText(e: unknown, fallback = '失敗しました'): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** 409(状態の競合: 実行中 / 使用中 など)か */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}
