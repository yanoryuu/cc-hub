// Discord の承認ボタン(セッション中の承認): CC Hub が起動したセッションが承認待ちになったら、
// Bot が承認用チャンネルに選択肢をボタンにして投稿する(「1. Yes」「2. Yes, and don't ask again」「3. No」など)。
// - ボタンを押せるのは設定の「返信を受け付けるユーザー ID」の人だけ
// - 押した時点で同じ承認待ちが続いているときだけ答える(別の承認に変わっていたら答えない)
// - CC Hub の画面や端末で先に答えた / 承認待ちが変わったら、メッセージからボタンを外して結果を書く
import type { Approval, ServerMessage, SessionInfo } from '@cc-hub/shared';
import type { BotInteraction } from './bot';

const PREFIX = 'cchub:appr:';
/** 選択肢が画面解析で揃うのを待つ時間(承認待ちになった直後は選択肢がまだ無いことがある) */
const SETTLE_MS = 1500;
const LABEL_MAX = 80;
/** Discord のボタンは 1 行 5 個・5 行まで */
const MAX_BUTTONS = 25;
/** 答えた直後は画面にまだ同じ承認が残っていることがあるので、同じ承認はこの間もう一度出さない */
const ANSWERED_MS = 15_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 承認待ちの中身の同一判定に使う */
export function approvalSig(a: Approval): string {
  return `${a.type}|${a.question}|${a.options.map((o) => `${o.n}.${o.label}`).join('|')}`;
}

/** ボタンにする選択肢(yn 形式は y / n) */
export function choices(a: Approval): { n: string; label: string }[] {
  if (a.type === 'yn' || a.options.length === 0) {
    return [
      { n: 'y', label: 'はい (y)' },
      { n: 'n', label: 'いいえ (n)' },
    ];
  }
  return a.options.slice(0, MAX_BUTTONS).map((o) => ({ n: o.n, label: `${o.n}. ${o.label}` }));
}

export function customId(sessionId: string, seq: number, n: string): string {
  return `${PREFIX}${seq}:${n}:${sessionId}`;
}

export function parseCustomId(s: string): { sessionId: string; seq: number; n: string } | null {
  if (!s.startsWith(PREFIX)) return null;
  const m = s.slice(PREFIX.length).match(/^(\d+):([^:]+):(.+)$/);
  return m ? { seq: Number(m[1]), n: m[2], sessionId: m[3] } : null;
}

/** ボタンの色: はい系 = 緑、いいえ系 = 赤、それ以外 = 灰 */
function styleOf(label: string, n: string): number {
  const l = label.replace(/^\d+\.\s*/, '');
  if (n === 'n' || /^(no\b|いいえ|拒否|deny|reject|cancel)/i.test(l)) return 4;
  if (n === 'y' || /^(yes\b|はい|allow|許可|approve)/i.test(l)) return 3;
  return 2;
}

export function buttons(sessionId: string, seq: number, a: Approval): unknown[] {
  const list = choices(a).map((c) => ({ type: 2, style: styleOf(c.label, c.n), label: clip(c.label, LABEL_MAX), custom_id: customId(sessionId, seq, c.n) }));
  const rows: unknown[] = [];
  for (let i = 0; i < list.length; i += 5) rows.push({ type: 1, components: list.slice(i, i + 5) });
  return rows;
}

export function cardText(s: Pick<SessionInfo, 'name' | 'currentTool'>, a: Approval): string {
  const lines = [`**承認待ち**: ${s.name}`];
  if (s.currentTool?.name) lines.push(`ツール: ${s.currentTool.name}${s.currentTool.target ? ` — ${clip(s.currentTool.target, 300)}` : ''}`);
  if (a.question) lines.push(clip(a.question, 1000));
  // ボタンの文字は 80 文字で切れるので、長い選択肢は本文にも全文を書く
  const long = a.options.filter((o) => `${o.n}. ${o.label}`.length > LABEL_MAX);
  for (const o of long) lines.push(`${o.n}. ${clip(o.label, 400)}`);
  return lines.join('\n');
}

export interface SessionApprovalDeps {
  /** Bot が接続中で、承認用チャンネルが設定されていれば その ID('' = 出さない) */
  channelId: () => string;
  allowed: (userId: string) => boolean;
  session: (id: string) => SessionInfo | undefined;
  post: (channelId: string, body: Record<string, unknown>) => Promise<string>;
  edit: (channelId: string, messageId: string, body: Record<string, unknown>) => Promise<void>;
  respond: (i: BotInteraction, type: 4 | 7, data: Record<string, unknown>) => Promise<void>;
  remember?: (messageId: string, sessionId: string) => void;
}

interface Posted {
  channelId: string;
  messageId: string;
  seq: number;
  sig: string;
  text: string;
}

export class SessionApprovals {
  private approve: ((id: string, option: string) => void) | null = null;
  private readonly posted = new Map<string, Posted>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Discord で答えた承認(セッション → 中身と時刻) */
  private readonly answered = new Map<string, { sig: string; at: number }>();
  private seq = 0;

  constructor(private readonly d: SessionApprovalDeps) {}

  /** 承認に答える関数(main で SessionManager.approve をつなぐ) */
  setApprove(fn: (id: string, option: string) => void): void {
    this.approve = fn;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** bus の 'state'。セッションの承認待ちを見て、ボタンを出す / 外す */
  onState(msg: ServerMessage): void {
    if (msg.t === 'session.remove') return this.close(msg.id, '(セッションが削除されました)');
    if (msg.t !== 'session.upsert') return;
    const s = msg.session;
    const p = this.posted.get(s.id);
    const waiting = s.managed && s.status === 'awaiting_approval' && !!s.approval;
    if (!waiting) {
      if (p) this.close(s.id, '→ 承認待ちが終わりました(CC Hub で操作)');
      return;
    }
    if (p && p.sig === approvalSig(s.approval!)) return;
    // 選択肢が揃うまで少し待ってから投稿する(待つ間に変わったら最新のものを出す)
    if (this.timers.has(s.id)) clearTimeout(this.timers.get(s.id)!);
    this.timers.set(
      s.id,
      setTimeout(() => {
        this.timers.delete(s.id);
        void this.post(s.id);
      }, SETTLE_MS),
    );
  }

  /** ボタンを外して結果を書く */
  private close(sessionId: string, note: string): void {
    const p = this.posted.get(sessionId);
    if (!p) return;
    this.posted.delete(sessionId);
    void this.d
      .edit(p.channelId, p.messageId, { content: `${p.text}\n${note}`, components: [] })
      .catch((e) => console.warn(`[bot] 承認のメッセージを更新できません: ${(e as Error).message}`));
  }

  private async post(sessionId: string): Promise<void> {
    const ch = this.d.channelId();
    const s = this.d.session(sessionId);
    if (!ch || !s || !s.managed || s.status !== 'awaiting_approval' || !s.approval) return;
    const a = s.approval;
    const sig = approvalSig(a);
    const old = this.posted.get(sessionId);
    if (old?.sig === sig) return;
    const done = this.answered.get(sessionId);
    if (done && done.sig === sig && Date.now() - done.at < ANSWERED_MS) return;
    if (old) this.close(sessionId, '→ 別の承認待ちに変わりました');
    const seq = ++this.seq;
    const text = cardText(s, a);
    try {
      const messageId = await this.d.post(ch, { content: text, components: buttons(sessionId, seq, a), allowed_mentions: { parse: [] } });
      this.posted.set(sessionId, { channelId: ch, messageId, seq, sig, text });
      if (messageId) this.d.remember?.(messageId, sessionId);
      console.log(`[bot] セッションの承認ボタンを投稿しました: ${s.name}`);
    } catch (e) {
      console.warn(`[bot] セッションの承認ボタンを投稿できません: ${(e as Error).message}`);
    }
  }

  /** ボタンが押された */
  async onInteraction(i: BotInteraction): Promise<void> {
    const c = parseCustomId(i.customId);
    if (!c) return;
    const ephemeral = (content: string) => this.d.respond(i, 4, { content, flags: 64 });
    try {
      if (!this.d.allowed(i.userId)) {
        console.warn(`[bot] 許可されていないユーザーが承認ボタンを押しました: ${i.userName} (${i.userId})`);
        return await ephemeral(`このユーザー(ID: ${i.userId})は承認できません。CC Hub の設定で「返信を受け付けるユーザー ID」に追加してください。`);
      }
      const p = this.posted.get(c.sessionId);
      const s = this.d.session(c.sessionId);
      // 古いボタン(別の承認待ちに変わった / もう答えた)は押しても答えない
      if (!p || p.seq !== c.seq || !s || s.status !== 'awaiting_approval' || !s.approval || approvalSig(s.approval) !== p.sig) {
        return await this.d.respond(i, 7, { content: `${p?.seq === c.seq ? p.text : '**承認待ち**'}\n→ この承認待ちはもう終わっています(何もしませんでした)`, components: [] });
      }
      if (!this.approve) return await ephemeral('CC Hub の準備ができていません。少し待ってからもう一度押してください。');
      const label = choices(s.approval).find((x) => x.n === c.n)?.label ?? c.n;
      this.approve(c.sessionId, c.n);
      this.posted.delete(c.sessionId);
      this.answered.set(c.sessionId, { sig: p.sig, at: Date.now() });
      console.log(`[bot] ${i.userName} が Discord で承認に答えました: ${s.name} → ${label}`);
      await this.d.respond(i, 7, { content: `${p.text}\n→ ✅ 「${clip(label, 200)}」を選びました(${i.userName})`, components: [] });
    } catch (e) {
      await ephemeral(`できませんでした: ${(e as Error).message}`).catch(() => undefined);
    }
  }
}
