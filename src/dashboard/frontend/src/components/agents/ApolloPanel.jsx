import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PanelHeader, Section, Stat, Empty, gridStyle } from './ZeusPanel';
import api from '../../api';
import { setApolloEvolutionRatio } from '../../api';

export default function ApolloPanel() {
  const [dna, setDna] = useState(null);
  const [intel, setIntel] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [dnaRes, intelRes] = await Promise.all([
        api.get('/api/creative-agent/dna?limit=10&min_samples=1').catch(() => ({ data: {} })),
        api.get('/api/creative-agent/intelligence').catch(() => ({ data: {} }))
      ]);
      setDna(dnaRes.data);
      setIntel(intelRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function changeEvolutionRatio(ratio) {
    try {
      await setApolloEvolutionRatio(ratio);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  if (loading) return <div className="bos-loading">Cargando Apollo...</div>;

  const poolReady = intel?.pool?.ready || 0;
  const evolution = dna?.evolution || {};
  const dnaSpace = evolution.dna_space || {};
  const stats = dna?.global_stats || {};
  const ratio = evolution.active_ratio || 0;

  return (
    <div>
      <PanelHeader icon="☀️" name="APOLLO" role="Creator · Gemini 3 + DNA" color="var(--bos-warn)" />

      {/* Stats */}
      <div style={gridStyle(4)}>
        <Stat label="Pool ready" value={poolReady} color={poolReady >= 60 ? 'var(--bos-warn)' : 'var(--bos-bio)'} sublabel={poolReady >= 60 ? 'saturado' : 'ok'} />
        <Stat label="DNAs únicos" value={stats.total_dnas || 0} color="var(--bos-electric)" />
        <Stat label="Tests" value={stats.total_tests || 0} color="var(--bos-text)" />
        <Stat label="Win rate" value={stats.overall_win_rate ? Math.round(stats.overall_win_rate * 100) + '%' : '—'} color="var(--bos-bio)" />
      </div>

      {/* Evolution Control */}
      <Section title="Evolution Control">
        <div style={{
          background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(236, 72, 153, 0.04))',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          borderRadius: 12,
          padding: '14px 16px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--bos-electric)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Flag actual
            </div>
            <div style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              color: ratio > 0 ? 'var(--bos-electric)' : 'var(--bos-text-muted)',
              fontFamily: 'JetBrains Mono, monospace'
            }}>
              {Math.round(ratio * 100)}%
            </div>
            <span style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)' }}>
              {ratio === 0 ? 'legacy random' : ratio === 1 ? 'full evolutionary' : 'gradual'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 0.2, 0.5, 0.8, 1].map(r => {
              const active = Math.abs(ratio - r) < 0.01;
              return (
                <button
                  key={r}
                  onClick={() => {
                    if (window.confirm(`Cambiar Apollo evolution a ${Math.round(r * 100)}%?`)) {
                      changeEvolutionRatio(r);
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: active ? '2px solid var(--bos-electric)' : '1px solid rgba(255,255,255,0.1)',
                    background: active ? 'rgba(139, 92, 246, 0.2)' : 'rgba(10, 14, 39, 0.5)',
                    color: active ? 'var(--bos-electric)' : 'var(--bos-text-muted)',
                    fontSize: '0.72rem',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                    fontFamily: 'JetBrains Mono, monospace'
                  }}
                >
                  {Math.round(r * 100)}%
                </button>
              );
            })}
          </div>
          {dnaSpace.normalized_entropy != null && (
            <div style={{ marginTop: 12, fontSize: '0.68rem', color: 'var(--bos-text-muted)', display: 'flex', gap: 14 }}>
              <span>entropy: <strong style={{ color: 'var(--bos-text)' }}>{dnaSpace.normalized_entropy}</strong></span>
              <span>dominant: <strong style={{ color: 'var(--bos-text)' }}>{dnaSpace.dominant_dna_pct}%</strong></span>
              <span>status: <strong style={{ color: 'var(--bos-bio)' }}>{dnaSpace.convergence_status}</strong></span>
            </div>
          )}
        </div>
      </Section>

      {/* Top 5 DNAs */}
      <Section title="Top DNAs" count={dna?.dnas?.length}>
        {dna?.dnas?.length === 0 ? (
          <Empty>Sin DNAs con samples suficientes</Empty>
        ) : (
          (dna?.dnas || []).slice(0, 5).map((d, i) => {
            const f = d.fitness || {};
            const winPct = Math.round((f.win_rate || 0) * 100);
            const roasColor = f.avg_roas >= 5 ? 'var(--bos-bio)' : f.avg_roas >= 2 ? 'var(--bos-warn)' : 'var(--bos-danger)';
            return (
              <motion.div
                key={d.dna_hash || i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                style={{
                  background: 'rgba(17, 21, 51, 0.5)',
                  borderLeft: `3px solid ${roasColor}`,
                  borderRadius: 8,
                  padding: '10px 14px',
                  marginBottom: 6
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>#{i + 1}</span>
                  <span style={{ fontSize: '1rem', fontWeight: 700, color: roasColor, fontFamily: 'JetBrains Mono, monospace' }}>
                    {f.avg_roas}x
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)' }}>·</span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--bos-text)' }}>
                    {f.tests_graduated}/{f.tests_total} wins ({winPct}%)
                  </span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', marginLeft: 'auto' }}>
                    conf {Math.round((f.sample_confidence || 0) * 100)}%
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {['style', 'copy_angle', 'scene', 'product', 'hook_type'].map(dim => (
                    <span key={dim} style={{
                      fontSize: '0.58rem',
                      padding: '2px 6px',
                      background: 'rgba(10, 14, 39, 0.8)',
                      borderRadius: 3,
                      color: 'var(--bos-text-muted)'
                    }}>
                      {(d.dimensions?.[dim] || '?').substring(0, 24)}
                    </span>
                  ))}
                </div>
              </motion.div>
            );
          })
        )}
      </Section>

      {/* Strategy mix */}
      {evolution.proposals_last_7d?.strategy_ratios && (
        <Section title="Strategy mix 7d" count={evolution.proposals_last_7d.total}>
          <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
            {[
              { k: 'random', c: '#6b7280' },
              { k: 'exploit', c: 'var(--bos-bio)' },
              { k: 'mutate', c: 'var(--bos-warn)' },
              { k: 'crossover', c: 'var(--bos-electric)' },
              { k: 'explore', c: 'var(--bos-synapse)' }
            ].map(s => {
              const pct = evolution.proposals_last_7d.strategy_ratios[s.k] || 0;
              if (pct === 0) return null;
              return (
                <motion.div
                  key={s.k}
                  initial={{ width: 0 }}
                  animate={{ width: pct + '%' }}
                  transition={{ duration: 0.5 }}
                  style={{
                    background: s.c,
                    fontSize: '0.6rem',
                    color: 'white',
                    textAlign: 'center',
                    lineHeight: '28px',
                    fontWeight: 600
                  }}
                  title={`${s.k}: ${pct}%`}
                >
                  {pct > 10 ? pct + '%' : ''}
                </motion.div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: '0.6rem', color: 'var(--bos-text-muted)', flexWrap: 'wrap' }}>
            {['random', 'exploit', 'mutate', 'crossover', 'explore'].map(k => (
              <span key={k}>
                ● {k}: {evolution.proposals_last_7d.strategy_ratios[k] || 0}%
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
