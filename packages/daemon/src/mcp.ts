// MCP サーバーの一覧と接続状態(claude mcp list の出力を解析する)。
// 出力の行: "<name>: <target> - <記号> <状態>"(例: "image-gen: npx -y @lpenguin/openai-image-mcp - ✔ Connected")
// cwd ごとに 2 分キャッシュし、同時の呼び出しはまとめる(claude mcp list は全サーバーに接続を試すので遅い)。
import path from 'node:path';
import type { McpServerInfo, McpStatus } from '@cc-hub/shared';
import { run, tail } from './repo/exec';

const CACHE_MS = 2 * 60_000;
const TIMEOUT_MS = 60_000;

/** 状態表示の先頭の記号から状態を決める */
function statusOf(symbol: string, text: string): McpStatus {
  if (/[✔✓]/.test(symbol)) return 'connected';
  if (/[!⚠]/.test(symbol)) return 'needs_auth';
  if (/[✗✘×]/.test(symbol)) return 'failed';
  // 記号が無い / 未知の場合は文言で判定
  if (/^connected$/i.test(text)) return 'connected';
  if (/auth/i.test(text)) return 'needs_auth';
  if (/fail|error/i.test(text)) return 'failed';
  return 'unknown';
}

/** 1 行を解析する。サーバーの行でなければ null */
export function parseMcpLine(line: string): McpServerInfo | null {
  const l = String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!l) return null;
  const sep = l.indexOf(': ');
  const dash = l.lastIndexOf(' - ');
  if (sep <= 0 || dash <= sep) return null;
  const name = l.slice(0, sep).trim();
  const target = l.slice(sep + 2, dash).trim();
  const st = l.slice(dash + 3).trim();
  // 先頭の記号(異体字セレクタ U+FE0F を含む)と状態の文言
  const m = /^([^\p{L}\p{N}\s]+)\s*(.*)$/u.exec(st);
  const symbol = m ? m[1] : '';
  const statusText = (m ? m[2] : st).trim();
  if (!name || !statusText) return null;
  return {
    name,
    target,
    status: statusOf(symbol, statusText),
    statusText,
    origin: name.startsWith('claude.ai ') ? 'claude.ai' : 'local',
  };
}

export function parseMcpList(out: string): McpServerInfo[] {
  const servers: McpServerInfo[] = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const s = parseMcpLine(line);
    if (s) servers.push(s);
  }
  return servers;
}

export type McpResult = { ok: true; servers: McpServerInfo[]; checkedAt: number } | { ok: false; error: string };

const cache = new Map<string, { ok: true; servers: McpServerInfo[]; checkedAt: number }>();
const inflight = new Map<string, Promise<McpResult>>();

/** claude mcp list を cwd で実行する(環境変数は CLAUDE* を除く。60 秒でタイムアウト) */
export function listMcp(claudePath: string, cwd: string, refresh = false): Promise<McpResult> {
  const key = path.resolve(cwd).toLowerCase();
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.checkedAt < CACHE_MS) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async (): Promise<McpResult> => {
    const r = await run(claudePath, ['mcp', 'list'], { cwd, timeout: TIMEOUT_MS });
    if (r.code !== 0) {
      return { ok: false, error: `claude mcp list に失敗しました (code ${r.code}): ${tail(r, 600)}` };
    }
    const res = { ok: true as const, servers: parseMcpList(r.stdout), checkedAt: Date.now() };
    cache.set(key, res);
    return res;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
