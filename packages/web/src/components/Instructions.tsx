// プロジェクトの共通の指示: 管理画面の「共通の指示」タブ(編集・行数の警告・Claude に書き直してもらう)と、ホームのカードの小さな表示
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectInstructions } from '@cc-hub/shared';
import type { ProjectRoute } from '../store';
import { errText } from '../api';
import {
  LINE_LIMIT,
  LINE_MSG,
  type LineTone,
  countLines,
  foldDiff,
  instructionsApi,
  lineDiff,
  lineTone,
  noteInstructionsLines,
  useInstructionsLines,
} from '../ops';
import { fmtAgo, fmtDate } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';

type Key = Pick<ProjectRoute, 'repoId' | 'cwd'>;

/** 行数のメーター: 「185 / 200 行」+ 状態の文 */
function LineMeter({ n, tone, compact = false }: { n: number; tone: LineTone; compact?: boolean }) {
  const pct = Math.min(100, (n / LINE_LIMIT) * 100);
  return (
    <div className={`ins-meter t-${tone} ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <span className="ins-count">
        <b>{n}</b> / {LINE_LIMIT} 行
      </span>
      <span className="ins-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      {LINE_MSG[tone] && (
        <span className="ins-msg">
          <span aria-hidden="true">{tone === 'over' ? '✗ ' : '⚠ '}</span>
          {LINE_MSG[tone]}
        </span>
      )}
    </div>
  );
}

/** 行番号付きのエディタ(textarea と行番号の列をスクロールで同期) */
function LineEditor({ value, onChange, tone }: { value: string; onChange: (v: string) => void; tone: LineTone }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = Math.max(1, value.split('\n').length);
  const nums = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1), [lines]);
  return (
    <div className={`ins-editor t-${tone}`}>
      <div className="ins-gutter mono" ref={gutter} aria-hidden="true">
        {nums.map((i) => (
          <div key={i} className={i > LINE_LIMIT ? 'over' : ''}>
            {i}
          </div>
        ))}
      </div>
      <textarea
        className="ins-text mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        spellCheck={false}
        wrap="off"
        aria-label="共通の指示"
        placeholder={'# このプロジェクトの共通の指示\n- テストは npm test で回す\n- コミットメッセージは日本語で'}
      />
    </div>
  );
}

/** 案と現在の差分(unified。変更のまわり 3 行だけ表示) */
function ProposalDiff({ before, after }: { before: string; after: string }) {
  const [full, setFull] = useState(false);
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const rows = useMemo(() => (full ? diff : foldDiff(diff, 3)), [diff, full]);
  const add = diff.filter((d) => d.kind === 'add').length;
  const del = diff.filter((d) => d.kind === 'del').length;
  return (
    <div className="ins-diff">
      <div className="ins-diff-head">
        <span className="diffstat">
          <span className="add">+{add}</span> <span className="del">−{del}</span>
        </span>
        <span className="muted small">行</span>
        <span className="spacer" />
        <button className="link-btn" onClick={() => setFull((v) => !v)}>
          {full ? '変更のまわりだけ表示' : 'すべての行を表示'}
        </button>
      </div>
      {add + del === 0 ? (
        <div className="empty small">変更はありません</div>
      ) : (
        <div className="code-view diff-view ins-diff-body" role="region" aria-label="書き直し案の差分">
          <pre>
            {rows.map((r, i) =>
              r.kind === 'skip' ? (
                <span key={i} className="dl hunk">
                  … {r.count} 行(変更なし)
                </span>
              ) : (
                <span key={i} className={`dl ${r.kind === 'same' ? '' : r.kind}`}>
                  <span className="dn">{r.a ?? ''}</span>
                  <span className="dn">{r.b ?? ''}</span>
                  <span className="dsign" aria-label={r.kind === 'add' ? '追加' : r.kind === 'del' ? '削除' : undefined}>
                    {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                  </span>
                  {r.text || ' '}
                </span>
              ),
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

export function InstructionsTab({ route, mobile }: { route: Key; mobile: boolean }) {
  const [data, setData] = useState<ProjectInstructions | null>(null);
  const [text, setText] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ content: string; from: 'editor' | 'proposal' } | null>(null);
  // Claude に書いてもらう
  const [req, setReq] = useState('');
  const [rewriting, setRewriting] = useState(false);
  const [rwErr, setRwErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ text: string; request: string } | null>(null);

  const dirty = !!data && text !== data.content;
  // エディタの内容のもとになった版(編集中に Claude が書き換えたかの判定用)
  const [baseAt, setBaseAt] = useState<number | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(
    async (quiet = false) => {
      try {
        const r = await instructionsApi.get(route);
        if (!r) throw new Error('共通の指示を取得できませんでした');
        setData((cur) => {
          // 編集中は上書きしない(Claude が書き換えたら下に知らせる)
          if (!dirtyRef.current || !cur) {
            setText(r.content);
            setBaseAt(r.updatedAt);
          }
          return r;
        });
        noteInstructionsLines(route, r.lineCount ?? countLines(r.content));
        setLoadErr(null);
      } catch (e) {
        if (!quiet) setLoadErr(errText(e, '共通の指示を取得できませんでした'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route.repoId, route.cwd],
  );

  // 表示中は 15 秒ごとに取り直す(セッションの中で Claude が書き換えることがあるため)
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(true), 15000);
    return () => clearInterval(t);
  }, [load]);

  const n = countLines(text);
  const tone = lineTone(n);

  const doSave = async (content: string) => {
    setSaving(true);
    setSaveErr(null);
    setSavedMsg(null);
    try {
      const r = await instructionsApi.put(route, content);
      const next = r ?? { ...(data as ProjectInstructions), content, lineCount: countLines(content), updatedAt: Date.now(), updatedBy: 'user' as const };
      setData(next);
      setText(next.content);
      setBaseAt(next.updatedAt);
      setProposal(null);
      setSavedMsg(next.warning ? `保存しました(${next.warning})` : '保存しました');
    } catch (e) {
      setSaveErr(errText(e, '保存に失敗しました'));
    } finally {
      setSaving(false);
    }
  };

  const save = (content: string, from: 'editor' | 'proposal') => {
    if (lineTone(countLines(content)) === 'over') setConfirm({ content, from });
    else void doSave(content);
  };

  const rewrite = async () => {
    const q = req.trim();
    if (!q || !data) return;
    setRewriting(true);
    setRwErr(null);
    setProposal(null);
    try {
      const r = await instructionsApi.rewrite(route, q);
      if (!r.proposal.trim() && data.content.trim()) throw new Error('案が空でした。依頼の書き方を変えてもう一度試してください');
      setProposal({ text: r.proposal, request: q });
    } catch (e) {
      setRwErr(errText(e, '書き直しに失敗しました'));
    } finally {
      setRewriting(false);
    }
  };

  if (loadErr && !data)
    return (
      <div className="rp-alert error" role="alert">
        <span className="rp-alert-ico" aria-hidden="true">
          !
        </span>
        <span>
          {loadErr}{' '}
          <button className="link-btn" onClick={() => void load()}>
            再試行
          </button>
        </span>
      </div>
    );
  if (!data)
    return (
      <div className="empty">
        <Spinner /> 読み込み中…
      </div>
    );

  const remoteChanged = dirty && data.updatedAt !== baseAt && data.updatedBy === 'claude';
  const pTone = proposal ? lineTone(countLines(proposal.text)) : 'ok';

  return (
    <div className={`ins ${mobile ? 'is-mobile' : ''}`}>
      <div className="ins-explain">
        <p>
          CC Hub から起動するこのプロジェクトのセッションに自動で渡されます。セッションの中で『共通の指示に〇〇を追加して』と頼むと、Claude が書き換えます。
        </p>
        <p className="muted small">長すぎると毎回のやりとりが重くなります。{LINE_LIMIT} 行程度までに、守ってほしいことを短く書くのがおすすめです。</p>
      </div>

      <div className="ins-grid">
        <section className="ins-edit-col" aria-label="共通の指示の編集">
          <div className="ins-toolbar">
            <LineMeter n={n} tone={tone} />
            <span className="spacer" />
            <span className="muted small ins-updated" title={data.updatedAt ? fmtDate(data.updatedAt) : undefined}>
              {data.updatedAt ? (
                <>
                  最終更新 {data.updatedBy === 'claude' ? 'Claude' : data.updatedBy === 'user' ? 'あなた' : ''}・{fmtAgo(data.updatedAt)}
                </>
              ) : (
                'まだ保存していません'
              )}
            </span>
          </div>
          {remoteChanged && <div className="rp-alert warn small">編集中に Claude が共通の指示を書き換えました。保存するとあなたの内容で上書きされます。</div>}
          <LineEditor value={text} onChange={setText} tone={tone} />
          <div className="ins-actions">
            {saveErr && <span className="form-error inline">{saveErr}</span>}
            {savedMsg && !dirty && <span className="ok-text">✓ {savedMsg}</span>}
            {dirty && <span className="warn-text small">未保存の変更があります</span>}
            <span className="spacer" />
            {dirty && (
              <button
                className="btn"
                onClick={() => {
                  setText(data.content);
                  setBaseAt(data.updatedAt);
                }}
                disabled={saving}
              >
                元に戻す
              </button>
            )}
            <button className={`btn primary ${tone === 'over' ? 'warn-save' : ''}`} onClick={() => save(text, 'editor')} disabled={!dirty || saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </section>

        <section className="ins-ai rp-card" aria-labelledby="ins-ai-h">
          <h3 id="ins-ai-h" className="set-h">
            Claude に書いてもらう
          </h3>
          <p className="muted small">やってほしい変更を書くと、Claude が共通の指示を書き直した案を作ります。差分を見てから保存できます。</p>
          <textarea
            className="ins-req"
            rows={3}
            value={req}
            onChange={(e) => setReq(e.target.value)}
            placeholder="例: テストは必ず npm test で回す、を追加して / 重複している項目をまとめて 150 行以内にして"
            aria-label="Claude への依頼"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void rewrite();
              }
            }}
          />
          <div className="ins-actions">
            {dirty && <span className="hint">保存済みの内容をもとに書き直します(編集中の変更は使われません)</span>}
            <span className="spacer" />
            <button className="btn primary" onClick={() => void rewrite()} disabled={!req.trim() || rewriting}>
              {rewriting ? (
                <>
                  <Spinner /> 書き直しています…
                </>
              ) : (
                '案を作る'
              )}
            </button>
          </div>
          {rwErr && <div className="form-error">{rwErr}</div>}
        </section>
      </div>

      {proposal && (
        <section className="rp-card ins-proposal" aria-labelledby="ins-prop-h">
          <div className="ins-prop-head">
            <h3 id="ins-prop-h" className="set-h">
              書き直しの案
            </h3>
            <span className="muted small ins-prop-req">「{proposal.request}」</span>
          </div>
          <LineMeter n={countLines(proposal.text)} tone={pTone} compact />
          <ProposalDiff before={data.content} after={proposal.text} />
          <div className="ins-actions">
            {dirty && <span className="warn-text small">保存すると編集中の変更は破棄されます</span>}
            <span className="spacer" />
            <button className="btn" onClick={() => setProposal(null)}>
              破棄
            </button>
            <button className="btn" onClick={() => void rewrite()} disabled={rewriting}>
              {rewriting ? '書き直しています…' : 'やり直す'}
            </button>
            <button className="btn primary" onClick={() => save(proposal.text, 'proposal')} disabled={saving}>
              この内容で保存
            </button>
          </div>
        </section>
      )}

      {confirm && (
        <ConfirmModal
          title={`${LINE_LIMIT} 行を超えています`}
          confirmLabel="このまま保存する"
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void doSave(c.content);
          }}
        >
          <p>
            共通の指示が <b>{countLines(confirm.content)} 行</b>あります(目安は {LINE_LIMIT} 行まで)。長いと毎回のやりとりが重くなり、大事な指示が埋もれます。
          </p>
          <p className="muted small">「Claude に書いてもらう」で「{LINE_LIMIT} 行以内に要点を絞って」と頼むこともできます。</p>
        </ConfirmModal>
      )}
    </div>
  );
}

/** ホームのカード用: 「✎ 共通の指示 185 行」(近い / 超えたら色を変える)。未記入・未対応なら出さない */
export function InstructionsChip({ project, onOpen }: { project: Key; onOpen: () => void }) {
  const n = useInstructionsLines(project);
  if (n == null || n === 0) return null;
  const tone = lineTone(n);
  return (
    <button
      className={`ins-chip t-${tone}`}
      onClick={onOpen}
      title={`共通の指示 ${n} 行(目安 ${LINE_LIMIT} 行)${LINE_MSG[tone] ? `\n${LINE_MSG[tone]}` : ''}`}
    >
      <span aria-hidden="true">📝</span> 共通の指示 <b>{n}</b> 行{tone === 'over' ? '(超過)' : ''}
    </button>
  );
}
