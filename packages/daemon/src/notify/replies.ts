// Discord での質問を、そのセッションへの「横からの質問」(/btw のように)として扱う。
// 作業の指示や承認は CC Hub から行うので、質問はセッションに送らない(承認は approvals.ts / session-approvals.ts のボタンで行う)。
// claude -p --resume <id> --fork-session で会話を写して答えさせ、ファイルは変更させない。
// 同じスレッドでの続けての質問には、それまでのやり取りを一緒に渡す(毎回会話を写し直すため、前の答えを覚えていない)。
import type { SessionInfo } from '@cc-hub/shared';
import { run, tail } from '../repo/exec';

export type ReplyAction = { kind: 'missing' } | { kind: 'btw'; text: string };

/** 先頭の「/btw」は付けても付けなくてもよい */
const BTW_RE = /^\/btw(?:\s+|$)/i;

/** 質問をどう扱うか */
export function decideReply(info: SessionInfo | undefined, content: string): ReplyAction {
  if (!info) return { kind: 'missing' };
  return { kind: 'btw', text: content.trim().replace(BTW_RE, '').trim() };
}

/** スレッドでのそれまでのやり取り */
export interface QaTurn {
  q: string;
  a: string;
}

/** 渡すやり取りの上限(新しいほうから) */
export const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 横からの質問に付ける前置き(history = 同じスレッドでのそれまでのやり取り) */
export function btwPrompt(question: string, history: QaTurn[] = []): string {
  const lines = [
    '(これは今の作業とは別の、横からの質問です。ファイルの変更やコマンドの実行はせず、会話の内容と必要ならファイルを読んで、日本語で簡潔に答えてください)',
  ];
  const h = history.slice(-HISTORY_TURNS);
  if (h.length) {
    lines.push('', 'この質問の前に、同じ話題で次のやり取りがありました:');
    for (const t of h) lines.push(`Q: ${clip(t.q, HISTORY_CHARS)}`, `A: ${clip(t.a, HISTORY_CHARS)}`);
    lines.push('', '続けての質問:');
  } else {
    lines.push('');
  }
  lines.push(question);
  return lines.join('\n');
}

/** 質問 1 件 */
export interface BtwRequest {
  sessionId: string;
  content: string;
  authorName: string;
  history: QaTurn[];
}

/** 答えの送り先(スレッド、作れなければ元のメッセージへの返信) */
export interface BtwIO {
  send(text: string): Promise<void>;
  typing(): Promise<void>;
}

export interface ReplyDeps {
  info: (id: string) => SessionInfo | undefined;
  /** --resume に使う claude の session_id(会話の記録が無ければ null) */
  resumeIdFor: (id: string) => string | null;
  claudePath: string;
}

const BTW_TIMEOUT_MS = 5 * 60_000;
const BTW_PARALLEL = 2;

export class ReplyRouter {
  private running = 0;

  constructor(private readonly d: ReplyDeps) {}

  /** 質問に答える。戻り値は答え(やり取りの記録用。答えられなかったら null)。エラーは Discord に返す */
  async handle(req: BtwRequest, io: BtwIO): Promise<string | null> {
    const info = this.d.info(req.sessionId);
    const action = decideReply(info, req.content);
    try {
      if (action.kind === 'missing') {
        await io.send('この通知のセッションが見つかりません(削除されたか、古い通知です)。');
        return null;
      }
      return await this.btw(req, info!, action.text, io);
    } catch (e) {
      await io.send(`送れませんでした: ${(e as Error).message}`).catch(() => undefined);
      return null;
    }
  }

  private async btw(req: BtwRequest, info: SessionInfo, question: string, io: BtwIO): Promise<string | null> {
    const fail = async (text: string) => {
      await io.send(text);
      return null;
    };
    if (!question) return fail('質問の本文が空です。');
    const resumeId = this.d.resumeIdFor(info.id);
    if (!resumeId) return fail(`「${info.name}」の会話の記録が見つからないため、質問に答えられません。`);
    if (this.running >= BTW_PARALLEL) return fail('ほかの質問に答えています。少し待ってからもう一度送ってください。');
    this.running++;
    // 答えが出るまで「入力中…」を出し続ける
    void io.typing();
    const typing = setInterval(() => void io.typing(), 8000);
    try {
      console.log(`[bot] ${req.authorName} から ${info.name} への横からの質問に答えます${req.history.length ? `(続き ${req.history.length} 件)` : ''}`);
      const res = await run(
        this.d.claudePath,
        [
          '-p',
          '--resume',
          resumeId,
          '--fork-session',
          '--no-session-persistence',
          '--settings',
          '{"disableAllHooks":true}',
          '--disallowedTools',
          'Edit,Write,NotebookEdit,Bash,PowerShell',
        ],
        { cwd: info.cwd, timeout: BTW_TIMEOUT_MS, input: btwPrompt(question, req.history) },
      );
      if (res.code !== 0) {
        console.warn(`[bot] 横からの質問に失敗 (code ${res.code}): ${tail(res, 300)}`);
        return fail(`答えを作れませんでした(code ${res.code})。${res.code === -1 ? '時間がかかりすぎたため中断しました。' : ''}`);
      }
      const answer = res.stdout.trim() || '(答えが空でした)';
      const note = info.status === 'running' ? '作業は止めずに答えています' : '会話の写しで答えています';
      await io.send(`**${info.name}**(${note})\n${answer}`);
      return answer;
    } finally {
      clearInterval(typing);
      this.running--;
    }
  }
}
