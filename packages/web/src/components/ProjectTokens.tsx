// 管理画面「トークン」: プロジェクト合計(リアルタイム)/ セッションごとの横棒グラフ / 並べ替えできる表 / 全体の使用率
import { useMemo, useState } from 'react';
import type { SessionInfo } from '@cc-hub/shared';
import { useHub } from '../store';
import { type LiveTokens, type TokenRow, fmtExact, fmtTokens, tokenTotal } from '../project';
import { fmtCost } from '../util';
import { UsageMeters } from './TopBar';
import { StatusDot } from './common';

type SortKey = 'name' | 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'total' | 'costUsd';
const COLS: { k: SortKey; label: string; num: boolean }[] = [
  { k: 'name', label: 'セッション', num: false },
  { k: 'input', label: '入力', num: true },
  { k: 'output', label: '出力', num: true },
  { k: 'cacheRead', label: 'キャッシュ読取', num: true },
  { k: 'cacheCreation', label: 'キャッシュ作成', num: true },
  { k: 'total', label: '合計', num: true },
  { k: 'costUsd', label: 'コスト', num: true },
];

/** 合計の数字カード(ヘッダーとトークンタブで共用) */
export function TokenTotals({ t, live, compact = false }: { t: TokenRow; live: boolean; compact?: boolean }) {
  const cache = t.cacheRead + t.cacheCreation;
  return (
    <div className={`tok-totals ${compact ? 'compact' : ''}`} aria-live="off">
      <TokStat label="入力" v={t.input} cls="in" />
      <TokStat label="出力" v={t.output} cls="out" />
      <TokStat label="キャッシュ" v={cache} cls="cache" title={`読取 ${fmtExact(t.cacheRead)} / 作成 ${fmtExact(t.cacheCreation)}`} />
      <div className="tok-stat cost">
        <span className="tok-stat-label">コスト</span>
        <span className="tok-stat-num">{fmtCost(t.costUsd)}</span>
      </div>
      {live && (
        <span className="live-dot" title="セッションの使用量をリアルタイムに集計しています">
          <span aria-hidden="true">●</span> ライブ
        </span>
      )}
    </div>
  );
}

function TokStat({ label, v, cls, title }: { label: string; v: number; cls: string; title?: string }) {
  return (
    <div className={`tok-stat ${cls}`} title={title ?? `${label} ${fmtExact(v)} トークン`}>
      <span className="tok-stat-label">
        <span className={`tok-sw ${cls}`} aria-hidden="true" />
        {label}
      </span>
      <span className="tok-stat-num">{fmtTokens(v)}</span>
    </div>
  );
}

export function TokensTab({ tokens, sessions, mobile }: { tokens: LiveTokens; sessions: SessionInfo[]; mobile: boolean }) {
  const open = useHub((s) => s.open);
  const byId = useMemo(() => Object.fromEntries(sessions.map((s) => [s.id, s])), [sessions]);
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'total', desc: true });
  const [withCache, setWithCache] = useState(true);

  const rows = useMemo(() => {
    const list = Object.entries(tokens.bySession).map(([id, t]) => ({
      id,
      s: byId[id] as SessionInfo | undefined,
      name: byId[id]?.name ?? `(削除済み ${id.slice(0, 8)})`,
      t,
      total: tokenTotal(t),
    }));
    const val = (r: (typeof list)[number]): number | string =>
      sort.k === 'name' ? r.name : sort.k === 'total' ? r.total : r.t[sort.k];
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'string' ? va.localeCompare(vb as string, 'ja') : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
  }, [tokens.bySession, byId, sort]);

  // グラフは使用量の多い順(表の並びとは独立)
  const chart = [...rows].sort((a, b) => (withCache ? b.total - a.total : b.t.input + b.t.output - (a.t.input + a.t.output)));
  const max = Math.max(1, ...chart.map((r) => (withCache ? r.total : r.t.input + r.t.output)));

  const head = (c: (typeof COLS)[number]) => {
    const on = sort.k === c.k;
    return (
      <th key={c.k} className={c.num ? 'num' : ''} aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
        <button className="th-sort" onClick={() => setSort({ k: c.k, desc: on ? !sort.desc : c.num })}>
          {c.label}
          <span aria-hidden="true" className="th-arrow">
            {on ? (sort.desc ? '▼' : '▲') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className="tok-tab">
      <section className="rp-card">
        <h3 className="sec-title">このプロジェクトの合計</h3>
        <TokenTotals t={tokens.total} live={tokens.live} />
        <div className="muted small">
          合計 {fmtExact(tokenTotal(tokens.total))} トークン(入力 {fmtExact(tokens.total.input)} / 出力 {fmtExact(tokens.total.output)} / キャッシュ読取{' '}
          {fmtExact(tokens.total.cacheRead)} / キャッシュ作成 {fmtExact(tokens.total.cacheCreation)})
        </div>
      </section>

      <section className="rp-card">
        <h3 className="sec-title">全体の使用率(全プロジェクト共通)</h3>
        <UsageMeters compact={mobile} />
      </section>

      <section className="rp-sec">
        <div className="tok-chart-head">
          <h3 className="sec-title">セッションごとの使用量</h3>
          <span className="spacer" />
          <div className="tok-legend" aria-hidden="true">
            <span>
              <span className="tok-sw in" /> 入力
            </span>
            <span>
              <span className="tok-sw out" /> 出力
            </span>
            {withCache && (
              <span>
                <span className="tok-sw cache" /> キャッシュ
              </span>
            )}
          </div>
          <label className="check-inline">
            <input type="checkbox" checked={withCache} onChange={(e) => setWithCache(e.target.checked)} />
            キャッシュを含める
          </label>
        </div>
        {chart.length === 0 ? (
          <div className="empty small">まだ使用量のデータがありません</div>
        ) : (
          <ul className="tok-chart" aria-label="セッションごとのトークン使用量">
            {chart.map((r) => {
              const cache = r.t.cacheRead + r.t.cacheCreation;
              const sum = withCache ? r.total : r.t.input + r.t.output;
              const pct = (v: number) => `${(v / max) * 100}%`;
              const label = `${r.name}: 入力 ${fmtTokens(r.t.input)}、出力 ${fmtTokens(r.t.output)}${withCache ? `、キャッシュ ${fmtTokens(cache)}` : ''}、合計 ${fmtTokens(sum)}`;
              return (
                <li key={r.id} className="tok-bar-row">
                  <span className="tok-bar-name">
                    {r.s && <StatusDot status={r.s.status} />}
                    <span title={r.name}>{r.name}</span>
                  </span>
                  <span className="tok-bar" role="img" aria-label={label}>
                    <span className="seg-in" style={{ width: pct(r.t.input) }} />
                    <span className="seg-out" style={{ width: pct(r.t.output) }} />
                    {withCache && <span className="seg-cache" style={{ width: pct(cache) }} />}
                  </span>
                  <span className="tok-bar-nums" aria-hidden="true">
                    <span>入力 {fmtTokens(r.t.input)}</span>
                    <span>出力 {fmtTokens(r.t.output)}</span>
                    {withCache && <span>キャッシュ {fmtTokens(cache)}</span>}
                    <b>計 {fmtTokens(sum)}</b>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rp-sec">
        <h3 className="sec-title">一覧(見出しで並べ替え)</h3>
        <div className="wt-table-wrap">
          <table className="wt-table tok-table">
            <thead>
              <tr>{COLS.map(head)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.s ? (
                      <button className="wt-session" onClick={() => open(r.id)} title="セッションを開く">
                        <StatusDot status={r.s.status} />
                        <span className="pr-session-name">{r.name}</span>
                      </button>
                    ) : (
                      <span className="muted">{r.name}</span>
                    )}
                  </td>
                  <td className="num mono" title={fmtExact(r.t.input)}>
                    {fmtTokens(r.t.input)}
                  </td>
                  <td className="num mono" title={fmtExact(r.t.output)}>
                    {fmtTokens(r.t.output)}
                  </td>
                  <td className="num mono" title={fmtExact(r.t.cacheRead)}>
                    {fmtTokens(r.t.cacheRead)}
                  </td>
                  <td className="num mono" title={fmtExact(r.t.cacheCreation)}>
                    {fmtTokens(r.t.cacheCreation)}
                  </td>
                  <td className="num mono strong" title={fmtExact(r.total)}>
                    {fmtTokens(r.total)}
                  </td>
                  <td className="num mono">{fmtCost(r.t.costUsd)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <td className="strong">合計</td>
                  <td className="num mono">{fmtTokens(tokens.total.input)}</td>
                  <td className="num mono">{fmtTokens(tokens.total.output)}</td>
                  <td className="num mono">{fmtTokens(tokens.total.cacheRead)}</td>
                  <td className="num mono">{fmtTokens(tokens.total.cacheCreation)}</td>
                  <td className="num mono strong">{fmtTokens(tokenTotal(tokens.total))}</td>
                  <td className="num mono">{fmtCost(tokens.total.costUsd)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
