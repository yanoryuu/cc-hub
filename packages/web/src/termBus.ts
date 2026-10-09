// ターミナル出力は量が多いので store に入れず、セッション ID ごとのリスナーへ直接流す。
export type TermEvent =
  | { t: 'snapshot'; data: string; cols: number; rows: number }
  | { t: 'data'; data: string }
  | { t: 'resize'; cols: number; rows: number };

type Listener = (e: TermEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export function onTerm(sid: string, fn: Listener): () => void {
  let set = listeners.get(sid);
  if (!set) {
    set = new Set();
    listeners.set(sid, set);
  }
  const s = set;
  s.add(fn);
  return () => {
    s.delete(fn);
    if (s.size === 0 && listeners.get(sid) === s) listeners.delete(sid);
  };
}

export function emitTerm(sid: string, e: TermEvent): void {
  const set = listeners.get(sid);
  if (set) for (const fn of set) fn(e);
}
