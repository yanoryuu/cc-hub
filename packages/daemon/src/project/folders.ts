// フォルダのプロジェクト(Git が無くてもよい)。「プロジェクトを追加」で登録したフォルダを覚えておき、
// ホームとサイドバーにいつも出す。worktree・ブランチ・PR は使わず、そのフォルダで直接セッションを始める。
import fs from 'node:fs';
import path from 'node:path';
import type { FolderProject } from '@cc-hub/shared';
import type { Store } from '../store/db';
import { HttpError } from '../util';

const KEY = 'folder_projects';
const MAX_FOLDERS = 100;

/** 比べるときのパス(大文字小文字・区切り・末尾の \ を揃える) */
export function folderKey(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

export class FolderProjects {
  constructor(private readonly store: Store) {}

  list(): FolderProject[] {
    const v = this.store.getSetting<FolderProject[]>(KEY);
    return Array.isArray(v) ? v.filter((f) => f && typeof f.path === 'string') : [];
  }

  /** 登録する(既にあればそのまま)。フォルダが存在することだけ確かめる */
  add(input: unknown, now = Date.now()): FolderProject[] {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) throw new HttpError(400, 'フォルダのパスを指定してください');
    if (!path.isAbsolute(raw)) throw new HttpError(400, 'フォルダは絶対パスで指定してください');
    const p = path.resolve(raw);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      throw new HttpError(404, `フォルダが見つかりません: ${p}`);
    }
    if (!st.isDirectory()) throw new HttpError(400, `フォルダではありません: ${p}`);
    const list = this.list();
    if (list.some((f) => folderKey(f.path) === folderKey(p))) return list;
    if (list.length >= MAX_FOLDERS) throw new HttpError(400, `登録できるフォルダは ${MAX_FOLDERS} 件までです`);
    const next = [...list, { path: p, addedAt: now }];
    this.store.setSetting(KEY, next);
    return next;
  }

  /** 登録を外す(フォルダの中身には触れない) */
  remove(input: unknown): FolderProject[] {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) throw new HttpError(400, 'フォルダのパスを指定してください');
    const next = this.list().filter((f) => folderKey(f.path) !== folderKey(raw));
    this.store.setSetting(KEY, next);
    return next;
  }
}
