// 新規セッションのモード(設定 → モード で編集)。一覧はデーモンから取り、画面間で共有する。
import { useEffect, useState } from 'react';
import { DEFAULT_MODES, type ModePreset } from '@cc-hub/shared';
import { api, pick } from './api';

let cache: ModePreset[] | null = null;
const listeners = new Set<(m: ModePreset[]) => void>();

function publish(m: ModePreset[]): ModePreset[] {
  cache = m;
  for (const l of listeners) l(m);
  return m;
}

export const modeApi = {
  load: async (): Promise<ModePreset[]> => publish(pick<ModePreset[]>(await api('/api/modes'), 'modes') ?? DEFAULT_MODES),
  save: async (modes: ModePreset[]): Promise<ModePreset[]> =>
    publish(pick<ModePreset[]>(await api('/api/modes', { modes }, { method: 'PUT' }), 'modes') ?? modes),
  reset: async (): Promise<ModePreset[]> => publish(pick<ModePreset[]>(await api('/api/modes/reset', {}), 'modes') ?? DEFAULT_MODES),
};

/** モードの一覧(取れるまでは既定の 6 つ) */
export function useModes(): ModePreset[] {
  const [modes, setModes] = useState<ModePreset[]>(cache ?? DEFAULT_MODES);
  useEffect(() => {
    listeners.add(setModes);
    modeApi.load().catch(() => undefined);
    return () => {
      listeners.delete(setModes);
    };
  }, []);
  return modes;
}
