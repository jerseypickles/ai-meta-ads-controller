import { useState, useEffect, Suspense, lazy } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../api';

const ZeusOrb = lazy(() => import('../ZeusOrb'));

export default function ZeusPanel() {
  const [data, setData] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [agentStats, setAgentStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('directives');

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
      setData(intelRes.data);
      setBriefing(briefingRes.data?.context || {});

      // Stats for ZeusOrb
      const ctx = briefingRes.data?.context || {};
      setAgentStats({
        athena: { actions: ctx.agents?.unified_agent?.actions || 0, active: true },
        apollo: { actions: ctx.apollo?.ready_pool || 0, active: true },
        prometheus: { actions: ctx.prometheus?.active_tests || 0, active: true },
        ares: { actions: ctx.agents?.ares_agent?.actions || 0, active: true }
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !data) return <div className="bos-loading">Cargando Zeus...</div>;

  const directives = data?.directives?.active || data?.directives || [];
  const hypotheses = data?.hypotheses || [];
  const scenePatterns = data?.scene_patterns || [];
  const thoughts = data?.thoughts || [];
  const conversations = data?.conversations || [];
  const intelligence = data?.intelligence_score || 0;
  const testingStats = data?.testing || {};

  const activeDirs = directives.filter(d => d.active !== false);
  const executedDirs = directives.filter(d => d.executed);

  return (
    <div>
      {/* HERO — 3D Neural Orb + IQ */}
      <div style={{
        background: 'radial-gradient(ellipse at center, rgba(251, 191, 36, 0.08) 0%, transparent 70%)',
        borderRadius: 16,
        padding: '16px 0',
        marginBottom: 20,
        position: 'relative',
        minHeight: 220
      }}>
        <Suspense fallback={<div className="bos-loading">Sintetizando red neural...</div>}>
          <div style={{ height: 200 }}>
            <ZeusOrb
              learningActive={false}
              directives={activeDirs}
              agentStats={agentStats}
              intelligence={intelligence}
            />
          </div>
        </Suspense>

        <div style={{
          position: 'absolute',
          top: 18,
          left: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 14
        }}>
          <motion.div
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200 }}
            style={{
              fontSize: '3.2rem',
              filter: 'drop-shadow(0 0 24px #fbbf24)',
              lineHeight: 1
            }}
          >
            ⚡
          </motion.div>
          <div>
            <div style={{
              fontSize: '1.9rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #fbbf24, #f97316, #ec4899)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
              lineHeight: 1
            }}>
              ZEUS
            </div>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--bos-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 4
            }}>
              CEO · Opus 4.7
            </div>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3 }}
          style={{
            position: 'absolute',
            top: 18,
            right: 24,
            textAlign: 'right'
          }}
        >
          <div style={{
            fontSize: '0.62rem',
            color: 'var(--bos-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.14em'
          }}>
            Intelligence Score
          </div>
          <div style={{
            fontSize: '2.2rem',
            fontWeight: 800,
            fontFamily: 'JetBrains Mono, monospace',
            color: '#fbbf24',
            filter: 'drop-shadow(0 0 12px rgba(251, 191, 36, 0.4))',
            lineHeight: 1
          }}>
            {intelligence}
            <span style={{ fontSize: '0.8rem', color: 'var(--bos-text-muted)', fontWeight: 400 }}>/100</span>
          </div>
        </motion.div>
      </div>

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { v: briefing?.zeus?.cycles_24h || 0, l: 'Ciclos 24h', c: '#fbbf24' },
          { v: activeDirs.length, l: 'Directivas activas', c: 'var(--bos-synapse)' },
          { v: scenePatterns.length, l: 'Patrones', c: 'var(--bos-bio)' },
          { v: testingStats.graduation_rate ? `${testingStats.graduation_rate}%` : '—', l: 'Win rate', c: 'var(--bos-electric)' }
        ].map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            style={{
              background: 'rgba(10, 14, 39, 0.6)',
              border: '1px solid rgba(59, 130, 246, 0.12)',
              borderRadius: 10,
              padding: '10px 12px',
              textAlign: 'center'
            }}
          >
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
              {s.v}
            </div>
            <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-muted)', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {s.l}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Lo que Zeus sabe (summary) */}
      {data?.summary && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          style={{
            background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.08), rgba(59, 130, 246, 0.04))',
            border: '1px solid rgba(251, 191, 36, 0.25)',
            borderLeft: '3px solid #fbbf24',
            borderRadius: 12,
            padding: '14px 18px',
            marginBottom: 20
          }}
        >
          <div style={{
            fontSize: '0.65rem',
            color: '#fbbf24',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            marginBottom: 6
          }}>
            💭 Lo que Zeus sabe
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--bos-text)', lineHeight: 1.55 }}>
            {data.summary}
          </div>
        </motion.div>
      )}

      {/* Section tabs */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 16,
        padding: 4,
        background: 'rgba(10, 14, 39, 0.4)',
        borderRadius: 10
      }}>
        {[
          { k: 'directives', l: 'Directivas', n: activeDirs.length },
          { k: 'hypotheses', l: 'Hipótesis', n: hypotheses.length },
          { k: 'scenes', l: 'Escenas', n: scenePatterns.length },
          { k: 'thoughts', l: 'Consciencia', n: thoughts.length },
          { k: 'chat', l: 'Comunicación', n: conversations.length }
        ].map(t => (
          <button
            key={t.k}
            onClick={() => setActiveSection(t.k)}
            style={{
              flex: 1,
              padding: '8px 10px',
              background: activeSection === t.k ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 146, 60, 0.15))' : 'transparent',
              border: activeSection === t.k ? '1px solid rgba(251, 191, 36, 0.4)' : '1px solid transparent',
              borderRadius: 6,
              color: activeSection === t.k ? '#fbbf24' : 'var(--bos-text-muted)',
              fontSize: '0.7rem',
              fontWeight: activeSection === t.k ? 700 : 500,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              transition: 'all 0.2s'
            }}
          >
            {t.l} {t.n > 0 && <span style={{ opacity: 0.6, fontSize: '0.6rem', marginLeft: 3 }}>{t.n}</span>}
          </button>
        ))}
      </div>

      {/* Section content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeSection}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25 }}
        >
          {activeSection === 'directives' && <DirectivesSection directives={directives} />}
          {activeSection === 'hypotheses' && <HypothesesSection hypotheses={hypotheses} />}
          {activeSection === 'scenes' && <ScenesSection patterns={scenePatterns} />}
          {activeSection === 'thoughts' && <ThoughtsSection thoughts={thoughts} />}
          {activeSection === 'chat' && <ConversationsSection conversations={conversations} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECTIVES — full rich view with target agent flow
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_ICONS = { athena: '🦉', apollo: '☀️', prometheus: '🔥', ares: '⚔️', all: '🌐' };
const AGENT_COLORS = { athena: '#10b981', apollo: '#f59e0b', prometheus: '#ef4444', ares: '#8b5cf6', all: '#3b82f6', zeus: '#fbbf24' };
const DIRECTIVE_COLORS = {
  prioritize: '#10b981',
  avoid: '#ef4444',
  adjust: '#f59e0b',
  alert: '#8b5cf6',
  insight: '#3b82f6',
  force_graduate: '#ec4899',
  force_duplicate: '#8b5cf6',
  pause_clone: '#ef4444'
};

function DirectivesSection({ directives }) {
  if (directives.length === 0) {
    return <EmptyState>Sin directivas. Zeus generará en su próximo ciclo.</EmptyState>;
  }

  const active = directives.filter(d => d.active !== false);
  const historical = directives.filter(d => d.active === false);

  return (
    <div>
      {active.length > 0 && (
        <div>
          <SectionHeader label="Activas" count={active.length} color="#fbbf24" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {active.map((d, i) => (
              <DirectiveCard key={d._id || i} d={d} index={i} />
            ))}
          </div>
        </div>
      )}
      {historical.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionHeader label="Histórico reciente" count={historical.length} color="var(--bos-text-dim)" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {historical.slice(0, 8).map((d, i) => (
              <DirectiveCard key={d._id || i} d={d} index={i} faded />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DirectiveCard({ d, index, faded }) {
  const color = DIRECTIVE_COLORS[d.directive_type] || '#6b7280';
  const targetColor = AGENT_COLORS[d.target_agent] || '#6b7280';
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: faded ? 0.55 : 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      style={{
        background: faded ? 'rgba(17, 21, 51, 0.3)' : 'rgba(17, 21, 51, 0.55)',
        borderRadius: 10,
        padding: '10px 14px',
        borderLeft: `3px solid ${color}`,
        position: 'relative',
        overflow: 'hidden'
      }}
    >
      {/* Agent-to-agent flow header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: '0.88rem', filter: 'drop-shadow(0 0 6px #fbbf24)' }}>⚡</span>
        <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)' }}>→</span>
        <span style={{ fontSize: '0.95rem' }}>{AGENT_ICONS[d.target_agent] || '?'}</span>
        <span style={{
          fontSize: '0.58rem',
          fontWeight: 700,
          color: targetColor,
          textTransform: 'uppercase',
          letterSpacing: '0.12em'
        }}>
          {d.target_agent}
        </span>
        <span style={{
          fontSize: '0.55rem',
          padding: '2px 8px',
          borderRadius: 8,
          background: `${color}22`,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 700
        }}>
          {d.directive_type}
        </span>
        {d.executed ? (
          <span style={{ fontSize: '0.58rem', color: 'var(--bos-bio)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
            ✓ EXECUTED
          </span>
        ) : d.active !== false ? (
          <span style={{ fontSize: '0.58rem', color: '#fbbf24', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
            ⏳ ACTIVE
          </span>
        ) : (
          <span style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
            ✗ EXPIRED
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.83rem', color: 'var(--bos-text)', lineHeight: 1.5, marginBottom: 4 }}>
        {d.directive}
      </div>
      <div style={{
        display: 'flex',
        gap: 10,
        fontSize: '0.6rem',
        color: 'var(--bos-text-muted)',
        fontFamily: 'JetBrains Mono, monospace'
      }}>
        <span>conf {Math.round((d.confidence || 0) * 100)}%</span>
        {d.based_on_samples && <span>· {d.based_on_samples} samples</span>}
        {d.execution_result && (
          <span style={{ color: 'var(--bos-bio)', marginLeft: 'auto' }}>
            → {d.execution_result.substring(0, 60)}
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HYPOTHESES
// ═══════════════════════════════════════════════════════════════════════════

function HypothesesSection({ hypotheses }) {
  if (hypotheses.length === 0) {
    return <EmptyState>Sin hipótesis activas. Zeus las genera cada ciclo.</EmptyState>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hypotheses.slice(0, 20).map((h, i) => {
        const verdict = h.diagnosis || h.data_points?.verdict;
        const icon = verdict === 'confirmed' ? '✓' : verdict === 'rejected' ? '✗' : verdict === 'inconclusive' ? '?' : '⏳';
        const color = verdict === 'confirmed' ? 'var(--bos-bio)' : verdict === 'rejected' ? 'var(--bos-danger)' : verdict === 'inconclusive' ? 'var(--bos-text-muted)' : '#fbbf24';
        const date = h.created_at ? new Date(h.created_at) : null;
        return (
          <motion.div
            key={h._id || i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03 }}
            style={{
              background: 'rgba(17, 21, 51, 0.5)',
              borderRadius: 10,
              padding: '10px 14px',
              borderLeft: `3px solid ${color}`
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: '1rem', color, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
                {icon}
              </span>
              <span style={{
                fontSize: '0.56rem',
                color,
                textTransform: 'uppercase',
                fontWeight: 700,
                letterSpacing: '0.1em',
                padding: '2px 6px',
                background: `${color}15`,
                borderRadius: 4
              }}>
                {verdict || 'pending'}
              </span>
              {date && (
                <span style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
                  {date.getDate()}/{date.getMonth() + 1}
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--bos-text)', lineHeight: 1.5 }}>
              {h.body || h.title}
            </div>
            {h.data_points?.evidence && (
              <div style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted)', marginTop: 5, paddingTop: 5, borderTop: '1px solid rgba(255,255,255,0.04)', fontStyle: 'italic' }}>
                📊 {h.data_points.evidence}
              </div>
            )}
            {h.data_points?.recommendation && (
              <div style={{ fontSize: '0.68rem', color: 'var(--bos-bio)', marginTop: 3 }}>
                → {h.data_points.recommendation}
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENES — Heat grid
// ═══════════════════════════════════════════════════════════════════════════

function ScenesSection({ patterns }) {
  if (patterns.length === 0) {
    return <EmptyState>Sin patrones de escenas aún. Se poblan con tests activos.</EmptyState>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
      {patterns.map((p, i) => {
        const hasPurchases = (p.purchases || 0) > 0;
        const color = hasPurchases ? 'var(--bos-bio)' : (p.spend >= 20 ? 'var(--bos-danger)' : 'var(--bos-warn)');
        const intensity = Math.min(1, (p.purchases || 0) / 5);
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.02 }}
            style={{
              background: `linear-gradient(135deg, ${color}${Math.round(intensity * 30).toString(16).padStart(2, '0')}, rgba(17, 21, 51, 0.5))`,
              border: `1px solid ${color}40`,
              borderRadius: 10,
              padding: '10px 12px'
            }}
          >
            <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', marginBottom: 4, fontWeight: 500 }}>
              {(p.scene || '').substring(0, 40)}
            </div>
            <div style={{ display: 'flex', gap: 10, fontSize: '0.62rem', flexWrap: 'wrap' }}>
              <span style={{ color, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                {p.purchases || 0} compras
              </span>
              <span style={{ color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {p.avg_roas}x · ${p.spend}
              </span>
              <span style={{ color: 'var(--bos-text-dim)' }}>
                {p.total} tests
                {p.active > 0 && <span style={{ color: '#fbbf24' }}> ({p.active} activos)</span>}
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THOUGHTS — Stream de consciencia
// ═══════════════════════════════════════════════════════════════════════════

function ThoughtsSection({ thoughts }) {
  if (thoughts.length === 0) {
    return <EmptyState>Zeus aún no tiene pensamientos registrados.</EmptyState>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {thoughts.slice(0, 20).map((t, i) => {
        const date = t.created_at ? new Date(t.created_at) : null;
        return (
          <motion.div
            key={t._id || i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.03 }}
            style={{
              background: 'rgba(17, 21, 51, 0.4)',
              borderRadius: 8,
              padding: '9px 14px',
              borderLeft: '2px solid rgba(251, 191, 36, 0.4)',
              position: 'relative'
            }}
          >
            <div style={{ fontSize: '0.8rem', color: 'var(--bos-text)', lineHeight: 1.5 }}>
              <span style={{ color: '#fbbf24', marginRight: 6 }}>💭</span>
              {t.body || t.title || t.thought}
            </div>
            {date && (
              <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                {date.getDate()}/{date.getMonth() + 1} · {date.getHours().toString().padStart(2, '0')}:{date.getMinutes().toString().padStart(2, '0')}
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS — Inter-agent flow
// ═══════════════════════════════════════════════════════════════════════════

const TYPE_COLORS = {
  directive: '#f97316',
  report: '#3b82f6',
  acknowledgment: '#10b981',
  alert: '#ef4444',
  thought: '#8b5cf6'
};

function ConversationsSection({ conversations }) {
  if (conversations.length === 0) {
    return <EmptyState>Sin comunicaciones recientes entre agentes.</EmptyState>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {conversations.slice(0, 30).map((c, i) => {
        const date = c.created_at ? new Date(c.created_at) : null;
        const fromColor = AGENT_COLORS[c.from] || '#6b7280';
        const toColor = AGENT_COLORS[c.to] || '#6b7280';
        const typeColor = TYPE_COLORS[c.type] || '#6b7280';
        return (
          <motion.div
            key={c._id || i}
            initial={{ opacity: 0, x: c.from === 'zeus' ? -10 : 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.02 }}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              padding: '8px 12px',
              borderRadius: 8,
              background: c.from === 'zeus' ? 'rgba(251, 191, 36, 0.06)' : 'rgba(17, 21, 51, 0.45)',
              borderLeft: `2px solid ${fromColor}`
            }}
          >
            <span style={{ fontSize: '0.9rem', minWidth: 22 }}>
              {AGENT_ICONS[c.from] || '?'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: fromColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {c.from}
                </span>
                <span style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)' }}>→</span>
                <span style={{ fontSize: '0.62rem', color: toColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {c.to}
                </span>
                <span style={{
                  fontSize: '0.5rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: `${typeColor}20`,
                  color: typeColor
                }}>
                  {c.type}
                </span>
                {date && (
                  <span style={{ fontSize: '0.55rem', color: 'var(--bos-text-dim)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
                    {date.getHours().toString().padStart(2, '0')}:{date.getMinutes().toString().padStart(2, '0')}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.76rem', color: 'var(--bos-text)', lineHeight: 1.4 }}>
                {c.message}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function SectionHeader({ label, count, color }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      fontSize: '0.65rem',
      color: color || 'var(--bos-text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      fontWeight: 700
    }}>
      <span>{label}</span>
      {count != null && (
        <span style={{
          background: 'rgba(251, 191, 36, 0.1)',
          color: color || 'var(--bos-text-muted)',
          padding: '2px 8px',
          borderRadius: 10,
          fontSize: '0.58rem',
          fontFamily: 'JetBrains Mono, monospace'
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{
      padding: '24px',
      textAlign: 'center',
      color: 'var(--bos-text-dim)',
      fontSize: '0.82rem',
      fontStyle: 'italic',
      background: 'rgba(10, 14, 39, 0.3)',
      border: '1px dashed rgba(255, 255, 255, 0.08)',
      borderRadius: 10
    }}>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED EXPORTS (used by other agent panels)
// ═══════════════════════════════════════════════════════════════════════════

export function PanelHeader({ icon, name, role, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300 }}
        style={{ fontSize: '2.6rem', filter: `drop-shadow(0 0 20px ${color})` }}
      >
        {icon}
      </motion.div>
      <div>
        <div style={{ fontSize: '1.7rem', fontWeight: 700, color: 'var(--bos-text)', letterSpacing: '0.02em' }}>
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
      <SectionHeader label={title} count={count} />
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
  return <EmptyState>{children}</EmptyState>;
}

export function gridStyle(cols) {
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gap: 10,
    marginBottom: 24
  };
}
