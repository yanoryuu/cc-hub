// 履歴: ~/.claude/projects の会話(transcript)一覧 → 中身のプレビュー → CC Hub / PowerShell で再開
// デスクトップは一覧 + 右に詳細の 2 ペイン、モバイルは一覧 → 全画面の詳細。管理画面の「履歴」タブにも埋め込む
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, HistoryMessage, SessionInfo } from '@cc-hub/shared';
import { api, errText, pick } from '../api';
import { useHub } from '../store';
import { useProjectCatalog } from '../home';
import { normPath } from '../project';
import { fmtAgo, fmtDate, projectLabel } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';

const PAGE = 50;

// ---------------------------------------------------------------- データ取得

interface HistoryPage {
  items: HistoryEntry[];
  total: number | null;
  loading: boolean;
  error: string | null;
  done: boolean;
  more: () => void;
  reload: () => void;
}

/** GET /api/history を 50 件ずつ。q / cwd が変わったら最初から */
function useHistory(q: string, cwd: string | null): HistoryPage {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const seq = useRef(0);
  const busy = useRef(false);

  const load = useCallback(
    async (offset: number) => {
      const my = offset === 0 ? ++seq.current : seq.current;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (q.trim()) qs.set('q', q.trim());
        if (cwd) qs.set('cwd', cwd);
        const r = await api<{ sessions?: HistoryEntry[]; total?: number }>(`/api/history?${qs}`);
        if (my !== seq.current) return;
        const got = r.sessions ?? [];
        setItems((cur) => (offset === 0 ? got : [...cur, ...got.filter((g) => !cur.some((c) => c.id === g.id))]));
        setTotal(typeof r.total === 'number' ? r.total : null);
        setDone(got.length < PAGE || (typeof r.total === 'number' && offset + got.length >= r.total));
      } catch (e) {
        if (my === seq.current) setError(errText(e, '履歴を読み込めませんでした'));
      } finally {
        if (my === seq.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [q, cwd],
  );

  useEffect(() => {
    setItems([]);
    setDone(false);
    void load(0);
  }, [load]);

  const more = useCallback(() => {
    if (busy.current || done) return;
    void load(items.length);
  }, [done, items.length, load]);

  return { items, total, loading, error, done, more, reload: () => void load(0) };
}

/** 入力が止まって ms 後の値 */
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

// ---------------------------------------------------------------- 日付のまとまり

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms: number, now = Date.now()): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return '今日';
  if (k === dayKey(now - 86_400_000)) return '昨日';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('ja-JP', { year: sameYear ? undefined : 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function groupByDay(list: HistoryEntry[]): { key: string; label: string; items: HistoryEntry[] }[] {
  const out: { key: string; label: string; items: HistoryEntry[] }[] = [];
  for (const h of list) {
    const k = dayKey(h.mtime);
    let g = out[out.length - 1];
    if (!g || g.key !== k) {
      g = { key: k, label: dayLabel(h.mtime), items: [] };
      out.push(g);
    }
    g.items.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- 画面

/**
 * 履歴の一覧 + 詳細。
 * cwd を渡すとそのフォルダ(配下を含む)に固定(管理画面の「履歴」タブ)。渡さなければプロジェクトの絞り込みチップを出す
 */
export function HistoryView({
  cwd = null,
  mobile = false,
  embedded = false,
  mobileHead,
}: {
  cwd?: string | null;
  mobile?: boolean;
  embedded?: boolean;
  /** モバイルの一覧画面の見出し(渡すと一覧を全画面の m-screen で包む) */
  mobileHead?: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [filterCwd, setFilterCwd] = useState<string | null>(null);
  const scope = cwd ?? filterCwd;
  const h = useHistory(dq, scope);
  const [sel, setSel] = useState<string | null>(null);
  const selected = h.items.find((x) => x.id === sel) ?? null;
  const groups = useMemo(() => groupByDay(h.items), [h.items]);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // デスクトップは最初の 1 件を選んでおく(右が空にならないように)
  useEffect(() => {
    if (mobile || sel || h.items.length === 0) return;
    setSel(h.items[0].id);
  }, [mobile, sel, h.items]);

  // 一覧の末尾が見えたら次の 50 件
  useEffect(() => {
    const el = sentinel.current;
    if (!el || h.done) return;
    const io = new IntersectionObserver((ents) => ents.some((e) => e.isIntersecting) && h.more(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [h.done, h.more]);

  if (mobile && selected) {
    return <HistoryDetail key={selected.id} entry={selected} mobile onBack={() => setSel(null)} />;
  }

  const list = (
    <div className="hx-listpane">
      <div className="hx-tools">
        <input
          type="search"
          className="hx-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="タイトル・最初の発言・フォルダで検索"
          aria-label="履歴を検索"
        />
        {!cwd && <ProjectChips value={filterCwd} onChange={setFilterCwd} />}
        <div className="hx-count muted small" role="status">
          {h.total !== null ? `${h.total} 件${dq.trim() ? `(「${dq.trim()}」で検索)` : ''}` : h.loading ? '読み込み中…' : ''}
        </div>
      </div>
      <div className="hx-list">
        {h.error && (
          <div className="rp-alert error" role="alert">
            <span className="rp-alert-ico" aria-hidden="true">
              !
            </span>
            <span>
              {h.error}{' '}
              <button className="link-btn" onClick={h.reload}>
                再試行
              </button>
            </span>
          </div>
        )}
        {!h.loading && !h.error && h.items.length === 0 && (
          <div className="empty">{dq.trim() ? '一致する会話がありません' : 'このフォルダの会話はまだありません'}</div>
        )}
        {groups.map((g) => (
          <section key={g.key} className="hx-day" aria-label={g.label}>
            <h3 className="hx-day-title">{g.label}</h3>
            {g.items.map((e) => (
              <HistoryRow key={e.id} e={e} on={sel === e.id} onClick={() => setSel(e.id)} showFolder={!cwd} />
            ))}
          </section>
        ))}
        <div ref={sentinel} className="hx-more">
          {h.loading && h.items.length > 0 && (
            <>
              <Spinner /> 読み込み中…
            </>
          )}
          {!h.loading && !h.done && h.items.length > 0 && (
            <button className="btn sm" onClick={h.more}>
              さらに読み込む
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (mobile) {
    if (mobileHead === undefined) return list;
    return (
      <div className="m-screen">
        {mobileHead}
        <div className="m-scroll">{list}</div>
      </div>
    );
  }
  return (
    <div className={`hx ${embedded ? 'embedded' : ''}`}>
      {list}
      <div className="hx-detailpane">
        {selected ? (
          <HistoryDetail key={selected.id} entry={selected} mobile={false} />
        ) : (
          <div className="empty big">左の一覧から会話を選ぶと、内容を確認して再開できます</div>
        )}
      </div>
    </div>
  );
}

/** プロジェクトの絞り込み(すべて + 登録リポジトリ + フォルダ) */
function ProjectChips({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const cat = useProjectCatalog();
  const opts = useMemo(() => {
    const out: { path: string; label: string }[] = [];
    for (const r of cat.repos) out.push({ path: r.repo.baseDir, label: r.repo.name });
    // 同じ名前のリポジトリとフォルダは見分けられるように
    const used = new Set(out.map((o) => o.label));
    for (const f of cat.folders.slice(0, 10)) out.push({ path: f.path, label: used.has(f.name) ? `${f.name}(フォルダ)` : f.name });
    return out;
  }, [cat]);
  return (
    <div className="hx-chips" role="radiogroup" aria-label="プロジェクトで絞り込み">
      <button type="button" role="radio" aria-checked={value === null} className={`chip ${value === null ? 'on' : ''}`} onClick={() => onChange(null)}>
        すべて
      </button>
      {opts.map((o) => {
        const on = value !== null && normPath(value) === normPath(o.path);
        return (
          <button type="button" role="radio" aria-checked={on} key={o.path} className={`chip ${on ? 'on' : ''}`} onClick={() => onChange(on ? null : o.path)} title={o.path}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function HistoryRow({ e, on, onClick, showFolder }: { e: HistoryEntry; on: boolean; onClick: () => void; showFolder: boolean }) {
  const live = useHub((s) => (e.hubSessionId ? s.sessions[e.hubSessionId] : undefined));
  return (
    <button className={`hx-row ${on ? 'on' : ''}`} onClick={onClick} aria-current={on ? 'true' : undefined}>
      <span className="hx-row-top">
        <span className="hx-title">{e.title || '(無題)'}</span>
        <span className="hx-time muted" title={fmtDate(e.mtime)}>
          {fmtAgo(e.mtime)}
        </span>
      </span>
      <span className="hx-meta">
        {showFolder && (
          <span className="chip static" title={e.cwd}>
            {projectLabel(e.cwd)}
          </span>
        )}
        {e.gitBranch && <span className="hx-branch mono">{e.gitBranch}</span>}
        {typeof e.messageCount === 'number' && <span className="muted">{e.messageCount} 発言</span>}
        {live && <span className="hx-live">CC Hub で表示中</span>}
      </span>
      {e.lastMessage && <span className="hx-last">{e.lastMessage}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- 詳細

function HistoryDetail({ entry, mobile, onBack }: { entry: HistoryEntry; mobile: boolean; onBack?: () => void }) {
  const [msgs, setMsgs] = useState<HistoryMessage[] | null>(null);
  const [full, setFull] = useState<HistoryEntry>(entry);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'hub' | 'terminal' | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [confirmPs, setConfirmPs] = useState(false);
  const live = useHub((s) => (full.hubSessionId ? s.sessions[full.hubSessionId] : undefined));
  const openSession = useHub((s) => s.open);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    api(`/api/history/${encodeURIComponent(entry.id)}`)
      .then((r) => {
        if (!alive) return;
        const e = pick<HistoryEntry>(r, 'entry');
        if (e) setFull({ ...entry, ...e });
        setMsgs(pick<HistoryMessage[]>(r, 'messages') ?? []);
      })
      .catch((e) => alive && setErr(errText(e, '会話を読み込めませんでした')));
    return () => {
      alive = false;
    };
  }, [entry]);

  // 最新の発言(末尾)が見えるように
  useEffect(() => {
    if (msgs && msgs.length > 0) bottom.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const resume = async (target: 'hub' | 'terminal') => {
    setBusy(target);
    setActErr(null);
    try {
      const r = await api(`/api/history/${encodeURIComponent(entry.id)}/open`, { target });
      const s = pick<SessionInfo>(r, 'session');
      if (s && s.id) {
        const st = useHub.getState();
        st.upsertSession(s);
        st.open(s.id);
      }
      setConfirmPs(false);
    } catch (e) {
      setActErr(errText(e, '再開できませんでした'));
    } finally {
      setBusy(null);
    }
  };

  const actions = (
    <div className="hx-actions">
      {live && (
        <button className="btn" onClick={() => openSession(live.id)}>
          この画面を開く
        </button>
      )}
      <button className="btn primary" disabled={!!busy} onClick={() => void resume('hub')}>
        {busy === 'hub' ? '再開中…' : 'CC Hub で再開'}
      </button>
      {!mobile && (
        <button className="btn" disabled={!!busy} onClick={() => setConfirmPs(true)}>
          PowerShell で再開
        </button>
      )}
    </div>
  );

  const head = (
    <div className="hx-dhead">
      <h2 className="hx-dtitle">{full.title || '(無題)'}</h2>
      <div className="hx-dmeta">
        <span className="chip static" title={full.cwd}>
          {projectLabel(full.cwd)}
        </span>
        <span className="mono muted hx-dpath" title={full.cwd}>
          {full.cwd}
        </span>
        {full.gitBranch && <span className="hx-branch mono">{full.gitBranch}</span>}
        <span className="muted">
          {full.createdAt ? `${fmtDate(full.createdAt)} 〜 ` : ''}
          {fmtDate(full.mtime)}
        </span>
        {typeof full.messageCount === 'number' && <span className="muted">{full.messageCount} 発言</span>}
        {live && <span className="hx-live">CC Hub で表示中</span>}
      </div>
      {!mobile && actions}
      {actErr && <div className="form-error">{actErr}</div>}
    </div>
  );

  const body = (
    <div className="hx-msgs" aria-label="会話の内容">
      {err ? (
        <div className="form-error">{err}</div>
      ) : msgs === null ? (
        <div className="empty">
          <Spinner /> 読み込み中…
        </div>
      ) : msgs.length === 0 ? (
        <div className="empty">表示できる発言がありません</div>
      ) : (
        msgs.map((m, i) => <Msg key={i} m={m} />)
      )}
      <div ref={bottom} />
    </div>
  );

  const confirm = confirmPs && (
    <ConfirmModal
      title="PowerShell で再開"
      confirmLabel="PowerShell で開く"
      busy={busy === 'terminal'}
      error={actErr}
      onConfirm={() => void resume('terminal')}
      onClose={() => setConfirmPs(false)}
    >
      <p>
        新しい PowerShell のウィンドウで <span className="mono">claude --resume</span> を実行し、この会話を続けます。
      </p>
      <p className="muted small mono">{full.cwd}</p>
      <p className="muted small">CC Hub の一覧には「PowerShell で実行中」として表示され、あとから CC Hub に戻せます。</p>
    </ConfirmModal>
  );

  if (mobile) {
    return (
      <div className="m-screen">
        <div className="m-head">
          <button className="icon-btn back" onClick={onBack} aria-label="履歴の一覧へ戻る">
            ‹
          </button>
          <span className="m-title">
            {full.title || '(無題)'}
            <span className="m-sub muted">{projectLabel(full.cwd)}</span>
          </span>
        </div>
        <div className="m-scroll">
          <div className="hx-detail is-mobile">
            {head}
            {body}
          </div>
        </div>
        <div className="hx-mfoot">{actions}</div>
      </div>
    );
  }
  return (
    <div className="hx-detail">
      {head}
      {body}
      {confirm}
    </div>
  );
}

const ROLE_LABEL: Record<HistoryMessage['role'], string> = { user: 'あなた', assistant: 'Claude', tool: 'ツール' };

/** 発言 1 件(テキストはそのまま表示。HTML として解釈しない) */
function Msg({ m }: { m: HistoryMessage }) {
  const [open, setOpen] = useState(false);
  if (m.role === 'tool') {
    const long = m.text.length > 160;
    return (
      <div className="hx-msg tool">
        <span className="hx-tool-ico" aria-hidden="true">
          ⚙
        </span>
        <span className="hx-tool-text mono">{long && !open ? `${m.text.slice(0, 160)}…` : m.text}</span>
        {long && (
          <button className="link-btn small" onClick={() => setOpen((v) => !v)}>
            {open ? '閉じる' : '全文'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className={`hx-msg ${m.role}`}>
      <div className="hx-msg-head">
        <span className="hx-role">{ROLE_LABEL[m.role]}</span>
        {m.ts > 0 && <span className="muted small">{fmtDate(m.ts)}</span>}
      </div>
      <div className="hx-msg-text">{m.text}</div>
    </div>
  );
}
