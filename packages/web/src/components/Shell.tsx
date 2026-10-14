// PowerShell 画面: CC Hub から PowerShell を開いて、ほかの端末(スマホ・Mac)からコマンドを打つ。Claude は動かさない。
// ターミナル表示は TerminalView(入力先を shellApi に差し替え)。スマホでも打てるように下にコマンド欄とキーを置く。
import { useEffect, useRef, useState } from 'react';
import type { ShellInfo } from '@cc-hub/shared';
import { errText, shellApi } from '../api';
import { useHub } from '../store';
import { useScopeCwd } from '../ext';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { useFontSize } from './SessionPane';

/** ターミナルに送るキー(スマホのキーボードに無いもの) */
const KEYS: { label: string; data: string; title: string }[] = [
  { label: 'Ctrl+C', data: '\x03', title: '実行中のコマンドを止める' },
  { label: 'Tab', data: '\t', title: '補完' },
  { label: '↑', data: '\x1b[A', title: '前のコマンド' },
  { label: '↓', data: '\x1b[B', title: '次のコマンド' },
  { label: 'Esc', data: '\x1b', title: '入力を消す' },
  { label: 'Enter', data: '\r', title: 'Enter' },
];

function NewShellForm({ onOpened, compact }: { onOpened: (s: ShellInfo) => void; compact?: boolean }) {
  const scopeCwd = useScopeCwd();
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = async (dir: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await shellApi.start(dir.trim() || undefined);
      if (r.shell) onOpened(r.shell);
    } catch (e) {
      setErr(errText(e, 'PowerShell を開けませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`shell-new ${compact ? 'compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void open(cwd);
      }}
    >
      <input
        className="mono"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="開くフォルダ(空 = ホーム)"
        aria-label="開くフォルダ"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button className="btn primary" disabled={busy} type="submit">
        {busy ? '開いています…' : '＋ PowerShell を開く'}
      </button>
      {scopeCwd && (
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void open(scopeCwd)} title={scopeCwd}>
          選択中のセッションのフォルダで開く
        </button>
      )}
      {err && <div className="form-error">{err}</div>}
    </form>
  );
}

/** 下のコマンド欄(スマホでも打てるように)とキー */
function CommandBar({ shell, termRef }: { shell: ShellInfo; termRef: React.RefObject<TerminalHandle> }) {
  const [text, setText] = useState('');
  const send = (data: string, submit = false) => {
    void shellApi.input(shell.id, data, submit).catch(() => {});
    termRef.current?.scrollToBottom();
  };
  return (
    <div className="shell-bar">
      <div className="shell-keys" role="group" aria-label="ターミナルに送るキー">
        {KEYS.map((k) => (
          <button key={k.label} type="button" className="btn ghost sm" title={k.title} disabled={!shell.alive} onClick={() => send(k.data)}>
            {k.label}
          </button>
        ))}
      </div>
      <form
        className="shell-cmd"
        onSubmit={(e) => {
          e.preventDefault();
          send(text, true);
          setText('');
        }}
      >
        <input
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={shell.alive ? 'コマンドを入力して Enter(ターミナルを直接タップしても打てます)' : 'PowerShell は終了しています'}
          aria-label="コマンド"
          disabled={!shell.alive}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="send"
        />
        <button className="btn primary" type="submit" disabled={!shell.alive}>
          実行
        </button>
      </form>
    </div>
  );
}

export function ShellScreen({ mobile = false, head }: { mobile?: boolean; head?: React.ReactNode }) {
  const shells = useHub((s) => s.shells);
  const list = Object.values(shells).sort((a, b) => a.startedAt - b.startedAt);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fontSize, changeFont] = useFontSize();
  const termRef = useRef<TerminalHandle>(null);
  const active = (activeId && shells[activeId]) || list[list.length - 1] || null;

  // 選んでいた PowerShell が閉じられたら選択を外す(最後に開いたものを出す)
  useEffect(() => {
    if (activeId && !shells[activeId]) setActiveId(null);
  }, [activeId, shells]);

  const close = async (s: ShellInfo) => {
    if (s.alive && !window.confirm(`「${s.name}」を閉じますか?(実行中のコマンドも終了します)`)) return;
    try {
      await shellApi.close(s.id);
    } catch (e) {
      window.alert(errText(e, '閉じられませんでした'));
    }
  };

  return (
    <div className={`shell-screen ${mobile ? 'mobile' : ''}`}>
      {head}
      <div className="shell-tabs" role="tablist" aria-label="開いている PowerShell">
        {list.map((s) => (
          <span key={s.id} className={`shell-tab ${active?.id === s.id ? 'on' : ''}`}>
            <button role="tab" aria-selected={active?.id === s.id} onClick={() => setActiveId(s.id)} title={s.cwd}>
              <span className={`shell-dot ${s.alive ? 'live' : ''}`} aria-hidden="true" />
              {s.name}
            </button>
            <button className="shell-tab-x" onClick={() => void close(s)} aria-label={`「${s.name}」を閉じる`} title="閉じる">
              ×
            </button>
          </span>
        ))}
        {active && (
          <span className="font-ctl shell-font" role="group" aria-label="ターミナルの文字サイズ">
            <button className="icon-btn" onClick={() => changeFont(-1)} aria-label="文字を小さく">
              A−
            </button>
            <span className="font-num">{fontSize}</span>
            <button className="icon-btn" onClick={() => changeFont(1)} aria-label="文字を大きく">
              A+
            </button>
          </span>
        )}
      </div>
      {active ? (
        <>
          <div className="shell-cwd mono muted small" title={active.cwd}>
            {active.cwd}
          </div>
          <TerminalView key={active.id} ref={termRef} sessionId={active.id} fontSize={fontSize} interactive={active.alive} io={shellApi} />
          <CommandBar shell={active} termRef={termRef} />
          <details className="shell-more">
            <summary>別の PowerShell を開く</summary>
            <NewShellForm compact onOpened={(s) => setActiveId(s.id)} />
          </details>
        </>
      ) : (
        <div className="shell-empty">
          <p>
            この PC の PowerShell を開いて、スマホや別の PC からコマンドを打てます(Claude は動きません)。
            <br />
            CC Hub を再起動すると閉じます。
          </p>
          <NewShellForm onOpened={(s) => setActiveId(s.id)} />
        </div>
      )}
    </div>
  );
}
