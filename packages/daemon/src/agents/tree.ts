// AgentTree: サブエージェントの親子ツリー(design §6 / 検証 V3)。
//
// 確認済みの事実:
//   - サブエージェント内から届く hooks には agent_id / agent_type が付く。メインスレッドの hooks には付かない
//   - PreToolUse(tool_name=Agent) に agent_id が付いていれば、それが「親」。無ければメイン直下
//   - SubagentStart の agent_id は「子」の ID
//   - PostToolUse(Agent) の tool_response.agentId で 子 ID ↔ tool_use_id が確定する
//   - <dirname(transcript_path)>/<session_id>/subagents/agent-<id>.meta.json に toolUseId 等がある(少し遅れて出来ることがある)
import fs from 'node:fs';
import path from 'node:path';
import type { AgentNode } from '@cc-hub/shared';
import { bus } from '../bus';
import type { Store } from '../store/db';
import { toolTarget } from '../util';

interface PendingSpawn {
  toolUseId: string;
  sessionId: string;
  parentAgentId: string | null;
  description: string;
  model: string | null;
  subagentType: string;
  ts: number;
  /** 対応付いた子エージェント ID */
  childId: string | null;
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);

export class AgentTree {
  readonly agents = new Map<string, AgentNode>();
  private readonly pending = new Map<string, PendingSpawn>(); // key = tool_use_id

  constructor(private readonly store: Store) {
    for (const a of store.loadAgents()) this.agents.set(a.agentId, a);
  }

  all(): Record<string, AgentNode> {
    return Object.fromEntries(this.agents);
  }

  /** hooks 1 件を処理する。sessionId はハブ側のセッション ID */
  handleHook(sessionId: string, b: any): void {
    const ev = String(b.hook_event_name || '');
    const agentId: string | null = typeof b.agent_id === 'string' && b.agent_id ? b.agent_id : null;
    const now = Date.now();
    switch (ev) {
      case 'PreToolUse': {
        if (AGENT_TOOLS.has(b.tool_name) && b.tool_use_id) {
          const ti = b.tool_input || {};
          this.pending.set(b.tool_use_id, {
            toolUseId: b.tool_use_id,
            sessionId,
            parentAgentId: agentId,
            description: String(ti.description || ''),
            model: ti.model ? String(ti.model) : null,
            subagentType: String(ti.subagent_type || 'general-purpose'),
            ts: now,
            childId: null,
          });
        }
        if (agentId) {
          const a = this.ensure(sessionId, agentId, b.agent_type);
          a.currentTool = { name: String(b.tool_name || ''), target: toolTarget(b.tool_name, b.tool_input), since: now };
          this.emit(a, false);
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (AGENT_TOOLS.has(b.tool_name) && b.tool_use_id) this.confirmSpawn(sessionId, b);
        if (agentId) {
          const a = this.ensure(sessionId, agentId, b.agent_type);
          a.currentTool = null;
          this.emit(a, false);
        }
        break;
      }
      case 'SubagentStart': {
        if (!agentId) break;
        this.onSubagentStart(sessionId, agentId, String(b.agent_type || ''), b);
        break;
      }
      case 'SubagentStop': {
        if (!agentId) break;
        const a = this.ensure(sessionId, agentId, b.agent_type);
        if (a.status === 'running') {
          a.status = 'done';
          a.endedAt = now;
        }
        a.currentTool = null;
        this.emit(a);
        break;
      }
    }
  }

  private onSubagentStart(sessionId: string, agentId: string, agentType: string, b: any): void {
    const existed = this.agents.get(agentId);
    const a = existed ?? this.newNode(sessionId, agentId, agentType);
    a.status = 'running';
    a.endedAt = null;
    if (agentType) a.type = agentType;
    // まずは推定: 同じセッション・同じ subagent_type の未対応 spawn のうち最も古いもの
    if (!this.spawnOf(agentId)) {
      const guess = [...this.pending.values()]
        .filter((p) => p.sessionId === sessionId && !p.childId && (!agentType || p.subagentType === agentType))
        .sort((x, y) => x.ts - y.ts)[0];
      if (guess) this.link(guess, a);
    }
    this.agents.set(agentId, a);
    this.emit(a);
    // meta.json で確定させる(遅れて作られることがあるので最大 ~2 秒リトライ)
    const tp = typeof b.transcript_path === 'string' ? b.transcript_path : '';
    const sid = typeof b.session_id === 'string' ? b.session_id : sessionId;
    if (tp) this.resolveFromMeta(path.join(path.dirname(tp), sid, 'subagents', `agent-${agentId}.meta.json`), agentId, 0);
  }

  private resolveFromMeta(file: string, agentId: string, attempt: number): void {
    fs.readFile(file, 'utf8', (err, text) => {
      if (err) {
        if (attempt < 10) setTimeout(() => this.resolveFromMeta(file, agentId, attempt + 1), 200);
        return;
      }
      let meta: any;
      try {
        meta = JSON.parse(text);
      } catch {
        return;
      }
      const a = this.agents.get(agentId);
      if (!a) return;
      const spawn = meta.toolUseId ? this.pending.get(meta.toolUseId) : undefined;
      if (spawn) {
        this.link(spawn, a);
      } else if (typeof meta.parentAgentId === 'string' || meta.spawnDepth === 1) {
        // spawn の PreToolUse を取りこぼした場合は meta の情報だけで決める
        this.setParent(a, meta.parentAgentId || null);
      }
      if (!a.description && meta.description) a.description = String(meta.description);
      if (!a.model && meta.model) a.model = String(meta.model);
      if (meta.agentType) a.type = String(meta.agentType);
      this.emit(a);
    });
  }

  private confirmSpawn(sessionId: string, b: any): void {
    const resp = b.tool_response || {};
    const childId: string | null = typeof resp.agentId === 'string' ? resp.agentId : null;
    const spawn = this.pending.get(b.tool_use_id);
    if (!childId) return;
    let a = this.agents.get(childId);
    if (!a) {
      // SubagentStart を取りこぼした: spawn 情報から作る
      a = this.newNode(sessionId, childId, spawn?.subagentType || 'general-purpose');
      a.status = resp.status === 'completed' || b.hook_event_name === 'PostToolUseFailure' ? 'done' : 'running';
      if (a.status === 'done') a.endedAt = Date.now();
      this.agents.set(childId, a);
    }
    if (b.hook_event_name === 'PostToolUseFailure' && a.status === 'running') {
      a.status = 'error';
      a.endedAt = Date.now();
    }
    if (spawn) this.link(spawn, a);
    this.emit(a);
  }

  /** spawn と子エージェントを対応付ける(別の子に推定で付いていたら外す) */
  private link(spawn: PendingSpawn, a: AgentNode): void {
    const prev = this.spawnOf(a.agentId);
    if (prev && prev !== spawn) prev.childId = null;
    if (spawn.childId && spawn.childId !== a.agentId) {
      // この spawn に誤って推定されていた別エージェントは親未確定に戻す(meta / PostToolUse で再確定される)
      spawn.childId = null;
    }
    spawn.childId = a.agentId;
    if (spawn.description) a.description = spawn.description;
    if (spawn.model) a.model = spawn.model;
    this.setParent(a, spawn.parentAgentId);
  }

  private spawnOf(agentId: string): PendingSpawn | undefined {
    for (const p of this.pending.values()) if (p.childId === agentId) return p;
    return undefined;
  }

  private setParent(a: AgentNode, parentId: string | null): void {
    a.parentAgentId = parentId && parentId !== a.agentId ? parentId : null;
    this.recomputeDepth(a);
  }

  private recomputeDepth(a: AgentNode, guard = 0): void {
    const parent = a.parentAgentId ? this.agents.get(a.parentAgentId) : undefined;
    const depth = parent ? parent.depth + 1 : 1;
    if (depth !== a.depth) {
      a.depth = depth;
      if (guard < 20) {
        for (const c of this.agents.values()) {
          if (c.parentAgentId === a.agentId) {
            this.recomputeDepth(c, guard + 1);
            this.emit(c);
          }
        }
      }
    }
  }

  private newNode(sessionId: string, agentId: string, type: string): AgentNode {
    return {
      agentId,
      sessionId,
      parentAgentId: null,
      type: type || 'general-purpose',
      description: '',
      model: null,
      status: 'running',
      currentTool: null,
      startedAt: Date.now(),
      endedAt: null,
      depth: 1,
    };
  }

  /** hooks が先に届いた未知のエージェントは、その場で作る */
  private ensure(sessionId: string, agentId: string, agentType: unknown): AgentNode {
    let a = this.agents.get(agentId);
    if (!a) {
      a = this.newNode(sessionId, agentId, typeof agentType === 'string' ? agentType : '');
      this.agents.set(agentId, a);
    }
    return a;
  }

  private emit(a: AgentNode, persist = true): void {
    if (persist) this.store.saveAgent(a);
    bus.state({ t: 'agent.upsert', agent: { ...a } });
  }

  /** セッション終了時: 実行中のエージェントを done にする */
  finishSession(sessionId: string): void {
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (a.sessionId === sessionId && a.status === 'running') {
        a.status = 'done';
        a.endedAt = now;
        a.currentTool = null;
        this.emit(a);
      }
    }
    for (const [k, p] of this.pending) if (p.sessionId === sessionId) this.pending.delete(k);
  }

  removeSession(sessionId: string): void {
    for (const a of [...this.agents.values()]) {
      if (a.sessionId === sessionId) {
        this.agents.delete(a.agentId);
        bus.state({ t: 'agent.remove', agentId: a.agentId });
      }
    }
    for (const [k, p] of this.pending) if (p.sessionId === sessionId) this.pending.delete(k);
  }

  /** 古い spawn 情報を捨てる(1 時間以上前で対応付け済み、または 6 時間以上前) */
  gc(): void {
    const now = Date.now();
    for (const [k, p] of this.pending) {
      if ((p.childId && now - p.ts > 3600_000) || now - p.ts > 6 * 3600_000) this.pending.delete(k);
    }
  }
}
