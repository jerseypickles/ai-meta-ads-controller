import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../api';

// Panel de Forecast de Demanda (Pilar 2 "Zeus con esteroides"). Muestra lo que Zeus
// "anticipa": demanda 7/30/90d, tendencia + confianza (honesta ante quiebres), momentum,
// patrón por día de semana, daily 14d y eventos próximos. Lee /api/zeus/demand-forecast.

const money = (n) => (n == null ? '—' : Math.abs(n) >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + Math.round(n));

function Metric({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: 'rgba(10,14,39,0.6)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: color || 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
      <div style={{ fontSize: '0.5rem', color: 'var(--bos-text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: '0.56rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

// Sparkline de barras para los próximos 14 días
function DailyBars({ days }) {
  if (!days || !days.length) return null;
  const max = Math.max(1, ...days.map(d => d.rev || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
      {days.map((d, i) => {
        const h = Math.max(4, ((d.rev || 0) / max) * 52);
        const weekend = d.dow === 'dom' || d.dow === 'sáb';
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }} title={`${d.date}: $${(d.rev || 0).toLocaleString()}`}>
            <motion.div initial={{ height: 0 }} animate={{ height: h }} transition={{ delay: i * 0.02 }}
              style={{ width: '100%', maxWidth: 12, borderRadius: 2, background: weekend ? '#10b981' : 'rgba(59,130,246,0.55)' }} />
            <div style={{ fontSize: '0.42rem', color: 'var(--bos-text-dim)' }}>{d.dow?.[0]}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function DemandForecastPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try { const res = await api.get('/api/zeus/demand-forecast'); setData(res.data); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function recompute() {
    setLoading(true);
    try { await api.post('/api/zeus/demand-forecast/compute'); } catch (e) {}
    setTimeout(load, 8000);
  }

  const df = data && data.available !== false ? data : null;
  const lowConf = df?.trend_confidence === 'baja';
  const fc = df?.forecast || {};
  const trendColor = lowConf ? 'var(--bos-electric)' : (df?.weekly_growth_pct > 2 ? '#10b981' : df?.weekly_growth_pct < -2 ? '#ef4444' : 'var(--bos-text-muted)');

  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="zeus-plans-panel">
      <div className="zeus-plans-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="zeus-panel-close" onClick={onClose} aria-label="Cerrar">×</button>
        <div className="zeus-plans-title" style={{ flex: 1 }}>📈 Forecast de Demanda</div>
        <button onClick={recompute} title="Recomputar" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--bos-text-muted)', borderRadius: 6, padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer' }}>↻</button>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {loading ? (
          <div style={{ color: 'var(--bos-text-dim)', fontSize: '0.7rem' }}>Cargando…</div>
        ) : !df ? (
          <div style={{ color: 'var(--bos-text-muted)', fontSize: '0.7rem' }}>Sin snapshot aún. Tocá <b>↻</b> para computar.</div>
        ) : (
          <>
            {/* Hero forecast */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <Metric label="Próx. 7 días" value={money(fc.next_7d)} color="#3b82f6" />
              <Metric label="Próx. 30 días" value={money(fc.next_30d)} />
              <Metric label="Próx. 90 días" value={money(fc.next_90d)} />
            </div>

            {/* Trend + confidence */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.66rem', color: trendColor, fontWeight: 600 }}>
                {lowConf ? '⚠️ ' : ''}{df.trend} {df.weekly_growth_pct != null && !lowConf ? `(${df.weekly_growth_pct > 0 ? '+' : ''}${df.weekly_growth_pct}%/sem)` : ''}
              </span>
              {lowConf && (
                <span style={{ fontSize: '0.56rem', color: 'var(--bos-electric)', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 10, padding: '2px 8px' }}>
                  baja confianza · serie volátil
                </span>
              )}
              {df.momentum_pct != null && (
                <span style={{ fontSize: '0.56rem', color: 'var(--bos-text-muted)' }}>
                  momentum 7d {df.momentum_pct > 0 ? '+' : ''}{df.momentum_pct}%
                </span>
              )}
            </div>

            {lowConf && (
              <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 8, padding: '8px 10px', marginBottom: 14, fontSize: '0.62rem', color: 'var(--bos-text-muted)', lineHeight: 1.5 }}>
                La serie está muy volátil (quiebre/recuperación reciente). No confiar en el número de tendencia — guiarse por la trayectoria de abajo + los eventos.
              </div>
            )}

            {/* Daily 14d */}
            <Section title="Próximos 14 días (verde = fin de semana)">
              <DailyBars days={df.daily_14d} />
            </Section>

            {/* DoW pattern */}
            {df.dow_pattern?.peak && (
              <Section title="Patrón por día de semana">
                <div style={{ display: 'flex', gap: 8, fontSize: '0.66rem' }}>
                  <span style={{ color: '#10b981' }}>▲ pico <b>{df.dow_pattern.peak.day}</b> ({df.dow_pattern.peak.mult}x)</span>
                  <span style={{ color: 'var(--bos-text-muted)' }}>▼ valle <b>{df.dow_pattern.low.day}</b> ({df.dow_pattern.low.mult}x)</span>
                </div>
              </Section>
            )}

            {/* Events */}
            {df.upcoming_events?.length > 0 && (
              <Section title="Eventos próximos (pre-posicionar)">
                {df.upcoming_events.map((e, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.64rem', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ color: 'var(--bos-text)' }}>🎯 {e.name}</span>
                    <span style={{ color: 'var(--bos-electric)', fontFamily: 'JetBrains Mono, monospace' }}>en {e.days_away}d</span>
                  </div>
                ))}
              </Section>
            )}

            <div style={{ fontSize: '0.52rem', color: 'var(--bos-text-dim)', marginTop: 4, lineHeight: 1.5 }}>
              Baseline {money(df.baseline_daily)}/día · {df.based_on_days}d de historia · pronóstico heurístico, no certeza
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
