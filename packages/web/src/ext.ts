// スキル / MCP の取得とキャッシュ(cwd ごと)。複数の画面(右パネル・スキル画面・上部バーの要約)で共有する。
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { McpServerInfo, McpStatus, SkillInfo, SkillSource } from '@cc-hub/shared';
import { errText, extApi } from './api';
import { useHub } from './store';

// ---------------------------------------------------------------- 共通: cwd キーの小さなストア

interface Entry<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function makeCache<T>() {
  const map = new Map<string, Entry<T>>();
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    get: (k: string): Entry<T> | undefined => map.get(k),
    set: (k: string, e: Entry<T>) => {
      map.set(k, e);
      emit();
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

const EMPTY = { data: null, loading: false, error: null };

// ---------------------------------------------------------------- スキル

export const SOURCE_LABEL: Record<SkillSource, string> = {
  project: 'プロジェクト',
  user: 'ユーザー',
  plugin: 'プラグイン',
};
/** 同名のスキルがあったときの優先順(プロジェクトがユーザー設定より優先) */
const SOURCE_RANK: Record<SkillSource, number> = { project: 0, user: 1, plugin: 2 };

const skillCache = makeCache<SkillInfo[]>();

/** 名前で重複を除く(プロジェクト → ユーザー → プラグインの順で残す) */
export function dedupeSkills(list: SkillInfo[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const s of [...list].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])) {
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name));
}

export function loadSkills(cwd: string | null, force = false): void {
  const k = cwd ?? '';
  const cur = skillCache.get(k);
  if (cur && (cur.loading || (cur.data && !force))) return;
  skillCache.set(k, { data: cur?.data ?? null, loading: true, error: null });
  extApi
    .skills(cwd)
    .then((list) => skillCache.set(k, { data: dedupeSkills(list), loading: false, error: null }))
    .catch((e) => skillCache.set(k, { data: cur?.data ?? null, loading: false, error: errText(e, 'スキルを取得できませんでした') }));
}

/** cwd のスキル一覧(最初に使われたときに取得) */
export function useSkills(cwd: string | null): Entry<SkillInfo[]> & { reload: () => void } {
  const k = cwd ?? '';
  const e = useSyncExternalStore(skillCache.subscribe, () => skillCache.get(k) ?? EMPTY);
  useEffect(() => loadSkills(cwd), [cwd]);
  return { ...e, reload: () => loadSkills(cwd, true) };
}

// ---------------------------------------------------------------- MCP

export interface McpResult {
  servers: McpServerInfo[];
  checkedAt: number | null;
}

export const MCP_STATUS_LABEL: Record<McpStatus, string> = {
  connected: '接続済み',
  needs_auth: '要認証',
  failed: '失敗',
  unknown: '不明',
};
export const MCP_STATUS_ICON: Record<McpStatus, string> = {
  connected: '✓',
  needs_auth: '!',
  failed: '✕',
  unknown: '?',
};

const mcpCache = makeCache<McpResult>();

export function loadMcp(cwd: string | null, refresh = false): void {
  const k = cwd ?? '';
  const cur = mcpCache.get(k);
  if (cur && (cur.loading || (cur.data && !refresh))) return;
  mcpCache.set(k, { data: cur?.data ?? null, loading: true, error: null });
  extApi
    .mcp(cwd, refresh)
    .then((r) => mcpCache.set(k, { data: r, loading: false, error: null }))
    .catch((e) => mcpCache.set(k, { data: cur?.data ?? null, loading: false, error: errText(e, 'MCP の状態を取得できませんでした') }));
}

export function useMcp(cwd: string | null): Entry<McpResult> & { refresh: () => void } {
  const k = cwd ?? '';
  const e = useSyncExternalStore(mcpCache.subscribe, () => mcpCache.get(k) ?? EMPTY);
  useEffect(() => loadMcp(cwd), [cwd]);
  return { ...e, refresh: () => loadMcp(cwd, true) };
}

export function mcpCounts(servers: McpServerInfo[]) {
  const c = { total: servers.length, connected: 0, needs_auth: 0, failed: 0, unknown: 0 };
  for (const s of servers) c[s.status]++;
  return c;
}

/** スキル / MCP の対象にする cwd: 選択中のセッションの cwd(なければ null = ユーザーのホーム) */
export function useScopeCwd(): string | null {
  return useHub((s) => (s.selectedId ? s.sessions[s.selectedId]?.cwd ?? null : null));
}

/** 再確認中の経過秒(スピナーの横に出す) */
export function useElapsed(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const t0 = Date.now();
    const t = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  return sec;
}
