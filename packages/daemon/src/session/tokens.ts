// トークン使用量(SessionInfo.tokens)の集計。
// - input / output: statusLine の context_window.total_input_tokens / total_output_tokens(メイン会話の累計)と
//   transcript のメイン分の大きい方 + サブエージェントの transcript の usage 合計。
//   (statusLine は最後の応答の後に再描画されないことがあり、出力が古いまま残るため。statusLine が無い外部セッションは transcript だけ)
// - cacheRead / cacheCreation: transcript(メイン + subagents/agent-*.jsonl)の usage を合計
// - transcript は追記分だけ読む(ファイルごとのオフセット)。アシスタントのメッセージはストリーミング中に
//   同じ message.id で複数回書かれるので、message.id ごとに最大値を取ってから合計する
import fs from 'node:fs';
import path from 'node:path';
import type { SessionTokens } from '@cc-hub/shared';
import { findTranscript } from '../history';

export interface UsageNums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const ZERO: UsageNums = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** transcript の 1 行から {id, usage} を取り出す。アシスタントのメッセージ以外は null */
export function parseUsageLine(line: string): { id: string; usage: UsageNums } | null {
  if (!line.includes('"usage"')) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const m = o?.message;
  const u = m?.usage;
  if (!u || typeof u !== 'object') return null;
  if (o.type && o.type !== 'assistant') return null;
  const id = typeof m.id === 'string' && m.id ? m.id : typeof o.requestId === 'string' ? o.requestId : typeof o.uuid === 'string' ? o.uuid : '';
  if (!id) return null;
  return {
    id,
    usage: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
    },
  };
}

/** message.id ごとに重複を除いて合計する(メイン / サブエージェント別) */
export class UsageTally {
  private readonly byId = new Map<string, { u: UsageNums; sub: boolean }>();
  readonly main: UsageNums = { ...ZERO };
  readonly sub: UsageNums = { ...ZERO };

  /** 1 行を取り込む。合計が変わったら true */
  addLine(line: string, sub: boolean): boolean {
    const p = parseUsageLine(line);
    return p ? this.add(p.id, p.usage, sub) : false;
  }

  add(id: string, u: UsageNums, sub: boolean): boolean {
    const prev = this.byId.get(id);
    const next: UsageNums = prev
      ? {
          input: Math.max(prev.u.input, u.input),
          output: Math.max(prev.u.output, u.output),
          cacheRead: Math.max(prev.u.cacheRead, u.cacheRead),
          cacheCreation: Math.max(prev.u.cacheCreation, u.cacheCreation),
        }
      : u;
    const isSub = prev ? prev.sub : sub;
    const t = isSub ? this.sub : this.main;
    const old = prev?.u ?? ZERO;
    if (prev && old.input === next.input && old.output === next.output && old.cacheRead === next.cacheRead && old.cacheCreation === next.cacheCreation) return false;
    t.input += next.input - old.input;
    t.output += next.output - old.output;
    t.cacheRead += next.cacheRead - old.cacheRead;
    t.cacheCreation += next.cacheCreation - old.cacheCreation;
    this.byId.set(id, { u: next, sub: isSub });
    return true;
  }

  get size(): number {
    return this.byId.size;
  }
}

/** statusLine の累計と transcript の集計から SessionTokens を作る(メイン分はどちらか大きい方) */
export function combineTokens(sl: { input: number; output: number } | null, t: UsageTally, now = Date.now()): SessionTokens {
  return {
    input: Math.max(sl?.input ?? 0, t.main.input) + t.sub.input,
    output: Math.max(sl?.output ?? 0, t.main.output) + t.sub.output,
    cacheRead: t.main.cacheRead + t.sub.cacheRead,
    cacheCreation: t.main.cacheCreation + t.sub.cacheCreation,
    updatedAt: now,
  };
}

/** 1 回の更新で 1 ファイルから読む上限(大きな transcript は数回に分けて読む) */
const READ_CHUNK = 4 * 1024 * 1024;

interface FileRt {
  offset: number;
  rest: Buffer;
}

/** セッション 1 つ分の transcript 追跡 */
export class TranscriptTail {
  readonly tally = new UsageTally();
  private readonly files = new Map<string, FileRt>();
  private readonly mainPaths = new Map<string, string>();
  /** まだ読み残しがある(次回もう一度読む) */
  pending = false;

  /** claude 側の session_id 群(/clear で変わったものも含む)の transcript を追記分だけ読む。合計が変わったら true */
  async poll(claudeIds: string[]): Promise<boolean> {
    let changed = false;
    this.pending = false;
    for (const id of claudeIds) {
      let main = this.mainPaths.get(id) ?? null;
      if (!main) {
        main = findTranscript(id);
        if (!main) continue;
        this.mainPaths.set(id, main);
      }
      if (await this.readFile(main, false)) changed = true;
      const subDir = path.join(main.replace(/\.jsonl$/i, ''), 'subagents');
      let ents: string[] = [];
      try {
        ents = await fs.promises.readdir(subDir);
      } catch {
        ents = [];
      }
      for (const f of ents) {
        if (!/^agent-.*\.jsonl$/i.test(f)) continue;
        if (await this.readFile(path.join(subDir, f), true)) changed = true;
      }
    }
    return changed;
  }

  private async readFile(fp: string, sub: boolean): Promise<boolean> {
    let size: number;
    try {
      size = (await fs.promises.stat(fp)).size;
    } catch {
      return false;
    }
    let rt = this.files.get(fp);
    if (!rt) {
      rt = { offset: 0, rest: Buffer.alloc(0) };
      this.files.set(fp, rt);
    }
    if (size < rt.offset) {
      // 縮んだ(書き直された)ら最初から。重複は message.id で除かれる
      rt.offset = 0;
      rt.rest = Buffer.alloc(0);
    }
    if (size === rt.offset) return false;
    const len = Math.min(READ_CHUNK, size - rt.offset);
    const buf = Buffer.alloc(len);
    let fh: fs.promises.FileHandle | null = null;
    let n = 0;
    try {
      fh = await fs.promises.open(fp, 'r');
      ({ bytesRead: n } = await fh.read(buf, 0, len, rt.offset));
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => undefined);
    }
    rt.offset += n;
    if (rt.offset < size) this.pending = true;
    const data = rt.rest.length ? Buffer.concat([rt.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
    const last = data.lastIndexOf(0x0a);
    if (last < 0) {
      rt.rest = Buffer.from(data);
      return false;
    }
    rt.rest = Buffer.from(data.subarray(last + 1));
    let changed = false;
    for (const line of data.subarray(0, last).toString('utf8').split('\n')) {
      if (line && this.tally.addLine(line, sub)) changed = true;
    }
    return changed;
  }
}
