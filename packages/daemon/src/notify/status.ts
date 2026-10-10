// Discord の /status: 動いているセッション・承認待ち・アップロードの承認待ち・再起動の予約をまとめた文章。
import type { DeployJob, RestartStatus, SessionInfo } from '@cc-hub/shared';

const PER_GROUP = 10;

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatStatus(o: { sessions: SessionInfo[]; deploys: DeployJob[]; restart: RestartStatus | null; now: number }): string {
  const live = o.sessions.filter((s) => s.status !== 'stopped' && s.status !== 'error');
  const group = (label: string, list: SessionInfo[], detail: (s: SessionInfo) => string): string[] => {
    if (!list.length) return [];
    const sorted = [...list].sort((a, b) => b.lastEventAt - a.lastEventAt);
    const lines = [`${label} ${list.length}`];
    for (const s of sorted.slice(0, PER_GROUP)) {
      const d = detail(s);
      lines.push(`・**${clip(s.name, 40)}**${d ? ` — ${clip(d, 80)}` : ''}`);
    }
    if (sorted.length > PER_GROUP) lines.push(`・ほか ${sorted.length - PER_GROUP} 件`);
    return lines;
  };
  const tool = (s: SessionInfo) => (s.currentTool ? `${s.currentTool.name}${s.currentTool.target ? `: ${s.currentTool.target}` : ''}` : '');
  const out: string[] = [`**CC Hub の状況**`];
  const sections = [
    group('⏳ 承認待ち', live.filter((s) => s.status === 'awaiting_approval'), (s) => s.approval?.question || tool(s)),
    group('▶ 実行中', live.filter((s) => s.status === 'running' || s.status === 'starting'), tool),
    group('💬 入力待ち', live.filter((s) => s.status === 'awaiting_input' || s.status === 'idle'), (s) => ago(o.now - s.lastEventAt)),
  ].filter((x) => x.length);
  const pending = o.deploys.filter((d) => d.state === 'pending_approval' || d.state === 'preview_ready');
  if (pending.length) {
    const lines = [`📦 アップロードの承認待ち ${pending.length}`];
    for (const d of pending.slice(0, PER_GROUP)) {
      const who = d.requestedBy.kind === 'claude' ? `Claude${d.requestedBy.sessionName ? `: ${d.requestedBy.sessionName}` : ''}` : 'あなた';
      lines.push(`・**${clip(d.serverName, 40)}**(${d.state === 'preview_ready' ? 'プレビューの確認待ち' : who})`);
    }
    sections.push(lines);
  }
  if (!sections.length) out.push('動いているセッションはありません。');
  for (const s of sections) out.push('', ...s);
  const r = o.restart;
  if (r && r.state !== 'idle') {
    out.push('', r.state === 'restarting' ? '🔄 再起動しています' : `🔄 再起動の予約: 作業が終わるのを待っています${r.busy.length ? `(${r.busy.slice(0, 5).join('、')})` : ''}`);
  } else if (r?.error) {
    out.push('', `⚠ ${clip(r.error, 200)}`);
  }
  return out.join('\n');
}
