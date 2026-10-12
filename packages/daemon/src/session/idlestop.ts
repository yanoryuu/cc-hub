// 使っていないセッションの自動停止: 入力待ちのまま長時間動きの無い CC Hub のセッションを止めてメモリを空ける。
// 止めるのは Claude のプロセスだけ(会話は残り、「再開」で続きから)。作業ツリーは自動解放しない(autorelease が見送る)。
// CC Hub の再起動時も、同じ条件に当たる入力待ちのセッションは再開しない。
import type { IdleStopSettings, SessionInfo, SessionStatus } from '@cc-hub/shared';

export const IDLE_STOP_KEY = 'idle_stop';
export const IDLE_STOPPED_KEY = 'idle_stopped_ids';
export const DEFAULT_IDLE_STOP: IdleStopSettings = { enabled: true, hours: 3 };
/** 自動停止の確認間隔 */
export const IDLE_CHECK_MS = 5 * 60_000;

/** 「使っていない」とみなす状態(Claude が作業を終えてユーザーの入力を待っている) */
const WAITING: SessionStatus[] = ['awaiting_input', 'idle'];

export function normalizeIdleStop(v: unknown): IdleStopSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<IdleStopSettings>;
  const hours = Number(o.hours);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_IDLE_STOP.enabled,
    hours: Number.isFinite(hours) && hours >= 0.5 && hours <= 168 ? hours : DEFAULT_IDLE_STOP.hours,
  };
}

/** 入力待ちのまま hours 以上、動き(出力・入力・承認)が無いか */
export function isIdleTooLong(s: Pick<SessionInfo, 'managed' | 'status' | 'approval' | 'lastEventAt'>, now: number, cfg: IdleStopSettings): boolean {
  if (!cfg.enabled || !s.managed || s.approval) return false;
  if (!WAITING.includes(s.status)) return false;
  return now - s.lastEventAt >= cfg.hours * 3600_000;
}
