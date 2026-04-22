/**
 * AdSetDetailCard — card inline dentro del chat de Zeus.
 * Se abre cuando el usuario clickea un link `zeus://adset/<id>`.
 * Fetcha /api/zeus/entity/adset/:id/detail y renderiza metrics completas,
 * sparkline ROAS 14d, ads adentro, acciones recientes y brain memory.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';
import api from '../api';

/**
 * Modal overlay que envuelve el AdSetDetailCard.
 * Se cierra con backdrop click, ESC, o botón ✕.
 * Se exporta nominalmente para usar desde ZeusSpeaks.
 */
export function AdSetDetailModal({ adsetId, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    // Bloquear scroll del body mientras el modal está abierto
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <AnimatePresence>
      <motion.div
        key="adset-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="adset-modal-backdrop"
        onClick={onClose}
      >
        <motion.div
          key="adset-modal-body"
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.98 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="adset-modal-body"
          onClick={(e) => e.stopPropagation()}
        >
          <AdSetDetailCard adsetId={adsetId} onClose={onClose} />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function fmtMoney(n) {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${n.toFixed(2)}%`;
}

function fmtRoas(n) {
  // 0 es un valor válido (ventana con spend pero sin ventas) — solo "—" cuando es null/undefined
  if (n == null) return '—';
  return `${Number(n).toFixed(2)}x`;
}

function roasColor(r) {
  if (!r) return '#6b7280';
  if (r >= 4) return '#10b981';
  if (r >= 2.5) return '#3b82f6';
  if (r >= 1.5) return '#f59e0b';
  return '#ef4444';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function AdSetDetailCard({ adsetId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/api/zeus/entity/adset/${adsetId}/detail`)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(err => {
        if (cancelled) return;
        setError(err.response?.data?.error || err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adsetId]);

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        className="adset-detail-card adset-detail-card--loading"
      >
        <div className="adset-detail-card__skeleton">Consultando ad set…</div>
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        className="adset-detail-card adset-detail-card--error"
      >
        <div className="adset-detail-card__header">
          <div className="adset-detail-card__title">Error al cargar ad set</div>
          <button onClick={onClose} className="adset-detail-card__close">✕</button>
        </div>
        <div className="adset-detail-card__error-body">{error}</div>
      </motion.div>
    );
  }

  const { entity, windows, daily_history, ads, ads_count, recent_actions, tests, brain_memory } = data;
  const sparkData = (daily_history || []).map(d => ({ date: d.date, roas: d.roas, spend: d.spend }));

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="adset-detail-card"
    >
      {/* Header */}
      <div className="adset-detail-card__header">
        <div className="adset-detail-card__title-block">
          <div className="adset-detail-card__title">{entity.name}</div>
          <div className="adset-detail-card__subtitle">
            <span className={`adset-detail-card__status adset-detail-card__status--${String(entity.status || '').toLowerCase()}`}>
              {entity.status}
            </span>
            {entity.learning_stage === 'LEARNING' && (
              <span className="adset-detail-card__learning">
                aprendiendo · {entity.learning_conversions || 0}/50
              </span>
            )}
            <span className="adset-detail-card__budget">${entity.daily_budget}/día</span>
          </div>
        </div>
        <button onClick={onClose} className="adset-detail-card__close" title="Cerrar">✕</button>
      </div>

      {/* Tabs */}
      <div className="adset-detail-card__tabs">
        {[
          { key: 'overview', label: 'Métricas' },
          { key: 'ads', label: `Ads (${ads_count || 0})` },
          { key: 'history', label: 'Historial' },
          { key: 'memory', label: 'Memoria' }
        ].map(t => (
          <button
            key={t.key}
            className={`adset-detail-card__tab ${activeTab === t.key ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === 'overview' && (
        <div className="adset-detail-card__body">
          <div className="adset-detail-card__windows">
            {[
              { key: 'today', label: 'Hoy' },
              { key: 'last_3d', label: '3d' },
              { key: 'last_7d', label: '7d' },
              { key: 'last_14d', label: '14d' }
            ].map(w => {
              const m = windows[w.key] || {};
              return (
                <div key={w.key} className="adset-detail-card__window">
                  <div className="adset-detail-card__window-label">{w.label}</div>
                  <div className="adset-detail-card__window-roas" style={{ color: roasColor(m.roas) }}>
                    {fmtRoas(m.roas)}
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>Spend</span><span>{fmtMoney(m.spend)}</span>
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>Revenue</span>
                    <span style={{ color: m.revenue > 0 ? '#10b981' : 'var(--bos-text-muted)' }}>
                      {fmtMoney(m.revenue)}
                    </span>
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>Compras</span><span>{m.purchases || 0}</span>
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>CPA</span><span>{m.cpa != null ? fmtMoney(m.cpa) : '—'}</span>
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>CTR</span><span>{fmtPct(m.ctr)}</span>
                  </div>
                  <div className="adset-detail-card__window-row">
                    <span>Freq</span><span>{m.frequency != null ? m.frequency.toFixed(2) : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {sparkData.length > 1 && (
            <div className="adset-detail-card__spark">
              <div className="adset-detail-card__spark-label">ROAS · últimos {sparkData.length}d</div>
              <ResponsiveContainer width="100%" height={100}>
                <LineChart data={sparkData}>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} domain={[0, 'auto']} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #1f2937', fontSize: 11 }}
                    labelStyle={{ color: '#93c5fd' }}
                  />
                  <Line type="monotone" dataKey="roas" stroke="#60a5fa" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Ads */}
      {activeTab === 'ads' && (
        <div className="adset-detail-card__body">
          {(!ads || ads.length === 0) && (
            <div className="adset-detail-card__empty">Sin ads activos registrados.</div>
          )}
          {ads && ads.map(ad => (
            <div key={ad.id} className="adset-detail-card__ad">
              <div className="adset-detail-card__ad-name">
                {ad.name}
                <span className={`adset-detail-card__status adset-detail-card__status--${String(ad.status || '').toLowerCase()}`}>
                  {ad.status}
                </span>
              </div>
              <div className="adset-detail-card__ad-metrics">
                <span>hoy {fmtMoney(ad.spend_today)}</span>
                <span>7d {fmtMoney(ad.spend_7d)}</span>
                <span style={{ color: roasColor(ad.roas_7d), fontWeight: 600 }}>{fmtRoas(ad.roas_7d)}</span>
                <span>{ad.purchases_7d}c</span>
                <span>CTR {fmtPct(ad.ctr)}</span>
                <span>f:{ad.frequency?.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* History */}
      {activeTab === 'history' && (
        <div className="adset-detail-card__body">
          {(!recent_actions || recent_actions.length === 0) && (
            <div className="adset-detail-card__empty">Sin acciones recientes registradas.</div>
          )}
          {recent_actions && recent_actions.map((a, i) => (
            <div key={i} className="adset-detail-card__action">
              <div className="adset-detail-card__action-head">
                <span className="adset-detail-card__action-label">{a.action}</span>
                <span className="adset-detail-card__action-agent">{a.agent}</span>
                <span className="adset-detail-card__action-time">{timeAgo(a.executed_at)}</span>
              </div>
              {(a.before_value != null || a.after_value != null) && (
                <div className="adset-detail-card__action-change">
                  {a.before_value} → {a.after_value}
                </div>
              )}
              {a.reasoning && <div className="adset-detail-card__action-reason">{a.reasoning}</div>}
              {a.impact_7d_roas_delta != null && (
                <div className="adset-detail-card__action-impact">
                  Impacto 7d ROAS: {a.impact_7d_roas_delta > 0 ? '+' : ''}{a.impact_7d_roas_delta.toFixed(2)}
                </div>
              )}
            </div>
          ))}
          {tests && tests.length > 0 && (
            <div className="adset-detail-card__tests">
              <div className="adset-detail-card__section-label">Tests lanzados desde este ad set</div>
              {tests.map(t => (
                <div key={t.id} className="adset-detail-card__test">
                  <span>{t.phase}</span>
                  <span>{timeAgo(t.launched_at)}</span>
                  <span style={{ color: roasColor(t.roas) }}>{fmtRoas(t.roas)}</span>
                  <span>{t.purchases || 0}c</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Memory */}
      {activeTab === 'memory' && (
        <div className="adset-detail-card__body">
          {!brain_memory && (
            <div className="adset-detail-card__empty">Sin memoria del brain sobre este ad set.</div>
          )}
          {brain_memory && (
            <>
              {brain_memory.notes && (
                <div className="adset-detail-card__memory-notes">{brain_memory.notes}</div>
              )}
              {brain_memory.patterns && Object.keys(brain_memory.patterns).length > 0 && (
                <div className="adset-detail-card__memory-patterns">
                  <div className="adset-detail-card__section-label">Patrones</div>
                  <pre>{JSON.stringify(brain_memory.patterns, null, 2)}</pre>
                </div>
              )}
              <div className="adset-detail-card__memory-meta">
                {brain_memory.action_count} acciones históricas · actualizado {timeAgo(brain_memory.last_updated)}
              </div>
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}
