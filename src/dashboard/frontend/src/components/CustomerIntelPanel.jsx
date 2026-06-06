import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../api';

// Panel de Inteligencia de Cliente (Pilar 1 "Zeus con esteroides"). Muestra lo que Zeus
// ahora "piensa" sobre el CLIENTE: recompra, LTV, AOV, segmentos RFM, split new/returning,
// top productos por revenue y por ADQUISICIÓN (puerta de entrada). Lee /api/zeus/customer-intelligence.

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const moneyK = (n) => (n == null ? '—' : Math.abs(n) >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : '$' + Math.round(n));

function Metric({ label, value, color, sub }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: 'rgba(10,14,39,0.6)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 10, padding: '9px 6px', textAlign: 'center' }}>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: color || 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: '0.5rem', color: 'var(--bos-text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      {sub && <div style={{ fontSize: '0.52rem', color: 'var(--bos-text-dim)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Bar({ label, value, max, color, right }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.62rem', color: 'var(--bos-text-muted)', marginBottom: 3 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{label}</span>
        <span style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>{right}</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
        <motion.div initial={{ width: 0 }} animate={{ width: pct + '%' }} transition={{ duration: 0.5 }} style={{ height: '100%', background: color, borderRadius: 3 }} />
      </div>
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

export default function CustomerIntelPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  async function load() {
    try { const res = await api.get('/api/zeus/customer-intelligence'); setData(res.data); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function recompute() {
    setMsg('Computando desde Shopify… (~9 min, volvé a abrir luego)');
    try { await api.post('/api/zeus/customer-intelligence/compute'); } catch (e) { setMsg('Error al disparar'); }
  }

  const ci = data && data.available !== false ? data : null;
  const seg = ci?.rfm_segments || {};
  const segMax = Math.max(1, ...Object.values(seg));
  const prods = ci?.top_products || [];
  const prodMax = Math.max(1, ...prods.map(p => p.revenue || 0));
  const acq = ci?.top_acquisition_products || [];
  const returningPct = ci?.revenue_split?.returning_pct || 0;
  const newPct = +(100 - returningPct).toFixed(0);

  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="zeus-plans-panel">
      <div className="zeus-plans-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="zeus-panel-close" onClick={onClose} aria-label="Cerrar">×</button>
        <div className="zeus-plans-title" style={{ flex: 1 }}>👥 Inteligencia de Cliente</div>
        <button onClick={recompute} title="Recomputar desde Shopify" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--bos-text-muted)', borderRadius: 6, padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer' }}>↻</button>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {loading ? (
          <div style={{ color: 'var(--bos-text-dim)', fontSize: '0.7rem' }}>Cargando…</div>
        ) : !ci ? (
          <div style={{ color: 'var(--bos-text-muted)', fontSize: '0.7rem', lineHeight: 1.6 }}>
            Sin snapshot aún. Tocá <b>↻</b> para computar desde Shopify (mina cohortes/LTV/RFM, tarda ~9 min).
            {msg && <div style={{ marginTop: 8, color: 'var(--bos-electric)' }}>{msg}</div>}
          </div>
        ) : (
          <>
            {/* Hero */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <Metric label="Clientes" value={(ci.total_customers || 0).toLocaleString()} />
              <Metric label="Recompra" value={(ci.repeat_rate_pct != null ? ci.repeat_rate_pct : Math.round((ci.repeat_rate || 0) * 100)) + '%'} color="var(--bos-electric)" />
              <Metric label="LTV" value={money(ci.avg_ltv)} />
              <Metric label="AOV" value={money(ci.avg_aov)} />
            </div>

            {/* Insight banner */}
            {returningPct < 40 && (
              <div style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 8, padding: '9px 11px', marginBottom: 14, fontSize: '0.66rem', color: 'var(--bos-text)', lineHeight: 1.55 }}>
                ⚠️ <b>{newPct}% del revenue es de clientes NUEVOS</b> — la retención es el mayor lever sin tocar. Vuelven cada ~{ci.avg_days_between_orders}d → ventana de winback.
              </div>
            )}

            {/* RFM */}
            <Section title="Segmentos (RFM)">
              <Bar label="🏆 Champions" value={seg.champions || 0} max={segMax} right={(seg.champions || 0).toLocaleString()} color="#10b981" />
              <Bar label="💚 Loyal" value={seg.loyal || 0} max={segMax} right={(seg.loyal || 0).toLocaleString()} color="#3b82f6" />
              <Bar label="🆕 Nuevos" value={seg.new || 0} max={segMax} right={(seg.new || 0).toLocaleString()} color="#a855f7" />
              <Bar label="⚠️ En riesgo" value={seg.at_risk || 0} max={segMax} right={(seg.at_risk || 0).toLocaleString()} color="#f97316" />
              <Bar label="💤 One-off" value={seg.one_off || 0} max={segMax} right={(seg.one_off || 0).toLocaleString()} color="#6b7280" />
            </Section>

            {/* Revenue split */}
            <Section title="Revenue: nuevos vs returning">
              <div style={{ display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', fontSize: '0.6rem', fontWeight: 600 }}>
                <div style={{ width: newPct + '%', background: 'rgba(168,85,247,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>{newPct}% nuevos</div>
                <div style={{ width: returningPct + '%', background: 'rgba(16,185,129,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>{returningPct}%</div>
              </div>
            </Section>

            {/* Top products */}
            <Section title="Top productos por revenue">
              {prods.slice(0, 6).map((p, i) => (
                <Bar key={i} label={p.name} value={p.revenue} max={prodMax} right={moneyK(p.revenue)} color="#3b82f6" />
              ))}
            </Section>

            {/* Acquisition */}
            {acq.length > 0 && (
              <Section title="Puerta de entrada (1ª compra)">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {acq.slice(0, 6).map((a, i) => (
                    <span key={i} style={{ fontSize: '0.6rem', color: 'var(--bos-text)', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 12, padding: '3px 9px' }}>
                      {a.name} <b style={{ color: '#10b981' }}>{a.first_orders}</b>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            <div style={{ fontSize: '0.52rem', color: 'var(--bos-text-dim)', marginTop: 4 }}>
              Ventana {ci.window_days}d · {(ci.orders_count || 0).toLocaleString()} órdenes · {money(ci.total_revenue)} revenue
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
