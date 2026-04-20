import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../api';

export default function MorningBriefing() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadBriefing();
    const interval = setInterval(loadBriefing, 15 * 60 * 1000); // refresh cada 15min
    return () => clearInterval(interval);
  }, []);

  async function loadBriefing(force = false) {
    try {
      setLoading(true);
      const url = '/api/brain/briefing' + (force ? '?force=1' : '');
      const res = await api.get(url);
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="briefing-hero">
        <div className="bos-loading">Analizando tu sistema...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="briefing-hero">
        <div style={{ color: 'var(--bos-danger)' }}>Error cargando briefing: {error}</div>
      </div>
    );
  }

  if (!data) return null;

  const trendArrow = (t) => t === 'up' ? '↑' : t === 'down' ? '↓' : '→';

  return (
    <motion.div
      className="briefing-hero"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <div className="briefing-greeting">
          ⚡ <strong>{data.greeting}</strong>
        </div>
        <div className="briefing-summary">{data.summary_line}</div>
      </motion.div>

      {data.key_metrics && data.key_metrics.length > 0 && (
        <div className="briefing-metrics-row">
          {data.key_metrics.map((m, i) => (
            <motion.div
              key={i}
              className="briefing-metric"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + i * 0.08 }}
            >
              <div className="briefing-metric-value">
                {m.value}
                <span className={`briefing-metric-trend ${m.trend || 'flat'}`}>
                  {trendArrow(m.trend)}
                </span>
              </div>
              <div className="briefing-metric-label">{m.label}</div>
            </motion.div>
          ))}
        </div>
      )}

      <div className="briefing-sections">
        <motion.div
          className="briefing-section"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.6 }}
        >
          <div className="briefing-section-title">Mientras dormías</div>
          <ul className="briefing-list">
            {(data.overnight_events || []).map((ev, i) => (
              <li key={i}>{ev}</li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          className="briefing-section"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.7 }}
        >
          <div className="briefing-section-title">Requiere tu atención</div>
          <ul className="briefing-list">
            {(data.attention_items || []).map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </motion.div>

        {data.zeus_today && data.zeus_today.length > 0 && (
          <motion.div
            className="briefing-section"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            style={{ gridColumn: '1 / -1' }}
          >
            <div className="briefing-section-title">Zeus hoy planea</div>
            <ul className="briefing-list">
              {data.zeus_today.map((z, i) => (
                <li key={i}>{z}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </div>

      {data.from_cache && (
        <div style={{ position: 'absolute', top: 12, right: 16, fontSize: '0.62rem', color: 'var(--bos-text-dim)' }}>
          ● briefing actualizado hace {data.age_min || 0} min {' '}
          <button
            onClick={() => loadBriefing(true)}
            style={{ background: 'transparent', border: 'none', color: 'var(--bos-synapse)', cursor: 'pointer', fontSize: '0.62rem' }}
          >
            refresh
          </button>
        </div>
      )}
    </motion.div>
  );
}
