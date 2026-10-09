// WebSocket /ws: 1 本の接続でトピックを多重化する。
//   'state'      → state.full(購読時)+ session/agent/usage/notify の差分
//   'term:<sid>' → term.snapshot(購読時)+ term.data / term.resize
// ターミナル出力は購読しているセッションの分だけ送る(スマホの通信量対策)。
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, HubState, ServerMessage, Topic } from '@cc-hub/shared';
import { bus } from '../bus';
import type { Auth } from './auth';
import type { SessionManager } from '../session/manager';

interface Client {
  ws: WebSocket;
  state: boolean;
  /** 購読中のセッション。値が配列ならスナップショット送信待ち(その間の term.data を溜める) */
  terms: Map<string, ServerMessage[] | null>;
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1e6 });
  private readonly clients = new Set<Client>();

  constructor(
    private readonly auth: Auth,
    private readonly sessions: SessionManager,
    private readonly getState: () => HubState,
  ) {
    bus.on('state', (msg: ServerMessage) => {
      const text = JSON.stringify(msg);
      for (const c of this.clients) if (c.state) this.sendRaw(c, text);
    });
    bus.on('term', (sid: string, msg: ServerMessage) => {
      let text: string | null = null;
      for (const c of this.clients) {
        if (!c.terms.has(sid)) continue;
        const q = c.terms.get(sid);
        if (q) q.push(msg);
        else this.sendRaw(c, (text ??= JSON.stringify(msg)));
      }
    });
    // 30 秒ごとに ping(切れた接続の掃除)
    setInterval(() => {
      for (const c of this.clients) {
        if ((c.ws as any).__alive === false) {
          c.ws.terminate();
          continue;
        }
        (c.ws as any).__alive = false;
        try {
          c.ws.ping();
        } catch {
          /* 無視 */
        }
      }
    }, 30000).unref();
  }

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws' || !this.auth.isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    const c: Client = { ws, state: false, terms: new Map() };
    (ws as any).__alive = true;
    this.clients.add(c);
    ws.on('pong', () => ((ws as any).__alive = true));
    ws.on('close', () => this.clients.delete(c));
    ws.on('error', () => this.clients.delete(c));
    ws.on('message', (raw) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === 'ping') return this.send(c, { t: 'pong' });
      if (m.t === 'sub' && Array.isArray(m.topics)) for (const t of m.topics) this.sub(c, t);
      if (m.t === 'unsub' && Array.isArray(m.topics)) for (const t of m.topics) this.unsub(c, t);
    });
  }

  private sub(c: Client, topic: Topic): void {
    if (topic === 'state') {
      c.state = true;
      this.send(c, { t: 'state.full', state: this.getState() });
      return;
    }
    if (typeof topic === 'string' && topic.startsWith('term:')) {
      const sid = topic.slice(5);
      if (!sid) return;
      // 購読開始: スナップショットができるまでの出力は溜めておき、スナップショットの後に流す
      const queue: ServerMessage[] = [];
      c.terms.set(sid, queue);
      this.sessions.snapshot(sid, (data, cols, rows) => {
        if (c.terms.get(sid) !== queue) return; // 途中で購読解除・再購読された
        this.send(c, { t: 'term.snapshot', sid, data, cols, rows });
        c.terms.set(sid, null);
        for (const m of queue) this.send(c, m);
      });
    }
  }

  private unsub(c: Client, topic: Topic): void {
    if (topic === 'state') c.state = false;
    else if (typeof topic === 'string' && topic.startsWith('term:')) c.terms.delete(topic.slice(5));
  }

  private send(c: Client, msg: ServerMessage): void {
    this.sendRaw(c, JSON.stringify(msg));
  }

  private sendRaw(c: Client, text: string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    // 極端に遅いクライアントは切る(バッファが 8MB を超えたら)
    if (c.ws.bufferedAmount > 8e6) {
      c.ws.terminate();
      return;
    }
    c.ws.send(text);
  }

  closeAll(): void {
    for (const c of this.clients) c.ws.terminate();
  }
}
