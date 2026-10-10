// 管理画面「Git」: ターゲット(worktree / .base / フォルダ)ごとのステージング・コミット・Push・コミット履歴
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, GitTarget, ProjectOverview, SessionInfo } from '@cc-hub/shared';
import { errText, isConflict } from '../api';
import { useHub } from '../store';
import { CHANGE_LABEL, changeCount, isWorking, projectApi } from '../project';
import { fmtAgo } from '../pr';
import { fmtDate, useNow } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { StatusBadge } from './common';
import { FilePreview } from './ProjectArtifacts';

type Section = 'staged' | 'unstaged' | 'untracked';
const SECTION_LABEL: Record<Section, string> = { staged: 'ステージ済み', unstaged: '未ステージ', untracked: '未追跡' };

interface LogEntry {
  id: number;
  ts: number;
  ok: boolean;
  text: string;
}
let logSeq = 1;

/** 拡張子からプレビューの種類を推定(Artifact.kind と同じ分類) */
function kindOf(path: string): 'image' | 'markdown' | 'code' | 'data' | 'other' {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'image';
  if (/^(md|markdown|mdx)$/.test(ext)) return 'markdown';
  if (/^(json|ya?ml|toml|csv|tsv|xml|ini|env|lock)$/.test(ext)) return 'data';
  if (/^(ts|tsx|js|jsx|mjs|cjs|css|scss|html|py|rs|go|cs|java|kt|c|h|cpp|hpp|sh|ps1|bat|sql|rb|php|swift|vue|svelte|txt|log)$/.test(ext)) return 'code';
  return 'other';
}

/** 既定ブランチ(origin/main → main) */
function defaultBranchOf(t: GitTarget, repoDefault: string | undefined): string | null {
  if (repoDefault) return repoDefault;
  if (t.baseRef) return t.baseRef.replace(/^origin\//, '');
  return null;
}

export function TargetPicker({
  targets,
  value,
  onChange,
  sessions,
}: {
  targets: GitTarget[];
  value: string;
  onChange: (id: string) => void;
  sessions: Record<string, SessionInfo>;
}) {
  return (
    <div className="tgt-picker" role="tablist" aria-label="対象の作業ツリー">
      {targets.map((t) => {
        const n = changeCount(t);
        const s = t.sessionId ? sessions[t.sessionId] : undefined;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={value === t.id}
            className={`tgt-chip ${value === t.id ? 'on' : ''}`}
            onClick={() => onChange(t.id)}
            title={`${t.path}${t.branch ? `\n${t.branch}` : ''}${s ? `\nセッション: ${s.name}` : ''}`}
          >
            <span className="tgt-label mono">{t.label}</span>
            {t.branch && <span className="tgt-branch mono">{t.branch}</span>}
            {n > 0 && (
              <span className="tgt-n" aria-label={`変更 ${n} 件`}>
                ●{n}
              </span>
            )}
            {t.unpushed > 0 && (
              <span className="tgt-n warn" aria-label={`未 push ${t.unpushed} 件`}>
                ↑{t.unpushed}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function GitTab({
  data,
  targetId,
  setTargetId,
  sessions,
  reload,
  mobile,
}: {
  data: ProjectOverview;
  targetId: string;
  setTargetId: (id: string) => void;
  sessions: Record<string, SessionInfo>;
  reload: () => void;
  mobile: boolean;
}) {
  const t = data.targets.find((x) => x.id === targetId) ?? data.targets[0];
  if (!t) return <div className="rp-empty">Git の対象(作業ツリー / フォルダ)がありません。</div>;
  return (
    <div className="git-tab">
      <TargetPicker targets={data.targets} value={t.id} onChange={setTargetId} sessions={sessions} />
      <TargetGit key={t.id} t={t} data={data} sessions={sessions} reload={reload} mobile={mobile} />
    </div>
  );
}

function TargetGit({
  t,
  data,
  sessions,
  reload,
  mobile,
}: {
  t: GitTarget;
  data: ProjectOverview;
  sessions: Record<string, SessionInfo>;
  reload: () => void;
  mobile: boolean;
}) {
  const now = useNow(30000);
  const open = useHub((s) => s.open);
  const repoDefault = useHub((s) => (data.key.repoId ? s.repos[data.key.repoId]?.defaultBranch : undefined));
  const session = t.sessionId ? sessions[t.sessionId] : undefined;
  const working = isWorking(session);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ path: string; section: Section } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const msgRef = useRef<HTMLTextAreaElement>(null);

  const addLog = (ok: boolean, text: string) => setLog((l) => [{ id: logSeq++, ts: Date.now(), ok, text }, ...l].slice(0, 20));

  // 取り直しで消えたファイルは選択から外す
  const files = useMemo(() => {
    const m = new Map<string, { section: Section; path: string; f?: FileChange }>();
    for (const f of t.staged) m.set(`staged|${f.path}`, { section: 'staged', path: f.path, f });
    for (const f of t.unstaged) m.set(`unstaged|${f.path}`, { section: 'unstaged', path: f.path, f });
    for (const p of t.untracked) m.set(`untracked|${p}`, { section: 'untracked', path: p });
    return m;
  }, [t]);
  const selKeys = [...sel].filter((k) => files.has(k));
  const selIn = (sec: Section) => selKeys.filter((k) => k.startsWith(`${sec}|`)).map((k) => files.get(k)!.path);
  const selStaged = selIn('staged');
  const selWork = [...selIn('unstaged'), ...selIn('untracked')];

  useEffect(() => {
    if (preview && !files.has(`${preview.section}|${preview.path}`)) {
      // ステージ / 解除で別のセクションに移ったら追いかける
      const moved = (['staged', 'unstaged', 'untracked'] as Section[]).find((s) => files.has(`${s}|${preview.path}`));
      setPreview(moved ? { path: preview.path, section: moved } : null);
    }
  }, [files, preview]);

  const toggle = (k: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const setSection = (sec: Section, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      for (const k of files.keys()) if (k.startsWith(`${sec}|`)) (on ? n.add(k) : n.delete(k));
      return n;
    });

  const stage = async (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    setBusy(unstage ? 'unstage' : 'stage');
    try {
      await projectApi.stage(t.id, paths, unstage);
      addLog(true, `${paths.length} ファイルを${unstage ? 'ステージ解除' : 'ステージ'}しました`);
      setSel(new Set());
      reload();
    } catch (e) {
      addLog(false, `${unstage ? 'ステージ解除' : 'ステージ'}に失敗: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ステージ済みが無いときは、選んだ未ステージのファイルをコミット時にステージする(contract の paths)
  const commitPaths = t.staged.length === 0 && selWork.length > 0 ? selWork : undefined;
  const commitCount = t.staged.length || commitPaths?.length || 0;
  const subject = message.split('\n')[0];
  const canCommit = !busy && message.trim().length > 0 && commitCount > 0;

  const commit = async (force = false) => {
    if (!message.trim()) return;
    setBusy('commit');
    setConflict(null);
    try {
      await projectApi.commit({ target: t.id, message: message.trim(), paths: commitPaths, force: force || undefined });
      addLog(true, `コミットしました: ${subject.trim()}`);
      setMessage('');
      setSel(new Set());
      reload();
    } catch (e) {
      const msg = errText(e, 'コミットに失敗しました');
      // セッションが作業中で 409 → 理由を説明して「それでもコミット」を出す(ステージが空などの 409 は出さない)
      if (isConflict(e) && !force && (working || /実行中|作業中|running|working|busy/i.test(msg)) && !/ステージ|staged|nothing|空/i.test(msg)) {
        setConflict(msg);
      } else addLog(false, `コミットに失敗: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const defaultBranch = defaultBranchOf(t, repoDefault);
  const unpushedCommits = t.commits.filter((c) => !c.pushed);

  const fileRow = (sec: Section, path: string, f?: FileChange) => {
    const k = `${sec}|${path}`;
    const st = f?.status ?? '?';
    const on = preview?.path === path && preview.section === sec;
    return (
      <li key={k} className={`gfile ${on ? 'on' : ''}`}>
        <input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} aria-label={`選択: ${path}`} />
        <button className="gfile-main" onClick={() => setPreview(on ? null : { path, section: sec })} aria-pressed={on} title={f?.from ? `${f.from} → ${path}` : path}>
          <span className={`fstat fs-${st === '?' ? 'u' : st}`}>{CHANGE_LABEL[st]}</span>
          <span className="gfile-path mono">
            {path.includes('/') && <span className="art-dir">{path.slice(0, path.lastIndexOf('/') + 1)}</span>}
            {path.slice(path.lastIndexOf('/') + 1)}
          </span>
          {f && (
            <span className="diffstat" aria-label={`追加 ${f.additions} 行 削除 ${f.deletions} 行`}>
              <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
            </span>
          )}
        </button>
      </li>
    );
  };

  const section = (sec: Section, items: { path: string; f?: FileChange }[]) => {
    const n = items.length;
    const nSel = selIn(sec).length;
    return (
      <section className={`gsec gsec-${sec}`} aria-label={SECTION_LABEL[sec]}>
        <div className="gsec-head">
          <label className="gsec-all">
            <input
              type="checkbox"
              checked={n > 0 && nSel === n}
              ref={(el) => {
                if (el) el.indeterminate = nSel > 0 && nSel < n;
              }}
              disabled={n === 0}
              onChange={(e) => setSection(sec, e.target.checked)}
              aria-label={`${SECTION_LABEL[sec]}をすべて選択`}
            />
            <span className="gsec-title">{SECTION_LABEL[sec]}</span>
          </label>
          <span className="count-pill">{n}</span>
          <span className="spacer" />
          {n > 0 &&
            (sec === 'staged' ? (
              <button className="btn sm ghost" disabled={!!busy} onClick={() => void stage(items.map((x) => x.path), true)}>
                すべて解除
              </button>
            ) : (
              <button className="btn sm ghost" disabled={!!busy} onClick={() => void stage(items.map((x) => x.path), false)}>
                すべてステージ
              </button>
            ))}
        </div>
        {n === 0 ? <div className="gsec-empty muted small">なし</div> : <ul className="gfiles">{items.map((x) => fileRow(sec, x.path, x.f))}</ul>}
      </section>
    );
  };

  const previewEl = preview && (
    <FilePreview
      key={`${preview.section}|${preview.path}`}
      targetId={t.id}
      path={preview.path}
      kind={kindOf(preview.path)}
      deleted={files.get(`${preview.section}|${preview.path}`)?.f?.status === 'D'}
      untracked={preview.section === 'untracked'}
      staged={preview.section === 'staged'}
      initialMode="diff"
      onClose={() => setPreview(null)}
    />
  );

  return (
    <>
      <div className="rp-card tgt-info">
        <div className="tgt-info-row">
          <span className="mono strong">{t.label}</span>
          {t.branch ? <span className="mono git-branch-inline">{t.branch}</span> : <span className="muted">(ブランチなし / detached)</span>}
          {t.upstream ? (
            <span className="muted small" title="追跡ブランチ">
              → {t.upstream}
            </span>
          ) : (
            t.branch && <span className="tag">未 push(追跡ブランチなし)</span>
          )}
          <span className="gstat" title={`${t.baseRef ?? 'base'} より進んでいる / 遅れているコミット数`}>
            ↑{t.ahead} ↓{t.behind}
          </span>
          {t.unpushed > 0 && <span className="gstat warn">未 push <b>{t.unpushed}</b></span>}
          <span className="spacer" />
          {session && (
            <button className="wt-session" onClick={() => open(session.id)} title="セッションを開く">
              <StatusBadge status={session.status} />
              <span className="pr-session-name">{session.name}</span>
            </button>
          )}
        </div>
        <div className="muted small mono break">{t.path}</div>
        {working && (
          <div className="git-warn" role="note">
            ⚠ このフォルダでは Claude が作業中です。コミットすると作業途中の変更が混ざることがあります。
          </div>
        )}
      </div>

      <div className={`git-grid ${mobile ? 'is-mobile' : ''}`}>
        <div className="git-col">
          {section('staged', t.staged.map((f) => ({ path: f.path, f })))}
          <div className="gstage-bar">
            <button className="btn sm" disabled={!!busy || selWork.length === 0} onClick={() => void stage(selWork, false)}>
              {busy === 'stage' ? <Spinner /> : '↑'} ステージ{selWork.length ? `(${selWork.length})` : ''}
            </button>
            <button className="btn sm" disabled={!!busy || selStaged.length === 0} onClick={() => void stage(selStaged, true)}>
              {busy === 'unstage' ? <Spinner /> : '↓'} ステージ解除{selStaged.length ? `(${selStaged.length})` : ''}
            </button>
            <span className="muted small">チェックして選び、ファイル名をクリックで差分</span>
          </div>
          {section('unstaged', t.unstaged.map((f) => ({ path: f.path, f })))}
          {section('untracked', t.untracked.map((p) => ({ path: p })))}

          <section className="rp-card commit-box" aria-label="コミット">
            <label className="field">
              <span className="commit-label">
                コミットメッセージ
                <span className={`muted small commit-count ${subject.length > 72 ? 'over' : ''}`} aria-live="polite">
                  1 行目 {subject.length} 文字{subject.length > 72 ? '(72 文字以内推奨)' : ''} · 全体 {message.length} 文字
                </span>
              </span>
              <textarea
                ref={msgRef}
                rows={mobile ? 3 : 4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (canCommit) void commit();
                  }
                }}
                placeholder={'1 行目に要約(例: ログイン後のリダイレクトを修正)\n\n詳細(任意)'}
                spellCheck={false}
              />
            </label>
            {conflict && (
              <div className="warn-box commit-conflict" role="alert">
                <p>
                  <strong>コミットを保留しました。</strong> {conflict}
                </p>
                <p className="small">
                  Claude がこのフォルダで作業中のため、作業途中のファイルがコミットに入ったり、Claude 側の git 操作と衝突したりする可能性があります。
                  セッションが入力待ちになってからコミットするのが安全です。
                </p>
                <div className="ctl-row">
                  <button className="btn danger" disabled={!!busy} onClick={() => void commit(true)}>
                    それでもコミット
                  </button>
                  <button className="btn" onClick={() => setConflict(null)}>
                    やめる
                  </button>
                </div>
              </div>
            )}
            <div className="commit-foot">
              <span className="muted small">
                {t.staged.length > 0
                  ? `ステージ済み ${t.staged.length} ファイルをコミット`
                  : commitPaths
                    ? `選んだ ${commitPaths.length} ファイルをステージしてコミット`
                    : 'コミットするファイルをステージしてください'}
              </span>
              <span className="spacer" />
              <kbd className="hide-mobile">Ctrl+Enter</kbd>
              <button className="btn primary" disabled={!canCommit} onClick={() => void commit()}>
                {busy === 'commit' ? <Spinner /> : null} コミット{commitCount ? `(${commitCount})` : ''}
              </button>
              <button
                className="btn"
                disabled={!!busy || !t.branch || (t.unpushed === 0 && !!t.upstream)}
                onClick={() => setPushOpen(true)}
                title={t.unpushed === 0 && t.upstream ? 'push するコミットがありません' : 'origin に push'}
              >
                ↑ Push{t.unpushed ? `(${t.unpushed})` : ''}
              </button>
            </div>
          </section>

          {log.length > 0 && (
            <section className="git-log" aria-label="操作の結果">
              <h3 className="sec-title">操作の結果</h3>
              <ul aria-live="polite">
                {log.map((l) => (
                  <li key={l.id} className={l.ok ? 'ok' : 'ng'}>
                    <span className="git-log-ico" aria-hidden="true">
                      {l.ok ? '✓' : '✗'}
                    </span>
                    <span className="sr-only">{l.ok ? '成功' : '失敗'}</span>
                    <span className="git-log-text">{l.text}</span>
                    <span className="muted small">{new Date(l.ts).toLocaleTimeString('ja-JP')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="git-col">
          {previewEl ?? (
            <div className="rp-card muted small git-prev-empty">ファイル名をクリックすると、ここに差分を表示します。</div>
          )}
          <section className="rp-sec">
            <h3 className="sec-title">
              コミット <span className="count-pill">{t.commits.length}</span>
              {t.baseRef && <span className="muted small">({t.baseRef} から)</span>}
            </h3>
            {t.commits.length === 0 ? (
              <div className="empty small">{t.baseRef ? `${t.baseRef} からのコミットはまだありません` : 'コミットはありません'}</div>
            ) : (
              <ul className="commit-list">
                {t.commits.map((c) => (
                  <li key={c.sha} className="commit-row">
                    <span className="mono commit-sha" title={c.sha}>
                      {c.sha.slice(0, 7)}
                    </span>
                    <span className="commit-subj" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className={`cbadge ${c.pushed ? 'pushed' : 'local'}`}>{c.pushed ? '✓ push 済み' : '↑ 未 push'}</span>
                    <span className="muted small commit-meta" title={fmtDate(c.date)}>
                      {c.author} · {fmtAgo(c.date, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {pushOpen && (
        <PushModal
          t={t}
          defaultBranch={defaultBranch}
          unpushed={unpushedCommits.map((c) => c.subject)}
          onClose={() => setPushOpen(false)}
          onDone={(ok, text) => {
            addLog(ok, text);
            if (ok) {
              setPushOpen(false);
              reload();
            }
          }}
        />
      )}
    </>
  );
}

/** Push の確認(既定ブランチへの直接 push は 409 → 理由を表示し、同意のチェックで強制できる) */
function PushModal({
  t,
  defaultBranch,
  unpushed,
  onClose,
  onDone,
}: {
  t: GitTarget;
  defaultBranch: string | null;
  unpushed: string[];
  onClose: () => void;
  onDone: (ok: boolean, text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const remote = t.upstream ? t.upstream.split('/')[0] : 'origin';
  const isDefault = !!t.branch && !!defaultBranch && t.branch === defaultBranch;

  const run = async () => {
    setBusy(true);
    setErr(null);
    const force = !!blocked;
    try {
      await projectApi.push(t.id, force);
      onDone(true, `${remote}/${t.branch} に push しました${force ? '(既定ブランチへ直接)' : ''}`);
    } catch (e) {
      const msg = errText(e, 'push に失敗しました');
      if (isConflict(e) && !force) {
        setBlocked(msg);
      } else {
        setErr(msg);
        onDone(false, `push に失敗: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmModal
      title="Push の確認"
      confirmLabel={blocked ? 'それでも push する' : 'Push'}
      danger={!!blocked}
      busy={busy}
      confirmDisabled={!!blocked && !ack}
      error={err}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        <span className="mono strong">{t.branch}</span> を <span className="mono strong">{remote}</span> に push します。
      </p>
      <dl className="kv push-kv">
        <dt>リモート</dt>
        <dd className="mono">{remote}</dd>
        <dt>ブランチ</dt>
        <dd className="mono">
          {t.branch} → {t.upstream ?? `${remote}/${t.branch}(新規。追跡ブランチを作成)`}
        </dd>
        <dt>コミット</dt>
        <dd>{t.unpushed} 件</dd>
      </dl>
      {unpushed.length > 0 && (
        <ul className="push-commits">
          {unpushed.slice(0, 8).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
          {unpushed.length > 8 && <li className="muted">ほか {unpushed.length - 8} 件</li>}
        </ul>
      )}
      {isDefault && !blocked && (
        <p className="warn-box">既定ブランチ({defaultBranch})への直接 push です。通常はブランチを切って PR を作成してください。</p>
      )}
      {blocked && (
        <div className="warn-box" role="alert">
          <p>
            <strong>push を止めました:</strong> {blocked}
          </p>
          <p className="small">既定ブランチへの直接 push は、レビューや CI を通らずに共有ブランチを書き換えます。</p>
          <label className={`check-field ${ack ? 'danger-on' : ''}`}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>
              {defaultBranch ?? '既定ブランチ'} に直接 push することを理解しました
            </span>
          </label>
        </div>
      )}
    </ConfirmModal>
  );
}
