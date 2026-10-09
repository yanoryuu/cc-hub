// xterm.js でセッションのターミナルを表示する。
// - term.snapshot → reset + write / term.data → write
// - 表示時・コンテナのリサイズ時に fit して POST /resize(デバウンス)
// - サーバーから term.resize が来たらローカルもそのサイズに合わせる(最後に書いた端末が勝つ)
// - タッチスクロールは SGR マウスホイールシーケンスに変換(Claude Code はオルタネートスクリーン + マウス追跡)
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { onTerm } from '../termBus';
import { subscribe } from '../ws';
import { sessionApi } from '../api';

export interface TerminalHandle {
  /** 正 = 下へ、負 = 上へ(行数) */
  scroll(lines: number): void;
  /** 1 画面の 1/3 程度(最低 5 行) */
  pageLines(): number;
  scrollToBottom(): void;
  focus(): void;
}

interface Props {
  sessionId: string;
  fontSize: number;
  /** false のときは入力を送らない(停止中など) */
  interactive: boolean;
}

const THEME = {
  background: '#0d0f13',
  foreground: '#d4d7de',
  cursor: '#d4d7de',
  cursorAccent: '#0d0f13',
  selectionBackground: '#3b4a6b',
  black: '#1b1e25',
  red: '#f0717d',
  green: '#7fd18b',
  yellow: '#e6b450',
  blue: '#6ea8fe',
  magenta: '#c49cff',
  cyan: '#5fd4d4',
  white: '#c8ccd4',
  brightBlack: '#5c6370',
  brightRed: '#ff8b95',
  brightGreen: '#9be3a5',
  brightYellow: '#f2c86d',
  brightBlue: '#8fbcff',
  brightMagenta: '#d6b8ff',
  brightCyan: '#80e5e5',
  brightWhite: '#f0f2f5',
};

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { sessionId, fontSize, interactive },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const [showBottomBtn, setShowBottomBtn] = useState(false);
  /** 直近の fit / リサイズ要求(外部から呼べるように ref に置く) */
  const fitNowRef = useRef<(force: boolean) => void>(() => {});

  const sendInput = (data: string) => {
    if (!interactiveRef.current) return;
    sessionApi.input(sessionId, data).catch(() => {});
  };

  const scrollView = (lines: number) => {
    const term = termRef.current;
    if (!term || lines === 0) return;
    if (term.modes.mouseTrackingMode !== 'none') {
      // 64 = wheel up, 65 = wheel down(SGR 形式)
      const btn = lines < 0 ? 64 : 65;
      const x = Math.max(1, Math.floor(term.cols / 2));
      const y = Math.max(1, Math.floor(term.rows / 2));
      const n = Math.min(40, Math.abs(lines));
      sendInput(`\x1b[<${btn};${x};${y}M`.repeat(n));
    } else {
      term.scrollLines(lines);
    }
  };

  useImperativeHandle(ref, () => ({
    scroll: scrollView,
    pageLines: () => Math.max(5, Math.floor((termRef.current?.rows ?? 24) / 3)),
    scrollToBottom: () => termRef.current?.scrollToBottom(),
    focus: () => termRef.current?.focus(),
  }));

  // ターミナル本体の生成と購読
  useEffect(() => {
    const host = hostRef.current!;
    const wrap = wrapRef.current!;
    const term = new Terminal({
      fontSize,
      fontFamily: '"Cascadia Mono", Consolas, "BIZ UDGothic", "Courier New", monospace',
      theme: THEME,
      scrollback: 5000,
      allowProposedApi: true,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // Ctrl+1..9 / Ctrl+Shift+A はアプリのショートカットなので xterm に渡さない
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) return false;
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) return false;
      return true;
    });

    const dataSub = term.onData((d) => sendInput(d));
    const updateBtn = () => {
      const buf = term.buffer.active;
      setShowBottomBtn(buf.viewportY < buf.baseY);
    };
    const scrollSub = term.onScroll(updateBtn);
    const parsedSub = term.onWriteParsed(updateBtn);

    // サーバーが知っている PTY サイズ
    let serverCols = 0;
    let serverRows = 0;
    let gotSnapshot = false;
    let postTimer: ReturnType<typeof setTimeout> | undefined;

    const visible = () => wrap.offsetWidth > 0 && wrap.offsetHeight > 0 && document.visibilityState === 'visible';

    // fit してサイズが変わっていれば(force なら常に)サーバーへ通知
    const fitNow = (force: boolean) => {
      if (!visible()) return;
      const dims = fit.proposeDimensions();
      if (!dims || !dims.cols || !dims.rows || !isFinite(dims.cols) || !isFinite(dims.rows)) return;
      const cols = Math.max(20, dims.cols);
      const rows = Math.max(5, dims.rows);
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      if (!gotSnapshot) return; // スナップショット前はサーバーへ送らない
      if (!force && cols === serverCols && rows === serverRows) return;
      if (postTimer) clearTimeout(postTimer);
      postTimer = setTimeout(() => {
        serverCols = cols;
        serverRows = rows;
        if (interactiveRef.current) sessionApi.resize(sessionId, cols, rows).catch(() => {});
      }, 150);
    };
    fitNowRef.current = fitNow;

    const offTerm = onTerm(sessionId, (e) => {
      if (e.t === 'snapshot') {
        if (e.cols > 0 && e.rows > 0) {
          serverCols = e.cols;
          serverRows = e.rows;
          term.resize(e.cols, e.rows);
        }
        // term.reset() は同期処理で、未処理の write キューより先に走ってしまう(スナップショットが二重になる)。
        // RIS(ESC c)を書き込みキューに入れて順序を保つ
        term.write('\x1bc' + (e.data || ''));
        const first = !gotSnapshot;
        gotSnapshot = true;
        // 表示中の端末が自分のサイズを主張する
        requestAnimationFrame(() => fitNow(first));
      } else if (e.t === 'data') {
        term.write(e.data);
      } else if (e.t === 'resize') {
        serverCols = e.cols;
        serverRows = e.rows;
        if (e.cols > 0 && e.rows > 0 && (term.cols !== e.cols || term.rows !== e.rows)) term.resize(e.cols, e.rows);
      }
    });
    const unsub = subscribe(`term:${sessionId}`);

    // コンテナのリサイズ → fit(デバウンス)
    let roTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(() => fitNow(false), 120);
    });
    ro.observe(wrap);

    // 端末に戻ってきたら(フォーカス / タブ復帰)このサイズを主張し直す
    const claim = () => setTimeout(() => fitNow(true), 50);
    const onVis = () => {
      if (document.visibilityState === 'visible') claim();
    };
    window.addEventListener('focus', claim);
    document.addEventListener('visibilitychange', onVis);

    // タッチスクロール(xterm 内部のジェスチャに横取りされないよう capture で捕捉)
    let lastY: number | null = null;
    let acc = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        lastY = null;
        return;
      }
      lastY = e.touches[0].clientY;
      acc = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lastY === null) return;
      e.preventDefault();
      e.stopPropagation();
      const y = e.touches[0].clientY;
      acc += lastY - y;
      lastY = y;
      const lineHeight = wrap.clientHeight / Math.max(1, term.rows);
      const lines = Math.trunc(acc / lineHeight);
      if (lines !== 0) {
        scrollView(lines);
        acc -= lines * lineHeight;
      }
    };
    const onTouchEnd = () => {
      lastY = null;
    };
    wrap.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    wrap.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });

    return () => {
      unsub();
      offTerm();
      ro.disconnect();
      if (roTimer) clearTimeout(roTimer);
      if (postTimer) clearTimeout(postTimer);
      window.removeEventListener('focus', claim);
      document.removeEventListener('visibilitychange', onVis);
      wrap.removeEventListener('touchstart', onTouchStart, { capture: true });
      wrap.removeEventListener('touchmove', onTouchMove, { capture: true });
      wrap.removeEventListener('touchend', onTouchEnd, { capture: true });
      dataSub.dispose();
      scrollSub.dispose();
      parsedSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // sessionId ごとに作り直す(親で key を付けている)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // フォントサイズ変更
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    requestAnimationFrame(() => fitNowRef.current(false));
  }, [fontSize]);

  return (
    <div className="term-wrap" ref={wrapRef}>
      <div className="term-host" ref={hostRef} />
      {showBottomBtn && (
        <button
          className="term-bottom-btn"
          onClick={() => {
            termRef.current?.scrollToBottom();
            setShowBottomBtn(false);
          }}
        >
          最下部へ
        </button>
      )}
    </div>
  );
});
