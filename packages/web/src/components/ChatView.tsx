// スマホのチャット表示: 端末の代わりに、会話の記録(transcript)からあなたの指示と Claude の返信だけを吹き出しで出す。
// ツールの実行(ファイルの読み書き・コマンドなど)は出さない
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { HistoryMessage, SessionInfo } from '@cc-hub/shared';
import { api, errText, pick } from '../api';
import { renderMarkdown } from '../markdown';

export interface ChatHandle {
  scrollToBottom: () => void;
}

/** 動いている間の読み直しの間隔 */
const POLL_MS = 3000;
const WORKING = new Set(['starting', 'running']);

export const ChatView = forwardRef<ChatHandle, { session: SessionInfo; fontSize: number }>(function ChatView(
  { session, fontSize },
  ref,
) {
  const [msgs, setMsgs] = useState<HistoryMessage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** 末尾付近を見ているか(見ていれば新しい発言で末尾へ追従する) */
  const atBottom = useRef(true);
  const working = WORKING.has(session.status);

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=200`);
      const all = pick<HistoryMessage[]>(r, 'messages') ?? [];
      const next = all.filter((m) => m.role !== 'tool');
      setMsgs((prev) => (prev && sameMsgs(prev, next) ? prev : next));
      setErr(null);
    } catch (e) {
      setErr(errText(e, '会話を読み込めませんでした'));
    }
  }, [session.id]);

  // 状態が変わったら(返信が終わった・承認待ちになったなど)少し待って読み直す
  useEffect(() => {
    const t = setTimeout(() => void load(), 400);
    return () => clearTimeout(t);
  }, [load, session.status, session.lastEventAt]);

  // 動いている間は定期的に読み直す
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load, working]);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
  }, []);
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

  useEffect(() => {
    if (atBottom.current) scrollToBottom();
  }, [msgs, working, scrollToBottom]);

  return (
    <div
      className="chat-view"
      ref={scroller}
      style={{ fontSize }}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {msgs === null && !err && <div className="chat-empty muted">読み込み中…</div>}
      {msgs !== null && msgs.length === 0 && (
        <div className="chat-empty muted">まだ会話がありません。下の入力欄から指示を送れます。</div>
      )}
      {msgs?.map((m, i) => (
        <div key={`${m.ts}-${i}`} className={`chat-msg ${m.role}`}>
          {m.role === 'user' ? <div className="chat-bubble">{m.text}</div> : <div className="md-body">{renderMarkdown(m.text)}</div>}
        </div>
      ))}
      {working && (
        <div className="chat-working" aria-live="polite">
          <span className="chat-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          作業中
        </div>
      )}
      {err && <div className="rp-alert error">{err}</div>}
    </div>
  );
});

function sameMsgs(a: HistoryMessage[], b: HistoryMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].ts !== b[i].ts || a[i].text !== b[i].text || a[i].role !== b[i].role) return false;
  return true;
}
