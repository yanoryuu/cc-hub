// プリロード: レンダラーに ccHub API だけを公開する
import { contextBridge, ipcRenderer } from 'electron';

let selectCb: ((sid: string) => void) | null = null;
let pending: string | null = null; // コールバック登録前に届いた選択要求

ipcRenderer.on('hub:select-session', (_e, sid: string) => {
  if (selectCb) selectCb(sid);
  else pending = sid;
});

contextBridge.exposeInMainWorld('ccHub', {
  isDesktop: true,
  onSelectSession(cb: (sid: string) => void): void {
    selectCb = cb;
    if (pending) {
      const s = pending;
      pending = null;
      cb(s);
    }
  },
});
