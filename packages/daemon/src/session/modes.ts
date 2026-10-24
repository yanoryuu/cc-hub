// 新規セッションのモード(設定 → モード で追加・編集・並べ替え)。デーモンの設定に保存する。
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_MODE_IDS, DEFAULT_MODES, MODE_PERMISSIONS, isSessionModel, type ModePermission, type ModePreset } from '@cc-hub/shared';
import type { Store } from '../store/db';
import { HttpError } from '../util';

const KEY = 'session_modes';
const MAX_MODES = 30;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLACEHOLDER = '{{instruction}}';
/** readOnly のモードで使わせないツール(--disallowedTools=… の形で渡す。空白区切りだと後ろの指示まで飲み込まれる) */
export const READ_ONLY_ARG = '--disallowedTools=Edit,Write,NotebookEdit';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 受け取ったモードの一覧を検証して整える。commander / plain が無ければ既定のものを足す */
export function normalizeModes(body: unknown): ModePreset[] {
  if (!Array.isArray(body)) throw new HttpError(400, 'モードの一覧を配列で送ってください');
  if (body.length > MAX_MODES) throw new HttpError(400, `モードは ${MAX_MODES} 個までです`);
  const out: ModePreset[] = [];
  for (const b of body as any[]) {
    const id = str(b?.id, 32).toLowerCase();
    if (!ID_RE.test(id)) throw new HttpError(400, `モードの id は英小文字・数字・- で付けてください: ${id || '(空)'}`);
    if (out.some((m) => m.id === id)) throw new HttpError(400, `モードの id が重複しています: ${id}`);
    const pm = b.permissionMode;
    if (pm != null && pm !== '' && !MODE_PERMISSIONS.includes(pm)) throw new HttpError(400, `権限モードが不正です: ${String(pm).slice(0, 20)}`);
    if (b.model != null && b.model !== '' && !isSessionModel(b.model)) throw new HttpError(400, `モデルが不正です: ${String(b.model).slice(0, 20)}`);
    out.push({
      id,
      label: str(b.label, 20) || id,
      description: str(b.description, 200),
      prompt: str(b.prompt, 4000),
      permissionMode: pm ? (pm as ModePermission) : null,
      model: b.model ? String(b.model) : null,
      readOnly: !!b.readOnly,
    });
  }
  for (const id of BUILTIN_MODE_IDS) {
    if (!out.some((m) => m.id === id)) out.push({ ...DEFAULT_MODES.find((m) => m.id === id)! });
  }
  return out;
}

/** モードに合わせて最初の指示を組み立てる。空なら undefined(指示なしで起動) */
export function buildModePrompt(mode: ModePreset | undefined, instruction: string | undefined, hasLocalCommander: boolean): string | undefined {
  const text = String(instruction ?? '').trim();
  let tpl = mode?.prompt.trim() ?? '';
  if (/^\/commander(\s|$)/.test(tpl) && !hasLocalCommander) tpl = tpl.replace(/^\/commander/, '/hub-commander');
  if (!tpl) return text || undefined;
  if (tpl.includes(PLACEHOLDER)) {
    // 指示が空ならテンプレートの指示部分も空のまま渡す(スラッシュコマンドだけのモードと同じ扱い)
    return tpl.split(PLACEHOLDER).join(text).trim() || undefined;
  }
  return text ? `${tpl} ${text}` : tpl;
}

/** リポジトリに自前の commander スキルがあるか */
export const hasLocalCommander = (cwd: string): boolean => fs.existsSync(path.join(cwd, '.claude', 'skills', 'commander', 'SKILL.md'));

export class SessionModes {
  constructor(private readonly store: Store) {}

  list(): ModePreset[] {
    const raw = this.store.getSetting<ModePreset[]>(KEY);
    if (!Array.isArray(raw) || !raw.length) return DEFAULT_MODES.map((m) => ({ ...m }));
    try {
      return normalizeModes(raw);
    } catch {
      return DEFAULT_MODES.map((m) => ({ ...m }));
    }
  }

  get(id: string | null | undefined): ModePreset | undefined {
    return id ? this.list().find((m) => m.id === id) : undefined;
  }

  put(body: unknown): ModePreset[] {
    const next = normalizeModes(body);
    this.store.setSetting(KEY, next);
    return next;
  }

  /** 既定の 6 つに戻す */
  reset(): ModePreset[] {
    this.store.setSetting(KEY, null);
    return this.list();
  }

  /** StartSessionRequest.mode を検証する。省略は plain、知らない値は 400 */
  resolve(v: unknown): ModePreset {
    if (v == null || v === '') return this.get('plain')!;
    const m = this.get(String(v));
    if (!m) throw new HttpError(400, `モードが見つかりません: ${String(v).slice(0, 40)}`);
    return m;
  }
}
