// NotifyService: 通知イベント(emitNotify)を設定に従って Windows 通知 / Discord に振り分ける。
// - 種類(topic)→ チャンネルごとの絞り込み(種類・リポジトリ)→ 間引き(セッション + 種類ごとに throttleSeconds)
//   → 抑制(アプリが前面でそのセッションを表示中なら Windows / Discord とも出さない)
// - Windows: デスクトップアプリが WS 接続中(client=desktop)ならアプリに出させる(bus 'notify.desktop')。
//   未接続ならデーモンが node-notifier で出す
// - Discord: 暗号化して保存した Webhook URL を復号して送る(復号した URL は 10 分だけメモリに置く)
import type { NotifyEvent, NotifySettings, NotifyTopic, ServerMessage, SessionInfo } from '@cc-hub/shared';
import { bus } from '../bus';
import type { Store } from '../store/db';
import type { SecretBox } from '../dpapi';
import { HttpError } from '../util';
import type { NotifyMeta } from './emit';
import { DiscordSender, buildPayload, type SendResult } from './discord';
import { DiscordBot, splitMessage, type BotInteraction, type BotReply } from './bot';
import { DeployApprovals, type DeployActions } from './approvals';
import { HISTORY_TURNS, type BtwIO, type BtwRequest, type QaTurn } from './replies';
import { Throttle, route, throttleKey, topicOf, type FocusState, type RouteDecision } from './topic';
import { loadStored, mergeUpdate, toPublic, type StoredNotifySettings } from './settings';
import { nodeToaster, type Toaster } from './toast';

const SETTINGS_KEY = 'notify';
const URL_CACHE_MS = 10 * 60_000;
const MSGS_KEY = 'discord_messages';

/** Discord に送った通知(返信を受けたときにセッションと種類を引く) */
export interface SentMessage {
  sessionId: string;
  /** 送った時刻 */
  at: number;
  topic: NotifyTopic | null;
}
/** 返信を受け付ける通知の数と期間 */
const MSG_KEEP = 300;
const MSG_TTL_MS = 7 * 24 * 3600_000;

export interface NotifyDeps {
  store: Store;
  secrets: SecretBox;
  session: (id: string) => SessionInfo | undefined;
  /** デスクトップアプリの WS 接続数 */
  desktopClients: () => number;
  toaster?: Toaster;
  sender?: DiscordSender;
}

export class NotifyService {
  private settings: StoredNotifySettings;
  private readonly throttle = new Throttle();
  private focus: FocusState | null = null;
  private readonly urlCache = new Map<string, { url: string; enc: string; at: number }>();
  private readonly toaster: Toaster;
  private readonly sender: DiscordSender;
  private readonly bot: DiscordBot;
  private replyHandler: ((req: BtwRequest, io: BtwIO) => Promise<string | null>) | null = null;
  /** Discord に送った通知のメッセージ ID → セッション(古い順) */
  private readonly msgs = new Map<string, SentMessage>();
  /** スレッド(なければ通知)ごとのそれまでのやり取り。続けての質問に渡す(再起動で消える) */
  private readonly threads = new Map<string, QaTurn[]>();
  /** 直近の振り分け結果(検証・デバッグ用。GET /api/notify/settings?debug=1 で返す) */
  readonly recent: { ts: number; title: string; topic: NotifyTopic | null; decision: RouteDecision | { skipped: string } }[] = [];
  private readonly approvals: DeployApprovals;
  private statusText: (() => string) | null = null;
  private readonly onState = (msg: ServerMessage) => this.approvals.onState(msg);
  private readonly onNotify = (ev: NotifyEvent, meta: NotifyMeta) => {
    this.dispatch(ev, meta ?? {}).catch((e) => console.warn(`[notify] 振り分けに失敗: ${(e as Error).message}`));
  };

  constructor(private readonly d: NotifyDeps) {
    this.settings = loadStored(d.store.getSetting(SETTINGS_KEY));
    this.toaster = d.toaster ?? nodeToaster;
    this.sender = d.sender ?? new DiscordSender();
    this.bot = new DiscordBot((r) => void this.onBotReply(r));
    this.approvals = new DeployApprovals({
      channelId: () => (this.settings.bot.enabled && this.bot.connected() ? this.settings.bot.approvalChannelId : ''),
      allowed: (userId) => this.settings.bot.allowedUserIds.includes(userId),
      post: (ch, body) => this.bot.post(ch, body),
      edit: (ch, id, body) => this.bot.edit(ch, id, body),
      respond: (i, type, data) => this.bot.respond(i, type, data),
      // 承認ボタンのメッセージも、返信・スレッドで申請したセッションに質問できるようにする
      remember: (messageId, sessionId) => this.remember(messageId, sessionId, 'deploy_request'),
    });
    this.bot.onInteraction = (i) => void this.onInteraction(i);
    this.loadMessages();
    bus.on('notify', this.onNotify);
    bus.on('state', this.onState);
    void this.applyBot();
  }

  stop(): void {
    bus.off('notify', this.onNotify);
    bus.off('state', this.onState);
    this.bot.stop();
  }

  /** アップロードの承認ボタンで呼ぶ操作(main で DeployService をつなぐ) */
  setDeployActions(a: DeployActions): void {
    this.approvals.setActions(a);
  }

  /** Discord の /status で返す文章(main でつなぐ) */
  setStatusProvider(fn: () => string): void {
    this.statusText = fn;
  }

  private async onInteraction(i: BotInteraction): Promise<void> {
    if (i.kind === 'button') return this.approvals.onInteraction(i);
    if (i.command !== 'status') return;
    try {
      if (!this.settings.bot.allowedUserIds.includes(i.userId)) {
        return await this.bot.respond(i, 4, { content: `このユーザー(ID: ${i.userId})は使えません。CC Hub の設定で「返信を受け付けるユーザー ID」に追加してください。`, flags: 64 });
      }
      await this.bot.respond(i, 4, { content: splitMessage(this.statusText?.() ?? '準備中です')[0] });
    } catch (e) {
      console.warn(`[bot] /status に答えられません: ${(e as Error).message}`);
    }
  }

  // ================================================================ 設定
  getSettings(): NotifySettings {
    const s = toPublic(this.settings);
    if (s.bot) s.bot.status = this.bot.status();
    return s;
  }

  async putSettings(body: unknown): Promise<NotifySettings> {
    const next = await mergeUpdate(this.settings, body, (p) => this.d.secrets.protect(p));
    this.settings = next;
    this.d.store.setSetting(SETTINGS_KEY, next);
    // 消えた / 変わった送信先の復号キャッシュを捨てる
    for (const [id, c] of this.urlCache) if (!next.discord.some((t) => t.id === id && t.webhookEnc === c.enc)) this.urlCache.delete(id);
    await this.applyBot();
    return this.getSettings();
  }

  // ================================================================ Discord Bot(通知への質問)
  /** 質問に答える関数(main で ReplyRouter をつなぐ)。戻り値は答え(スレッドのやり取りとして覚える) */
  setReplyHandler(fn: (req: BtwRequest, io: BtwIO) => Promise<string | null>): void {
    this.replyHandler = fn;
  }

  /** 設定に合わせて Bot を接続 / 切断する */
  private async applyBot(): Promise<void> {
    const b = this.settings.bot;
    if (!b.enabled || !b.tokenEnc) {
      this.bot.stop();
      return;
    }
    try {
      this.bot.start(await this.d.secrets.unprotect(b.tokenEnc));
    } catch (e) {
      this.bot.stop();
      console.warn(`[bot] トークンを復号できません: ${(e as Error).message}`);
    }
  }

  /**
   * 人が書いたメッセージ。対象は次の 2 つだけ(それ以外は無視):
   * - 通知(承認ボタンのメッセージを含む)から作ったスレッドへの書き込み(スレッドの ID = 通知のメッセージ ID)
   * - 通知への返信 → その通知からスレッドを作り、答えはスレッドに書く(作れなければ返信で答える)
   */
  private async onBotReply(r: BotReply): Promise<void> {
    // スラッシュコマンドが使えない場合のために、「/status」「!status」だけの書き込みにも答える
    if (/^[/!]status$/i.test(r.content) && this.settings.bot.allowedUserIds.includes(r.authorId)) {
      await this.bot.reply(r.channelId, r.messageId, this.statusText?.() ?? '準備中です').catch(() => undefined);
      return;
    }
    const inThread = this.msgs.has(r.channelId);
    const notifId = inThread ? r.channelId : r.refMessageId;
    const m = notifId ? this.msgs.get(notifId) : undefined;
    if (!m || !notifId) return;
    const replyInPlace = (text: string) => this.bot.reply(r.channelId, r.messageId, text);
    if (!this.settings.bot.allowedUserIds.includes(r.authorId)) {
      console.warn(`[bot] 許可されていないユーザーからの質問を無視しました: ${r.authorName} (${r.authorId})`);
      await replyInPlace(
        `このユーザー(ID: ${r.authorId})からの質問は受け付けていません。CC Hub の 設定 → 通知 → Discord Bot の「返信を受け付けるユーザー ID」に追加してください。`,
      ).catch(() => undefined);
      return;
    }
    if (!this.replyHandler) return;
    let threadId: string | null = inThread ? r.channelId : null;
    if (!threadId) {
      const name = this.d.session(m.sessionId)?.name ?? 'セッション';
      threadId = await this.bot.startThread(r.channelId, notifId, `${name} への質問`);
    }
    const io: BtwIO = threadId
      ? { send: (text) => this.bot.sendText(threadId!, text), typing: () => this.bot.typing(threadId!) }
      : { send: replyInPlace, typing: () => this.bot.typing(r.channelId) };
    const key = threadId ?? notifId;
    const history = this.threads.get(key) ?? [];
    try {
      const answer = await this.replyHandler({ sessionId: m.sessionId, content: r.content, authorName: r.authorName, history }, io);
      if (answer) {
        this.threads.set(key, [...history, { q: r.content, a: answer }].slice(-HISTORY_TURNS));
        // 古いスレッドのやり取りは捨てる
        if (this.threads.size > 200) this.threads.delete(this.threads.keys().next().value!);
      }
    } catch (e) {
      console.warn(`[bot] 質問の処理に失敗: ${(e as Error).message}`);
    }
  }

  /** 送った通知のメッセージ ID → セッション(再起動後も返信できるように保存する) */
  private remember(messageId: string, sessionId: string, topic: NotifyTopic): void {
    const now = Date.now();
    this.msgs.set(messageId, { sessionId, at: now, topic });
    for (const [k, v] of this.msgs) {
      if (this.msgs.size <= MSG_KEEP && now - v.at < MSG_TTL_MS) break;
      this.msgs.delete(k);
    }
    this.d.store.setSetting(MSGS_KEY, [...this.msgs].map(([id, v]) => ({ id, ...v })));
  }

  private loadMessages(): void {
    const raw = this.d.store.getSetting(MSGS_KEY);
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const x of raw) {
      if (x && typeof x.id === 'string' && typeof x.sessionId === 'string' && now - Number(x.at) < MSG_TTL_MS) {
        this.msgs.set(x.id, { sessionId: x.sessionId, at: Number(x.at), topic: typeof x.topic === 'string' ? x.topic : null });
      }
    }
  }

  // ================================================================ 表示中のセッション(抑制用)
  /** POST /api/client/focus {sessionId?, focused?, active?}。指定された項目だけ更新する。active = 画面を操作した */
  setFocus(body: any): FocusState {
    const now = Date.now();
    const cur = this.focus ?? { sessionId: null, focused: false, at: 0 };
    const next: FocusState = { ...cur, at: now };
    if (body && 'sessionId' in body) next.sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (body && 'focused' in body) next.focused = body.focused === true;
    // 前面になった・セッションを開いた・操作した時を「画面の前にいる」とみなす
    if (body?.active === true || (next.focused && (!cur.focused || next.sessionId !== cur.sessionId))) next.activeAt = now;
    this.focus = next;
    return { ...next };
  }

  // ================================================================ 振り分け
  private async dispatch(ev: NotifyEvent, meta: NotifyMeta): Promise<void> {
    const topic = topicOf(ev, meta);
    const info = ev.sessionId ? this.d.session(ev.sessionId) : undefined;
    const repoId = meta.repoId ?? info?.repoId ?? (ev.prId ? ev.prId.replace(/#\d+$/, '') : null);
    const now = Date.now();
    const record = (decision: RouteDecision | { skipped: string }) => {
      this.recent.unshift({ ts: now, title: ev.title, topic, decision });
      this.recent.length = Math.min(this.recent.length, 50);
    };
    if (!topic) return record({ skipped: '対象外の種類' });
    const decision = route({
      event: ev,
      topic,
      repoId,
      settings: toPublic(this.settings),
      focus: this.focus,
      desktopConnected: this.d.desktopClients() > 0,
      now,
    });
    if (decision.skipped) return record(decision);
    // アーティファクトは 1 件ずつ別のページなので間引かない
    if (topic !== 'artifact' && !this.throttle.allow(throttleKey(ev, topic), this.settings.throttleSeconds, now)) return record({ skipped: '間引き' });
    record(decision);
    if (decision.windows) this.showWindows(ev, decision.windows);
    for (const id of decision.discord) {
      const t = this.settings.discord.find((x) => x.id === id);
      if (!t) continue;
      const payload = buildPayload(ev, {
        topic,
        sessionName: info?.name ?? meta.sessionName ?? null,
        repoId,
        branch: meta.branch ?? info?.branch ?? null,
        prUrl: meta.prUrl ?? null,
        url: meta.url ?? null,
        urlLabel: meta.urlLabel ?? null,
        failed: ev.kind === 'deploy' && /失敗/.test(ev.title),
        descriptionMax: topic === 'artifact' ? 2000 : undefined,
      });
      void this.sendDiscord(t.id, payload).then((r) => {
        if (!r.ok) console.warn(`[notify] Discord(${t.name})への送信に失敗: ${r.error}`);
        else if (r.messageId && ev.sessionId) this.remember(r.messageId, ev.sessionId, topic);
      });
    }
  }

  private showWindows(ev: NotifyEvent, via: 'app' | 'daemon'): void {
    if (via === 'app') {
      bus.emit('notify.desktop', ev);
      return;
    }
    console.log(`[notify] Windows 通知(デーモン): ${ev.title}`);
    void this.toaster({ title: ev.title, message: ev.body });
  }

  private async webhookUrl(id: string): Promise<string> {
    const t = this.settings.discord.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Discord の送信先が見つかりません');
    const c = this.urlCache.get(id);
    if (c && c.enc === t.webhookEnc && Date.now() - c.at < URL_CACHE_MS) return c.url;
    const url = await this.d.secrets.unprotect(t.webhookEnc);
    this.urlCache.set(id, { url, enc: t.webhookEnc, at: Date.now() });
    return url;
  }

  private async sendDiscord(id: string, payload: unknown): Promise<SendResult> {
    let url: string;
    try {
      url = await this.webhookUrl(id);
    } catch (e) {
      return { ok: false, error: `Webhook URL を復号できません: ${(e as Error).message}` };
    }
    return this.sender.send(id, url, payload);
  }

  // ================================================================ テスト送信
  /** POST /api/notify/test {channel, targetId?}。設定の絞り込み・間引きは無視して送る */
  async test(channel: unknown, targetId: unknown): Promise<{ ok: boolean; message: string; via?: string }> {
    const ev: NotifyEvent = {
      kind: 'done',
      sessionId: '',
      title: 'CC Hub のテスト通知',
      body: 'この通知が見えていれば設定は正しく動いています。',
      ts: Date.now(),
    };
    if (channel === 'windows') {
      const via = this.d.desktopClients() > 0 ? 'app' : 'daemon';
      this.showWindows(ev, via);
      return { ok: true, message: via === 'app' ? 'デスクトップアプリに通知を出させました' : 'デーモンから Windows 通知を出しました', via };
    }
    if (channel === 'discord') {
      const targets = typeof targetId === 'string' && targetId ? this.settings.discord.filter((t) => t.id === targetId) : this.settings.discord;
      if (!targets.length) throw new HttpError(404, 'Discord の送信先がありません');
      const errors: string[] = [];
      for (const t of targets) {
        const r = await this.sendDiscord(t.id, buildPayload(ev, { topic: 'test' }));
        if (!r.ok) errors.push(`${t.name}: ${r.error}`);
      }
      return errors.length ? { ok: false, message: errors.join(' / ') } : { ok: true, message: `${targets.length} 件の送信先に送りました` };
    }
    if (channel === 'approval') {
      await this.approvals.postTest();
      return { ok: true, message: '承認用チャンネルにテストの承認ボタンを送りました(押しても何も起きません)' };
    }
    throw new HttpError(400, "channel は 'windows' / 'discord' / 'approval' です");
  }
}
