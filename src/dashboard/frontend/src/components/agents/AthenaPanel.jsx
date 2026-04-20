import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PanelHeader, Section, Stat, Empty, gridStyle } from './ZeusPanel';
import api from '../../api';

export default function AthenaPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const [activityRes, briefingRes] = await Promise.all([
        api.get('/api/agent/activity').catch(() => ({ data: {} })),
        api.get('/api/brain/briefing').catch(() => ({ data: {} }))
      ]);
      setData({
        activity: activityRes.data,
        context: briefingRes.data?.context
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="bos-loading">Cargando Athena...</div>;

  const activity = data?.activity || {};
  const actions = activity.recent || [];
  const summary = activity.summary || {};

  const actionColor = {
    scale_up: 'var(--bos-bio)',
    scale_down: 'var(--bos-warn)',
    pause: 'var(--bos-danger)',
    reactivate: 'var(--bos-synapse)',
    pause_adset: 'var(--bos-danger)',
    pause_ad: 'var(--bos-warn)'
  };

  return (
    <div>
      <PanelHeader icon="🦉" name="ATHENA" role="Account Manager · Sonnet 4.6" color="var(--bos-bio)" />

      {/* Stats */}
      <div style={gridStyle(4)}>
        <Stat label="Acciones 24h" value={summary.total_24h || actions.filter(a => new Date(a.executed_at).getTime() > Date.now() - 86400000).length} color="var(--bos-bio)" />
        <Stat label="Scales up" value={actions.filter(a => a.action === 'scale_up').length} color="var(--bos-bio)" />
        <Stat label="Pauses" value={actions.filter(a => a.action?.startsWith('pause')).length} color="var(--bos-danger)" />
        <Stat label="Ad sets activos" value={summary.active_adsets || data?.context?.account?.active_adsets || 0} color="var(--bos-text)" />
      </div>

      {/* Recent actions */}
      <Section title="Últimas acciones" count={actions.length}>
        {actions.length === 0 ? (
          <Empty>Sin acciones recientes</Empty>
        ) : (
          actions.slice(0, 10).map((a, i) => {
            const when = a.executed_at ? formatRelative(a.executed_at) : '?';
            return (
              <motion.div
                key={a._id || i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                style={{
                  background: 'rgba(17, 21, 51, 0.5)',
                  borderLeft: `3px solid ${actionColor[a.action] || '#6b7280'}`,
                  borderRadius: 8,
                  padding: '10px 14px',
                  marginBottom: 6
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{
                    fontSize: '0.62rem',
                    color: actionColor[a.action] || '#6b7280',
                    fontFamily: 'JetBrains Mono, monospace',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    letterSpacing: '0.08em'
                  }}>
                    {a.action?.replace('_', ' ')}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--bos-text)', flex: 1 }}>
                    {a.entity_name || '?'}
                  </span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--bos-text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                    {when}
                  </span>
                </div>
                {a.reasoning && (
                  <div style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted)', lineHeight: 1.4 }}>
                    {a.reasoning.substring(0, 160)}
                  </div>
                )}
              </motion.div>
            );
          })
        )}
      </Section>

      {/* Action summary by type */}
      {summary && Object.keys(summary).length > 0 && (
        <Section title="Resumen de ciclo">
          <div style={{
            background: 'rgba(10, 14, 39, 0.5)',
            borderRadius: 10,
            padding: '14px 18px',
            fontSize: '0.8rem',
            color: 'var(--bos-text)',
            lineHeight: 1.8
          }}>
            {summary.last_cycle_summary || 'Athena continúa monitoreando la cuenta cada 2h.'}
          </div>
        </Section>
      )}
    </div>
  );
}

function formatRelative(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
