// 「アプリを開く」ボタン: セッションごとに登録した Unity エディタ / 自作ツールなどをいつでも起動する。
// ヘッダーのボタン(LauncherBar)と、セッション詳細の管理欄(LauncherManager)
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppLauncher, SessionInfo } from '@cc-hub/shared';
import { type LauncherEdit, errText, launcherApi } from '../api';
import { useHub } from '../store';
import { fmtAgo, fmtDate, readLocal, useNow, writeLocal } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';

// ---------------------------------------------------------------- 共通

/** ヘッダーに並べるのはこの数まで。超えたら「アプリ」メニューにまとめる */
const INLINE_MAX = 3;
/** Claude が登録したコマンドを一度確認したか(ランチャー id ごと。端末ごとに保存) */
const CONFIRM_KEY = 'cchub_launcher_ok';

function confirmedIds(): Set<string> {
  try {
    const v = JSON.parse(readLocal(CONFIRM_KEY, '[]'));
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function markConfirmed(id: string): void {
  const s = confirmedIds();
  s.add(id);
  // 古い id がたまり続けないよう直近 200 件だけ残す
  writeLocal(CONFIRM_KEY, JSON.stringify([...s].slice(-200)));
}

/** 確認なしで実行してよいか(ユーザーが登録したもの / 一度確認したもの) */
function needsConfirm(l: AppLauncher): boolean {
  return l.addedBy === 'claude' && !confirmedIds().has(l.id);
}

/** 画面右下の短いお知らせ(アプリ内トーストを流用。どのセッションにも紐付けない) */
export function flash(ok: boolean, title: string, body = ''): void {
  useHub.getState().pushToast({ kind: ok ? 'done' : 'error', sessionId: '', title, body, ts: Date.now() });
}

/** 表示用のコマンド({cwd} はそのまま見せる) */
function commandText(l: Pick<AppLauncher, 'kind' | 'command'>): string {
  return l.kind === 'unity' ? '作業フォルダを Unity エディタで開きます' : l.command || '(コマンド未設定)';
}

/** Unity = 立方体 / コマンド = ▶ */
export function LauncherIcon({ kind }: { kind: AppLauncher['kind'] }) {
  if (kind === 'unity') {
    return (
      <svg className="launch-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M2 5l6 3.5L14 5M8 8.5v6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <span className="launch-ico txt" aria-hidden="true">
      ▶
    </span>
  );
}

/**
 * 起動処理: Claude が登録したコマンドは初回だけ確認ダイアログを出す。
 * 戻り値の dialog は呼び出し側で描画する
 */
function useLauncherRunner(session: SessionInfo) {
  const [running, setRunning] = useState<string | null>(null);
  const [pending, setPending] = useState<AppLauncher | null>(null);

  const exec = async (l: AppLauncher) => {
    setRunning(l.id);
    const t0 = Date.now();
    try {
      const msg = await launcherApi.run(session.id, l.id);
      flash(true, `${l.label}: ${msg}`);
    } catch (e) {
      flash(false, `${l.label} を開けませんでした`, errText(e));
    } finally {
      // 一瞬で終わっても押したことが分かるよう、少しだけスピナーを出す
      const wait = Math.max(0, 600 - (Date.now() - t0));
      setTimeout(() => setRunning((r) => (r === l.id ? null : r)), wait);
    }
  };

  const run = (l: AppLauncher) => {
    if (running) return;
    if (needsConfirm(l)) setPending(l);
    else void exec(l);
  };

  // ヘッダーの中に置くので、書式を引き継がないよう body 直下に出す
  const dialog = pending ? createPortal(
    <ConfirmModal
      title="Claude が登録したコマンドを実行します"
      confirmLabel="実行する"
      wide
      onClose={() => setPending(null)}
      onConfirm={() => {
        markConfirmed(pending.id);
        const l = pending;
        setPending(null);
        void exec(l);
      }}
    >
      <p>
        「<strong>{pending.label}</strong>」は Claude がこのセッションに登録したボタンです。実行するコマンドを確認してください。
      </p>
      <pre className="launch-cmd big">{commandText(pending)}</pre>
      <p className="hint">
        <span className="mono">{'{cwd}'}</span> は作業フォルダ(<span className="mono break">{session.cwd}</span>)に置き換わります。
        一度実行すると、この端末では次回から確認しません。
      </p>
    </ConfirmModal>,
    document.body,
  ) : null;

  return { running, run, dialog };
}

function LaunchButton({
  l,
  running,
  onRun,
  menu,
}: {
  l: AppLauncher;
  running: boolean;
  onRun: () => void;
  menu?: boolean;
}) {
  const title = [
    `${l.label}: ${commandText(l)}`,
    l.addedBy === 'claude' ? '(Claude が登録)' : '',
    l.lastError ? `\n⚠ 前回の起動に失敗: ${l.lastError}` : '',
  ].join('');
  return (
    <button
      type="button"
      role={menu ? 'menuitem' : undefined}
      className={menu ? 'launch-menu-item' : `btn ghost sm head-act launch-btn ${l.lastError ? 'has-err' : ''}`}
      onClick={onRun}
      disabled={running}
      title={title}
      aria-label={`${l.label} を開く${l.lastError ? '(前回は失敗)' : ''}`}
    >
      {running ? <Spinner label={`${l.label} を起動中`} /> : <LauncherIcon kind={l.kind} />}
      <span className="launch-label">{l.label}</span>
      {l.lastError && (
        <span className="launch-err" aria-hidden="true">
          !
        </span>
      )}
    </button>
  );
}

/**
 * ヘッダーに並べる「アプリを開く」ボタン。多いとき(INLINE_MAX 超)は「アプリ」メニューにまとめる。
 * INLINE_MAX 以下でも、ヘッダーが狭いときは CSS(コンテナクエリ)でメニューの方に切り替える
 */
export function LauncherBar({ session }: { session: SessionInfo }) {
  const list = session.launchers ?? [];
  const { running, run, dialog } = useLauncherRunner(session);
  if (list.length === 0) return null;
  const inline = list.length <= INLINE_MAX;
  return (
    <span className={`launch-bar n${Math.min(list.length, INLINE_MAX + 1)}`} role="group" aria-label="アプリを開く">
      {inline && (
        <span className="launch-inline">
          {list.map((l) => (
            <LaunchButton key={l.id} l={l} running={running === l.id} onRun={() => run(l)} />
          ))}
        </span>
      )}
      <LaunchMenu list={list} running={running} run={run} auto={inline} />
      {dialog}
    </span>
  );
}

function LaunchMenu({
  list,
  running,
  run,
  auto,
}: {
  list: AppLauncher[];
  running: string | null;
  run: (l: AppLauncher) => void;
  /** true = 普段は隠し、狭いときだけ出す */
  auto: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const anyErr = list.some((l) => l.lastError);
  return (
        <span className={`launch-dd ${auto ? 'auto' : ''}`} ref={wrapRef}>
          <button
            type="button"
            className={`btn ghost sm head-act launch-btn ${open ? 'on' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title="登録したアプリ・ツールを開く"
          >
            {running ? <Spinner /> : <LauncherIcon kind="command" />}
            <span className="launch-label">アプリ</span>
            <span className="count-pill">{list.length}</span>
            {anyErr && (
              <span className="launch-err" aria-hidden="true">
                !
              </span>
            )}
            <span aria-hidden="true">▾</span>
          </button>
          {open && (
            <div className="launch-menu" role="menu" aria-label="アプリを開く">
              {list.map((l) => (
                <LaunchButton
                  key={l.id}
                  l={l}
                  menu
                  running={running === l.id}
                  onRun={() => {
                    setOpen(false);
                    run(l);
                  }}
                />
              ))}
            </div>
          )}
        </span>
  );
}

// ---------------------------------------------------------------- 管理欄(セッション詳細)

interface FormState {
  /** 編集中の既存ランチャー id(新規は null) */
  id: string | null;
  label: string;
  kind: AppLauncher['kind'];
  command: string;
}

const EMPTY_FORM: FormState = { id: null, label: '', kind: 'command', command: '' };

/** 保存用に変換(addedBy などは既存の値を保つ) */
function toEdit(l: AppLauncher): LauncherEdit {
  return { ...l };
}

export function LauncherManager({ session }: { session: SessionInfo }) {
  const list = session.launchers ?? [];
  const repo = useHub((s) => (session.repoId ? s.repos[session.repoId] : undefined));
  const upsertSession = useHub((s) => s.upsertSession);
  const now = useNow(30000);
  const { running, run, dialog } = useLauncherRunner(session);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const hasUnity = list.some((l) => l.kind === 'unity');
  // Unity のプロジェクトか UI からはフォルダを見られないので、リポジトリの種別が Unity のときか、まだ 1 つも無いときに提案する
  const suggestUnity = !hasUnity && (repo?.kind === 'unity' || list.length === 0);

  /** 保存。成功したら保存後のセッション(デーモンが返さなければ今のセッション)、失敗は null */
  const save = async (next: LauncherEdit[]): Promise<SessionInfo | null> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await launcherApi.save(session.id, next);
      if (s) upsertSession(s);
      return s ?? session;
    } catch (e) {
      setErr(errText(e, '保存できませんでした'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const formError = (f: FormState): string | null => {
    if (!f.label.trim()) return 'ボタンの名前を入れてください';
    if (f.kind === 'command' && !f.command.trim()) return '実行するコマンドを入れてください';
    if (list.some((l) => l.id !== f.id && l.label === f.label.trim())) return '同じ名前のボタンがあります';
    return null;
  };

  /** フォームの内容を一覧に反映して保存。ok = 保存できた / saved = 保存後のランチャー(見つかれば) */
  const submit = async (f: FormState): Promise<{ ok: boolean; saved: AppLauncher | null }> => {
    const v = formError(f);
    if (v) {
      setErr(v);
      return { ok: false, saved: null };
    }
    const label = f.label.trim();
    const command = f.kind === 'command' ? f.command.trim() : null;
    let next: LauncherEdit[];
    if (f.id) {
      next = list.map((l) =>
        l.id === f.id
          ? {
              ...l,
              label,
              kind: f.kind,
              command,
              // 中身を書き換えたら、以後は自分で登録したものとして扱う(確認ダイアログを出さない)
              addedBy: l.command === command && l.kind === f.kind ? l.addedBy : 'user',
            }
          : toEdit(l),
      );
    } else {
      next = [...list.map(toEdit), { label, kind: f.kind, command, addedBy: 'user', lastRunAt: null, lastError: null }];
    }
    const s = await save(next);
    if (!s) return { ok: false, saved: null };
    return { ok: true, saved: (s.launchers ?? []).find((l) => (f.id ? l.id === f.id : l.label === label)) ?? null };
  };

  const addUnity = async () => {
    const label = list.some((l) => l.label === 'Unity') ? 'Unity エディタ' : 'Unity';
    await save([...list.map(toEdit), { label, kind: 'unity', command: null, addedBy: 'user', lastRunAt: null, lastError: null }]);
  };

  const remove = async (l: AppLauncher) => {
    if (!confirm(`ボタン「${l.label}」を削除しますか?`)) return;
    await save(list.filter((x) => x.id !== l.id).map(toEdit));
    if (form?.id === l.id) setForm(null);
  };

  const openForm = (f: FormState) => {
    setErr(null);
    setTestMsg(null);
    setForm(f);
  };

  return (
    <section className="panel-sec launch-sec" aria-labelledby={`launch-h-${session.id}`}>
      <h3 className="sec-title" id={`launch-h-${session.id}`}>
        アプリを開くボタン {list.length > 0 && <span className="count-pill">{list.length}</span>}
      </h3>
      <p className="hint">Unity エディタや自作ツールを、このセッションの作業フォルダでいつでも開けるようにします。</p>

      {list.length > 0 && (
        <ul className="launch-list">
          {list.map((l) => (
            <li key={l.id} className={`launch-item ${l.lastError ? 'has-err' : ''}`}>
              <div className="launch-item-top">
                <LauncherIcon kind={l.kind} />
                <span className="launch-item-name">{l.label}</span>
                <span className="tag">{l.kind === 'unity' ? 'Unity エディタ' : 'コマンド'}</span>
                {l.addedBy === 'claude' && (
                  <span className="tag claude" title="Claude が MCP の set_app_launcher で登録しました">
                    Claude が登録
                  </span>
                )}
              </div>
              <pre className="launch-cmd">{commandText(l)}</pre>
              <div className="launch-item-meta muted small">
                {l.lastRunAt ? <span title={fmtDate(l.lastRunAt)}>最後に実行: {fmtAgo(l.lastRunAt, now)}</span> : <span>まだ実行していません</span>}
              </div>
              {l.lastError && (
                <div className="launch-item-err" role="note">
                  <span aria-hidden="true">⚠ </span>前回の起動に失敗: {l.lastError}
                </div>
              )}
              <div className="ctl-row">
                <button className="btn sm" disabled={running === l.id} onClick={() => run(l)}>
                  {running === l.id ? <Spinner /> : <LauncherIcon kind={l.kind} />} 開く
                </button>
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => openForm({ id: l.id, label: l.label, kind: l.kind, command: l.command ?? '' })}
                >
                  編集
                </button>
                <button className="btn sm danger" disabled={busy} onClick={() => void remove(l)}>
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <LauncherForm
          form={form}
          cwd={session.cwd}
          busy={busy || !!running}
          err={err}
          testMsg={testMsg}
          onChange={(f) => {
            setForm(f);
            setErr(null);
          }}
          onCancel={() => {
            setForm(null);
            setErr(null);
            setTestMsg(null);
          }}
          onSave={async () => {
            const r = await submit(form);
            if (r.ok) {
              setForm(null);
              setTestMsg(null);
            }
          }}
          onTest={async () => {
            // まだ保存していない内容は保存してから実行する(実行はデーモン側でしかできない)
            setTestMsg(null);
            const { ok, saved } = await submit(form);
            if (!ok) return;
            if (!saved) {
              setTestMsg({ ok: false, text: '保存しました。一覧に反映されたら「開く」で実行してください' });
              return;
            }
            setForm({ id: saved.id, label: saved.label, kind: saved.kind, command: saved.command ?? '' });
            setBusy(true);
            try {
              const msg = await launcherApi.run(session.id, saved.id);
              markConfirmed(saved.id);
              setTestMsg({ ok: true, text: msg });
            } catch (e) {
              setTestMsg({ ok: false, text: errText(e, '起動できませんでした') });
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <div className="launch-add">
          <button className="btn sm" onClick={() => openForm({ ...EMPTY_FORM })}>
            + ボタンを追加
          </button>
          {suggestUnity && (
            <button
              className="chip launch-chip"
              disabled={busy}
              onClick={() => void addUnity()}
              title="作業フォルダを Unity エディタで開くボタンを追加します(ProjectVersion.txt のバージョンで開きます)"
            >
              <LauncherIcon kind="unity" /> Unity を追加
            </button>
          )}
          {err && <div className="form-error">{err}</div>}
        </div>
      )}

      <p className="hint launch-claude-hint">
        セッションで『このツールを開くボタンを登録して』と頼むと、Claude が登録します。
      </p>
      {dialog}
    </section>
  );
}

function LauncherForm({
  form,
  cwd,
  busy,
  err,
  testMsg,
  onChange,
  onCancel,
  onSave,
  onTest,
}: {
  form: FormState;
  cwd: string;
  busy: boolean;
  err: string | null;
  testMsg: { ok: boolean; text: string } | null;
  onChange: (f: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const idBase = `lf-${form.id ?? 'new'}`;
  return (
    <form
      className="form launch-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="launch-form-title">{form.id ? 'ボタンを編集' : '新しいボタン'}</div>
      <label className="field">
        <span>ボタンの名前</span>
        <input
          value={form.label}
          onChange={(e) => onChange({ ...form, label: e.target.value })}
          placeholder="例: マップエディタ"
          maxLength={40}
          autoFocus
        />
      </label>
      <div className="field" role="radiogroup" aria-labelledby={`${idBase}-kind`}>
        <span id={`${idBase}-kind`}>種類</span>
        <div className="seg small">
          <button
            type="button"
            role="radio"
            aria-checked={form.kind === 'unity'}
            className={form.kind === 'unity' ? 'on' : ''}
            onClick={() => onChange({ ...form, kind: 'unity', label: form.label || 'Unity' })}
          >
            Unity エディタ
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={form.kind === 'command'}
            className={form.kind === 'command' ? 'on' : ''}
            onClick={() => onChange({ ...form, kind: 'command' })}
          >
            コマンド
          </button>
        </div>
      </div>
      {form.kind === 'command' ? (
        <label className="field">
          <span>実行するコマンド</span>
          <textarea
            className="mono"
            rows={3}
            value={form.command}
            onChange={(e) => onChange({ ...form, command: e.target.value })}
            placeholder='例: "C:\Tools\MapEditor.exe" {cwd}\maps'
            spellCheck={false}
            aria-describedby={`${idBase}-help`}
          />
          <span className="hint" id={`${idBase}-help`}>
            <span className="mono">{'{cwd}'}</span> は作業フォルダに置き換わります。例: <span className="mono">npm run tool</span> /{' '}
            <span className="mono">"C:\Tools\MapEditor.exe" {'{cwd}'}\maps</span>
            <br />
            作業フォルダ(<span className="mono break">{cwd}</span>)で実行します。終了は待ちません。
          </span>
        </label>
      ) : (
        <p className="hint">
          作業フォルダの Unity プロジェクトを、ProjectVersion.txt のバージョンの Unity エディタで開きます(既に開いていれば何もしません)。
        </p>
      )}
      {err && <div className="form-error">{err}</div>}
      {testMsg && (
        <div className={`launch-test ${testMsg.ok ? 'ok' : 'ng'}`} role="status">
          {testMsg.ok ? '✓ ' : '⚠ '}
          {testMsg.text}
        </div>
      )}
      <div className="ctl-row">
        <button type="submit" className="btn primary sm" disabled={busy}>
          保存
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={onTest} title="保存してから、いま実行してみます">
          {busy ? <Spinner /> : null} テスト実行
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
