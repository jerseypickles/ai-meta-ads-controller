import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import api from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// DemeterWidget — cash reconciliation panel
// Muestra Meta ROAS (atribución) vs cash ROAS (real, post Shopify fees)
// ═══════════════════════════════════════════════════════════════════════════

const COLOR_META = '#60a5fa';     // azul — Meta-reported
const COLOR_CASH = '#34d399';     // verde — cash real
const COLOR_GAP_OK = '#34d399';
const COLOR_GAP_WARN = '#fbbf24';
const COLOR_GAP_BAD = '#f87171';

function gapColor(pct) {
  if (pct == null) return 'var(--bos-text-dim)';
  const a = Math.abs(pct);
  if (a < 15) return COLOR_GAP_OK;
  if (a < 30) return COLOR_GAP_WARN;
  return COLOR_GAP_BAD;
}

function fmtMoney(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtRoas(n) {
  if (n == null || n === 0) return '—';
  return `${n.toFixed(2)}x`;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const meta = payload.find(p => p.dataKey === 'meta_roas')?.value;
  const cash = payload.find(p => p.dataKey === 'cash_roas')?.value;
  return (
    <div style={{
      background: 'rgba(11, 17, 32, 0.95)',
      border: '1px solid rgba(96, 165, 250, 0.3)',
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: '0.72rem',
      fontFamily: 'JetBrains Mono, monospace',
      backdropFilter: 'blur(8px)'
    }}>
      <div style={{ color: '#e2e8f0', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <div style={{ color: COLOR_META }}>Meta: {fmtRoas(meta)}</div>
      <div style={{ color: COLOR_CASH }}>Cash: {fmtRoas(cash)}</div>
    </div>
  );
}

export default function DemeterWidget() {
  const [snapshots, setSnapshots] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [snapsR, sumR] = await Promise.all([
          api.get('/api/demeter/snapshots?days=30'),
          api.get('/api/demeter/summary?days=7')
        ]);
        if (!alive) return;
        setSnapshots(snapsR.data?.snapshots || []);
        setSummary(sumR.data?.summary || null);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err.response?.data?.error || err.message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 5 * 60 * 1000); // refresh cada 5 min
    return () => { alive = false; clearInterval(t); };
  }, []);

  const chartData = useMemo(() => {
    return [...snapshots]
      .reverse()
      .map(s => ({
        date: s.date_et?.slice(5) || '', // MM-DD
        meta_roas: s.meta_roas || 0,
        cash_roas: s.cash_roas || 0
      }));
  }, [snapshots]);

  const last7 = useMemo(() => snapshots.slice(0, 7), [snapshots]);

  if (loading) {
    return (
      <div className="demeter-widget" style={widgetStyle}>
        <div style={headerStyle}>
          <span style={{ fontSize: '1.05rem', fontWeight: 600 }}>💰 Cash Reconciliation</span>
        </div>
        <div style={{ padding: 24, color: 'var(--bos-text-muted)', fontSize: '0.78rem', textAlign: 'center' }}>
          Cargando snapshots...
        </div>
      </div>
    );
  }

  // Sin data: mostrar onboarding state
  if (snapshots.length === 0) {
    return (
      <div className="demeter-widget" style={widgetStyle}>
        <div style={headerStyle}>
          <span style={{ fontSize: '1.05rem', fontWeight: 600 }}>💰 Cash Reconciliation</span>
          <span style={{ fontSize: '0.62rem', color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            sin data
          </span>
        </div>
        <div style={{ padding: 24, color: 'var(--bos-text-muted)', fontSize: '0.8rem', textAlign: 'center', lineHeight: 1.6 }}>
          {error ? (
            <>
              <div style={{ color: '#f87171', marginBottom: 8 }}>⚠ {error}</div>
              <div>Verificá SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_TOKEN en env de Render.</div>
            </>
          ) : (
            <>
              No hay snapshots aún. Para inicializar, corré:
              <pre style={{ marginTop: 12, padding: 10, background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: '0.7rem', color: '#34d399', textAlign: 'left' }}>
                node scripts/demeter-backfill.js --days 60
              </pre>
            </>
          )}
        </div>
      </div>
    );
  }

  const today = snapshots[0];
  return (
    <div className="demeter-widget" style={widgetStyle}>
      {/* Header con stats principales */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '1.05rem', fontWeight: 600 }}>💰 Cash Reconciliation</span>
          <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            7d
          </span>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          {today?.date_et}
        </div>
      </div>

      {/* Big stats row */}
      {summary && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
          padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)'
        }}>
          <Stat
            label="Meta spend"
            value={fmtMoney(summary.total_meta_spend)}
            color="#94a3b8"
          />
          <Stat
            label="Cash net (post fees)"
            value={fmtMoney(summary.total_net_after_fees)}
            color={COLOR_CASH}
          />
          <Stat
            label="Cash ROAS"
            value={fmtRoas(summary.avg_cash_roas)}
            color={COLOR_CASH}
          />
          <Stat
            label="Gap vs Meta"
            value={`${summary.avg_gap_pct > 0 ? '+' : ''}${summary.avg_gap_pct.toFixed(1)}%`}
            color={gapColor(summary.avg_gap_pct)}
            tooltip={`Meta reportó ${fmtRoas(summary.avg_meta_roas)}, real ${fmtRoas(summary.avg_cash_roas)}`}
          />
        </div>
      )}

      {/* Sparkline 30d */}
      <div style={{ padding: '8px 18px 16px', height: 140 }}>
        <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>ROAS 30d</span>
          <span>
            <span style={{ color: COLOR_META }}>━ Meta</span>
            <span style={{ color: COLOR_CASH, marginLeft: 12 }}>━ Cash</span>
          </span>
        </div>
        <ResponsiveContainer width="100%" height="90%">
          <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: -28 }}>
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} interval={Math.max(0, Math.floor(chartData.length / 8) - 1)} />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} domain={['auto', 'auto']} />
            <ReferenceLine y={3} stroke="#475569" strokeDasharray="2 4" strokeWidth={0.8} />
            <Tooltip content={<CustomTooltip />} />
            <Line type="monotone" dataKey="meta_roas" stroke={COLOR_META} strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="cash_roas" stroke={COLOR_CASH} strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla últimos 7 días */}
      <div style={{ padding: '8px 18px 18px' }}>
        <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
          Últimos 7 días
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: '0.7rem', fontFamily: 'JetBrains Mono, monospace', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--bos-text-dim)', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>fecha</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>spend</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>gross</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>net</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>orders</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>meta</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>cash</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>gap</th>
              </tr>
            </thead>
            <tbody>
              {last7.map(s => (
                <tr key={s.date_et} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '6px 8px', color: 'var(--bos-text)' }}>{s.date_et?.slice(5)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{fmtMoney(s.meta_spend)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--bos-text)' }}>{fmtMoney(s.gross_sales)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: COLOR_CASH }}>{fmtMoney(s.net_after_fees)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--bos-text-muted)' }}>{s.orders_count || 0}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: COLOR_META }}>{fmtRoas(s.meta_roas)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: COLOR_CASH }}>{fmtRoas(s.cash_roas)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: gapColor(s.gap_pct) }}>
                    {s.gap_pct != null ? `${s.gap_pct > 0 ? '+' : ''}${s.gap_pct.toFixed(0)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color, tooltip }) {
  return (
    <div title={tooltip || ''}>
      <div style={{ fontSize: '1.05rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
      <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

const widgetStyle = {
  background: 'rgba(10, 14, 39, 0.5)',
  border: '1px solid rgba(20, 184, 166, 0.18)',
  borderRadius: 14,
  marginTop: 18,
  marginBottom: 18,
  overflow: 'hidden'
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 18px',
  borderBottom: '1px solid rgba(255,255,255,0.05)'
};
