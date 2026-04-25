import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { LineChart, Line, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine, Legend } from 'recharts';
import api from '../../api';

const DEMETER_COLOR = '#14b8a6';
const COLOR_META = '#60a5fa';
const COLOR_CASH = '#34d399';
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

function fmtMoney(n, full = false) {
  if (n == null) return '—';
  if (full) return `$${Math.round(n).toLocaleString()}`;
  if (Math.abs(n) >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${Math.round(n)}`;
}

function fmtRoas(n) {
  if (n == null || n === 0) return '—';
  return `${n.toFixed(2)}x`;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{
      background: 'rgba(11, 17, 32, 0.95)',
      border: `1px solid ${DEMETER_COLOR}55`,
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: '0.74rem',
      fontFamily: 'JetBrains Mono, monospace',
      backdropFilter: 'blur(8px)'
    }}>
      <div style={{ color: '#e2e8f0', marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: {typeof p.value === 'number' && p.dataKey?.includes('roas') ? fmtRoas(p.value) : fmtMoney(p.value, true)}
        </div>
      ))}
    </div>
  );
}

// ─── Helpers de rango por tab ────────────────────────────────────────────

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/** Retorna { from, to, label } según el tab. from/to en YYYY-MM-DD ET. */
function rangeForTab(tabId) {
  const today = todayInET(); // 'YYYY-MM-DD'
  const [y, m] = today.split('-').map(Number);

  if (tabId === 'this_month') {
    return {
      from: `${y}-${String(m).padStart(2, '0')}-01`,
      to: today,
      label: `${MONTH_NAMES[m - 1]} ${y}`,
      isCurrent: true
    };
  }
  if (tabId === 'last_month') {
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const lastDay = new Date(prev.y, prev.m, 0).getDate(); // último día del mes prev
    return {
      from: `${prev.y}-${String(prev.m).padStart(2, '0')}-01`,
      to: `${prev.y}-${String(prev.m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      label: `${MONTH_NAMES[prev.m - 1]} ${prev.y}`
    };
  }
  if (tabId === 'rolling_30') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 29);
    return {
      from: d.toISOString().slice(0, 10),
      to: today,
      label: 'Últimos 30 días'
    };
  }
  if (tabId === 'rolling_90') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 89);
    return {
      from: d.toISOString().slice(0, 10),
      to: today,
      label: 'Últimos 90 días'
    };
  }
  // 'all'
  return { from: '0000-01-01', to: '9999-12-31', label: 'Todo el histórico' };
}

const TABS = [
  { id: 'this_month', label: 'Este Mes' },
  { id: 'last_month', label: 'Mes Pasado' },
  { id: 'rolling_30', label: 'Últimos 30d' },
  { id: 'rolling_90', label: 'Últimos 90d' },
  { id: 'all', label: 'Todo' }
];

export default function DemeterPanel() {
  const [allSnapshots, setAllSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('this_month');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  async function loadAll() {
    try {
      // Pedimos histórico amplio (365d) y filtramos por tab client-side.
      // Si hay menos snapshots, retorna lo que haya.
      const r = await api.get('/api/demeter/snapshots?days=365');
      setAllSnapshots(r.data?.snapshots || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRunNow() {
    if (!confirm(`¿Re-computar últimos 30 días? Toma ~30-60s.`)) return;
    setRunning(true);
    try {
      await api.post('/api/demeter/run-now', { days: 30 });
      await loadAll();
    } catch (err) {
      alert(`Error: ${err.response?.data?.error || err.message}`);
    } finally {
      setRunning(false);
    }
  }

  // ─── Filter por tab + summary client-side ─────────────────────────────
  const range = rangeForTab(activeTab);
  const snapshots = useMemo(() => {
    return allSnapshots.filter(s =>
      s.date_et >= range.from && s.date_et <= range.to
    );
  }, [allSnapshots, range.from, range.to]);

  const summary = useMemo(() => {
    if (snapshots.length === 0) return null;
    const sum = (k) => snapshots.reduce((a, s) => a + (s[k] || 0), 0);
    const totalSpend = sum('meta_spend');
    const totalNet = sum('net_after_fees');
    const totalGross = sum('gross_sales');
    const totalRefunds = sum('refunds');
    const totalDiscounts = sum('discounts');
    const totalFees = sum('shopify_fees_est');
    const totalOrders = sum('orders_count');
    const totalMetaValue = sum('meta_purchase_value');

    const cashRoas = totalSpend > 0 ? totalNet / totalSpend : 0;
    const metaRoas = totalSpend > 0 ? totalMetaValue / totalSpend : 0;
    const gapPct = metaRoas > 0 ? ((metaRoas - cashRoas) / metaRoas) * 100 : 0;

    return {
      total_meta_spend: +totalSpend.toFixed(2),
      total_meta_value: +totalMetaValue.toFixed(2),
      total_gross_sales: +totalGross.toFixed(2),
      total_discounts: +totalDiscounts.toFixed(2),
      total_refunds: +totalRefunds.toFixed(2),
      total_fees: +totalFees.toFixed(2),
      total_net_after_fees: +totalNet.toFixed(2),
      total_orders: totalOrders,
      avg_cash_roas: +cashRoas.toFixed(3),
      avg_meta_roas: +metaRoas.toFixed(3),
      avg_gap_pct: +gapPct.toFixed(1),
      avg_order_value: totalOrders > 0 ? +(totalGross / totalOrders).toFixed(2) : 0,
      net_profit: +(totalNet - totalSpend).toFixed(2),
      days_count: snapshots.length
    };
  }, [snapshots]);

  const chartData = useMemo(() => {
    return [...snapshots].reverse().map(s => ({
      date: s.date_et?.slice(5) || '',
      meta_roas: s.meta_roas || 0,
      cash_roas: s.cash_roas || 0,
      meta_spend: s.meta_spend || 0,
      net_after_fees: s.net_after_fees || 0,
      gap_pct: s.gap_pct || 0
    }));
  }, [snapshots]);

  if (loading && snapshots.length === 0) {
    return <div className="bos-loading">Sintetizando inteligencia de Demeter...</div>;
  }

  if (error && snapshots.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#f87171' }}>
        <div style={{ fontSize: '1.1rem', marginBottom: 8 }}>⚠ Error</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--bos-text-muted)', marginBottom: 16 }}>{error}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--bos-text-muted)' }}>
          Verificá SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_TOKEN en env de Render.
        </div>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--bos-text-muted)' }}>
        <div style={{ fontSize: '1.1rem', marginBottom: 12 }}>Sin snapshots aún</div>
        <div style={{ fontSize: '0.8rem', marginBottom: 16, lineHeight: 1.6 }}>
          Demeter necesita inicializarse. En Render Shell:
        </div>
        <pre style={{ display: 'inline-block', padding: '10px 16px', background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: '0.74rem', color: COLOR_CASH, textAlign: 'left' }}>
          node scripts/demeter-backfill.js --days 60
        </pre>
        <div style={{ marginTop: 16 }}>
          <button onClick={handleRunNow} disabled={running} style={runBtnStyle}>
            {running ? 'Computando...' : 'Run now (30 días)'}
          </button>
        </div>
      </div>
    );
  }

  const today = snapshots[0];

  return (
    <div>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at top left, rgba(20, 184, 166, 0.14) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(52, 211, 153, 0.08) 0%, transparent 50%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        border: '1px solid rgba(20, 184, 166, 0.22)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring' }}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `${DEMETER_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${DEMETER_COLOR}40`,
              filter: `drop-shadow(0 0 20px ${DEMETER_COLOR})`,
              fontSize: '2rem'
            }}
          >
            ✿
          </motion.div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: DEMETER_COLOR, letterSpacing: '0.02em' }}>
              DEMETER
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--bos-text-muted)' }}>
              Reconciliación de caja — Meta spend vs Shopify net
            </div>
          </div>
          <button onClick={handleRunNow} disabled={running} style={runBtnStyle}>
            {running ? '⟳ computando...' : '↻ Refresh data'}
          </button>
        </div>

        {/* TABS */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer',
                border: activeTab === t.id ? `1px solid ${DEMETER_COLOR}` : '1px solid rgba(255,255,255,0.08)',
                background: activeTab === t.id ? `${DEMETER_COLOR}22` : 'rgba(17, 21, 51, 0.5)',
                color: activeTab === t.id ? DEMETER_COLOR : 'var(--bos-text-muted)',
                transition: 'all 0.15s'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Range label */}
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 12,
          fontSize: '0.78rem', color: 'var(--bos-text-muted)', marginBottom: 14
        }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--bos-text)' }}>
            {range.label}
          </span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem' }}>
            {summary?.days_count || 0} días con data
            {range.isCurrent && <span style={{ color: DEMETER_COLOR, marginLeft: 6 }}>· en curso</span>}
          </span>
        </div>

        {/* KPI cards principales — 4 grandes */}
        {summary ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 }}>
            <KpiCard
              label="Gasto Meta Ads"
              value={fmtMoney(summary.total_meta_spend, true)}
              sub={`${summary.days_count} días`}
              color="#94a3b8"
            />
            <KpiCard
              label="Cash neto (post-fees)"
              value={fmtMoney(summary.total_net_after_fees, true)}
              sub={`${summary.total_orders.toLocaleString()} órdenes`}
              color={COLOR_CASH}
            />
            <KpiCard
              label="Cash ROAS real"
              value={fmtRoas(summary.avg_cash_roas)}
              sub={`Meta dice ${fmtRoas(summary.avg_meta_roas)}`}
              color={COLOR_CASH}
              big
            />
            <KpiCard
              label="Profit (cash − ad spend)"
              value={fmtMoney(summary.net_profit, true)}
              sub={`AOV ${fmtMoney(summary.avg_order_value)}`}
              color={summary.net_profit >= 0 ? COLOR_CASH : COLOR_GAP_BAD}
              big
            />
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--bos-text-muted)', fontSize: '0.85rem' }}>
            No hay snapshots para este período.
          </div>
        )}

        {/* Mini stats row — desglose Shopify */}
        {summary && summary.days_count > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10,
            padding: '12px 14px',
            background: 'rgba(17, 21, 51, 0.4)',
            borderRadius: 10,
            fontSize: '0.74rem'
          }}>
            <MiniStat label="Gross sales" value={fmtMoney(summary.total_gross_sales, true)} />
            <MiniStat label="Discounts" value={`-${fmtMoney(summary.total_discounts)}`} color="#94a3b8" />
            <MiniStat label="Refunds" value={`-${fmtMoney(summary.total_refunds)}`} color={summary.total_refunds > 0 ? COLOR_GAP_BAD : 'var(--bos-text-muted)'} />
            <MiniStat label="Shopify fees" value={`-${fmtMoney(summary.total_fees)}`} color="#94a3b8" />
            <MiniStat label="Gap atribución" value={`${summary.avg_gap_pct.toFixed(1)}%`} color={gapColor(summary.avg_gap_pct)} />
          </div>
        )}
      </div>

      {/* CHART 1 — ROAS comparison */}
      <Section title="ROAS · Meta atribuído vs Cash real" subtitle={`${range.label} · línea punteada = target ROAS 3x`}>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} interval={Math.max(0, Math.floor(chartData.length / 12) - 1)} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
              <ReferenceLine y={3} stroke="#475569" strokeDasharray="3 4" strokeWidth={0.8} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: '0.72rem' }} />
              <Line type="monotone" dataKey="meta_roas" name="Meta ROAS" stroke={COLOR_META} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="cash_roas" name="Cash ROAS" stroke={COLOR_CASH} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* CHART 2 — Spend vs Net */}
      <Section title="Spend vs Net (post fees)" subtitle="cuánto gastaste vs cuánto realmente entró a la cuenta">
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} interval={Math.max(0, Math.floor(chartData.length / 12) - 1)} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: '0.72rem' }} />
              <Bar dataKey="meta_spend" name="Meta spend" fill={COLOR_META} opacity={0.7} />
              <Bar dataKey="net_after_fees" name="Cash net" fill={COLOR_CASH} opacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* TABLA full */}
      <Section title={`Detalle día por día · ${snapshots.length} ${snapshots.length === 1 ? 'día' : 'días'}`} subtitle="re-computado idempotente cada 00:05 ET (captura refunds retroactivos)">
        <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
          <table style={{ width: '100%', fontSize: '0.74rem', fontFamily: 'JetBrains Mono, monospace', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'rgba(10, 14, 39, 0.95)', backdropFilter: 'blur(4px)' }}>
              <tr style={{ color: 'var(--bos-text-dim)', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <th style={thStyle}>fecha</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>spend</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>gross</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>discounts</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>refunds</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>fees</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>net</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>orders</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>meta</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>cash</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>gap</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map(s => (
                <tr key={s.date_et} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ ...tdStyle, color: 'var(--bos-text)' }}>{s.date_et}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#94a3b8' }}>{fmtMoney(s.meta_spend)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--bos-text)' }}>{fmtMoney(s.gross_sales)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--bos-text-muted)' }}>{fmtMoney(s.discounts)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: s.refunds > 0 ? COLOR_GAP_BAD : 'var(--bos-text-dim)' }}>
                    {s.refunds > 0 ? fmtMoney(s.refunds) : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--bos-text-muted)' }}>{fmtMoney(s.shopify_fees_est)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: COLOR_CASH, fontWeight: 600 }}>{fmtMoney(s.net_after_fees)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--bos-text-muted)' }}>{s.orders_count || 0}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: COLOR_META }}>{fmtRoas(s.meta_roas)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: COLOR_CASH, fontWeight: 600 }}>{fmtRoas(s.cash_roas)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: gapColor(s.gap_pct) }}>
                    {s.gap_pct != null ? `${s.gap_pct > 0 ? '+' : ''}${s.gap_pct.toFixed(0)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Footer info */}
      <div style={{
        marginTop: 16, padding: '12px 16px',
        background: 'rgba(20, 184, 166, 0.05)',
        border: '1px solid rgba(20, 184, 166, 0.1)',
        borderRadius: 10,
        fontSize: '0.72rem', color: 'var(--bos-text-muted)', lineHeight: 1.6
      }}>
        <strong style={{ color: DEMETER_COLOR }}>Cómo leer el gap:</strong>
        {' '}gap &gt; 0 = Meta sobre-atribuye (típico, view-through attribution + cross-channel overlap).
        {' '}gap &lt; 15% es atribución consistente. 15-30% warning. ≥30% = investigar.
        {' '}Net incluye Shopify fees est. (2.9% + $0.30/order) — no incluye shipping costs ni COGS.
        {' '}Refunds retroactivos: el cron re-computa últimos 7 días cada 00:05 ET.
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, color, big }) {
  return (
    <div style={{
      background: 'rgba(17, 21, 51, 0.55)',
      border: `1px solid ${big ? color + '33' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 10,
      padding: big ? '16px 18px' : '14px 16px'
    }}>
      <div style={{ fontSize: '0.62rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: big ? '1.9rem' : '1.5rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted)', marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color = 'var(--bos-text)' }) {
  return (
    <div>
      <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: '0.86rem', fontWeight: 600, color, fontFamily: 'JetBrains Mono, monospace' }}>
        {value}
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div style={{
      marginBottom: 20,
      background: 'rgba(10, 14, 39, 0.4)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 12,
      padding: '16px 20px'
    }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--bos-text)' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted)', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
      {children}
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '8px 10px', whiteSpace: 'nowrap' };
const tdStyle = { padding: '7px 10px', whiteSpace: 'nowrap' };

const selectStyle = {
  background: 'rgba(17, 21, 51, 0.7)',
  border: '1px solid rgba(20, 184, 166, 0.3)',
  color: 'var(--bos-text)',
  padding: '6px 10px',
  borderRadius: 6,
  fontSize: '0.74rem',
  cursor: 'pointer'
};

const runBtnStyle = {
  background: 'rgba(20, 184, 166, 0.15)',
  border: '1px solid rgba(20, 184, 166, 0.4)',
  color: DEMETER_COLOR,
  padding: '6px 14px',
  borderRadius: 6,
  fontSize: '0.74rem',
  fontWeight: 600,
  cursor: 'pointer'
};
