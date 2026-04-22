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
        padding: '16px 0 0',
        marginBottom: 20,
        position: 'relative',
        height: 340,
        overflow: 'hidden'
      }}>
        <Suspense fallback={<div className="bos-loading">Sintetizando red neural...</div>}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
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
  const [filter, setFilter] = useState('all'); // all | creator | learner | persistent
  const [localDeactivated, setLocalDeactivated] = useState(new Set());

  if (directives.length === 0) {
    return <EmptyState>Sin directivas. Zeus generará en su próximo ciclo.</EmptyState>;
  }

  // Fuente efectiva: source top-level o data.source legacy
  function effectiveSource(d) {
    return d.source || d.data?.source || 'system';
  }

  const active = directives.filter(d => d.active !== false && !localDeactivated.has(d._id));
  const historical = directives.filter(d => d.active === false || localDeactivated.has(d._id));

  // Counts para los filter chips
  const count = {
    all: active.length,
    creator: active.filter(d => effectiveSource(d) === 'chat').length,
    persistent: active.filter(d => d.persistent === true).length,
    learner: active.filter(d => effectiveSource(d) === 'learner').length
  };

  // Filtro activo
  const filtered = active.filter(d => {
    if (filter === 'all') return true;
    if (filter === 'creator') return effectiveSource(d) === 'chat';
    if (filter === 'persistent') return d.persistent === true;
    if (filter === 'learner') return effectiveSource(d) === 'learner';
    return true;
  });

  // Orden: persistent primero, luego source=chat, luego resto por confidence
  filtered.sort((a, b) => {
    if (a.persistent !== b.persistent) return a.persistent ? -1 : 1;
    const sa = effectiveSource(a), sb = effectiveSource(b);
    const prio = { chat: 0, proactive: 1, learner: 2, system: 3 };
    if (prio[sa] !== prio[sb]) return (prio[sa] ?? 4) - (prio[sb] ?? 4);
    return (b.confidence || 0) - (a.confidence || 0);
  });

  async function handleDeactivate(id) {
    if (!window.confirm('¿Desactivar esta directiva?')) return;
    try {
      await api.post(`/api/zeus/directives/${id}/deactivate`, { reason: 'panel_button' });
      setLocalDeactivated(new Set([...localDeactivated, id]));
    } catch (err) {
      alert('Error desactivando: ' + (err?.response?.data?.error || err.message));
    }
  }

  const chips = [
    { key: 'all', label: 'Todas', color: '#93c5fd', n: count.all },
    { key: 'creator', label: '👑 Creador', color: '#60a5fa', n: count.creator },
    { key: 'persistent', label: '🔒 Estables', color: '#fbbf24', n: count.persistent },
    { key: 'learner', label: '🤖 Learner', color: 'var(--bos-text-muted)', n: count.learner }
  ];

  return (
    <div>
      {active.length > 0 && (
        <div>
          <SectionHeader label="Activas" count={active.length} color="#fbbf24" />

          {/* Filter chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {chips.map(c => (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                style={{
                  background: filter === c.key ? `${c.color}22` : 'transparent',
                  border: `1px solid ${filter === c.key ? c.color : 'rgba(255,255,255,0.08)'}`,
                  color: filter === c.key ? c.color : 'var(--bos-text-muted)',
                  fontSize: '0.64rem',
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: '4px 10px',
                  borderRadius: 12,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5
                }}
              >
                <span>{c.label}</span>
                <span style={{ opacity: 0.7 }}>·</span>
                <span>{c.n}</span>
              </button>
            ))}
          </div>

          {filtered.length === 0 && (
            <EmptyState>Sin directivas en este filtro.</EmptyState>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map((d, i) => (
              <DirectiveCard
                key={d._id || i}
                d={d}
                index={i}
                effectiveSource={effectiveSource(d)}
                onDeactivate={handleDeactivate}
              />
            ))}
          </div>
        </div>
      )}
      {historical.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionHeader label="Histórico reciente" count={historical.length} color="var(--bos-text-dim)" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {historical.slice(0, 8).map((d, i) => (
              <DirectiveCard
                key={d._id || i}
                d={d}
                index={i}
                effectiveSource={effectiveSource(d)}
                faded
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Formatea tiempo restante: "13d 20h", "4h 30m", "12m", "expirada"
function timeRemaining(expires_at) {
  if (!expires_at) return null;
  const diff = new Date(expires_at).getTime() - Date.now();
  if (diff <= 0) return { label: 'expirada', expired: true };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return { label: `${days}d ${hours}h`, expired: false, days };
  if (hours > 0) return { label: `${hours}h ${mins}m`, expired: false, days: 0 };
  return { label: `${mins}m`, expired: false, days: 0 };
}

function DirectiveCard({ d, index, faded, effectiveSource, onDeactivate }) {
  const [expanded, setExpanded] = useState(false);
  const color = DIRECTIVE_COLORS[d.directive_type] || '#6b7280';
  const targetColor = AGENT_COLORS[d.target_agent] || '#6b7280';
  const isCreator = effectiveSource === 'chat';
  const isPersistent = d.persistent === true;
  const isProactive = effectiveSource === 'proactive';
  const isLearner = effectiveSource === 'learner';
  const remaining = timeRemaining(d.expires_at);
  const reasoning = d.data?.reasoning || '';

  // Tier styling — de más importante (persistent) a menos (learner)
  let tierStyle;
  if (isPersistent) {
    tierStyle = {
      className: 'dir-card tier-persistent',
      tierLabel: '🔒 REGLA ESTABLE',
      tierColor: '#fbbf24',
      borderLeft: `4px solid #fbbf24`,
      boxShadow: '0 0 18px rgba(251, 191, 36, 0.08)',
      background: 'linear-gradient(180deg, rgba(251, 191, 36, 0.06), rgba(17, 21, 51, 0.55))'
    };
  } else if (isCreator) {
    tierStyle = {
      className: 'dir-card tier-creator',
      tierLabel: '👑 CREADOR',
      tierColor: '#60a5fa',
      borderLeft: `4px solid #60a5fa`,
      boxShadow: '0 0 14px rgba(96, 165, 250, 0.1)',
      background: 'linear-gradient(180deg, rgba(96, 165, 250, 0.04), rgba(17, 21, 51, 0.55))'
    };
  } else if (isProactive) {
    tierStyle = {
      className: 'dir-card tier-proactive',
      tierLabel: '💡 ZEUS',
      tierColor: '#f97316',
      borderLeft: `3px solid #f97316`,
      boxShadow: 'none',
      background: 'rgba(17, 21, 51, 0.48)'
    };
  } else {
    // learner o system
    tierStyle = {
      className: 'dir-card tier-learner',
      tierLabel: isLearner ? '🤖 learner' : '· system',
      tierColor: 'var(--bos-text-dim)',
      borderLeft: `2px solid ${color}55`,
      boxShadow: 'none',
      background: 'rgba(17, 21, 51, 0.32)'
    };
  }

  const textSize = isPersistent || isCreator ? '0.83rem' : '0.74rem';
  const padding = isPersistent || isCreator ? '12px 14px' : '8px 12px';

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: faded ? 0.55 : 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      className={tierStyle.className}
      style={{
        background: faded ? 'rgba(17, 21, 51, 0.25)' : tierStyle.background,
        borderRadius: 10,
        padding,
        borderLeft: tierStyle.borderLeft,
        boxShadow: faded ? 'none' : tierStyle.boxShadow,
        position: 'relative',
        overflow: 'hidden',
        transition: 'all 0.2s'
      }}
    >
      {/* Header — tier label + agent + type + status/countdown + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        {/* Tier badge — la más prominente */}
        <span style={{
          fontSize: '0.55rem',
          fontWeight: 700,
          color: tierStyle.tierColor,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          padding: '2px 7px',
          borderRadius: 4,
          background: `${tierStyle.tierColor}15`,
          whiteSpace: 'nowrap'
        }}>
          {tierStyle.tierLabel}
        </span>

        {/* Agent destino */}
        <span style={{ fontSize: '0.9rem' }}>{AGENT_ICONS[d.target_agent] || '?'}</span>
        <span style={{
          fontSize: '0.56rem',
          fontWeight: 700,
          color: targetColor,
          textTransform: 'uppercase',
          letterSpacing: '0.1em'
        }}>
          {d.target_agent}
        </span>

        {/* Directive type */}
        <span style={{
          fontSize: '0.55rem',
          padding: '2px 7px',
          borderRadius: 4,
          background: `${color}22`,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 700
        }}>
          {d.directive_type}
        </span>

        {/* Status / countdown a la derecha */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {d.executed ? (
            <span style={{ fontSize: '0.58rem', color: 'var(--bos-bio)', fontFamily: 'JetBrains Mono, monospace' }}>
              ✓ EXECUTED
            </span>
          ) : d.active === false || faded ? (
            <span style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              ✗ {remaining?.expired ? 'EXPIRED' : 'INACTIVE'}
            </span>
          ) : isPersistent ? (
            <span style={{ fontSize: '0.58rem', color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              ∞ permanente
            </span>
          ) : remaining ? (
            <span
              style={{
                fontSize: '0.58rem',
                color: remaining.days >= 7 ? 'var(--bos-bio)' :
                       remaining.days >= 2 ? '#60a5fa' :
                       remaining.days >= 1 ? '#fbbf24' : '#f97316',
                fontFamily: 'JetBrains Mono, monospace',
                fontWeight: 600
              }}
              title={`expira ${new Date(d.expires_at).toLocaleString()}`}
            >
              ⏱ {remaining.label}
            </span>
          ) : (
            <span style={{ fontSize: '0.58rem', color: '#fbbf24', fontFamily: 'JetBrains Mono, monospace' }}>
              ⏳ activa
            </span>
          )}

          {/* Botón desactivar — solo para directivas del creador, no executadas, no faded */}
          {isCreator && !faded && !d.executed && onDeactivate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeactivate(d._id);
              }}
              title="Desactivar esta directiva"
              style={{
                background: 'transparent',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: 'var(--bos-text-muted)',
                width: 20,
                height: 20,
                borderRadius: 4,
                fontSize: '0.7rem',
                cursor: 'pointer',
                padding: 0,
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ef4444';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--bos-text-muted)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Texto de la directiva */}
      <div
        style={{
          fontSize: textSize,
          color: 'var(--bos-text)',
          lineHeight: 1.5,
          marginBottom: 4,
          cursor: reasoning ? 'pointer' : 'default'
        }}
        onClick={() => reasoning && setExpanded(!expanded)}
      >
        {d.directive}
      </div>

      {/* Reasoning expandible (hover o click) */}
      {reasoning && (
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              style={{
                fontSize: '0.7rem',
                color: 'var(--bos-text-muted)',
                lineHeight: 1.5,
                padding: '8px 10px',
                background: 'rgba(0, 0, 0, 0.25)',
                borderRadius: 6,
                borderLeft: '2px solid rgba(96, 165, 250, 0.3)',
                margin: '6px 0',
                fontStyle: 'italic'
              }}
            >
              <div style={{
                fontSize: '0.55rem',
                color: '#93c5fd',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                fontWeight: 700,
                fontStyle: 'normal',
                marginBottom: 4
              }}>
                Razón
              </div>
              {reasoning}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* Footer meta — confidence + samples + toggle reasoning */}
      <div style={{
        display: 'flex',
        gap: 10,
        fontSize: '0.58rem',
        color: 'var(--bos-text-muted)',
        fontFamily: 'JetBrains Mono, monospace',
        alignItems: 'center'
      }}>
        {!isPersistent && <span>conf {Math.round((d.confidence || 0) * 100)}%</span>}
        {d.based_on_samples > 0 && <span>· {d.based_on_samples} samples</span>}
        {reasoning && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--bos-text-dim)',
              fontSize: '0.58rem',
              fontFamily: 'inherit',
              cursor: 'pointer',
              padding: 0,
              marginLeft: 'auto',
              textDecoration: 'underline',
              textDecorationStyle: 'dotted'
            }}
          >
            {expanded ? '▲ ocultar razón' : '▼ ver razón'}
          </button>
        )}
        {d.execution_result && (
          <span style={{ color: 'var(--bos-bio)', marginLeft: reasoning ? 0 : 'auto' }}>
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
