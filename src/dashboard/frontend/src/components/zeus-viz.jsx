/**
 * Zeus visualizations — componentes SVG inline que Zeus renderea en sus respuestas.
 * Zeus emite bloques markdown tipo:
 *   ```zeus:sparkline
 *   {"data":[3.2,3.5,3.1,2.8,2.5], "label":"ROAS 7d"}
 *   ```
 * El parser detecta estos y los convierte en componentes React.
 */

import React from 'react';

export function Sparkline({ data = [], label, trend, color = '#3b82f6', height = 32 }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const width = Math.max(80, data.length * 10);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const last = data[data.length - 1];
  const first = data[0];
  const inferredTrend = trend || (last > first ? 'up' : last < first ? 'down' : 'flat');
  const trendColor = inferredTrend === 'up' ? '#10b981' : inferredTrend === 'down' ? '#ef4444' : '#6b7280';
  const trendIcon = inferredTrend === 'up' ? '↗' : inferredTrend === 'down' ? '↘' : '→';

  // Últimos valor endpoint circle
  const lastX = width;
  const lastY = height - ((last - min) / range) * (height - 4) - 2;

  return (
    <div className="zeus-viz zeus-viz-sparkline">
      {label && <span className="zeus-viz-label">{label}</span>}
      <svg width={width} height={height} className="zeus-viz-svg">
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
      </svg>
      <span className="zeus-viz-value" style={{ color: trendColor }}>
        {trendIcon} {typeof last === 'number' ? last.toFixed(last > 100 ? 0 : 2) : last}
      </span>
    </div>
  );
}

export function MetricCard({ label, value, delta, trend, unit }) {
  const trendKind = trend || (typeof delta === 'number' ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : 'flat');
  const trendColor = trendKind === 'up' ? '#10b981' : trendKind === 'down' ? '#ef4444' : '#9ca3af';
  const trendIcon = trendKind === 'up' ? '▲' : trendKind === 'down' ? '▼' : '•';

  return (
    <div className="zeus-viz zeus-viz-metric">
      <div className="zeus-viz-metric-label">{label}</div>
      <div className="zeus-viz-metric-value">
        {value}{unit ? <span className="zeus-viz-metric-unit">{unit}</span> : null}
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

export function CompareBars({ items = [], metric = 'roas' }) {
  if (!items.length) return null;
  const max = Math.max(...items.map(i => Math.abs(i.value || 0))) || 1;

  return (
    <div className="zeus-viz zeus-viz-compare">
      {items.map((it, i) => {
        const pct = (Math.abs(it.value || 0) / max) * 100;
        const color = it.color || (it.value >= 3 ? '#10b981' : it.value >= 1.5 ? '#f59e0b' : '#ef4444');
        return (
          <div key={i} className="zeus-viz-compare-row">
            <span className="zeus-viz-compare-label">{it.label}</span>
            <div className="zeus-viz-compare-bar-wrap">
              <div
                className="zeus-viz-compare-bar"
                style={{ width: `${pct}%`, background: color }}
              />
            </div>
            <span className="zeus-viz-compare-value" style={{ color }}>
              {typeof it.value === 'number' ? it.value.toFixed(2) : it.value}
              {metric === 'roas' ? 'x' : metric === 'pct' ? '%' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ProgressGauge({ value, max = 100, label, color = '#3b82f6' }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="zeus-viz zeus-viz-progress">
      {label && <span className="zeus-viz-label">{label}</span>}
      <div className="zeus-viz-progress-track">
        <div className="zeus-viz-progress-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="zeus-viz-progress-value">{value}/{max}</span>
    </div>
  );
}

/**
 * Renderiza un bloque de visualización tipo zeus:* a partir de su spec JSON.
 * Retorna null si el tipo no se reconoce.
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
