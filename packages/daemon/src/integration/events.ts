// 外部連携: セッションの status が変わったら、SSE の購読者と Webhook(署名付き POST)に知らせる
import crypto from 'node:crypto';
import type http from 'node:http';
import type { ServerMessage, SessionInfo } from '@cc-hub/shared';
import { bus } from '../bus';
import type { IntegrationTokens } from './tokens';

/** 外部に見せるセッションの形(内部の細かい項目は出さない) */
export interface IntegrationSession {
  id: string;
  name: string;
  status: SessionInfo['status'];
  cwd: string;
  repoId: string | null;
  branch: string | null;
  mode: string | null;
  model: string | null;
  createdAt: number;
  lastEventAt: number | null;
  /** 最後の発言の冒頭(200 文字まで)。全文は /last-message */
  lastMessage: string | null;
  contextPct: number | null;
}

export function toIntegrationSession(s: SessionInfo): IntegrationSession {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    cwd: s.cwd,
    repoId: s.repoId ?? null,
    branch: s.branch ?? null,
    mode: s.mode ?? null,
    model: s.model ?? null,
    createdAt: s.createdAt,
    lastEventAt: s.lastEventAt ?? null,
    lastMessage: s.lastMessage ?? null,
    contextPct: s.contextPct ?? null,
  };
}

export interface StatusEvent {
  type: 'session.status';
  id: string;
  at: number;
  previousStatus: SessionInfo['status'] | null;
  session: IntegrationSession;
}

const WEBHOOK_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 25_000;

export type WebhookPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export class IntegrationEvents {
  private readonly last = new Map<string, SessionInfo['status']>();
  private readonly clients = new Set<http.ServerResponse>();
  private readonly onState = (msg: ServerMessage) => this.handle(msg);
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tokens: IntegrationTokens,
    initial: SessionInfo[],
    private readonly post: WebhookPost = (url, init) => fetch(url, init),
  ) {
    for (const s of initial) this.last.set(s.id, s.status);
    bus.on('state', this.onState);
  }

  dispose(): void {
    bus.off('state', this.onState);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private handle(msg: ServerMessage): void {
    if (msg.t === 'session.remove') {
      this.last.delete(msg.id);
      return;
    }
    if (msg.t !== 'session.upsert') return;
    const s = msg.session;
    const prev = this.last.get(s.id) ?? null;
    if (prev === s.status) return;
    this.last.set(s.id, s.status);
    this.emit({ type: 'session.status', id: crypto.randomUUID(), at: Date.now(), previousStatus: prev, session: toIntegrationSession(s) });
  }

  private emit(ev: StatusEvent): void {
    const chunk = `event: ${ev.type}\nid: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(chunk);
    for (const t of this.tokens.webhookTargets()) void this.deliver(t, ev);
  }

  private async deliver(t: { name: string; url: string; secret: string }, ev: StatusEvent): Promise<void> {
    const body = JSON.stringify(ev);
    const sig = crypto.createHmac('sha256', t.secret).update(body).digest('hex');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.post(t.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'cc-hub-integration',
            'X-CC-Hub-Event': ev.type,
            'X-CC-Hub-Delivery': ev.id,
            'X-CC-Hub-Signature-256': `sha256=${sig}`,
          },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (r.ok) return;
        if (r.status < 500) {
          console.warn(`[integration] Webhook「${t.name}」が ${r.status} を返しました`);
          return;
        }
      } catch {
        /* つながらない / 時間切れ → 1 回だけやり直す */
      }
    }
    console.warn(`[integration] Webhook「${t.name}」に送れませんでした`);
  }

  /** SSE の購読を始める(最初に今のセッション一覧を hello で送る) */
  subscribe(req: http.IncomingMessage, res: http.ServerResponse, sessions: SessionInfo[]): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ sessions: sessions.map(toIntegrationSession) })}\n\n`);
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) c.write(': ping\n\n');
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }
  }

  get subscribers(): number {
    return this.clients.size;
  }
}
