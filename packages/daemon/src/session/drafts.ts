// 新規セッションの下書き(指示・プロジェクト・ブランチ名など)。デーモンの設定に保存するので、スマホで書いて PC から起動できる。
import crypto from 'node:crypto';
import type { SessionDraft } from '@cc-hub/shared';
import type { Store } from '../store/db';
import { HttpError } from '../util';

const KEY = 'session_drafts';
const MAX_DRAFTS = 50;
const TEXT_MAX = 20_000;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 受け取った下書きを検証して整える */
export function normalizeDraft(id: string, b: any, now = Date.now()): SessionDraft {
  if (!b || typeof b !== 'object') throw new HttpError(400, '下書きの形式が不正です');
  const d: SessionDraft = {
    id,
    kind: b.kind === 'folder' ? 'folder' : 'repo',
    repoId: str(b.repoId, 200) || null,
    cwd: str(b.cwd, 1000) || null,
    instruction: str(b.instruction, TEXT_MAX),
    name: str(b.name, 100),
    branchSlug: str(b.branchSlug, 100),
    mode: b.mode === 'plain' ? 'plain' : 'commander',
    updatedAt: now,
  };
  if (!d.instruction.trim() && !d.name.trim() && !d.branchSlug.trim()) throw new HttpError(400, '指示が空の下書きは保存できません');
  return d;
}

export class SessionDrafts {
  constructor(private readonly store: Store) {}

  /** 新しい順 */
  list(): SessionDraft[] {
    const raw = this.store.getSetting<SessionDraft[]>(KEY);
    return Array.isArray(raw) ? [...raw].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  }

  /** id が無ければ新しく作る。同じ id は上書き */
  put(id: string | null, body: unknown): SessionDraft {
    const draftId = id && /^[\w-]{1,64}$/.test(id) ? id : crypto.randomUUID();
    const d = normalizeDraft(draftId, body);
    const next = [d, ...this.list().filter((x) => x.id !== draftId)].slice(0, MAX_DRAFTS);
    this.store.setSetting(KEY, next);
    return d;
  }

  remove(id: string): void {
    this.store.setSetting(
      KEY,
      this.list().filter((x) => x.id !== id),
    );
  }
}
