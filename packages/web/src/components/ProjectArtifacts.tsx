// 管理画面「アーティファクト」: セッションが作成・変更したファイルの一覧とプレビュー(画像 / Markdown / コード / 差分)
import { useEffect, useMemo, useState } from 'react';
import type { Artifact, GitTarget, ProjectOverview, SessionInfo } from '@cc-hub/shared';
import { errText } from '../api';
import { CHANGE_LABEL, KIND_ICON, KIND_LABEL, fetchText, fmtSize, projectApi } from '../project';
import { renderMarkdown } from '../markdown';
import { fmtAgo } from '../pr';
import { baseName, fmtDate, useNow } from '../util';
import { Spinner } from './RepoCommon';

/** 表示する行数の上限(巨大ファイルで固まらないように) */
const MAX_LINES = 4000;

// ---------------------------------------------------------------- 差分 / コード表示(Git タブと共用)

/** unified diff の表示(行頭の + / − を残すので色だけに頼らない) */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="empty small">差分はありません</div>;
  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className="code-view diff-view" role="region" aria-label="差分">
      <pre>
        {shown.map((l, i) => {
          const cls = l.startsWith('@@')
            ? 'hunk'
            : l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
              ? 'meta'
              : l.startsWith('+')
                ? 'add'
                : l.startsWith('-')
                  ? 'del'
                  : '';
          return (
            <span key={i} className={`dl ${cls}`}>
              {l || ' '}
              {'\n'}
            </span>
          );
        })}
      </pre>
      {lines.length > MAX_LINES && <div className="muted small code-more">… 残り {lines.length - MAX_LINES} 行は省略しました</div>}
    </div>
  );
}

/** 行番号付きのテキスト表示 */
export function CodeView({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, MAX_LINES);
  const w = String(shown.length).length;
  return (
    <div className="code-view" role="region" aria-label="ファイルの内容">
      <pre style={{ ['--ln-w' as string]: `${w + 1}ch` }}>
        {shown.map((l, i) => (
          <span key={i} className="cl">
            <span className="ln" aria-hidden="true">
              {i + 1}
            </span>
            {l || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
      {lines.length > MAX_LINES && <div className="muted small code-more">… 残り {lines.length - MAX_LINES} 行は省略しました</div>}
    </div>
  );
}

// ---------------------------------------------------------------- プレビュー

type PreviewMode = 'content' | 'diff';

export function FilePreview({
  targetId,
  path,
  kind,
  deleted,
  untracked,
  staged,
  initialMode,
  onClose,
}: {
  targetId: string;
  path: string;
  kind: Artifact['kind'];
  /** 削除されたファイル(中身は無いので差分のみ) */
  deleted?: boolean;
  /** 未追跡(差分は全行追加) */
  untracked?: boolean;
  /** ステージ済みの差分を見る */
  staged?: boolean;
  /** 最初に出す表示(Git タブは差分から) */
  initialMode?: PreviewMode;
  onClose?: () => void;
}) {
  const first: PreviewMode = deleted ? 'diff' : initialMode ?? 'content';
  const [mode, setMode] = useState<PreviewMode>(first);
  const [text, setText] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mdSource, setMdSource] = useState(false);
  const url = projectApi.fileUrl(targetId, path);

  useEffect(() => {
    setMode(first);
    setText(null);
    setDiff(null);
    setErr(null);
    setMdSource(false);
  }, [targetId, path, deleted]);

  useEffect(() => {
    let alive = true;
    if (mode === 'content' && kind !== 'image' && text === null) {
      setLoading(true);
      fetchText(url)
        .then((t) => alive && setText(t))
        .catch((e) => alive && setErr(errText(e, '読み込めませんでした')))
        .finally(() => alive && setLoading(false));
    } else if (mode === 'diff' && diff === null) {
      setLoading(true);
      projectApi
        .diff(targetId, path, !!staged)
        .then((d) => alive && setDiff(d))
        .catch((e) => alive && setErr(errText(e, '差分を取得できませんでした')))
        .finally(() => alive && setLoading(false));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetId, path, kind, staged]);

  // Markdown の相対リンク / 画像は同じターゲットのファイルとして開く
  const resolve = (rel: string): string | null => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const parts = `${dir}${rel.split(/[?#]/)[0]}`.split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.length ? projectApi.fileUrl(targetId, out.join('/')) : null;
  };

  return (
    <div className="fprev">
      <div className="fprev-head">
        <span className="fprev-path mono" title={path}>
          {path}
        </span>
        <span className="spacer" />
        <div className="seg small" role="tablist" aria-label="表示">
          <button role="tab" aria-selected={mode === 'content'} className={mode === 'content' ? 'on' : ''} disabled={deleted} onClick={() => setMode('content')}>
            内容
          </button>
          <button role="tab" aria-selected={mode === 'diff'} className={mode === 'diff' ? 'on' : ''} onClick={() => setMode('diff')}>
            差分
          </button>
        </div>
        {kind === 'markdown' && mode === 'content' && (
          <button className="btn sm ghost" aria-pressed={mdSource} onClick={() => setMdSource((v) => !v)}>
            {mdSource ? '整形して表示' : 'ソース'}
          </button>
        )}
        {!deleted && (
          <>
            <a className="btn sm" href={url} target="_blank" rel="noreferrer" title="新しいタブで開く">
              開く ↗
            </a>
            <a className="btn sm" href={url} download={baseName(path)} title="ダウンロード">
              ↓ 保存
            </a>
          </>
        )}
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="プレビューを閉じる">
            ✕
          </button>
        )}
      </div>
      <div className="fprev-body">
        {err ? (
          <div className="form-error pad" role="alert">
            {err}
          </div>
        ) : loading ? (
          <div className="empty small">
            <Spinner /> 読み込み中…
          </div>
        ) : mode === 'diff' ? (
          diff !== null && (
            <>
              {untracked && <div className="muted small fprev-note">未追跡のファイル(すべて追加)</div>}
              <DiffView diff={diff} />
            </>
          )
        ) : kind === 'image' ? (
          <div className="fprev-img">
            <img src={url} alt={path} />
          </div>
        ) : text === null ? null : kind === 'markdown' && !mdSource ? (
          <div className="md-body">{renderMarkdown(text, resolve)}</div>
        ) : (
          <CodeView text={text} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 一覧

type CommitFilter = 'all' | 'uncommitted' | 'committed';

export function ArtifactsTab({
  data,
  sessions,
  mobile,
}: {
  data: ProjectOverview;
  sessions: Record<string, SessionInfo>;
  mobile: boolean;
}) {
  const now = useNow(30000);
  const [target, setTarget] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [kind, setKind] = useState<'' | Artifact['kind']>('');
  const [committed, setCommitted] = useState<CommitFilter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const targets = useMemo(() => {
    const m: Record<string, GitTarget> = {};
    for (const t of data.targets) m[t.id] = t;
    return m;
  }, [data.targets]);

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return data.artifacts
      .filter(
        (a) =>
          (!target || a.targetId === target) &&
          (!sessionId || a.sessionId === sessionId) &&
          (!kind || a.kind === kind) &&
          (committed === 'all' || (committed === 'committed') === a.committed) &&
          (!qq || a.path.toLowerCase().includes(qq)),
      )
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  }, [data.artifacts, target, sessionId, kind, committed, q]);

  const keyOf = (a: Artifact) => `${a.targetId}|${a.path}`;
  const selected = sel ? data.artifacts.find((a) => keyOf(a) === sel) ?? null : null;
  const sessionIds = [...new Set(data.artifacts.map((a) => a.sessionId).filter((x): x is string => !!x))];
  const kinds = [...new Set(data.artifacts.map((a) => a.kind))];
  const counts = { image: 0, markdown: 0, code: 0, data: 0, other: 0 } as Record<Artifact['kind'], number>;
  for (const a of data.artifacts) counts[a.kind]++;

  if (data.artifacts.length === 0) {
    return <div className="rp-empty">まだセッションが作成・変更したファイルはありません。</div>;
  }

  const preview = selected && (
    <FilePreview
      key={sel}
      targetId={selected.targetId}
      path={selected.path}
      kind={selected.kind}
      deleted={selected.status === 'D'}
      untracked={selected.status === '?'}
      onClose={() => setSel(null)}
    />
  );

  // スマホ: プレビューは一覧の代わりに全幅で
  if (mobile && selected) {
    return (
      <div className="art-mobile-prev">
        <button className="btn ghost sm" onClick={() => setSel(null)}>
          ‹ 一覧へ戻る
        </button>
        {preview}
      </div>
    );
  }

  return (
    <div className={`art-layout ${selected ? 'has-prev' : ''}`}>
      <div className="art-list-col">
        <div className="art-filters" role="group" aria-label="絞り込み">
          <label className="mini-field">
            <span>作業ツリー</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">すべて</option>
              {data.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.branch ? ` (${t.branch})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>セッション</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">すべて</option>
              {sessionIds.map((id) => (
                <option key={id} value={id}>
                  {sessions[id]?.name ?? id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>種類</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as '' | Artifact['kind'])}>
              <option value="">すべて</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}({counts[k]})
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>コミット</span>
            <select value={committed} onChange={(e) => setCommitted(e.target.value as CommitFilter)}>
              <option value="all">すべて</option>
              <option value="uncommitted">未コミット</option>
              <option value="committed">コミット済み</option>
            </select>
          </label>
          <label className="mini-field grow">
            <span>パス</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ファイル名で絞り込み" spellCheck={false} />
          </label>
        </div>
        <div className="muted small art-count" aria-live="polite">
          {list.length} / {data.artifacts.length} 件
        </div>
        {list.length === 0 ? (
          <div className="empty small">条件に合うファイルはありません</div>
        ) : (
          <ul className="art-list">
            {list.map((a) => {
              const k = keyOf(a);
              const t = targets[a.targetId];
              const s = a.sessionId ? sessions[a.sessionId] : undefined;
              return (
                <li key={k}>
                  <button className={`art-row ${sel === k ? 'on' : ''}`} aria-current={sel === k} onClick={() => setSel(sel === k ? null : k)}>
                    <span className={`art-kind k-${a.kind}`} title={KIND_LABEL[a.kind]} aria-label={KIND_LABEL[a.kind]}>
                      {KIND_ICON[a.kind]}
                    </span>
                    <span className="art-main">
                      <span className="art-path mono" title={a.path}>
                        <span className="art-dir">{a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/') + 1) : ''}</span>
                        <span className="art-file">{baseName(a.path)}</span>
                      </span>
                      <span className="art-meta">
                        <span className={`fstat fs-${a.status === '?' ? 'u' : a.status}`}>{CHANGE_LABEL[a.status]}</span>
                        <span className={`tag ${a.committed ? '' : 'uncommitted'}`}>{a.committed ? 'コミット済み' : '未コミット'}</span>
                        {t && <span className="muted">{t.label}</span>}
                        {s && <span className="muted art-sess">{s.name}</span>}
                      </span>
                    </span>
                    <span className="art-right">
                      <span className="mono small">{a.status === 'D' ? '—' : fmtSize(a.size)}</span>
                      <span className="muted small" title={fmtDate(a.mtime)}>
                        {fmtAgo(a.mtime, now)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selected ? (
        <div className="art-prev-col">{preview}</div>
      ) : (
        !mobile && <div className="art-prev-col art-prev-empty muted">ファイルを選ぶと、ここに内容(画像・Markdown・コード)と差分を表示します</div>
      )}
    </div>
  );
}
