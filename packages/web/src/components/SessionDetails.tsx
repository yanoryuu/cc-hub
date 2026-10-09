// セッション詳細と操作(停止 / 再起動 / 削除 / 名前変更)
import { useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { errText, isConflict, sessionApi } from '../api';
import { fmtCost, fmtDate } from '../util';
import { useHub } from '../store';
import { WT_STATE_LABEL, useSessionWorktree } from '../repo';
import { StatusBadge } from './common';
import { ReleaseBanner } from './ReleaseBanner';

export function SessionControls({ session, onDone }: { session: SessionInfo; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.name);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone?.();
    } catch (e) {
      // 409: worktree が割り当て中のセッションは、先に解放しないと削除できない
      setErr(
        isConflict(e) && session.worktreeId
          ? `${errText(e)} — 作業ツリーがまだこのセッションに割り当てられています。先に「作業ツリーを解放」してから削除してください。`
          : errText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const stopped = session.status === 'stopped';

  if (renaming) {
    return (
      <form
        className="rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = name.trim();
          if (!v) return;
          void run(() => sessionApi.rename(session.id, v)).then(() => setRenaming(false));
        }}
      >
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="新しい名前" />
        <button className="btn primary" disabled={busy || !name.trim()} type="submit">
          保存
        </button>
        <button className="btn" type="button" onClick={() => setRenaming(false)}>
          取消
        </button>
      </form>
    );
  }

  return (
    <div>
      <div className="ctl-row">
        {session.managed && (
          <>
            <button
              className="btn"
              disabled={busy || stopped}
              onClick={() => {
                if (confirm(`「${session.name}」を停止しますか?`)) void run(() => sessionApi.control(session.id, 'stop'));
              }}
            >
              停止
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                if (confirm(`「${session.name}」を再起動しますか?`))
                  void run(() => sessionApi.control(session.id, 'restart'));
              }}
            >
              再起動
            </button>
          </>
        )}
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setName(session.name);
            setRenaming(true);
          }}
        >
          名前変更
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`「${session.name}」を一覧から削除しますか?${session.managed && !stopped ? '\n(実行中のプロセスも終了します)' : ''}`))
              void run(() => sessionApi.control(session.id, 'remove'));
          }}
        >
          削除
        </button>
      </div>
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}

export function SessionDetails({ session }: { session: SessionInfo }) {
  const repo = useHub((s) => (session.repoId ? s.repos[session.repoId] : undefined));
  const wtAny = useHub((s) => (session.worktreeId ? s.worktrees[session.worktreeId] : undefined));
  const wt = useSessionWorktree(session);
  const openRepos = useHub((s) => s.openRepos);
  return (
    <section className="panel-sec">
      <h3 className="sec-title">セッション</h3>
      <dl className="kv">
        <dt>状態</dt>
        <dd>
          <StatusBadge status={session.status} />
          {!session.managed && <span className="ro-tag">読み取り専用</span>}
        </dd>
        <dt>作業ディレクトリ</dt>
        <dd className="mono break" title={session.cwd}>
          {session.cwd}
        </dd>
        <dt>モード</dt>
        <dd>{session.mode}</dd>
        <dt>権限モード</dt>
        <dd>{session.permissionMode ?? '—'}</dd>
        <dt>モデル</dt>
        <dd>{session.model ?? '—'}</dd>
        <dt>コンテキスト</dt>
        <dd>{session.contextPct == null ? '—' : `${Math.round(session.contextPct)}%`}</dd>
        <dt>コスト</dt>
        <dd>{fmtCost(session.costUsd)}</dd>
        {session.repoId && (
          <>
            <dt>リポジトリ</dt>
            <dd>
              {repo ? (
                <button className="link" onClick={() => openRepos({ page: 'repo', id: repo.id })} title="リポジトリを開く">
                  {repo.id}
                </button>
              ) : (
                session.repoId
              )}
            </dd>
          </>
        )}
        {session.worktreeId && (
          <>
            <dt>worktree</dt>
            <dd>
              <span className="mono">{wtAny?.name ?? session.worktreeId.split('#').pop()}</span>
              {wt ? (
                <span className="muted small"> {WT_STATE_LABEL[wt.state]}</span>
              ) : wtAny ? (
                <span className="muted small"> 解放済み</span>
              ) : null}
            </dd>
          </>
        )}
        {session.branch && (
          <>
            <dt>ブランチ</dt>
            <dd className="mono ellipsis" title={session.branch}>
              {session.branch}
            </dd>
          </>
        )}
        <dt>開始</dt>
        <dd>{fmtDate(session.createdAt)}</dd>
        <dt>ID</dt>
        <dd className="mono small break">{session.id}</dd>
      </dl>
      <ReleaseBanner session={session} compact />
      <SessionControls session={session} />
    </section>
  );
}
