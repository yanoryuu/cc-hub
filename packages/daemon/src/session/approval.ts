// ApprovalDetector: 画面末尾を解析して、承認待ちの選択肢を取り出す(CC Remote の detectApproval を移植・拡張)。
//
// 対応する形式:
//   1) 番号付き選択肢   "❯ 1. Yes" / "  2. No"            → numbered=true、n は画面上の番号
//   2) 番号なし選択肢   "❯ No, exit" / "  Yes, I trust…"   → numbered=false
//      (信頼ダイアログなど。n は上から数えた 1 始まりの位置を文字列にしたもの: "1", "2", …)
//   3) (y/n) 形式        "... (y/n)"                       → type='yn'
//
// /approve での送信キー:
//   numbered   : 番号キーをそのまま送る(CC Remote クライアントと同じ。Claude Code は数字で即決定する)
//   unnumbered : 現在の選択位置から目的の位置まで ↑(\x1b[A) / ↓(\x1b[B) を送り、最後に \r
//   yn         : 'y' / 'n'
import type { Approval } from '@cc-hub/shared';

export interface DetectedApproval extends Approval {
  /** 番号付き選択肢か(false = カーソル移動で選ぶ形式) */
  numbered: boolean;
}

const QUESTION_RE = /do you want|would you like|allow |proceed\?|permission|trust/i;
const TRUST_RE = /trust this folder|one you trust|do you trust|trust the files/i;
const BORDER_RE = /^\s*[─━═╌╍┄┅—\-]{3,}/;
const BOX_RE = /^\s*[│╭╮╰╯┃]/;
// 選択メニューの操作ヒント(番号なし選択肢の判定に使う)
const HINT_RE = /enter\s*to\s*(confirm|select)|esc\s*to\s*(cancel|exit)|to\s*navigate|↑\s*\/?\s*↓/i;

export function detectApproval(lines: string[], cwd: string): DetectedApproval | null {
  const numbered = detectNumbered(lines, cwd);
  if (numbered) return numbered;
  const unnumbered = detectUnnumbered(lines, cwd);
  if (unnumbered) return unnumbered;
  const ynLine = lines.find((l) => /\((y\/n|yes\/no)\)\s*:?\s*$/i.test(l));
  if (ynLine) return { type: 'yn', question: ynLine.trim(), options: [], numbered: true };
  return null;
}

function isTrust(lines: string[]): boolean {
  return TRUST_RE.test(lines.join(' '));
}

function trustQuestion(cwd: string): string {
  return `このフォルダを信頼しますか(${cwd})`;
}

// 1) 番号付き(CC Remote と同じ判定: 2 件以上、どれかにカーソル印)
function detectNumbered(lines: string[], cwd: string): DetectedApproval | null {
  const optRe = /^[\s│┃]*(❯|>)?\s*(\d+)\.\s+(.+?)\s*[│┃]?\s*$/;
  const options: { n: string; label: string; selected: boolean; line: number }[] = [];
  let hasCursorMark = false;
  lines.forEach((l, i) => {
    const m = l.match(optRe);
    if (m) {
      if (m[1]) hasCursorMark = true;
      options.push({ n: m[2], label: m[3], selected: !!m[1], line: i });
    }
  });
  if (options.length < 2 || !hasCursorMark) return null;
  // 同じ番号が重複している場合(古いリストが画面に残っている等)は、最後の連番だけを使う
  let start = 0;
  for (let i = 1; i < options.length; i++) if (options[i].n === '1') start = i;
  const opts = options.slice(start);
  if (opts.length < 2 || !opts.some((o) => o.selected)) return null;
  const first = opts[0].line;
  const last = opts[opts.length - 1].line;
  // 質問文: 選択肢の上 10 行以内で、既知の質問パターン > '?' を含む行 > 直上の意味のある行 の順に採用
  // (AskUserQuestion のダイアログは「赤と青、どちらが好きですか？」のような自由な文になる)
  let question: string | null = null;
  let fallback: string | null = null;
  for (let i = first - 1; i >= Math.max(0, first - 10); i--) {
    const t = lines[i].replace(/[│┃]/g, '').trim();
    if (!t || BORDER_RE.test(lines[i])) continue;
    if (QUESTION_RE.test(t)) {
      question = t;
      break;
    }
    if (!question && /[?？]\s*$/.test(t)) question = t;
    if (!fallback && !/^[☐☑✔]/.test(t)) fallback = t;
  }
  // 誤検知対策(画面全体を見るため): 質問文があるか、選択肢の下 6 行以内に操作ヒントがあること
  const hint = lines.slice(last + 1, last + 7).some((l) => HINT_RE.test(l));
  if (!question && !hint) return null;
  if (isTrust(lines)) question = trustQuestion(cwd);
  return {
    type: 'options',
    question: question || fallback || 'Claude が確認を求めています',
    options: opts.map(({ n, label, selected }) => ({ n, label, selected })),
    numbered: true,
  };
}

// 2) 番号なし: "❯ label" 行と、同じ桁から始まる隣接行を選択肢とみなす。
//    入力欄("❯ " + 罫線)を誤検知しないよう、直後が罫線のものは除外し、下に操作ヒントがあることを条件にする。
function detectUnnumbered(lines: string[], cwd: string): DetectedApproval | null {
  const curRe = /^(\s*)❯\s+(\S.*?)\s*$/;
  let ci = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(curRe);
    if (m && !/^\d+\.\s/.test(m[2])) {
      ci = i;
      break;
    }
  }
  if (ci < 0) return null;
  const m = lines[ci].match(curRe)!;
  const labelCol = lines[ci].indexOf(m[2]);
  const isSibling = (l: string | undefined): string | null => {
    if (l == null || !l.trim() || BORDER_RE.test(l) || BOX_RE.test(l)) return null;
    const lead = l.length - l.trimStart().length;
    if (lead !== labelCol) return null;
    return l.trim();
  };
  let top = ci;
  while (top > 0 && isSibling(lines[top - 1])) top--;
  let bottom = ci;
  while (bottom < lines.length - 1 && isSibling(lines[bottom + 1])) bottom++;
  const count = bottom - top + 1;
  if (count < 2 || count > 9) return null;
  // 入力欄の判定: 選択肢ブロックの直下/直上が罫線なら入力ボックス
  if (BORDER_RE.test(lines[bottom + 1] ?? '') || BORDER_RE.test(lines[top - 1] ?? '')) return null;
  // 質問文(上方 8 行以内に '?' を含む行 or 既知の質問パターン)
  let question: string | null = null;
  for (let i = top - 1; i >= Math.max(0, top - 8); i--) {
    const t = lines[i].trim();
    if (t && (/[?？]/.test(t) || QUESTION_RE.test(t))) {
      question = t;
      break;
    }
  }
  // 誤検知対策: 選択肢の下 4 行以内に操作ヒント(Enter to confirm 等)があること。
  // (会話ログに残った複数行のプロンプト "❯ ..." + 字下げ行 を選択肢と誤認しないため)
  const hint = lines.slice(bottom + 1, bottom + 5).some((l) => HINT_RE.test(l));
  if (!hint) return null;
  const trust = isTrust(lines);
  const options = [];
  for (let i = top; i <= bottom; i++) {
    const label = i === ci ? m[2] : lines[i].trim();
    options.push({ n: String(i - top + 1), label, selected: i === ci });
  }
  return {
    type: 'options',
    question: trust ? trustQuestion(cwd) : question || 'Claude が確認を求めています',
    options,
    numbered: false,
  };
}

/**
 * /approve の option を PTY に送るキー列に変換する。
 * 戻り値は「順番に送るキー」の配列(カーソル移動は 1 キーずつ間隔を空けて送るため)。
 * option: 選択肢の n / 'y' / 'n'。options 形式で 'y'/'n' が来たら Yes/No で始まる選択肢に読み替える。
 */
export function approvalKeys(a: DetectedApproval, option: string): string[] | null {
  const opt = String(option).trim();
  if (a.type === 'yn') {
    if (/^y/i.test(opt)) return ['y'];
    if (/^n/i.test(opt)) return ['n'];
    return null;
  }
  let target = a.options.find((o) => o.n === opt);
  if (!target && /^(y|yes)$/i.test(opt)) target = a.options.find((o) => /^yes/i.test(o.label)) ?? a.options[0];
  if (!target && /^(n|no)$/i.test(opt)) target = a.options.find((o) => /^no/i.test(o.label)) ?? a.options[a.options.length - 1];
  if (!target) return null;
  if (a.numbered) return [target.n];
  const cur = Math.max(0, a.options.findIndex((o) => o.selected));
  const to = a.options.indexOf(target);
  const keys: string[] = [];
  const key = to > cur ? '\x1b[B' : '\x1b[A';
  for (let i = 0; i < Math.abs(to - cur); i++) keys.push(key);
  keys.push('\r');
  return keys;
}

/** ダイアログが画面から消えてから、承認を取り下げるまでの猶予(描き直しの途中の画面で一瞬消えて見えるのを無視する) */
export const APPROVAL_HOLD_MS = 700;

export interface StableApproval {
  /** 表示に使う検出結果 */
  value: DetectedApproval | null;
  /** 画面から消えて見え始めた時刻(猶予中だけ値が入る) */
  missSince: number | null;
  /** 猶予の終わりにもう一度調べるまでのミリ秒(不要なら null) */
  recheckMs: number | null;
}

/** next の選択肢がすべて prev にあり(番号とラベルが同じ)、数が少ないか */
function isPartialOf(next: DetectedApproval, prev: DetectedApproval): boolean {
  if (next.type !== prev.type || next.numbered !== prev.numbered || next.question !== prev.question) return false;
  if (next.options.length >= prev.options.length) return false;
  return next.options.every((o) => prev.options.some((p) => p.n === o.n && p.label === o.label));
}

/**
 * 画面の解析結果をそのまま出すと、描き直しの途中や、端末が低くてダイアログの一部しか見えないときに
 * 選択肢が減ったり消えたりして見える(スマホで承認の帯がガクガクする原因)。次のように落ち着かせる:
 * - 同じ質問のまま選択肢が一部しか見えないときは、前に見えた全部の選択肢を保つ(選択中の位置だけ新しくする)
 * - 画面から消えても、APPROVAL_HOLD_MS 続くまでは取り下げない
 * answered = ユーザーが答えた直後(このときは保たずに、画面のとおりにする)
 */
export function stabilizeApproval(
  prev: DetectedApproval | null,
  next: DetectedApproval | null,
  now: number,
  missSince: number | null,
  answered: boolean,
): StableApproval {
  if (!next) {
    if (!prev || answered) return { value: null, missSince: null, recheckMs: null };
    const since = missSince ?? now;
    const left = APPROVAL_HOLD_MS - (now - since);
    if (left <= 0) return { value: null, missSince: null, recheckMs: null };
    return { value: prev, missSince: since, recheckMs: left };
  }
  if (prev && !answered && isPartialOf(next, prev)) {
    const sel = next.options.find((o) => o.selected);
    const options = sel ? prev.options.map((o) => ({ ...o, selected: o.n === sel.n })) : prev.options;
    return { value: { ...prev, options }, missSince: null, recheckMs: null };
  }
  return { value: next, missSince: null, recheckMs: null };
}
