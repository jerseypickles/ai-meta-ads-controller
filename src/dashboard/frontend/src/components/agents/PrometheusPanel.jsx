import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PanelHeader, Section, Stat, Empty, gridStyle } from './ZeusPanel';
import api from '../../api';

export default function PrometheusPanel() {
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
        api.get('/api/testing-agent/intelligence').catch(() => ({ data: {} })),
        api.get('/api/brain/briefing').catch(() => ({ data: {} }))
      ]);
      setData({
        intel: intelRes.data,
        context: briefingRes.data?.context
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="bos-loading">Cargando Prometheus...</div>;

  const ctx = data?.context || {};
  const intel = data?.intel || {};
  const activeTests = intel.active_tests || [];
  const closeToGrad = ctx.graduates_closest_success || [];

  return (
    <div>
      <PanelHeader icon="🔥" name="PROMETHEUS" role="Tester · procedural" color="var(--bos-danger)" />

      {/* Stats */}
      <div style={gridStyle(4)}>
        <Stat label="Tests activos" value={ctx.prometheus?.active_tests || 0} color="var(--bos-synapse)" />
        <Stat label="Graduados 24h" value={ctx.prometheus?.graduated_24h || 0} color="var(--bos-bio)" />
        <Stat label="Killed 24h" value={ctx.prometheus?.killed_24h || 0} color="var(--bos-danger)" />
        <Stat label="Win rate" value={
          (ctx.prometheus?.graduated_24h + ctx.prometheus?.killed_24h) > 0
            ? Math.round((ctx.prometheus.graduated_24h / (ctx.prometheus.graduated_24h + ctx.prometheus.killed_24h)) * 100) + '%'
            : '—'
        } color="var(--bos-warn)" />
      </div>

      {/* Close to SUCCESS graduates */}
      <Section title="Más cerca de SUCCESS" count={closeToGrad.length}>
        {closeToGrad.length === 0 ? (
          <Empty>Sin graduates acercándose a SUCCESS</Empty>
        ) : (
          closeToGrad.map((g, i) => {
            const pct = (g.conv / 50) * 100;
            const roasColor = parseFloat(g.roas) >= 5 ? 'var(--bos-bio)' : parseFloat(g.roas) >= 3 ? 'var(--bos-warn)' : 'var(--bos-danger)';
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                style={{
                  background: 'rgba(17, 21, 51, 0.5)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  marginBottom: 8
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--bos-text)', flex: 1 }}>
                    {g.name}
                  </span>
                  <span style={{ fontSize: '0.72rem', fontFamily: 'JetBrains Mono, monospace', color: roasColor, fontWeight: 700 }}>
                    {g.roas}x
                  </span>
                </div>
                {/* Progress bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, height: 6, background: 'rgba(10, 14, 39, 0.6)', borderRadius: 3, overflow: 'hidden' }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, delay: i * 0.05 }}
                      style={{
                        height: '100%',
                        background: pct > 60 ? 'linear-gradient(90deg, var(--bos-bio), var(--bos-synapse))' : 'linear-gradient(90deg, var(--bos-synapse), var(--bos-warn))'
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '0.65rem', fontFamily: 'JetBrains Mono, monospace', color: 'var(--bos-text-muted)', minWidth: 48 }}>
                    {g.conv}/50
                  </span>
                </div>
              </motion.div>
            );
          })
        )}
      </Section>

      {/* Info section */}
      <Section title="Sobre Prometheus">
        <div style={{
          background: 'rgba(10, 14, 39, 0.5)',
          borderRadius: 10,
          padding: '12px 16px',
          fontSize: '0.78rem',
          color: 'var(--bos-text-muted)',
          lineHeight: 1.6
        }}>
          Prometheus testea creativos en la campaña <strong style={{ color: 'var(--bos-text)' }}>[TESTING]</strong> a $10/día.
          Graduación natural: ROAS ≥ 3x + 2+ compras después de día 3.
          Force_graduate de Zeus: requires 3+ días + 3+ purchases + 4x+ (hardened hoy).
          Corre 5x/día.
        </div>
      </Section>
    </div>
  );
}
