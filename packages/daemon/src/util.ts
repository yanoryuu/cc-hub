// 共通ヘルパー
import type http from 'node:http';

/** API のエラー(ステータスコード付き) */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** ツール入力から「対象」の要約を作る(file_path / command 先頭 80 文字 / pattern / description / url) */
export function toolTarget(_name: unknown, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.description ?? input.url ?? input.query ?? input.skill ?? '';
  const s = String(pick).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

export function readBody(req: http.IncomingMessage, limit = 1e6): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'bad request'));
      }
    });
    req.on('error', reject);
  });
}

export function json(res: http.ServerResponse, code: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

export function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** SessionInfo.task の最大長 */
export const TASK_MAX = 300;

const BG_FINISHED_RE = /^(completed?|done|finished|failed|error|killed|stopped|cancell?ed)$/i;

/** Stop hook の background_tasks のうち、まだ終わっていないものの数(状態が無いものは実行中とみなす) */
export function activeBackgroundTasks(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => {
    const st = t && typeof t === 'object' ? (t as { status?: unknown }).status : undefined;
    return !(typeof st === 'string' && BG_FINISHED_RE.test(st.trim()));
  }).length;
}

/**
 * 指示 / 最初のプロンプトから「何の作業か」(SessionInfo.task)を作る。
 * 先頭のスラッシュコマンド名(/commander など)は取り除き、その後ろの本文を使う。本文が無い・システム由来("<" で始まる)なら null
 */
export function taskText(text: unknown): string | null {
  let s = String(text ?? '').trim();
  if (!s || s.startsWith('<')) return null;
  if (s.startsWith('/')) {
    const m = /^\/\S+\s*([\s\S]*)$/.exec(s);
    s = (m?.[1] ?? '').trim();
    if (!s) return null;
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > TASK_MAX ? s.slice(0, TASK_MAX) : s;
}
