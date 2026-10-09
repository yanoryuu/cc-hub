// デーモン内のイベントバス。WebSocket 層はこれを購読してクライアントに配る。
//   'state' : トピック 'state' の購読者に送る ServerMessage(session/agent/usage/notify)
//   'term'  : (sid, ServerMessage) トピック `term:<sid>` の購読者に送る
import { EventEmitter } from 'node:events';
import type { ServerMessage } from '@cc-hub/shared';

class Bus extends EventEmitter {
  state(msg: ServerMessage): void {
    this.emit('state', msg);
  }
  term(sid: string, msg: ServerMessage): void {
    this.emit('term', sid, msg);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
