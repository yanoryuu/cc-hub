// 登録したフォルダのプロジェクト(Git なしでもよい)。一覧はデーモンから取り、画面間で共有する。
import { useEffect, useState } from 'react';
import type { FolderProject } from '@cc-hub/shared';
import { api, pick } from './api';

let cache: FolderProject[] | null = null;
const listeners = new Set<(f: FolderProject[]) => void>();

function publish(f: FolderProject[]): FolderProject[] {
  cache = f;
  for (const l of listeners) l(f);
  return f;
}

export const folderApi = {
  load: async (): Promise<FolderProject[]> => publish(pick<FolderProject[]>(await api('/api/folders'), 'folders') ?? []),
  add: async (path: string): Promise<FolderProject[]> =>
    publish(pick<FolderProject[]>(await api('/api/folders', { path }), 'folders') ?? cache ?? []),
  remove: async (path: string): Promise<FolderProject[]> =>
    publish(pick<FolderProject[]>(await api('/api/folders/remove', { path }), 'folders') ?? cache ?? []),
};

/** 登録したフォルダ(取れるまでは前回の値か空) */
export function useFolderProjects(): FolderProject[] {
  const [list, setList] = useState<FolderProject[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    folderApi.load().catch(() => undefined);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}
