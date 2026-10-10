// デザイントークンのコントラスト比を計算して表にする(WCAG 2.x の相対輝度)。
//   node packages/web/scripts/contrast.mjs
// src/styles.css の :root からトークンを読み取るので、色を変えたらこれを流して確認する。
// 目標: 本文・副次テキスト ≥ 4.5、補助(三次)テキスト・入力欄の枠 ≥ 3.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'src', 'styles.css'), 'utf8');

// :root { ... } のブロックをすべて読む(後勝ち)
const tok = {};
for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const d of m[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tok[d[1]] = d[2];
}

function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function lum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** color-mix(in srgb, fg pct%, bg) の近似 */
function mix(fg, pct, bg) {
  return fg.map((c, i) => Math.round(c * pct + bg[i] * (1 - pct)));
}
const val = (name) => {
  if (name.startsWith('#')) return rgb(name);
  if (!tok[name]) throw new Error(`トークンがありません: --${name}`);
  return rgb(tok[name]);
};

// [前景, 背景, 目標, 用途]。背景は "mix:<色>:<割合>:<下地>" で color-mix のバッジ背景を表す
const BG = (spec) => {
  if (!spec.startsWith('mix:')) return val(spec);
  const [, c, p, base] = spec.split(':');
  return mix(val(c), Number(p), val(base));
};
const pairs = [];
const add = (fg, bg, min, use) => pairs.push({ fg, bg, min, use });

for (const bg of ['bg', 'panel', 'panel-2', 'panel-3']) {
  add('fg', bg, 4.5, '本文');
  add('fg-2', bg, 4.5, '副次テキスト');
  add('muted', bg, 4.5, 'ラベル・補足');
  add('dim', bg, 3, '三次(区切り・無効)');
}
add('fg', 'bg-term', 4.5, 'ターミナル本文');
add('accent', 'bg', 4.5, 'リンク・ブランチ名');
add('accent', 'panel', 4.5, 'リンク・ブランチ名');
add('accent', 'panel-3', 4.5, '選択中の行のブランチ名');
add('accent', 'accent-bg', 4.5, '選択中ボタン');
for (const st of ['st-running', 'st-approval', 'st-input', 'st-idle', 'st-error', 'st-stopped', 'st-starting']) {
  add(st, 'panel', 4.5, '状態ラベル(一覧)');
  add(st, `mix:${st}:0.16:panel`, 4.5, '状態バッジ');
}
add('#ffffff', 'primary', 4.5, '主ボタン');
add('warn-fg', 'warn-bg', 4.5, '警告ボックス');
add('approve-fg', 'approve', 4.5, '許可ボタン');
add('deny-fg', 'deny', 4.5, '拒否ボタン');
add('danger-fg', 'danger-bg', 4.5, '危険ボタン');
// 管理画面: 変更の種類バッジ / push 済みバッジ / トークンのグラフ(非テキスト)
for (const c of ['diff-add', 'st-running', 'st-error', 'wt-warming', 'st-approval', 'muted', 'st-input']) {
  add(c, `mix:${c}:0.14:panel`, 4.5, '変更の種類バッジ(管理画面)');
}
add('warn-fg', 'panel', 4.5, '未 push(管理画面)');
add('dim', 'bg-term', 3, 'コードの行番号');
for (const c of ['st-running', 'st-input', 'wt-warming']) add(c, 'bg', 3, 'トークンのグラフ(非テキスト)');
add('border-input', 'bg', 3, '入力欄の枠(非テキスト)');
add('border-input', 'panel', 3, '入力欄の枠(非テキスト)');

let fail = 0;
const rows = pairs.map((p) => {
  const r = ratio(BG(p.fg), BG(p.bg));
  const ok = r >= p.min;
  if (!ok) fail++;
  const name = (s) => (s.startsWith('#') ? s : s.startsWith('mix:') ? `${s.split(':')[1]} 16% / ${s.split(':')[3]}` : `--${s}`);
  return { 前景: name(p.fg), 背景: name(p.bg), 比: r.toFixed(2), 目標: p.min, 判定: ok ? 'OK' : 'NG', 用途: p.use };
});
const cols = Object.keys(rows[0]);
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
const line = (r) => '| ' + cols.map((c, i) => String(r[c]).padEnd(w[i])).join(' | ') + ' |';
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|');
for (const r of rows) console.log(line(r));
console.log(`\n${pairs.length} 組中 NG ${fail}`);
process.exitCode = fail ? 1 : 0;
