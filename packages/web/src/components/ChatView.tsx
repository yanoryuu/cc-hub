// スマホのチャット表示: 端末の代わりに、会話の記録(transcript)からあなたの指示と Claude の返信だけを吹き出しで出す。
// ツールの実行(ファイルの読み書き・コマンドなど)は出さない
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { HistoryMessage, SessionInfo } from '@cc-hub/shared';
import { api, errText, pick } from '../api';
import { renderMarkdown } from '../markdown';
import { dropSent, unmatchedSent, useSent } from '../sentMessages';

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
  const sentAll = useSent(session.id);
  const users = useMemo(() => (msgs ?? []).filter((m) => m.role === 'user'), [msgs]);
  // 記録に載るまでは「送信済み」として出しておく(作業中に送った指示は、作業の区切りまで記録に出ない)
  const sent = useMemo(() => (msgs ? unmatchedSent(sentAll, users) : sentAll), [msgs, sentAll, users]);
  useEffect(() => {
    if (msgs) dropSent(session.id, sent);
  }, [msgs, sent, session.id]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

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

  // 状態が変わったら(返信が終わった・承認待ちになったなど)・送った直後は少し待って読み直す
  useEffect(() => {
    const t = setTimeout(() => void load(), 400);
    return () => clearTimeout(t);
  }, [load, session.status, session.lastEventAt, sentAll.length]);

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
  // 自分で送ったら末尾へ
  useEffect(() => {
    if (sentAll.length) scrollToBottom();
  }, [sentAll.length, scrollToBottom]);

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
      {msgs !== null && msgs.length === 0 && !sent.length && (
        <div className="chat-empty muted">まだ会話がありません。下の入力欄から指示を送れます。</div>
      )}
      {msgs?.map((m, i) => (
        <div key={`${m.ts}-${i}`} className={`chat-msg ${m.role}`}>
          {m.role === 'user' ? <div className="chat-bubble">{m.text}</div> : <div className="md-body">{renderMarkdown(m.text)}</div>}
        </div>
      ))}
      {sent.map((m) => (
        <div key={`sent-${m.at}`} className="chat-msg user sent">
          <div className="chat-bubble">{m.text}</div>
          <div className="chat-sent-note">{working ? '送信済み · 今の作業の区切りで読まれます' : '送信済み'}</div>
        </div>
      ))}
      {working && <WorkingLine session={session} now={now} />}
      {err && <div className="rp-alert error">{err}</div>}
    </div>
  );
});

/** ツール名を、何をしているかの言葉にする */
const TOOL_WORDS: Record<string, string> = {
  Read: 'ファイルを読んでいます',
  Edit: 'ファイルを編集しています',
  MultiEdit: 'ファイルを編集しています',
  Write: 'ファイルを書いています',
  NotebookEdit: 'ノートブックを編集しています',
  Bash: 'コマンドを実行しています',
  PowerShell: 'コマンドを実行しています',
  Grep: 'コードを検索しています',
  Glob: 'ファイルを探しています',
  WebFetch: 'Web ページを読んでいます',
  WebSearch: 'Web を検索しています',
  Task: 'サブエージェントに任せています',
  Agent: 'サブエージェントに任せています',
  Skill: 'スキルを使っています',
  TodoWrite: 'やることを整理しています',
};

function toolWords(name: string): string {
  if (TOOL_WORDS[name]) return TOOL_WORDS[name];
  if (name.startsWith('mcp__')) return `${name.split('__').slice(1).join(' / ')} を使っています`;
  return `${name} を使っています`;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 作業中の表示: 今使っているツール(何をしているか)と対象、経過時間 */
function WorkingLine({ session, now }: { session: SessionInfo; now: number }) {
  const t = session.currentTool;
  const label = session.status === 'starting' ? '起動しています' : t ? (t.name === '待機' ? '待機しています' : toolWords(t.name)) : '考えています';
  return (
    <div className="chat-working" aria-live="polite">
      <span className="chat-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="chat-working-text">
        <span className="chat-working-label">
          {label}
          {t && <span className="chat-working-time"> · {elapsed(now - t.since)}</span>}
        </span>
        {t?.target && <span className="chat-working-target mono">{t.target}</span>}
      </span>
    </div>
  );
}

function sameMsgs(a: HistoryMessage[], b: HistoryMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].ts !== b[i].ts || a[i].text !== b[i].text || a[i].role !== b[i].role) return false;
  return true;
}
