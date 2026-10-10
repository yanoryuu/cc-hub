// PR 画面(フェーズ 3): 一覧 / 詳細 / 操作ダイアログ。デスクトップとモバイルで共用
import { useEffect, useMemo, useState } from 'react';
import type { CheckState, MergeMethod, PrDetail, PrInfo, PrReviewEvent, SessionMode } from '@cc-hub/shared';
import { errText, pickSessionId, prApi } from '../api';
import { useHub } from '../store';
import {
  CHECK_LABEL,
  PR_STATE_LABEL,
  REVIEW_LABEL,
  canMerge,
  fmtAgo,
  mergeBlockers,
  needsAttention,
  refreshPrs,
  repoShort,
  splitPrId,
  usePrGroups,
} from '../pr';
import { fmtDate, readLocal, useNow, writeLocal } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { StatusDot } from './common';

// ---------------------------------------------------------------- 小さな部品

/** CI の状態アイコン ✓ / ✗ / ● / — */
export function CheckIcon({ checks, summary }: { checks: CheckState; summary?: PrInfo['checksSummary'] }) {
  const ico = checks === 'success' ? '✓' : checks === 'failure' ? '✗' : checks === 'pending' ? '●' : '—';
  const detail = summary ? `(成功 ${summary.passed} / 失敗 ${summary.failed} / 実行中 ${summary.pending})` : '';
  return (
    <span className={`ci ci-${checks}`} title={`${CHECK_LABEL[checks]}${detail}`} aria-label={CHECK_LABEL[checks]}>
      {ico}
    </span>
  );
}

export function PrStateChip({ pr }: { pr: Pick<PrInfo, 'state' | 'isDraft'> }) {
  const k = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return <span className={`prst prst-${k}`}>{pr.state === 'OPEN' && pr.isDraft ? 'Draft' : PR_STATE_LABEL[pr.state]}</span>;
}

export function ReviewChip({ decision }: { decision: PrInfo['reviewDecision'] }) {
  if (!decision) return null;
  return <span className={`rvw rvw-${decision.toLowerCase()}`}>{REVIEW_LABEL[decision]}</span>;
}

function ConflictChip({ pr }: { pr: PrInfo }) {
  if (pr.state !== 'OPEN' || pr.mergeable !== 'CONFLICTING') return null;
  return <span className="pr-conflict">⚠ コンフリクト</span>;
}

/** セッション画面などで使う小さな PR チップ: #42 Open ✗ 修正依頼 */
export function PrChip({ pr, onClick }: { pr: PrInfo; onClick?: () => void }) {
  return (
    <button className="pr-chip" onClick={onClick} title={`${pr.repoId}#${pr.number} ${pr.title}`}>
      <span className="pr-chip-num">#{pr.number}</span>
      <PrStateChip pr={pr} />
      {pr.state === 'OPEN' && <CheckIcon checks={pr.checks} summary={pr.checksSummary} />}
      {pr.state === 'OPEN' && <ReviewChip decision={pr.reviewDecision} />}
      <ConflictChip pr={pr} />
    </button>
  );
}

/** GitHub で開く(新しいタブ) */
export function GitHubLink({ url, className = 'btn' }: { url: string; className?: string }) {
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer">
      GitHub で開く ↗
    </a>
  );
}

/** 紐付いたセッションへのリンク(行クリックと区別するため伝播を止める) */
function SessionLink({ sessionId }: { sessionId: string | null }) {
  const s = useHub((st) => (sessionId ? st.sessions[sessionId] : undefined));
  const open = useHub((st) => st.open);
  if (!sessionId || !s) return null;
  return (
    <button
      className="pr-session"
      onClick={(e) => {
        e.stopPropagation();
        open(s.id);
      }}
      title="セッションを開く"
    >
      <StatusDot status={s.status} />
      <span className="pr-session-name">{s.name}</span>
    </button>
  );
}

/** PR 一覧を今すぐ取り直すボタン */
export function RefreshPrsButton({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await refreshPrs(true);
    } catch (e) {
      setErr(errText(e, '更新に失敗しました'));
      setTimeout(() => setErr(null), 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="pr-refresh">
      {err && <span className="form-error inline">{err}</span>}
      <button className={`btn ${compact ? 'sm' : ''}`} disabled={busy} onClick={() => void run()} title="GitHub から PR を取り直す">
        {busy ? <Spinner /> : '⟳'} {compact ? '' : '更新'}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- サイドバー

/** デスクトップ左サイドバーの「PR」セクション(件数だけの 1 行) */
export function SidebarPrs() {
  const g = usePrGroups();
  const deskView = useHub((s) => s.deskView);
  const openPr = useHub((s) => s.openPr);
  const attn = g.mine.filter(needsAttention).length;
  return (
    <section className="side-prs" aria-label="PR">
      <button
        className={`side-prs-btn ${deskView === 'prs' ? 'on' : ''}`}
        onClick={() => openPr(null)}
        title="PR 一覧を開く"
      >
        <span className="side-prs-title">PR</span>
        <span className="pool-chips">
          <span className="pchip" title="自分の PR(Open)">
            自分 {g.mine.length}
          </span>
          {g.review.length > 0 && (
            <span className="pchip review" title="レビュー依頼">
              レビュー {g.review.length}
            </span>
          )}
          {attn > 0 && (
            <span className="pchip broken" title="CI 失敗 / 修正依頼 / コンフリクト">
              要対応 {attn}
            </span>
          )}
        </span>
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- 一覧

export function PrRow({ pr, now }: { pr: PrInfo; now: number }) {
  const openPr = useHub((s) => s.openPr);
  const repoName = repoShort(pr.repoId);
  const go = () => openPr(pr.id);
  return (
    <div
      className={`pr-row ${(pr.mine || (pr.sessionId && !pr.reviewRequested)) && needsAttention(pr) ? 'attn' : ''} pr-${pr.state.toLowerCase()}`}
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      }}
    >
      <span className="pr-row-ci">
        {pr.state === 'OPEN' ? <CheckIcon checks={pr.checks} summary={pr.checksSummary} /> : <PrStateChip pr={pr} />}
      </span>
      <span className="pr-row-main">
        <span className="pr-row-top">
          <span className="pr-row-repo" title={pr.repoId}>
            {repoName}
          </span>
          <span className="pr-row-num">#{pr.number}</span>
          <span className="pr-row-title">{pr.title}</span>
        </span>
        <span className="pr-row-sub">
          {pr.state === 'OPEN' && pr.isDraft && <PrStateChip pr={pr} />}
          {pr.state === 'OPEN' && <ReviewChip decision={pr.reviewDecision} />}
          <ConflictChip pr={pr} />
          {canMerge(pr) && pr.checks === 'success' && <span className="pr-mergeable">マージ可</span>}
          {pr.commentCount > 0 && <span className="pr-meta">💬 {pr.commentCount}</span>}
          {!pr.mine && <span className="pr-meta">@{pr.author}</span>}
          <span className="pr-branch mono" title={`${pr.headRefName} → ${pr.baseRefName}`}>
            {pr.headRefName}
          </span>
          <SessionLink sessionId={pr.sessionId} />
        </span>
      </span>
      <span className="pr-row-time" title={fmtDate(pr.updatedAt)}>
        {fmtAgo(pr.updatedAt, now)}
      </span>
    </div>
  );
}

function PrGroup({ title, list, now, empty }: { title: string; list: PrInfo[]; now: number; empty?: string }) {
  if (list.length === 0 && !empty) return null;
  return (
    <section className="pr-group">
      <h3 className="sec-title">
        {title} <span className="count-pill">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <div className="pr-empty">{empty}</div>
      ) : (
        <div className="pr-list">
          {list.map((p) => (
            <PrRow key={p.id} pr={p} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

export function PrListPage({ mobile = false }: { mobile?: boolean }) {
  const g = usePrGroups();
  const loaded = useHub((s) => s.loaded);
  const now = useNow(30000);
  const [showClosed, setShowClosed] = useState(() => readLocal('cchub_pr_closed', '0') === '1');
  const toggleClosed = () =>
    setShowClosed((v) => {
      writeLocal('cchub_pr_closed', v ? '0' : '1');
      return !v;
    });
  const total = g.mine.length + g.review.length + g.other.length + g.closed.length;
  return (
    <div className="repo-page pr-page">
      {!mobile && (
        <div className="rp-head">
          <h2 className="rp-title">PR</h2>
          <span className="muted small">自分の PR・レビュー依頼・セッションに紐付いた PR</span>
          <span className="spacer" />
          <RefreshPrsButton />
        </div>
      )}
      {total === 0 ? (
        <div className="rp-empty">
          {loaded ? (
            <>
              <p>表示できる PR はありません。</p>
              <p className="muted small">セッションの「PR を作成」から作るか、GitHub で作成すると数分以内に表示されます。</p>
            </>
          ) : (
            '読み込み中…'
          )}
        </div>
      ) : (
        <>
          <PrGroup title="自分の PR" list={g.mine} now={now} empty="Open の PR はありません" />
          <PrGroup title="レビュー依頼" list={g.review} now={now} empty="レビュー依頼はありません" />
          <PrGroup title="その他" list={g.other} now={now} />
          {g.closed.length > 0 && (
            <section className="pr-group">
              <h3 className="sec-title">
                <button className="sgroup-toggle" onClick={toggleClosed} aria-expanded={showClosed}>
                  <span aria-hidden="true">{showClosed ? '▾' : '▸'}</span> 最近マージ / クローズ
                  <span className="sgroup-count">{g.closed.length}</span>
                </button>
              </h3>
              {showClosed && (
                <div className="pr-list">
                  {g.closed.map((p) => (
                    <PrRow key={p.id} pr={p} now={now} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 操作ダイアログ

type Notice = { text: string; sessionId?: string | null; error?: boolean };

/** 「指摘を直させる」/「CI の失敗を直させる」 */
export function FixDialog({
  pr,
  kind,
  detail,
  onClose,
  onDone,
}: {
  pr: PrInfo;
  kind: 'comments' | 'checks';
  detail?: PrDetail | null;
  onClose: () => void;
  onDone?: (n: Notice) => void;
}) {
  const session = useHub((s) => (pr.sessionId ? s.sessions[pr.sessionId] : undefined));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = !!session && session.managed && session.status !== 'stopped' && session.status !== 'error';
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = kind === 'comments' ? { comments: true } : { checks: true };
      const r = await prApi.fix(pr.repoId, pr.number, note.trim() ? { ...body, note: note.trim() } : body);
      const sid = pickSessionId(r) ?? (live ? session!.id : null);
      onDone?.({
        text: live ? `セッション「${session!.name}」に送りました` : '新しいセッションを起動して送りました',
        sessionId: sid,
      });
      onClose();
    } catch (e) {
      setErr(errText(e, '送信に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  const failed = detail?.failedChecks ?? [];
  const nComments = detail ? detail.comments.length + detail.reviews.filter((r) => r.body.trim()).length : pr.commentCount;
  return (
    <ConfirmModal
      title={kind === 'comments' ? 'レビューの指摘を直させる' : 'CI の失敗を直させる'}
      confirmLabel="送信"
      wide
      busy={busy}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p className="fix-target">
        <span className="mono">
          {pr.repoId}#{pr.number}
        </span>{' '}
        {pr.title}
      </p>
      <p>
        {kind === 'comments'
          ? `レビューコメント(${nComments} 件)を整形して送り、修正させます。`
          : `失敗したチェック${failed.length ? `(${failed.map((f) => f.name).join(', ')})` : ''}のログを送り、修正させます。`}
      </p>
      <p className="hint">
        送り先:{' '}
        {live ? (
          <>
            実行中のセッション <strong>{session!.name}</strong>
          </>
        ) : (
          <>
            セッションが動いていないため、プールの worktree で <span className="mono">{pr.headRefName}</span> を checkout して新しいセッションを起動します
          </>
        )}
      </p>
      <label className="field">
        <span>補足の指示(任意)</span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={kind === 'comments' ? '例: 命名の指摘は今回は見送ってよい' : '例: テストを直すのではなく実装側を直して'}
        />
      </label>
    </ConfirmModal>
  );
}

function ModeSeg({ mode, setMode }: { mode: SessionMode; setMode: (m: SessionMode) => void }) {
  return (
    <div className="field">
      <span>モード</span>
      <div className="seg small">
        <button type="button" className={mode === 'commander' ? 'on' : ''} onClick={() => setMode('commander')}>
          commander
        </button>
        <button type="button" className={mode === 'plain' ? 'on' : ''} onClick={() => setMode('plain')}>
          plain
        </button>
      </div>
    </div>
  );
}

/** 「この PR でセッションを開く」 */
function OpenSessionDialog({ pr, onClose, onDone }: { pr: PrInfo; onClose: () => void; onDone: (n: Notice) => void }) {
  const open = useHub((s) => s.open);
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<SessionMode>('commander');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await prApi.openSession(pr.repoId, pr.number, {
        mode,
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      const sid = pickSessionId(r);
      onClose();
      if (sid) open(sid);
      else onDone({ text: 'セッションを起動しました' });
    } catch (e) {
      setErr(errText(e, '起動に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal title="この PR でセッションを開く" confirmLabel="起動" wide busy={busy} error={err} onConfirm={() => void run()} onClose={onClose}>
      <p>
        プールの worktree に <span className="mono">{pr.headRefName}</span> を checkout(gh pr checkout {pr.number})して、新しいセッションを起動します。
      </p>
      <label className="field">
        <span>指示(任意)</span>
        <textarea
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={mode === 'commander' ? '/commander に渡す指示(例: レビュー指摘を確認して直して)' : '最初のプロンプト(任意)'}
        />
      </label>
      <ModeSeg mode={mode} setMode={setMode} />
    </ConfirmModal>
  );
}

const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: 'スカッシュしてマージ(squash)',
  merge: 'マージコミットを作る(merge)',
  rebase: 'リベースしてマージ(rebase)',
};

/** 「マージ」確認ダイアログ。override = 条件を満たしていないのにマージする */
export function MergeDialog({
  pr,
  override,
  onClose,
  onDone,
}: {
  pr: PrInfo;
  override: boolean;
  onClose: () => void;
  onDone: (n: Notice) => void;
}) {
  const [method, setMethod] = useState<MergeMethod>(() => {
    const m = readLocal('cchub_merge_method', 'squash');
    return m === 'merge' || m === 'rebase' ? m : 'squash';
  });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const session = useHub((s) => (pr.sessionId ? s.sessions[pr.sessionId] : undefined));
  const blockers = mergeBlockers(pr);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      writeLocal('cchub_merge_method', method);
      await prApi.merge(pr.repoId, pr.number, method);
      onDone({ text: `#${pr.number} をマージしました` });
      onClose();
    } catch (e) {
      setErr(errText(e, 'マージに失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal
      title={`#${pr.number} をマージ`}
      confirmLabel={override ? '条件を無視してマージ' : 'マージ'}
      danger={override}
      busy={busy}
      confirmDisabled={override && !ack}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        <span className="mono strong">
          {pr.repoId}#{pr.number}
        </span>
        「{pr.title}」を <span className="mono">{pr.baseRefName}</span> にマージします。
      </p>
      <label className="field">
        <span>マージ方法</span>
        <select value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)}>
          {(['squash', 'merge', 'rebase'] as MergeMethod[]).map((m) => (
            <option key={m} value={m}>
              {MERGE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        ブランチ <span className="mono">{pr.headRefName}</span> は削除されます(--delete-branch)。
        {session ? `紐付いたセッション「${session.name}」の worktree は、停止済みなら解放されます。` : ''}
      </p>
      {override && (
        <>
          <div className="warn-box">
            マージの条件を満たしていません:
            <ul className="blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            GitHub 側の保護ルールによっては失敗します。
          </div>
          <label className={`check-field ${ack ? 'danger-on' : ''}`}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>理解した上でマージする</span>
          </label>
        </>
      )}
    </ConfirmModal>
  );
}

function CloseDialog({ pr, onClose, onDone }: { pr: PrInfo; onClose: () => void; onDone: (n: Notice) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await prApi.close(pr.repoId, pr.number);
      onDone({ text: `#${pr.number} をクローズしました` });
      onClose();
    } catch (e) {
      setErr(errText(e, 'クローズに失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal title={`#${pr.number} をクローズ`} confirmLabel="クローズ" danger busy={busy} error={err} onConfirm={() => void run()} onClose={onClose}>
      <p>
        <span className="mono strong">
          {pr.repoId}#{pr.number}
        </span>
        「{pr.title}」をマージせずにクローズします。ブランチは残ります。
      </p>
    </ConfirmModal>
  );
}

const REVIEW_EVENT_LABEL: Record<PrReviewEvent, string> = {
  comment: 'コメント',
  approve: '承認',
  request_changes: '修正依頼',
};

/** GitHub にレビューを送る(承認 / 修正依頼 / コメント) */
function ReviewDialog({ pr, onClose, onDone }: { pr: PrInfo; onClose: () => void; onDone: (n: Notice) => void }) {
  // 自分の PR は GitHub の仕様で承認・修正依頼できない
  const [event, setEvent] = useState<PrReviewEvent>(pr.mine ? 'comment' : 'approve');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needBody = event !== 'approve';
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await prApi.review(pr.repoId, pr.number, event, body.trim());
      onDone({ text: `#${pr.number} に${REVIEW_EVENT_LABEL[event]}を送りました` });
      onClose();
    } catch (e) {
      setErr(errText(e, 'レビューを送れませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal
      title={`#${pr.number} をレビュー`}
      confirmLabel={`${REVIEW_EVENT_LABEL[event]}を送る`}
      wide
      busy={busy}
      confirmDisabled={needBody && !body.trim()}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p className="fix-target">
        <span className="mono">
          {pr.repoId}#{pr.number}
        </span>{' '}
        {pr.title}
      </p>
      <div className="field">
        <span>種類</span>
        <div className="seg small">
          {(['comment', 'approve', 'request_changes'] as PrReviewEvent[]).map((ev) => (
            <button
              key={ev}
              type="button"
              className={event === ev ? 'on' : ''}
              disabled={pr.mine && ev !== 'comment'}
              title={pr.mine && ev !== 'comment' ? '自分の PR は承認・修正依頼できません(GitHub の仕様)' : undefined}
              onClick={() => setEvent(ev)}
            >
              {REVIEW_EVENT_LABEL[ev]}
            </button>
          ))}
        </div>
      </div>
      {pr.mine && <p className="hint">自分の PR は GitHub の仕様で承認・修正依頼ができないため、コメントだけ送れます。</p>}
      <label className="field">
        <span>本文{needBody ? '' : '(任意)'}</span>
        <textarea
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={event === 'approve' ? '例: LGTM' : event === 'request_changes' ? '直してほしい点を書いてください' : 'コメント(Markdown)'}
        />
      </label>
    </ConfirmModal>
  );
}

/** 「Claude にレビューさせる」: PR のブランチで新しいセッションを起動してレビューさせる */
function AiReviewDialog({ pr, onClose, onDone }: { pr: PrInfo; onClose: () => void; onDone: (n: Notice) => void }) {
  const open = useHub((s) => s.open);
  const [note, setNote] = useState('');
  const [post, setPost] = useState(() => readLocal('cchub_ai_review_post', '0') === '1');
  const [mode, setMode] = useState<SessionMode>('plain');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      writeLocal('cchub_ai_review_post', post ? '1' : '0');
      const r = await prApi.aiReview(pr.repoId, pr.number, { post, mode, ...(note.trim() ? { note: note.trim() } : {}) });
      const sid = pickSessionId(r);
      onClose();
      if (sid) open(sid);
      else onDone({ text: 'レビュー用のセッションを起動しました' });
    } catch (e) {
      setErr(errText(e, '起動に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal title="Claude にレビューさせる" confirmLabel="レビュー開始" wide busy={busy} error={err} onConfirm={() => void run()} onClose={onClose}>
      <p>
        プールの worktree に <span className="mono">{pr.headRefName}</span> を checkout して新しいセッションを起動し、差分をレビューさせます。コードは変更させません。
      </p>
      <label className="field">
        <span>観点の補足(任意)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: パフォーマンスとエラー処理を重点的に" />
      </label>
      <label className="check-field">
        <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />
        <span>レビュー結果を GitHub の PR にコメントとして投稿させる(承認・修正依頼はしません)</span>
      </label>
      <ModeSeg mode={mode} setMode={setMode} />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------- 詳細

type Dialog =
  | null
  | { t: 'fix'; kind: 'comments' | 'checks' }
  | { t: 'open' }
  | { t: 'merge'; override: boolean }
  | { t: 'close' }
  | { t: 'review' }
  | { t: 'ai-review' };

interface TimelineItem {
  key: string;
  author: string;
  body: string;
  at: number;
  reviewState?: string;
  path?: string;
  line?: number;
  url?: string;
}

const REVIEW_STATE_LABEL: Record<string, string> = {
  APPROVED: '承認',
  CHANGES_REQUESTED: '修正依頼',
  COMMENTED: 'コメント',
  DISMISSED: '却下',
  PENDING: '保留中',
};

function timeline(d: PrDetail): TimelineItem[] {
  const out: TimelineItem[] = [];
  d.reviews.forEach((r, i) => {
    // 本文のない「コメント」レビュー(行コメントの入れ物)は省く
    if (!r.body.trim() && r.state === 'COMMENTED') return;
    out.push({ key: `r${i}`, author: r.author, body: r.body, at: r.submittedAt, reviewState: r.state });
  });
  d.comments.forEach((c, i) =>
    out.push({ key: `c${i}`, author: c.author, body: c.body, at: c.createdAt, path: c.path, line: c.line, url: c.url }),
  );
  return out.sort((a, b) => a.at - b.at);
}

export function PrDetailPage({ id, mobile = false }: { id: string; mobile?: boolean }) {
  const live = useHub((s) => s.prs[id]);
  const openPr = useHub((s) => s.openPr);
  const now = useNow(30000);
  const key = useMemo(() => splitPrId(id), [id]);
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const openSession = useHub((s) => s.open);

  // 一覧側の状態(CI / レビュー / マージ)が変わったら詳細も取り直す
  const stamp = live ? `${live.updatedAt}|${live.state}|${live.checks}|${live.reviewDecision}|${live.commentCount}` : '';
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setLoading(true);
    prApi
      .detail(key.repoId, key.number)
      .then((d) => {
        if (cancelled) return;
        setDetail(d ?? null);
        setLoadErr(d ? null : 'PR の詳細を取得できませんでした');
      })
      .catch((e) => !cancelled && setLoadErr(errText(e, 'PR の詳細を取得できませんでした')))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, stamp]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 10000);
    return () => clearTimeout(t);
  }, [notice]);

  // 状態表示は WS で届く一覧側を優先(詳細の取得は少し古いことがある)
  const pr: PrInfo | null = live ?? detail;
  const back = !mobile && (
    <button className="btn ghost" onClick={() => openPr(null)}>
      ‹ PR
    </button>
  );

  if (!pr) {
    return (
      <div className="repo-page pr-page">
        <div className="rp-head">{back}</div>
        <div className="rp-empty">
          {loading ? (
            <>
              <Spinner /> 読み込み中…
            </>
          ) : (
            <>
              {loadErr ?? 'PR が見つかりません'}
              <button className="btn" onClick={() => openPr(null)}>
                一覧へ
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const open = pr.state === 'OPEN';
  const mergeOk = canMerge(pr);
  const blockers = mergeBlockers(pr);
  const items = detail ? timeline(detail) : [];
  const failed = detail?.failedChecks ?? [];
  const hasComments = items.length > 0 || pr.commentCount > 0 || pr.reviewDecision === 'CHANGES_REQUESTED';
  const files = detail?.files ?? [];
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="repo-page pr-page pr-detail">
      {/* モバイルは上部バーにリポジトリ名と更新ボタンがある */}
      {!mobile && (
        <div className="rp-head wrap">
          {back}
          <span className="pr-d-repo muted">{pr.repoId}</span>
          <span className="spacer" />
          <RefreshPrsButton compact />
        </div>
      )}
      <div className="pr-d-head">
        <h2 className="pr-d-title">
          {pr.title} <span className="pr-d-num">#{pr.number}</span>
        </h2>
        <div className="pr-d-chips">
          <PrStateChip pr={pr} />
          {open && (
            <span className={`ci-chip ci-${pr.checks}`} title={CHECK_LABEL[pr.checks]}>
              <CheckIcon checks={pr.checks} /> {CHECK_LABEL[pr.checks]}
              {pr.checks !== 'none' && (
                <span className="ci-sum">
                  {' '}
                  {pr.checksSummary.passed}/{pr.checksSummary.passed + pr.checksSummary.failed + pr.checksSummary.pending}
                </span>
              )}
            </span>
          )}
          {open && <ReviewChip decision={pr.reviewDecision} />}
          {open && pr.mergeable === 'MERGEABLE' && <span className="pr-mergeable" title="GitHub の判定: base とコンフリクトしない">コンフリクトなし</span>}
          <ConflictChip pr={pr} />
        </div>
        <div className="pr-d-meta">
          <span className="mono pr-branch" title="head → base">
            {pr.headRefName} → {pr.baseRefName}
          </span>
          <span>@{pr.author}</span>
          <span title={fmtDate(pr.updatedAt)}>更新 {fmtAgo(pr.updatedAt, now)}</span>
          <SessionLink sessionId={pr.sessionId} />
        </div>
      </div>

      {notice && (
        <div className={`rp-alert ${notice.error ? 'error' : 'info'} pr-notice`} role="status">
          <span>{notice.text}</span>
          {notice.sessionId && (
            <button className="btn sm" onClick={() => openSession(notice.sessionId!)}>
              セッションを開く
            </button>
          )}
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="閉じる">
            ✕
          </button>
        </div>
      )}

      <div className="pr-actions">
        {open && (
          <>
            <button className="btn" disabled={!hasComments} onClick={() => setDialog({ t: 'fix', kind: 'comments' })}>
              指摘を直させる
            </button>
            <button
              className={`btn ${pr.checks === 'failure' ? 'primary' : ''}`}
              disabled={pr.checks !== 'failure'}
              onClick={() => setDialog({ t: 'fix', kind: 'checks' })}
            >
              CI の失敗を直させる
            </button>
          </>
        )}
        <button className="btn" onClick={() => setDialog({ t: 'open' })}>
          この PR でセッションを開く
        </button>
        {open && (
          <>
            <span className="pr-actions-sep" aria-hidden="true" />
            <button className="btn" onClick={() => setDialog({ t: 'ai-review' })} title="PR のブランチで Claude に差分をレビューさせる">
              Claude にレビューさせる
            </button>
            <button className="btn" onClick={() => setDialog({ t: 'review' })} title="GitHub にレビュー(承認 / 修正依頼 / コメント)を送る">
              レビューを送る
            </button>
            <span className="pr-actions-sep" aria-hidden="true" />
            <button
              className={`btn ${mergeOk ? 'approve' : ''}`}
              disabled={!mergeOk}
              onClick={() => setDialog({ t: 'merge', override: false })}
              title={mergeOk ? 'マージする' : blockers.join(' / ')}
            >
              マージ
            </button>
            <button className="btn danger" onClick={() => setDialog({ t: 'close' })}>
              クローズ
            </button>
          </>
        )}
        <span className="spacer" />
        <GitHubLink url={pr.url} />
      </div>
      {open && !mergeOk && blockers.length > 0 && (
        <div className="pr-blockers">
          <span className="muted">マージできない理由: {blockers.join(' / ')}</span>
          <button className="link-btn" onClick={() => setDialog({ t: 'merge', override: true })}>
            それでもマージ…
          </button>
        </div>
      )}

      {loading && !detail && (
        <div className="muted small">
          <Spinner /> 詳細を読み込み中…
        </div>
      )}
      {loadErr && !detail && <div className="form-error">{loadErr}</div>}

      {detail && (
        <>
          {failed.length > 0 && (
            <section className="rp-sec">
              <h3 className="sec-title">
                失敗したチェック <span className="count-pill fail">{failed.length}</span>
              </h3>
              <div className="rp-card pr-checks">
                {failed.map((c) => (
                  <div className="pr-check" key={c.name + c.url}>
                    <span className="ci ci-failure">✗</span>
                    <span className="pr-check-name">{c.name}</span>
                    <span className="spacer" />
                    {c.url && (
                      <a className="link-btn" href={c.url} target="_blank" rel="noreferrer">
                        ログ ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rp-sec">
            <h3 className="sec-title">説明</h3>
            <div className="rp-card pr-body">{detail.body.trim() ? detail.body : <span className="muted">説明はありません</span>}</div>
          </section>

          <section className="rp-sec">
            <h3 className="sec-title">
              コメント / レビュー <span className="count-pill">{items.length}</span>
            </h3>
            {items.length === 0 ? (
              <div className="pr-empty">コメントはありません</div>
            ) : (
              <div className="pr-comments">
                {items.map((c) => (
                  <article key={c.key} className={`pr-comment ${c.reviewState ? `rv-${c.reviewState.toLowerCase()}` : ''}`}>
                    <div className="pr-comment-head">
                      <span className="strong">@{c.author}</span>
                      {c.reviewState && (
                        <span className={`rvw rvw-${c.reviewState.toLowerCase()}`}>{REVIEW_STATE_LABEL[c.reviewState] ?? c.reviewState}</span>
                      )}
                      {c.path && (
                        <span className="mono pr-comment-path" title={c.path}>
                          {c.path}
                          {c.line != null ? `:${c.line}` : ''}
                        </span>
                      )}
                      <span className="spacer" />
                      <span className="muted small" title={fmtDate(c.at)}>
                        {fmtAgo(c.at, now)}
                      </span>
                      {c.url && (
                        <a className="link-btn" href={c.url} target="_blank" rel="noreferrer" aria-label="GitHub で開く">
                          ↗
                        </a>
                      )}
                    </div>
                    {c.body.trim() && <div className="pr-comment-body">{c.body}</div>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rp-sec">
            <h3 className="sec-title">
              変更ファイル <span className="count-pill">{files.length}</span>
              {files.length > 0 && (
                <span className="diffstat">
                  <span className="add">+{add}</span> <span className="del">−{del}</span>
                </span>
              )}
            </h3>
            {files.length === 0 ? (
              <div className="pr-empty">変更はありません</div>
            ) : (
              <div className="rp-card pr-files">
                {files.map((f) => (
                  <div className="pr-file" key={f.path}>
                    <span className="mono pr-file-path">{f.path}</span>
                    <span className="diffstat">
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {dialog?.t === 'fix' && (
        <FixDialog pr={pr} kind={dialog.kind} detail={detail} onClose={() => setDialog(null)} onDone={setNotice} />
      )}
      {dialog?.t === 'open' && <OpenSessionDialog pr={pr} onClose={() => setDialog(null)} onDone={setNotice} />}
      {dialog?.t === 'merge' && (
        <MergeDialog pr={pr} override={dialog.override} onClose={() => setDialog(null)} onDone={setNotice} />
      )}
      {dialog?.t === 'close' && <CloseDialog pr={pr} onClose={() => setDialog(null)} onDone={setNotice} />}
      {dialog?.t === 'review' && <ReviewDialog pr={pr} onClose={() => setDialog(null)} onDone={setNotice} />}
      {dialog?.t === 'ai-review' && <AiReviewDialog pr={pr} onClose={() => setDialog(null)} onDone={setNotice} />}
    </div>
  );
}

/** デスクトップ中央の PR 画面(一覧 / 詳細) */
export function PrScreen() {
  const route = useHub((s) => s.prRoute);
  return route.page === 'pr' ? <PrDetailPage key={route.id} id={route.id} /> : <PrListPage />;
}
