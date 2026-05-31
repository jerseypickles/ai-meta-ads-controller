import { useState, useEffect, useCallback } from 'react';
import { getArgosIntelligence, runArgosApi } from '../api';

const ARGOS = '#22d3ee'; // cyan — "el que todo lo ve"

// 🦚 Argos — análisis del pixel: funnel + salud de eventos.
function ArgosPanel() {
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
          <div style={{ fontSize: 11, opacity: 0.55 }}>Análisis del pixel · funnel + salud</div>
        </div>
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
      </div>

      {loading ? <p style={{ opacity: 0.5, marginTop: 16 }}>Cargando…</p> : !data ? (
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

          {/* Maduración del pixel (clave: pixel nuevo + purchase-only) */}
          {data.maturation && (
            <div style={{ ...card, padding: 12, margin: '14px 0' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>🌱 Maduración del pixel</div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }}>
                <div><b style={{ color: ARGOS }}>{data.maturation.age_days}d</b> <span style={{ opacity: 0.6 }}>de datos</span></div>
                <div><b style={{ color: ARGOS }}>{data.maturation.purchases}</b> <span style={{ opacity: 0.6 }}>compras · {data.maturation.purchases_per_week}/sem</span></div>
                <div><b style={{ color: '#34d399' }}>{data.maturation.success}</b> <span style={{ opacity: 0.6 }}>adsets aprendidos</span></div>
                <div><b style={{ color: '#fbbf24' }}>{data.maturation.in_learning}</b> <span style={{ opacity: 0.6 }}>en learning</span></div>
                {data.maturation.limited > 0 && <div><b style={{ color: '#f87171' }}>{data.maturation.limited}</b> <span style={{ opacity: 0.6 }}>limitados</span></div>}
              </div>
              {/* Por adset: progreso hacia salir de learning */}
              {(data.maturation.adsets || []).length > 0 && (
                <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                  {data.maturation.adsets.map((a, i) => {
                    const conv = a.conversions != null ? a.conversions : 0;
                    const pct = Math.min(100, Math.round((conv / (data.maturation.target || 50)) * 100));
                    const sc = a.status === 'SUCCESS' ? '#34d399' : a.status === 'LEARNING_LIMITED' ? '#f87171' : '#fbbf24';
                    return (
                      <div key={i} style={{ fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{a.name}</span>
                          <span style={{ color: sc, fontWeight: 600 }}>{a.status}{a.conversions != null ? ` · ${conv}/${data.maturation.target}` : ''}</span>
                        </div>
                        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: sc }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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

export default ArgosPanel;
