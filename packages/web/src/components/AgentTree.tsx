// サブエージェントの親子ツリー(選択中セッション分)
import { useMemo } from 'react';
import type { AgentNode, SessionInfo } from '@cc-hub/shared';
import { useHub } from '../store';
import { AGENT_STATUS_LABEL, fmtElapsed, useNow } from '../util';
import { StatusDot, toolText } from './common';

interface TreeNode {
  agent: AgentNode;
  children: TreeNode[];
}

function buildTree(agents: AgentNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const a of agents) byId.set(a.agentId, { agent: a, children: [] });
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    const p = n.agent.parentAgentId ? byId.get(n.agent.parentAgentId) : undefined;
    // 親が見つからない場合はメイン直下に置く
    if (p) p.children.push(n);
    else roots.push(n);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.agent.startedAt - b.agent.startedAt);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

function AgentRow({ node, now }: { node: TreeNode; now: number }) {
  const a = node.agent;
  const elapsed = (a.endedAt ?? now) - a.startedAt;
  return (
    <li className={`agent ag-${a.status}`}>
      <div className="agent-row">
        <span className={`adot ag-${a.status}`} title={AGENT_STATUS_LABEL[a.status]} aria-hidden="true" />
        <span className="agent-type">{a.type}</span>
        {a.model && <span className="agent-model">{a.model}</span>}
        <span className="agent-time" title={a.status === 'running' ? '経過時間' : '所要時間'}>
          {a.status === 'running' ? fmtElapsed(elapsed) : `${AGENT_STATUS_LABEL[a.status]} ${fmtElapsed(elapsed)}`}
        </span>
      </div>
      {a.description && <div className="agent-desc">{a.description}</div>}
      {a.status === 'running' && a.currentTool && (
        <div className="agent-tool mono" title={toolText(a)}>
          {toolText(a)}
        </div>
      )}
      {node.children.length > 0 && (
        <ul className="agent-children">
          {node.children.map((c) => (
            <AgentRow key={c.agent.agentId} node={c} now={now} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function AgentTree({ session }: { session: SessionInfo }) {
  const agents = useHub((s) => s.agents);
  const now = useNow(1000);
  const tree = useMemo(
    () => buildTree(Object.values(agents).filter((a) => a.sessionId === session.id)),
    [agents, session.id],
  );
  const running = useMemo(() => {
    let n = 0;
    for (const a of Object.values(agents)) if (a.sessionId === session.id && a.status === 'running') n++;
    return n;
  }, [agents, session.id]);

  return (
    <section className="panel-sec">
      <h3 className="sec-title">
        エージェント {running > 0 && <span className="count-pill">{running} 実行中</span>}
      </h3>
      <ul className="agent-tree">
        <li className="agent agent-main">
          <div className="agent-row">
            <StatusDot status={session.status} />
            <span className="agent-type">{session.mode === 'commander' ? 'commander' : 'main'}</span>
            {session.model && <span className="agent-model">{session.model}</span>}
            {session.currentTool && (
              <span className="agent-time">{fmtElapsed(now - session.currentTool.since)}</span>
            )}
          </div>
          {session.currentTool && (
            <div className="agent-tool mono" title={toolText(session)}>
              {toolText(session)}
            </div>
          )}
          {tree.length > 0 ? (
            <ul className="agent-children">
              {tree.map((n) => (
                <AgentRow key={n.agent.agentId} node={n} now={now} />
              ))}
            </ul>
          ) : (
            <div className="muted small agent-none">サブエージェントなし</div>
          )}
        </li>
      </ul>
    </section>
  );
}
