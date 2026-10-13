// Claude が Artifact ツールでページを公開したときの通知(Discord に内容の抜粋と URL を送る)。
// PostToolUse(tool_name = 'Artifact')の tool_input / tool_response から URL・タイトル・元ファイルを取り出す
import fs from 'node:fs';
import path from 'node:path';

const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
/** 読み込むファイルの上限(これより大きいものは本文を読まない) */
const MAX_FILE = 4 * 1024 * 1024;
/** Discord に載せる本文の長さ */
export const ARTIFACT_EXCERPT_MAX = 1500;

export interface ArtifactPublish {
  url: string;
  title: string;
  description: string;
  /** 公開したローカルのファイル(本文の抜粋に使う) */
  filePath: string | null;
}

/** PostToolUse の hooks から公開されたアーティファクトを取り出す。公開でなければ null */
export function artifactFromHook(b: any): ArtifactPublish | null {
  if (!b || b.hook_event_name !== 'PostToolUse' || b.tool_name !== 'Artifact') return null;
  const input = b.tool_input && typeof b.tool_input === 'object' ? b.tool_input : {};
  const action = typeof input.action === 'string' ? input.action : 'publish';
  // 画像などの素材のアップロードはページの公開ではない
  if (action !== 'publish' || input.asset === true) return null;
  let resp = '';
  try {
    resp = typeof b.tool_response === 'string' ? b.tool_response : JSON.stringify(b.tool_response ?? '');
  } catch {
    /* 文字列にできない */
  }
  const url = resp.match(URL_RE)?.[0] ?? (typeof input.url === 'string' ? input.url.match(URL_RE)?.[0] : undefined);
  if (!url) return null;
  const filePath = typeof input.file_path === 'string' && input.file_path ? input.file_path : null;
  const title = String(input.title ?? '').trim() || (filePath ? path.basename(filePath).replace(/\.[^.]+$/, '') : '');
  return { url, title, description: String(input.description ?? '').trim(), filePath };
}

/** HTML から読める文章だけ取り出す(script / style を除き、タグを外して空白を詰める) */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|svg|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n・')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** 公開したファイルの本文(抜粋)。読めなければ '' */
export function artifactExcerpt(filePath: string | null, cwd: string, max = ARTIFACT_EXCERPT_MAX): { title: string; text: string } {
  if (!filePath) return { title: '', text: '' };
  try {
    const p = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || '.', filePath);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE) return { title: '', text: '' };
    const raw = fs.readFileSync(p, 'utf8');
    const r = /\.html?$/i.test(p) ? htmlToText(raw) : { title: '', text: raw.trim() };
    return { title: r.title, text: r.text.length > max ? r.text.slice(0, max - 1) + '…' : r.text };
  } catch {
    return { title: '', text: '' };
  }
}
