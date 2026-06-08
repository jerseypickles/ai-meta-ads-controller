import { useState, useEffect, useCallback, useRef } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  getDionysusPending, getDionysusStats, runDionysusApi,
  approveDionysusVideo, rejectDionysusVideo, generateDionysusSources, backfillDionysusVideoJudge, backfillDionysusSignals
} from '../api';

const FUCHSIA = '#ec4899'; // magenta — matchea el orbe de Dionisio en la galaxia (era #c026d3)

// 🎭 Dionisio — cola de videos + DNA (qué motion rinde). Human-in-the-loop.
function DionysusPanel() {
  const [pending, setPending] = useState([]);
  const [genVideos, setGenVideos] = useState([]); // generándose ahora
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState('cola');
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([getDionysusPending(), getDionysusStats().catch(() => null)]);
      setPending(p.pending || []);
      setGenVideos(p.generating || []);
      setStats(s);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const onRun = async () => {
    setRunning(true);
    try { await runDionysusApi(); } catch (e) { console.error(e); }
    // poll mientras genera — los placeholders 'generando' y luego los videos aparecen solos.
    // VIP 1080p puede tardar 20-25min, así que polleamos hasta 28min (no 5).
    const POLL_WINDOW_MS = 28 * 60 * 1000;
    const t0 = Date.now();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      await load();
      if (Date.now() - t0 > POLL_WINDOW_MS) { clearInterval(pollRef.current); setRunning(false); }
    }, 8000);
    setTimeout(() => { if (pollRef.current) clearInterval(pollRef.current); setRunning(false); }, POLL_WINDOW_MS + 1000);
  };

  const [genSources, setGenSources] = useState(false);
  const onGenSources = async () => {
    setGenSources(true);
    try { await generateDionysusSources(); } catch (e) { console.error(e); }
    setTimeout(() => { load(); setGenSources(false); }, 4000);
  };

  const decide = async (id, action) => {
    setBusy(id);
    try {
      if (action === 'approve') await approveDionysusVideo(id);
      else await rejectDionysusVideo(id, 'rechazado en review');
      setPending(p => p.filter(x => x._id !== id));
    } catch (e) { console.error(e); }
    finally { setBusy(null); }
  };

  // Descarga el video. Intenta blob (fuerza descarga); si CORS lo impide, abre en pestaña.
  const downloadVideo = async (url, name) => {
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name || 'dionisio-video').replace(/[^a-z0-9_\-]+/gi, '_') + '.mp4';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { window.open(url, '_blank'); }
  };

  const queueCount = pending.length + genVideos.length;
  const TABS = [
    { k: 'cola', l: '📋 Cola de review', n: queueCount || null },
    { k: 'evolucion', l: '📈 Evolución semanal', n: null },
    { k: 'aprendizaje', l: '🧬 Aprendizaje', n: null },
    { k: 'calibracion', l: '🎯 Calibración del juez', n: null }
  ];

  return (
    <div className="dionysus-panel ag-dionisio" style={{ padding: 2 }}>
      {/* ── HERO ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 14, marginBottom: 14,
        background: `linear-gradient(135deg, color-mix(in srgb, ${FUCHSIA} 16%, transparent), transparent 70%)`,
        border: `1px solid color-mix(in srgb, ${FUCHSIA} 28%, transparent)` }}>
        <div style={{ width: 54, height: 54, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28,
          background: `radial-gradient(circle at 35% 30%, #f9a8d4, ${FUCHSIA})`, boxShadow: `0 0 22px color-mix(in srgb, ${FUCHSIA} 55%, transparent)` }}>🎭</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1,
            background: `linear-gradient(135deg, ${FUCHSIA}, #f9a8d4)`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>DIONISIO</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--bos-text-muted, #94a3b8)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 4 }}>Video Creator · Seedance 2.0 · human-in-the-loop</div>
        </div>
        <button onClick={onGenSources} disabled={genSources} title="Generar imágenes de interacción (mano+chip+salsa) que Dionisio anima"
          style={{ padding: '8px 13px', borderRadius: 8, border: `1px solid color-mix(in srgb, ${FUCHSIA} 40%, transparent)`, fontWeight: 600, cursor: genSources ? 'default' : 'pointer', background: 'transparent', color: FUCHSIA, fontSize: '0.78rem' }}>
          {genSources ? '🎨 Generando…' : '🎨 Fuentes'}
        </button>
        <button onClick={onRun} disabled={running}
          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', fontWeight: 700, cursor: running ? 'default' : 'pointer', fontSize: '0.8rem',
            background: running ? `color-mix(in srgb, ${FUCHSIA} 30%, transparent)` : `linear-gradient(135deg, ${FUCHSIA}, color-mix(in srgb, ${FUCHSIA} 65%, #000))`, color: '#fff' }}>
          {running ? '🎬 Generando…' : '✨ Generar videos'}
        </button>
        <button onClick={load} title="Refrescar" style={{ padding: '8px 11px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#fff', cursor: 'pointer' }}>↻</button>
      </div>

      {/* ── KPI strip ── */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Pool fuentes', value: `${stats.source_pool ?? 0}/${stats.source_pool_target ?? 30}`, color: '#f0abfc' },
            { label: 'Pendientes', value: stats.pending, color: FUCHSIA },
            { label: 'Videos totales', value: stats.total_videos, color: '#a78bfa' },
            { label: 'Testeados', value: stats.tested_count, color: '#34d399' }
          ].map(s => (
            <div key={s.label} style={{ background: `color-mix(in srgb, ${s.color} 8%, rgba(17,21,51,0.5))`, border: `1px solid color-mix(in srgb, ${s.color} 25%, transparent)`, borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, color: s.color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: '0.58rem', opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Generando banner ── */}
      {(running || genVideos.length > 0) && (
        <div style={{ padding: '14px 18px', marginBottom: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14,
          background: `color-mix(in srgb, ${FUCHSIA} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${FUCHSIA} 25%, transparent)` }}>
          <div className="dio-pulse" style={{ width: 14, height: 14, borderRadius: '50%', background: FUCHSIA }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>Dionisio está generando{genVideos.length > 0 ? ` ${genVideos.length} video${genVideos.length > 1 ? 's' : ''}` : ' videos'}…</div>
            <div style={{ fontSize: '0.72rem', opacity: 0.6 }}>Juzga tus mejores imágenes → anima 5s con Seedance 1080p. Puede tardar varios minutos por video; aparecen en la Cola al terminar.</div>
          </div>
        </div>
      )}

      {/* ── TABS ── */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'rgba(10,14,39,0.4)', borderRadius: 10, marginBottom: 16 }}>
        {TABS.map(t => {
          const active = tab === t.k;
          return (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              flex: 1, padding: '8px 6px', borderRadius: 6, cursor: 'pointer', fontSize: '0.72rem', fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
              background: active ? `color-mix(in srgb, ${FUCHSIA} 20%, transparent)` : 'transparent',
              border: active ? `1px solid color-mix(in srgb, ${FUCHSIA} 50%, transparent)` : '1px solid transparent',
              color: active ? '#fff' : 'var(--bos-text-muted, #94a3b8)' }}>
              {t.l}{t.n != null && <span style={{ opacity: 0.6, marginLeft: 4 }}>{t.n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── CONTENT ── */}
      {tab === 'cola' && <ColaSection loading={loading} pending={pending} genVideos={genVideos} busy={busy} decide={decide} downloadVideo={downloadVideo} />}
      {tab === 'evolucion' && <EvolucionSection weekly={stats?.weekly} />}
      {tab === 'aprendizaje' && <DNASection stats={stats} />}
      {tab === 'calibracion' && <CalibracionSection learnings={stats?.learnings} />}

      <style>{`
        @keyframes dioPulse {0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(1.4)}}
        .dio-pulse{animation:dioPulse 1.2s ease-in-out infinite}
        @keyframes dioSpin {0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
        .dio-spin{animation:dioSpin 2.5s linear infinite; display:inline-block}
        @keyframes dioBar {0%{margin-left:-40%}100%{margin-left:100%}}
        .dio-bar{animation:dioBar 1.4s ease-in-out infinite}
      `}</style>
    </div>
  );
}

const card = { background: 'rgba(236,72,153,0.06)', border: '1px solid rgba(236,72,153,0.2)', borderRadius: 12 };

// ── TAB: Cola de review ──
function ColaSection({ loading, pending, genVideos, busy, decide, downloadVideo }) {
  if (loading) return <p style={{ opacity: 0.5 }}>Cargando…</p>;
  if (pending.length === 0 && genVideos.length === 0) {
    return (
      <div style={{ ...card, padding: 28, textAlign: 'center', opacity: 0.6 }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>🎬</div>
        Sin videos pendientes. Dale <b>"Generar videos"</b> para crear desde tus winners.
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
      {genVideos.map(g => (
        <div key={g._id} style={{ ...card, overflow: 'hidden', padding: 0 }}>
          <div style={{ width: '100%', aspectRatio: '9/16', background: `linear-gradient(135deg, color-mix(in srgb, ${FUCHSIA} 18%, transparent), transparent)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <div style={{ fontSize: 26 }} className="dio-spin">🎬</div>
            <div style={{ fontSize: 11, color: FUCHSIA, fontWeight: 600 }}>generando…</div>
            <div style={{ width: '60%', height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
              <div className="dio-bar" style={{ height: '100%', background: FUCHSIA, width: '40%' }} />
            </div>
          </div>
          <div style={{ padding: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{g.headline}</div>
            <div style={{ fontSize: 10, opacity: 0.55 }}>{g.product_name} · <span style={{ color: FUCHSIA }}>{g.motion_variant}</span>{g.video_judge_score != null ? ` · score ${g.video_judge_score}` : ''}</div>
          </div>
        </div>
      ))}
      {pending.map(v => (
        <div key={v._id} style={{ ...card, overflow: 'hidden', padding: 0 }}>
          <video src={v.video_url} controls loop muted playsInline style={{ width: '100%', display: 'block', aspectRatio: '9/16', objectFit: 'cover', background: '#000' }} />
          <div style={{ padding: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{v.headline}</div>
            <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 8 }}>{v.product_name} · <span style={{ color: FUCHSIA }}>{v.motion_variant}</span></div>
            <JudgeVerdict v={v} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => decide(v._id, 'approve')} disabled={busy === v._id} style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>{busy === v._id ? '…' : '✓ Aprobar'}</button>
              <button onClick={() => downloadVideo(v.video_url, `${v.product_name || 'dionisio'}-${v.motion_variant || ''}`)} title="Descargar video" style={{ padding: '7px 12px', borderRadius: 6, border: `1px solid color-mix(in srgb, ${FUCHSIA} 40%, transparent)`, background: 'transparent', color: FUCHSIA, cursor: 'pointer' }}>⬇</button>
              <button onClick={() => decide(v._id, 'reject')} disabled={busy === v._id} style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>✗</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── TAB: Aprendizaje (DNA por dimensión) ──
function DNASection({ stats }) {
  const dims = [{ key: 'motion', label: 'Motion (interacción)' }, { key: 'hook', label: 'Hook (gancho 1-2s)' }, { key: 'camera', label: 'Cámara' }, { key: 'scene', label: 'Escena' }];
  const byDim = stats?.dna_by_dimension;
  const hasAny = byDim && dims.some(d => (byDim[d.key] || []).length);
  return (
    <div>
      <div style={{ marginBottom: 10, fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        🧬 Lo que Dionisio aprende <span style={{ fontWeight: 400, opacity: 0.5, fontSize: 11 }}>(qué rinde en cada dimensión · exploit/explore)</span>
      </div>
      {!hasAny ? (
        <div style={{ ...card, padding: 16, fontSize: 12, opacity: 0.65 }}>
          Todavía sin data — el DNA se construye a medida que Prometheus testea los videos. Vas a ver acá qué <b>motion</b>, <b>cámara</b> y <b>escena</b> traen mejor CTR/hold/ROAS, y Dionisio genera más del ganador.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, alignItems: 'start' }}>
          {dims.map(dim => {
            const all = (byDim[dim.key] || []).slice().sort((a, b) => (b.tested || 0) - (a.tested || 0));
            if (!all.length) return null;
            const rows = all.slice(0, 6); const extra = all.length - rows.length;
            return (
              <div key={dim.key} style={{ ...card, padding: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.7, padding: '4px 8px' }}>{dim.label}</div>
                <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <thead><tr style={{ opacity: 0.55, textAlign: 'left' }}>
                    <th style={{ padding: '5px 6px' }}>Valor</th><th style={{ width: 34 }}>Test</th><th style={{ width: 44 }}>CTR</th><th style={{ width: 42 }} title="% que ve el video completo">Hold</th><th style={{ width: 44 }}>ROAS</th><th style={{ width: 38 }}>Win</th>
                  </tr></thead>
                  <tbody>
                    {rows.map(d => (
                      <tr key={d.variant} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '5px 6px', fontWeight: 600, color: FUCHSIA, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.variant}>{d.variant}</td>
                        <td>{d.tested}</td><td>{d.avg_ctr}%</td>
                        <td style={{ color: d.avg_hold >= 10 ? '#34d399' : '#cbd5e1' }}>{d.avg_hold ?? 0}%</td>
                        <td style={{ color: d.avg_roas >= 2 ? '#34d399' : '#f87171' }}>{d.avg_roas}x</td>
                        <td>{d.win_rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {extra > 0 && <div style={{ fontSize: 10, opacity: 0.45, padding: '4px 8px' }}>+{extra} más</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BackfillButton() {
  const [state, setState] = useState('idle'); // idle | running | done
  const run = async () => {
    setState('running');
    try { await backfillDionysusVideoJudge(); setState('done'); } catch { setState('idle'); }
  };
  if (state === 'done') {
    return <div style={{ fontSize: '0.66rem', marginTop: 8, color: '#34d399' }}>✓ Backfill corriendo en background — Gemini está juzgando los videos existentes. Refrescá (↻) en unos minutos y vas a ver el juez de video poblarse.</div>;
  }
  return (
    <button onClick={run} disabled={state === 'running'} style={{ marginTop: 10, padding: '8px 14px', borderRadius: 8, border: `1px solid ${FUCHSIA}`, background: `color-mix(in srgb, ${FUCHSIA} 18%, transparent)`, color: '#fff', fontWeight: 600, fontSize: '0.74rem', cursor: state === 'running' ? 'default' : 'pointer' }}>
      {state === 'running' ? '🎬 Lanzando…' : '🎬 Correr juez de video (Gemini) sobre los existentes'}
    </button>
  );
}

// ── TAB: Calibración del juez (el reconciliador) ──
const SIGNAL_LABELS = {
  hook_strength: 'Hook Strength', curiosity_gap: 'Curiosity Gap', food_craving: 'Food Craving',
  visual_energy: 'Visual Energy', visual_contrast: 'Visual Contrast', clarity: 'Clarity',
  production_quality: 'Production Quality', authenticity: 'Authenticity', motion_intensity: 'Motion Intensity'
};
const cColor = c => c == null ? '#64748b' : c >= 0.6 ? '#34d399' : c >= 0.4 ? '#60a5fa' : c >= 0.2 ? '#fbbf24' : '#f87171';
const corrLabel = c => c == null ? 'sin data' : c >= 0.6 ? 'Fuerte' : c >= 0.4 ? 'Moderada' : c >= 0.2 ? 'Débil' : 'Nula';

function CalibracionSection({ learnings }) {
  if (!learnings) {
    return (
      <div style={{ ...card, padding: 20, fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 }}>
        🎯 Sin calibración aún. El <b>reconciliador</b> cruza la predicción del juez + las señales creativas contra el resultado real. Necesita videos firmes para arrancar.
      </div>
    );
  }
  const j = learnings.judge || {};
  const sigRank = learnings.signal_rank || [];
  const motions = learnings.motion_rank || [];
  const settled = learnings.settled_count || 0;
  const sigCount = learnings.signals_count || 0;
  // derivados
  // poder predictivo = promedio del |corr| (una señal de corr -0.3 SÍ predice, inversamente)
  const corrs = sigRank.map(s => s.corr).filter(c => c != null);
  const avgCorr = corrs.length ? corrs.reduce((a, b) => a + Math.abs(b), 0) / corrs.length : null;
  const best = sigRank[0];
  const confidence = Math.round(Math.min(100, (Math.min(1, settled / 30) * 45) + (Math.min(1, sigCount / 25) * 30) + ((avgCorr || 0) * 25)));

  const Kpi = ({ label, value, sub, color = FUCHSIA }) => (
    <div style={{ ...card, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.56rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.55 }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.6rem', opacity: 0.6, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const JudgeCard = ({ icon, title, sub, c }) => (
    <div style={{ ...card, padding: '14px 16px' }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 700 }}>{icon} {title}</div>
      <div style={{ fontSize: '0.58rem', opacity: 0.5, marginBottom: 10 }}>{sub}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `conic-gradient(${cColor(c)} ${Math.max(0, Math.min(1, c || 0)) * 360}deg, rgba(255,255,255,0.08) 0deg)` }}>
          <div style={{ width: 50, height: 50, borderRadius: '50%', background: 'var(--bg-secondary, #0f1330)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, fontSize: '0.9rem', color: cColor(c) }}>{c ?? '—'}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: cColor(c) }}>{corrLabel(c)}</div>
          <div style={{ fontSize: '0.64rem', opacity: 0.6, lineHeight: 1.4, marginTop: 2 }}>
            {c == null ? 'esperando videos asentados para calibrar.' : c >= 0.4 ? 'predice razonablemente el resultado real.' : 'predicción débil — el juez necesita afinar criterio.'}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1.1rem', fontWeight: 800, background: `linear-gradient(135deg, ${FUCHSIA}, #f9a8d4)`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>🎯 Calibración del Juez</span>
        <span style={{ fontSize: '0.66rem', opacity: 0.55 }}>Reconciliado de <b style={{ color: FUCHSIA }}>{settled}</b> videos firmes · juez + señales creativas ↔ resultado real</span>
        {learnings.generated_at && (
          <span style={{ marginLeft: 'auto', fontSize: '0.6rem', opacity: 0.45 }}>↻ actualizado hace {Math.max(0, Math.round((Date.now() - new Date(learnings.generated_at)) / 60000))} min</span>
        )}
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <Kpi label="Precisión predictiva" value={avgCorr != null ? `${Math.round(avgCorr * 100)}%` : '—'} sub="prom. de señales" color="#a78bfa" />
        <Kpi label="Correlación prom." value={avgCorr != null ? avgCorr.toFixed(2) : '—'} sub={corrLabel(avgCorr)} color={cColor(avgCorr)} />
        <Kpi label="Mejor señal" value={best ? (SIGNAL_LABELS[best.signal] || best.signal).split(' ')[0] : '—'} sub={best ? `corr ${best.corr}` : 'sin data'} color="#34d399" />
        <Kpi label="Videos evaluados" value={settled} sub={`${sigCount} con señales`} color="#f0abfc" />
        <Kpi label="Confianza" value={`${confidence}%`} sub={confidence >= 60 ? 'alta' : confidence >= 35 ? 'media' : 'baja'} color="#60a5fa" />
      </div>

      {/* Jueces */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <JudgeCard icon="🖼️" title="Juez de imagen · Claude" sub="predice desde la foto-fuente" c={j.score_corr} />
        <JudgeCard icon="🎬" title="Juez de video · Gemini" sub="predice desde el mp4 (movimiento)" c={j.video_score_corr} />
      </div>

      {/* Señales que más explican el outcome */}
      <div style={{ ...card, padding: '12px 14px' }}>
        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6, marginBottom: 8 }}>📊 Señales que más explican el outcome</div>
        {sigRank.length === 0 ? (
          <div style={{ fontSize: '0.72rem', opacity: 0.6, padding: '6px 0 10px' }}>Aún sin señales asentadas (≥6 videos puntuados + con outcome). Generalas con el botón de abajo.</div>
        ) : (
          <div>
            {sigRank.map(s => (
              <div key={s.signal} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: '0.74rem' }}>
                <span style={{ width: 130, color: 'var(--text-secondary)' }}>{SIGNAL_LABELS[s.signal] || s.signal}</span>
                <span style={{ width: 40, fontFamily: 'JetBrains Mono, monospace', color: cColor(s.corr), fontWeight: 700 }}>{s.corr}</span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3 }}>
                  <div style={{ width: `${Math.max(0, Math.min(1, s.corr)) * 100}%`, height: '100%', background: cColor(s.corr), borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 8 }}><SignalsButton /></div>
      </div>

      {/* Hooks / patrones (motions) que funcionan */}
      <div style={{ ...card, padding: 8 }}>
        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6, padding: '4px 6px 8px' }}>🎬 Patrones que más funcionan (motions ↔ outcome real)</div>
        {motions.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.6, padding: 10 }}>Aún sin motions con suficiente data (≥3 firmes c/u).</div>
        ) : (
          <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead><tr style={{ opacity: 0.55, textAlign: 'left' }}>
              <th style={{ padding: '5px 8px' }}>Motion</th><th style={{ width: 70 }}>Outcome</th><th style={{ width: 50 }}>Hold</th><th style={{ width: 70 }}>Grad/Test</th><th style={{ width: 40 }}>Kill</th>
            </tr></thead>
            <tbody>
              {motions.map((r, i) => (
                <tr key={r.key} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600, color: i === 0 ? '#34d399' : FUCHSIA }}>{i === 0 ? '👑 ' : ''}{r.key}</td>
                  <td style={{ fontFamily: 'JetBrains Mono, monospace', color: r.avg_outcome >= 50 ? '#34d399' : r.avg_outcome >= 20 ? '#fbbf24' : '#f87171' }}>{r.avg_outcome}</td>
                  <td>{r.avg_hold}%</td>
                  <td style={{ color: '#34d399' }}>{r.graduated}/{r.n}</td>
                  <td style={{ color: r.killed ? '#f87171' : '#64748b' }}>{r.killed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Impacto de señales por patrón (la receta del ganador) */}
      {(() => {
        const topMotion = motions[0]?.key;
        const prof = (learnings.pattern_signals || {})[topMotion] || [];
        if (!prof.length) return null;
        const maxAbs = Math.max(...prof.map(p => Math.abs(p.lift)), 1);
        return (
          <div style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6, marginBottom: 4 }}>🔬 Impacto de señales · <b style={{ color: '#34d399' }}>{topMotion}</b></div>
            <div style={{ fontSize: '0.58rem', opacity: 0.5, marginBottom: 10 }}>qué señales ELEVA este patrón ganador vs el promedio (su receta creativa)</div>
            {prof.slice(0, 7).map(p => {
              const col = p.lift >= 0 ? '#34d399' : '#f87171';
              return (
                <div key={p.signal} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: '0.72rem' }}>
                  <span style={{ width: 130, color: 'var(--text-secondary)' }}>{SIGNAL_LABELS[p.signal] || p.signal}</span>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 10 }}>
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>{p.lift < 0 && <div style={{ width: `${Math.abs(p.lift) / maxAbs * 100}%`, height: 6, background: col, borderRadius: 3 }} />}</div>
                    <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.2)' }} />
                    <div style={{ flex: 1 }}>{p.lift >= 0 && <div style={{ width: `${p.lift / maxAbs * 100}%`, height: 6, background: col, borderRadius: 3 }} />}</div>
                  </div>
                  <span style={{ width: 36, textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: col, fontWeight: 700 }}>{p.lift >= 0 ? '+' : ''}{p.lift}</span>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Footer: insights + recomendación + próxima acción */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <div style={{ ...card, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.66rem', fontWeight: 700, color: FUCHSIA, marginBottom: 6 }}>⭐ Insight clave</div>
          <div style={{ fontSize: '0.7rem', lineHeight: 1.45, opacity: 0.85 }}>
            {best ? <>La señal <b>{SIGNAL_LABELS[best.signal] || best.signal}</b> es el predictor #1 (corr {best.corr}){sigRank[1] && <>, seguida de <b>{SIGNAL_LABELS[sigRank[1].signal]}</b> ({sigRank[1].corr})</>}. Eso explica el outcome más que cualquier motion.</> : 'Aún juntando señales para el primer insight.'}
          </div>
        </div>
        <div style={{ ...card, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.66rem', fontWeight: 700, color: '#34d399', marginBottom: 6 }}>⚡ Recomendación auto</div>
          <div style={{ fontSize: '0.7rem', lineHeight: 1.45, opacity: 0.85 }}>
            {best && motions[0] ? <>Priorizá generar <b>{motions[0].key}</b> maximizando <b>{SIGNAL_LABELS[best.signal]}</b>. El director creativo ya recibe esta guía automáticamente.</> : 'Esperando data para recomendar.'}
          </div>
        </div>
        <div style={{ ...card, padding: '12px 14px' }}>
          <div style={{ fontSize: '0.66rem', fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>🎯 Próxima acción</div>
          <div style={{ fontSize: '0.7rem', lineHeight: 1.45, opacity: 0.85 }}>
            {motions[0] ? <>Generar variantes de <b>{motions[0].key}</b> con ángulos nuevos + curiosidad alta, testear en audiencias frías.</> : 'Generar más videos para llenar la calibración.'}
          </div>
        </div>
      </div>
    </div>
  );
}

function SignalsButton() {
  const [state, setState] = useState('idle');
  const run = async () => {
    setState('running');
    try { await backfillDionysusSignals(); setState('done'); } catch { setState('idle'); }
  };
  if (state === 'done') return <div style={{ fontSize: '0.66rem', color: '#34d399' }}>✓ Extrayendo señales en background — refrescá (↻) en unos minutos.</div>;
  return (
    <button onClick={run} disabled={state === 'running'} style={{ padding: '7px 13px', borderRadius: 8, border: `1px solid ${FUCHSIA}`, background: `color-mix(in srgb, ${FUCHSIA} 18%, transparent)`, color: '#fff', fontWeight: 600, fontSize: '0.72rem', cursor: state === 'running' ? 'default' : 'pointer' }}>
      {state === 'running' ? '📊 Lanzando…' : '📊 Extraer señales creativas de los videos'}
    </button>
  );
}

// ── TAB: Evolución semanal (la prueba de mejora semana a semana) ──
function EvolucionSection({ weekly }) {
  if (!weekly || weekly.length === 0) {
    return (
      <div style={{ ...card, padding: 20, fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 }}>
        📈 Sin data semanal aún. A medida que corran videos por semana, vas a ver acá el <b>% de positivos</b> (graduó o convirtió) semana a semana y el <b>Δ vs la semana anterior</b> — la prueba de que el loop mejora.
      </div>
    );
  }
  const fmtWk = w => 'S' + ((w || '').split('-W')[1] || w);
  const last = weekly[weekly.length - 1];
  const dpos = last.delta_positive;
  const series = weekly.map(w => ({ ...w, wk: fmtWk(w.week) }));
  const dColor = d => d == null ? '#64748b' : d > 0 ? '#34d399' : d < 0 ? '#f87171' : '#94a3b8';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Headline: esta semana vs anterior */}
      <div style={{ ...card, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.55 }}>Esta semana · {fmtWk(last.week)}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: '2.4rem', fontWeight: 800, color: FUCHSIA, fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>{last.pct_positive}%</span>
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>positivos</span>
            {dpos != null && (
              <span style={{ fontSize: '0.95rem', fontWeight: 700, color: dColor(dpos) }}>
                {dpos > 0 ? '▲ +' : dpos < 0 ? '▼ ' : '= '}{dpos} pts
                <span style={{ fontSize: '0.6rem', opacity: 0.7, fontWeight: 400 }}> vs sem. anterior</span>
              </span>
            )}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 18, textAlign: 'right' }}>
          <div><div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#34d399', fontFamily: 'JetBrains Mono, monospace' }}>{last.win_rate ?? '—'}%</div><div style={{ fontSize: '0.54rem', opacity: 0.55, textTransform: 'uppercase' }}>win rate</div></div>
          <div><div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#a78bfa', fontFamily: 'JetBrains Mono, monospace' }}>{last.avg_outcome}</div><div style={{ fontSize: '0.54rem', opacity: 0.55, textTransform: 'uppercase' }}>outcome</div></div>
          <div><div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f0abfc', fontFamily: 'JetBrains Mono, monospace' }}>{last.n}</div><div style={{ fontSize: '0.54rem', opacity: 0.55, textTransform: 'uppercase' }}>videos</div></div>
        </div>
      </div>

      {/* Chart */}
      <div style={{ ...card, padding: '14px 12px 6px', height: 240 }}>
        <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6, marginBottom: 8, paddingLeft: 6 }}>% positivos &amp; win-rate por semana</div>
        <ResponsiveContainer width="100%" height="88%">
          <ComposedChart data={series} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="wk" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={34} domain={[0, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip contentStyle={{ background: '#0f1117', border: '1px solid #2d3244', borderRadius: 8, fontSize: 11 }}
              formatter={(val, name) => [`${val}%`, name === 'pct_positive' ? '% positivos' : 'win rate']} />
            <Bar dataKey="pct_positive" fill={FUCHSIA} fillOpacity={0.55} radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="win_rate" stroke="#34d399" strokeWidth={2} dot={{ r: 3, fill: '#34d399' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla */}
      <div style={{ ...card, padding: 6 }}>
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
          <thead><tr style={{ opacity: 0.55, textAlign: 'left' }}>
            <th style={{ padding: '5px 8px' }}>Semana</th><th style={{ width: 54 }}>Videos</th><th style={{ width: 54 }}>% Pos</th><th style={{ width: 56 }}>Δ pos</th><th style={{ width: 50 }}>Win</th><th style={{ width: 64 }}>Outcome</th><th style={{ width: 48 }}>Hold</th>
          </tr></thead>
          <tbody>
            {series.slice().reverse().map(w => (
              <tr key={w.week} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{w.wk}</td>
                <td>{w.n}</td>
                <td style={{ color: FUCHSIA, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{w.pct_positive}%</td>
                <td style={{ color: dColor(w.delta_positive), fontFamily: 'JetBrains Mono, monospace' }}>{w.delta_positive != null ? (w.delta_positive > 0 ? '+' : '') + w.delta_positive : '—'}</td>
                <td>{w.win_rate ?? '—'}%</td>
                <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>{w.avg_outcome}</td>
                <td>{w.avg_hold}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: '0.62rem', opacity: 0.5 }}>Positivo = el video graduó o convirtió (≥1 compra). El objetivo es que el % positivos suba semana a semana, aunque sea de a poco.</div>
    </div>
  );
}

// Veredicto del juez de video, expandible (¿la gente real engancha?)
const VERDICT_DIMS = {
  fidelidad: 'Fidelidad', freno_scroll: 'Freno scroll', apetito: 'Apetito',
  autenticidad: 'Autenticidad', calidad: 'Calidad'
};
function JudgeVerdict({ v }) {
  const [open, setOpen] = useState(false);
  const score = v.video_judge_score;
  if (score == null) return null;
  const bd = v.video_judge_breakdown || {};
  const dims = bd.breakdown || null;
  const sc = (n) => (n >= 80 ? '#34d399' : n >= 60 ? '#fbbf24' : '#f87171');
  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'rgba(255,255,255,0.04)', border: `1px solid ${sc(score)}40`, borderRadius: 6,
        padding: '6px 9px', cursor: 'pointer', color: '#e5e7eb'
      }}>
        <span style={{ fontSize: 11 }}>Veredicto <span style={{ opacity: 0.5 }}>(¿engancha a la gente?)</span></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <b style={{ color: sc(score), fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>{score}</b>
          <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', fontSize: 10, opacity: 0.6 }}>▾</span>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: 'rgba(0,0,0,0.25)', borderRadius: 6, fontSize: 11 }}>
          {bd.reason && <div style={{ fontStyle: 'italic', opacity: 0.8, marginBottom: 8 }}>“{bd.reason}”</div>}
          {dims ? Object.keys(VERDICT_DIMS).filter(k => dims[k]).map(k => {
            const d = dims[k]; const c = sc(d.score);
            return (
              <div key={k} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                  <span>{VERDICT_DIMS[k]}</span>
                  <b style={{ color: c, fontFamily: 'JetBrains Mono, monospace' }}>{d.score}</b>
                </div>
                <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, margin: '2px 0 3px' }}>
                  <div style={{ width: `${Math.max(0, Math.min(100, d.score))}%`, height: '100%', background: c, borderRadius: 2 }} />
                </div>
                {d.note && <div style={{ fontSize: 10, opacity: 0.6 }}>{d.note}</div>}
              </div>
            );
          }) : <div style={{ opacity: 0.5 }}>Sin desglose (video previo al fix del juez).</div>}
          {(bd.que_funciona || []).length > 0 && (
            <div style={{ marginTop: 6 }}>{bd.que_funciona.map((s, i) => <div key={i} style={{ color: '#34d399', fontSize: 10 }}>✓ {s}</div>)}</div>
          )}
          {(bd.que_falla || []).length > 0 && (
            <div style={{ marginTop: 4 }}>{bd.que_falla.map((s, i) => <div key={i} style={{ color: '#f87171', fontSize: 10 }}>✗ {s}</div>)}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default DionysusPanel;
