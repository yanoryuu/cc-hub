// Electron preload が公開する API(packages/desktop の preload と合わせること)
export {};

declare global {
  interface Window {
    ccHub?: {
      isDesktop: true;
      /** トースト通知クリックなどで「このセッションを開いて」と要求されたとき */
      onSelectSession(cb: (sid: string) => void): void;
      /** Windows のフォルダ選択ダイアログ(キャンセルで null)。古いデスクトップ版には無い */
      pickFolder?: () => Promise<string | null>;
    };
  }
}
