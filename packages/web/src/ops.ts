// 通知の設定 / アップロード先のサーバー / アップロード / プロジェクトの共通の指示: API と表示用ヘルパー
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type {
  DeployJob,
  DeployState,
  NotifySettings,
  NotifyTopic,
  ProjectInstructions,
  ServerInfo,
  ServerProtocol,
} from '@cc-hub/shared';
import { INSTRUCTIONS_LINE_LIMIT } from '@cc-hub/shared';
import { api, pick } from './api';
import { type ProjectRoute, useHub } from './store';
import { normPath, projectKey, projectQuery } from './project';

const enc = encodeURIComponent;

// ---------------------------------------------------------------- 通知

/** 設定画面のチェック項目(この順で並べる)。'test' は内部用なので出さない */
export const TOPIC_ORDER: Exclude<NotifyTopic, 'test'>[] = [
  'approval',
  'input',
  'error',
  'pr_ci_failed',
  'pr_review',
  'pr_merged',
  'deploy_request',
  'deploy_done',
];

export const TOPIC_LABEL: Record<NotifyTopic, string> = {
  approval: '承認待ち',
  input: '入力待ち',
  error: 'エラー',
  pr_ci_failed: 'CI 失敗',
  pr_review: 'レビュー・コメント',
  pr_merged: 'マージ',
  deploy_request: 'アップロードの申請',
  deploy_done: 'アップロード完了・失敗',
  test: 'テスト',
};

/** 保存時だけ使う: 新しい Webhook URL(空なら据え置き) */
export type DiscordTargetEdit = NotifySettings['discord'][number] & { webhookUrl?: string };

export const notifyApi = {
  get: async (): Promise<NotifySettings | undefined> => pick<NotifySettings>(await api('/api/notify/settings'), 'settings'),
  put: async (s: Omit<NotifySettings, 'discord'> & { discord: DiscordTargetEdit[] }): Promise<NotifySettings | undefined> =>
    pick<NotifySettings>(await api('/api/notify/settings', s, { method: 'PUT' }), 'settings'),
  test: (channel: 'windows' | 'discord' | 'approval', targetId?: string) =>
    api('/api/notify/test', targetId ? { channel, targetId } : { channel }),
};

/** Discord の Webhook URL らしいか */
export function isDiscordWebhook(u: string): boolean {
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(u.trim());
}

// ---------------------------------------------------------------- サーバー

export const PROTOCOL_LABEL: Record<ServerProtocol, string> = { ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP' };
export const DEFAULT_PORT: Record<ServerProtocol, number> = { ftp: 21, ftps: 21, sftp: 22 };

/** POST / PATCH /api/servers の本体(ServerInfo の編集項目 + secret) */
export interface ServerEdit {
  name: string;
  protocol: ServerProtocol;
  host: string;
  port: number;
  username: string;
  auth: { type: 'password' | 'key'; keyPath?: string };
  remoteDir: string;
  publicUrl: string | null;
  defaultLocalDir: string | null;
  buildCommand: string | null;
  exclude: string[];
  deleteExtra: boolean;
  note: string;
  /** パスワード or 秘密鍵のパスフレーズ。空なら送らない(据え置き) */
  secret?: string;
}

export interface ServerTestResult {
  ok: boolean;
  message: string;
  entries?: string[];
}

export const serverApi = {
  create: async (b: ServerEdit): Promise<ServerInfo | undefined> => pick<ServerInfo>(await api('/api/servers', b), 'server'),
  patch: async (id: string, b: ServerEdit): Promise<ServerInfo | undefined> =>
    pick<ServerInfo>(await api(`/api/servers/${enc(id)}`, b, { method: 'PATCH' }), 'server'),
  remove: (id: string) => api(`/api/servers/${enc(id)}`, undefined, { method: 'DELETE' }),
  /** 失敗もメッセージとして返す(ok:false の応答は例外にせず結果にする) */
  test: async (id: string): Promise<ServerTestResult> => {
    const res = await fetch(`/api/servers/${enc(id)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      // 認証切れは通常の api() に任せる(PIN 画面 → 再試行)
      const r = await api(`/api/servers/${enc(id)}/test`, {});
      return { ok: true, message: r.message ?? '接続できました', entries: r.entries };
    }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; entries?: string[] };
    return {
      ok: !!j.ok && res.ok,
      message: j.message || j.error || (res.ok ? '接続できました' : `HTTP ${res.status}`),
      entries: Array.isArray(j.entries) ? j.entries : undefined,
    };
  },
};

/** サーバーの一覧(名前順) */
export function useServerList(): ServerInfo[] {
  const servers = useHub((s) => s.servers);
  return useMemo(() => Object.values(servers).sort((a, b) => a.name.localeCompare(b.name, 'ja')), [servers]);
}

/** path が dir の中(または同じ)か */
export function isInside(path: string | null | undefined, dir: string | null | undefined): boolean {
  if (!path || !dir) return false;
  const p = normPath(path);
  const d = normPath(dir);
  return p === d || p.startsWith(`${d}\\`);
}

/** "ftp://host:21/public_html" のような短い表示 */
export function serverWhere(s: Pick<ServerInfo, 'host' | 'port' | 'protocol' | 'remoteDir'>): string {
  const def = DEFAULT_PORT[s.protocol] === s.port;
  return `${s.host}${def ? '' : `:${s.port}`}${s.remoteDir.startsWith('/') ? '' : '/'}${s.remoteDir}`;
}

// ---------------------------------------------------------------- アップロード

export const DEPLOY_STATE_LABEL: Record<DeployState, string> = {
  pending_approval: '承認待ち',
  planning: '差分を確認中',
  ready: '確認待ち',
  uploading: 'アップロード中',
  preview_ready: 'プレビュー確認待ち',
  done: '完了',
  failed: '失敗',
  rejected: '却下',
  cancelled: '中止',
};

export const DEPLOY_STATE_ICON: Record<DeployState, string> = {
  pending_approval: '⏸',
  planning: '…',
  ready: '◆',
  uploading: '↑',
  preview_ready: '◎',
  done: '✓',
  failed: '✗',
  rejected: '⊘',
  cancelled: '⊘',
};

export function isDeployActive(d: DeployJob): boolean {
  return d.state === 'planning' || d.state === 'ready' || d.state === 'uploading';
}

export function isDeployFinished(d: DeployJob): boolean {
  return d.state === 'done' || d.state === 'failed' || d.state === 'rejected' || d.state === 'cancelled';
}

export const deployApi = {
  create: async (b: { serverId: string; localDir?: string; buildCommand?: string; dryRun?: boolean }): Promise<DeployJob | undefined> =>
    pick<DeployJob>(await api('/api/deploys', b), 'deploy'),
  start: (id: string) => api(`/api/deploys/${enc(id)}/start`, {}),
  approve: (id: string) => api(`/api/deploys/${enc(id)}/approve`, {}),
  reject: (id: string, reason?: string) => api(`/api/deploys/${enc(id)}/reject`, reason ? { reason } : {}),
  cancel: (id: string) => api(`/api/deploys/${enc(id)}/cancel`, {}),
  /** Firebase: preview_ready のプレビューを本番(live)へ */
  promote: (id: string) => api(`/api/deploys/${enc(id)}/promote`, {}),
};

/** レスポンスに deploy があればストアに入れる(WS の deploy.upsert より先に画面を進めるため) */
export function takeDeploy(r: unknown): void {
  const d = pick<DeployJob>(r, 'deploy');
  if (d && typeof d === 'object' && 'id' in d && d.id) useHub.getState().upsertDeploy(d);
}

/** Claude からの申請(承認待ち)。古い順 */
export function usePendingDeploys(): DeployJob[] {
  const deploys = useHub((s) => s.deploys);
  return useMemo(
    () => Object.values(deploys).filter((d) => d.state === 'pending_approval').sort((a, b) => a.createdAt - b.createdAt),
    [deploys],
  );
}

/** あなたの対応待ち: Claude からの申請(承認待ち)+ Firebase のプレビュー確認待ち(本番に反映 / 破棄)。古い順 */
export function useAttentionDeploys(): DeployJob[] {
  const deploys = useHub((s) => s.deploys);
  return useMemo(
    () =>
      Object.values(deploys)
        .filter((d) => d.state === 'pending_approval' || d.state === 'preview_ready')
        .sort((a, b) => a.createdAt - b.createdAt),
    [deploys],
  );
}

/** 新しい順のアップロード一覧(フィルタ付き) */
export function useDeployHistory(filter?: (d: DeployJob) => boolean): DeployJob[] {
  const deploys = useHub((s) => s.deploys);
  return useMemo(
    () =>
      Object.values(deploys)
        .filter((d) => (filter ? filter(d) : true))
        .sort((a, b) => b.createdAt - a.createdAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deploys],
  );
}

// ---------------------------------------------------------------- 共通の指示

export const LINE_LIMIT = INSTRUCTIONS_LINE_LIMIT;
/** これ以上で「近づいています」(上限の 90%) */
export const LINE_NEAR = Math.round(INSTRUCTIONS_LINE_LIMIT * 0.9);

/** 行数(末尾の改行 1 つは数えない。空なら 0) */
export function countLines(text: string): number {
  if (!text) return 0;
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.split('\n').length;
}

export type LineTone = 'ok' | 'near' | 'over';
export function lineTone(n: number): LineTone {
  return n > LINE_LIMIT ? 'over' : n >= LINE_NEAR ? 'near' : 'ok';
}
export const LINE_MSG: Record<LineTone, string | null> = {
  ok: null,
  near: `${LINE_LIMIT} 行に近づいています`,
  over: `${LINE_LIMIT} 行を超えています。要点を絞ってください`,
};

export const instructionsApi = {
  get: async (p: Pick<ProjectRoute, 'repoId' | 'cwd'>): Promise<ProjectInstructions | undefined> =>
    pick<ProjectInstructions>(await api(`/api/project/instructions?${projectQuery(p)}`), 'instructions'),
  put: async (p: Pick<ProjectRoute, 'repoId' | 'cwd'>, content: string): Promise<ProjectInstructions | undefined> => {
    const r = pick<ProjectInstructions>(await api(`/api/project/instructions?${projectQuery(p)}`, { content }, { method: 'PUT' }), 'instructions');
    if (r) setSummary(projectKey(p), r.lineCount ?? countLines(r.content));
    return r;
  },
  rewrite: async (p: Pick<ProjectRoute, 'repoId' | 'cwd'>, request: string): Promise<{ proposal: string; lineCount: number }> => {
    const r = await api(`/api/project/instructions/rewrite?${projectQuery(p)}`, { request });
    const proposal = typeof r?.proposal === 'string' ? r.proposal : typeof r?.data?.proposal === 'string' ? r.data.proposal : '';
    const lc = typeof r?.lineCount === 'number' ? r.lineCount : countLines(proposal);
    return { proposal, lineCount: lc };
  },
};

// ホームのカード用: 共通の指示の行数(プロジェクトごとに 1 回だけ取得してキャッシュ。保存したら更新)
const summary = new Map<string, number | null>();
const summarySubs = new Set<() => void>();
const loadingSummary = new Set<string>();
function setSummary(k: string, n: number | null) {
  summary.set(k, n);
  summarySubs.forEach((f) => f());
}

/** 共通の指示の行数(取得前・未対応のデーモン・未記入なら null) */
export function useInstructionsLines(p: Pick<ProjectRoute, 'repoId' | 'cwd'>): number | null {
  const k = projectKey(p);
  const n = useSyncExternalStore(
    (f) => {
      summarySubs.add(f);
      return () => summarySubs.delete(f);
    },
    () => summary.get(k) ?? null,
  );
  useEffect(() => {
    if (summary.has(k) || loadingSummary.has(k)) return;
    loadingSummary.add(k);
    instructionsApi
      .get(p)
      .then((r) => setSummary(k, r ? r.lineCount ?? countLines(r.content) : null))
      .catch(() => setSummary(k, null))
      .finally(() => loadingSummary.delete(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return n;
}

/** 管理画面で読み込んだ結果をホームのカードにも反映 */
export function noteInstructionsLines(p: Pick<ProjectRoute, 'repoId' | 'cwd'>, n: number): void {
  const k = projectKey(p);
  if (summary.get(k) !== n) setSummary(k, n);
}

// ---------------------------------------------------------------- 行の差分(LCS)

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 元の行番号 / 新しい行番号(1 始まり) */
  a: number | null;
  b: number | null;
}

/** 行単位の差分(共通の前後を除いてから LCS。指示ファイルは数百行なので O(n*m) で十分) */
export function lineDiff(before: string, after: string): DiffLine[] {
  const A = before ? before.replace(/\n$/, '').split('\n') : [];
  const B = after ? after.replace(/\n$/, '').split('\n') : [];
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..], b[j..] の LCS 長
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  for (let k = 0; k < pre; k++) out.push({ kind: 'same', text: A[k], a: k + 1, b: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], a: pre + i + 1, b: pre + j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ kind: 'add', text: b[j], a: null, b: pre + j + 1 });
      j++;
    } else {
      out.push({ kind: 'del', text: a[i], a: pre + i + 1, b: null });
      i++;
    }
  }
  for (let k = 0; k < suf; k++) out.push({ kind: 'same', text: A[A.length - suf + k], a: A.length - suf + k + 1, b: B.length - suf + k + 1 });
  return out;
}

/** 変更の前後 ctx 行だけ残す(間は「… N 行」で省略) */
export type DiffRow = DiffLine | { kind: 'skip'; count: number };
export function foldDiff(lines: DiffLine[], ctx = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skip = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skip) out.push({ kind: 'skip', count: skip });
      skip = 0;
      out.push(l);
    } else skip++;
  });
  if (skip) out.push({ kind: 'skip', count: skip });
  return out;
}
