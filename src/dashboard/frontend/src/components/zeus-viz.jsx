/**
 * Zeus visualizations — componentes inline que Zeus renderea en sus respuestas.
 * Refactorizado 2026-04-22: usa Recharts 3.x para visualizaciones profesionales
 * en vez de SVG/CSS custom. Mismo contrato JSON externo (Zeus emite los mismos
 * 4 tipos: sparkline / metric / compare / progress).
 *
 * Zeus emite bloques markdown tipo:
 *   ```zeus:compare
 *   {"items":[{"label":"Sin escalar","value":17},{"label":"Escalado","value":18}], "metric":"adsets"}
 *   ```
 * El parser detecta y convierte a componente React.
 */

import React from 'react';
import {
  LineChart, Line, Area, AreaChart,
  BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, Cell, LabelList,
  ReferenceLine
} from 'recharts';

// ═══════════════════════════════════════════════════════════════
// Theme helpers — colores consistentes con el dark theme del dashboard
// ═══════════════════════════════════════════════════════════════

const THEME = {
  text: '#e5e7eb',
  textMuted: '#9ca3af',
  textDim: '#6b7280',
  bgCard: 'rgba(17, 21, 51, 0.5)',
  bgTrack: 'rgba(17, 21, 51, 0.7)',
  border: 'rgba(255, 255, 255, 0.06)',
  blue: '#3b82f6',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  violet: '#8b5cf6',
  gray: '#6b7280'
};

// Colorear según tipo de métrica + valor
function colorForValue(value, metric) {
  const v = typeof value === 'number' ? value : 0;
  if (metric === 'roas') {
    if (v >= 3) return THEME.green;
    if (v >= 1.5) return THEME.amber;
    return THEME.red;
  }
  if (metric === 'pct' || metric === 'percent') {
    if (v >= 80) return THEME.green;
    if (v >= 50) return THEME.amber;
    return THEME.red;
  }
  // Default (count, raw numbers): blue scale
  return THEME.blue;
}

// Format de números según contexto
function formatValue(value, metric) {
  if (typeof value !== 'number') return value;
  if (metric === 'roas') return value.toFixed(2) + 'x';
  if (metric === 'pct' || metric === 'percent') return value.toFixed(1) + '%';
  if (metric === 'currency' || metric === '$') return '$' + Math.round(value).toLocaleString();
  // Default: smart formatting
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 100) return value.toFixed(0);
  return value.toFixed(2);
}

// Tooltip compartido
function CustomTooltip({ active, payload, metric }) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0];
  const value = item.value;
  const label = item.payload?.label ?? item.payload?.x ?? '';
  return (
    <div style={{
      background: 'rgba(0, 0, 0, 0.85)',
      border: `1px solid ${THEME.border}`,
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: '0.7rem',
      color: THEME.text,
      fontFamily: 'JetBrains Mono, Menlo, monospace',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)'
    }}>
      {label && <div style={{ color: THEME.textMuted, marginBottom: 2 }}>{label}</div>}
      <div style={{ fontWeight: 700 }}>{formatValue(value, metric)}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Sparkline — line chart compacto con gradient + tooltip
// ═══════════════════════════════════════════════════════════════

export function Sparkline({ data = [], label, trend, color, metric }) {
  if (!Array.isArray(data) || data.length < 2) return null;

  // Convert raw numbers to {x, value} for Recharts
  const chartData = data.map((v, i) => ({ x: i, value: v, label: `${i + 1}` }));

  const last = data[data.length - 1];
  const first = data[0];
  const inferredTrend = trend || (last > first ? 'up' : last < first ? 'down' : 'flat');
  const trendColor = inferredTrend === 'up' ? THEME.green : inferredTrend === 'down' ? THEME.red : THEME.gray;
  const lineColor = color || trendColor;
  const trendIcon = inferredTrend === 'up' ? '↗' : inferredTrend === 'down' ? '↘' : '→';

  const gradId = `zeus-spark-grad-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <div className="zeus-viz zeus-viz-sparkline">
      {label && <span className="zeus-viz-label">{label}</span>}
      <div className="zeus-viz-spark-chart">
        <ResponsiveContainer width="100%" height={36}>
          <AreaChart data={chartData} margin={{ top: 2, right: 4, bottom: 2, left: 4 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.4} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke={lineColor}
              strokeWidth={1.75}
              fill={`url(#${gradId})`}
              dot={false}
              activeDot={{ r: 3, fill: lineColor, stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1 }}
              isAnimationActive={true}
              animationDuration={400}
            />
            <Tooltip content={<CustomTooltip metric={metric} />} cursor={{ stroke: THEME.textDim, strokeWidth: 1, strokeDasharray: '2 2' }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <span className="zeus-viz-value" style={{ color: trendColor }}>
        {trendIcon} {formatValue(last, metric)}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MetricCard — card destacada con valor + delta
// ═══════════════════════════════════════════════════════════════

export function MetricCard({ label, value, delta, trend, unit, sparkline }) {
  const trendKind = trend || (typeof delta === 'number' ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : 'flat');
  const trendColor = trendKind === 'up' ? THEME.green : trendKind === 'down' ? THEME.red : THEME.textDim;
  const trendIcon = trendKind === 'up' ? '▲' : trendKind === 'down' ? '▼' : '•';

  return (
    <div className="zeus-viz zeus-viz-metric">
      <div className="zeus-viz-metric-label">{label}</div>
      <div className="zeus-viz-metric-row">
        <div className="zeus-viz-metric-value">
          {value}{unit ? <span className="zeus-viz-metric-unit">{unit}</span> : null}
        </div>
        {Array.isArray(sparkline) && sparkline.length >= 2 && (
          <div className="zeus-viz-metric-spark">
            <ResponsiveContainer width={60} height={20}>
              <LineChart data={sparkline.map((v, i) => ({ x: i, value: v }))}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={trendColor}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {delta !== undefined && delta !== null && (
        <div className="zeus-viz-metric-delta" style={{ color: trendColor }}>
          {trendIcon} {typeof delta === 'number' ? (delta > 0 ? '+' : '') + delta.toFixed(1) : delta}
          {unit ? unit : ''}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CompareBars — horizontal bar chart con tooltip + cell colors
// ═══════════════════════════════════════════════════════════════

export function CompareBars({ items = [], metric = 'roas' }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // Normalizar items (defensive — Zeus a veces emite formatos raros)
  const normalized = items
    .map(it => {
      if (typeof it === 'string') return null;  // descarta items que no son objects
      return {
        label: it.label || it.name || '',
        value: typeof it.value === 'number' ? it.value : parseFloat(it.value) || 0,
        color: it.color || colorForValue(it.value, metric)
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) return null;

  // Altura: 28px por barra, mínimo 100px
  const height = Math.max(100, normalized.length * 32);

  return (
    <div className="zeus-viz zeus-viz-compare">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={normalized}
          layout="vertical"
          margin={{ top: 4, right: 56, bottom: 4, left: 4 }}
        >
          <XAxis
            type="number"
            hide
            domain={[0, dataMax => dataMax * 1.05]}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={100}
            tick={{ fontSize: 11, fill: THEME.text, fontFamily: 'system-ui' }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            content={<CustomTooltip metric={metric} />}
            cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} animationDuration={500}>
            {normalized.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value) => formatValue(value, metric)}
              style={{ fontSize: 11, fontWeight: 700, fill: THEME.text, fontFamily: 'JetBrains Mono, Menlo, monospace' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ProgressGauge — bar de progreso con label + porcentaje + threshold
// ═══════════════════════════════════════════════════════════════

export function ProgressGauge({ value, max = 100, label, color, threshold }) {
  const v = typeof value === 'number' ? value : parseFloat(value) || 0;
  const m = typeof max === 'number' ? max : parseFloat(max) || 100;
  const pct = Math.min(100, Math.max(0, (v / m) * 100));
  const fillColor = color || (pct >= 80 ? THEME.green : pct >= 50 ? THEME.amber : THEME.blue);

  return (
    <div className="zeus-viz zeus-viz-progress">
      {label && <div className="zeus-viz-progress-label">{label}</div>}
      <div className="zeus-viz-progress-row">
        <div className="zeus-viz-progress-track">
          <div
            className="zeus-viz-progress-fill"
            style={{
              width: `${pct}%`,
              background: `linear-gradient(90deg, ${fillColor}cc 0%, ${fillColor} 100%)`,
              boxShadow: pct >= 100 ? `0 0 8px ${fillColor}aa` : 'none'
            }}
          />
          {threshold != null && threshold > 0 && threshold < m && (
            <div
              className="zeus-viz-progress-threshold"
              style={{ left: `${(threshold / m) * 100}%` }}
              title={`threshold: ${threshold}`}
            />
          )}
        </div>
        <div className="zeus-viz-progress-value">
          <span style={{ color: fillColor, fontWeight: 700 }}>{formatValue(v)}</span>
          <span className="zeus-viz-progress-max">/ {formatValue(m)}</span>
          <span className="zeus-viz-progress-pct" style={{ color: THEME.textDim }}> · {pct.toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Renderiza un bloque de visualización tipo zeus:* a partir de su spec JSON.
 * Retorna null si el tipo no se reconoce o el spec es inválido.
 */
export function renderVizBlock(type, spec) {
  if (!spec || typeof spec !== 'object') return null;
  try {
    if (type === 'sparkline') return <Sparkline {...spec} />;
    if (type === 'metric') return <MetricCard {...spec} />;
    if (type === 'compare') return <CompareBars {...spec} />;
    if (type === 'progress') return <ProgressGauge {...spec} />;
  } catch (err) {
    console.warn('[zeus-viz] render failed', type, err);
  }
  return null;
}
