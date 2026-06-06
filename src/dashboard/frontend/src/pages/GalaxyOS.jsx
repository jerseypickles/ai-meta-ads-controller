import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../api';
import GalaxyCanvas from '../galaxy/GalaxyCanvas';
import GalaxyCanvas3D from '../galaxy/GalaxyCanvas3D';
import { Timeline, Minimap, Legend } from '../galaxy/widgets';
import { AGENT_MAP, AGENT_KPIS, agentColor } from '../galaxy/agents';
import NeuralCommandCenter from '../components/NeuralCommandCenter';
import ZeusPanel from '../components/agents/ZeusPanel';
import AthenaPanel from '../components/agents/AthenaPanel';
import ApolloPanel from '../components/agents/ApolloPanel';
import PrometheusPanel from '../components/agents/PrometheusPanel';
import AresPanel from '../components/agents/AresPanel';
import DemeterPanel from '../components/agents/DemeterPanel';
import HermesPanel from '../components/agents/HermesPanel';
import DionysusPanel from '../components/DionysusPanel';

const PANELS = {
  zeus: ZeusPanel, athena: AthenaPanel, apollo: ApolloPanel, prometheus: PrometheusPanel,
  ares: AresPanel, demeter: DemeterPanel, hermes: HermesPanel, dionisio: DionysusPanel
};

const RAIL = [
  { k: 'galaxia', label: 'Galaxia', icon: '🌌' },
  { k: 'red', label: 'Red', icon: '🕸️' },
  { k: 'actividad', label: 'Actividad', icon: '⚡' },
  { k: 'metricas', label: 'Métricas', icon: '📊' },
  { k: 'historial', label: 'Historial', icon: '🕑' },
  { k: 'config', label: 'Config', icon: '⚙️' }
];

export default function GalaxyOS() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [selected, setSelected] = useState(null);
  const [entered, setEntered] = useState(false);
  const [view, setView] = useState('galaxia');

  useEffect(() => {
    const load = () => api.get('/api/overview').then(r => setOverview(r.data)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const agentsData = {};
  (overview?.agents || []).forEach(a => { agentsData[a.id] = a; });

  const g = overview?.global || {};
  const now = new Date();
  const Panel = selected ? PANELS[selected] : null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* ── TOP BAR ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '12px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
        <div onClick={() => navigate('/')} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }} title="Salir a la vista clásica">
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'radial-gradient(circle at 35% 30%, #93c5fd, var(--ag-zeus))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', boxShadow: '0 0 16px rgba(59,130,246,0.5)' }}>🧠</div>
          <div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, letterSpacing: '0.02em' }}>Neural Command Center</div>
            <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>Sistema Operativo Neural · Jersey Pickles</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Kpi label="ROAS hoy" value={`${g.roas_today ?? '—'}x`} color="#34d399" />
        <Kpi label="Revenue hoy" value={`$${(g.revenue_today ?? 0).toLocaleString()}`} color="#60a5fa" />
        <Kpi label="Presupuesto activo" value={`$${(g.active_budget ?? 0).toLocaleString()}`} color="#a78bfa" />
        <div style={{ textAlign: 'right', minWidth: 92 }}>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>{now.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          <div style={{ fontSize: '0.78rem', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>{now.toLocaleTimeString('es', { hour12: false })}</div>
        </div>
      </div>

      {/* ── CUERPO: rail + canvas/panel ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* RAIL */}
        <div style={{ width: 76, flexShrink: 0, borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '14px 0' }}>
          {RAIL.map(r => {
            const active = view === r.k;
            return (
              <button key={r.k} onClick={() => setView(r.k)} title={r.label} style={{
                width: 52, padding: '8px 0', background: active ? 'var(--bg-active)' : 'transparent',
                border: active ? '1px solid var(--border-light)' : '1px solid transparent', borderRadius: 10,
                color: active ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: '1rem'
              }}>
                <span>{r.icon}</span>
                <span style={{ fontSize: '0.52rem', letterSpacing: '0.03em' }}>{r.label}</span>
              </button>
            );
          })}
        </div>

        {/* GALAXIA / SPLIT */}
        {view === 'red' ? (
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <NeuralCommandCenter onAgentClick={(id) => { setSelected(id); setView('galaxia'); }} />
          </div>
        ) : view === 'actividad' ? (
          <ActivityView activity={overview?.activity} />
        ) : view !== 'galaxia' ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Vista «{RAIL.find(r => r.k === view)?.label}» — próximamente.
          </div>
        ) : entered && selected ? (
          // SPLIT: mini-galaxia + panel denso
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--border-color)', position: 'relative' }}>
              <GalaxyCanvas agentsData={agentsData} selected={selected} compact onSelect={setSelected} />
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: '1px solid var(--border-color)' }}>
                <button onClick={() => setEntered(false)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: '0.72rem' }}>← Galaxia</button>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: agentColor(selected) }}>{AGENT_MAP[selected]?.label}</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>{AGENT_MAP[selected]?.role}</span>
              </div>
              <div className={`ag-${selected}`} style={{ flex: 1, overflow: 'auto', padding: 18 }}>
                {Panel ? <Panel /> : <div style={{ color: 'var(--text-muted)' }}>Panel no disponible.</div>}
              </div>
            </div>
          </div>
        ) : (
          // OVERVIEW: canvas + panel resumen
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <GalaxyCanvas3D agentsData={agentsData} selected={selected} onSelect={setSelected} />
                <Minimap selected={selected} onSelect={setSelected} />
                <Legend />
              </div>
              <Timeline activity={overview?.activity} />
            </div>
            <AnimatePresence>
              {selected && (
                <motion.div
                  key={selected}
                  initial={{ x: 360, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 360, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 26 }}
                  style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'auto' }}
                >
                  <AgentSummaryPanel id={selected} data={agentsData[selected]} onEnter={() => setEntered(true)} onClose={() => setSelected(null)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
    </div>
  );
}

function AgentSummaryPanel({ id, data, onEnter, onClose }) {
  const meta = AGENT_MAP[id] || {};
  const color = agentColor(id);
  const kpis = AGENT_KPIS[id] || [];
  const la = data?.last_action;
  return (
    <div style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ width: 46, height: 46, borderRadius: '50%', background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${color} 80%, white), ${color})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem', boxShadow: `0 0 18px color-mix(in srgb, ${color} 55%, transparent)` }}>{meta.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>{meta.label}</div>
          <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>{meta.role}</div>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '1.1rem', cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }} />
        <span style={{ fontSize: '0.72rem', color: '#34d399' }}>Activo</span>
        {meta.awareness && <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginLeft: 6, border: '1px dashed var(--border-light)', borderRadius: 10, padding: '1px 7px' }}>awareness · foot traffic</span>}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {kpis.map(k => (
          <div key={k.key} style={{ background: 'var(--bg-tertiary)', border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k.label}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace' }}>
              {(() => { const v = (data?.kpis && data.kpis[k.key]) ?? data?.[k.key]; return v == null ? '—' : (k.money ? `$${Number(v).toLocaleString()}` : `${v}${k.suffix || ''}`); })()}
            </div>
          </div>
        ))}
      </div>

      {/* Última acción */}
      {la && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Última acción</div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 8, padding: '10px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            <span style={{ color, fontWeight: 600 }}>{la.action}</span>{la.entity_name ? ` · ${la.entity_name}` : ''}
            {la.at && <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 3 }}>{new Date(la.at).toLocaleString('es', { hour12: false })}</div>}
          </div>
        </div>
      )}

      {/* Acciones */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onEnter} style={{ flex: 1, background: `color-mix(in srgb, ${color} 30%, transparent)`, border: `1px solid ${color}`, color: '#fff', borderRadius: 8, padding: '9px 0', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700 }}>Entrar</button>
        <button disabled style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', borderRadius: 8, padding: '9px 0', cursor: 'not-allowed', fontSize: '0.78rem' }}>Chat</button>
        <button disabled style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', borderRadius: 8, padding: '9px 0', cursor: 'not-allowed', fontSize: '0.78rem' }}>Logs</button>
      </div>
    </div>
  );
}

function ActivityView({ activity = [] }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Actividad del Sistema · hoy</div>
      {activity.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>Sin actividad registrada hoy.</div>
      ) : activity.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border-color)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--ag-${a.agent})`, boxShadow: `0 0 6px var(--ag-${a.agent})`, flexShrink: 0 }} />
          <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <b style={{ color: `var(--ag-${a.agent})`, textTransform: 'capitalize' }}>{a.agent}</b> · {a.action}{a.entity_name ? ` · ${a.entity_name}` : ''}
          </span>
          <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>{a.at ? new Date(a.at).toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>
      ))}
    </div>
  );
}
