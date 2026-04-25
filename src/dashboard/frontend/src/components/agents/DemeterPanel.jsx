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
  const [forecast, setForecast] = useState(null);
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
      const [snapsR, fcR] = await Promise.all([
        api.get('/api/demeter/snapshots?days=365'),
        api.get('/api/demeter/forecast').catch(() => ({ data: null }))
      ]);
      setAllSnapshots(snapsR.data?.snapshots || []);
      setForecast(fcR.data || null);
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
    const totalGross = sum('gross_sales');           // productos
    const totalShipping = sum('shipping');           // cobrado al cliente
    const totalTaxes = sum('taxes');                 // recolectado para gob.
    const totalSales = sum('total_sales');           // matchea Shopify UI
    const totalRefunds = sum('refunds');
    const totalDiscounts = sum('discounts');
    const totalFees = sum('shopify_fees_est');
    const totalCashToBank = sum('cash_to_bank');
    const totalNetForMerchant = sum('net_for_merchant');
    const totalOrders = sum('orders_count');
    const totalMetaValue = sum('meta_purchase_value');

    const cashRoas = totalSpend > 0 ? totalNetForMerchant / totalSpend : 0;
    const metaRoas = totalSpend > 0 ? totalMetaValue / totalSpend : 0;
    const gapPct = metaRoas > 0 ? ((metaRoas - cashRoas) / metaRoas) * 100 : 0;

    return {
      total_meta_spend: +totalSpend.toFixed(2),
      total_meta_value: +totalMetaValue.toFixed(2),
      total_gross_sales: +totalGross.toFixed(2),
      total_shipping: +totalShipping.toFixed(2),
      total_taxes: +totalTaxes.toFixed(2),
      total_sales: +totalSales.toFixed(2),
      total_discounts: +totalDiscounts.toFixed(2),
      total_refunds: +totalRefunds.toFixed(2),
      total_fees: +totalFees.toFixed(2),
      total_cash_to_bank: +totalCashToBank.toFixed(2),
      total_net_for_merchant: +totalNetForMerchant.toFixed(2),
      total_orders: totalOrders,
      avg_cash_roas: +cashRoas.toFixed(3),
      avg_meta_roas: +metaRoas.toFixed(3),
      avg_gap_pct: +gapPct.toFixed(1),
      avg_order_value: totalOrders > 0 ? +(totalSales / totalOrders).toFixed(2) : 0,
      net_profit: +(totalNetForMerchant - totalSpend).toFixed(2),
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
    <div style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
      {/* HERO */}
      <div style={{
        background: 'radial-gradient(ellipse at top left, rgba(20, 184, 166, 0.14) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(52, 211, 153, 0.08) 0%, transparent 50%)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        border: '1px solid rgba(20, 184, 166, 0.22)',
        minWidth: 0,
        overflow: 'hidden'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring' }}
            style={{
              width: 56, height: 56, borderRadius: '50%',
              background: `${DEMETER_COLOR}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${DEMETER_COLOR}40`,
              filter: `drop-shadow(0 0 20px ${DEMETER_COLOR})`,
              fontSize: '1.7rem',
              flexShrink: 0
            }}
          >
            ✿
          </motion.div>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: DEMETER_COLOR, letterSpacing: '0.02em' }}>
              DEMETER
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)' }}>
              Reconciliación de caja
            </div>
          </div>
          <button onClick={handleRunNow} disabled={running} style={runBtnStyle}>
            {running ? '⟳' : '↻ Refresh'}
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

        {/* KPI cards principales — 4 grandes con labels en español llano */}
        {summary ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
            marginBottom: 14
          }}>
            <KpiCard
              label="Gasto Meta Ads"
              value={fmtMoney(summary.total_meta_spend)}
              sub={`${summary.days_count} días`}
              color="#94a3b8"
              tooltip="Lo que pagaste a Meta por anuncios."
            />
            <KpiCard
              label="Entró al banco"
              value={fmtMoney(summary.total_cash_to_bank)}
              sub={`${summary.total_orders.toLocaleString()} órdenes`}
              color={COLOR_CASH}
              tooltip="Total ventas Shopify menos refunds menos fees de Shopify. Es lo que efectivamente recibiste en tu cuenta bancaria. Incluye tax que vas a pagar al gobierno."
            />
            <KpiCard
              label="Tuyo real"
              value={fmtMoney(summary.total_net_for_merchant)}
              sub={`menos tax al gob.`}
              color={COLOR_CASH}
              big
              tooltip="Cash al banco menos tax que recolectaste para el gobierno. Es lo que es realmente tuyo, antes de descontar COGS y otros costos del negocio."
            />
            <KpiCard
              label="ROAS real"
              value={fmtRoas(summary.avg_cash_roas)}
              sub={`Meta dice ${fmtRoas(summary.avg_meta_roas)}`}
              color={COLOR_CASH}
              big
              tooltip="Por cada $1 que gastaste en Meta Ads, $X.XX entró a tu bolsillo (post-tax). Esta es la métrica real, no la que reporta Meta."
            />
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--bos-text-muted)', fontSize: '0.85rem' }}>
            No hay snapshots para este período.
          </div>
        )}

        {/* Acordeón "Cómo se calcula" — colapsado por default */}
        {summary && summary.days_count > 0 && (
          <CalculationBreakdown summary={summary} />
        )}
      </div>

      {/* FORECAST — solo cuando tab es 'this_month' y mes está en curso */}
      {activeTab === 'this_month' && forecast?.month_status === 'in_progress' && forecast?.projection && (
        <ForecastCard forecast={forecast} />
      )}

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

function KpiCard({ label, value, sub, color, big, tooltip }) {
  return (
    <div
      title={tooltip || ''}
      style={{
      background: 'rgba(17, 21, 51, 0.55)',
      border: `1px solid ${big ? color + '33' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 10,
      padding: big ? '14px 16px' : '12px 14px',
      minWidth: 0,
      overflow: 'hidden',
      cursor: tooltip ? 'help' : 'default'
    }}>
      <div style={{
        fontSize: '0.6rem',
        color: 'var(--bos-text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 6,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'flex',
        alignItems: 'center',
        gap: 4
      }}>
        {label}
        {tooltip && <span style={{ fontSize: '0.6rem', opacity: 0.5 }}>ⓘ</span>}
      </div>
      <div style={{
        fontSize: big ? '1.5rem' : '1.25rem',
        fontWeight: 700,
        color,
        fontFamily: 'JetBrains Mono, monospace',
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}>
        {value}
      </div>
      {sub && (
        <div style={{
          fontSize: '0.66rem',
          color: 'var(--bos-text-muted)',
          marginTop: 5,
          fontFamily: 'JetBrains Mono, monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color = 'var(--bos-text)' }) {
  return (
    <div style={{ minWidth: 0, overflow: 'hidden' }}>
      <div style={{
        fontSize: '0.56rem',
        color: 'var(--bos-text-dim)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 2,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '0.82rem',
        fontWeight: 600,
        color,
        fontFamily: 'JetBrains Mono, monospace',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }}>
        {value}
      </div>
    </div>
  );
}

// ─── CALCULATION BREAKDOWN — acordeón "Cómo se calcula" ─────────────────

function CalculationBreakdown({ summary }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: 'rgba(17, 21, 51, 0.4)',
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.05)',
      overflow: 'hidden'
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'transparent',
          border: 'none',
          color: 'var(--bos-text-muted)',
          fontSize: '0.74rem',
          fontWeight: 600,
          letterSpacing: '0.04em',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span>{expanded ? '▾' : '▸'} Cómo llegamos a estos números</span>
        <span style={{ fontSize: '0.66rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
          {expanded ? 'click para ocultar' : 'click para ver desglose'}
        </span>
      </button>

      {expanded && (
        <div style={{
          padding: '16px 20px 20px',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          fontSize: '0.82rem',
          fontFamily: 'JetBrains Mono, monospace',
          lineHeight: 2
        }}>
          {/* Cascada plana — empieza arriba con lo que entró, va restando hacia abajo */}

          <CascadeLine label="Total ventas Shopify" value={summary.total_sales} bold note="lo que cobraste en Shopify" />

          <CascadeLine label="− Shipping cobrado" value={-summary.total_shipping} note="va al carrier (USPS/UPS), no es tuyo" />

          <CascadeLine label="− Tax cobrado" value={-summary.total_taxes} note="va al gobierno, no es tuyo" />

          <CascadeLine label="− Refunds" value={-summary.total_refunds} note="devoluciones procesadas" />

          <CascadeLine label="− Shopify fees" value={-summary.total_fees} note="2.9% + $0.30 por orden" />

          <CascadeLine label="− Gasto Meta Ads" value={-summary.total_meta_spend} note="lo que pagaste a Meta" />

          <CascadeLine
            label="= PROFIT pre-COGS"
            value={summary.net_profit}
            bold big highlight
            color={summary.net_profit >= 0 ? COLOR_CASH : COLOR_GAP_BAD}
            note="lo que te queda antes de costos del producto"
          />

          <div style={{
            marginTop: 16, padding: '10px 14px',
            background: 'rgba(20, 184, 166, 0.06)',
            borderRadius: 6,
            fontSize: '0.74rem',
            color: 'var(--bos-text-muted)',
            lineHeight: 1.6,
            fontFamily: '-apple-system, system-ui, sans-serif'
          }}>
            <strong style={{ color: DEMETER_COLOR }}>Falta restar (no tracked aquí):</strong>
            {' '}COGS del producto, costos operativos (rent, salarios, software). El número de arriba
            es <strong>profit pre-COGS</strong>, no profit final.
          </div>
        </div>
      )}
    </div>
  );
}

function CascadeLine({ label, value, note, bold, big, highlight, color }) {
  const negative = value < 0;
  const display = `${negative ? '−' : ''}${fmtMoney(Math.abs(value))}`;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 16,
      padding: highlight ? '12px 14px' : '4px 0',
      marginTop: highlight ? 12 : 0,
      borderTop: highlight ? `1px solid ${color || COLOR_CASH}88` : 'none',
      borderRadius: highlight ? 6 : 0,
      background: highlight ? `${color || COLOR_CASH}11` : 'transparent'
    }}>
      <div style={{
        fontSize: big ? '0.95rem' : '0.86rem',
        fontWeight: bold ? 700 : 500,
        color: bold ? (color || 'var(--bos-text)') : 'var(--bos-text-muted)',
        fontFamily: '-apple-system, system-ui, sans-serif',
        flex: '1 1 auto',
        minWidth: 0
      }}>
        <span>{label}</span>
        {note && (
          <span style={{
            display: 'block',
            fontSize: '0.7rem',
            color: 'var(--bos-text-dim)',
            fontStyle: 'italic',
            marginTop: -2,
            marginLeft: bold ? 0 : 14
          }}>
            {note}
          </span>
        )}
      </div>
      <div style={{
        fontSize: big ? '1.15rem' : '0.92rem',
        fontWeight: bold ? 700 : 600,
        color: color || (negative ? '#94a3b8' : 'var(--bos-text)'),
        fontFamily: 'JetBrains Mono, monospace',
        flexShrink: 0
      }}>
        {display}
      </div>
    </div>
  );
}

// ─── FORECAST CARD ────────────────────────────────────────────────────────

function ForecastCard({ forecast }) {
  const { mtd, run_rate, projection, confidence, month_label, month_total_days } = forecast;
  const daysElapsed = mtd.days_with_data;
  const progressPct = (daysElapsed / month_total_days) * 100;

  const confidenceLabels = {
    high: { label: 'alta', color: COLOR_CASH, hint: 'run-rate consistente últimos 7d' },
    medium: { label: 'media', color: COLOR_GAP_WARN, hint: 'algo de variabilidad en el run-rate' },
    low: { label: 'baja', color: COLOR_GAP_BAD, hint: 'pocos días o run-rate muy volátil' }
  };
  const conf = confidenceLabels[confidence] || confidenceLabels.low;

  // Delta projection vs MTD scaled (lo que iría si no cambia nada)
  const projVsActual = (key) => {
    const proj = projection[`projected_${key}`];
    const actual = mtd[key === 'meta_spend' ? 'meta_spend' : key === 'net_after_fees' ? 'net_after_fees' : key];
    const linearScale = actual * (month_total_days / daysElapsed);
    const diff = proj - linearScale;
    return diff;
  };

  return (
    <div style={{
      marginBottom: 20,
      background: `linear-gradient(135deg, ${DEMETER_COLOR}11 0%, rgba(96, 165, 250, 0.05) 100%)`,
      border: `1px solid ${DEMETER_COLOR}33`,
      borderRadius: 14,
      padding: '18px 22px',
      minWidth: 0,
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: '0.66rem', color: DEMETER_COLOR, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
            📊 Proyección al cierre · {month_label}
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--bos-text-muted)', marginTop: 4 }}>
            Run-rate últimos {run_rate.days} días · {projection.days_remaining} días restantes
          </div>
        </div>
        <div style={{
          fontSize: '0.66rem',
          padding: '4px 10px',
          borderRadius: 6,
          background: `${conf.color}22`,
          border: `1px solid ${conf.color}55`,
          color: conf.color,
          fontWeight: 600,
          letterSpacing: '0.05em'
        }} title={conf.hint}>
          confianza {conf.label}
        </div>
      </div>

      {/* Progress bar mes */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          height: 6, background: 'rgba(17, 21, 51, 0.6)', borderRadius: 3, overflow: 'hidden',
          position: 'relative'
        }}>
          <div style={{
            height: '100%', width: `${progressPct}%`,
            background: `linear-gradient(90deg, ${DEMETER_COLOR}, ${COLOR_CASH})`,
            transition: 'width 0.4s'
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.62rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
          <span>día {daysElapsed}/{month_total_days}</span>
          <span>{progressPct.toFixed(0)}% completo</span>
        </div>
      </div>

      {/* Stats: actual MTD → proyección cierre */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 12,
        marginBottom: 12
      }}>
        <ForecastStat label="Spend mes" actual={mtd.meta_spend} projected={projection.projected_meta_spend} />
        <ForecastStat label="Cash neto mes" actual={mtd.net_after_fees} projected={projection.projected_net_after_fees} color={COLOR_CASH} />
        <ForecastStat label="Profit mes" actual={mtd.profit} projected={projection.projected_profit} color={projection.projected_profit >= 0 ? COLOR_CASH : COLOR_GAP_BAD} />
        <ForecastStat label="Cash ROAS mes" actual={mtd.cash_roas} projected={projection.projected_cash_roas} format="roas" color={COLOR_CASH} />
        <ForecastStat label="Órdenes mes" actual={mtd.orders} projected={projection.projected_orders} format="int" />
      </div>

      <div style={{
        fontSize: '0.68rem',
        color: 'var(--bos-text-muted)',
        lineHeight: 1.6,
        paddingTop: 10,
        borderTop: '1px solid rgba(255,255,255,0.05)'
      }}>
        Run-rate diario: <span style={{ color: 'var(--bos-text)', fontFamily: 'JetBrains Mono, monospace' }}>${Math.round(run_rate.avg_meta_spend).toLocaleString()}/d spend</span>
        {' · '}
        <span style={{ color: COLOR_CASH, fontFamily: 'JetBrains Mono, monospace' }}>${Math.round(run_rate.avg_net_after_fees).toLocaleString()}/d cash net</span>
        {' · '}
        cash ROAS <span style={{ color: COLOR_CASH, fontFamily: 'JetBrains Mono, monospace' }}>{run_rate.avg_cash_roas.toFixed(2)}x</span>
      </div>
    </div>
  );
}

function ForecastStat({ label, actual, projected, format = 'money', color = 'var(--bos-text)' }) {
  const fmt = (v) => {
    if (format === 'roas') return fmtRoas(v);
    if (format === 'int') return Math.round(v).toLocaleString();
    return fmtMoney(v);
  };
  return (
    <div style={{ minWidth: 0, overflow: 'hidden' }}>
      <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.74rem', color: 'var(--bos-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          {fmt(actual)}
        </div>
        <span style={{ fontSize: '0.68rem', color: 'var(--bos-text-dim)' }}>→</span>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>
          {fmt(projected)}
        </div>
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
      padding: '16px 20px',
      minWidth: 0,
      overflow: 'hidden'
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
