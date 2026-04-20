import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../api';

export default function TemporalSpine() {
  const [events, setEvents] = useState([]);
  const [hoveredEvent, setHoveredEvent] = useState(null);

  useEffect(() => {
    loadEvents();
    const interval = setInterval(loadEvents, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadEvents() {
    try {
      // Traer actions + directives últimas 24h
      const [actionsRes, directivesRes] = await Promise.all([
        api.get('/api/agent/activity').catch(() => ({ data: { recent: [] } })),
        api.get('/api/zeus/intelligence').catch(() => ({ data: { directives: [] } }))
      ]);

      const events = [];
      const now = Date.now();
      const windowMs = 24 * 3600 * 1000;

      // Actions de agentes
      const recent = actionsRes.data?.recent || actionsRes.data || [];
      (Array.isArray(recent) ? recent : []).slice(0, 100).forEach(a => {
        if (!a.executed_at) return;
        const ts = new Date(a.executed_at).getTime();
        if (now - ts > windowMs) return;
        events.push({
          ts,
          agent: (a.agent_type || 'unknown').replace('_agent', ''),
          type: a.action || 'action',
          detail: a.entity_name || a.reasoning?.substring(0, 60) || ''
        });
      });

      // Directives
      const dirs = directivesRes.data?.directives || [];
      (Array.isArray(dirs) ? dirs : []).slice(0, 50).forEach(d => {
        if (!d.created_at) return;
        const ts = new Date(d.created_at).getTime();
        if (now - ts > windowMs) return;
        events.push({
          ts,
          agent: 'zeus',
          type: d.directive_type,
          detail: (d.directive || '').substring(0, 80),
          target: d.target_agent
        });
      });

      events.sort((a, b) => a.ts - b.ts);
      setEvents(events);
    } catch (err) {
      console.error('TemporalSpine error:', err);
    }
  }

  const now = Date.now();
  const windowMs = 24 * 3600 * 1000;
  const windowStart = now - windowMs;

  const eventToX = (ts) => ((ts - windowStart) / windowMs) * 100;
  const nowX = 100; // now is always at the right edge

  return (
    <div className="temporal-spine">
      <div className="temporal-label">
        ◄ 24h
      </div>
      <div className="temporal-timeline" onMouseLeave={() => setHoveredEvent(null)}>
        {/* Now line */}
        <div className="temporal-now-line" style={{ left: `${nowX}%` }} />

        {/* Time markers */}
        {[6, 12, 18].map(h => {
          const markerTs = now - h * 3600 * 1000;
          const x = eventToX(markerTs);
          return (
            <div key={h} style={{
              position: 'absolute',
              left: `${x}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: 'rgba(255, 255, 255, 0.06)',
              pointerEvents: 'none'
            }}>
              <span style={{
                position: 'absolute',
                bottom: -2,
                left: 4,
                fontSize: '0.55rem',
                color: 'var(--bos-text-dim)',
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                -{h}h
              </span>
            </div>
          );
        })}

        {/* Events */}
        {events.map((ev, i) => {
          const x = eventToX(ev.ts);
          if (x < 0 || x > 100) return null;
          return (
            <motion.div
              key={i}
              className={`temporal-event ${ev.agent}`}
              style={{ left: `${x}%` }}
              initial={{ opacity: 0, scaleY: 0 }}
              animate={{ opacity: 0.7, scaleY: 1 }}
              transition={{ delay: i * 0.01 }}
              onMouseEnter={() => setHoveredEvent({ ...ev, x })}
            />
          );
        })}

        {/* Hover tooltip */}
        {hoveredEvent && (
          <div style={{
            position: 'absolute',
            left: `${hoveredEvent.x}%`,
            bottom: '100%',
            transform: 'translateX(-50%)',
            background: 'rgba(17, 21, 51, 0.98)',
            border: '1px solid var(--bos-synapse)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: '0.68rem',
            color: 'var(--bos-text)',
            whiteSpace: 'nowrap',
            boxShadow: '0 0 20px var(--bos-synapse-glow)',
            zIndex: 60,
            pointerEvents: 'none',
            marginBottom: 8
          }}>
            <strong style={{ color: 'var(--bos-synapse)', textTransform: 'uppercase' }}>{hoveredEvent.agent}</strong>
            {' · '}
            <span>{hoveredEvent.type}</span>
            {hoveredEvent.target && <span style={{ color: 'var(--bos-text-muted)' }}> → {hoveredEvent.target}</span>}
            <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', marginTop: 2 }}>
              {hoveredEvent.detail}
            </div>
          </div>
        )}
      </div>
      <div className="temporal-label" style={{ textAlign: 'right', minWidth: 60 }}>
        now ►
      </div>
      <div style={{ marginLeft: 20, display: 'flex', gap: 10, fontSize: '0.6rem' }}>
        {[
          { k: 'zeus', c: 'var(--bos-synapse)' },
          { k: 'athena', c: 'var(--bos-bio)' },
          { k: 'apollo', c: 'var(--bos-warn)' },
          { k: 'prometheus', c: 'var(--bos-danger)' },
          { k: 'ares', c: 'var(--bos-electric)' }
        ].map(a => (
          <div key={a.k} style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--bos-text-muted)' }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: a.c }} />
            {a.k}
          </div>
        ))}
      </div>
    </div>
  );
}
