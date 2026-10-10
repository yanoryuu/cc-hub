// 通知イベント → 通知の種類(NotifyTopic)の対応と、チャンネルごとの絞り込み・間引き・抑制の判定(純粋関数 / 小さな状態)。
import type { NotifyEvent, NotifySettings, NotifyTopic } from '@cc-hub/shared';
import type { NotifyMeta } from './emit';

export const ALL_TOPICS: NotifyTopic[] = [
  'approval',
  'input',
  'error',
  'pr_ci_failed',
  'pr_review',
  'pr_merged',
  'deploy_request',
  'deploy_done',
  'test',
];

/** PR の通知のタイトル(github/pr.ts の diffPrEvents)から種類を決める */
export function prTopic(title: string): NotifyTopic | null {
  if (/CI/.test(title) && /失敗/.test(title)) return 'pr_ci_failed';
  if (/マージ/.test(title)) return 'pr_merged';
  if (/クローズ/.test(title)) return null; // マージせずに閉じた PR は外部へは送らない
  return 'pr_review'; // 修正依頼 / 承認 / コメント
}

/** 通知の種類。外部(Windows / Discord)へ送らないものは null */
export function topicOf(ev: NotifyEvent, meta: NotifyMeta = {}): NotifyTopic | null {
  if (meta.topic !== undefined) return meta.topic;
  switch (ev.kind) {
    case 'approval':
      return 'approval';
    case 'input':
      return 'input';
    case 'error':
      return 'error';
    case 'pr':
      return prTopic(ev.title);
    case 'deploy':
      return /申請/.test(ev.title) ? 'deploy_request' : 'deploy_done';
    default:
      return null; // 'done' など
  }
}

/** アプリが「どのセッションを前面で表示しているか」(POST /api/client/focus) */
export interface FocusState {
  /** 表示中のセッション。不明なら null */
  sessionId: string | null;
  /** ウィンドウ(タブ)が前面か */
  focused: boolean;
  at: number;
  /** 最後にユーザーが画面を操作した時刻(クリック・キー入力など。前面になった時も含む) */
  activeAt?: number;
}

/** 表示中とみなす最長時間(報告が途絶えたクライアントの状態を信じ続けない) */
export const FOCUS_TTL_MS = 30 * 60_000;
/** Discord を止めるのは、表示中かつこの時間内に操作があったときだけ(画面を開いたまま席を離れても届くように) */
export const ACTIVE_TTL_MS = 2 * 60_000;

export interface RouteInput {
  event: NotifyEvent;
  topic: NotifyTopic | null;
  repoId: string | null;
  settings: NotifySettings;
  focus: FocusState | null;
  /** デスクトップアプリが WS で接続中か */
  desktopConnected: boolean;
  now: number;
}

export interface RouteDecision {
  /** Windows 通知: 'app' = デスクトップアプリに出させる / 'daemon' = デーモンが自分で出す / null = 出さない */
  windows: 'app' | 'daemon' | null;
  /** 送る Discord の送信先 ID */
  discord: string[];
  /** 送らなかった理由(ログ / テスト用) */
  skipped: string | null;
}

/** 前面で表示中のセッションか(suppressWhenViewing 用) */
export function isViewing(focus: FocusState | null, sessionId: string, now: number): boolean {
  return !!focus && !!sessionId && focus.focused && focus.sessionId === sessionId && now - focus.at < FOCUS_TTL_MS;
}

/** 表示中で、しかも最近操作している(= 画面の前にいる)か */
export function isAttending(focus: FocusState | null, sessionId: string, now: number): boolean {
  const at = focus?.activeAt;
  return isViewing(focus, sessionId, now) && at != null && now - at < ACTIVE_TTL_MS;
}

/**
 * 通知の振り分け。throttle は呼び出し側の Throttle で先に判定する(ここでは種類・リポジトリ・表示中の抑制のみ)。
 * 'test' はテスト送信用で、ここでは通常の通知として扱わない
 */
export function route(r: RouteInput): RouteDecision {
  const none = (skipped: string): RouteDecision => ({ windows: null, discord: [], skipped });
  if (!r.topic) return none('対象外の種類');
  const s = r.settings;
  // 表示中の抑制: Windows は表示中なら止める。Discord は画面の前にいる(最近操作した)ときだけ止める
  const viewing = s.windows.suppressWhenViewing && isViewing(r.focus, r.event.sessionId, r.now);
  const attending = viewing && isAttending(r.focus, r.event.sessionId, r.now);
  if (attending) return none('表示中のセッション');
  let windows: RouteDecision['windows'] = null;
  if (!viewing && s.windows.enabled && s.windows.topics.includes(r.topic)) windows = r.desktopConnected ? 'app' : 'daemon';
  const discord = s.discord
    .filter((t) => t.enabled && t.topics.includes(r.topic!))
    .filter((t) => t.repoIds.length === 0 || (!!r.repoId && t.repoIds.some((x) => x.toLowerCase() === r.repoId!.toLowerCase())))
    .map((t) => t.id);
  if (!windows && !discord.length) return none(viewing ? '表示中のセッション' : '送信先なし');
  return { windows, discord, skipped: null };
}

/** 同じセッション(PR)・同じ種類の通知の間引き */
export class Throttle {
  private readonly last = new Map<string, number>();

  /** 送ってよければ true(時刻を記録する)。seconds <= 0 なら常に true */
  allow(key: string, seconds: number, now: number): boolean {
    if (seconds <= 0) return true;
    const prev = this.last.get(key);
    if (prev != null && now - prev < seconds * 1000) return false;
    this.last.set(key, now);
    // 古いものを掃除
    if (this.last.size > 2000) {
      for (const [k, t] of this.last) if (now - t > 3600_000) this.last.delete(k);
    }
    return true;
  }
}

export function throttleKey(ev: NotifyEvent, topic: NotifyTopic): string {
  // セッションも PR も無い通知(ユーザーからのアップロードなど)はタイトル(サーバー名を含む)で分ける
  return `${ev.sessionId || ev.prId || `t:${ev.title}`}|${topic}`;
}
