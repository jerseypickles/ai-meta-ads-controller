import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getDionysusPending, getDionysusStats, runDionysusApi,
  approveDionysusVideo, rejectDionysusVideo, generateDionysusSources
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

  const card = { background: 'rgba(192,38,211,0.06)', border: `1px solid rgba(192,38,211,0.2)`, borderRadius: 12 };

  return (
    <div className="dionysus-panel" style={{ padding: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <span style={{ fontSize: 26 }}>🎭</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: FUCHSIA }}>Dionisio</div>
          <div style={{ fontSize: 11, opacity: 0.55 }}>Video · Seedance 2.0</div>
        </div>
        <button onClick={onGenSources} disabled={genSources} title="Generar imágenes de interacción (mano+chip+salsa) que Dionisio anima"
          style={{ marginLeft: 'auto', padding: '9px 14px', borderRadius: 8, border: '1px solid rgba(192,38,211,0.4)', fontWeight: 600, cursor: genSources ? 'default' : 'pointer',
                   background: 'transparent', color: FUCHSIA }}>
          {genSources ? '🎨 Generando…' : '🎨 Fuentes'}
        </button>
        <button onClick={onRun} disabled={running}
          style={{ padding: '9px 18px', borderRadius: 8, border: 'none', fontWeight: 700, cursor: running ? 'default' : 'pointer',
                   background: running ? 'rgba(192,38,211,0.3)' : FUCHSIA, color: '#fff' }}>
          {running ? '🎬 Generando…' : '✨ Generar videos'}
        </button>
        <button onClick={load} title="Refrescar" style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#fff', cursor: 'pointer' }}>↻</button>
      </div>

      {/* Stat strip */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
          {[
            { label: 'Pool fuentes', value: `${stats.source_pool ?? 0}/${stats.source_pool_target ?? 30}`, color: '#f0abfc' },
            { label: 'Pendientes', value: stats.pending, color: FUCHSIA },
            { label: 'Videos totales', value: stats.total_videos, color: '#a78bfa' },
            { label: 'Testeados', value: stats.tested_count, color: '#34d399' }
          ].map(s => (
            <div key={s.label} style={{ ...card, flex: 1, padding: '12px 14px' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Generando — banner animado */}
      {(running || genVideos.length > 0) && (
        <div style={{ ...card, padding: '16px 18px', margin: '12px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="dio-pulse" style={{ width: 14, height: 14, borderRadius: '50%', background: FUCHSIA }} />
          <div>
            <div style={{ fontWeight: 600 }}>
              Dionisio está generando{genVideos.length > 0 ? ` ${genVideos.length} video${genVideos.length > 1 ? 's' : ''}` : ' videos'}…
            </div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>Juzga tus mejores imágenes → anima 5s con Seedance 1080p. Puede tardar varios minutos por video (HD); van apareciendo abajo a medida que terminan.</div>
          </div>
        </div>
      )}

      {/* DNA — qué aprende (3 dimensiones: motion / cámara / escena) */}
      <div style={{ margin: '18px 0 10px', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        🧬 Lo que Dionisio aprende <span style={{ fontWeight: 400, opacity: 0.5, fontSize: 11 }}>(qué rinde mejor en cada dimensión · exploit/explore)</span>
      </div>
      {(() => {
        const dims = [
          { key: 'motion', label: 'Motion (interacción)' },
          { key: 'camera', label: 'Cámara' },
          { key: 'scene', label: 'Escena' }
        ];
        const byDim = stats?.dna_by_dimension;
        const hasAny = byDim && dims.some(d => (byDim[d.key] || []).length);
        if (!hasAny) {
          return (
            <div style={{ ...card, padding: 14, fontSize: 12, opacity: 0.6 }}>
              Todavía sin data — el DNA se construye a medida que los videos se testean. Cuando Prometheus testee los primeros, vas a ver acá qué <b>motion</b>, qué <b>cámara</b> y qué <b>escena</b> traen mejor CTR/ROAS, y Dionisio va a generar más del ganador.
            </div>
          );
        }
        const CAP = 5;
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10, alignItems: 'start' }}>
            {dims.map(dim => {
              const all = (byDim[dim.key] || []).slice().sort((a, b) => (b.tested || 0) - (a.tested || 0));
              if (!all.length) return null;
              const rows = all.slice(0, CAP);
              const extra = all.length - rows.length;
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
                          <td>{d.tested}</td>
                          <td>{d.avg_ctr}%</td>
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
        );
      })()}

      {/* Cola de review */}
      <div style={{ margin: '20px 0 10px', fontWeight: 700, fontSize: 13 }}>📋 Cola de aprobación</div>
      {loading ? (
        <p style={{ opacity: 0.5 }}>Cargando…</p>
      ) : (pending.length === 0 && genVideos.length === 0) ? (
        <div style={{ ...card, padding: 20, textAlign: 'center', opacity: 0.6 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎬</div>
          Sin videos pendientes. Dale <b>"Generar videos"</b> para crear desde tus winners.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
          {/* Skeletons de los que se están generando */}
          {genVideos.map(g => (
            <div key={g._id} style={{ ...card, overflow: 'hidden', padding: 0 }}>
              <div style={{ width: '100%', aspectRatio: '9/16', background: 'linear-gradient(135deg, rgba(192,38,211,0.15), rgba(192,38,211,0.04))', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
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
              <video src={v.video_url} controls loop muted playsInline
                style={{ width: '100%', display: 'block', aspectRatio: '9/16', objectFit: 'cover', background: '#000' }} />
              <div style={{ padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{v.headline}</div>
                <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 8 }}>
                  {v.product_name} · <span style={{ color: FUCHSIA }}>{v.motion_variant}</span>
                </div>
                <JudgeVerdict v={v} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => decide(v._id, 'approve')} disabled={busy === v._id}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                    {busy === v._id ? '…' : '✓ Aprobar'}
                  </button>
                  <button onClick={() => downloadVideo(v.video_url, `${v.product_name || 'dionisio'}-${v.motion_variant || ''}`)} title="Descargar video"
                    style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid rgba(192,38,211,0.4)', background: 'transparent', color: FUCHSIA, cursor: 'pointer' }}>⬇</button>
                  <button onClick={() => decide(v._id, 'reject')} disabled={busy === v._id}
                    style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>✗</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

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
