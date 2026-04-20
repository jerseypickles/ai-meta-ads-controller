import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../api';

export default function ZeusPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [intelRes, briefingRes] = await Promise.all([
        api.get('/api/zeus/intelligence').catch(() => ({ data: {} })),
        api.get('/api/brain/briefing').catch(() => ({ data: {} }))
      ]);
      setData({
        intelligence: intelRes.data,
        context: briefingRes.data?.context
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="bos-loading">Cargando Zeus...</div>;

  const directives = data?.intelligence?.directives || [];
  const hypotheses = data?.intelligence?.hypotheses || [];
  const recentThoughts = data?.intelligence?.thoughts || [];
  const activeDirectives = directives.filter(d => d.active);
  const executedDirectives = directives.filter(d => d.executed);

  const typeColor = {
    prioritize: 'var(--bos-synapse)',
    force_graduate: 'var(--bos-danger)',
    alert: 'var(--bos-warn)',
    adjust: 'var(--bos-electric)',
    avoid: '#6b7280'
  };

  const targetIcon = {
    athena: '🦉',
    apollo: '☀️',
    prometheus: '🔥',
    ares: '⚔️',
    all: '🌐'
  };

  return (
    <div>
      <PanelHeader icon="⚡" name="ZEUS" role="CEO · Opus 4.7" color="var(--bos-synapse)" />

      {/* Stats row */}
      <div style={gridStyle(4)}>
        <Stat label="Ciclos 24h" value={data?.context?.zeus?.cycles_24h || 0} color="var(--bos-synapse)" />
        <Stat label="Directivas" value={data?.context?.zeus?.directives_24h || 0} color="var(--bos-text)" />
        <Stat label="Ejecutadas" value={data?.context?.zeus?.executed_24h || 0} color="var(--bos-bio)" />
        <Stat label="Pending" value={data?.context?.zeus?.active_pending || 0} color="var(--bos-warn)" />
      </div>

      {/* Directivas activas */}
      <Section title="Directivas activas" count={activeDirectives.length}>
        {activeDirectives.length === 0 ? (
          <Empty>No hay directivas pendientes de ejecución</Empty>
        ) : (
          activeDirectives.slice(0, 8).map((d, i) => (
            <motion.div
              key={d._id || i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              style={{
                background: 'rgba(17, 21, 51, 0.5)',
                borderLeft: `3px solid ${typeColor[d.directive_type] || '#6b7280'}`,
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 8
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: '1rem' }}>{targetIcon[d.target_agent] || '?'}</span>
                <span style={{ fontSize: '0.65rem', color: typeColor[d.directive_type], textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                  {d.directive_type}
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', marginLeft: 'auto' }}>
                  conf {Math.round((d.confidence || 0) * 100)}%
                </span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--bos-text)', lineHeight: 1.4 }}>
                {d.directive}
              </div>
            </motion.div>
          ))
        )}
      </Section>

      {/* Hypothesis tracking */}
      <Section title="Hipótesis activas" count={hypotheses.length}>
        {hypotheses.length === 0 ? (
          <Empty>Zeus no tiene hipótesis activas</Empty>
        ) : (
          hypotheses.slice(0, 5).map((h, i) => {
            const v = h.diagnosis || h.data_points?.verdict;
            const verdictIcon = v === 'confirmed' ? '✓' : v === 'rejected' ? '✗' : v === 'inconclusive' ? '?' : '⏳';
            const verdictColor = v === 'confirmed' ? 'var(--bos-bio)' : v === 'rejected' ? 'var(--bos-danger)' : 'var(--bos-text-muted)';
            return (
              <motion.div
                key={h._id || i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '0.8rem' }}
              >
                <span style={{ color: verdictColor, marginRight: 8, fontFamily: 'JetBrains Mono, monospace' }}>{verdictIcon}</span>
                <span style={{ color: 'var(--bos-text)' }}>{(h.body || h.title || '').substring(0, 140)}</span>
                {h.data_points?.evidence && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)', marginTop: 4, marginLeft: 20 }}>
                    {h.data_points.evidence}
                  </div>
                )}
              </motion.div>
            );
          })
        )}
      </Section>

      {/* Recent thoughts */}
      {recentThoughts.length > 0 && (
        <Section title="Últimos pensamientos" count={recentThoughts.length}>
          {recentThoughts.slice(0, 5).map((t, i) => (
            <div key={i} style={{ padding: '6px 0', fontSize: '0.78rem', color: 'var(--bos-text)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span style={{ color: 'var(--bos-neural)', marginRight: 6 }}>💭</span>
              {(t.message || t.thought || '').substring(0, 180)}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared components for all agent panels
// ═══════════════════════════════════════════════════════════════════════════

export function PanelHeader({ icon, name, role, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300 }}
        style={{
          fontSize: '2.6rem',
          filter: `drop-shadow(0 0 20px ${color})`
        }}
      >
        {icon}
      </motion.div>
      <div>
        <div style={{
          fontSize: '1.7rem',
          fontWeight: 700,
          color: 'var(--bos-text)',
          letterSpacing: '0.02em'
        }}>
          {name}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          {role}
        </div>
      </div>
    </div>
  );
}

export function Section({ title, count, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: '0.7rem',
        color: 'var(--bos-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        fontWeight: 600,
        marginBottom: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }}>
        <span>{title}</span>
        {count != null && (
          <span style={{
            background: 'rgba(59, 130, 246, 0.15)',
            color: 'var(--bos-synapse)',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: '0.62rem',
            fontFamily: 'JetBrains Mono, monospace'
          }}>
            {count}
          </span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Stat({ label, value, color, sublabel }) {
  return (
    <div style={{
      background: 'rgba(10, 14, 39, 0.5)',
      border: '1px solid rgba(59, 130, 246, 0.1)',
      borderRadius: 10,
      padding: '12px 14px',
      textAlign: 'center'
    }}>
      <div style={{
        fontSize: '1.4rem',
        fontWeight: 700,
        color: color || 'var(--bos-text)',
        fontFamily: 'JetBrains Mono, monospace',
        lineHeight: 1
      }}>
        {value}
      </div>
      <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      {sublabel && (
        <div style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', marginTop: 2 }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return (
    <div style={{
      padding: '20px',
      textAlign: 'center',
      color: 'var(--bos-text-dim)',
      fontSize: '0.8rem',
      fontStyle: 'italic',
      background: 'rgba(10, 14, 39, 0.3)',
      borderRadius: 8
    }}>
      {children}
    </div>
  );
}

export function gridStyle(cols) {
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gap: 10,
    marginBottom: 24
  };
}
