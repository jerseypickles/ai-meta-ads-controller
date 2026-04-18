import { useState, useEffect } from 'react';
import { getAgentPerformance } from '../api';

const ACTION_LABELS = {
  scale_up: { icon: '↑', label: 'Scale Up', color: '#10b981' },
  scale_down: { icon: '↓', label: 'Scale Down', color: '#f59e0b' },
  pause: { icon: '⏸', label: 'Pause Ad', color: '#ef4444' },
  pause_adset: { icon: '⏹', label: 'Pause AdSet', color: '#ef4444' },
  reactivate: { icon: '▶', label: 'Reactivar', color: '#3b82f6' },
  create_ad: { icon: '+', label: 'Crear Ad', color: '#8b5cf6' }
};

const ATHENA_BLUE = '#60a5fa';

function AthenaPanel({ data, loading, running, expandedAdSet, onToggleExpand, onRunAgent, onRefresh, formatTime }) {
  const [activeSection, setActiveSection] = useState('overview');

  if (loading && !data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando Athena...</div>;

  const adsets = data?.adsets || [];
  const global = data?.global || { total_adsets: 0, win_rate: 0, total_measured: 0, last_cycle: null };
  const roasColor = (r) => r >= 4 ? '#10b981' : r >= 2.5 ? '#3b82f6' : r >= 1.5 ? '#f59e0b' : r > 0 ? '#ef4444' : '#6b7280';

  // Categorizar
  const winners = adsets.filter(a => (a.metrics_7d?.roas || 0) >= 3 && (a.metrics_7d?.spend || 0) >= 50);
  const watching = adsets.filter(a => (a.metrics_7d?.roas || 0) >= 1.5 && (a.metrics_7d?.roas || 0) < 3 && (a.metrics_7d?.spend || 0) >= 30);
  const risk = adsets.filter(a => (a.metrics_7d?.roas || 0) < 1.5 && (a.metrics_7d?.spend || 0) >= 50);
  const learningAdsets = adsets.filter(a => a.learning_stage === 'LEARNING');
  const recentActions = adsets
    .flatMap(a => (a.recent_actions || []).map(act => ({ ...act, adset_name: a.adset_name, adset_id: a.adset_id })))
    .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))
    .slice(0, 15);

  const SectionTab = ({ id, label, count, color }) => (
    <div onClick={() => setActiveSection(id)} style={{
      padding: '8px 16px', cursor: 'pointer',
      borderBottom: activeSection === id ? `2px solid ${color || ATHENA_BLUE}` : '2px solid transparent',
      color: activeSection === id ? 'var(--text-primary)' : 'var(--text-muted)',
      fontSize: '0.78rem', fontWeight: activeSection === id ? 600 : 400,
      transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: 6
    }}>
      {label}
      {count > 0 && (
        <span style={{ fontSize: '0.6rem', background: `${color || ATHENA_BLUE}20`, color: color || ATHENA_BLUE, padding: '1px 6px', borderRadius: 8, fontWeight: 600 }}>
          {count}
        </span>
      )}
    </div>
  );

  const AdSetRow = ({ adset }) => {
    const isExpanded = expandedAdSet === adset.adset_id;
    const roas = adset.metrics_7d?.roas || 0;
    const roas3d = adset.metrics_3d?.roas || 0;
    const trend = roas3d > roas ? '↑' : roas3d < roas ? '↓' : '→';

    return (
      <div onClick={() => onToggleExpand(adset.adset_id)} style={{
        background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 4,
        cursor: 'pointer', borderLeft: `3px solid ${roasColor(roas)}`, transition: 'all 0.15s'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
              {adset.adset_name}
              {adset.learning_stage === 'LEARNING' && (
                <span style={{ fontSize: '0.55rem', background: '#fbbf2420', color: '#fbbf24', padding: '1px 5px', borderRadius: 4 }}>
                  {adset.learning_conversions || 0}/50
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 12 }}>
              <span>${adset.daily_budget}/d</span>
              <span>${Math.round(adset.metrics_7d?.spend || 0)} spend</span>
              <span>{adset.metrics_7d?.purchases || 0} compras</span>
              <span>f:{(adset.metrics_7d?.frequency || 0).toFixed(1)}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right', marginLeft: 12 }}>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: roasColor(roas) }}>{roas.toFixed(2)}x</div>
            <div style={{ fontSize: '0.6rem', color: roas3d > roas ? '#10b981' : roas3d < roas ? '#ef4444' : 'var(--text-muted)' }}>
              3d: {roas3d.toFixed(2)}x {trend}
            </div>
          </div>
        </div>
        {isExpanded && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-color)', fontSize: '0.7rem' }}>
            {adset.agent?.assessment && (
              <div style={{ color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>{adset.agent.assessment}</div>
            )}
            <div style={{ display: 'flex', gap: 16, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>7d: {roas.toFixed(2)}x</span>
              <span>3d: {roas3d.toFixed(2)}x</span>
              <span>CTR: {(adset.metrics_7d?.ctr || 0).toFixed(2)}%</span>
              <span>CPA: ${(adset.metrics_7d?.cpa || 0).toFixed(2)}</span>
              <span>{adset.active_ads_count || 0} ads</span>
            </div>
            {(adset.recent_actions || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                {adset.recent_actions.slice(0, 3).map((act, i) => {
                  const am = ACTION_LABELS[act.action] || { icon: '•', label: act.action, color: '#6b7280' };
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', color: am.color, fontSize: '0.65rem' }}>
                      <span>{am.icon}</span>
                      <span>{am.label}</span>
                      {(act.action === 'scale_up' || act.action === 'scale_down') && <span>${act.before_value} → ${act.after_value}</span>}
                      <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{formatTime(act.executed_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="agent-panel">
      {/* ═══ HEADER ═══ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%', background: `${ATHENA_BLUE}15`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${ATHENA_BLUE}30`
          }}>
            <span style={{ fontSize: '1.5rem' }}>🦉</span>
          </div>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Athena <span style={{ fontSize: '0.7rem', color: ATHENA_BLUE, fontWeight: 500 }}>Estratega</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {global.total_adsets} ad sets | {global.last_cycle ? `Ultimo ciclo ${formatTime(global.last_cycle)}` : 'Sin actividad'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="brain-action-btn" onClick={onRefresh} disabled={loading} style={{ fontSize: '0.72rem' }}>
            {loading ? '...' : 'Refrescar'}
          </button>
          <button className="brain-action-btn primary" onClick={onRunAgent} disabled={running} style={{ fontSize: '0.72rem' }}>
            {running ? 'Ejecutando...' : 'Ejecutar'}
          </button>
        </div>
      </div>

      {/* ═══ STATS BAR ═══ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 20 }}>
        {[
          { v: global.total_adsets, l: 'Ad Sets', c: ATHENA_BLUE },
          { v: winners.length, l: 'Escalando', c: '#10b981' },
          { v: watching.length, l: 'Observando', c: '#3b82f6' },
          { v: risk.length, l: 'En Riesgo', c: '#ef4444' },
          { v: learningAdsets.length, l: 'Learning', c: '#fbbf24' },
          { v: `${global.win_rate}%`, l: 'Win Rate', c: global.win_rate >= 50 ? '#10b981' : '#f59e0b' }
        ].map((s, i) => (
          <div key={i} style={{
            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 8px',
            textAlign: 'center', borderTop: `2px solid ${s.c}30`
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* ═══ SECTION TABS ═══ */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: 16, overflow: 'auto' }}>
        <SectionTab id="overview" label="Resumen" count={0} />
        <SectionTab id="actions" label="Acciones" count={recentActions.length} color="#10b981" />
        <SectionTab id="winners" label="Escalando" count={winners.length} color="#10b981" />
        <SectionTab id="watching" label="Observando" count={watching.length} color="#3b82f6" />
        <SectionTab id="risk" label="En Riesgo" count={risk.length} color="#ef4444" />
        <SectionTab id="learning" label="Learning" count={learningAdsets.length} color="#fbbf24" />
      </div>

      {/* ═══ OVERVIEW ═══ */}
      {activeSection === 'overview' && (
        <div>
          {/* Alertas */}
          {(() => {
            const critical = adsets.filter(a => (a.active_ads_count || 0) <= 1 && a.status === 'ACTIVE');
            return critical.length > 0 && (
              <div style={{ background: '#ef444415', border: '1px solid #ef444430', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 16, fontSize: '0.75rem' }}>
                <strong style={{ color: '#ef4444' }}>{critical.length} ad set{critical.length > 1 ? 's' : ''} con 1 solo ad</strong>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {critical.map(a => (
                    <span key={a.adset_id} style={{ fontSize: '0.65rem', background: '#ef444420', color: '#f87171', padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }} onClick={() => onToggleExpand(a.adset_id)}>
                      {a.adset_name}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Top winners + Top risk side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: '0.72rem', color: '#10b981', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Top Winners</div>
              {winners.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0)).slice(0, 5).map(a => <AdSetRow key={a.adset_id} adset={a} />)}
              {winners.length === 0 && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>Sin ganadores ROAS 3x+</div>}
            </div>
            <div>
              <div style={{ fontSize: '0.72rem', color: '#ef4444', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>En Riesgo</div>
              {risk.sort((a, b) => (a.metrics_7d?.roas || 0) - (b.metrics_7d?.roas || 0)).slice(0, 5).map(a => <AdSetRow key={a.adset_id} adset={a} />)}
              {risk.length === 0 && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>Sin ad sets en riesgo</div>}
            </div>
          </div>
        </div>
      )}

      {/* ═══ ACTIONS TIMELINE ═══ */}
      {activeSection === 'actions' && (
        <div>
          <div style={{ fontSize: '0.72rem', color: ATHENA_BLUE, fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timeline de Acciones</div>
          {recentActions.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>Sin acciones recientes</div>}
          <div style={{ borderLeft: `2px solid ${ATHENA_BLUE}30`, paddingLeft: 16, marginLeft: 6 }}>
            {recentActions.map((act, i) => {
              const am = ACTION_LABELS[act.action] || { icon: '•', label: act.action, color: '#6b7280' };
              return (
                <div key={i} style={{ position: 'relative', marginBottom: 12 }}>
                  <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: am.color, border: '2px solid var(--bg-primary)' }} />
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: am.color, fontWeight: 600, fontSize: '0.75rem' }}>{am.icon} {am.label}</span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-primary)' }}>{act.adset_name}</span>
                        {(act.action === 'scale_up' || act.action === 'scale_down') && (
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>${act.before_value} → ${act.after_value}</span>
                        )}
                      </div>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{formatTime(act.executed_at)}</span>
                    </div>
                    {act.reasoning && <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>{act.reasoning.substring(0, 200)}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ WINNERS ═══ */}
      {activeSection === 'winners' && (
        <div>
          <div style={{ fontSize: '0.72rem', color: '#10b981', fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Escalando — ROAS 3x+ ({winners.length})</div>
          {winners.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0)).map(a => <AdSetRow key={a.adset_id} adset={a} />)}
          {winners.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin ganadores</div>}
        </div>
      )}

      {/* ═══ WATCHING ═══ */}
      {activeSection === 'watching' && (
        <div>
          <div style={{ fontSize: '0.72rem', color: '#3b82f6', fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Observando — ROAS 1.5-3x ({watching.length})</div>
          {watching.sort((a, b) => (b.metrics_7d?.roas || 0) - (a.metrics_7d?.roas || 0)).map(a => <AdSetRow key={a.adset_id} adset={a} />)}
          {watching.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin ad sets en observacion</div>}
        </div>
      )}

      {/* ═══ RISK ═══ */}
      {activeSection === 'risk' && (
        <div>
          <div style={{ fontSize: '0.72rem', color: '#ef4444', fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>En Riesgo — ROAS &lt;1.5x ({risk.length})</div>
          {risk.sort((a, b) => (a.metrics_7d?.roas || 0) - (b.metrics_7d?.roas || 0)).map(a => <AdSetRow key={a.adset_id} adset={a} />)}
          {risk.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin ad sets en riesgo</div>}
        </div>
      )}

      {/* ═══ LEARNING ═══ */}
      {activeSection === 'learning' && (
        <div>
          <div style={{ fontSize: '0.72rem', color: '#fbbf24', fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Meta Learning Phase ({learningAdsets.length})</div>
          {learningAdsets.sort((a, b) => (b.learning_conversions || 0) - (a.learning_conversions || 0)).map(a => {
            const conv = a.learning_conversions || 0;
            const pct = Math.round(conv / 50 * 100);
            return (
              <div key={a.adset_id} style={{
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 14px',
                marginBottom: 4, borderLeft: '3px solid #fbbf2440'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{a.adset_name}</span>
                  <span style={{ fontSize: '0.7rem', color: roasColor(a.metrics_7d?.roas || 0), fontWeight: 600 }}>{(a.metrics_7d?.roas || 0).toFixed(2)}x</span>
                </div>
                <div style={{ background: 'var(--bg-tertiary)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 4 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: pct >= 80 ? '#10b981' : '#fbbf24', borderRadius: 4, transition: 'width 0.3s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  <span>{conv}/50 conversiones ({50 - conv} faltan)</span>
                  <span>${a.daily_budget}/d</span>
                </div>
              </div>
            );
          })}
          {learningAdsets.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin ad sets en learning</div>}
        </div>
      )}
    </div>
  );
}

export default AthenaPanel;
