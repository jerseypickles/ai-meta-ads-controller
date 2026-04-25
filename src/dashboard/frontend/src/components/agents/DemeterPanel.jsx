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

export default function DemeterPanel() {
  const [snapshots, setSnapshots] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [windowDays, setWindowDays] = useState(30);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    loadAll(windowDays);
    const t = setInterval(() => loadAll(windowDays), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [windowDays]);

  async function loadAll(days) {
    try {
      const [snapsR, sumR] = await Promise.all([
        api.get(`/api/demeter/snapshots?days=${days}`),
        api.get(`/api/demeter/summary?days=${days}`)
      ]);
      setSnapshots(snapsR.data?.snapshots || []);
      setSummary(sumR.data?.summary || null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRunNow() {
    if (!confirm(`¿Re-computar últimos ${windowDays} días? Toma ~${windowDays}s−${windowDays * 2}s.`)) return;
    setRunning(true);
    try {
      await api.post('/api/demeter/run-now', { days: Math.min(windowDays, 30) });
      await loadAll(windowDays);
    } catch (err) {
      alert(`Error: ${err.response?.data?.error || err.message}`);
    } finally {
      setRunning(false);
    }
  }

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
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
              Cash Reconciliation · Meta vs Shopify net
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(parseInt(e.target.value))}
              style={selectStyle}
            >
              <option value={7}>7d</option>
              <option value={14}>14d</option>
              <option value={30}>30d</option>
              <option value={60}>60d</option>
              <option value={90}>90d</option>
            </select>
            <button onClick={handleRunNow} disabled={running} style={runBtnStyle}>
              {running ? '⟳' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* KPI cards */}
        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <KpiCard
              label="Meta spend"
              value={fmtMoney(summary.total_meta_spend)}
              sub={`${summary.total_orders || 0} orders`}
              color="#94a3b8"
            />
            <KpiCard
              label="Cash net"
              value={fmtMoney(summary.total_net_after_fees)}
              sub={`gross ${fmtMoney(summary.total_gross_sales)}`}
              color={COLOR_CASH}
            />
            <KpiCard
              label="Cash ROAS"
              value={fmtRoas(summary.avg_cash_roas)}
              sub={`Meta ${fmtRoas(summary.avg_meta_roas)}`}
              color={COLOR_CASH}
            />
            <KpiCard
              label="Net profit"
              value={fmtMoney(summary.net_profit)}
              sub={`AOV ${fmtMoney(summary.avg_order_value)}`}
              color={summary.net_profit >= 0 ? COLOR_CASH : COLOR_GAP_BAD}
            />
          </div>
        )}
      </div>

      {/* CHART 1 — ROAS comparison */}
      <Section title="ROAS · Meta atribuído vs Cash real" subtitle={`${windowDays} días · target $3 ━ ━`}>
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
      <Section title={`Snapshots últimos ${snapshots.length} días`} subtitle="re-computado idempotente cada 00:05 ET (refunds retroactivos)">
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

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'rgba(17, 21, 51, 0.55)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 10,
      padding: '12px 14px'
    }}>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>
        {label}
      </div>
      {sub && (
        <div style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
          {sub}
        </div>
      )}
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
