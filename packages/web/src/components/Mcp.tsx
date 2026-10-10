// MCP サーバーの接続状況(claude mcp list)。再確認は 30〜60 秒かかることがある
import type { McpServerInfo, McpStatus } from '@cc-hub/shared';
import { MCP_STATUS_ICON, MCP_STATUS_LABEL, mcpCounts, useElapsed, useMcp, useScopeCwd } from '../ext';
import { useHub } from '../store';
import { fmtAgo, projectLabel, useNow } from '../util';

/** 問題のあるものを上に */
const RANK: Record<McpStatus, number> = { failed: 0, needs_auth: 1, unknown: 2, connected: 3 };

function displayName(s: McpServerInfo): string {
  return s.origin === 'claude.ai' ? s.name.replace(/^claude\.ai\s+/, '') : s.name;
}

export function McpStatusLabel({ status }: { status: McpStatus }) {
  return (
    <span className={`mcp-st mcp-${status}`}>
      <span className="mcp-ico" aria-hidden="true">
        {MCP_STATUS_ICON[status]}
      </span>
      {MCP_STATUS_LABEL[status]}
    </span>
  );
}

export function McpView({ cwd, compact = false }: { cwd: string | null; compact?: boolean }) {
  const { data, loading, error, refresh } = useMcp(cwd);
  const now = useNow(15000);
  const elapsed = useElapsed(loading);
  const servers = [...(data?.servers ?? [])].sort((a, b) => RANK[a.status] - RANK[b.status] || displayName(a).localeCompare(displayName(b)));
  const c = mcpCounts(servers);
  return (
    <div className={`ext-view ${compact ? 'compact' : ''}`}>
      <div className="ext-head">
        {!compact && <h2 className="ext-title">MCP の接続状況</h2>}
        <span className="ext-scope" title={cwd ?? 'ユーザーのホーム'}>
          対象: <b>{cwd ? projectLabel(cwd) : 'ホーム'}</b>
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={refresh} disabled={loading} aria-busy={loading}>
          {loading && <span className="spinner" aria-hidden="true" />}
          {loading ? `確認中… ${elapsed} 秒` : '再確認'}
        </button>
      </div>
      <div className="mcp-summary-row">
        {data ? (
          <>
            <span className="mcp-count">
              <b>{c.connected}</b> / {c.total} 接続
            </span>
            {c.needs_auth > 0 && <McpChip status="needs_auth" n={c.needs_auth} />}
            {c.failed > 0 && <McpChip status="failed" n={c.failed} />}
            {c.unknown > 0 && <McpChip status="unknown" n={c.unknown} />}
            <span className="spacer" />
            {data.checkedAt && (
              <span className="muted" title={new Date(data.checkedAt).toLocaleString('ja-JP')}>
                確認 {new Date(data.checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}(
                {fmtAgo(data.checkedAt, now)})
              </span>
            )}
          </>
        ) : (
          <span className="muted">{loading ? '確認しています…' : ''}</span>
        )}
      </div>
      {loading && <p className="ext-lead">各サーバーに接続して確かめるので、30〜60 秒かかることがあります。</p>}
      {error && <div className="form-error pad">{error}</div>}
      {data && servers.length === 0 && <div className="empty small">MCP サーバーは設定されていません</div>}
      {servers.length > 0 && (
        <ul className="mcp-list">
          {servers.map((s) => (
            <li key={s.name} className={`mcp-row mcp-${s.status}`}>
              <McpStatusLabel status={s.status} />
              <span className="mcp-main">
                <span className="mcp-top">
                  <span className="mcp-name">{displayName(s)}</span>
                  <span className={`tag origin-${s.origin === 'claude.ai' ? 'cloud' : 'local'}`}>
                    {s.origin === 'claude.ai' ? 'claude.ai' : 'ローカル'}
                  </span>
                </span>
                <span className="mcp-target" title={s.target}>
                  {s.target}
                </span>
                {s.status !== 'connected' && s.statusText && <span className="mcp-text">{s.statusText}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.needs_auth > 0 && (
        <p className="ext-lead">「要認証」のサーバーは、Claude Code で /mcp を開くか claude.ai のコネクタ設定から認証してください。</p>
      )}
    </div>
  );
}

function McpChip({ status, n }: { status: McpStatus; n: number }) {
  return (
    <span className={`mcp-chip mcp-${status}`}>
      <span aria-hidden="true">{MCP_STATUS_ICON[status]}</span> {MCP_STATUS_LABEL[status]} {n}
    </span>
  );
}

/** 上部バーの要約「MCP 7/19 接続」(失敗があれば警告色)。クリックで MCP 画面 */
export function McpSummary() {
  const cwd = useScopeCwd();
  const { data, loading } = useMcp(cwd);
  const setView = useHub((s) => s.setDeskView);
  const view = useHub((s) => s.deskView);
  const c = mcpCounts(data?.servers ?? []);
  const tone = c.failed > 0 ? 'bad' : c.needs_auth > 0 ? 'warn' : data ? 'ok' : '';
  const title = data
    ? `MCP: 接続済み ${c.connected} / 要認証 ${c.needs_auth} / 失敗 ${c.failed} / 不明 ${c.unknown}`
    : 'MCP の接続状況';
  return (
    <button className={`btn mcp-sum ${tone} ${view === 'mcp' ? 'on' : ''}`} onClick={() => setView(view === 'mcp' ? 'session' : 'mcp')} title={title}>
      {loading && !data ? (
        <>
          <span className="spinner" aria-hidden="true" /> MCP
        </>
      ) : data ? (
        <>
          <span aria-hidden="true">{c.failed > 0 ? '✕' : c.needs_auth > 0 ? '!' : '✓'}</span> MCP {c.connected}/{c.total} 接続
          {c.failed > 0 && <span className="mcp-sum-bad">失敗 {c.failed}</span>}
        </>
      ) : (
        'MCP'
      )}
    </button>
  );
}
