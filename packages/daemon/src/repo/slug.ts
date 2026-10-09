// ブランチ名の slug 生成(design §7.4)。claude -p --model haiku で最初の指示から英語の kebab-case を作る。
// 失敗・タイムアウト時は指示中の英数字の単語、それも無ければ task-<日時>。
import os from 'node:os';
import { run } from './exec';

const MAX = 40;
const TIMEOUT_MS = 25_000;

/** 任意の文字列を [a-z0-9-] の slug(最大 40 文字)にする。空になったら '' */
export function sanitizeSlug(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX)
    .replace(/-+$/, '');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** フォールバック: 指示の中の ASCII の単語をつなげる。無ければ task-yyyymmdd-hhmm */
export function fallbackSlug(instruction: string): string {
  const words = String(instruction ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const s = sanitizeSlug(words.join('-'));
  return s || `task-${stamp()}`;
}

/** モデルの出力から slug を取り出す(前置きや引用符が付いても拾えるように) */
function pickFromOutput(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.replace(/[`"'*]/g, '').replace(/^\s*(slug|branch)\s*[:：]\s*/i, '').trim())
    .filter(Boolean);
  // kebab-case らしい行を優先、無ければ最初の行
  const kebab = lines.find((l) => /^[a-z0-9]+(-[a-z0-9]+)+$/i.test(l));
  return sanitizeSlug(kebab ?? lines[0] ?? '');
}

export async function generateSlug(instruction: string, claudePath: string): Promise<{ slug: string; source: 'model' | 'fallback' }> {
  const text = String(instruction ?? '').trim();
  if (!text) return { slug: fallbackSlug(''), source: 'fallback' };
  const prompt =
    'Summarize the following task as a git branch slug. ' +
    'Output ONLY the slug: English, lowercase kebab-case, at most 40 characters, no prefix, no quotes, no explanation.\n\n' +
    `Task: ${text.slice(0, 2000)}`;
  // hooks を無効化して(本番デーモンへの通知ノイズを避ける)、セッションも保存しない
  const r = await run(
    claudePath,
    ['-p', '--model', 'haiku', '--settings', '{"disableAllHooks":true}', '--no-session-persistence', prompt],
    { cwd: os.tmpdir(), timeout: TIMEOUT_MS },
  );
  if (r.code === 0) {
    const s = pickFromOutput(r.stdout);
    if (s.length >= 3) return { slug: s, source: 'model' };
  } else {
    console.warn(`[slug] claude -p に失敗 (code ${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  return { slug: fallbackSlug(text), source: 'fallback' };
}
