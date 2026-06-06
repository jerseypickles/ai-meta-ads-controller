import React, { useState, useEffect } from 'react';
import api from '../api';
import { AGENTS, ZEUS, AGENT_HEX, AGENT_MAP } from './agents';

const hex = id => AGENT_HEX[id] || '#64748b';
const label = id => AGENT_MAP[id]?.label || (id === 'manual' ? 'Manual' : id);

const VERDICT = {
  positive: { c: '#34d399', t: 'positivo' },
  negative: { c: '#f87171', t: 'negativo' },
  neutral: { c: '#94a3b8', t: 'neutral' },
  pending: { c: '#64748b', t: 'pendiente' }
};

const ACTION_LABEL = {
  scale_budget: 'Escaló budget', scale_up: 'Scale up', scale_down: 'Scale down', move_budget: 'Movió budget',
  duplicate_adset: 'Duplicó adset', create_adset: 'Creó adset', create_campaign: 'Creó CBO', create_ad: 'Creó ad',
  pause_adset: 'Pausó adset', pause_ad: 'Pausó ad', pause: 'Pausó', reactivate_ad: 'Reactivó ad',
  fast_track_duplicate: 'Fast-track', kill: 'Mató test', graduate: 'Graduó test'
};
const actionLabel = a => ACTION_LABEL[a] || (a || '—').replace(/_/g, ' ');

function dayKey(d) {
  return new Date(d).toLocaleDateString('es', { weekday: 'long', day: '2-digit', month: 'long' });
}
function hhmm(d) {
  return new Date(d).toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export default function HistoryView() {
  const [data, setData] = useState(null);
  const [agent, setAgent] = useState('all');
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/api/overview/history?agent=${agent}&days=30`).then(r => setData(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, [agent]);

  const entries = data?.entries || [];
  // agrupar por día (orden ya viene desc por fecha)
  const groups = [];
  let cur = null;
  for (const e of entries) {
    const k = dayKey(e.at);
    if (!cur || cur.key !== k) { cur = { key: k, items: [] }; groups.push(cur); }
    cur.items.push(e);
  }

  const v = data?.verdict || { positive: 0, negative: 0, neutral: 0, pending: 0 };
  const vTotal = (v.positive + v.negative + v.neutral + v.pending) || 1;
  const chips = [{ id: 'all', label: 'Todos' }, ...[ZEUS, ...AGENTS].map(a => ({ id: a.id, label: a.label }))];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 26px' }}>
      {/* ── Header / stats ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, gap: 20, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '0.02em' }}>Historial del Sistema</div>
          <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>
            {data ? `${data.total} acciones · últimos ${data.days} días` : 'Cargando…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {data?.win_rate != null && (
            <Stat label="Win rate" value={`${data.win_rate}%`} color={data.win_rate >= 60 ? '#34d399' : data.win_rate >= 40 ? '#fbbf24' : '#f87171'} />
          )}
          <Stat label="Positivos" value={v.positive} color="#34d399" />
          <Stat label="Negativos" value={v.negative} color="#f87171" />
          <Stat label="Pendientes" value={v.pending} color="#94a3b8" />
        </div>
      </div>

      {/* barra de veredictos */}
      <div style={{ display: 'flex', height: 6, borderRadius: 4, overflow: 'hidden', marginBottom: 16, background: 'rgba(255,255,255,0.05)' }}>
        {['positive', 'negative', 'neutral', 'pending'].map(k => (
          <div key={k} style={{ width: `${(v[k] / vTotal) * 100}%`, background: VERDICT[k].c, opacity: k === 'pending' ? 0.4 : 1 }} title={`${VERDICT[k].t}: ${v[k]}`} />
        ))}
      </div>

      {/* ── Filtros por agente ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        {chips.map(c => {
          const active = agent === c.id;
          const col = c.id === 'all' ? '#94a3b8' : hex(c.id);
          const n = c.id === 'all' ? data?.total : data?.by_agent?.[c.id];
          return (
            <button key={c.id} onClick={() => { setAgent(c.id); setOpen(null); }} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
              background: active ? `color-mix(in srgb, ${col} 22%, transparent)` : 'rgba(255,255,255,0.03)',
              border: `1px solid ${active ? col : 'rgba(255,255,255,0.08)'}`,
              color: active ? '#fff' : 'var(--text-tertiary)', fontSize: '0.68rem', fontWeight: active ? 700 : 500
            }}>
              {c.id !== 'all' && <span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />}
              {c.label}{n != null && <span style={{ opacity: 0.55, fontFamily: 'JetBrains Mono, monospace' }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Ledger ── */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: 30, textAlign: 'center' }}>Cargando historial…</div>
      ) : entries.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: 30, textAlign: 'center', fontStyle: 'italic' }}>Sin acciones en el período.</div>
      ) : groups.map(g => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px 2px' }}>{g.key} · {g.items.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {g.items.map(e => <Row key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: '0.54rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
    </div>
  );
}

function Row({ e, open, onToggle }) {
  const col = hex(e.agent);
  const vd = VERDICT[e.verdict] || VERDICT.pending;
  const chg = e.change_percent ? `${e.change_percent > 0 ? '+' : ''}${Math.round(e.change_percent)}%` : null;
  return (
    <div onClick={onToggle} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 7, cursor: 'pointer',
      background: open ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.018)',
      borderLeft: `2px solid ${col}`, fontSize: '0.74rem'
    }}>
      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', width: 38, flexShrink: 0 }}>{hhmm(e.at)}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, width: 86, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0 }} />
        <span style={{ color: col, fontWeight: 600, fontSize: '0.66rem' }}>{label(e.agent)}</span>
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'normal' : 'nowrap', color: 'var(--text-secondary)' }}>
        <b style={{ color: 'var(--text-primary)' }}>{actionLabel(e.action)}</b>
        {e.entity_name ? <span style={{ opacity: 0.7 }}> · {e.entity_name}</span> : ''}
      </span>
      {chg && <span style={{ fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', color: e.change_percent > 0 ? '#34d399' : '#f87171', flexShrink: 0 }}>{chg}</span>}
      {e.success === false && <span style={{ fontSize: '0.58rem', color: '#f87171', flexShrink: 0 }}>✗ falló</span>}
      <span style={{ fontSize: '0.56rem', color: vd.c, border: `1px solid ${vd.c}55`, borderRadius: 10, padding: '1px 7px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{vd.t}</span>
      {open && e.reasoning && (
        <div style={{ flexBasis: '100%', marginTop: 4, fontSize: '0.66rem', color: 'var(--text-tertiary)', fontStyle: 'italic', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
          {e.reasoning}
          {e.roas != null && e.roas > 0 && <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontStyle: 'normal' }}>· ROAS al ejecutar {Number(e.roas).toFixed(2)}x</span>}
        </div>
      )}
    </div>
  );
}
