// 表示用のヘルパー
import { useEffect, useState } from 'react';
import type { AgentStatus, ApprovalOption, SessionStatus } from '@cc-hub/shared';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: '起動中',
  running: '実行中',
  awaiting_approval: '承認待ち',
  awaiting_input: '入力待ち',
  idle: 'アイドル',
  error: 'エラー',
  stopped: '停止',
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: '実行中',
  done: '完了',
  error: 'エラー',
};

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** プロジェクト表示名: worktree(.base / wt-01 など)は親のリポジトリ名を付ける */
export function projectLabel(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1] || p;
  if (parts.length >= 2 && (/^\./.test(last) || /^wt-\d+$/i.test(last))) return `${parts[parts.length - 2]}/${last}`;
  return last;
}

/** ミリ秒 → "1:05:09" / "5:09" / "9s" */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}s`;
}

/** リセットまでの残り時間 → "1:40" / "3日4時間" */
export function fmtUntil(ms: number): string {
  if (ms <= 0) return '0:00';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}日${h}時間`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtCost(usd: number | null): string {
  return usd == null ? '—' : `$${usd.toFixed(2)}`;
}

/** 承認オプションの送信値: 番号があればそれ、なければインデックス文字列 */
export function optionValue(opt: ApprovalOption, index: number): string {
  return opt.n && opt.n.trim() ? opt.n : String(index);
}

export function optionTone(label: string): 'approve' | 'deny' | '' {
  if (/^(yes|はい|許可|allow)/i.test(label)) return 'approve';
  if (/^(no|いいえ|拒否|deny)/i.test(label)) return 'deny';
  return '';
}

/** 一定間隔で現在時刻を返す(経過時間の表示用) */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    fn();
    return () => mq.removeEventListener('change', fn);
  }, [q]);
  return m;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function readLocal(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* プライベートモードなど */
  }
}
