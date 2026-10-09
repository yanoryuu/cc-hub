// ゲームキャプチャ(CC Remote から移植): ウィンドウ一覧 → MJPEG 表示、タップ/ドラッグ・キー入力を /game/input へ
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { readLocal, writeLocal } from '../util';

interface GameWindow {
  hwnd: number;
  title: string;
}

const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const SPECIAL_KEYS: { label: string; vk: number }[] = [
  { label: 'Esc', vk: 27 },
  { label: 'Tab', vk: 9 },
  { label: '⌫', vk: 8 },
  { label: 'Enter', vk: 13 },
  { label: 'Shift', vk: 16 },
  { label: 'Ctrl', vk: 17 },
  { label: '←', vk: 37 },
  { label: '↑', vk: 38 },
  { label: '↓', vk: 40 },
  { label: '→', vk: 39 },
];

const PAD_MODES: Record<string, Record<'up' | 'left' | 'down' | 'right', number>> = {
  WASD: { up: 87, left: 65, down: 83, right: 68 },
  '←↑↓→': { up: 38, left: 37, down: 40, right: 39 },
};

function sendGame(body: Record<string, unknown>): void {
  api('/game/input', body).catch(() => {});
}
function sendKey(type: 'keydown' | 'keyup', vk: number): void {
  sendGame({ type, vk });
}

/** 押している間 keydown、離すと keyup(長押し対応) */
function HoldKey({ vk, className, children }: { vk: () => number; className?: string; children: React.ReactNode }) {
  const [held, setHeld] = useState(false);
  const heldVk = useRef(0);
  const release = () => {
    if (!held) return;
    setHeld(false);
    sendKey('keyup', heldVk.current);
  };
  return (
    <button
      className={`${className ?? ''} ${held ? 'held' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        heldVk.current = vk();
        setHeld(true);
        sendKey('keydown', heldVk.current);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {children}
    </button>
  );
}

export function GameView() {
  const [windows, setWindows] = useState<GameWindow[]>([]);
  const [hwnd, setHwnd] = useState<string>('');
  const [src, setSrc] = useState(BLANK_GIF);
  const [inputOn, setInputOn] = useState(false);
  const [kbOn, setKbOn] = useState(() => readLocal('cchub_game_kb', '0') === '1');
  const [padOn, setPadOn] = useState(() => readLocal('cchub_game_pad', '0') === '1');
  const [padMode, setPadMode] = useState(() => {
    const m = readLocal('cchub_padmode', 'WASD');
    return PAD_MODES[m] ? m : 'WASD';
  });
  const [zoomPct, setZoomPct] = useState(100);
  const [error, setError] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const zoom = useRef({ z: 1, x: 0, y: 0 });
  const inputOnRef = useRef(inputOn);
  inputOnRef.current = inputOn;

  const applyZoom = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const zs = zoom.current;
    if (zs.z <= 1.001) {
      zs.z = 1;
      zs.x = 0;
      zs.y = 0;
    }
    // パンは画像がビュー外に飛ばない範囲にクランプ
    const maxX = ((zs.z - 1) * img.offsetWidth) / 2;
    const maxY = ((zs.z - 1) * img.offsetHeight) / 2;
    zs.x = Math.max(-maxX, Math.min(maxX, zs.x));
    zs.y = Math.max(-maxY, Math.min(maxY, zs.y));
    img.style.transform = `translate(${zs.x}px, ${zs.y}px) scale(${zs.z})`;
    setZoomPct(Math.round(zs.z * 100));
  }, []);

  /** (cx, cy)(ビュー中心からのオフセット)を固定したままズーム率を変える */
  const setZoom = useCallback(
    (next: number, cx?: number, cy?: number) => {
      const zs = zoom.current;
      next = Math.max(1, Math.min(6, next));
      if (cx !== undefined && cy !== undefined) {
        const k = next / zs.z;
        zs.x = cx - k * (cx - zs.x);
        zs.y = cy - k * (cy - zs.y);
      }
      zs.z = next;
      applyZoom();
    },
    [applyZoom],
  );

  const loadWindows = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ ok: boolean; windows: GameWindow[] }>('/game/windows');
      const list = r.windows ?? [];
      setWindows(list);
      setHwnd((prev) => {
        if (prev && list.some((w) => String(w.hwnd) === prev)) return prev;
        const unity = list.find((w) => /Unity/i.test(w.title));
        return unity ? String(unity.hwnd) : list[0] ? String(list[0].hwnd) : '';
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ウィンドウ一覧の取得に失敗しました');
    }
  }, []);

  useEffect(() => {
    void loadWindows();
  }, [loadWindows]);

  // ウィンドウ選択でストリーム開始。アンマウント時は src を差し替えて MJPEG 接続を切る
  useEffect(() => {
    if (!hwnd) {
      setSrc(BLANK_GIF);
      return;
    }
    zoom.current = { z: 1, x: 0, y: 0 };
    applyZoom();
    setSrc(`/game/stream?hwnd=${hwnd}&t=${Date.now()}`);
  }, [hwnd, applyZoom]);
  useEffect(
    () => () => {
      if (imgRef.current) imgRef.current.src = BLANK_GIF;
    },
    [],
  );

  // ビュー上のポインタ操作: 2 本指 = ピンチズーム / 1 本指 = 入力 ON なら down/move/up、OFF ならズーム中のパン
  useEffect(() => {
    const view = viewRef.current!;
    const img = imgRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let pointerDown = false;
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null;
    let pan: { x: number; y: number; panX: number; panY: number } | null = null;
    let lastMove = 0;

    const toNorm = (e: PointerEvent) => {
      // object-fit: contain の余白を除いた実描画領域内の正規化座標
      const rect = img.getBoundingClientRect();
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih || !rect.width || !rect.height) return null;
      const scale = Math.min(rect.width / iw, rect.height / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const ox = rect.left + (rect.width - dw) / 2;
      const oy = rect.top + (rect.height - dh) / 2;
      const x = (e.clientX - ox) / dw;
      const y = (e.clientY - oy) / dh;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { x, y };
    };
    const offset = (cx: number, cy: number) => {
      const r = view.getBoundingClientRect();
      return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
    };
    const pinchInfo = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: offset((a.x + b.x) / 2, (a.y + b.y) / 2) };
    };

    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.pad-btn, #pad-mode')) return;
      e.preventDefault();
      view.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        if (pointerDown) {
          pointerDown = false;
          sendGame({ type: 'up', ...(toNorm(e) ?? { x: 0.5, y: 0.5 }) });
        }
        pan = null;
        pinch = pinchInfo();
        return;
      }
      if (pointers.size !== 1) return;
      if (inputOnRef.current) {
        const pt = toNorm(e);
        if (pt) {
          pointerDown = true;
          sendGame({ type: 'down', ...pt });
        }
      } else if (zoom.current.z > 1) {
        pan = { x: e.clientX, y: e.clientY, panX: zoom.current.x, panY: zoom.current.y };
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const { dist, mid } = pinchInfo();
        if (pinch.dist > 0) {
          zoom.current.x += mid.x - pinch.mid.x;
          zoom.current.y += mid.y - pinch.mid.y;
          pinch.mid = mid;
          setZoom(zoom.current.z * (dist / pinch.dist), mid.x, mid.y);
          pinch.dist = dist;
        }
        return;
      }
      if (pan) {
        zoom.current.x = pan.panX + (e.clientX - pan.x);
        zoom.current.y = pan.panY + (e.clientY - pan.y);
        applyZoom();
        return;
      }
      if (inputOnRef.current && pointerDown) {
        const now = Date.now();
        if (now - lastMove < 50) return; // 50ms に間引き
        const pt = toNorm(e);
        if (!pt) return;
        lastMove = now;
        sendGame({ type: 'move', ...pt });
      }
    };
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) pan = null;
      if (pointerDown && pointers.size === 0) {
        pointerDown = false;
        sendGame({ type: 'up', ...(toNorm(e) ?? { x: 0.5, y: 0.5 }) });
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const o = offset(e.clientX, e.clientY);
      setZoom(zoom.current.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), o.x, o.y);
    };
    view.addEventListener('pointerdown', down);
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    view.addEventListener('wheel', wheel, { passive: false });
    return () => {
      view.removeEventListener('pointerdown', down);
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', end);
      view.removeEventListener('pointercancel', end);
      view.removeEventListener('wheel', wheel);
    };
  }, [applyZoom, setZoom]);

  // PC: 入力 ON なら物理キーボードをそのまま転送
  useEffect(() => {
    const skip = (e: KeyboardEvent) =>
      !inputOnRef.current || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || !e.keyCode;
    const kd = (e: KeyboardEvent) => {
      if (skip(e) || e.repeat) return;
      e.preventDefault();
      sendKey('keydown', e.keyCode);
    };
    const ku = (e: KeyboardEvent) => {
      if (skip(e)) return;
      e.preventDefault();
      sendKey('keyup', e.keyCode);
    };
    document.addEventListener('keydown', kd);
    document.addEventListener('keyup', ku);
    return () => {
      document.removeEventListener('keydown', kd);
      document.removeEventListener('keyup', ku);
    };
  }, []);

  // スマホキーボード: フィールドに打った文字をそのまま送る(IME 変換中は確定まで待つ)
  const composing = useRef(false);
  const onKeyInput = (el: HTMLInputElement, native: InputEvent | Event) => {
    if (composing.current || (native as InputEvent).isComposing) return;
    if (el.value) {
      sendGame({ type: 'text', text: el.value });
      el.value = '';
    }
  };

  return (
    <div className="game">
      <div className="game-toolbar">
        <select value={hwnd} onChange={(e) => setHwnd(e.target.value)} aria-label="キャプチャするウィンドウ">
          {windows.length === 0 && <option value="">ウィンドウなし</option>}
          {windows.map((w) => (
            <option key={w.hwnd} value={String(w.hwnd)}>
              {w.title.length > 70 ? w.title.slice(0, 70) + '…' : w.title}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void loadWindows()} title="ウィンドウ一覧を更新" aria-label="更新">
          ↻
        </button>
        <button className="btn" onClick={() => setZoom(zoom.current.z / 1.5, 0, 0)} aria-label="縮小">
          −
        </button>
        <button className="btn" onClick={() => setZoom(1)} title="ズームをリセット">
          {zoomPct}%
        </button>
        <button className="btn" onClick={() => setZoom(zoom.current.z * 1.5, 0, 0)} aria-label="拡大">
          ＋
        </button>
        <button
          className={`btn ${inputOn ? 'on-green' : 'muted'}`}
          onClick={() => setInputOn((v) => !v)}
          title="タップ操作・キー入力の転送"
        >
          操作 {inputOn ? 'ON' : 'OFF'}
        </button>
        <button
          className={`btn ${kbOn ? 'on' : ''}`}
          onClick={() => {
            writeLocal('cchub_game_kb', kbOn ? '0' : '1');
            setKbOn(!kbOn);
          }}
          title="キーボード"
        >
          キー
        </button>
        <button
          className={`btn ${padOn ? 'on' : ''}`}
          onClick={() => {
            writeLocal('cchub_game_pad', padOn ? '0' : '1');
            setPadOn(!padOn);
          }}
          title="コントローラー"
        >
          パッド
        </button>
      </div>
      {error && <div className="form-error pad">{error}</div>}

      {kbOn && (
        <div className="game-keys">
          <input
            type="text"
            placeholder="ここに打った文字がゲームへ送信されます"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              if (e.data) sendGame({ type: 'text', text: e.data });
              e.currentTarget.value = '';
            }}
            onInput={(e) => onKeyInput(e.currentTarget, e.nativeEvent)}
            onKeyDown={(e) => {
              const SPECIAL: Record<string, number> = {
                Enter: 13,
                Backspace: 8,
                ArrowLeft: 37,
                ArrowUp: 38,
                ArrowDown: 40,
                ArrowRight: 39,
                Escape: 27,
                Tab: 9,
              };
              if (composing.current) return;
              const vk = SPECIAL[e.key];
              if (vk && !e.currentTarget.value) {
                e.preventDefault();
                sendKey('keydown', vk);
                setTimeout(() => sendKey('keyup', vk), 50);
              }
            }}
          />
          <div className="keys-row">
            {SPECIAL_KEYS.map((k) => (
              <HoldKey key={k.vk} vk={() => k.vk}>
                {k.label}
              </HoldKey>
            ))}
          </div>
        </div>
      )}

      <div className="game-view" ref={viewRef}>
        <img ref={imgRef} src={src} alt="" draggable={false} />
        {!hwnd && <div className="game-empty">キャプチャするウィンドウを選んでください</div>}
        {padOn && (
          <div className="game-pad">
            {(['up', 'left', 'right', 'down'] as const).map((d) => (
              <HoldKey key={d} className={`pad-btn pad-${d}`} vk={() => PAD_MODES[padMode][d]}>
                {{ up: '▲', left: '◀', right: '▶', down: '▼' }[d]}
              </HoldKey>
            ))}
            <button
              id="pad-mode"
              onClick={() => {
                const m = padMode === 'WASD' ? '←↑↓→' : 'WASD';
                writeLocal('cchub_padmode', m);
                setPadMode(m);
              }}
            >
              {padMode}
            </button>
            <HoldKey className="pad-btn pad-y" vk={() => 81}>
              Y
            </HoldKey>
            <HoldKey className="pad-btn pad-x" vk={() => 69}>
              X
            </HoldKey>
            <HoldKey className="pad-btn pad-b" vk={() => 27}>
              B
            </HoldKey>
            <HoldKey className="pad-btn pad-a" vk={() => 32}>
              A
            </HoldKey>
          </div>
        )}
      </div>
    </div>
  );
}
