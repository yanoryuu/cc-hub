// リポジトリ詳細の「ブランチ」セクション(フェーズ 3)。開いたときに取得し、マージ済みのローカルブランチを一括削除できる
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BranchInfo, RepoInfo } from '@cc-hub/shared';
import { errText, isConflict, prApi } from '../api';
import { useHub } from '../store';
import { fmtAgo } from '../pr';
import { fmtDate, readLocal, useNow, writeLocal } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { StatusDot } from './common';

/** 削除できる = マージ済みのローカルブランチで、既定ブランチでも使用中でもない */
function deletable(b: BranchInfo, repo: RepoInfo): boolean {
  return b.merged && b.isLocal && b.name !== repo.defaultBranch && !b.worktreeId && !b.sessionId;
}

/** 表示順: 既定ブランチ → 使用中 → 更新が新しい順 */
function sortBranches(list: BranchInfo[], repo: RepoInfo): BranchInfo[] {
  const rank = (b: BranchInfo) => (b.name === repo.defaultBranch ? 0 : b.sessionId || b.worktreeId ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.lastCommit.date - a.lastCommit.date);
}

export function BranchSection({ repo, mobile }: { repo: RepoInfo; mobile: boolean }) {
  const [open, setOpen] = useState(() => readLocal('cchub_branches_open', '1') === '1');
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await prApi.branches(repo.id);
      setBranches(list);
      // 消えたブランチは選択から外す
      setSel((s) => new Set([...s].filter((n) => list.some((b) => b.name === n && deletable(b, repo)))));
    } catch (e) {
      setErr(errText(e, 'ブランチを取得できませんでした'));
    } finally {
      setLoading(false);
    }
  }, [repo]);

  // 開いたときに取得(ブランチ一覧は状態に含まれないので遅延取得)
  useEffect(() => {
    if (open && repo.status === 'ready') void load();
    // repo オブジェクトは WS で頻繁に差し替わるので id と状態だけを見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo.id, repo.status]);

  const toggleOpen = () =>
    setOpen((v) => {
      writeLocal('cchub_branches_open', v ? '0' : '1');
      return !v;
    });

  const sorted = useMemo(() => (branches ? sortBranches(branches, repo) : []), [branches, repo]);
  const cleanable = sorted.filter((b) => deletable(b, repo));
  const toggle = (name: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const allSelected = cleanable.length > 0 && cleanable.every((b) => sel.has(b.name));
  const selectAll = () => setSel(allSelected ? new Set() : new Set(cleanable.map((b) => b.name)));

  return (
    <section className="rp-sec">
      <h3 className="sec-title branch-head">
        <button className="sgroup-toggle" onClick={toggleOpen} aria-expanded={open}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> ブランチ
          {branches && <span className="sgroup-count">{branches.length}</span>}
        </button>
        <span className="spacer" />
        {open && (
          <button className="btn sm" disabled={loading || repo.status !== 'ready'} onClick={() => void load()} title="git fetch --prune して取り直す">
            {loading ? <Spinner /> : '⟳'} 更新
          </button>
        )}
      </h3>
      {open && (
        <>
          {repo.status !== 'ready' ? (
            <div className="empty">クローンが完了すると表示されます</div>
          ) : err ? (
            <div className="form-error">{err}</div>
          ) : !branches ? (
            <div className="empty">
              <Spinner /> 取得中…(git fetch --prune)
            </div>
          ) : branches.length === 0 ? (
            <div className="empty">ブランチはありません</div>
          ) : (
            <>
              <div className="branch-bar">
                {cleanable.length > 0 ? (
                  <>
                    <label className="check-inline">
                      <input type="checkbox" checked={allSelected} onChange={selectAll} />
                      マージ済みをすべて選択({cleanable.length})
                    </label>
                    <span className="spacer" />
                    <button className="btn sm danger" disabled={sel.size === 0} onClick={() => setConfirm(true)}>
                      マージ済みを削除{sel.size > 0 ? `(${sel.size})` : ''}
                    </button>
                  </>
                ) : (
                  <span className="muted small">削除できるマージ済みのローカルブランチはありません</span>
                )}
              </div>
              {msg && <div className="rp-note">{msg}</div>}
              {mobile ? (
                <div className="wt-cards">
                  {sorted.map((b) => (
                    <BranchCard key={b.name + b.isLocal} b={b} repo={repo} checked={sel.has(b.name)} onToggle={() => toggle(b.name)} />
                  ))}
                </div>
              ) : (
                <BranchTable list={sorted} repo={repo} sel={sel} onToggle={toggle} />
              )}
            </>
          )}
        </>
      )}
      {confirm && (
        <CleanupModal
          repo={repo}
          names={[...sel]}
          onClose={() => setConfirm(false)}
          onDone={(n) => {
            setConfirm(false);
            setSel(new Set());
            setMsg(`${n} 本のブランチを削除しました`);
            setTimeout(() => setMsg(null), 6000);
            void load();
          }}
        />
      )}
    </section>
  );
}

function CleanupModal({
  repo,
  names,
  onClose,
  onDone,
}: {
  repo: RepoInfo;
  names: string[];
  onClose: () => void;
  onDone: (n: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await prApi.cleanup(repo.id, names);
      onDone(names.length);
    } catch (e) {
      setErr(isConflict(e) ? `${errText(e)}(使用中のブランチは削除できません)` : errText(e, '削除に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmModal
      title="マージ済みのブランチを削除"
      confirmLabel={`${names.length} 本を削除`}
      danger
      busy={busy}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        {repo.name} のローカルブランチを削除します(リモートのブランチは消しません)。
      </p>
      <ul className="branch-del-list mono">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </ConfirmModal>
  );
}

function Where({ b }: { b: BranchInfo }) {
  return (
    <span className="br-where">
      {b.isLocal && <span className="br-tag local">ローカル</span>}
      {b.hasRemote && <span className="br-tag remote">リモート</span>}
    </span>
  );
}

function AheadBehind({ b, repo }: { b: BranchInfo; repo: RepoInfo }) {
  if (b.name === repo.defaultBranch) return <span className="dim">base</span>;
  return (
    <span className={`br-ab ${b.behind > 0 ? 'behind' : ''}`} title={`base より ${b.ahead} 進み / ${b.behind} 遅れ`}>
      ↑{b.ahead} ↓{b.behind}
    </span>
  );
}

function Links({ b }: { b: BranchInfo }) {
  const s = useHub((st) => (b.sessionId ? st.sessions[b.sessionId] : undefined));
  const wt = useHub((st) => (b.worktreeId ? st.worktrees[b.worktreeId] : undefined));
  const open = useHub((st) => st.open);
  const openPr = useHub((st) => st.openPr);
  const prId = b.prNumber != null ? `${b.repoId}#${b.prNumber}` : null;
  const hasPr = useHub((st) => (prId ? !!st.prs[prId] : false));
  if (!b.sessionId && !b.worktreeId && b.prNumber == null) return <span className="dim">—</span>;
  return (
    <span className="br-links">
      {s ? (
        <button className="wt-session" onClick={() => open(s.id)} title="セッションを開く">
          <StatusDot status={s.status} />
          <span className="wt-session-name">{s.name}</span>
        </button>
      ) : null}
      {(wt || b.worktreeId) && <span className="mono small muted">{wt?.name ?? b.worktreeId!.split('#').pop()}</span>}
      {b.prNumber != null &&
        (hasPr ? (
          <button className="link-btn" onClick={() => openPr(prId)}>
            PR #{b.prNumber}
          </button>
        ) : (
          <span className="muted small">PR #{b.prNumber}</span>
        ))}
    </span>
  );
}

function BranchTable({
  list,
  repo,
  sel,
  onToggle,
}: {
  list: BranchInfo[];
  repo: RepoInfo;
  sel: Set<string>;
  onToggle: (name: string) => void;
}) {
  const now = useNow(60000);
  return (
    <div className="wt-table-wrap">
      <table className="wt-table br-table">
        <thead>
          <tr>
            <th aria-label="選択" />
            <th>ブランチ</th>
            <th>場所</th>
            <th>base 比</th>
            <th>未 push</th>
            <th>最終コミット</th>
            <th>紐付け</th>
          </tr>
        </thead>
        <tbody>
          {list.map((b) => {
            const can = deletable(b, repo);
            return (
              <tr key={b.name + b.isLocal} className={sel.has(b.name) ? 'sel' : ''}>
                <td className="br-check">
                  {can && (
                    <input type="checkbox" checked={sel.has(b.name)} onChange={() => onToggle(b.name)} aria-label={`${b.name} を選択`} />
                  )}
                </td>
                <td>
                  <span className="br-name mono">{b.name}</span>
                  {b.name === repo.defaultBranch && <span className="br-tag def">既定</span>}
                  {b.merged && <span className="br-tag merged">マージ済み</span>}
                </td>
                <td>
                  <Where b={b} />
                </td>
                <td className="nowrap">
                  <AheadBehind b={b} repo={repo} />
                </td>
                <td className="nowrap">{b.unpushed > 0 ? <span className="warn-text">{b.unpushed}</span> : <span className="dim">0</span>}</td>
                <td className="br-commit">
                  <span className="br-subject" title={b.lastCommit.subject}>
                    {b.lastCommit.subject}
                  </span>
                  <span className="muted small">
                    {b.lastCommit.author} · <span title={fmtDate(b.lastCommit.date)}>{fmtAgo(b.lastCommit.date, now)}</span>
                  </span>
                </td>
                <td>
                  <Links b={b} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BranchCard({ b, repo, checked, onToggle }: { b: BranchInfo; repo: RepoInfo; checked: boolean; onToggle: () => void }) {
  const now = useNow(60000);
  const can = deletable(b, repo);
  return (
    <div className={`wt-card br-card ${checked ? 'sel' : ''}`}>
      <div className="wt-card-top">
        {can && <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`${b.name} を選択`} />}
        <span className="br-name mono strong">{b.name}</span>
        {b.name === repo.defaultBranch && <span className="br-tag def">既定</span>}
        {b.merged && <span className="br-tag merged">マージ済み</span>}
      </div>
      <div className="wt-card-line">
        <Where b={b} />
        <AheadBehind b={b} repo={repo} />
        {b.unpushed > 0 && <span className="warn-text small">未 push {b.unpushed}</span>}
      </div>
      <div className="br-commit">
        <span className="br-subject">{b.lastCommit.subject}</span>
        <span className="muted small">
          {b.lastCommit.author} · {fmtAgo(b.lastCommit.date, now)}
        </span>
      </div>
      {(b.sessionId || b.worktreeId || b.prNumber != null) && (
        <div className="wt-card-line">
          <Links b={b} />
        </div>
      )}
    </div>
  );
}
