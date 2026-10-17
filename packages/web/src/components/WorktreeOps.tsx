// worktree の「main に rebase」「削除」。使っていない(inUse でない)ときだけ押せる。
// リポジトリ画面の worktree 一覧と、プロジェクト画面の「作業ツリー」タブで共用
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RebaseResult, SessionInfo, WorktreeInfo, WorktreeLocker } from '@cc-hub/shared';
import { errText, isConflict, repoApi, sessionApi } from '../api';
import { useHub } from '../store';
import { getDraft, insertIntoComposer, setDraft } from '../composer';
import { ConfirmModal, Spinner } from './RepoCommon';
import { flash } from './Launchers';

export const IN_USE_HINT = '使用中のため操作できません(セッションを止めると操作できます)';
const BUSY_STATES = new Set<WorktreeInfo['state']>(['creating', 'warming', 'releasing', 'deleting']);

/**
 * 使用中か。デーモンの inUse を優先し、古いデーモン(inUse なし)では
 * 準備・初期化の途中か、割り当て先のセッションが動いているかで判断する
 */
export function wtInUse(w: WorktreeInfo, sessions: Record<string, SessionInfo>): boolean {
  if (typeof w.inUse === 'boolean') return w.inUse;
  if (BUSY_STATES.has(w.state)) return true;
  const s = w.sessionId ? sessions[w.sessionId] : undefined;
  return !!s && s.status !== 'stopped' && s.status !== 'error';
}

/** 「使用中」バッジ */
export function InUseTag() {
  return (
    <span className="tag inuse" title={IN_USE_HINT}>
      <span className="inuse-dot" aria-hidden="true" />
      使用中
    </span>
  );
}

/** rebase の衝突を Claude に解消してもらう指示 */
function resolvePrompt(def: string, files: string[]): string {
  return [
    `この作業ツリーを最新の origin/${def} に rebase してください(git fetch origin のあと git rebase origin/${def})。`,
    '次のファイルで衝突します。両方の変更の意図を確認して解消し、rebase を最後まで完了させてください(完了したらテストも確認してください):',
    ...files.map((f) => `- ${f}`),
  ].join('\n');
}

type Phase = null | 'rebase' | 'delete';

export function WtOps({ w, layout = 'row', showTag = false }: { w: WorktreeInfo; layout?: 'row' | 'card'; showTag?: boolean }) {
  const sessions = useHub((s) => s.sessions);
  const repo = useHub((s) => s.repos[w.repoId]);
  const def = repo?.defaultBranch || 'main';
  const inUse = wtInUse(w, sessions);
  const busyState = BUSY_STATES.has(w.state);
  const [phase, setPhase] = useState<Phase>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RebaseResult | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // 削除の前に、フォルダをつかんでいるプログラム(開いたままの Unity など)を調べる。undefined = 調べ中、null = 調べられなかった
  const [lockers, setLockers] = useState<WorktreeLocker[] | null | undefined>(undefined);

  const checkLockers = async () => {
    setLockers(undefined);
    try {
      setLockers(await repoApi.worktreeLockers(w.id));
    } catch {
      setLockers(null);
    }
  };

  useEffect(() => {
    if (phase === 'delete') void checkLockers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, w.id]);

  // 結果の一言はしばらくしたら消す
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  const disabled = inUse || busyState || busy;
  const reason = inUse ? IN_USE_HINT : busyState ? '準備・初期化の途中のため操作できません' : undefined;
  const canRebase = w.state === 'idle' || w.state === 'assigned';
  const close = () => {
    setPhase(null);
    setErr(null);
    setResult(null);
  };

  const doRebase = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await repoApi.rebaseWorktree(w.id);
      if (r.result === 'conflict') {
        setResult(r);
        return;
      }
      if (r.result === 'failed') {
        setErr(r.message || 'rebase に失敗しました');
        return;
      }
      const text = r.result === 'up_to_date' ? 'すでに最新です' : `${r.pulled} 件のコミットを取り込みました`;
      flash(true, `${w.name}: ${text}`, r.result === 'rebased' ? `${def} の最新に rebase しました` : '');
      setNote({ ok: true, text });
      close();
    } catch (e) {
      setErr(isConflict(e) ? `${errText(e)} — ${IN_USE_HINT}` : errText(e, 'rebase に失敗しました'));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    setErr(null);
    try {
      await repoApi.deleteWorktree(w.id);
      flash(true, `${w.name} を削除しています`, w.branch ? `ブランチ ${w.branch} は残します` : '');
      close();
    } catch (e) {
      // つかんでいるプログラムが原因なら一覧を取り直して見せる
      const text = errText(e, '削除に失敗しました');
      if (/Unity|プログラム/.test(text)) {
        setErr(null);
        void checkLockers();
      } else {
        setErr(isConflict(e) ? `${text} — ${IN_USE_HINT}` : text);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`wt-ops ${layout}`} title={reason}>
      {showTag && inUse && <InUseTag />}
      {canRebase && (
        <button
          type="button"
          className="btn sm"
          disabled={disabled}
          aria-disabled={disabled}
          title={reason ?? `最新の origin/${def} を取り込みます(衝突したら元に戻します)`}
          onClick={() => {
            setErr(null);
            setPhase('rebase');
          }}
        >
          {busy && phase === 'rebase' ? <Spinner /> : <span aria-hidden="true">⤓</span>} {def} に rebase
        </button>
      )}
      <button
        type="button"
        className="btn sm danger"
        disabled={disabled}
        title={reason ?? 'この worktree を削除します(ブランチは残します)'}
        onClick={() => {
          setErr(null);
          setPhase('delete');
        }}
      >
        削除
      </button>
      {reason && layout === 'card' && <span className="wt-ops-hint">{reason}</span>}
      {note && (
        <span className={note.ok ? 'ok-text wt-ops-note' : 'form-error wt-ops-note'} role="status">
          {note.ok ? '✓ ' : ''}
          {note.text}
        </span>
      )}

      {/* 表のセル(右寄せ・折り返しなし)の書式を引き継がないよう、ダイアログは body 直下に出す */}
      {phase && createPortal(<>
      {phase === 'rebase' && !result && (
        <ConfirmModal
          title={`${w.name} を ${def} に rebase`}
          confirmLabel={`${def} に rebase`}
          busy={busy}
          error={err}
          wide
          onConfirm={() => void doRebase()}
          onClose={close}
        >
          <dl className="kv cf-kv">
            <dt>worktree</dt>
            <dd className="mono">{w.name}</dd>
            <dt>ブランチ</dt>
            <dd className="mono">{w.branch ?? '(ブランチなし・待機中)'}</dd>
            {w.git && (
              <>
                <dt>差分</dt>
                <dd>
                  {def} より {w.git.ahead} 進み / {w.git.behind} 遅れ
                </dd>
              </>
            )}
          </dl>
          {w.state === 'idle' || !w.branch ? (
            // 待機中(ブランチなし)の作業ツリーは rebase ではなく最新の main に合わせ直す
            <p className="rp-alert warn">
              待機中の作業ツリーなので、最新の <span className="mono">{def}</span> にそのまま合わせ直します。
              この作業ツリーに手で入れた変更やコミットがあれば消えます。
            </p>
          ) : (
            <p>
              最新の <span className="mono">{def}</span>(origin/{def})を取り込みます。衝突したら元に戻します(作業内容は失われません)。
            </p>
          )}
          {w.git && w.git.changed > 0 && (
            <p className="rp-alert warn">未コミットの変更が {w.git.changed} 件あります。rebase できない場合は、先にコミットしてください。</p>
          )}
        </ConfirmModal>
      )}

      {phase === 'rebase' && result && <ConflictPanel w={w} def={def} result={result} onClose={close} />}

      {phase === 'delete' && (
        <ConfirmModal
          title={`${w.name} を削除`}
          confirmLabel="削除する"
          danger
          busy={busy}
          confirmDisabled={lockers === undefined || (lockers?.length ?? 0) > 0}
          error={err}
          wide
          onConfirm={() => void doDelete()}
          onClose={close}
        >
          <p>
            worktree <span className="mono">{w.name}</span> のフォルダを削除します。
          </p>
          <p className="mono small break muted">{w.path}</p>
          <LockerNotice lockers={lockers} onRecheck={() => void checkLockers()} />
          {w.branch && (
            <div className="warn-box">
              ブランチ <span className="mono">{w.branch}</span> は残ります。
              {w.git && w.git.unpushed > 0 && (
                <>
                  {' '}
                  未 push のコミットが <strong>{w.git.unpushed} 件</strong>あります(ブランチには残りますが、この PC にしかありません)。
                </>
              )}
              {w.git && w.git.changed > 0 && (
                <>
                  <br />
                  未コミットの変更 <strong>{w.git.changed} 件</strong>は失われます。
                </>
              )}
            </div>
          )}
          {w.sessionId && sessions[w.sessionId] && (
            <p className="hint">
              セッション「{sessions[w.sessionId].name}」は作業場所がなくなるため、再開できなくなります。
            </p>
          )}
        </ConfirmModal>
      )}
      </>, document.body)}
    </span>
  );
}

/** rebase で衝突したとき: ぶつかったファイルと、解消の仕方 */
function ConflictPanel({ w, def, result, onClose }: { w: WorktreeInfo; def: string; result: RebaseResult; onClose: () => void }) {
  const session = useHub((s) => (w.sessionId ? s.sessions[w.sessionId] : undefined));
  const open = useHub((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const askSession = async () => {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      // 入力欄に指示を入れておく(送信はユーザーが確認してから)
      setDraft(session.id, { text: '', attachments: getDraft(session.id).attachments });
      insertIntoComposer(session.id, resolvePrompt(def, result.conflicts));
      if (session.managed && (session.status === 'stopped' || session.status === 'error')) {
        await sessionApi.control(session.id, 'restart');
      }
      open(session.id);
      onClose();
    } catch (e) {
      setErr(errText(e, 'セッションを再開できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="rb-title">
        <div className="modal-head">
          <h2 id="rb-title">{w.name}: rebase で衝突しました</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body form">
          <div className="rp-alert warn">
            <span>
              <span className="mono">{w.branch ?? w.name}</span> を origin/{def} に rebase すると、次の {result.conflicts.length}{' '}
              ファイルで衝突します。rebase は中止して元の状態に戻しました。
            </span>
          </div>
          {result.conflicts.length > 0 && (
            <ul className="conflict-files" aria-label="衝突したファイル">
              {result.conflicts.map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          )}
          {result.message && <p className="hint">{result.message}</p>}
          <p>セッションを再開して Claude に解消させるか、手動で解消してください。</p>
          {session && (
            <p className="hint">
              「セッションに解消を頼む」を押すと、セッション「{session.name}」
              {session.status === 'stopped' || session.status === 'error' ? 'を再開し、' : 'を開き、'}
              入力欄に解消の指示を入れます(送信は内容を確認してから)。
            </p>
          )}
          {err && <div className="form-error">{err}</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              閉じる
            </button>
            {session && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void askSession()}>
                {busy ? '再開中…' : 'セッションに解消を頼む'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 削除の前の確認: フォルダをつかんでいるプログラム */
function LockerNotice({ lockers, onRecheck }: { lockers: WorktreeLocker[] | null | undefined; onRecheck: () => void }) {
  if (lockers === undefined) {
    return (
      <p className="hint" role="status">
        <Spinner /> このフォルダを開いているプログラムがないか確認しています…
      </p>
    );
  }
  if (lockers === null) {
    return <p className="hint">開いているプログラムを確認できませんでした。Unity などで開いている場合は、閉じてから削除してください。</p>;
  }
  if (!lockers.length) return null;
  const unity = lockers.some((l) => l.kind === 'unity' || l.kind === 'unity_worker');
  return (
    <div className="rp-alert warn locker-notice" role="alert">
      <strong>{unity ? 'Unity で開いたままです' : 'このフォルダを使っているプログラムがあります'}</strong>
      <span>
        {unity
          ? 'Unity で作業内容を保存してからエディタを閉じ、「もう一度確認」を押してください。開いたままだとフォルダを消し切れず、壊れた状態になります。'
          : '次のプログラムを終了してから、「もう一度確認」を押してください。'}
      </span>
      <ul className="locker-list">
        {lockers.map((l) => (
          <li key={l.pid}>
            {l.label} <span className="muted mono small">PID {l.pid}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn sm" onClick={onRecheck}>
        もう一度確認
      </button>
    </div>
  );
}
