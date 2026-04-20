import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PanelHeader, Section, Stat, Empty, gridStyle } from './ZeusPanel';
import api from '../../api';

export default function AresPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const res = await api.get('/api/ares/intelligence').catch(() => ({ data: {} }));
      setData(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="bos-loading">Cargando Ares...</div>;

  const cbos = [
    { num: 1, name: 'Production', data: data?.cbo1, color: '#ef4444' },
    { num: 2, name: 'Rising', data: data?.cbo2, color: '#f59e0b' },
    { num: 3, name: 'Medición', data: data?.cbo3, color: '#8b5cf6' }
  ];

  return (
    <div>
      <PanelHeader icon="⚔️" name="ARES" role="Portfolio Manager · multi-CBO" color="var(--bos-electric)" />

      {/* Aggregate stats */}
      <div style={gridStyle(4)}>
        <Stat label="Clones totales" value={data?.active_duplicates || 0} color="var(--bos-electric)" />
        <Stat label="ROAS combined" value={data?.avg_roas || data?.cbo?.roas || '—'} color="var(--bos-bio)" />
        <Stat label="Spend 7d" value={`$${data?.total_spend_7d || data?.cbo?.spend_7d || 0}`} color="var(--bos-text)" />
        <Stat label="Candidatos" value={data?.candidates?.length || 0} color="var(--bos-warn)" />
      </div>

      {/* 3 CBOs side by side */}
      <Section title="Los 3 CBOs">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cbos.map((cbo, i) => {
            if (!cbo.data) return null;
            const clones = cbo.data.adsets || [];
            const withSpend = clones.filter(c => (c.spend_7d || 0) > 5).length;
            return (
              <motion.div
                key={cbo.num}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                style={{
                  background: 'rgba(17, 21, 51, 0.5)',
                  borderLeft: `4px solid ${cbo.color}`,
                  borderRadius: 10,
                  padding: '12px 16px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: cbo.color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em'
                  }}>
                    CBO {cbo.num} · {cbo.name}
                  </div>
                  <div style={{ flex: 1 }} />
                  <div style={{
                    fontSize: '1.3rem',
                    fontWeight: 700,
                    color: parseFloat(cbo.data.roas) >= 3 ? 'var(--bos-bio)' : 'var(--bos-warn)',
                    fontFamily: 'JetBrains Mono, monospace',
                    lineHeight: 1
                  }}>
                    {cbo.data.roas || 0}x
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: '0.68rem', color: 'var(--bos-text-muted)' }}>
                  <div>
                    <div style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {cbo.data.active_clones || clones.length}
                    </div>
                    <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      clones
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {withSpend}
                    </div>
                    <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      con spend
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      ${cbo.data.spend_7d || 0}
                    </div>
                    <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      spend 7d
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {cbo.data.purchases_7d || 0}
                    </div>
                    <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      compras
                    </div>
                  </div>
                </div>
                {clones.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: '0.6rem', color: 'var(--bos-text-dim)' }}>
                    Top: {clones.slice(0, 3).map(c => `${(c.adset_name || '?').substring(0, 30)} (${c.roas_7d}x)`).join(' · ')}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </Section>

      {/* Candidates */}
      <Section title="Candidatos a duplicar" count={data?.candidates?.length}>
        {(!data?.candidates || data.candidates.length === 0) ? (
          <Empty>Sin candidatos (criterios endurecidos: ROAS 3x/14d + $500 + 30 purch + SUCCESS)</Empty>
        ) : (
          data.candidates.slice(0, 5).map((c, i) => (
            <div key={i} style={{
              padding: '8px 12px',
              background: 'rgba(10, 14, 39, 0.5)',
              borderRadius: 6,
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 10
            }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--bos-text)', flex: 1 }}>
                {(c.entity_name || '?').substring(0, 40)}
              </span>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--bos-bio)', fontFamily: 'JetBrains Mono, monospace' }}>
                {c.roas_7d}x
              </span>
              <span style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)' }}>
                ${c.spend_7d} · {c.purchases_7d}c
              </span>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
