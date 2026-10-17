// セッションの操作面: ターミナル + 指示の入力欄(Composer)+ クイックキー(畳める)
// 外部 / PowerShell に移したセッションは、説明と「引き継ぐ」ボタン + 引き継いで送る入力欄
import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { ApprovalBanner } from './Approval';
import { ReleaseBanner } from './ReleaseBanner';
import { Composer } from './Composer';
import { ConflictDialog, TakeoverPanel, useTakeover } from './Handoff';
import { sessionApi } from '../api';
import { flushPendingSend, usePendingSend } from '../composer';
import { useSessionWorktree } from '../repo';
import { readLocal, writeLocal } from '../util';

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

export function useFontSize(): [number, (d: number) => void] {
  const [size, setSize] = useState(() => {
    const def = window.matchMedia('(min-width: 900px)').matches ? '14' : '13';
    // 旧既定(13 / 12)のままの人は新しい既定に上げる(読みやすさの改善。A−/A+ で変えた値はそのまま)
    const saved = readLocal('cchub_font2', '') || def;
    const n = parseInt(saved, 10);
    return Number.isFinite(n) ? n : 14;
  });
  const change = (d: number) =>
    setSize((s) => {
      const next = Math.max(9, Math.min(26, s + d));
      writeLocal('cchub_font2', String(next));
      return next;
    });
  return [size, change];
}

export function QuickKeys({ session, termRef }: { session: SessionInfo; termRef: React.RefObject<TerminalHandle> }) {
  return (
    <div className="quick-keys" role="toolbar" aria-label="クイックキー(ターミナルに直接送るキー)">
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

/** クイックキーの開閉(既定: デスクトップは閉じる / スマホは開く。開閉は保存) */
function useQuickKeysOpen(desktop: boolean): [boolean, () => void] {
  const key = desktop ? 'cchub_qk_desk' : 'cchub_qk_mob';
  const [open, setOpen] = useState(() => readLocal(key, desktop ? '0' : '1') === '1');
  return [
    open,
    () =>
      setOpen((v) => {
        writeLocal(key, v ? '0' : '1');
        return !v;
      }),
  ];
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
  const [qkOpen, toggleQk] = useQuickKeysOpen(desktop);
  const live = session.managed && session.status !== 'stopped';
  const takeover = useTakeover(session);
  const pending = usePendingSend(session.id);

  // 「引き継いで送信」: CC Hub 管理下になって入力待ちになったら、預かっていた指示を送る
  useEffect(() => {
    if (pending && session.managed && (session.status === 'awaiting_input' || session.status === 'idle')) {
      void flushPendingSend(session.id).then(() => termRef.current?.scrollToBottom());
    }
  }, [pending, session.managed, session.status, session.id]);

  const fontCtl = session.managed ? (
    <span className="font-ctl" role="group" aria-label="ターミナルの文字サイズ">
      <button className="icon-btn" onClick={() => changeFont(-1)} title="文字を小さく" aria-label="文字を小さく">
        A−
      </button>
      <span className="font-num" aria-live="polite">
        {fontSize}
      </span>
      <button className="icon-btn" onClick={() => changeFont(1)} title="文字を大きく" aria-label="文字を大きく">
        A+
      </button>
    </span>
  ) : null;

  const qkToggle = (
    <button
      type="button"
      className={`tool-btn ${qkOpen ? 'on' : ''}`}
      aria-expanded={qkOpen}
      onClick={toggleQk}
      title="Esc / ↑↓ / 1 2 3 などをターミナルに直接送るキー"
    >
      <span aria-hidden="true">⌨</span> キー {qkOpen ? '▾' : '▸'}
    </button>
  );

  return (
    <div className="session-pane">
      {header(fontCtl)}
      {/* スマホは承認の帯を端末に重ねる(帯で端末が縮む → Claude が描き直す → 帯が変わる、のループを防ぐ) */}
      {(desktop || !session.managed) && <ApprovalBanner session={session} />}
      <ReleaseBanner session={session} />
      {session.managed ? (
        <>
          <div className="term-stack">
            <TerminalView
              key={session.id}
              ref={termRef}
              sessionId={session.id}
              fontSize={fontSize}
              interactive={live}
            />
            {!desktop && <ApprovalBanner session={session} overlay />}
          </div>
          {live ? (
            <div className="composer-dock">
              {qkOpen && <QuickKeys session={session} termRef={termRef} />}
              <Composer
                session={session}
                desktop={desktop}
                onSent={() => termRef.current?.scrollToBottom()}
                toolbarExtra={qkToggle}
              />
            </div>
          ) : (
            <StoppedBar session={session} />
          )}
        </>
      ) : (
        <>
          <TakeoverPanel session={session} ctl={takeover} />
          <div className="composer-dock">
            <Composer session={session} desktop={desktop} mode="takeover" onTakeoverSend={(t) => takeover.start(t)} />
          </div>
          <ConflictDialog ctl={takeover} session={session} />
        </>
      )}
    </div>
  );
}

/** 停止中の下部バー。worktree を解放済みのセッションは作業場所が無いので再開できない旨を出す */
function StoppedBar({ session }: { session: SessionInfo }) {
  const wt = useSessionWorktree(session);
  const released = !!session.worktreeId && !wt;
  const label =
    session.status === 'error'
      ? `エラーで終了しました${session.exitCode != null ? `(終了コード ${session.exitCode})` : ''}`
      : 'セッションは停止しています';
  if (released) {
    return (
      <div className="stopped-bar">
        {label}。作業ツリーは解放済みのため、このセッションは再開できません
        {session.branch ? `(ブランチ ${session.branch} を残した場合は、そこから新しいセッションを始めてください)` : ''}
      </div>
    );
  }
  return (
    <div className="stopped-bar">
      {label}
      <button className="btn" onClick={() => sessionApi.control(session.id, 'restart').catch(() => {})}>
        再起動
      </button>
    </div>
  );
}
