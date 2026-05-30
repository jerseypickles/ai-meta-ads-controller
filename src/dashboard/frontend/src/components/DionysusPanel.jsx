import { useState, useEffect, useCallback } from 'react';
import { getDionysusPending, runDionysusApi, approveDionysusVideo, rejectDionysusVideo } from '../api';

// 🎭 Dionisio — cola de videos pendientes de aprobación (human-in-the-loop).
function DionysusPanel() {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null); // id en proceso

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await getDionysusPending(); setPending(d.pending || []); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRun = async () => {
    setRunning(true);
    try { await runDionysusApi(); } catch (e) { console.error(e); }
    finally { setRunning(false); }
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

  return (
    <div className="dionysus-panel">
      <div className="agent-panel-identity" data-agent="dionysus">
        <span className="agent-icon">🎭</span>
        <span className="agent-name">Dionisio</span>
        <span className="agent-role">— Video</span>
        <button className="btn-agent-run" onClick={onRun} disabled={running} style={{ marginLeft: 'auto' }}>
          {running ? 'Generando…' : 'Generar videos'}
        </button>
        <button className="btn-agent-run" onClick={load} disabled={loading} style={{ marginLeft: 8 }}>
          ↻
        </button>
      </div>

      <p style={{ opacity: 0.7, fontSize: 13, margin: '8px 0 16px' }}>
        Videos 5s generados de los winners (Seedance 2.0). Aprobá los que quieras → Prometheus los testea.
      </p>

      {loading ? (
        <p>Cargando…</p>
      ) : pending.length === 0 ? (
        <p style={{ opacity: 0.6 }}>Sin videos pendientes. Dale "Generar videos" o esperá el próximo ciclo.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
          {pending.map(v => (
            <div key={v._id} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.03)' }}>
              <video src={v.video_url} controls loop muted playsInline style={{ width: '100%', display: 'block', aspectRatio: '9/16', objectFit: 'cover', background: '#000' }} />
              <div style={{ padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{v.headline}</div>
                <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>{v.product_name} · {v.motion_variant}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => decide(v._id, 'approve')} disabled={busy === v._id}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                    {busy === v._id ? '…' : '✓ Aprobar'}
                  </button>
                  <button onClick={() => decide(v._id, 'reject')} disabled={busy === v._id}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>
                    ✗
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DionysusPanel;
