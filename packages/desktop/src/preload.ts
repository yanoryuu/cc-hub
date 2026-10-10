// プリロード: レンダラーに ccHub API だけを公開する
import { contextBridge, ipcRenderer } from 'electron';

let selectCb: ((sid: string) => void) | null = null;
let pending: string | null = null; // コールバック登録前に届いた選択要求

ipcRenderer.on('hub:select-session', (_e, sid: string) => {
  if (selectCb) selectCb(sid);
  else pending = sid;
});

/** main と合わせる。ここに無いチャンネルは呼ばない */
const IPC_PICK_FOLDER = 'hub:pick-folder';

contextBridge.exposeInMainWorld('ccHub', {
  isDesktop: true,
  /** Windows のフォルダ選択ダイアログ。キャンセルなら null */
  async pickFolder(): Promise<string | null> {
    const r: unknown = await ipcRenderer.invoke(IPC_PICK_FOLDER);
    return typeof r === 'string' && r ? r : null;
  },
  onSelectSession(cb: (sid: string) => void): void {
    selectCb = cb;
    if (pending) {
      const s = pending;
      pending = null;
      cb(s);
    }
  },
});
