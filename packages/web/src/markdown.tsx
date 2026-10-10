// 小さな安全な Markdown レンダラー(アーティファクトのプレビュー用)。
// 生の HTML は一切解釈しない: すべて React の要素とテキストとして組み立てるので、<script> などはそのまま文字で表示される。
// 対応: 見出し / 段落 / 箇条書き(- * + / 1.)/ タスク [ ] [x] / 引用 / コードブロック ``` / 水平線 / 表(簡易)
//       インライン: `code` / **太字** / *斜体* / ~~取り消し~~ / [リンク](http(s)://… または相対パス)
import type { ReactNode } from 'react';

/** リンク先として許可する URL(javascript: / data: などは不可)。相対パスは file 用の URL に変換する */
function safeHref(url: string, resolve?: (rel: string) => string | null): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // その他のスキームは不可
  if (u.startsWith('#')) return null; // ページ内リンクは無視
  return resolve ? resolve(u) : null;
}

/** インライン要素の解析 */
function inline(text: string, key: string, resolve?: (rel: string) => string | null): ReactNode[] {
  const out: ReactNode[] = [];
  // 優先順: コード → リンク → 太字 → 取り消し → 斜体
  const re = /(`+)([^`]+?)\1|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[4] !== undefined) {
      const isImg = m[0].startsWith('!');
      const href = safeHref(m[4], resolve);
      const label = m[3] || m[4];
      // 画像は埋め込まずリンクにする(外部への読み込みを発生させない)
      if (href)
        out.push(
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {isImg ? `[画像] ${label}` : inline(label, k, resolve)}
          </a>,
        );
      else out.push(<span key={k}>{label}</span>);
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k}>{inline(m[5] ?? m[6], k, resolve)}</strong>);
    else if (m[7] !== undefined) out.push(<del key={k}>{m[7]}</del>);
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<em key={k}>{m[8] ?? m[9]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type ListItem = { text: string; task: boolean | null; children: string[] };

/** Markdown のテキストを React 要素にする。resolve は相対リンクの解決(なければリンクにしない) */
export function renderMarkdown(src: string, resolve?: (rel: string) => string | null): ReactNode {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  const isBlank = (l: string) => /^\s*$/.test(l);
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // コードブロック
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key()} className="md-code" data-lang={fence[2] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // 見出し
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const lvl = h[1].length;
      const kk = key();
      const content = inline(h[2], kk, resolve);
      blocks.push(
        lvl === 1 ? (
          <h1 key={kk}>{content}</h1>
        ) : lvl === 2 ? (
          <h2 key={kk}>{content}</h2>
        ) : lvl === 3 ? (
          <h3 key={kk}>{content}</h3>
        ) : (
          <h4 key={kk}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    // 水平線
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i++;
      continue;
    }
    // 引用
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key()}>{renderMarkdown(body.join('\n'), resolve)}</blockquote>);
      continue;
    }
    // 表(| a | b | の次に |---|---|)
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const kk = key();
      blocks.push(
        <div key={kk} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${kk}h${j}`, resolve)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${kk}r${ri}c${j}`, resolve)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // 箇条書き
    const lm = line.match(listRe);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const baseIndent = lm[1].length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m2 = l.match(listRe);
        if (m2 && m2[1].length <= baseIndent + 1) {
          let text = m2[3];
          let task: boolean | null = null;
          const t = text.match(/^\[([ xX])\]\s+(.*)$/);
          if (t) {
            task = t[1] !== ' ';
            text = t[2];
          }
          items.push({ text, task, children: [] });
          i++;
        } else if (!isBlank(l) && /^\s+/.test(l) && items.length) {
          // 入れ子(インデントされた行)は子として再帰的に描く
          items[items.length - 1].children.push(l.replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ''));
          i++;
        } else break;
      }
      const kk = key();
      const lis = items.map((it, j) => (
        <li key={j} className={it.task !== null ? 'md-task' : undefined}>
          {it.task !== null && (
            <span className="md-check" aria-label={it.task ? '完了' : '未完了'}>
              {it.task ? '☑' : '☐'}
            </span>
          )}
          {inline(it.text, `${kk}-${j}`, resolve)}
          {it.children.length > 0 && renderMarkdown(it.children.join('\n'), resolve)}
        </li>
      ));
      blocks.push(ordered ? <ol key={kk}>{lis}</ol> : <ul key={kk}>{lis}</ul>);
      continue;
    }
    // 段落(空行・見出し・リスト・コードまで)
    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) &&
      !listRe.test(lines[i])
    )
      para.push(lines[i++]);
    if (para.length === 0) {
      // どれにも当てはまらない行(念のため): そのまま段落に
      para.push(lines[i++]);
    }
    const kk = key();
    blocks.push(<p key={kk}>{inline(para.join(' '), kk, resolve)}</p>);
  }
  return <>{blocks}</>;
}
