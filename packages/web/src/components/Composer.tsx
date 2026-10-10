// 指示の入力欄: 自動で伸びるテキストエリア / Enter 送信(Shift+Enter 改行、IME 変換中は送らない)/
// セッションごとの下書き / ↑↓ で送信履歴 / 「/」でコマンド・スキルの補完 / 画像・ファイルの貼り付けとドロップ
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo, SkillInfo } from '@cc-hub/shared';
import { errText, sessionApi } from '../api';
import {
  type Attachment,
  BUILTIN_COMMANDS,
  fileToBase64,
  getDraft,
  pushHistory,
  readHistory,
  setDraft,
  takeFocusWanted,
  useDraftSubscription,
} from '../composer';
import { SOURCE_LABEL, useSkills } from '../ext';

/** 1 ファイルの上限(デーモンへの JSON で送るので大きすぎるものは断る) */
const MAX_BYTES = 15 * 1024 * 1024;
let attSeq = 1;

interface CmpItem {
  name: string;
  description: string;
  /** 'builtin' = Claude Code の組み込みコマンド */
  source: 'builtin' | SkillInfo['source'];
  kind?: SkillInfo['kind'];
  plugin?: string;
  path?: string;
}

/** キャレットの前が「先頭の / から空白なしで続く語」なら、その語(/ を除く)を返す */
function slashToken(text: string, caret: number): string | null {
  const m = /^\/(\S*)$/.exec(text.slice(0, caret));
  return m ? m[1] : null;
}

function pasteName(f: File): string {
  // クリップボードの画像は "image.png" などの決まった名前で来るので、日時を付けて重ならないようにする
  const generic = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name);
  if (!generic) return f.name;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `paste-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export function Composer({
  session,
  desktop,
  mode = 'send',
  onSent,
  onTakeoverSend,
  toolbarExtra,
}: {
  session: SessionInfo;
  desktop: boolean;
  /** 'takeover' = 外部セッション: 送信ボタンが「引き継いで送信」になる(添付は引き継ぎ後) */
  mode?: 'send' | 'takeover';
  onSent?: () => void;
  /** mode='takeover' のときの送信(引き継ぎ → 入力待ちになったら送る) */
  onTakeoverSend?: (text: string) => void;
  /** ツールバー左側に足すボタン(クイックキーの開閉など) */
  toolbarExtra?: React.ReactNode;
}) {
  const sid = session.id;
  const init = getDraft(sid);
  const [text, setText] = useState(init.text);
  const [atts, setAtts] = useState<Attachment[]>(init.attachments);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [caret, setCaret] = useState(init.text.length);
  const [sel, setSel] = useState(0);
  /** Esc で閉じたときの語(同じ語の間は開き直さない) */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composing = useRef(false);
  /** 履歴を表示中なら履歴の位置。null = 通常の入力 */
  const hist = useRef<{ idx: number; list: string[] } | null>(null);
  const takeover = mode === 'takeover';

  // 下書きを保存(セッションを切り替えても残る)
  useEffect(() => setDraft(sid, { text, attachments: atts }), [sid, text, atts]);

  // スキル一覧などから挿入されたとき
  const onExternal = useCallback(() => {
    const d = getDraft(sid);
    hist.current = null;
    setText(d.text);
    setDismissed(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(d.text.length, d.text.length);
      setCaret(d.text.length);
      takeFocusWanted(sid);
    });
  }, [sid]);
  useDraftSubscription(sid, onExternal);
  useEffect(() => {
    if (takeFocusWanted(sid)) onExternal();
  }, [sid, onExternal]);

  // 高さを内容に合わせる
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = desktop ? 260 : 180;
    ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px';
  }, [text, desktop]);

  // ---------------------------------------------------------------- 補完
  const skills = useSkills(session.cwd);
  const token = slashToken(text, caret);
  const items = useMemo<CmpItem[]>(() => {
    if (token == null) return [];
    const q = token.toLowerCase();
    const all: CmpItem[] = BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' as const }));
    const seen = new Set(all.map((c) => c.name));
    for (const s of skills.data ?? []) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      all.push({ name: s.name, description: s.description, source: s.source, kind: s.kind, plugin: s.plugin, path: s.path });
    }
    if (!q) return all;
    // 前方一致(プラグイン名を除いた名前も)→ 部分一致 → 説明に含む の順
    const score = (c: CmpItem) => {
      const n = c.name.toLowerCase();
      const bare = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
      if (n.startsWith(q) || bare.startsWith(q)) return 0;
      if (n.includes(q)) return 1;
      if (c.description.toLowerCase().includes(q)) return 2;
      return -1;
    };
    return all
      .map((c) => ({ c, s: score(c) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.c);
  }, [token, skills.data]);
  const popupOpen = token != null && token !== dismissed && (items.length > 0 || skills.loading);
  useEffect(() => setSel(0), [token]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, popupOpen]);

  const accept = (it: CmpItem) => {
    const rest = text.slice(caret).replace(/^\S*/, '').replace(/^\s*/, '');
    const head = `/${it.name} `;
    const next = head + rest;
    hist.current = null;
    setText(next);
    setDismissed(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(head.length, head.length);
      setCaret(head.length);
    });
  };

  // ---------------------------------------------------------------- 添付
  const insertAtCaret = (s: string) => {
    const ta = taRef.current;
    setText((cur) => {
      const at = ta ? Math.min(ta.selectionStart ?? cur.length, cur.length) : cur.length;
      const before = cur.slice(0, at);
      const after = cur.slice(at);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      return `${before}${pad}${s} ${after.replace(/^ /, '')}`;
    });
  };

  const upload = async (files: File[]) => {
    if (takeover) {
      setErr('添付は引き継いだ後に使えます');
      return;
    }
    for (const f of files) {
      const id = attSeq++;
      const name = pasteName(f);
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      if (f.size > MAX_BYTES) {
        setAtts((a) => [...a, { id, name, mime: f.type, preview, path: null, error: `大きすぎます(上限 ${MAX_BYTES / 1024 / 1024}MB)` }]);
        continue;
      }
      setAtts((a) => [...a, { id, name, mime: f.type, preview, path: null, error: null }]);
      try {
        const dataBase64 = await fileToBase64(f);
        const p = await sessionApi.attach(sid, { name, mime: f.type || 'application/octet-stream', dataBase64 });
        setAtts((a) => a.map((x) => (x.id === id ? { ...x, path: p } : x)));
        insertAtCaret(`@${p}`);
      } catch (e) {
        setAtts((a) => a.map((x) => (x.id === id ? { ...x, error: errText(e, 'アップロードに失敗しました') } : x)));
      }
    }
  };

  const removeAtt = (a: Attachment) => {
    if (a.preview) URL.revokeObjectURL(a.preview);
    setAtts((list) => list.filter((x) => x.id !== a.id));
    if (a.path) {
      const esc = a.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      setText((t) => t.replace(new RegExp(`@${esc} ?`, 'g'), ''));
    }
  };

  const uploading = atts.some((a) => !a.path && !a.error);

  // ---------------------------------------------------------------- 送信
  const send = async () => {
    const v = text.trim();
    if (!v || busy || uploading) return;
    setErr(null);
    if (takeover) {
      // 本文は預ける(取りやめ / 失敗したら下書きに戻る)
      setText('');
      setCaret(0);
      onTakeoverSend?.(v);
      return;
    }
    setBusy(true);
    try {
      await sessionApi.input(sid, v, true);
      pushHistory(sid, v);
      hist.current = null;
      for (const a of atts) if (a.preview) URL.revokeObjectURL(a.preview);
      setAtts([]);
      setText('');
      setCaret(0);
      onSent?.();
    } catch (e) {
      setErr(errText(e, '送信できませんでした')); // 入力は残す
    } finally {
      setBusy(false);
    }
  };

  const recall = (dir: -1 | 1): boolean => {
    let h = hist.current;
    if (!h) {
      if (dir === 1 || text !== '') return false;
      const list = readHistory(sid);
      if (list.length === 0) return false;
      h = { idx: list.length, list };
    }
    const idx = h.idx + dir;
    if (idx < 0) return true; // いちばん古い
    if (idx >= h.list.length) {
      hist.current = null;
      setText('');
      return true;
    }
    hist.current = { ...h, idx };
    const v = h.list[idx];
    setText(v);
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(v.length, v.length);
      setCaret(v.length);
    });
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 変換中の Enter / 矢印は変換の操作なので何もしない
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (popupOpen && items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        accept(items[Math.min(sel, items.length - 1)]);
        return;
      }
    }
    if (e.key === 'Escape' && popupOpen) {
      e.preventDefault();
      setDismissed(token);
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (recall(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      return;
    }
    // Enter で送信 / Shift+Enter で改行(スマホのキーボードは Enter = 改行、送信はボタン)
    if (desktop && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const syncCaret = () => setCaret(taRef.current?.selectionStart ?? text.length);
  const listId = `cmp-${sid}`;

  return (
    <div
      className={`composer ${drag ? 'drag' : ''} ${takeover ? 'takeover' : ''}`}
      onDragOver={(e) => {
        if (takeover || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        setDrag(false);
        if (takeover || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        void upload([...e.dataTransfer.files]);
      }}
    >
      {popupOpen && (
        <div className="cmp-pop">
          <ul className="cmp-list" role="listbox" id={listId} ref={listRef} aria-label="コマンドとスキル">
            {items.map((it, i) => (
              <li
                key={`${it.source}:${it.name}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === sel}
                className={`cmp-item ${i === sel ? 'sel' : ''}`}
                title={it.path ?? it.description}
                onMouseDown={(e) => {
                  e.preventDefault(); // テキストエリアのフォーカスを外さない
                  accept(it);
                }}
                onMouseMove={() => i !== sel && setSel(i)}
              >
                <span className="cmp-top">
                  <span className="cmp-name">/{it.name}</span>
                  <span className={`src-badge src-${it.source}`}>{it.source === 'builtin' ? '組み込み' : SOURCE_LABEL[it.source]}</span>
                  {it.kind === 'command' && <span className="kind-note">コマンド</span>}
                </span>
                {it.description && <span className="cmp-desc">{it.description}</span>}
              </li>
            ))}
            {items.length === 0 && skills.loading && <li className="cmp-empty">スキルを読み込み中…</li>}
          </ul>
          {desktop && <div className="cmp-help">↑↓ で選ぶ · Enter / Tab で入力 · Esc で閉じる</div>}
        </div>
      )}
      {atts.length > 0 && (
        <div className="att-row" aria-label="添付ファイル">
          {atts.map((a) => (
            <span key={a.id} className={`att-chip ${a.error ? 'err' : ''}`} title={a.error ?? a.path ?? a.name}>
              {a.preview ? <img src={a.preview} alt="" /> : <span className="att-ico" aria-hidden="true">📄</span>}
              <span className="att-text">
                <span className="att-name">{a.name}</span>
                <span className="att-sub">{a.error ? a.error : a.path ? `@${a.path}` : 'アップロード中…'}</span>
              </span>
              {!a.path && !a.error && <span className="spinner" aria-label="アップロード中" />}
              <button className="att-x" onClick={() => removeAtt(a)} aria-label={`${a.name} を外す`} title="外す">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="cmp-box">
        <textarea
          ref={taRef}
          rows={desktop ? 2 : 1}
          value={text}
          spellCheck={false}
          aria-label="Claude への指示"
          aria-autocomplete="list"
          aria-controls={popupOpen ? listId : undefined}
          aria-activedescendant={popupOpen && items.length ? `${listId}-${sel}` : undefined}
          placeholder={
            takeover
              ? '指示を入力すると、引き継いでから送ります'
              : desktop
                ? '指示を入力 — 「/」でコマンドとスキル、画像は貼り付け / ドロップで添付'
                : '指示を入力(「/」でコマンド)'
          }
          onChange={(e) => {
            hist.current = null;
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            if (dismissed != null) setDismissed((d) => (slashToken(e.target.value, e.target.selectionStart ?? 0) === d ? d : null));
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => {
            composing.current = false;
            syncCaret();
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length === 0) return;
            e.preventDefault();
            void upload(files);
          }}
        />
        <div className="cmp-tools">
          {!takeover && (
            <>
              <button
                type="button"
                className="tool-btn"
                onClick={() => fileRef.current?.click()}
                title="画像やファイルを添付(貼り付け・ドロップでも添付できます)"
              >
                <span aria-hidden="true">📎</span> 添付
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const fs = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (fs.length) void upload(fs);
                }}
              />
            </>
          )}
          <button
            type="button"
            className="tool-btn"
            title="コマンドとスキルの一覧"
            onClick={() => {
              const next = text.startsWith('/') ? text : `/${text}`;
              setText(next);
              setDismissed(null);
              requestAnimationFrame(() => {
                taRef.current?.focus();
                taRef.current?.setSelectionRange(1, 1);
                setCaret(1);
              });
            }}
          >
            <span className="mono" aria-hidden="true">
              /
            </span>{' '}
            コマンド
          </button>
          {toolbarExtra}
          <span className="spacer" />
          {desktop && <span className="cmp-hint">Enter で送信 · Shift+Enter で改行</span>}
          <button
            className="btn primary send-btn"
            disabled={busy || uploading || !text.trim()}
            onClick={() => void send()}
            title={uploading ? 'アップロードが終わるまで待ってください' : undefined}
          >
            {takeover ? '引き継いで送信' : busy ? '送信中…' : '送信'}
          </button>
        </div>
      </div>
      {err && <div className="form-error cmp-err">{err}</div>}
      {drag && <div className="drop-hint">ここにドロップして添付</div>}
    </div>
  );
}
