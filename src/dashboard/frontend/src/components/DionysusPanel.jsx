import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getDionysusPending, getDionysusStats, runDionysusApi,
  approveDionysusVideo, rejectDionysusVideo
} from '../api';

const FUCHSIA = '#c026d3';

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
    // poll mientras genera — los placeholders 'generando' y luego los videos aparecen solos
    const t0 = Date.now();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      await load();
      if (Date.now() - t0 > 5 * 60 * 1000) { clearInterval(pollRef.current); setRunning(false); }
    }, 6000);
    setTimeout(() => { if (pollRef.current) clearInterval(pollRef.current); setRunning(false); }, 5 * 60 * 1000 + 1000);
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
        <button onClick={onRun} disabled={running}
          style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 8, border: 'none', fontWeight: 700, cursor: running ? 'default' : 'pointer',
                   background: running ? 'rgba(192,38,211,0.3)' : FUCHSIA, color: '#fff' }}>
          {running ? '🎬 Generando…' : '✨ Generar videos'}
        </button>
        <button onClick={load} title="Refrescar" style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#fff', cursor: 'pointer' }}>↻</button>
      </div>

      {/* Stat strip */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
          {[
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
            <div style={{ fontSize: 12, opacity: 0.6 }}>Juzga tus mejores imágenes → anima 5s con Seedance. Toma 1-2 min/video; van apareciendo abajo.</div>
          </div>
        </div>
      )}

      {/* DNA — qué aprende */}
      <div style={{ margin: '18px 0 10px', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        🧬 Lo que Dionisio aprende <span style={{ fontWeight: 400, opacity: 0.5, fontSize: 11 }}>(qué motion rinde mejor)</span>
      </div>
      {!stats?.dna?.length ? (
        <div style={{ ...card, padding: 14, fontSize: 12, opacity: 0.6 }}>
          Todavía sin data — el DNA se construye a medida que los videos se testean. Cuando Prometheus testee los primeros, vas a ver acá qué movimiento (drip, breeze, shimmer…) trae mejor CTR/ROAS.
        </div>
      ) : (
        <div style={{ ...card, padding: 6 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead><tr style={{ opacity: 0.55, textAlign: 'left' }}>
              <th style={{ padding: 8 }}>Motion</th><th>Testeados</th><th>CTR avg</th><th>ROAS avg</th><th>Win-rate</th>
            </tr></thead>
            <tbody>
              {stats.dna.map(d => (
                <tr key={d.variant} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: 8, fontWeight: 600 }}>{d.variant}</td>
                  <td>{d.tested}</td>
                  <td>{d.avg_ctr}%</td>
                  <td style={{ color: d.avg_roas >= 2 ? '#34d399' : '#f87171' }}>{d.avg_roas}x</td>
                  <td>{d.win_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                  {v.video_judge_score != null ? <> · <span style={{ color: '#34d399' }}>score {v.video_judge_score}</span></> : null}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => decide(v._id, 'approve')} disabled={busy === v._id}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                    {busy === v._id ? '…' : '✓ Aprobar'}
                  </button>
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

export default DionysusPanel;
