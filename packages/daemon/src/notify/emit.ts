// 通知イベントの発行口。セッション / PR / アップロードはここを通して通知を出す。
//   1. WebSocket の 'state' 購読者(Web UI のアプリ内トースト)へ { t: 'notify' } を配る
//   2. NotifyService(Windows 通知 / Discord への振り分け)へ付加情報(meta)付きで渡す
import type { NotifyEvent, NotifyTopic } from '@cc-hub/shared';
import { bus } from '../bus';

/** 振り分けに使う付加情報(NotifyEvent には含めない) */
export interface NotifyMeta {
  /** 明示した通知の種類。省略時は kind / title から決める(topicOf) */
  topic?: NotifyTopic | null;
  repoId?: string | null;
  branch?: string | null;
  /** PR の URL(Discord のリンクに使う) */
  prUrl?: string | null;
  /** アップロード完了時の公開 URL など */
  url?: string | null;
  /** 申請者のセッション名など、セッション一覧に無い場合の表示名 */
  sessionName?: string | null;
}

export function emitNotify(event: NotifyEvent, meta: NotifyMeta = {}): void {
  bus.state({ t: 'notify', event });
  bus.emit('notify', event, meta);
}
