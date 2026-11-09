// スマホのチャット表示用: 送った指示を、会話の記録(transcript)に載るまで「送信済み」としてすぐ出しておく。
// Claude が作業中に送った指示は、作業の区切りで読まれるまで記録に出てこないため
import { useSyncExternalStore } from 'react';

export interface SentMessage {
  text: string;
  at: number;
}

/** これより古い「送信済み」は出さない(記録に載らなかったもの) */
const MAX_AGE_MS = 60 * 60_000;

const store = new Map<string, SentMessage[]>();
const listeners = new Set<() => void>();
const EMPTY: SentMessage[] = [];

function emit(): void {
  for (const l of listeners) l();
}

export function addSent(sid: string, text: string): void {
  const now = Date.now();
  const list = (store.get(sid) ?? []).filter((m) => now - m.at < MAX_AGE_MS);
  store.set(sid, [...list, { text, at: now }]);
  emit();
}

/** 記録に載った分を消す */
export function dropSent(sid: string, keep: SentMessage[]): void {
  const cur = store.get(sid);
  if (!cur || cur.length === keep.length) return;
  if (keep.length) store.set(sid, keep);
  else store.delete(sid);
  emit();
}

export function useSent(sid: string): SentMessage[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => store.get(sid) ?? EMPTY,
  );
}

/** 比べるときは空白をそろえる(送るときに改行を空白にしているため) */
export function normText(s: string): string {
  // 記録側は長い発言を切って持っているので、頭の部分で比べる
  return s.replace(/\s+/g, ' ').trim().slice(0, 3000);
}

/**
 * まだ記録に載っていない「送信済み」を返す。記録の user 発言のうち、送った時刻(少しの誤差は許す)以降のものと
 * 本文が一致したら載ったとみなす(端末の時計のずれは 2 分まで許す)。同じ文を 2 回送った場合も 1 対 1 で対応させる
 */
export function unmatchedSent(sent: SentMessage[], users: { text: string; ts: number }[]): SentMessage[] {
  if (!sent.length) return sent;
  const used = new Set<number>();
  const out: SentMessage[] = [];
  for (const m of sent) {
    const t = normText(m.text);
    const idx = users.findIndex((u, i) => !used.has(i) && u.ts >= m.at - 120_000 && normText(u.text) === t);
    if (idx >= 0) used.add(idx);
    else if (Date.now() - m.at < MAX_AGE_MS) out.push(m);
  }
  return out;
}
