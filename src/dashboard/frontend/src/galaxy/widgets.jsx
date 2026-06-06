import React from 'react';
import { AGENTS, ZEUS } from './agents';

function ringPos(angleDeg, radius, cx = 50, cy = 50) {
  const r = (angleDeg - 90) * (Math.PI / 180);
  return { x: cx + radius * Math.cos(r), y: cy + radius * Math.sin(r) };
}

// ── Leyenda (bottom-right) ──
export function Legend() {
  const all = [ZEUS, ...AGENTS];
  return (
    <div style={{ position: 'absolute', right: 12, bottom: 12, background: 'rgba(15,17,23,0.78)', backdropFilter: 'blur(8px)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '8px 11px', pointerEvents: 'none' }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Leyenda</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
        {all.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: `var(--ag-${a.id})`, boxShadow: `0 0 5px var(--ag-${a.id})` }} />
            <span style={{ fontSize: '0.62rem', color: 'var(--text-secondary)' }}>{a.label.toLowerCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Minimapa (bottom-left) ──
export function Minimap({ selected, onSelect }) {
  const W = 168, H = 120;
  return (
    <div style={{ position: 'absolute', left: 12, bottom: 12, width: W, background: 'rgba(15,17,23,0.78)', backdropFilter: 'blur(8px)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Mapa General</div>
      <svg width={W - 20} height={H - 36} viewBox="0 0 100 70" style={{ display: 'block' }}>
        {AGENTS.map(a => {
          const p = ringPos(a.angle, 30, 50, 35);
          return <line key={'l' + a.id} x1="50" y1="35" x2={p.x} y2={p.y} stroke={`var(--ag-${a.id})`} strokeOpacity="0.25" strokeWidth="0.6" />;
        })}
        {AGENTS.map(a => {
          const p = ringPos(a.angle, 30, 50, 35);
          return <circle key={a.id} cx={p.x} cy={p.y} r={selected === a.id ? 3.2 : 2.3} fill={`var(--ag-${a.id})`} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect && onSelect(a.id)} />;
        })}
        <circle cx="50" cy="35" r="4.5" fill="var(--ag-zeus)" stroke="#93c5fd" strokeWidth="0.8" />
      </svg>
    </div>
  );
}

// ── Timeline inferior (actividad del sistema, últimas 12h) ──
export function Timeline({ activity = [] }) {
  const now = Date.now();
  const span = 12 * 3600 * 1000; // 12h
  const ticks = [-12, -9, -6, -3, 0];
  const items = (activity || []).filter(a => a.at && (now - new Date(a.at).getTime()) <= span);
  return (
    <div style={{ height: 104, flexShrink: 0, borderTop: '1px solid var(--border-color)', padding: '10px 22px', position: 'relative', background: 'rgba(15,17,23,0.4)' }}>
      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        Línea de Tiempo · Actividad del Sistema {items.length > 0 && <span style={{ color: 'var(--text-muted)' }}>· {items.length} eventos</span>}
      </div>
      <div style={{ position: 'relative', height: 52 }}>
        {/* baseline */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 16, height: 1, background: 'rgba(255,255,255,0.08)' }} />
        {/* stems de actividad */}
        {items.map((a, i) => {
          const ageFrac = (now - new Date(a.at).getTime()) / span; // 0 = ahora, 1 = -12h
          const x = (1 - ageFrac) * 100;
          const h = 14 + ((i * 7) % 26);
          return (
            <div key={i} style={{ position: 'absolute', left: `${x}%`, bottom: 16, width: 1.5, height: h, background: `var(--ag-${a.agent})`, boxShadow: `0 0 5px var(--ag-${a.agent})` }}>
              <div style={{ position: 'absolute', top: -3, left: -2, width: 5, height: 5, borderRadius: '50%', background: `var(--ag-${a.agent})` }} />
            </div>
          );
        })}
        {items.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.66rem', fontStyle: 'italic' }}>
            Sin actividad en las últimas 12h
          </div>
        )}
        {/* eje */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'space-between' }}>
          {ticks.map(t => <span key={t} style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{t === 0 ? 'ahora' : `${t}h`}</span>)}
        </div>
      </div>
    </div>
  );
}
