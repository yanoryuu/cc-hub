// WebSocket クライアント(/ws)。自動再接続 + 指数バックオフ。
// 購読トピックは参照カウントで管理し、再接続時にまとめて張り直す。
import type { ClientMessage, ServerMessage, Topic } from '@cc-hub/shared';
import { useHub } from './store';
import { emitTerm } from './termBus';
import { api, pickState } from './api';

const topicRefs = new Map<Topic, number>([['state', 1]]);
let ws: WebSocket | null = null;
let backoff = 500;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** トピックを購読する。戻り値の関数で解除 */
export function subscribe(topic: Topic): () => void {
  const n = topicRefs.get(topic) ?? 0;
  topicRefs.set(topic, n + 1);
  if (n === 0) send({ t: 'sub', topics: [topic] });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const m = (topicRefs.get(topic) ?? 1) - 1;
    if (m <= 0) {
      topicRefs.delete(topic);
      send({ t: 'unsub', topics: [topic] });
    } else topicRefs.set(topic, m);
  };
}

function handle(msg: ServerMessage): void {
  const st = useHub.getState();
  switch (msg.t) {
    case 'state.full':
      st.applyFull(msg.state);
      break;
    case 'session.upsert':
      st.upsertSession(msg.session);
      break;
    case 'session.remove':
      st.removeSession(msg.id);
      break;
    case 'agent.upsert':
      st.upsertAgent(msg.agent);
      break;
    case 'agent.remove':
      st.removeAgent(msg.agentId);
      break;
    case 'usage':
      st.setUsage(msg.usage);
      break;
    case 'repo.upsert':
      st.upsertRepo(msg.repo);
      break;
    case 'repo.remove':
      st.removeRepo(msg.id);
      break;
    case 'worktree.upsert':
      st.upsertWorktree(msg.worktree);
      break;
    case 'worktree.remove':
      st.removeWorktree(msg.id);
      break;
    case 'pr.upsert':
      st.upsertPr(msg.pr);
      break;
    case 'pr.remove':
      st.removePr(msg.id);
      break;
    case 'server.upsert':
      st.upsertServer(msg.server);
      break;
    case 'server.remove':
      st.removeServer(msg.id);
      break;
    case 'deploy.upsert':
      st.upsertDeploy(msg.deploy);
      break;
    case 'term.snapshot':
      emitTerm(msg.sid, { t: 'snapshot', data: msg.data, cols: msg.cols, rows: msg.rows });
      break;
    case 'term.data':
      emitTerm(msg.sid, { t: 'data', data: msg.data });
      break;
    case 'term.resize':
      emitTerm(msg.sid, { t: 'resize', cols: msg.cols, rows: msg.rows });
      break;
    case 'notify':
      st.pushToast(msg.event);
      break;
    case 'pong':
      break;
  }
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  let opened = false;

  sock.onopen = () => {
    opened = true;
    backoff = 500;
    useHub.getState().setConnected(true);
    const msg: ClientMessage = { t: 'sub', topics: [...topicRefs.keys()] };
    sock.send(JSON.stringify(msg));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    useHub.getState().setConnected(false);
    // 一度も開けなかった場合は認証切れの可能性 → REST で確認(401 なら PIN 画面へ)
    if (!opened) api('/api/state', undefined, { noRetry: true }).catch(() => {});
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoff + Math.random() * 300;
  backoff = Math.min(backoff * 2, 10000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // 認証待ちの間は接続しない(PIN ログイン後に startWs される)
    if (useHub.getState().auth !== 'ok') return;
    connect();
  }, delay);
}

/** 認証済みになったら呼ぶ。接続中なら何もしない */
export function startWs(): void {
  started = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  backoff = 500;
  connect();
}

/** タブ復帰時など: 切れていれば即再接続 */
export function kickWs(): void {
  if (started && !ws && useHub.getState().auth === 'ok') startWs();
}

/** 初期ロード: REST で状態を取り、WS を開始する */
export async function bootstrap(): Promise<void> {
  const st = useHub.getState();
  try {
    const r = await api('/api/state', undefined, { noRetry: true });
    const s = pickState(r);
    if (s) st.applyFull(s);
    st.setAuth('ok');
    startWs();
  } catch {
    // 401 なら api() が need_pin にしている。それ以外(デーモン停止など)は再接続ループに任せる
    if (useHub.getState().auth === 'checking') {
      st.setAuth('ok');
      startWs();
    }
  }
}
