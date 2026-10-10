// デスクトップアプリが接続していないときに、デーモン自身が Windows のトースト通知を出す(node-notifier / SnoreToast)。
// node-notifier は同梱の実行ファイル(vendor/snoreToast)を __dirname から探すため、esbuild では external にしている。
import fs from 'node:fs';
import path from 'node:path';

export interface ToastInput {
  title: string;
  message: string;
}

export type Toaster = (t: ToastInput) => Promise<void>;

/** packages/desktop/assets/icon.ico(無ければ icon.png)。daemon パッケージのルートから辿る */
function findIcon(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@cc-hub/daemon') {
        for (const f of ['icon.ico', 'icon.png']) {
          const p = path.join(dir, '..', 'desktop', 'assets', f);
          if (fs.existsSync(p)) return p;
        }
        return undefined;
      }
    } catch {
      /* 上へ */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

let icon: string | undefined | null = null;

/** node-notifier でトーストを出す(失敗はログだけ) */
export const nodeToaster: Toaster = (t) =>
  new Promise((resolve) => {
    // 検証用: 実際のトーストを出さずにログだけ残す
    if (process.env.CC_HUB_TEST === '1' && process.env.CC_HUB_NO_TOAST === '1') {
      console.log(`[notify] (検証のためトーストは出しません) ${t.title}`);
      return resolve();
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WindowsToaster } = require('node-notifier') as typeof import('node-notifier');
      if (icon === null) icon = findIcon();
      const toaster = new WindowsToaster({ withFallback: false });
      toaster.notify(
        { title: t.title.slice(0, 120), message: t.message.slice(0, 250) || ' ', appID: 'CC Hub', icon, sound: false, wait: false } as any,
        (err: Error | null) => {
          if (err) console.warn(`[notify] Windows 通知に失敗: ${err.message}`);
          resolve();
        },
      );
    } catch (e) {
      console.warn(`[notify] Windows 通知に失敗: ${(e as Error).message}`);
      resolve();
    }
  });
