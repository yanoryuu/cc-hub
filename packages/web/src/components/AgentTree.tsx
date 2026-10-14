// サブエージェントの親子ツリー(選択中セッション分)
import { useMemo, useState } from 'react';
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

/** main の下のサブエージェントを閉じているか(セッションをまたいで覚える) */
const MAIN_KEY = 'cchub.agentsMainCollapsed';
function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(MAIN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 開く / 閉じるの三角(子が無ければ同じ幅の空き) */
function Caret({ open, onClick, label }: { open: boolean; onClick?: () => void; label: string }) {
  if (!onClick) return <span className="agent-caret empty" aria-hidden="true" />;
  return (
    <button type="button" className="agent-caret" onClick={onClick} aria-expanded={open} aria-label={label} title={label}>
      {open ? '▾' : '▸'}
    </button>
  );
}

/** 子孫の数と、そのうち実行中の数 */
function countTree(list: TreeNode[]): { total: number; running: number } {
  let total = 0;
  let running = 0;
  for (const n of list) {
    total++;
    if (n.agent.status === 'running') running++;
    const c = countTree(n.children);
    total += c.total;
    running += c.running;
  }
  return { total, running };
}

function AgentRow({ node, now }: { node: TreeNode; now: number }) {
  const a = node.agent;
  // 子のあるエージェントも個別に閉じられる(既定は開く)
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const elapsed = (a.endedAt ?? now) - a.startedAt;
  return (
    <li className={`agent ag-${a.status}`}>
      <div className="agent-row">
        <Caret open={open} onClick={hasChildren ? () => setOpen((v) => !v) : undefined} label={open ? '子エージェントを閉じる' : '子エージェントを開く'} />
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
      {hasChildren && !open && <div className="muted small agent-none">子エージェント {countTree(node.children).total} 件(閉じています)</div>}
      {hasChildren && open && (
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
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(MAIN_KEY, v ? '0' : '1');
      } catch {
        /* 保存できなくても表示は切り替える */
      }
      return !v;
    });
  const total = useMemo(() => countTree(tree), [tree]);

  return (
    <section className="panel-sec">
      <h3 className="sec-title">
        エージェント {running > 0 && <span className="count-pill">{running} 実行中</span>}
      </h3>
      <ul className="agent-tree">
        <li className="agent agent-main">
          <div className="agent-row">
            <Caret
              open={!collapsed}
              onClick={tree.length > 0 ? toggle : undefined}
              label={collapsed ? 'サブエージェントを開く' : 'サブエージェントをまとめて閉じる'}
            />
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
          {tree.length > 0 && collapsed ? (
            <button type="button" className="link-btn small agent-none" onClick={toggle}>
              サブエージェント {total.total} 件{total.running > 0 ? `(${total.running} 実行中)` : ''} — 開く
            </button>
          ) : tree.length > 0 ? (
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
