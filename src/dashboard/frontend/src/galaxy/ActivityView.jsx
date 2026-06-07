import { useState, useEffect, useCallback } from 'react';
import api from '../api';

// Centro de operaciones — feed rico de actividad. Impacto HONESTO: verdict medido
// (positivo/neutro/negativo) o "Midiendo" si aún no se midió (no inventamos verde).

const AGENT_META = {
  athena: { label: 'Athena', color: 'var(--ag-athena, #a855f7)' },
  apollo: { label: 'Apollo', color: 'var(--ag-apollo, #f97316)' },
  prometheus: { label: 'Prometheus', color: 'var(--ag-prometheus, #ef4444)' },
  ares: { label: 'Ares', color: 'var(--ag-ares, #f59e0b)' },
  demeter: { label: 'Demeter', color: 'var(--ag-demeter, #10b981)' },
  dionisio: { label: 'Dionisio', color: 'var(--ag-dionisio, #ec4899)' },
  hermes: { label: 'Hermes', color: 'var(--ag-hermes, #06b6d4)' },
  zeus: { label: 'Zeus', color: 'var(--ag-zeus, #eab308)' },
  sistema: { label: 'Sistema', color: '#64748b' }
};
const ACTION_COLOR = (a = '') =>
  /scale_up|duplicate|create/i.test(a) ? '#34d399' :
  /scale_down|pause|kill/i.test(a) ? '#f87171' :
  /budget|move/i.test(a) ? '#60a5fa' : '#a78bfa';

const rel = (at) => {
  if (!at) return '';
  const diff = Date.now() - new Date(at);
  const mi = Math.floor(diff / 60000), h = Math.floor(mi / 60), d = Math.floor(h / 24);
  if (d > 0) return `Hace ${d}d ${h % 24}h`;
  if (h > 0) return `Hace ${h}h ${mi % 60}m`;
  return `Hace ${Math.max(mi, 0)}m`;
};
const absT = (at) => {
  const d = new Date(at), now = new Date();
  const t = d.toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })} ${t}`;
};

function Donut({ breakdown = {} }) {
  const items = [
    { k: 'positive', label: 'Positivo', color: '#34d399' },
    { k: 'neutral', label: 'Neutro', color: '#fbbf24' },
    { k: 'negative', label: 'Negativo', color: '#f87171' },
    { k: 'pending', label: 'Midiendo', color: '#64748b' }
  ];
  const total = items.reduce((s, i) => s + (breakdown[i.k] || 0), 0) || 1;
  let acc = 0;
  const stops = items.map(i => {
    const start = (acc / total) * 360; acc += breakdown[i.k] || 0; const end = (acc / total) * 360;
    return `${i.color} ${start}deg ${end}deg`;
  }).join(', ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 92, height: 92, borderRadius: '50%', background: `conic-gradient(${stops})`, flexShrink: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 11, borderRadius: '50%', background: 'var(--bg-secondary, #0f1330)' }} />
      </div>
      <div style={{ flex: 1 }}>
        {items.map(i => {
          const n = breakdown[i.k] || 0; const pct = total ? Math.round((n / total) * 100) : 0;
          return (
            <div key={i.k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.72rem', marginBottom: 3 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: i.color }} />
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{i.label}</span>
              <b style={{ fontFamily: 'JetBrains Mono, monospace' }}>{pct}% ({n})</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const card = { background: 'var(--bg-secondary, rgba(17,21,51,0.5))', border: '1px solid var(--border-color, rgba(255,255,255,0.08))', borderRadius: 12 };

export default function ActivityView() {
  const [data, setData] = useState(null);
  const [agent, setAgent] = useState('all');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/overview/activity', { params: { agent, page, q, days: 14 } })
      .then(r => setData(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, [agent, page, q]);
  useEffect(() => { load(); }, [load]);
  // reset a página 1 al cambiar filtro/búsqueda
  useEffect(() => { setPage(1); }, [agent, q]);

  const counts = data?.counts_by_agent || {};
  const chipAgents = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const sum = data?.summary || {};
  const events = data?.events || [];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 18, alignItems: 'start' }}>
      {/* ── Columna principal ── */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Actividad del Sistema</span>
          <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>últimos 14 días · {data?.all_count ?? 0} eventos</span>
        </div>

        {/* Chips de filtro + búsqueda */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <Chip active={agent === 'all'} onClick={() => setAgent('all')} label="Todos" count={data?.all_count} color="#94a3b8" />
          {chipAgents.map(a => (
            <Chip key={a} active={agent === a} onClick={() => setAgent(a)} label={AGENT_META[a]?.label || a} count={counts[a]} color={AGENT_META[a]?.color || '#64748b'} />
          ))}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar en actividad…"
            style={{ marginLeft: 'auto', minWidth: 200, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-tertiary, rgba(0,0,0,0.25))', color: 'var(--text-primary, #fff)', fontSize: '0.76rem' }} />
        </div>

        {/* Tabla */}
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '150px 120px minmax(0,1fr) 110px 96px', gap: 8, padding: '9px 14px', fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
            <div>Agente</div><div>Acción</div><div>Mensaje</div><div>Impacto</div><div style={{ textAlign: 'right' }}>Hora</div>
          </div>
          {loading ? (
            <div style={{ padding: 24, opacity: 0.5, fontSize: '0.78rem' }}>Cargando…</div>
          ) : events.length === 0 ? (
            <div style={{ padding: 24, opacity: 0.55, fontSize: '0.78rem', fontStyle: 'italic' }}>Sin actividad para este filtro.</div>
          ) : events.map((e, i) => {
            const am = AGENT_META[e.agent] || { label: e.agent, color: '#64748b' };
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '150px 120px minmax(0,1fr) 110px 96px', gap: 8, padding: '10px 14px', alignItems: 'center', borderBottom: '1px solid var(--border-color)', fontSize: '0.76rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: am.color, boxShadow: `0 0 6px ${am.color}`, flexShrink: 0 }} />
                  <b style={{ color: am.color, whiteSpace: 'nowrap' }}>{am.label}</b>
                </div>
                <div><span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.66rem', padding: '3px 8px', borderRadius: 5, background: `color-mix(in srgb, ${ACTION_COLOR(e.action)} 16%, transparent)`, color: ACTION_COLOR(e.action), whiteSpace: 'nowrap' }}>{e.action}</span></div>
                <div style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.reasoning || e.entity_name}>{e.entity_name || <span style={{ opacity: 0.4 }}>—</span>}</div>
                <div>
                  <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '3px 8px', borderRadius: 5, background: `color-mix(in srgb, ${e.impact_color} 16%, transparent)`, color: e.impact_color, whiteSpace: 'nowrap' }}>
                    {e.verdict === 'pending' ? '⏳ ' : ''}{e.impact_label}
                  </span>
                  {e.verdict === 'pending' && e.expected_impact_pct ? (
                    <div style={{ fontSize: '0.54rem', color: 'var(--text-muted)', marginTop: 2 }}>esp. {e.expected_impact_pct > 0 ? '+' : ''}{e.expected_impact_pct}%</div>
                  ) : null}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.66rem', fontFamily: 'JetBrains Mono, monospace' }}>{absT(e.at)}</div>
                  <div style={{ fontSize: '0.54rem', color: 'var(--text-muted)' }}>{rel(e.at)}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Paginación */}
        {data && data.pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            <span>Mostrando {(data.page - 1) * data.per_page + 1}–{Math.min(data.page * data.per_page, data.total)} de {data.total}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <PgBtn disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</PgBtn>
              <span style={{ padding: '4px 10px' }}>{data.page} / {data.pages}</span>
              <PgBtn disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>›</PgBtn>
            </div>
          </div>
        )}
      </div>

      {/* ── Sidebar ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Resumen del día */}
        <div style={{ ...card, padding: 14 }}>
          <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>Resumen · 14 días</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { v: sum.total, l: 'Eventos', c: '#a78bfa' },
              { v: sum.scale, l: 'Escalas', c: '#34d399' },
              { v: sum.new_adsets, l: 'Nuevos adsets', c: '#60a5fa' },
              { v: sum.pauses, l: 'Pausas', c: '#f87171' },
              { v: sum.images, l: 'Imágenes (Apollo)', c: '#fb923c' },
              { v: sum.videos, l: 'Videos (Dionisio)', c: '#ec4899' }
            ].map(s => (
              <div key={s.l}>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: s.c, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>{s.v ?? 0}</div>
                <div style={{ fontSize: '0.56rem', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 3 }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Impacto general */}
        <div style={{ ...card, padding: 14 }}>
          <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 12 }}>Impacto general <span style={{ opacity: 0.5, textTransform: 'none', letterSpacing: 0 }}>· medido vs midiendo</span></div>
          <Donut breakdown={data?.impact_breakdown} />
          {(data?.impact_breakdown?.pending === data?.total && data?.total > 0) && (
            <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>Aún sin medir — el impacto real se mide a T+1d/3d/7d.</div>
          )}
        </div>

        {/* Agentes más activos */}
        <div style={{ ...card, padding: 14 }}>
          <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 12 }}>Agentes más activos</div>
          {(data?.top_agents || []).map(t => {
            const am = AGENT_META[t.agent] || { label: t.agent, color: '#64748b' };
            return (
              <div key={t.agent} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.72rem', marginBottom: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: am.color }} />
                  <b style={{ color: am.color }}>{am.label}</b>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.64rem' }}>{t.count} · {t.pct}%</span>
                </div>
                <div style={{ height: 5, background: 'rgba(255,255,255,0.07)', borderRadius: 3 }}>
                  <div style={{ width: `${t.pct}%`, height: '100%', background: am.color, borderRadius: 3 }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Chip({ active, onClick, label, count, color }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: '0.74rem', fontWeight: active ? 700 : 500,
      background: active ? `color-mix(in srgb, ${color} 20%, transparent)` : 'var(--bg-tertiary, rgba(255,255,255,0.04))',
      border: active ? `1px solid color-mix(in srgb, ${color} 55%, transparent)` : '1px solid transparent',
      color: active ? '#fff' : 'var(--text-secondary, #94a3b8)'
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      {label}{count != null && <span style={{ opacity: 0.6, fontFamily: 'JetBrains Mono, monospace' }}>{count}</span>}
    </button>
  );
}

function PgBtn({ disabled, onClick, children }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', color: disabled ? 'var(--text-muted)' : 'var(--text-primary, #fff)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 }}>{children}</button>
  );
}
