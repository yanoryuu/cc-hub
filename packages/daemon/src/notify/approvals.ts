// Discord の承認ボタン: アップロード / Firebase デプロイの「はい・いいえ」で答えられる承認を、Bot が承認用チャンネルにボタン付きで投稿する。
// - 承認待ち(pending_approval): [承認] [却下]
// - Firebase のプレビュー確認待ち(preview_ready): [本番に反映] [やめる]
// ボタンを押せるのは設定の「返信を受け付けるユーザー ID」の人だけ。CC Hub の画面で先に操作された場合は、メッセージからボタンを外して結果を書く。
// (ボタン付きのメッセージは Webhook では送れないため、Bot が投稿する)
import type { DeployJob, ServerMessage } from '@cc-hub/shared';
import type { BotInteraction } from './bot';
import { HttpError } from '../util';

export type DeployAction = 'approve' | 'reject' | 'promote' | 'cancel';

export interface DeployActions {
  approve(id: string): unknown;
  reject(id: string, reason: unknown): unknown;
  promote(id: string): unknown;
  cancel(id: string): unknown;
}

/** ボタンを出す状態 */
const ASK_STATES: DeployJob['state'][] = ['pending_approval', 'preview_ready'];
const PREFIX = 'cchub:deploy:';
/** テスト送信のボタン(押しても何もしない) */
const TEST_PREFIX = 'test-';
const TEST_TEXT = '**承認ボタンのテスト**: CC Hub の設定から送ったテストです。押しても何も起きません。';

const STATE_LABEL: Record<DeployJob['state'], string> = {
  pending_approval: '承認待ち',
  planning: '準備中',
  ready: '確認待ち',
  uploading: '送信中',
  preview_ready: 'プレビュー確認待ち',
  done: '完了',
  failed: '失敗',
  rejected: '却下',
  cancelled: '中止',
};

const ACTION_DONE: Record<DeployAction, string> = {
  approve: '✅ 承認しました',
  reject: '⛔ 却下しました',
  promote: '🚀 本番への反映を始めました',
  cancel: '⏹ やめました',
};

export function customId(action: DeployAction, jobId: string): string {
  return `${PREFIX}${action}:${jobId}`;
}

export function parseCustomId(s: string): { action: DeployAction; jobId: string } | null {
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const i = rest.indexOf(':');
  const action = rest.slice(0, i) as DeployAction;
  const jobId = rest.slice(i + 1);
  if (i < 0 || !jobId || !['approve', 'reject', 'promote', 'cancel'].includes(action)) return null;
  return { action, jobId };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 承認のメッセージの本文(ボタンを除く) */
export function cardText(j: DeployJob): string {
  const who = j.requestedBy.kind === 'claude' ? `Claude${j.requestedBy.sessionName ? `(${j.requestedBy.sessionName})` : ''}` : 'あなた';
  const lines: string[] = [];
  if (j.state === 'preview_ready' && j.firebase) {
    lines.push(`**プレビューを確認して本番に反映**: ${j.firebase.projectId}`);
    if (j.firebase.previewUrl) lines.push(`プレビュー: ${j.firebase.previewUrl}`);
    const others = j.firebase.targets.filter((t) => t !== 'hosting');
    if (others.length) lines.push(`本番に反映するときに ${others.join(', ')} もデプロイします`);
  } else if (j.firebase) {
    lines.push(`**Firebase デプロイの承認**: ${j.firebase.projectId}`);
    lines.push(`対象: ${j.firebase.targets.join(', ')}${j.firebase.preview && j.firebase.targets.includes('hosting') ? '(Hosting はまずプレビュー URL に公開)' : ''}`);
  } else {
    lines.push(`**アップロードの承認**: ${j.serverName}`);
    lines.push(`送るフォルダ: ${j.localDir}`);
  }
  lines.push(`申請: ${who}`);
  if (j.note) lines.push(`理由: ${clip(j.note, 1200)}`);
  return lines.join('\n');
}

/** 状態に合わせたボタン */
export function buttons(j: DeployJob): unknown[] {
  const b = (action: DeployAction, label: string, style: number) => ({ type: 2, style, label, custom_id: customId(action, j.id) });
  const row =
    j.state === 'preview_ready'
      ? [b('promote', '本番に反映', 3), b('cancel', 'やめる', 2)]
      : [b('approve', '承認', 3), b('reject', '却下', 4)];
  return [{ type: 1, components: row }];
}

export interface ApprovalDeps {
  /** Bot が接続中で、承認用チャンネルが設定されていれば その ID('' = 出さない) */
  channelId: () => string;
  allowed: (userId: string) => boolean;
  post: (channelId: string, body: Record<string, unknown>) => Promise<string>;
  edit: (channelId: string, messageId: string, body: Record<string, unknown>) => Promise<void>;
  respond: (i: BotInteraction, type: 4 | 7, data: Record<string, unknown>) => Promise<void>;
  /** 投稿したメッセージを申請したセッションに紐付ける(返信・スレッドでそのセッションに質問できる) */
  remember?: (messageId: string, sessionId: string) => void;
}

interface Posted {
  channelId: string;
  messageId: string;
  /** ボタンを出したときの状態 */
  state: DeployJob['state'];
  /** Discord のボタンで操作済み(画面の更新で上書きしない) */
  handled: boolean;
}

export class DeployApprovals {
  private actions: DeployActions | null = null;
  private readonly posted = new Map<string, Posted>();
  private readonly posting = new Set<string>();

  constructor(private readonly d: ApprovalDeps) {}

  setActions(a: DeployActions): void {
    this.actions = a;
  }

  /** bus の 'state'。deploy.upsert を見て、ボタンを出す / 外す */
  onState(msg: ServerMessage): void {
    if (msg.t !== 'deploy.upsert') return;
    const j = msg.deploy;
    const p = this.posted.get(j.id);
    if (ASK_STATES.includes(j.state)) {
      if (p?.state === j.state) return;
      void this.post(j);
    } else if (p?.handled) {
      if (['done', 'failed', 'rejected', 'cancelled'].includes(j.state)) this.posted.delete(j.id);
    } else if (p && p.state !== j.state) {
      // CC Hub の画面で操作された / 終わった → ボタンを外して結果を書く
      this.posted.delete(j.id);
      void this.d
        .edit(p.channelId, p.messageId, { content: `${cardText({ ...j, state: p.state })}\n→ ${STATE_LABEL[j.state]}(CC Hub で操作)`, components: [] })
        .catch((e) => console.warn(`[bot] 承認のメッセージを更新できません: ${(e as Error).message}`));
    }
  }

  private async post(j: DeployJob): Promise<void> {
    const ch = this.d.channelId();
    if (!ch || this.posting.has(j.id)) return;
    this.posting.add(j.id);
    try {
      const old = this.posted.get(j.id);
      // プレビューの確認に進んだら、承認のメッセージのボタンは外す
      if (old && !old.handled) await this.d.edit(old.channelId, old.messageId, { components: [] }).catch(() => undefined);
      const messageId = await this.d.post(ch, { content: cardText(j), components: buttons(j) });
      this.posted.set(j.id, { channelId: ch, messageId, state: j.state, handled: false });
      if (messageId && j.requestedBy.kind === 'claude' && j.requestedBy.sessionId) this.d.remember?.(messageId, j.requestedBy.sessionId);
      console.log(`[bot] 承認のボタンを投稿しました: ${j.serverName} (${STATE_LABEL[j.state]})`);
    } catch (e) {
      console.warn(`[bot] 承認のボタンを投稿できません: ${(e as Error).message}`);
    } finally {
      this.posting.delete(j.id);
    }
  }

  /** テスト送信: 押しても何も起きない承認のメッセージを承認用チャンネルに投稿する */
  async postTest(): Promise<void> {
    const ch = this.d.channelId();
    if (!ch) throw new HttpError(409, 'Bot が接続されていないか、承認ボタンを出すチャンネル ID が設定されていません');
    const id = `${TEST_PREFIX}${Date.now()}`;
    const b = (action: DeployAction, label: string, style: number) => ({ type: 2, style, label, custom_id: customId(action, id) });
    try {
      await this.d.post(ch, { content: TEST_TEXT, components: [{ type: 1, components: [b('approve', '承認', 3), b('reject', '却下', 4)] }] });
    } catch (e) {
      throw new HttpError(502, `承認用チャンネルに投稿できませんでした(Bot にチャンネルの表示・メッセージの送信の権限があるか確認してください): ${(e as Error).message}`);
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
      // テスト送信のボタン: 何もせず、押されたことだけを書く
      if (c.jobId.startsWith(TEST_PREFIX)) {
        console.log(`[bot] ${i.userName} がテストの承認ボタン(${c.action})を押しました`);
        return await this.d.respond(i, 7, { content: `${TEST_TEXT}\n→ ${ACTION_DONE[c.action]}(テスト・${i.userName})`, components: [] });
      }
      if (!this.actions) return await ephemeral('CC Hub の準備ができていません。少し待ってからもう一度押してください。');
      const a = this.actions;
      let job: DeployJob;
      switch (c.action) {
        case 'approve':
          job = a.approve(c.jobId) as DeployJob;
          break;
        case 'reject':
          job = a.reject(c.jobId, `Discord で却下(${i.userName})`) as DeployJob;
          break;
        case 'promote':
          job = a.promote(c.jobId) as DeployJob;
          break;
        case 'cancel':
          job = a.cancel(c.jobId) as DeployJob;
          break;
      }
      const p = this.posted.get(c.jobId);
      if (p) p.handled = true;
      console.log(`[bot] ${i.userName} が Discord で ${c.action} しました: ${job.serverName}`);
      const before = p?.state ?? (c.action === 'promote' || c.action === 'cancel' ? 'preview_ready' : 'pending_approval');
      await this.d.respond(i, 7, { content: `${cardText({ ...job, state: before })}\n→ ${ACTION_DONE[c.action]}(${i.userName})`, components: [] });
    } catch (e) {
      // 状態が変わっていた(CC Hub で操作済みなど)/ 進行中のアップロードがある など
      await ephemeral(`できませんでした: ${(e as Error).message}`).catch(() => undefined);
    }
  }
}
