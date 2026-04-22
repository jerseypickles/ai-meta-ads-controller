/**
 * EntityListTable — lista densa de entidades (adsets, ads, tests, campaigns)
 * renderizada por Zeus cuando emite un bloque ```zeus:entity-list.
 *
 * No es una tabla cuadriculada — cada row es una card visual con jerarquía:
 *   nombre + badge (arriba) · métricas densas (medio) · sparkline (abajo)
 *
 * Usa TanStack Table v8 solo como engine de sort (headless). El rendering
 * es custom para conseguir el look de Linear/Vercel/Stripe dashboards.
 *
 * Contrato del spec JSON:
 * {
 *   "entity_type": "adset" | "ad" | "test" | "campaign",
 *   "sort": "roas_7d" | "spend_7d" | "purchases" | "cpa",   // default
 *   "rows": [
 *     {
 *       "id": "1202...",
 *       "name": "Snack Obsessed",
 *       "roas_7d": 0.42,
 *       "spend_7d": 138,
 *       "revenue_7d": 58,        // opcional
 *       "purchases": 1,
 *       "cpa": 84,                // opcional; si falta, se calcula
 *       "frequency": 1.06,        // opcional
 *       "ctr": 0.92,              // opcional
 *       "stage": "fail" | "learn" | "success" | "testing",
 *       "status": "ACTIVE" | "PAUSED",
 *       "sparkline": [0, 0.1, 0.3, ...],   // opcional, ROAS 14d
 *       "note": "alta saturación",          // opcional, label chico
 *       "warning": true                     // opcional, muestra ⚠
 *     }
 *   ]
 * }
 */

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper
} from '@tanstack/react-table';

const STAGE_COLORS = {
  fail: { bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.35)', text: '#ef4444', label: 'FAIL' },
  learn: { bg: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.35)', text: '#fbbf24', label: 'LEARN' },
  learning: { bg: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.35)', text: '#fbbf24', label: 'LEARN' },
  success: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.35)', text: '#10b981', label: 'SUCCESS' },
  testing: { bg: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.35)', text: '#60a5fa', label: 'TESTING' },
  scaling: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.35)', text: '#10b981', label: 'SCALING' },
  paused: { bg: 'rgba(107, 114, 128, 0.15)', border: 'rgba(107, 114, 128, 0.35)', text: '#9ca3af', label: 'PAUSED' },
  active: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.35)', text: '#10b981', label: 'ACTIVE' }
};

function roasColor(r) {
  if (r == null) return '#6b7280';
  if (r >= 3) return '#10b981';
  if (r >= 1.5) return '#fbbf24';
  if (r >= 0.8) return '#f97316';
  return '#ef4444';
}

function fmtMoney(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString()}`;
  return `$${Math.round(n)}`;
}

function fmtRoas(n) {
  if (n == null) return '—';
  return `${Number(n).toFixed(2)}x`;
}

function handleEntityClick(kind, id, e) {
  e.preventDefault();
  e.stopPropagation();
  window.dispatchEvent(new CustomEvent('zeus-navigate', { detail: { kind, id } }));
}

function StageBadge({ stage, status, warning }) {
  const key = (stage || status || '').toLowerCase();
  const cfg = STAGE_COLORS[key] || STAGE_COLORS.active;
  return (
    <span
      className="entity-list-badge"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.text }}
    >
      {cfg.label}
      {warning && <span style={{ marginLeft: 4 }}>⚠</span>}
    </span>
  );
}

function MiniSparkline({ data }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  // Transformamos a formato recharts
  const series = data.map((v, i) => ({ x: i, y: typeof v === 'number' ? v : 0 }));
  const max = Math.max(...series.map(s => s.y));
  const last = series[series.length - 1].y;
  const color = roasColor(last);
  return (
    <div className="entity-list-spark" title={`Últimos ${data.length} puntos · último ${last?.toFixed?.(2)}x`}>
      <ResponsiveContainer width="100%" height={22}>
        <LineChart data={series} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <YAxis hide domain={[0, Math.max(max * 1.1, 0.5)]} />
          <Line
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function EntityRow({ row, entityType, expanded, onToggle }) {
  const d = row.original;
  const kind = entityType || 'adset';
  const cpa = d.cpa != null ? d.cpa : (d.purchases > 0 ? d.spend_7d / d.purchases : null);

  return (
    <motion.div
      layout
      className={`entity-list-row ${expanded ? 'is-expanded' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      <div className="entity-list-row-top" onClick={onToggle}>
        <div className="entity-list-row-name">
          <a
            href={`zeus://${kind}/${d.id}`}
            className="zeus-entity-link entity-list-row-link"
            onClick={(e) => handleEntityClick(kind, d.id, e)}
          >
            {d.name}
          </a>
          {d.note && <span className="entity-list-row-note">{d.note}</span>}
        </div>
        <div className="entity-list-row-badge">
          <StageBadge stage={d.stage} status={d.status} warning={d.warning} />
        </div>
      </div>

      <div className="entity-list-row-metrics">
        <span className="entity-list-metric" style={{ color: roasColor(d.roas_7d), fontWeight: 700 }}>
          {fmtRoas(d.roas_7d)}
        </span>
        <span className="entity-list-sep">·</span>
        <span className="entity-list-metric">{fmtMoney(d.spend_7d)} 7d</span>
        <span className="entity-list-sep">·</span>
        <span className="entity-list-metric">
          {d.purchases || 0} {d.purchases === 1 ? 'compra' : 'compras'}
        </span>
        {cpa != null && (
          <>
            <span className="entity-list-sep">·</span>
            <span className="entity-list-metric">CPA {fmtMoney(cpa)}</span>
          </>
        )}
        {d.frequency != null && (
          <>
            <span className="entity-list-sep">·</span>
            <span className="entity-list-metric">f:{d.frequency.toFixed(2)}</span>
          </>
        )}
        {d.ctr != null && (
          <>
            <span className="entity-list-sep">·</span>
            <span className="entity-list-metric">CTR {d.ctr.toFixed(2)}%</span>
          </>
        )}
      </div>

      {Array.isArray(d.sparkline) && d.sparkline.length > 1 && (
        <MiniSparkline data={d.sparkline} />
      )}

      <AnimatePresence>
        {expanded && d.expanded_detail && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="entity-list-row-expand"
          >
            <div className="entity-list-row-expand-body">
              {typeof d.expanded_detail === 'string'
                ? d.expanded_detail
                : JSON.stringify(d.expanded_detail, null, 2)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const columnHelper = createColumnHelper();

export default function EntityListTable({ spec }) {
  const entityType = spec?.entity_type || 'adset';
  const initialSort = spec?.sort || 'spend_7d';
  const rows = Array.isArray(spec?.rows) ? spec.rows : [];

  const [sorting, setSorting] = useState([{ id: initialSort, desc: true }]);
  const [expandedId, setExpandedId] = useState(null);

  const columns = useMemo(() => [
    columnHelper.accessor('name', { header: 'Nombre' }),
    columnHelper.accessor('roas_7d', { header: 'ROAS 7d' }),
    columnHelper.accessor('spend_7d', { header: 'Spend 7d' }),
    columnHelper.accessor('purchases', { header: 'Compras' }),
    columnHelper.accessor(r => r.cpa ?? (r.purchases > 0 ? r.spend_7d / r.purchases : null), {
      id: 'cpa', header: 'CPA'
    })
  ], []);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  const sortLabels = {
    spend_7d: 'Spend 7d',
    roas_7d: 'ROAS 7d',
    purchases: 'Compras',
    cpa: 'CPA',
    name: 'Nombre'
  };

  if (rows.length === 0) {
    return (
      <div className="entity-list-empty">
        Lista vacía.
      </div>
    );
  }

  const currentSort = sorting[0];
  const sortedRows = table.getRowModel().rows;

  return (
    <div className="entity-list">
      <div className="entity-list-header">
        <div className="entity-list-header-count">
          {rows.length} {entityType === 'adset' ? 'ad sets' : entityType + 's'}
        </div>
        <div className="entity-list-sort">
          <span className="entity-list-sort-label">Ordenar por</span>
          {Object.entries(sortLabels).map(([key, label]) => (
            <button
              key={key}
              className={`entity-list-sort-btn ${currentSort?.id === key ? 'is-active' : ''}`}
              onClick={() => {
                if (currentSort?.id === key) {
                  setSorting([{ id: key, desc: !currentSort.desc }]);
                } else {
                  setSorting([{ id: key, desc: true }]);
                }
              }}
            >
              {label}
              {currentSort?.id === key && (
                <span className="entity-list-sort-arrow">{currentSort.desc ? '↓' : '↑'}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="entity-list-rows">
        {sortedRows.map((tr) => (
          <EntityRow
            key={tr.original.id}
            row={tr}
            entityType={entityType}
            expanded={expandedId === tr.original.id}
            onToggle={() => setExpandedId(expandedId === tr.original.id ? null : tr.original.id)}
          />
        ))}
      </div>
    </div>
  );
}
