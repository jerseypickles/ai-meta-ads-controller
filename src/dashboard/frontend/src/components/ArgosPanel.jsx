import { useState, useEffect, useCallback } from 'react';
import { getArgosIntelligence, runArgosApi, getArgosCapiStats } from '../api';

const ARGOS = '#22d3ee'; // cyan — "el que todo lo ve"

// 🦚 Argos — análisis del pixel: funnel + salud de eventos + envío server-side (CAPI).
function ArgosPanel() {
  const [tab, setTab] = useState('pixel'); // 'pixel' | 'capi'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(async (d) => {
    setLoading(true);
    try { setData(await getArgosIntelligence(d)); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  const onRun = async () => {
    setRunning(true);
    try { await runArgosApi(); } catch (e) { console.error(e); }
    setTimeout(() => { load(days); setRunning(false); }, 8000);
  };

  const card = { background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.2)', borderRadius: 12 };
  const f = data?.funnel_7d || {};
  const rates = data?.rates || {};
  const health = data?.health_score ?? 0;
  const healthColor = health >= 80 ? '#34d399' : health >= 50 ? '#fbbf24' : '#f87171';

  // Pasos del funnel REAL del pixel con su tasa hacia el siguiente.
  const steps = [
    { key: 'page_view', label: 'PageView', rateAfter: rates.pv_to_vc },
    { key: 'view_content', label: 'View content', rateAfter: rates.vc_to_atc },
    { key: 'add_to_cart', label: 'Add to cart', rateAfter: rates.atc_to_ic },
    { key: 'initiate_checkout', label: 'Initiate checkout', rateAfter: rates.ic_to_purchase },
    { key: 'purchase', label: 'Purchase', rateAfter: null }
  ];
  const maxVal = Math.max(1, ...steps.map(s => f[s.key] || 0));
  const pm = data?.pixel_meta || {};
  const lastFired = pm.last_fired_time ? new Date(pm.last_fired_time) : null;
  const firedAgoMin = lastFired ? Math.round((Date.now() - lastFired.getTime()) / 60000) : null;

  return (
    <div style={{ padding: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <span style={{ fontSize: 26 }}>🦚</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: ARGOS }}>Argos</div>
          <div style={{ fontSize: 11, opacity: 0.55 }}>Análisis del pixel · funnel + salud + server-side</div>
        </div>
        {tab === 'pixel' && (
          <>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, marginRight: 8 }}>
              {[7, 14, 30].map(d => (
                <button key={d} onClick={() => setDays(d)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${days === d ? ARGOS : 'rgba(255,255,255,0.15)'}`,
                           background: days === d ? `${ARGOS}22` : 'transparent', color: days === d ? ARGOS : '#94a3b8', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                  {d}d
                </button>
              ))}
            </div>
            <button onClick={onRun} disabled={running}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 700, cursor: running ? 'default' : 'pointer',
                       background: running ? 'rgba(34,211,238,0.3)' : ARGOS, color: '#06262b' }}>
              {running ? '👁 Analizando…' : '👁 Analizar pixel'}
            </button>
          </>
        )}
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 6, margin: '14px 0 4px' }}>
        {[{ k: 'pixel', label: '🔻 Pixel & funnel' }, { k: 'capi', label: '📡 Server-side / CAPI' }].map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${tab === t.k ? ARGOS : 'rgba(255,255,255,0.12)'}`,
                     background: tab === t.k ? `${ARGOS}1f` : 'transparent', color: tab === t.k ? ARGOS : '#94a3b8',
                     fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'capi' ? <CapiView /> :
       loading ? <p style={{ opacity: 0.5, marginTop: 16 }}>Cargando…</p> : !data ? (
        <p style={{ opacity: 0.5, marginTop: 16 }}>Sin data — dale "Analizar pixel".</p>
      ) : (
        <>
          {/* Health score */}
          <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
            <div style={{ ...card, flex: '0 0 130px', padding: '14px', textAlign: 'center' }}>
              <div style={{ fontSize: 34, fontWeight: 800, color: healthColor }}>{health}</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>Pixel health</div>
            </div>
            <div style={{ ...card, flex: 1, padding: '14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>Pixel · {data.window_days || days} días</div>
              <div style={{ fontSize: 13 }}>
                {(f.page_view || 0).toLocaleString()} PageView → <b style={{ color: ARGOS }}>{(f.purchase || 0).toLocaleString()}</b> compras
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                {firedAgoMin != null
                  ? <>último evento hace {firedAgoMin < 60 ? `${firedAgoMin}m` : `${Math.round(firedAgoMin / 60)}h`} {firedAgoMin <= 180 ? '🟢' : '🔴'}</>
                  : 'sin data de frescura'}
                {pm.is_unavailable && <span style={{ color: '#f87171', marginLeft: 8 }}>· pixel NO disponible</span>}
                {data.stale && <span style={{ color: '#fbbf24', marginLeft: 8 }}>· cache</span>}
              </div>
            </div>
          </div>

          {/* Maduración del PIXEL — cuánta señal de conversión acumuló */}
          {data.maturation && (() => {
            const m = data.maturation;
            const lvl = m.signal_level;
            const lvlColor = lvl === 'mature' ? '#34d399' : lvl === 'warming' ? '#fbbf24' : '#f87171';
            const lvlLabel = lvl === 'mature' ? 'MADURO' : lvl === 'warming' ? 'CALENTANDO' : 'FRÍO (poca señal)';
            const evs = [
              { key: 'purchase', label: 'Purchase', target: m.target_per_week },
              { key: 'add_to_cart', label: 'Add to cart', target: m.target_per_week },
              { key: 'initiate_checkout', label: 'Initiate checkout', target: m.target_per_week }
            ];
            return (
              <div style={{ ...card, padding: 12, margin: '14px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>🌱 Maduración del pixel</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>{m.age_days}d de datos</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: lvlColor, border: `1px solid ${lvlColor}`, borderRadius: 6, padding: '2px 8px' }}>{lvlLabel}</span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
                  Señal de conversión por semana vs el umbral que Meta necesita (~{m.target_per_week}/sem) para optimizar bien.
                </div>
                <div style={{ display: 'grid', gap: 7 }}>
                  {evs.map(e => {
                    const v = m.per_week?.[e.key] || 0;
                    const pct = Math.min(100, Math.round((v / e.target) * 100));
                    const c = pct >= 100 ? '#34d399' : pct >= 30 ? '#fbbf24' : '#f87171';
                    return (
                      <div key={e.key} style={{ fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ opacity: 0.85 }}>{e.label}</span>
                          <span style={{ color: c, fontWeight: 600 }}>{v}/sem <span style={{ opacity: 0.5 }}>de ~{e.target}</span></span>
                        </div>
                        <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: c }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Diagnóstico fundamentado (Claude) */}
          {data.diagnosis && (
            <div style={{ ...card, padding: '12px 14px', margin: '12px 0', borderLeft: `3px solid ${ARGOS}` }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: ARGOS, marginBottom: 6 }}>🦚 Diagnóstico de Argos</div>
              <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{data.diagnosis}</div>
            </div>
          )}

          {/* Funnel */}
          <div style={{ margin: '16px 0 8px', fontWeight: 700, fontSize: 13 }}>🔻 Funnel & drop-off ({data.window_days || days}d)</div>
          <div style={{ ...card, padding: 12 }}>
            {steps.map((s, i) => {
              const val = f[s.key] || 0;
              const pct = Math.round((val / maxVal) * 100);
              const lowRate = s.rateAfter != null && s.rateAfter < 30 && val > 0;
              return (
                <div key={s.key} style={{ marginBottom: i < steps.length - 1 ? 4 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 130, fontSize: 12, opacity: 0.8 }}>{s.label}</div>
                    <div style={{ flex: 1, height: 22, background: 'rgba(255,255,255,0.05)', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${ARGOS}, ${ARGOS}99)`, borderRadius: 5, transition: 'width .4s' }} />
                    </div>
                    <div style={{ width: 70, textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{val.toLocaleString()}</div>
                  </div>
                  {s.rateAfter != null && (
                    <div style={{ marginLeft: 130, fontSize: 10, color: lowRate ? '#f87171' : 'var(--bos-text-dim, #94a3b8)', padding: '1px 0 3px 10px' }}>
                      ↓ {s.rateAfter}% {lowRate ? '⚠️' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Issues */}
          <div style={{ margin: '18px 0 8px', fontWeight: 700, fontSize: 13 }}>🔎 Diagnóstico</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {(data.issues || []).map((it, i) => {
              const c = it.severity === 'critical' ? '#f87171' : it.severity === 'warning' ? '#fbbf24' : '#34d399';
              const icon = it.severity === 'critical' ? '🔴' : it.severity === 'warning' ? '🟡' : '🟢';
              return (
                <div key={i} style={{ ...card, padding: '10px 12px', borderLeft: `3px solid ${c}` }}>
                  <div style={{ fontSize: 13 }}>{icon} {it.message}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
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
    <div style={{ marginTop: 8 }}>
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
