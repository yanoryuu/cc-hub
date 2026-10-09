// Usage: プラン使用率(5 時間枠 / 週次)。rate_limits はアカウント共通なので「最後に受信した値」を全体の値とする。
import type { RateWindow, Usage } from '@cc-hub/shared';
import { bus } from './bus';
import type { Store } from './store/db';

function toWindow(w: any): RateWindow | null {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  if (w.used_percentage == null || !Number.isFinite(pct)) return null;
  let resetsAt = Number(w.resets_at);
  if (!Number.isFinite(resetsAt)) resetsAt = 0;
  // resets_at は Unix 秒。念のためミリ秒で来た場合はそのまま使う
  else if (resetsAt < 1e12) resetsAt *= 1000;
  return { pct, resetsAt };
}

export class UsageTracker {
  usage: Usage | null;

  constructor(private readonly store: Store) {
    this.usage = store.getSetting<Usage>('usage');
  }

  /** statusLine の JSON から rate_limits を取り込む。片方の窓が無ければ前回値を残す */
  update(data: any): void {
    const rl = data?.rate_limits;
    if (!rl || typeof rl !== 'object') return;
    const five = toWindow(rl.five_hour);
    const seven = toWindow(rl.seven_day);
    if (!five && !seven) return;
    const prev = this.usage;
    const next: Usage = {
      fiveHour: five ?? prev?.fiveHour ?? null,
      sevenDay: seven ?? prev?.sevenDay ?? null,
      updatedAt: Date.now(),
    };
    const changed =
      !prev || JSON.stringify([prev.fiveHour, prev.sevenDay]) !== JSON.stringify([next.fiveHour, next.sevenDay]);
    this.usage = next;
    if (changed) {
      this.store.setSetting('usage', next);
      bus.state({ t: 'usage', usage: next });
    }
  }
}
