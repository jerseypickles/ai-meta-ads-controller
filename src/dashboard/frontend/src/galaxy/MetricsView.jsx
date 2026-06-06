import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import api from '../api';

const roasColor = r => (r >= 3 ? '#34d399' : r >= 1.5 ? '#fbbf24' : r > 0 ? '#f87171' : '#64748b');
const fmt$ = n => `$${Math.round(n || 0).toLocaleString()}`;
const dmFmt = s => { const [, m, d] = (s || '').split('-'); return d && m ? `${d}/${m}` : s; };

export default function MetricsView() {
  const [ov, setOv] = useState(null);
  const [hist, setHist] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/metrics/overview').then(r => r.data).catch(() => null),
      api.get('/api/metrics/overview/history?days=30').then(r => r.data).catch(() => [])
    ]).then(([o, h]) => { setOv(o); setHist(Array.isArray(h) ? h : []); }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Cargando métricas…</div>;

  const windows = [
    { k: 'today_roas', l: 'Hoy' }, { k: 'roas_3d', l: '3d' }, { k: 'roas_7d', l: '7d' },
    { k: 'roas_14d', l: '14d' }, { k: 'roas_30d', l: '30d' }
  ];
  const series = hist.map(d => ({ ...d, dm: dmFmt(d.date) }));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '0.02em' }}>Métricas de la Cuenta</div>
          <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>
            {ov?.data_age_minutes != null ? `Datos de hace ${ov.data_age_minutes} min` : 'Jersey Pickles'}
            {ov && <> · {ov.active_adsets} adsets activos</>}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 18 }}>
        <Kpi label="ROAS hoy" value={`${(ov?.today_roas || 0).toFixed(2)}x`} color={roasColor(ov?.today_roas)} />
        <Kpi label="ROAS 7d" value={`${(ov?.roas_7d || 0).toFixed(2)}x`} color={roasColor(ov?.roas_7d)} />
        <Kpi label="Revenue hoy" value={fmt$(ov?.today_revenue)} color="#60a5fa" />
        <Kpi label="Spend hoy" value={fmt$(ov?.spend_today)} color="#f59e0b" />
        <Kpi label="Spend 14d" value={fmt$(ov?.spend_14d)} color="#a78bfa" />
        <Kpi label="Presupuesto" value={fmt$(ov?.daily_budget)} color="#22d3ee" />
      </div>

      {/* ROAS por ventana */}
      <div style={{ marginBottom: 18 }}>
        <SectionLabel>ROAS por ventana</SectionLabel>
        <div style={{ display: 'flex', gap: 8 }}>
          {windows.map(w => {
            const v = ov?.[w.k] || 0; const c = roasColor(v); const noData = !v;
            return (
              <div key={w.k} style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: `1px solid ${c}33`, borderRadius: 8, padding: '8px 6px', textAlign: 'center' }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: noData ? 'var(--text-muted)' : c, fontFamily: 'JetBrains Mono, monospace' }}>{noData ? '—' : v.toFixed(2) + 'x'}</div>
                <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, margin: '4px 0' }}>
                  <div style={{ width: `${Math.min(100, (v / 5) * 100)}%`, height: '100%', background: c, borderRadius: 2 }} />
                </div>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{w.l}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tendencia */}
      <SectionLabel>Spend &amp; ROAS · {series.length} días</SectionLabel>
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '14px 10px 6px', height: 280 }}>
        {series.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.78rem' }}>Sin histórico aún.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="dm" tick={{ fontSize: 9, fill: '#94a3b8' }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
              <YAxis yAxisId="l" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={42} tickFormatter={v => `$${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={30} tickFormatter={v => `${v}x`} />
              <Tooltip contentStyle={{ background: '#0f1117', border: '1px solid #2d3244', borderRadius: 8, fontSize: 11 }}
                formatter={(val, name) => name === 'spend' ? [fmt$(val), 'Spend'] : [`${val}x`, 'ROAS 7d']} labelStyle={{ color: '#94a3b8' }} />
              <Bar yAxisId="l" dataKey="spend" fill="#f59e0b" fillOpacity={0.5} radius={[2, 2, 0, 0]} />
              <Line yAxisId="r" type="monotone" dataKey="roas_7d" stroke="#34d399" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{value}</div>
    </div>
  );
}
function SectionLabel({ children }) {
  return <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{children}</div>;
}
