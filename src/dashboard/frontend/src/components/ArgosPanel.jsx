import { useState, useEffect, useCallback } from 'react';
import { getArgosCapiStats } from '../api';

const ARGOS = '#22d3ee'; // cyan — "el que todo lo ve"

// 🦚 Argos — seguimiento del envío de conversiones server-side (Meta CAPI).
function ArgosPanel() {
  return (
    <div style={{ padding: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <span style={{ fontSize: 26 }}>🦚</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: ARGOS }}>Argos</div>
          <div style={{ fontSize: 11, opacity: 0.55 }}>Conversiones server-side · Meta CAPI</div>
        </div>
      </div>
      <CapiView />
    </div>
  );
}

// 📡 Server-side / CAPI — salud del envío de conversiones por servidor a Meta.
function CapiView() {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setD(await getArgosCapiStats()); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const card = { background: `${ARGOS}10`, border: `1px solid ${ARGOS}33`, borderRadius: 12 };

  if (loading && !d) return <p style={{ opacity: 0.5, marginTop: 16 }}>Cargando envío server-side…</p>;
  if (!d) return <p style={{ opacity: 0.5, marginTop: 16 }}>Sin data.</p>;
  if (d.error) return <p style={{ color: '#f87171', marginTop: 16 }}>Error: {d.error}</p>;

  const t = d.totals || {};
  const mq = d.match_quality || {};
  const lastSent = d.last_sent_at ? new Date(d.last_sent_at) : null;
  const lastAgoMin = lastSent ? Math.round((Date.now() - lastSent.getTime()) / 60000) : null;

  // Señales de match quality, ordenadas por importancia para atribución.
  const mqRows = [
    { k: 'em', label: 'Email', strong: true },
    { k: 'fbp', label: 'fbp (cookie navegador)', strong: true, key_signal: true },
    { k: 'fbc', label: 'fbc (click id)', strong: true, key_signal: true },
    { k: 'ph', label: 'Teléfono', strong: true },
    { k: 'external_id', label: 'Customer ID' },
    { k: 'ip', label: 'IP' },
    { k: 'ua', label: 'User-Agent' },
    { k: 'fn', label: 'Nombre' },
    { k: 'ln', label: 'Apellido' },
    { k: 'ct', label: 'Ciudad' },
    { k: 'zp', label: 'ZIP' }
  ];
  const fbMissing = (mq.fbp || 0) < 50 || (mq.fbc || 0) < 50;

  const kpis = [
    { label: 'Enviados 24h', val: d.sent_today ?? 0, color: ARGOS },
    { label: 'Valor 24h', val: `$${Math.round(d.value_today || 0).toLocaleString()}`, color: '#34d399' },
    { label: 'En cola', val: t.pending ?? 0, color: (t.pending > 0) ? '#fbbf24' : '#64748b' },
    { label: 'Fallidos', val: t.failed ?? 0, color: (t.failed > 0) ? '#f87171' : '#64748b' }
  ];

  return (
    <div style={{ marginTop: 14 }}>
      {/* Estado de configuración */}
      <div style={{ ...card, padding: '11px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: d.configured && d.enabled ? '#34d399' : '#f87171' }}>
          {d.configured && d.enabled ? '🟢 CAPI activo' : d.configured ? '🟡 CAPI deshabilitado' : '🔴 Token no configurado'}
        </span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>pixel {d.pixel_id}</span>
        {d.test_mode && <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', border: '1px solid #fbbf24', borderRadius: 5, padding: '1px 6px' }}>TEST MODE</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>
          {lastAgoMin != null
            ? <>último envío hace {lastAgoMin < 60 ? `${lastAgoMin}m` : lastAgoMin < 1440 ? `${Math.round(lastAgoMin / 60)}h` : `${Math.round(lastAgoMin / 1440)}d`} {lastAgoMin <= 360 ? '🟢' : '🟡'}</>
            : 'sin envíos aún'}
        </span>
        <button onClick={load} style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${ARGOS}55`, background: 'transparent', color: ARGOS, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>↻</button>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 14 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ ...card, padding: '14px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.color }}>{k.val}</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Match Quality */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>🎯 Match Quality</span>
        <span style={{ fontSize: 11, opacity: 0.55 }}>de {mq.sample || 0} envíos · prom {mq.avg_keys || 0} señales/evento</span>
      </div>
      <div style={{ ...card, padding: 12 }}>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
          Cuántas señales lleva cada evento. Más señal = Meta atribuye mejor. <b style={{ color: ARGOS }}>fbp/fbc</b> son las más potentes para ads.
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {mqRows.map(r => {
            const v = mq[r.k] ?? 0;
            const c = v >= 80 ? '#34d399' : v >= 40 ? '#fbbf24' : '#f87171';
            return (
              <div key={r.k} style={{ fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ opacity: 0.85, fontWeight: r.key_signal ? 700 : 400, color: r.key_signal ? ARGOS : 'inherit' }}>
                    {r.label}{r.key_signal ? ' ★' : ''}
                  </span>
                  <span style={{ color: c, fontWeight: 600 }}>{v}%</span>
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${v}%`, height: '100%', background: c }} />
                </div>
              </div>
            );
          })}
        </div>
        {fbMissing && (
          <div style={{ marginTop: 10, fontSize: 11, color: '#fbbf24', borderLeft: '3px solid #fbbf24', paddingLeft: 8 }}>
            ⚠️ fbp/fbc bajos → capturalos como cart attributes en el custom pixel para subir el match quality (mejor atribución).
          </div>
        )}
      </div>

      {/* Feed de últimas compras */}
      <div style={{ margin: '18px 0 8px', fontWeight: 700, fontSize: 13 }}>📦 Últimas compras (server-side)</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {(d.recent || []).length === 0 && <p style={{ opacity: 0.5, fontSize: 12 }}>Sin compras registradas aún.</p>}
        {(d.recent || []).map(r => {
          const icon = r.status === 'sent' ? '✅' : r.status === 'failed' ? '🔴' : '⏳';
          return (
            <div key={r.order_id} style={{ ...card, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14 }}>{icon}</span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>${(r.value || 0).toFixed(2)}</span>
              <span style={{ fontSize: 10, opacity: 0.45, fontFamily: 'monospace' }}>#{r.order_id}</span>
              {r.events_received != null && <span style={{ fontSize: 10, color: '#34d399' }}>recv {r.events_received}</span>}
              <span style={{ fontSize: 9, fontWeight: 700, color: r.has_fbp ? '#34d399' : '#475569', border: `1px solid ${r.has_fbp ? '#34d39955' : '#47556955'}`, borderRadius: 4, padding: '1px 5px' }}>fbp</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: r.has_fbc ? '#34d399' : '#475569', border: `1px solid ${r.has_fbc ? '#34d39955' : '#47556955'}`, borderRadius: 4, padding: '1px 5px' }}>fbc</span>
              {!r.dedup_ok && <span style={{ fontSize: 9, color: '#f87171' }}>⚠ dedup</span>}
              {r.attempts > 1 && <span style={{ fontSize: 10, opacity: 0.5 }}>·{r.attempts} intentos</span>}
              {r.last_error && <span style={{ fontSize: 10, color: '#f87171', flexBasis: '100%' }}>↳ {r.last_error}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ArgosPanel;
