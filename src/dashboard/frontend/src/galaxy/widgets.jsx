import React from 'react';
import { AGENTS, ZEUS, AGENT_MAP } from './agents';

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

// ── Timeline inferior — forward-looking: quién viene ahora (próximos agentes) ──
const relTime = m => (m < 60 ? `en ${m}m` : `en ${Math.floor(m / 60)}h ${m % 60}m`);

export function Timeline({ upcoming = [], nowEt, recentCount = 0 }) {
  return (
    <div style={{ height: 104, flexShrink: 0, borderTop: '1px solid var(--border-color)', padding: '10px 22px', background: 'rgba(15,17,23,0.4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Línea de Tiempo · Próximos agentes
          {recentCount > 0 && <span style={{ color: 'var(--text-muted)' }}> · {recentCount} acciones hoy</span>}
        </span>
        {nowEt && <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>ahora {nowEt} ET</span>}
      </div>
      {/* riel de próximos */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {/* ancla "ahora" */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#fff', boxShadow: '0 0 8px #fff' }} />
          <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>ahora</span>
        </div>
        {upcoming.length === 0 && <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Cargando agenda…</span>}
        {upcoming.map((u, i) => {
          const col = `var(--ag-${u.agent})`;
          const nm = AGENT_MAP[u.agent]?.label || u.agent;
          const first = i === 0;
          return (
            <React.Fragment key={u.agent}>
              <span style={{ flexShrink: 0, width: 18, height: 1, background: 'rgba(255,255,255,0.12)' }} />
              <div style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8,
                background: first ? `color-mix(in srgb, ${col} 18%, transparent)` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${first ? col : 'rgba(255,255,255,0.08)'}`
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: col, boxShadow: first ? `0 0 7px ${col}` : 'none', flexShrink: 0 }} />
                <div style={{ lineHeight: 1.25 }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: first ? 700 : 600, color: first ? '#fff' : 'var(--text-secondary)' }}>{nm} <span style={{ fontFamily: 'JetBrains Mono, monospace', color: col }}>{u.at}</span></div>
                  <div style={{ fontSize: '0.54rem', color: 'var(--text-muted)' }}>{relTime(u.in_minutes)}{first ? ' · próximo' : ''}</div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
