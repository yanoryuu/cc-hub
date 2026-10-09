// セッションのブランチ / PR(フェーズ 3): worktree の変更状況と紐付いた PR、PR の作成
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { errText, prApi } from '../api';
import { useHub } from '../store';
import { useSessionWorktree } from '../repo';
import { fmtAgo, useSessionPr } from '../pr';
import { useNow } from '../util';
import { FixDialog, GitHubLink, PrChip } from './Prs';

export function SessionGit({ session }: { session: SessionInfo }) {
  const wt = useSessionWorktree(session);
  const pr = useSessionPr(session);
  const openPr = useHub((s) => s.openPr);
  const now = useNow(30000);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fix, setFix] = useState(false);

  // PR ができたら「作成を指示しました」の表示を消す
  useEffect(() => {
    if (pr && pr.state === 'OPEN') setRequested(false);
  }, [pr]);

  if (!session.branch && !pr) return null;

  const git = wt?.git ?? null;
  const live = session.managed && session.status !== 'stopped' && session.status !== 'error';
  // Open / マージ済みの PR があれば作成ボタンは出さない(クローズされたものは作り直せる)
  const canOfferCreate = !pr || pr.state === 'CLOSED';

  const createPr = async () => {
    setBusy(true);
    setErr(null);
    try {
      await prApi.createPr(session.id, draft);
      setRequested(true);
    } catch (e) {
      setErr(errText(e, 'PR の作成を指示できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-sec git-sec">
      <h3 className="sec-title">ブランチ / PR</h3>
      {session.branch && (
        <div className="git-branch mono" title={session.branch}>
          {session.branch}
        </div>
      )}

      {wt && !git && <div className="muted small">変更状況を取得中…</div>}
      {git && (
        <>
          <div className="git-stats">
            <span className={`gstat ${git.changed > 0 ? 'on' : ''}`} title="未コミットの変更(未追跡を含む)">
              変更 <b>{git.changed}</b> ファイル
            </span>
            <span className="gstat diffstat" title="base からの差分">
              <span className="add">+{git.insertions}</span> <span className="del">−{git.deletions}</span>
            </span>
            <span className="gstat" title="base より進んでいる / 遅れているコミット数">
              ↑{git.ahead} ↓{git.behind}
            </span>
            {git.unpushed > 0 && (
              <span className="gstat warn" title={git.pushed ? 'push していないコミット' : 'まだ一度も push していません'}>
                未 push <b>{git.unpushed}</b>
              </span>
            )}
          </div>
          {git.behind > 0 && (
            <div className="git-behind" role="note">
              ⚠ base から {git.behind} コミット遅れ(rebase 推奨)
            </div>
          )}
          <div className="muted small git-updated">更新 {fmtAgo(git.updatedAt, now)}</div>
        </>
      )}

      {pr ? (
        <div className="git-pr">
          <PrChip pr={pr} onClick={() => openPr(pr.id)} />
          <div className="git-pr-title" title={pr.title}>
            {pr.title}
          </div>
          <div className="ctl-row">
            <button className="btn sm" onClick={() => openPr(pr.id)}>
              PR を開く
            </button>
            {pr.state === 'OPEN' && pr.checks === 'failure' && (
              <button className="btn sm primary" onClick={() => setFix(true)}>
                CI を直させる
              </button>
            )}
            <GitHubLink url={pr.url} className="btn sm" />
          </div>
        </div>
      ) : null}

      {canOfferCreate && session.branch && (
        <div className="git-create">
          {requested ? (
            <div className="muted small">PR の作成を指示しました。できあがると自動でここに表示されます。</div>
          ) : (
            <>
              <div className="ctl-row">
                <button
                  className="btn sm primary"
                  disabled={busy || !live || !git || git.ahead === 0}
                  onClick={() => void createPr()}
                >
                  {busy ? '指示中…' : 'PR を作成'}
                </button>
                <label className="check-inline">
                  <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                  ドラフト
                </label>
              </div>
              {!live ? (
                <div className="hint">セッションが停止しているため作成できません</div>
              ) : git && git.ahead === 0 ? (
                <div className="hint">まだコミットがありません</div>
              ) : (
                <div className="hint">セッションに push と gh pr create を指示します(説明は Claude が下書き)</div>
              )}
            </>
          )}
          {err && <div className="form-error">{err}</div>}
        </div>
      )}
      {fix && pr && <FixDialog pr={pr} kind="checks" onClose={() => setFix(false)} />}
    </section>
  );
}
