import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../api';

const ATHENA_COLOR = '#60a5fa';

const ACTION_LABELS = {
  scale_up: { icon: '↑', label: 'Scale Up', color: '#10b981' },
  scale_down: { icon: '↓', label: 'Scale Down', color: '#f59e0b' },
  pause: { icon: '⏸', label: 'Pause Ad', color: '#ef4444' },
  pause_adset: { icon: '⏹', label: 'Pause AdSet', color: '#ef4444' },
  reactivate: { icon: '▶', label: 'Reactivar', color: '#3b82f6' },
  create_ad: { icon: '+', label: 'Crear Ad', color: '#8b5cf6' }
};

function roasColor(r) {
  if (r >= 4) return '#10b981';
  if (r >= 2.5) return '#3b82f6';
  if (r >= 1.5) return '#f59e0b';
  if (r > 0) return '#ef4444';
  return '#6b7280';
}

function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function AthenaPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('overview');
  const [expandedAdSet, setExpandedAdSet] = useState(null);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const res = await api.get('/api/agent/activity', { timeout: 20000 });
      setData(res.data);
    } catch (err) {
      console.error('Athena activity error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !data) return <div className="bos-loading">Sintetizando inteligencia de Athena...</div>;

  const adsets = data?.adsets || [];
  const global = data?.global || { total_adsets: 0, win_rate: 0, total_measured: 0, last_cycle: null };

  // Categorizar
  const winners = adsets.filter(a => (a.metrics_7d?.roas || 0) >= 3 && (a.metrics_7d?.spend || 0) >= 50);
  const watching = adsets.filter(a => (a.metrics_7d?.roas || 0) >= 1.5 && (a.metrics_7d?.roas || 0) < 3 && (a.metrics_7d?.spend || 0) >= 30);
  const risk = adsets.filter(a => (a.metrics_7d?.roas || 0) < 1.5 && (a.metrics_7d?.spend || 0) >= 50);
  const learningAdsets = adsets.filter(a => a.learning_stage === 'LEARNING');
  const recentActions = adsets
    .flatMap(a => (a.recent_actions || []).map(act => ({ ...act, adset_name: a.adset_name, adset_id: a.adset_id })))
    .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))
    .slice(0, 20);
  const criticalAlerts = adsets.filter(a => (a.active_ads_count || 0) <= 1 && a.status === 'ACTIVE');

  return (
    <div>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at center, rgba(96, 165, 250, 0.08) 0%, transparent 70%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        position: 'relative',
        border: '1px solid rgba(96, 165, 250, 0.15)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `${ATHENA_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${ATHENA_COLOR}40`,
              filter: `drop-shadow(0 0 16px ${ATHENA_COLOR}50)`,
              fontSize: '2rem'
            }}
          >
            🦉
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '1.7rem',
              fontWeight: 800,
              background: 'linear-gradient(135deg, #60a5fa, #3b82f6, #1e40af)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
              lineHeight: 1
            }}>
              ATHENA
            </div>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--bos-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginTop: 4
            }}>
              Account Manager · Sonnet 4.6
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 2 }}>
              Último ciclo
            </div>
            <div style={{ fontSize: '0.9rem', color: ATHENA_COLOR, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {global.last_cycle ? formatTime(global.last_cycle) : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* STATS BAR (6 cards) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
        {[
          { v: global.total_adsets, l: 'Ad Sets', c: ATHENA_COLOR },
          { v: winners.length, l: 'Escalando', c: '#10b981' },
          { v: watching.length, l: 'Observando', c: '#3b82f6' },
          { v: risk.length, l: 'Riesgo', c: '#ef4444' },
          { v: learningAdsets.length, l: 'Learning', c: '#fbbf24' },
          { v: `${global.win_rate}%`, l: 'Win', c: global.win_rate >= 50 ? '#10b981' : '#f59e0b' }
        ].map((s, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              background: 'rgba(10, 14, 39, 0.6)',
              border: '1px solid rgba(59, 130, 246, 0.1)',
              borderRadius: 10,
              padding: '10px 8px',
              textAlign: 'center',
              borderTop: `2px solid ${s.c}40`
            }}
          >
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: s.c, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
              {s.v}
            </div>
            <div style={{ fontSize: '0.56rem', color: 'var(--bos-text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {s.l}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Critical alerts banner */}
      {criticalAlerts.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.02))',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderLeft: '3px solid #ef4444',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: '0.78rem'
          }}
        >
          <strong style={{ color: '#ef4444' }}>⚠ {criticalAlerts.length} ad set{criticalAlerts.length > 1 ? 's' : ''} con 1 solo ad</strong>
          <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {criticalAlerts.slice(0, 6).map(a => (
              <span
                key={a.adset_id}
                onClick={() => setExpandedAdSet(a.adset_id)}
                style={{
                  fontSize: '0.62rem',
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#f87171',
                  padding: '2px 8px',
                  borderRadius: 4,
                  cursor: 'pointer'
                }}
              >
                {a.adset_name}
              </span>
            ))}
            {criticalAlerts.length > 6 && (
              <span style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)' }}>+{criticalAlerts.length - 6} más</span>
            )}
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
        borderRadius: 10,
        overflowX: 'auto'
      }}>
        {[
          { k: 'overview', l: 'Resumen', c: ATHENA_COLOR },
          { k: 'actions', l: 'Acciones', c: '#10b981', n: recentActions.length },
          { k: 'winners', l: 'Escalando', c: '#10b981', n: winners.length },
          { k: 'watching', l: 'Observando', c: '#3b82f6', n: watching.length },
          { k: 'risk', l: 'Riesgo', c: '#ef4444', n: risk.length },
          { k: 'learning', l: 'Learning', c: '#fbbf24', n: learningAdsets.length }
        ].map(t => {
          const active = activeSection === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setActiveSection(t.k)}
              style={{
                flex: '1 1 auto',
                padding: '8px 10px',
                background: active ? `linear-gradient(135deg, ${t.c}25, ${t.c}12)` : 'transparent',
                border: active ? `1px solid ${t.c}50` : '1px solid transparent',
                borderRadius: 6,
                color: active ? t.c : 'var(--bos-text-muted)',
                fontSize: '0.68rem',
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                whiteSpace: 'nowrap'
              }}
            >
              {t.l} {t.n > 0 && <span style={{ opacity: 0.6, marginLeft: 3 }}>{t.n}</span>}
            </button>
          );
        })}
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
          {activeSection === 'overview' && (
            <OverviewSection winners={winners} risk={risk} expandedAdSet={expandedAdSet} setExpandedAdSet={setExpandedAdSet} />
          )}
          {activeSection === 'actions' && (
            <ActionsTimeline actions={recentActions} />
          )}
          {activeSection === 'winners' && (
            <AdSetList list={winners.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0))} label="Escalando · ROAS 3x+" color="#10b981" expandedAdSet={expandedAdSet} setExpandedAdSet={setExpandedAdSet} emptyMsg="Sin ganadores ROAS 3x+" />
          )}
          {activeSection === 'watching' && (
            <AdSetList list={watching.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0))} label="Observando · ROAS 1.5-3x" color="#3b82f6" expandedAdSet={expandedAdSet} setExpandedAdSet={setExpandedAdSet} emptyMsg="Sin ad sets en observación" />
          )}
          {activeSection === 'risk' && (
            <AdSetList list={risk.sort((a, b) => (a.metrics_7d?.roas || 0) - (b.metrics_7d?.roas || 0))} label="En Riesgo · ROAS <1.5x" color="#ef4444" expandedAdSet={expandedAdSet} setExpandedAdSet={setExpandedAdSet} emptyMsg="Sin ad sets en riesgo" />
          )}
          {activeSection === 'learning' && (
            <LearningSection list={learningAdsets.sort((a, b) => (b.learning_conversions || 0) - (a.learning_conversions || 0))} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERVIEW — side by side winners + risk
// ═══════════════════════════════════════════════════════════════════════════

function OverviewSection({ winners, risk, expandedAdSet, setExpandedAdSet }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <div>
        <SectionHeader label="Top Winners" count={winners.length} color="#10b981" />
        {winners.length === 0 ? (
          <Empty>Sin ganadores</Empty>
        ) : (
          winners.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0)).slice(0, 5).map(a => (
            <AdSetRow key={a.adset_id} adset={a} expanded={expandedAdSet === a.adset_id} onToggle={() => setExpandedAdSet(expandedAdSet === a.adset_id ? null : a.adset_id)} />
          ))
        )}
      </div>
      <div>
        <SectionHeader label="En Riesgo" count={risk.length} color="#ef4444" />
        {risk.length === 0 ? (
          <Empty>Sin ad sets en riesgo</Empty>
        ) : (
          risk.sort((a, b) => (a.metrics_7d?.roas || 0) - (b.metrics_7d?.roas || 0)).slice(0, 5).map(a => (
            <AdSetRow key={a.adset_id} adset={a} expanded={expandedAdSet === a.adset_id} onToggle={() => setExpandedAdSet(expandedAdSet === a.adset_id ? null : a.adset_id)} />
          ))
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS TIMELINE
// ═══════════════════════════════════════════════════════════════════════════

function ActionsTimeline({ actions }) {
  if (actions.length === 0) {
    return <Empty>Sin acciones recientes</Empty>;
  }
  return (
    <div style={{ borderLeft: `2px solid ${ATHENA_COLOR}30`, paddingLeft: 16, marginLeft: 6 }}>
      {actions.map((act, i) => {
        const am = ACTION_LABELS[act.action] || { icon: '•', label: act.action, color: '#6b7280' };
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03 }}
            style={{ position: 'relative', marginBottom: 10 }}
          >
            <div style={{
              position: 'absolute',
              left: -22,
              top: 8,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: am.color,
              border: '2px solid var(--bos-bg-void)',
              boxShadow: `0 0 8px ${am.color}`
            }} />
            <div style={{
              background: 'rgba(17, 21, 51, 0.55)',
              borderRadius: 8,
              padding: '10px 14px',
              borderLeft: `2px solid ${am.color}40`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ color: am.color, fontWeight: 700, fontSize: '0.72rem', fontFamily: 'JetBrains Mono, monospace' }}>
                  {am.icon} {am.label.toUpperCase()}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--bos-text)' }}>{act.adset_name}</span>
                {(act.action === 'scale_up' || act.action === 'scale_down') && (
                  <span style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                    ${act.before_value} → ${act.after_value}
                  </span>
                )}
                <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
                  {formatTime(act.executed_at)}
                </span>
              </div>
              {act.reasoning && (
                <div style={{ fontSize: '0.66rem', color: 'var(--bos-text-muted)', lineHeight: 1.5 }}>
                  {act.reasoning.substring(0, 220)}
                </div>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AD SET LIST (for winners/watching/risk tabs)
// ═══════════════════════════════════════════════════════════════════════════

function AdSetList({ list, label, color, expandedAdSet, setExpandedAdSet, emptyMsg }) {
  if (list.length === 0) return <Empty>{emptyMsg}</Empty>;
  return (
    <div>
      <SectionHeader label={label} count={list.length} color={color} />
      {list.map(a => (
        <AdSetRow
          key={a.adset_id}
          adset={a}
          expanded={expandedAdSet === a.adset_id}
          onToggle={() => setExpandedAdSet(expandedAdSet === a.adset_id ? null : a.adset_id)}
        />
      ))}
    </div>
  );
}

function AdSetRow({ adset, expanded, onToggle }) {
  const roas = adset.metrics_7d?.roas || 0;
  const roas3d = adset.metrics_3d?.roas || 0;
  const trend = roas3d > roas ? '↑' : roas3d < roas ? '↓' : '→';
  const trendColor = roas3d > roas ? '#10b981' : roas3d < roas ? '#ef4444' : 'var(--bos-text-muted)';

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onToggle}
      style={{
        background: 'rgba(17, 21, 51, 0.5)',
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 4,
        cursor: 'pointer',
        borderLeft: `3px solid ${roasColor(roas)}`,
        transition: 'all 0.15s'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--bos-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
            {adset.adset_name}
            {adset.learning_stage === 'LEARNING' && (
              <span style={{ fontSize: '0.55rem', background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', padding: '1px 6px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                {adset.learning_conversions || 0}/50
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-muted)', marginTop: 3, display: 'flex', gap: 10, fontFamily: 'JetBrains Mono, monospace' }}>
            <span>${adset.daily_budget}/d</span>
            <span>${Math.round(adset.metrics_7d?.spend || 0)}</span>
            <span>{adset.metrics_7d?.purchases || 0}c</span>
            <span>f:{(adset.metrics_7d?.frequency || 0).toFixed(1)}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right', marginLeft: 12 }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: roasColor(roas), fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
            {roas.toFixed(2)}x
          </div>
          <div style={{ fontSize: '0.58rem', color: trendColor, marginTop: 3, fontFamily: 'JetBrains Mono, monospace' }}>
            3d: {roas3d.toFixed(2)}x {trend}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid rgba(255, 255, 255, 0.06)',
              overflow: 'hidden'
            }}
          >
            {adset.agent?.assessment && (
              <div style={{ color: 'var(--bos-text-muted)', marginBottom: 8, lineHeight: 1.5, fontSize: '0.7rem', fontStyle: 'italic' }}>
                💭 {adset.agent.assessment}
              </div>
            )}
            <div style={{ display: 'flex', gap: 14, color: 'var(--bos-text-muted)', flexWrap: 'wrap', fontSize: '0.66rem', fontFamily: 'JetBrains Mono, monospace' }}>
              <span>CTR: {(adset.metrics_7d?.ctr || 0).toFixed(2)}%</span>
              <span>CPA: ${(adset.metrics_7d?.cpa || 0).toFixed(2)}</span>
              <span>{adset.active_ads_count || 0} ads</span>
            </div>
            {(adset.recent_actions || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                  Historial
                </div>
                {adset.recent_actions.slice(0, 3).map((act, i) => {
                  const am = ACTION_LABELS[act.action] || { icon: '•', label: act.action, color: '#6b7280' };
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: '0.63rem' }}>
                      <span style={{ color: am.color }}>{am.icon}</span>
                      <span style={{ color: am.color, fontFamily: 'JetBrains Mono, monospace' }}>{am.label}</span>
                      {(act.action === 'scale_up' || act.action === 'scale_down') && (
                        <span style={{ color: 'var(--bos-text-muted)' }}>${act.before_value} → ${act.after_value}</span>
                      )}
                      <span style={{ color: 'var(--bos-text-dim)', marginLeft: 'auto' }}>{formatTime(act.executed_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LEARNING SECTION — progress bars to 50 conv
// ═══════════════════════════════════════════════════════════════════════════

function LearningSection({ list }) {
  if (list.length === 0) return <Empty>Sin ad sets en learning phase</Empty>;
  return (
    <div>
      <SectionHeader label="Meta Learning Phase" count={list.length} color="#fbbf24" />
      {list.map((a, i) => {
        const conv = a.learning_conversions || 0;
        const pct = Math.round((conv / 50) * 100);
        const barColor = pct >= 80 ? '#10b981' : pct >= 50 ? '#3b82f6' : '#fbbf24';
        return (
          <motion.div
            key={a.adset_id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03 }}
            style={{
              background: 'rgba(17, 21, 51, 0.5)',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 6,
              borderLeft: '3px solid rgba(251, 191, 36, 0.4)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
              <span style={{ fontSize: '0.76rem', color: 'var(--bos-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.adset_name}
              </span>
              <span style={{ fontSize: '0.78rem', color: roasColor(a.metrics_7d?.roas || 0), fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', marginLeft: 10 }}>
                {(a.metrics_7d?.roas || 0).toFixed(2)}x
              </span>
            </div>
            <div style={{ background: 'rgba(10, 14, 39, 0.6)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 5 }}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.8, delay: i * 0.04 }}
                style={{
                  height: '100%',
                  background: `linear-gradient(90deg, ${barColor}, ${barColor}dd)`,
                  boxShadow: `0 0 8px ${barColor}60`,
                  borderRadius: 4
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              <span>{conv}/50 conversiones ({50 - conv} faltan)</span>
              <span>${a.daily_budget}/d</span>
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
          background: `${color || '#6b7280'}15`,
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

function Empty({ children }) {
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
