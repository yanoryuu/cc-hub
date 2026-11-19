// 外部連携(ジャービスなど)用のトークン。スコープ付きで、できることを絞る。
// 保存は <dataDir>\integrations.json。トークン本体は保存せず sha256 だけを持つ(発行時に一度だけ返す)。
// トークン・Webhook の秘密鍵はログに出さないこと。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { HttpError } from '../util';

export const INTEGRATION_SCOPES = ['sessions:start', 'state:read'] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/** 保存する形(hash / webhookSecret は API では返さない) */
interface TokenRecord {
  id: string;
  name: string;
  scopes: IntegrationScope[];
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

/** 一覧で返す形 */
export interface IntegrationTokenInfo {
  id: string;
  name: string;
  scopes: IntegrationScope[];
  createdAt: number;
  lastUsedAt: number | null;
  webhookUrl: string | null;
  /** トークンの先頭(見分け用。cch_ + 4 文字) */
  hint: string;
}

const TOKEN_PREFIX = 'cch_';
const NAME_MAX = 60;
const TOKENS_MAX = 20;

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/** Webhook の URL を検査する(http / https のみ。認証情報入りの URL は不可) */
export function checkWebhookUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2000) throw new HttpError(400, 'webhookUrl が不正です');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new HttpError(400, 'webhookUrl が URL ではありません');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'webhookUrl は http(s) の URL にしてください');
  if (u.username || u.password) throw new HttpError(400, 'webhookUrl に認証情報を含めないでください');
  return u.toString();
}

export class IntegrationTokens {
  private records: TokenRecord[] = [];
  private readonly file: string;
  private readonly touched = new Map<string, number>();

  constructor(dir: string) {
    this.file = path.join(dir, 'integrations.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { tokens?: TokenRecord[] };
      this.records = (raw.tokens ?? []).filter((r) => r && typeof r.id === 'string' && typeof r.hash === 'string');
      for (const r of this.records) r.scopes = (r.scopes ?? []).filter((s): s is IntegrationScope => (INTEGRATION_SCOPES as readonly string[]).includes(s));
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens: this.records }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private info(r: TokenRecord): IntegrationTokenInfo {
    return { id: r.id, name: r.name, scopes: [...r.scopes], createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, webhookUrl: r.webhookUrl, hint: r.id.slice(0, 4) };
  }

  list(): IntegrationTokenInfo[] {
    return this.records.map((r) => this.info(r));
  }

  /** 発行。token と webhookSecret はこのときだけ返す */
  create(body: unknown): { info: IntegrationTokenInfo; token: string; webhookSecret: string | null } {
    const b = (body ?? {}) as { name?: unknown; scopes?: unknown; webhookUrl?: unknown };
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, NAME_MAX) : '';
    if (!name) throw new HttpError(400, '名前を入れてください');
    const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes)] : [];
    if (!scopes.length || !scopes.every((s) => (INTEGRATION_SCOPES as readonly unknown[]).includes(s))) {
      throw new HttpError(400, `scopes は ${INTEGRATION_SCOPES.join(' / ')} から 1 つ以上選んでください`);
    }
    if (this.records.length >= TOKENS_MAX) throw new HttpError(400, `トークンは ${TOKENS_MAX} 個までです`);
    const webhookUrl = checkWebhookUrl(b.webhookUrl);
    // id の先頭 4 文字をトークンにも入れて、どのトークンか見分けられるようにする
    const id = crypto.randomBytes(8).toString('hex');
    const token = `${TOKEN_PREFIX}${id.slice(0, 4)}_${crypto.randomBytes(24).toString('base64url')}`;
    const webhookSecret = webhookUrl ? crypto.randomBytes(24).toString('base64url') : null;
    const rec: TokenRecord = { id, name, scopes: scopes as IntegrationScope[], hash: sha256(token), createdAt: Date.now(), lastUsedAt: null, webhookUrl, webhookSecret };
    this.records.push(rec);
    this.save();
    return { info: this.info(rec), token, webhookSecret };
  }

  /** Webhook の URL を変える(空で解除)。新しく設定したときだけ秘密鍵を作り直して返す */
  setWebhook(id: string, url: unknown): { info: IntegrationTokenInfo; webhookSecret: string | null } {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'トークンが見つかりません');
    const webhookUrl = checkWebhookUrl(url);
    const fresh = !!webhookUrl && (!r.webhookSecret || webhookUrl !== r.webhookUrl);
    r.webhookUrl = webhookUrl;
    if (!webhookUrl) r.webhookSecret = null;
    else if (fresh) r.webhookSecret = crypto.randomBytes(24).toString('base64url');
    this.save();
    return { info: this.info(r), webhookSecret: fresh ? r.webhookSecret : null };
  }

  revoke(id: string): void {
    const n = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === n) throw new HttpError(404, 'トークンが見つかりません');
    this.save();
  }

  /** Authorization: Bearer cch_... を検査する。無効なら null */
  authenticate(req: http.IncomingMessage): IntegrationTokenInfo | null {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
    if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) return null;
    const h = sha256(bearer);
    const r = this.records.find((x) => safeEqualHex(x.hash, h));
    if (!r) return null;
    // 最終利用時刻は 10 分に 1 回だけ保存する
    const now = Date.now();
    r.lastUsedAt = now;
    if (now - (this.touched.get(r.id) ?? 0) > 600_000) {
      this.touched.set(r.id, now);
      try {
        this.save();
      } catch {
        /* 保存できなくても認証は通す */
      }
    }
    return this.info(r);
  }

  /** 状態変化を Webhook で送る先(state:read を持つトークンだけ) */
  webhookTargets(): { id: string; name: string; url: string; secret: string }[] {
    return this.records
      .filter((r) => r.webhookUrl && r.webhookSecret && r.scopes.includes('state:read'))
      .map((r) => ({ id: r.id, name: r.name, url: r.webhookUrl!, secret: r.webhookSecret! }));
  }
}
