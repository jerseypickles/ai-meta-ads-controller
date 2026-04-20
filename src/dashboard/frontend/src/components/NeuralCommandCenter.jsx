import { useState, useEffect, useMemo, useCallback } from 'react';
import ReactFlow, { Background, Controls, Handle, Position, MarkerType } from 'reactflow';
import 'reactflow/dist/style.css';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// AGENT NODE — custom node con glow + status
// ═══════════════════════════════════════════════════════════════════════════

function AgentNode({ data }) {
  const { icon, name, role, status, metric, metricLabel, thinking } = data;

  return (
    <div className={`agent-node ${name.toLowerCase()} ${status === 'active' ? 'active' : ''} ${thinking ? 'thinking' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div className="agent-node-icon">{icon}</div>
      <div className="agent-node-name">{name}</div>
      {role && (
        <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', marginTop: 2 }}>
          {role}
        </div>
      )}
      <div className="agent-node-status">
        {status === 'active' && '● running'}
        {status === 'idle' && '○ idle'}
        {status === 'paused' && '◌ paused'}
        {thinking && '~ thinking'}
      </div>
      {metric && (
        <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--bos-text)' }}>
          <strong style={{ color: 'var(--bos-synapse)' }}>{metric}</strong>
          <div style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {metricLabel}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function NeuralCommandCenter({ onAgentClick }) {
  const [status, setStatus] = useState({});
  const [recentActivity, setRecentActivity] = useState([]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, []);

  async function loadStatus() {
    try {
      // Traemos el briefing context que ya tiene datos de todos los agentes
      const res = await api.get('/api/brain/briefing');
      const ctx = res.data.context;
      if (!ctx) return;

      setStatus({
        zeus: {
          directives_24h: ctx.zeus?.directives_24h || 0,
          executed: ctx.zeus?.executed_24h || 0,
          active: ctx.zeus?.active_pending || 0,
          cycles: ctx.zeus?.cycles_24h || 0
        },
        athena: {
          actions: ctx.agents?.unified_agent?.actions || 0,
          status: (ctx.agents?.unified_agent?.actions > 0) ? 'active' : 'idle'
        },
        apollo: {
          ready_pool: ctx.apollo?.ready_pool || 0,
          status: ctx.apollo?.ready_pool >= 60 ? 'paused' : 'idle'
        },
        prometheus: {
          active_tests: ctx.prometheus?.active_tests || 0,
          graduated: ctx.prometheus?.graduated_24h || 0,
          killed: ctx.prometheus?.killed_24h || 0,
          status: ctx.prometheus?.active_tests > 0 ? 'active' : 'idle'
        },
        ares: {
          actions: ctx.agents?.ares_agent?.actions || 0,
          status: (ctx.agents?.ares_agent?.actions > 0) ? 'active' : 'idle'
        },
        account: ctx.account
      });

      // Activity events para las edges — últimas directivas activas
      setRecentActivity(ctx.zeus?.active_pending > 0 ? ['athena', 'apollo', 'prometheus', 'ares'] : []);
    } catch (err) {
      console.error('NeuralCommandCenter error:', err);
    }
  }

  const nodes = useMemo(() => [
    {
      id: 'zeus',
      type: 'agent',
      position: { x: 340, y: 20 },
      data: {
        icon: '⚡',
        name: 'ZEUS',
        role: 'CEO · Opus 4.7',
        status: status.zeus?.cycles > 0 ? 'active' : 'idle',
        thinking: false,
        metric: `${status.zeus?.directives_24h || 0} directivas`,
        metricLabel: '24h'
      }
    },
    {
      id: 'athena',
      type: 'agent',
      position: { x: 50, y: 240 },
      data: {
        icon: '🦉',
        name: 'ATHENA',
        role: 'Account',
        status: status.athena?.status || 'idle',
        metric: `${status.athena?.actions || 0} ops`,
        metricLabel: '24h'
      }
    },
    {
      id: 'apollo',
      type: 'agent',
      position: { x: 230, y: 320 },
      data: {
        icon: '☀️',
        name: 'APOLLO',
        role: 'Creator',
        status: status.apollo?.status || 'idle',
        metric: `${status.apollo?.ready_pool || 0} ready`,
        metricLabel: 'pool'
      }
    },
    {
      id: 'prometheus',
      type: 'agent',
      position: { x: 450, y: 320 },
      data: {
        icon: '🔥',
        name: 'PROMETHEUS',
        role: 'Testing',
        status: status.prometheus?.status || 'idle',
        metric: `${status.prometheus?.active_tests || 0} tests`,
        metricLabel: 'activos'
      }
    },
    {
      id: 'ares',
      type: 'agent',
      position: { x: 640, y: 240 },
      data: {
        icon: '⚔️',
        name: 'ARES',
        role: 'Portfolio',
        status: status.ares?.status || 'idle',
        metric: `${status.ares?.actions || 0} ops`,
        metricLabel: '24h'
      }
    }
  ], [status]);

  const edges = useMemo(() => {
    const baseEdges = [
      { id: 'z-a', source: 'zeus', target: 'athena', animated: recentActivity.includes('athena'), style: { stroke: 'var(--bos-bio)' }, markerEnd: { type: MarkerType.Arrow, color: '#10b981' } },
      { id: 'z-ap', source: 'zeus', target: 'apollo', animated: recentActivity.includes('apollo'), style: { stroke: 'var(--bos-warn)' }, markerEnd: { type: MarkerType.Arrow, color: '#f59e0b' } },
      { id: 'z-p', source: 'zeus', target: 'prometheus', animated: recentActivity.includes('prometheus'), style: { stroke: 'var(--bos-danger)' }, markerEnd: { type: MarkerType.Arrow, color: '#ef4444' } },
      { id: 'z-ar', source: 'zeus', target: 'ares', animated: recentActivity.includes('ares'), style: { stroke: 'var(--bos-electric)' }, markerEnd: { type: MarkerType.Arrow, color: '#8b5cf6' } },
      { id: 'ap-p', source: 'apollo', target: 'prometheus', animated: status.apollo?.ready_pool > 0, style: { stroke: 'rgba(251, 191, 36, 0.4)', strokeDasharray: '4 4' } }
    ];
    return baseEdges;
  }, [status, recentActivity]);

  const onNodeClick = useCallback((_event, node) => {
    if (onAgentClick) onAgentClick(node.id);
  }, [onAgentClick]);

  return (
    <div className="neural-command">
      <div className="neural-command-header">
        <div className="neural-command-title">
          🧠 Neural Command Center
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          ROAS hoy <span style={{ color: 'var(--bos-bio)' }}>{status.account?.roas_today || '—'}x</span>
          {' · '}
          Revenue <span style={{ color: 'var(--bos-synapse)' }}>${status.account?.revenue_today?.toLocaleString() || 0}</span>
        </div>
      </div>
      <div className="neural-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          onNodeClick={onNodeClick}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background color="rgba(59, 130, 246, 0.08)" gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}
