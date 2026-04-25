import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../api';

// Cron schedules de cada agente (ET timezone)
// Sincronizado con src/index.js
const AGENT_SCHEDULES = [
  {
    agent: 'zeus',
    label: 'zeus cycle',
    // brain-cycle 7,13,19,23 + zeus-learner 5,11,17,23
    times: [{ h: 5 }, { h: 7 }, { h: 11 }, { h: 13 }, { h: 17 }, { h: 19 }, { h: 23 }]
  },
  {
    agent: 'athena',
    label: 'athena cycle',
    // account-agent cada 2h par + ai-manager 9,17,22
    times: [
      { h: 2 }, { h: 4 }, { h: 6 }, { h: 8 }, { h: 9 }, { h: 10 },
      { h: 12 }, { h: 14 }, { h: 16 }, { h: 17 }, { h: 18 }, { h: 20 }, { h: 22 }
    ]
  },
  { agent: 'apollo', label: 'apollo cycle', times: [{ h: 8 }, { h: 14 }, { h: 20 }] },
  {
    agent: 'prometheus',
    label: 'prometheus cycle',
    times: [{ h: 6, m: 30 }, { h: 10, m: 30 }, { h: 14, m: 30 }, { h: 18, m: 30 }, { h: 22, m: 30 }]
  },
  {
    agent: 'ares',
    label: 'ares cycle',
    // ares-agent (legacy) 8,16 + ares-brain (LLM Opus) 1,7,13,19
    times: [
      { h: 1 }, { h: 7 }, { h: 8 }, { h: 13 }, { h: 16 }, { h: 19 }
    ]
  },
  {
    agent: 'demeter',
    label: 'demeter cycle',
    // daily snapshot 00:05 (cierre del día anterior, lo más relevante)
    times: [{ h: 0, m: 5 }]
  }
];

// Detectar offset de ET dinámicamente (maneja EDT/EST)
function etOffsetHours(ts = Date.now()) {
  const d = new Date(ts);
  const etH = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(d));
  const utcH = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', hour12: false }).format(d));
  let diff = utcH - etH;
  if (diff < 0) diff += 24;
  return diff;
}

function etDateComponents(ts) {
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.format(d).split('-');
  return { year: +parts[0], month: +parts[1], day: +parts[2] };
}

function etToUtc(year, month, day, hour, minute = 0) {
  const offsetH = etOffsetHours(Date.UTC(year, month - 1, day, hour + 4, minute));
  return Date.UTC(year, month - 1, day, hour + offsetH, minute);
}

function generateScheduleTicks(fromMs, toMs) {
  const ticks = [];
  // Probar yesterday/today/tomorrow en ET para cubrir la ventana
  for (const offset of [-86400000, 0, 86400000]) {
    const etDate = etDateComponents(fromMs + offset);
    for (const schedule of AGENT_SCHEDULES) {
      for (const t of schedule.times) {
        const ts = etToUtc(etDate.year, etDate.month, etDate.day, t.h, t.m || 0);
        if (ts >= fromMs && ts <= toMs) {
          ticks.push({
            ts,
            agent: schedule.agent,
            label: schedule.label,
            scheduled: true
          });
        }
      }
    }
  }
  return ticks.sort((a, b) => a.ts - b.ts);
}

export default function TemporalSpine() {
  const [events, setEvents] = useState([]);
  const [hoveredEvent, setHoveredEvent] = useState(null);
  const [, tick] = useState(0);

  useEffect(() => {
    loadEvents();
    const interval = setInterval(loadEvents, 30000);
    return () => clearInterval(interval);
  }, []);

  // Re-renderea cada minuto para mover la línea 'now' y actualizar ticks
  useEffect(() => {
    const i = setInterval(() => tick(t => t + 1), 60000);
    return () => clearInterval(i);
  }, []);

  async function loadEvents() {
    try {
      const [actionsRes, directivesRes] = await Promise.all([
        api.get('/api/agent/activity').catch(() => ({ data: { recent: [] } })),
        api.get('/api/zeus/intelligence').catch(() => ({ data: { directives: [] } }))
      ]);

      const collected = [];
      const now = Date.now();
      const pastMs = 18 * 3600 * 1000;

      const recent = actionsRes.data?.recent || actionsRes.data || [];
      (Array.isArray(recent) ? recent : []).slice(0, 100).forEach(a => {
        if (!a.executed_at) return;
        const ts = new Date(a.executed_at).getTime();
        if (now - ts > pastMs) return;
        collected.push({
          ts,
          agent: (a.agent_type || 'unknown').replace('_agent', ''),
          type: a.action || 'action',
          detail: a.entity_name || a.reasoning?.substring(0, 60) || ''
        });
      });

      const dirs = directivesRes.data?.directives || [];
      (Array.isArray(dirs) ? dirs : []).slice(0, 50).forEach(d => {
        if (!d.created_at) return;
        const ts = new Date(d.created_at).getTime();
        if (now - ts > pastMs) return;
        collected.push({
          ts,
          agent: 'zeus',
          type: d.directive_type,
          detail: (d.directive || '').substring(0, 80),
          target: d.target_agent
        });
      });

      collected.sort((a, b) => a.ts - b.ts);
      setEvents(collected);
    } catch (err) {
      console.error('TemporalSpine error:', err);
    }
  }

  // Ventana: -18h → +6h (total 24h). Now está a 75% desde la izquierda.
  const now = Date.now();
  const PAST_MS = 18 * 3600 * 1000;
  const FUTURE_MS = 6 * 3600 * 1000;
  const WINDOW_MS = PAST_MS + FUTURE_MS;
  const windowStart = now - PAST_MS;
  const windowEnd = now + FUTURE_MS;

  const tsToX = (ts) => ((ts - windowStart) / WINDOW_MS) * 100;
  const nowX = tsToX(now);

  // Ticks programados en el futuro (y también próximo pasado cercano)
  const scheduleTicks = generateScheduleTicks(now - 60 * 60 * 1000, windowEnd);

  // Time markers
  const timeMarkers = [
    { offset: -12, label: '-12h' },
    { offset: -6, label: '-6h' },
    { offset: 3, label: '+3h' },
    { offset: 6, label: '+6h' }
  ];

  const formatTime = (ts) => {
    return new Date(ts).toLocaleTimeString('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  return (
    <div className="temporal-spine">
      <div className="temporal-label">◄ 18h</div>
      <div className="temporal-timeline" onMouseLeave={() => setHoveredEvent(null)}>
        {/* Now line */}
        <div className="temporal-now-line" style={{ left: `${nowX}%` }} />

        {/* Future zone background subtle */}
        <div style={{
          position: 'absolute',
          left: `${nowX}%`,
          right: 0,
          top: 0,
          bottom: 0,
          background: 'linear-gradient(90deg, rgba(59, 130, 246, 0.05), rgba(59, 130, 246, 0.02))',
          pointerEvents: 'none'
        }} />

        {/* Time markers */}
        {timeMarkers.map(m => {
          const markerTs = now + m.offset * 3600000;
          const x = tsToX(markerTs);
          if (x < 0 || x > 100) return null;
          return (
            <div key={m.offset} style={{
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
                {m.label}
              </span>
            </div>
          );
        })}

        {/* Scheduled ticks (ciclos futuros) */}
        {scheduleTicks.map((t, i) => {
          const x = tsToX(t.ts);
          if (x < 0 || x > 100) return null;
          const isFuture = t.ts > now;
          return (
            <div
              key={`sched-${i}`}
              className={`temporal-schedule ${t.agent} ${isFuture ? 'future' : 'recent'}`}
              style={{ left: `${x}%` }}
              onMouseEnter={() => setHoveredEvent({
                ts: t.ts,
                agent: t.agent,
                type: t.label,
                detail: `programado — ${formatTime(t.ts)} ET`,
                x,
                scheduled: true,
                isFuture
              })}
            />
          );
        })}

        {/* Executed events (pasado) */}
        {events.map((ev, i) => {
          const x = tsToX(ev.ts);
          if (x < 0 || x > 100) return null;
          return (
            <motion.div
              key={i}
              className={`temporal-event ${ev.agent}`}
              style={{ left: `${x}%` }}
              initial={{ opacity: 0, scaleY: 0 }}
              animate={{ opacity: 0.75, scaleY: 1 }}
              transition={{ delay: Math.min(i * 0.01, 1) }}
              onMouseEnter={() => setHoveredEvent({ ...ev, x })}
            />
          );
        })}

        {/* Hover tooltip */}
        {hoveredEvent && (
          <div style={{
            position: 'absolute',
            left: `${Math.max(5, Math.min(95, hoveredEvent.x))}%`,
            bottom: '100%',
            transform: 'translateX(-50%)',
            background: 'rgba(17, 21, 51, 0.98)',
            border: `1px solid ${hoveredEvent.isFuture ? 'rgba(255,255,255,0.2)' : 'var(--bos-synapse)'}`,
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
            {hoveredEvent.scheduled && (
              <span style={{ color: 'var(--bos-text-muted)', marginLeft: 6 }}>
                · {hoveredEvent.isFuture ? 'próximo' : 'pasado cercano'}
              </span>
            )}
            <div style={{ fontSize: '0.6rem', color: 'var(--bos-text-muted)', marginTop: 2 }}>
              {hoveredEvent.detail}
            </div>
          </div>
        )}
      </div>
      <div className="temporal-label" style={{ textAlign: 'right', minWidth: 70 }}>
        now ► 6h
      </div>
      <div style={{ marginLeft: 20, display: 'flex', gap: 10, fontSize: '0.6rem', flexWrap: 'wrap' }}>
        {[
          { k: 'zeus', c: 'var(--bos-synapse)' },
          { k: 'athena', c: 'var(--bos-bio)' },
          { k: 'apollo', c: 'var(--bos-warn)' },
          { k: 'prometheus', c: 'var(--bos-danger)' },
          { k: 'ares', c: 'var(--bos-electric)' },
          { k: 'demeter', c: '#14b8a6' }
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
