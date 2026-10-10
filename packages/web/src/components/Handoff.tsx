// セッションの受け渡し: 「PowerShell で開く」(CC Hub → PowerShell)と「CC Hub で引き継ぐ / CC Hub に戻す」(外部 → CC Hub)
import { useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { errText, isConflict, sessionApi } from '../api';
import { cancelPendingSend, queueSendAfterTakeover, usePendingSend } from '../composer';
import { fmtElapsed, useNow } from '../util';
import { ConfirmModal } from './RepoCommon';
import { StatusBadge, toolText } from './common';

/** 引き継ぎの実行(409 のときは強制するかを確認する) */
export function useTakeover(session: SessionInfo) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 409 のメッセージ(強制するかの確認ダイアログを出す) */
  const [conflict, setConflict] = useState<string | null>(null);

  const run = async (force: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await sessionApi.takeover(session.id, force);
      setConflict(null);
    } catch (e) {
      if (!force && isConflict(e)) setConflict(errText(e));
      else {
        setErr(errText(e, '引き継げませんでした'));
        setConflict(null);
        cancelPendingSend(session.id);
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    err,
    conflict,
    start: (sendText?: string) => {
      if (sendText) queueSendAfterTakeover(session.id, sendText);
      void run(false);
    },
    force: () => void run(true),
    cancel: () => {
      setConflict(null);
      cancelPendingSend(session.id);
    },
  };
}

export type TakeoverCtl = ReturnType<typeof useTakeover>;

/** 相手側が実行中(409)のときの確認 */
export function ConflictDialog({ ctl, session }: { ctl: TakeoverCtl; session: SessionInfo }) {
  if (!ctl.conflict) return null;
  const where = session.handedOff ? 'PowerShell のウィンドウ' : '元のウィンドウ(VS Code やターミナル)';
  return (
    <ConfirmModal
      title="相手側でまだ動いています"
      confirmLabel="強制的に引き継ぐ"
      danger
      busy={ctl.busy}
      error={ctl.err}
      onConfirm={ctl.force}
      onClose={ctl.cancel}
    >
      <p>{ctl.conflict}</p>
      <div className="warn-box">
        強制的に引き継いでも、{where}の処理は止まりません。両方で動かすと<strong>会話が 2 つに分かれ</strong>
        、同じ作業ツリーへの変更がぶつかることがあります。
        <br />
        できれば{where}で処理が終わるのを待つか、止めてから引き継いでください。
      </div>
    </ConfirmModal>
  );
}

/** 外部セッション / PowerShell に移したセッションの説明と「引き継ぐ」ボタン(セッション画面の中央に出す) */
export function TakeoverPanel({ session, ctl }: { session: SessionInfo; ctl: TakeoverCtl }) {
  const now = useNow(1000);
  const pending = usePendingSend(session.id);
  const ps = !!session.handedOff;
  return (
    <div className="readonly-view">
      <section className={`handoff ${ps ? 'ps' : 'ext'}`} aria-labelledby={`ho-${session.id}`}>
        <div className="handoff-head">
          <span className="handoff-ico" aria-hidden="true">
            {ps ? '❯_' : '⇄'}
          </span>
          <div className="handoff-text">
            <h3 id={`ho-${session.id}`}>{ps ? 'PowerShell のウィンドウで実行中です' : 'CC Hub の外で動いているセッションです'}</h3>
            {ps ? (
              <p>
                このセッションは PowerShell の新しいウィンドウに移しました。作業ツリーはそのまま保持しています。
                <br />
                「CC Hub に戻す」と、PowerShell 側の続きをここで再開します(戻したら PowerShell のウィンドウは閉じてください)。
              </p>
            ) : (
              <p>
                VS Code やターミナルなど、CC Hub の外で起動されたセッションです。ここからは状態を見るだけで、指示は送れません。
                <br />
                「CC Hub で引き継ぐ」と、この会話を CC Hub で再開して、ここから指示を出せるようになります(引き継いだら元のウィンドウは閉じてください)。
              </p>
            )}
          </div>
        </div>
        <div className="handoff-actions">
          <button className="btn primary lg" disabled={ctl.busy} onClick={() => ctl.start()}>
            {ctl.busy && !ctl.conflict ? '引き継ぎ中…' : ps ? 'CC Hub に戻す' : 'CC Hub で引き継ぐ'}
          </button>
          <span className="hint">下の入力欄に指示を書いて「引き継いで送信」すると、引き継いだ後にその指示を送ります。</span>
        </div>
        {pending && (
          <div className="handoff-pending" role="status">
            <span className="spinner" aria-hidden="true" /> 引き継いだら次の指示を送ります: <q>{pending}</q>
            <button className="link-btn" onClick={() => cancelPendingSend(session.id)}>
              取りやめる
            </button>
          </div>
        )}
        {ctl.err && !ctl.conflict && <div className="form-error">{ctl.err}</div>}
      </section>
      <dl className="kv ro-kv">
        <dt>状態</dt>
        <dd>
          <StatusBadge status={session.status} />
        </dd>
        <dt>実行中のツール</dt>
        <dd className="mono">
          {session.currentTool ? (
            <>
              {toolText(session)} <span className="muted">({fmtElapsed(now - session.currentTool.since)})</span>
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

/** ヘッダーや詳細に置く「CC Hub で引き継ぐ / CC Hub に戻す」ボタン */
export function TakeoverButton({ session, className = 'btn' }: { session: SessionInfo; className?: string }) {
  const ctl = useTakeover(session);
  if (session.managed) return null;
  return (
    <>
      <button className={className} disabled={ctl.busy} onClick={() => ctl.start()} title="この会話を CC Hub の画面で再開します">
        {ctl.busy && !ctl.conflict ? '引き継ぎ中…' : session.handedOff ? 'CC Hub に戻す' : 'CC Hub で引き継ぐ'}
      </button>
      {ctl.err && !ctl.conflict && <span className="form-error inline">{ctl.err}</span>}
      <ConflictDialog ctl={ctl} session={session} />
    </>
  );
}

/** 「PowerShell で開く」ボタン + 確認ダイアログ(デスクトップのみ: PC にウィンドウを開くため) */
export function PowerShellButton({ session, className = 'btn' }: { session: SessionInfo; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!session.managed) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await sessionApi.openTerminal(session.id);
      setOpen(false);
    } catch (e) {
      setErr(errText(e, 'PowerShell で開けませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className={className}
        disabled={session.status === 'starting'}
        onClick={() => {
          setErr(null);
          setOpen(true);
        }}
        title="このセッションを PowerShell の新しいウィンドウで続ける"
      >
        <span aria-hidden="true" className="mono">
          ❯_
        </span>{' '}
        PowerShell で開く
      </button>
      {open && (
        <ConfirmModal title="PowerShell で開く" confirmLabel="PowerShell で開く" busy={busy} error={err} onConfirm={go} onClose={() => setOpen(false)}>
          <p>CC Hub 側のこのセッションを止めて、PowerShell の新しいウィンドウで続きを開きます。作業ツリーはそのまま保持されます。</p>
          <p className="hint">
            {session.status === 'running' || session.status === 'awaiting_approval'
              ? '実行中の処理は中断されます。'
              : ''}
            PowerShell での作業が終わったら、「CC Hub に戻す」でまたここから操作できます。
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
