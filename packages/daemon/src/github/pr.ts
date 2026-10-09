// PR の純粋なロジック(gh の JSON → PrInfo、前回との差分 → 通知、修正指示の文面)。
// 副作用を持たないのでテスト(test/pr.test.ts)から直接呼ぶ。
import type { CheckState, PrComment, PrDetail, PrInfo, PrState } from '@cc-hub/shared';

/** gh pr list / view に渡す --json フィールド(一覧用) */
export const PR_LIST_FIELDS =
  'number,title,url,state,isDraft,headRefName,baseRefName,author,reviewDecision,mergeable,statusCheckRollup,updatedAt,comments,reviews';
/** 詳細用 */
export const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},body,files`;

/** 閉じた / マージ済みの PR を一覧に残す期間 */
export const CLOSED_KEEP_MS = 3 * 24 * 3600_000;

// ---------------------------------------------------------------- チェック

export interface ChecksResult {
  checks: CheckState;
  summary: { passed: number; failed: number; pending: number };
  /** 失敗したチェック(名前・URL・Actions の run id) */
  failed: { name: string; url: string; runId: number | null }[];
}

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Actions の詳細 URL(.../actions/runs/<id>/job/<job>)から run id を取り出す */
export function extractRunId(url: unknown): number | null {
  const m = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(String(url ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * statusCheckRollup(CheckRun / StatusContext の配列)→ CheckState と件数。
 * CheckRun: status(QUEUED / IN_PROGRESS / COMPLETED …)+ conclusion。StatusContext: state(SUCCESS / FAILURE / ERROR / PENDING / EXPECTED)
 */
export function mapChecks(rollup: unknown): ChecksResult {
  const summary = { passed: 0, failed: 0, pending: 0 };
  const failed: ChecksResult['failed'] = [];
  const items = Array.isArray(rollup) ? rollup : [];
  for (const c of items) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name || c.context || c.workflowName || '?');
    const url = String(c.detailsUrl || c.targetUrl || '');
    const isStatus = c.__typename === 'StatusContext' || (c.state != null && c.status == null && c.conclusion == null);
    if (isStatus) {
      const st = String(c.state || '').toUpperCase();
      if (st === 'SUCCESS') summary.passed++;
      else if (st === 'FAILURE' || st === 'ERROR') {
        summary.failed++;
        failed.push({ name, url, runId: extractRunId(url) });
      } else summary.pending++;
      continue;
    }
    const status = String(c.status || '').toUpperCase();
    const concl = String(c.conclusion || '').toUpperCase();
    if (status && status !== 'COMPLETED') summary.pending++;
    else if (FAIL_CONCLUSIONS.has(concl)) {
      summary.failed++;
      failed.push({ name, url, runId: extractRunId(url) });
    } else if (PASS_CONCLUSIONS.has(concl)) summary.passed++;
    else if (!concl) summary.pending++;
    else summary.passed++; // STALE など: 失敗ではないものとして扱う
  }
  const total = summary.passed + summary.failed + summary.pending;
  const checks: CheckState = total === 0 ? 'none' : summary.failed > 0 ? 'failure' : summary.pending > 0 ? 'pending' : 'success';
  return { checks, summary, failed };
}

// ---------------------------------------------------------------- gh JSON → PrInfo

function ts(v: unknown): number {
  const n = Date.parse(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function login(a: any): string {
  return a && typeof a === 'object' ? String(a.login || a.name || '') : String(a ?? '');
}

const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const MERGEABLE = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);

export interface PrFlags {
  mine?: boolean;
  reviewRequested?: boolean;
  /** 自分のログイン名(head での取得結果に mine を付けるため) */
  me?: string | null;
}

/** gh pr list / view の 1 件 → PrInfo(紐付け sessionId / worktreeId は null。呼ぶ側で付ける) */
export function toPrInfo(repoId: string, j: any, flags: PrFlags = {}): PrInfo {
  const ch = mapChecks(j?.statusCheckRollup);
  const state = String(j?.state || '').toUpperCase();
  const decision = String(j?.reviewDecision || '').toUpperCase();
  const mergeable = String(j?.mergeable || '').toUpperCase();
  const author = login(j?.author);
  const comments = Array.isArray(j?.comments) ? j.comments.length : Number(j?.comments?.totalCount) || 0;
  const reviews = Array.isArray(j?.reviews) ? j.reviews.length : Number(j?.reviews?.totalCount) || 0;
  const number = Number(j?.number) || 0;
  return {
    id: `${repoId}#${number}`,
    repoId,
    number,
    title: String(j?.title ?? ''),
    url: String(j?.url ?? ''),
    state: (PR_STATES.has(state) ? state : 'OPEN') as PrState,
    isDraft: !!j?.isDraft,
    headRefName: String(j?.headRefName ?? ''),
    baseRefName: String(j?.baseRefName ?? ''),
    author,
    reviewDecision: DECISIONS.has(decision) ? (decision as PrInfo['reviewDecision']) : null,
    mergeable: (MERGEABLE.has(mergeable) ? mergeable : 'UNKNOWN') as PrInfo['mergeable'],
    checks: ch.checks,
    checksSummary: ch.summary,
    commentCount: comments + reviews,
    updatedAt: ts(j?.updatedAt),
    mine: !!flags.mine || (!!flags.me && author.toLowerCase() === flags.me.toLowerCase()),
    reviewRequested: !!flags.reviewRequested,
    sessionId: null,
    worktreeId: null,
  };
}

/** 一覧に残すか(OPEN か、閉じてから 3 日以内) */
export function keepPr(p: PrInfo, now = Date.now()): boolean {
  return p.state === 'OPEN' || now - p.updatedAt <= CLOSED_KEEP_MS;
}

/** 同じ PR が複数の取得結果に出たときにまとめる(mine / reviewRequested は OR) */
export function mergePr(a: PrInfo | undefined, b: PrInfo): PrInfo {
  if (!a) return b;
  const newer = b.updatedAt >= a.updatedAt ? b : a;
  return { ...newer, mine: a.mine || b.mine, reviewRequested: a.reviewRequested || b.reviewRequested };
}

/** gh pr view の詳細 → PrDetail */
export function toPrDetail(repoId: string, j: any, lineComments: any[], base: PrInfo): PrDetail {
  const comments: PrComment[] = [];
  for (const c of Array.isArray(j?.comments) ? j.comments : []) {
    comments.push({ author: login(c.author), body: String(c.body ?? ''), createdAt: ts(c.createdAt), url: c.url ? String(c.url) : undefined });
  }
  for (const c of Array.isArray(lineComments) ? lineComments : []) {
    const line = Number(c.line ?? c.original_line ?? c.position);
    comments.push({
      author: login(c.user ?? c.author),
      body: String(c.body ?? ''),
      createdAt: ts(c.created_at ?? c.createdAt),
      path: c.path ? String(c.path) : undefined,
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      url: c.html_url ? String(c.html_url) : undefined,
    });
  }
  comments.sort((a, b) => a.createdAt - b.createdAt);
  const reviews = (Array.isArray(j?.reviews) ? j.reviews : []).map((r: any) => ({
    author: login(r.author),
    state: String(r.state ?? ''),
    body: String(r.body ?? ''),
    submittedAt: ts(r.submittedAt),
  }));
  const files = (Array.isArray(j?.files) ? j.files : []).map((f: any) => ({
    path: String(f.path ?? ''),
    additions: Number(f.additions) || 0,
    deletions: Number(f.deletions) || 0,
  }));
  return { ...base, body: String(j?.body ?? ''), comments, reviews, files, failedChecks: mapChecks(j?.statusCheckRollup).failed };
}

// ---------------------------------------------------------------- 差分 → 通知

export interface PrEvent {
  pr: PrInfo;
  title: string;
  body: string;
}

/**
 * 前回のスナップショットとの差分から通知イベントを作る。
 * 前回に無い PR(初回取得・新規)は通知しない(起動直後に大量に出さないため)。
 */
export function diffPrEvents(prev: PrInfo | undefined, next: PrInfo): PrEvent[] {
  if (!prev) return [];
  const out: PrEvent[] = [];
  const name = `#${next.number} ${next.title}`;
  if (next.state === 'MERGED' && prev.state !== 'MERGED') {
    out.push({ pr: next, title: 'PR がマージされました', body: name });
    return out; // マージ後のその他の変化は通知しない
  }
  if (next.state === 'CLOSED' && prev.state === 'OPEN') {
    out.push({ pr: next, title: 'PR がクローズされました', body: name });
    return out;
  }
  if (next.checks === 'failure' && prev.checks !== 'failure') {
    out.push({ pr: next, title: 'CI が失敗しました', body: `${name}(失敗 ${next.checksSummary.failed} 件)` });
  }
  if (next.reviewDecision !== prev.reviewDecision) {
    if (next.reviewDecision === 'CHANGES_REQUESTED') out.push({ pr: next, title: '修正を依頼されました', body: name });
    else if (next.reviewDecision === 'APPROVED') out.push({ pr: next, title: 'PR が承認されました', body: name });
  }
  if (next.mine && next.commentCount > prev.commentCount) {
    const n = next.commentCount - prev.commentCount;
    out.push({ pr: next, title: '新しいコメント / レビュー', body: `${name}(+${n} 件)` });
  }
  return out;
}

// ---------------------------------------------------------------- 修正指示

export const LOG_TAIL_LINES = 200;
export const FIX_MAX_BYTES = 30 * 1024;

/** ログの末尾 n 行(ANSI エスケープと gh のタイムスタンプ前置きは落とす) */
export function trimLog(log: string, lines = LOG_TAIL_LINES): string {
  const clean = String(log ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    // gh run view --log-failed の各行は "<job>\t<step>\t<時刻> <本文>"。前置きは落とす
    .map((l) => l.replace(/^[^\t\n]*\t[^\t\n]*\t/, '').replace(/^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/, ''));
  while (clean.length && !clean[clean.length - 1].trim()) clean.pop();
  const t = clean.slice(-lines);
  return (clean.length > lines ? `…(先頭 ${clean.length - lines} 行を省略)\n` : '') + t.join('\n');
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** UTF-8 で n バイト以内に収まるよう末尾を残して切る */
function tailBytes(s: string, n: number): string {
  if (byteLen(s) <= n) return s;
  let cut = s.slice(-n);
  while (byteLen(cut) > n) cut = cut.slice(1);
  return '…(省略)\n' + cut.slice(cut.indexOf('\n') + 1);
}

export interface FixInput {
  pr: { number: number; title: string; url: string; headRefName: string };
  /** 未解決のレビューコメント(path / line 付きは行コメント) */
  comments: PrComment[];
  /** 失敗したチェックのログ */
  checkLogs: { name: string; runId: number | null; log: string }[];
  note?: string;
}

/** 「直して」の指示文(Markdown)。全体で 30KB 以内に収める(ログを削る) */
export function buildFixInstruction(f: FixInput): string {
  const head: string[] = [];
  head.push(`PR #${f.pr.number}「${f.pr.title}」(${f.pr.url}、ブランチ ${f.pr.headRefName})の指摘を修正してください。`);
  head.push('');
  head.push('進め方:');
  head.push('- 下の指摘・失敗ログを読み、原因を特定して修正する(指摘が妥当でない場合は理由を説明する)');
  head.push('- 必要ならテスト・ビルドで確認する');
  head.push('- 修正をコミットして `git push` する(PR に反映させる)');
  head.push('- 最後に、何をどう直したかを日本語で短く報告する');
  if (f.note && f.note.trim()) {
    head.push('');
    head.push('## 補足の指示');
    head.push(f.note.trim());
  }
  const cm: string[] = [];
  if (f.comments.length) {
    cm.push('');
    cm.push(`## レビューコメント(${f.comments.length} 件)`);
    for (const c of f.comments) {
      const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : '会話';
      cm.push(`- **${c.author || '?'}** (${where}):`);
      for (const l of String(c.body).trim().split(/\r?\n/)) cm.push(`  > ${l}`);
    }
  }
  let text = head.join('\n') + cm.join('\n');
  if (byteLen(text) > FIX_MAX_BYTES / 2 && f.checkLogs.length) text = tailBytes(text, FIX_MAX_BYTES / 2);
  if (f.checkLogs.length) {
    const intro = `\n\n## 失敗したチェック(${f.checkLogs.length} 件)`;
    const budget = FIX_MAX_BYTES - byteLen(text) - byteLen(intro) - 64;
    const per = Math.max(512, Math.floor(budget / f.checkLogs.length));
    const parts = f.checkLogs.map((c) => {
      const title = `\n\n### ${c.name}${c.runId ? `(run ${c.runId})` : ''}\n`;
      const body = trimLog(c.log) || '(ログを取得できませんでした)';
      return `${title}\`\`\`\n${tailBytes(body, per - byteLen(title) - 8)}\n\`\`\``;
    });
    text += intro + parts.join('');
  }
  if (byteLen(text) > FIX_MAX_BYTES) text = text.slice(0, FIX_MAX_BYTES / 3); // 念のため(通常は到達しない)
  return text;
}

/** PR 作成の指示文(1 行) */
export function buildCreatePrInstruction(o: { base: string; draft: boolean }): string {
  return [
    'この作業を GitHub の PR にしてください。手順:',
    '(1) `git status` で確認し、未コミットの変更が作業の一部ならコミットする(一時ファイルや無関係な変更は含めない)。',
    '(2) `git push -u origin HEAD` で push する。',
    `(3) \`gh pr create --base ${o.base}${o.draft ? ' --draft' : ''} --title "<タイトル>" --body "<本文>"\` で PR を作る。` +
      'タイトルと本文は日本語で、本文には変更内容の要約・変更理由・確認方法を書く。',
    '(4) 作成した PR の URL を報告する。',
  ].join(' ');
}
