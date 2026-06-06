import React from 'react';
import { motion } from 'framer-motion';
import { AGENTS, ZEUS, AGENT_KPIS, agentColor } from './agents';

// Posición de un orbe en el anillo (angle 0 = arriba, horario)
function ringPos(angleDeg, radius) {
  const r = (angleDeg - 90) * (Math.PI / 180); // -90 → 0° arriba
  return { x: 50 + radius * Math.cos(r), y: 50 + radius * Math.sin(r) };
}

function fmtKpi(val, kpi) {
  if (val == null) return '—';
  return kpi.money ? `$${Number(val).toLocaleString()}` : String(val);
}

function AgentOrb({ agent, data, selected, compact, onSelect }) {
  const color = agentColor(agent.id);
  const size = compact ? 46 : 96;
  const kpis = (AGENT_KPIS[agent.id] || []).slice(0, 2);
  const status = data?.status || 'active';
  return (
    <motion.button
      onClick={() => onSelect(agent.id)}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: selected ? 1.12 : 1 }}
      whileHover={{ scale: selected ? 1.14 : 1.08 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      style={{
        position: 'absolute', left: '50%', top: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'transparent', border: 'none', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        zIndex: selected ? 4 : 2
      }}
    >
      {/* orbe */}
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${color} 80%, white), ${color} 45%, color-mix(in srgb, ${color} 30%, transparent) 100%)`,
        boxShadow: `0 0 ${selected ? 38 : 24}px color-mix(in srgb, ${color} ${selected ? 75 : 55}%, transparent), inset 0 0 14px rgba(0,0,0,0.35)`,
        border: `1px solid color-mix(in srgb, ${color} 60%, transparent)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: compact ? '1.1rem' : '2rem', position: 'relative'
      }}>
        <span style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}>{agent.icon}</span>
        {agent.awareness && (
          <div style={{ position: 'absolute', inset: -5, borderRadius: '50%', border: `1px dashed color-mix(in srgb, ${color} 50%, transparent)` }} />
        )}
      </div>
      {!compact && (
        <div style={{ textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#f9fafb', letterSpacing: '0.03em', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>{agent.label}</div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{agent.role}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 2 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: status === 'active' ? '#10b981' : '#6b7280', boxShadow: status === 'active' ? '0 0 6px #10b981' : 'none' }} />
            <span style={{ fontSize: '0.56rem', color: status === 'active' ? '#34d399' : '#9ca3af', textTransform: 'capitalize' }}>{status === 'active' ? 'Activo' : status}</span>
          </div>
          {kpis.length > 0 && (
            <div style={{ marginTop: 3, display: 'flex', gap: 8, justifyContent: 'center' }}>
              {kpis.map(k => (
                <div key={k.key} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>
                    {fmtKpi((data?.kpis && data.kpis[k.key]) ?? data?.[k.key], k)}
                  </div>
                  <div style={{ fontSize: '0.48rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.button>
  );
}

export default function GalaxyCanvas({ agentsData = {}, selected, onSelect, compact = false }) {
  const radius = compact ? 38 : 34;
  const positions = AGENTS.map(a => ({ a, p: ringPos(a.angle, radius) }));

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Nebulosa de fondo */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 45%, rgba(59,130,246,0.10), transparent 55%), radial-gradient(ellipse at 70% 75%, rgba(168,85,247,0.06), transparent 50%), radial-gradient(ellipse at 25% 70%, rgba(16,185,129,0.05), transparent 50%)',
        pointerEvents: 'none'
      }} />

      {/* Líneas de conexión Zeus → agentes */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} preserveAspectRatio="none">
        {positions.map(({ a, p }) => (
          <line key={a.id} x1="50%" y1="50%" x2={`${p.x}%`} y2={`${p.y}%`}
            stroke={`var(--ag-${a.id})`} strokeOpacity={selected === a.id ? 0.55 : 0.18}
            strokeWidth={selected === a.id ? 1.6 : 1} strokeDasharray={a.awareness ? '4 5' : 'none'} />
        ))}
      </svg>

      {/* Orbes de agentes */}
      {positions.map(({ a, p }) => (
        <div key={a.id} style={{ position: 'absolute', left: `${p.x}%`, top: `${p.y}%`, width: 0, height: 0 }}>
          <AgentOrb agent={a} data={agentsData[a.id]} selected={selected === a.id} compact={compact} onSelect={onSelect} />
        </div>
      ))}

      {/* Zeus centro */}
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0 }}>
        <motion.button
          onClick={() => onSelect('zeus')}
          whileHover={{ scale: 1.06 }}
          animate={{ scale: selected === 'zeus' ? 1.1 : 1 }}
          style={{
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, zIndex: 5
          }}
        >
          <div style={{
            width: compact ? 64 : 130, height: compact ? 64 : 130, borderRadius: '50%',
            background: 'radial-gradient(circle at 38% 32%, #93c5fd, var(--ag-zeus) 45%, rgba(59,130,246,0.15) 100%)',
            boxShadow: `0 0 ${selected === 'zeus' ? 60 : 44}px rgba(59,130,246,0.6), inset 0 0 22px rgba(0,0,0,0.35)`,
            border: '1px solid rgba(96,165,250,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? '1.6rem' : '3rem'
          }}>
            <span style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))' }}>{ZEUS.icon}</span>
          </div>
          {!compact && (
            <div style={{ textAlign: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', letterSpacing: '0.06em', textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>ZEUS</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--blue-light)' }}>Cerebro</div>
            </div>
          )}
        </motion.button>
      </div>
    </div>
  );
}
