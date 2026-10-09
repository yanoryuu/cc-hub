// セッションの操作面: ターミナル + クイックキー + 入力バー(読み取り専用セッションは情報表示のみ)
import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { ApprovalBanner } from './Approval';
import { ReleaseBanner } from './ReleaseBanner';
import { StatusBadge, toolText } from './common';
import { sessionApi } from '../api';
import { fmtElapsed, readLocal, useNow, writeLocal } from '../util';

const QUICK_KEYS: { label: string; title?: string; key?: string; cmd?: string; scroll?: -1 | 1 }[] = [
  { label: '▲上', title: '上へスクロール', scroll: -1 },
  { label: '▼下', title: '下へスクロール', scroll: 1 },
  { label: 'Enter', key: '\r' },
  { label: 'Esc', key: '\x1b' },
  { label: '↑', key: '\x1b[A' },
  { label: '↓', key: '\x1b[B' },
  { label: 'Tab', key: '\t' },
  { label: '⇧Tab', title: 'Shift+Tab(モード切替)', key: '\x1b[Z' },
  { label: 'Ctrl+C', key: '\x03' },
  { label: '1', key: '1' },
  { label: '2', key: '2' },
  { label: '3', key: '3' },
  { label: '/compact', cmd: '/compact' },
  { label: '/clear', cmd: '/clear' },
  { label: '/model', cmd: '/model' },
  { label: '/context', cmd: '/context' },
  { label: '/cost', cmd: '/cost' },
  { label: '/resume', cmd: '/resume' },
  { label: '/help', cmd: '/help' },
];

function useFontSize(): [number, (d: number) => void] {
  const [size, setSize] = useState(() => {
    const def = window.matchMedia('(min-width: 900px)').matches ? '13' : '12';
    const n = parseInt(readLocal('cchub_font', def), 10);
    return Number.isFinite(n) ? n : 13;
  });
  const change = (d: number) =>
    setSize((s) => {
      const next = Math.max(8, Math.min(24, s + d));
      writeLocal('cchub_font', String(next));
      return next;
    });
  return [size, change];
}

export function QuickKeys({ session, termRef }: { session: SessionInfo; termRef: React.RefObject<TerminalHandle> }) {
  return (
    <div className="quick-keys" role="toolbar" aria-label="クイックキー">
      {QUICK_KEYS.map((q) => (
        <button
          key={q.label}
          className="qk"
          title={q.title}
          onClick={() => {
            if (q.scroll) {
              const t = termRef.current;
              if (t) t.scroll(q.scroll * t.pageLines());
            } else if (q.key !== undefined) {
              sessionApi.input(session.id, q.key).catch(() => {});
            } else if (q.cmd) {
              sessionApi.input(session.id, q.cmd, true).catch(() => {});
            }
          }}
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}

export function InputBar({
  session,
  desktop,
  onSent,
}: {
  session: SessionInfo;
  desktop: boolean;
  onSent?: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 高さを内容に合わせる(最大 160px)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // border-box なので枠線 2px 分を足す(足さないとスクロールバーが出る)
    ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
  }, [text]);

  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await sessionApi.input(session.id, v, true);
      setText('');
      onSent?.();
    } catch {
      /* 失敗時は入力を残す */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="input-bar">
      <textarea
        ref={taRef}
        rows={1}
        value={text}
        placeholder={desktop ? '指示を入力(Enter で送信 / Shift+Enter で改行)' : '指示を入力'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // デスクトップ: Enter 送信 / Shift+Enter 改行。IME 変換中の Enter は無視
          if (desktop && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary send-btn" disabled={busy || !text.trim()} onClick={() => void send()}>
        送信
      </button>
    </div>
  );
}

/** 外部セッション(読み取り専用)の情報表示 */
function ReadOnlyView({ session }: { session: SessionInfo }) {
  const now = useNow(1000);
  return (
    <div className="readonly-view">
      <div className="ro-note">外部で起動されたセッションです(読み取り専用)。ターミナルは表示できません。</div>
      <dl className="kv">
        <dt>状態</dt>
        <dd>
          <StatusBadge status={session.status} />
        </dd>
        <dt>実行中のツール</dt>
        <dd className="mono">
          {session.currentTool ? (
            <>
              {toolText(session)}{' '}
              <span className="muted">({fmtElapsed(now - session.currentTool.since)})</span>
            </>
          ) : (
            <span className="muted">なし</span>
          )}
        </dd>
        <dt>直近のメッセージ</dt>
        <dd className="ro-msg">{session.lastMessage || <span className="muted">なし</span>}</dd>
      </dl>
    </div>
  );
}

export function SessionPane({
  session,
  desktop,
  header,
}: {
  session: SessionInfo;
  desktop: boolean;
  /** 上部に置くヘッダー(デスクトップ / モバイルで異なる) */
  header: (fontCtl: React.ReactNode) => React.ReactNode;
}) {
  const termRef = useRef<TerminalHandle>(null);
  const [fontSize, changeFont] = useFontSize();
  const live = session.managed && session.status !== 'stopped';

  const fontCtl = session.managed ? (
    <span className="font-ctl">
      <button className="icon-btn" onClick={() => changeFont(-1)} title="文字を小さく" aria-label="文字を小さく">
        A−
      </button>
      <button className="icon-btn" onClick={() => changeFont(1)} title="文字を大きく" aria-label="文字を大きく">
        A+
      </button>
    </span>
  ) : null;

  return (
    <div className="session-pane">
      {header(fontCtl)}
      <ApprovalBanner session={session} />
      <ReleaseBanner session={session} />
      {session.managed ? (
        <>
          <TerminalView
            key={session.id}
            ref={termRef}
            sessionId={session.id}
            fontSize={fontSize}
            interactive={live}
          />
          {live ? (
            <>
              <QuickKeys session={session} termRef={termRef} />
              <InputBar session={session} desktop={desktop} onSent={() => termRef.current?.scrollToBottom()} />
            </>
          ) : (
            <div className="stopped-bar">
              {session.status === 'error' ? `エラーで終了しました${session.exitCode != null ? `(終了コード ${session.exitCode})` : ''}` : 'セッションは停止しています'}
              <button className="btn" onClick={() => sessionApi.control(session.id, 'restart').catch(() => {})}>
                再起動
              </button>
            </div>
          )}
        </>
      ) : (
        <ReadOnlyView session={session} />
      )}
    </div>
  );
}
