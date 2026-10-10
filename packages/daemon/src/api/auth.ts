// 認証: PIN → Cookie ccr_token(sha256 を SQLite に保存し、再起動してもログアウトしない)、
// ローカルトークン(Cookie hub_local / Authorization: Bearer)、ingest トークン(X-CC-Hub-Token)。
// PIN とトークンはログに出さないこと。
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Store } from '../store/db';

const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* 壊れた Cookie は無視 */
      }
    }
  }
  return out;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class Auth {
  private readonly hashes: Set<string>;
  private failures = 0;
  private lockoutUntil = 0;
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly pin: string,
    private readonly localToken: string,
    private readonly ingestToken: string,
  ) {
    this.hashes = new Set(store.loadAuthTokens());
  }

  /** PIN ログイン。成功ならトークン(Cookie 値)を返す */
  login(pin: unknown): { ok: true; token: string } | { ok: false; status: number; error: string } {
    if (Date.now() < this.lockoutUntil) {
      return { ok: false, status: 429, error: 'PIN 失敗回数が多すぎます。5分後に再試行してください。' };
    }
    if (this.pin && safeEqual(String(pin ?? ''), this.pin)) {
      this.failures = 0;
      const token = crypto.randomBytes(32).toString('hex');
      const h = sha256(token);
      this.hashes.add(h);
      this.store.addAuthToken(h);
      return { ok: true, token };
    }
    this.failures++;
    if (this.failures >= MAX_FAILURES) {
      this.lockoutUntil = Date.now() + LOCKOUT_MS;
      this.failures = 0;
    }
    return { ok: false, status: 401, error: 'PIN が違います' };
  }

  isAuthed(req: http.IncomingMessage): boolean {
    const cookies = parseCookies(req);
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
    if (bearer && safeEqual(bearer, this.localToken)) return true;
    if (cookies.hub_local && safeEqual(cookies.hub_local, this.localToken)) return true;
    const t = cookies.ccr_token;
    if (t) {
      const h = sha256(t);
      if (this.hashes.has(h)) {
        // 最終利用時刻は 1 時間に 1 回だけ更新
        const now = Date.now();
        if (now - (this.lastTouch.get(h) ?? 0) > 3600_000) {
          this.lastTouch.set(h, now);
          this.store.touchAuthToken(h);
        }
        return true;
      }
    }
    return false;
  }

  /** Authorization: Bearer <ローカルトークン> か(デスクトップアプリの識別に使う。Cookie は含めない) */
  isLocalBearer(req: http.IncomingMessage): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
    return !!bearer && safeEqual(bearer, this.localToken);
  }

  /** MCP: Authorization: Bearer <mcp トークン> かつ tailscale serve 経由(プロキシヘッダ付き)ではないこと */
  isMcp(req: http.IncomingMessage, mcpToken: string): boolean {
    if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers['x-forwarded-host']) return false;
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
    return !!bearer && !!mcpToken && safeEqual(bearer, mcpToken);
  }

  /** ingest: トークン一致 かつ tailscale serve 経由(プロキシヘッダ付き)ではないこと */
  isIngest(req: http.IncomingMessage): boolean {
    if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login']) return false;
    const t = req.headers['x-cc-hub-token'];
    return typeof t === 'string' && safeEqual(t, this.ingestToken);
  }
}
