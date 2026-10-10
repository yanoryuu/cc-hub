// Discord Bot: Gateway(WebSocket)でメッセージを受け取り、通知への「返信」だけを拾う。返事は REST で送る。
// - 必要な権限: チャンネルの閲覧・メッセージの送信・メッセージ履歴の閲覧。Developer Portal で MESSAGE CONTENT INTENT を有効にする
// - トークンはログに出さない。切断されたら少しずつ間隔を空けて再接続する(トークン不正 / Intent 不足は再接続しない)
import WebSocket from 'ws';
import type { DiscordBotStatus } from '@cc-hub/shared';

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API = 'https://discord.com/api/v10';
/** GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const BOT_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
/** Discord のメッセージの上限 */
export const DISCORD_MAX = 2000;

/** 人が書いたメッセージ(通知への返信か、通知から作ったスレッドへの書き込みかは NotifyService が判断する) */
export interface BotReply {
  /** 返信先のメッセージ ID(返信でなければ null) */
  refMessageId: string | null;
  /** 書き込まれたチャンネル(スレッドならスレッドの ID = スレッドを作った元のメッセージの ID) */
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
}

/** MESSAGE_CREATE の内容を取り出す(Bot の発言は null) */
export function parseReply(d: any): BotReply | null {
  if (!d || typeof d !== 'object') return null;
  if (d.author?.bot) return null;
  if (typeof d.channel_id !== 'string' || typeof d.id !== 'string') return null;
  const ref = d.message_reference?.message_id;
  const content = typeof d.content === 'string' ? d.content.trim() : '';
  return {
    refMessageId: typeof ref === 'string' ? ref : null,
    channelId: d.channel_id,
    messageId: d.id,
    authorId: String(d.author?.id ?? ''),
    authorName: String(d.author?.global_name || d.author?.username || ''),
    content,
  };
}

/** 長い文章を Discord の上限に収まるように分ける(改行の位置で切る。最大 maxParts 件) */
export function splitMessage(text: string, max = DISCORD_MAX - 50, maxParts = 4): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < maxParts) {
    if (rest.length <= max) {
      out.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out[out.length - 1] += '\n…(長いので省略しました)';
  return out;
}

/** ボタンが押された / スラッシュコマンドが実行された(INTERACTION_CREATE) */
export interface BotInteraction {
  kind: 'button' | 'command';
  id: string;
  token: string;
  /** ボタンの custom_id(コマンドなら '') */
  customId: string;
  /** コマンド名(ボタンなら '') */
  command: string;
  userId: string;
  userName: string;
  channelId: string;
  messageId: string;
}

/** Bot が登録するスラッシュコマンド */
export const BOT_COMMANDS = [{ name: 'status', description: 'CC Hub の状況(動いているセッション・承認待ち・再起動の予約)', type: 1 }];

/** INTERACTION_CREATE からボタンの操作(type 3)/ コマンド(type 2)を取り出す(それ以外は null) */
export function parseInteraction(d: any): BotInteraction | null {
  if (!d || (d.type !== 2 && d.type !== 3) || typeof d.id !== 'string' || typeof d.token !== 'string') return null;
  const u = d.member?.user ?? d.user;
  if (!u?.id) return null;
  const button = d.type === 3;
  const customId = button ? d.data?.custom_id : '';
  const command = button ? '' : d.data?.name;
  if (typeof customId !== 'string' || typeof command !== 'string' || (!customId && !command)) return null;
  return {
    kind: button ? 'button' : 'command',
    id: d.id,
    token: d.token,
    customId,
    command,
    userId: String(u.id),
    userName: String(u.global_name || u.username || ''),
    channelId: String(d.channel_id ?? ''),
    messageId: String(d.message?.id ?? ''),
  };
}

export class DiscordBot {
  private ws: WebSocket | null = null;
  private token = '';
  private seq: number | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = 5000;
  private stopped = true;
  private _status: DiscordBotStatus = { state: 'off', user: null, error: null };
  private appId: string | null = null;
  /** スラッシュコマンドを登録済みのサーバー */
  private readonly registered = new Set<string>();

  /** ボタンが押されたとき(NotifyService が設定する) */
  onInteraction: ((i: BotInteraction) => void) | null = null;

  constructor(private readonly onReply: (r: BotReply) => void) {}

  connected(): boolean {
    return !this.stopped && this._status.state === 'connected';
  }

  status(): DiscordBotStatus {
    return { ...this._status };
  }

  /** 接続する(既に同じトークンで接続中なら何もしない) */
  start(token: string): void {
    if (!this.stopped && token === this.token) return;
    this.stop();
    this.token = token;
    this.stopped = false;
    this.retryMs = 5000;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      try {
        ws.close(1000);
      } catch {
        /* 閉じ済み */
      }
    }
    this._status = { state: 'off', user: null, error: null };
  }

  private connect(): void {
    this._status = { ...this._status, state: 'connecting', error: null };
    const ws = new WebSocket(GATEWAY);
    this.ws = ws;
    ws.on('message', (raw) => {
      let p: any;
      try {
        p = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.onPayload(ws, p);
    });
    ws.on('close', (code) => this.onClose(ws, code));
    ws.on('error', (e) => console.warn(`[bot] 接続エラー: ${e.message}`));
  }

  private send(ws: WebSocket, op: number, d: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onPayload(ws: WebSocket, p: any): void {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: {
        // Hello → 心拍を始めて Identify
        this.clearHeartbeat();
        const iv = Number(p.d?.heartbeat_interval) || 41250;
        this.heartbeat = setInterval(() => this.send(ws, 1, this.seq), iv);
        this.send(ws, 2, {
          token: this.token,
          intents: BOT_INTENTS,
          properties: { os: 'windows', browser: 'cc-hub', device: 'cc-hub' },
        });
        break;
      }
      case 1:
        this.send(ws, 1, this.seq);
        break;
      case 7: // Reconnect
      case 9: // Invalid Session
        ws.close(4000);
        break;
      case 0:
        if (p.t === 'READY') {
          const u = p.d?.user;
          this._status = { state: 'connected', user: u ? String(u.global_name || u.username || '') : null, error: null };
          this.retryMs = 5000;
          console.log(`[bot] Discord に接続しました: ${this._status.user ?? '?'}`);
          // スラッシュコマンド(/status)をサーバーごとに登録する(サーバー単位ならすぐ使えるようになる)
          this.appId = typeof p.d?.application?.id === 'string' ? p.d.application.id : null;
          for (const g of Array.isArray(p.d?.guilds) ? p.d.guilds : []) if (typeof g?.id === 'string') void this.registerCommands(g.id);
        } else if (p.t === 'GUILD_CREATE' && typeof p.d?.id === 'string') {
          void this.registerCommands(p.d.id);
        } else if (p.t === 'MESSAGE_CREATE') {
          const r = parseReply(p.d);
          if (r) this.onReply(r);
        } else if (p.t === 'INTERACTION_CREATE') {
          const i = parseInteraction(p.d);
          if (i) this.onInteraction?.(i);
        }
        break;
    }
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return;
    this.clearHeartbeat();
    this.ws = null;
    if (this.stopped) return;
    // 再接続しても直らないもの
    const fatal: Record<number, string> = {
      4004: 'トークンが正しくありません(Developer Portal で Reset Token して入れ直してください)',
      4013: 'Intent の指定が不正です',
      4014: 'MESSAGE CONTENT INTENT が無効です(Developer Portal の Bot → Privileged Gateway Intents で有効にしてください)',
    };
    if (fatal[code]) {
      this._status = { state: 'error', user: null, error: fatal[code] };
      console.warn(`[bot] 接続できません: ${fatal[code]}`);
      return;
    }
    this._status = { ...this._status, state: 'connecting', error: `切断されました (code ${code})。再接続します` };
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 120_000);
  }

  // ================================================================ REST
  private async rest(method: string, p: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API}${p}`, {
      method,
      headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Discord が ${res.status} を返しました ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** 返信する(長い文章は分けて送る。最初の 1 件だけ元のメッセージへの返信にする) */
  async reply(channelId: string, toMessageId: string, text: string): Promise<void> {
    if (this.stopped) return;
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      await this.rest('POST', `/channels/${channelId}/messages`, {
        content: parts[i],
        allowed_mentions: { parse: [] },
        ...(i === 0 ? { message_reference: { message_id: toMessageId, fail_if_not_exists: false } } : {}),
      });
    }
  }

  /** サーバーにスラッシュコマンドを登録する(上書きなので何度呼んでもよい。接続ごとに 1 回) */
  private async registerCommands(guildId: string): Promise<void> {
    if (!this.appId || this.registered.has(guildId)) return;
    this.registered.add(guildId);
    try {
      await this.rest('PUT', `/applications/${this.appId}/guilds/${guildId}/commands`, BOT_COMMANDS);
    } catch (e) {
      this.registered.delete(guildId);
      console.warn(`[bot] /status コマンドを登録できません(サーバー ${guildId}): ${(e as Error).message}`);
    }
  }

  /** 文章を投稿する(長い文章は分けて送る) */
  async sendText(channelId: string, text: string): Promise<void> {
    if (this.stopped) return;
    for (const part of splitMessage(text)) {
      await this.rest('POST', `/channels/${channelId}/messages`, { content: part, allowed_mentions: { parse: [] } });
    }
  }

  /**
   * メッセージからスレッドを作る(既にあればそのまま使う)。スレッドの ID は元のメッセージの ID と同じ。
   * 権限が無いなど作れなければ null
   */
  async startThread(channelId: string, messageId: string, name: string): Promise<string | null> {
    if (this.stopped) return null;
    try {
      const t = await this.rest('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
        name: name.slice(0, 100) || 'CC Hub',
        auto_archive_duration: 1440,
      });
      return String(t?.id ?? messageId);
    } catch (e) {
      // 160004 = このメッセージのスレッドは既にある
      if (/160004/.test((e as Error).message)) return messageId;
      console.warn(`[bot] スレッドを作れません(権限「公開スレッドの作成」が必要): ${(e as Error).message}`);
      return null;
    }
  }

  /** メッセージを投稿する(ボタンなど components 付き)。戻り値はメッセージ ID */
  async post(channelId: string, body: Record<string, unknown>): Promise<string> {
    const m = await this.rest('POST', `/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, ...body });
    return String(m?.id ?? '');
  }

  /** 投稿済みのメッセージを書き換える */
  async edit(channelId: string, messageId: string, body: Record<string, unknown>): Promise<void> {
    await this.rest('PATCH', `/channels/${channelId}/messages/${messageId}`, body);
  }

  /** ボタンの操作に応答する(3 秒以内)。type 7 = 元のメッセージを書き換える / type 4 = 新しく返す */
  async respond(i: BotInteraction, type: 4 | 7, data: Record<string, unknown>): Promise<void> {
    await this.rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type, data: { allowed_mentions: { parse: [] }, ...data } });
  }

  /** 「入力中…」を出す(10 秒ほどで消える) */
  async typing(channelId: string): Promise<void> {
    if (this.stopped) return;
    await this.rest('POST', `/channels/${channelId}/typing`).catch(() => undefined);
  }
}
