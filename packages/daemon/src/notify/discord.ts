// Discord への通知(Webhook)。
// - URL の検証: 本番は https://discord.com/api/webhooks/... と https://discordapp.com/api/webhooks/... だけ。
//   検証用(環境変数 CC_HUB_TEST=1)に限り http://127.0.0.1:<port>/... の偽サーバーも許す
// - 埋め込み(embed)の作成: タイトル / 本文(300 文字まで)/ 種類ごとの色 / セッション・リポジトリ・PR のリンク。秘密は載せない
// - 送信: Webhook ごとに直列のキュー。429 は retry_after 秒待って再送(最大 3 回)
import type { NotifyEvent, NotifyTopic } from '@cc-hub/shared';

export const DESCRIPTION_MAX = 300;
const TITLE_MAX = 256;
const FIELD_MAX = 1024;
const SEND_TIMEOUT_MS = 10_000;
const MAX_RETRY = 3;

const PROD_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;
const TEST_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_\-/]*$/;

export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CC_HUB_TEST === '1';
}

/** Webhook URL の検証。問題があればエラーメッセージ、正しければ null */
export function validateWebhookUrl(url: unknown, testMode = isTestMode()): string | null {
  const u = String(url ?? '').trim();
  if (!u) return 'Webhook URL が空です';
  if (PROD_RE.test(u)) return null;
  if (testMode && TEST_RE.test(u)) return null;
  return 'Discord の Webhook URL(https://discord.com/api/webhooks/… )を指定してください';
}

/** 設定画面に出す伏せ字(末尾 6 文字だけ) */
export function maskWebhook(url: string): string {
  const u = String(url ?? '');
  return u ? `…${u.slice(-6)}` : '';
}

/** 本文から秘密らしいもの(Webhook URL / Bearer トークン / 長い 16 進トークン)を伏せる */
export function redact(s: string): string {
  return String(s ?? '')
    .replace(/https?:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\S+/gi, '[webhook]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [伏せ字]')
    .replace(/\b[0-9a-f]{40,}\b/gi, '[伏せ字]');
}

function clip(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 種類ごとの色 */
export function colorOf(ev: NotifyEvent, topic: NotifyTopic | null, failed = false): number {
  if (failed || topic === 'error' || topic === 'pr_ci_failed') return 0xef4444; // 赤
  switch (topic) {
    case 'approval':
    case 'deploy_request':
      return 0xf59e0b; // 橙(要対応)
    case 'input':
      return 0x3b82f6; // 青
    case 'pr_merged':
    case 'deploy_done':
      return 0x22c55e; // 緑
    case 'pr_review':
      return 0x8b5cf6; // 紫
    case 'artifact':
      return 0x14b8a6; // 青緑
    default:
      return ev.kind === 'deploy' ? 0x22c55e : 0x64748b;
  }
}

export interface EmbedContext {
  topic: NotifyTopic | null;
  sessionName?: string | null;
  repoId?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  url?: string | null;
  /** url のフィールド名(既定 "URL") */
  urlLabel?: string | null;
  /** 失敗の通知か(アップロード失敗など。色を赤にする) */
  failed?: boolean;
  /** 本文の長さの上限(既定 DESCRIPTION_MAX。アーティファクトは内容の抜粋を載せるので長め) */
  descriptionMax?: number;
}

/** Webhook に送る本文 */
export function buildPayload(ev: NotifyEvent, ctx: EmbedContext): Record<string, unknown> {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (ctx.sessionName) fields.push({ name: 'セッション', value: clip(redact(ctx.sessionName), FIELD_MAX), inline: true });
  if (ctx.repoId || ctx.branch) {
    const v = [ctx.repoId, ctx.branch].filter(Boolean).join(' / ');
    fields.push({ name: 'リポジトリ / ブランチ', value: clip(v, FIELD_MAX), inline: true });
  }
  if (ctx.prUrl && /^https:\/\/github\.com\//.test(ctx.prUrl)) fields.push({ name: 'PR', value: clip(ctx.prUrl, FIELD_MAX) });
  if (ctx.url && /^https?:\/\//.test(ctx.url)) fields.push({ name: clip(ctx.urlLabel || 'URL', 256), value: clip(ctx.url, FIELD_MAX) });
  const embed: Record<string, unknown> = {
    title: clip(redact(ev.title), TITLE_MAX),
    description: clip(redact(ev.body || ''), Math.min(4000, ctx.descriptionMax ?? DESCRIPTION_MAX)),
    color: colorOf(ev, ctx.topic, ctx.failed),
    timestamp: new Date(ev.ts || Date.now()).toISOString(),
    footer: { text: 'CC Hub' },
  };
  if (fields.length) embed.fields = fields;
  // アーティファクトはタイトルを押すとページが開くようにする
  if (ctx.topic === 'artifact' && ctx.url && /^https:\/\/claude\.ai\//.test(ctx.url)) embed.url = ctx.url;
  // @everyone などのメンションを無効にする(本文は Claude の発言を含むため)
  return { username: 'CC Hub', embeds: [embed], allowed_mentions: { parse: [] } };
}

/** 429 の待ち時間(ミリ秒)。本文の retry_after(秒)> Retry-After ヘッダ(秒)> 1 秒 */
export function retryAfterMs(body: unknown, header: string | null): number {
  const b = body as { retry_after?: unknown } | null;
  const s = Number(b?.retry_after);
  if (Number.isFinite(s) && s >= 0) return Math.min(60_000, Math.ceil(s * 1000));
  const h = header == null || header === '' ? NaN : Number(header);
  if (Number.isFinite(h) && h >= 0) return Math.min(60_000, Math.ceil(h * 1000));
  return 1000;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** 送信結果。messageId = 送ったメッセージの ID(返信の紐付けに使う) */
export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

/** Webhook ごとに直列で送る。失敗はログだけ(URL は出さない) */
export class DiscordSender {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** キューに積む。戻り値は送信結果(ok / エラー文) */
  send(key: string, url: string, payload: unknown): Promise<SendResult> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const p = prev.then(() => this.post(url, payload));
    const tail = p.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return p;
  }

  private async post(url: string, payload: unknown): Promise<SendResult> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
      try {
        // ?wait=true: 送ったメッセージ(ID)を返させる。Bot が返信を受けたとき、どのセッションの通知かを引くのに使う
        const res = await this.fetchImpl(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: ac.signal,
        });
        const text = await res.text().catch(() => '');
        if (res.status >= 200 && res.status < 300) {
          let messageId: string | undefined;
          try {
            const j = JSON.parse(text) as { id?: unknown };
            if (typeof j.id === 'string') messageId = j.id;
          } catch {
            /* 本文なし(204) */
          }
          return { ok: true, messageId };
        }
        if (res.status === 429 && attempt < MAX_RETRY) {
          let j: unknown = null;
          try {
            j = JSON.parse(text);
          } catch {
            /* 本文なし */
          }
          await this.sleep(retryAfterMs(j, res.headers.get('retry-after')));
          continue;
        }
        return { ok: false, error: `Discord が ${res.status} を返しました` };
      } catch (e) {
        return { ok: false, error: `Discord に送れませんでした: ${(e as Error).name === 'AbortError' ? 'タイムアウト' : (e as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
