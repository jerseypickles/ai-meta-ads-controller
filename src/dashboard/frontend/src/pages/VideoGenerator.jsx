import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Video, Upload, Image, Play, Trash2, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Camera, Zap, Download,
  Loader, Film, ArrowRight, Eye, ChevronDown, ChevronRight
} from 'lucide-react';
import {
  getVideoAngles, getVideoMotions, uploadProductPhoto, getVideoShots,
  deleteVideoShot, generateAngleShots, generateClipsBatch, getClipStatus,
  getClipStatusBatch
} from '../api';

const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');

// ═══ STATUS CONFIG ═══
const STATUS_CFG = {
  completed: { color: '#22c55e', bg: '#14532d', label: 'Listo', icon: CheckCircle },
  queued: { color: '#f59e0b', bg: '#78350f', label: 'En Cola', icon: Clock },
  processing: { color: '#3b82f6', bg: '#1e3a5f', label: 'Generando', icon: Loader },
  failed: { color: '#ef4444', bg: '#7f1d1d', label: 'Error', icon: XCircle },
  error: { color: '#ef4444', bg: '#7f1d1d', label: 'Error', icon: XCircle },
};

// ═══ STEP INDICATOR ═══
const StepIndicator = ({ number, title, subtitle, active, done }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
    borderRadius: '10px', backgroundColor: active ? '#1e3a5f' : done ? '#14532d' : '#141720',
    border: `1px solid ${active ? '#3b82f6' : done ? '#22c55e' : '#2a2d3a'}`,
    opacity: (!active && !done) ? 0.5 : 1, transition: 'all 0.2s ease'
  }}>
    <div style={{
      width: '32px', height: '32px', borderRadius: '50%', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '14px',
      backgroundColor: done ? '#22c55e' : active ? '#3b82f6' : '#374151',
      color: '#fff'
    }}>
      {done ? <CheckCircle size={16} /> : number}
    </div>
    <div>
      <div style={{ fontWeight: '600', fontSize: '13px', color: active ? '#93c5fd' : done ? '#86efac' : '#9ca3af' }}>{title}</div>
      <div style={{ fontSize: '11px', color: '#6b7280' }}>{subtitle}</div>
    </div>
  </div>
);

// ═══ SHOT CARD ═══
const ShotCard = ({ shot, selected, onToggle, onDelete }) => (
  <div style={{
    position: 'relative', borderRadius: '10px', overflow: 'hidden',
    border: selected ? '3px solid #3b82f6' : '2px solid #2a2d3a',
    cursor: 'pointer', transition: 'all 0.15s ease', backgroundColor: '#111'
  }}>
    <img
      src={`${BASE_URL}${shot.url}`}
      alt={shot.angle}
      onClick={onToggle}
      style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover' }}
    />
    {selected && (
      <div style={{
        position: 'absolute', top: '6px', right: '6px', backgroundColor: '#3b82f6',
        borderRadius: '50%', width: '22px', height: '22px', display: 'flex',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <CheckCircle size={14} color="#fff" />
      </div>
    )}
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 8px',
      background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
    }}>
      <span style={{ fontSize: '10px', color: '#d1d5db', fontWeight: '500' }}>{shot.angle}</span>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
        <Trash2 size={12} color="#fca5a5" />
      </button>
    </div>
  </div>
);

// ═══ CLIP CARD ═══
const ClipCard = ({ clip, onRefresh }) => {
  const cfg = STATUS_CFG[clip.status] || STATUS_CFG.error;
  const Icon = cfg.icon;
  return (
    <div style={{
      backgroundColor: '#141720', border: '1px solid #2a2d3a', borderRadius: '12px',
      padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: cfg.bg, padding: '4px 10px', borderRadius: '6px'
        }}>
          <Icon size={13} color={cfg.color} className={clip.status === 'processing' ? 'spin' : ''} />
          <span style={{ fontSize: '11px', fontWeight: '600', color: cfg.color }}>{cfg.label}</span>
        </div>
        {clip.cameraMotion && (
          <span style={{ fontSize: '10px', color: '#6b7280' }}>{clip.cameraMotion}</span>
        )}
      </div>

      {clip.status === 'completed' && clip.videoUrl && (
        <div>
          <video src={clip.videoUrl} controls style={{ width: '100%', borderRadius: '8px', maxHeight: '200px' }} />
          <a href={clip.videoUrl} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#3b82f6', fontSize: '11px', marginTop: '4px', textDecoration: 'none' }}>
            <Download size={11} /> Descargar
          </a>
        </div>
      )}

      {(clip.status === 'queued' || clip.status === 'processing') && (
        <button onClick={() => onRefresh(clip.requestId)}
          style={{ background: 'none', border: '1px solid #334155', borderRadius: '6px', padding: '6px', cursor: 'pointer', color: '#6b7280', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
          <RefreshCw size={12} /> Verificar
        </button>
      )}

      <div style={{ fontSize: '9px', color: '#374151', fontFamily: 'monospace' }}>{clip.requestId}</div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════
export default function VideoGenerator() {
  // Step 1: Product photo
  const [productPhoto, setProductPhoto] = useState(null);
  const [productDescription, setProductDescription] = useState('Jersey Pickles product jar');
  const [uploading, setUploading] = useState(false);

  // Step 2: Generated shots
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState(new Set());
  const [generatingShots, setGeneratingShots] = useState(false);
  const [numShots, setNumShots] = useState(12);

  // Step 3: Video clips
  const [motions, setMotions] = useState([]);
  const [selectedMotion, setSelectedMotion] = useState('slow-dolly-in');
  const [duration, setDuration] = useState(5);
  const [clips, setClips] = useState([]);
  const [generatingClips, setGeneratingClips] = useState(false);

  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const pollingRef = useRef(null);

  // Load motions + existing shots on mount
  useEffect(() => {
    loadMotions();
    loadShots();
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  // Auto-poll pending clips
  useEffect(() => {
    const pending = clips.filter(c => c.status === 'queued' || c.status === 'processing');
    if (pending.length > 0 && !pollingRef.current) {
      pollingRef.current = setInterval(refreshPendingClips, 15000);
    } else if (pending.length === 0 && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [clips]);

  const loadMotions = async () => {
    try {
      const data = await getVideoMotions();
      setMotions(data.motions || []);
    } catch (err) { console.error('Load motions error:', err); }
  };

  const loadShots = async () => {
    try {
      const data = await getVideoShots();
      setShots(data.shots || []);
    } catch (err) { console.error('Load shots error:', err); }
  };

  // Step 1: Upload product photo
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      const data = await uploadProductPhoto(formData);
      setProductPhoto(data);
    } catch (err) {
      setError(`Upload error: ${err.response?.data?.error || err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Step 2: Generate angle shots
  const handleGenerateShots = async () => {
    if (!productPhoto) return;
    setGeneratingShots(true);
    setError(null);
    try {
      const data = await generateAngleShots({
        productImagePath: productPhoto.path || productPhoto.url,
        productDescription,
        numShots
      });
      setShots(data.shots?.filter(s => s.status === 'completed') || []);
    } catch (err) {
      setError(`Error generando shots: ${err.response?.data?.error || err.message}`);
    } finally {
      setGeneratingShots(false);
    }
  };

  // Step 3: Generate video clips
  const handleGenerateClips = async () => {
    if (selectedShots.size === 0) { setError('Selecciona al menos 1 shot'); return; }
    setGeneratingClips(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const shotsList = [...selectedShots].map(filename => {
        const shot = shots.find(s => s.filename === filename);
        return {
          imageUrl: `${origin}${shot.url}`,
          angle: shot.angle,
          cameraMotion: selectedMotion
        };
      });

      const data = await generateClipsBatch({ shots: shotsList, cameraMotion: selectedMotion, duration });
      setClips(prev => [...(data.jobs || []), ...prev]);
    } catch (err) {
      setError(`Error generando clips: ${err.response?.data?.error || err.message}`);
    } finally {
      setGeneratingClips(false);
    }
  };

  const refreshPendingClips = useCallback(async () => {
    const pending = clips.filter(c => c.status === 'queued' || c.status === 'processing');
    if (pending.length === 0) return;
    try {
      const ids = pending.map(c => c.requestId).filter(Boolean);
      if (ids.length === 0) return;
      const data = await getClipStatusBatch(ids);
      if (data.jobs) {
        setClips(prev => prev.map(c => {
          const updated = data.jobs.find(u => u.requestId === c.requestId);
          return updated ? { ...c, ...updated } : c;
        }));
      }
    } catch (err) { console.error('Poll error:', err); }
  }, [clips]);

  const refreshSingleClip = async (requestId) => {
    try {
      const data = await getClipStatus(requestId);
      setClips(prev => prev.map(c => c.requestId === requestId ? { ...c, ...data } : c));
    } catch (err) { console.error('Refresh error:', err); }
  };

  const toggleShot = (filename) => {
    setSelectedShots(prev => {
      const next = new Set(prev);
      next.has(filename) ? next.delete(filename) : next.add(filename);
      return next;
    });
  };

  const selectAllShots = () => {
    if (selectedShots.size === shots.length) setSelectedShots(new Set());
    else setSelectedShots(new Set(shots.map(s => s.filename)));
  };

  const handleDeleteShot = async (filename) => {
    try {
      await deleteVideoShot(filename);
      setShots(prev => prev.filter(s => s.filename !== filename));
      setSelectedShots(prev => { const n = new Set(prev); n.delete(filename); return n; });
    } catch (err) { setError(err.message); }
  };

  const completedClips = clips.filter(c => c.status === 'completed');
  const pendingClips = clips.filter(c => c.status === 'queued' || c.status === 'processing');

  // Determine current step
  const step = !productPhoto ? 1 : shots.length === 0 ? 2 : 3;

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* ═══ HEADER ═══ */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Video size={24} color="#8b5cf6" />
          Video AI — Product Commercials
        </h1>
        <p style={{ color: '#6b7280', fontSize: '13px' }}>
          1 foto del producto → 12 angulos con OpenAI → videos con Kling 2.6
        </p>
      </div>

      {/* ═══ STEP INDICATORS ═══ */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <StepIndicator number={1} title="Subir Foto" subtitle="1 foto del producto" active={step === 1} done={!!productPhoto} />
        <ArrowRight size={20} color="#374151" style={{ alignSelf: 'center' }} />
        <StepIndicator number={2} title="Generar Angulos" subtitle={`${numShots} shots con OpenAI`} active={step === 2} done={shots.length > 0} />
        <ArrowRight size={20} color="#374151" style={{ alignSelf: 'center' }} />
        <StepIndicator number={3} title="Crear Videos" subtitle="Kling 2.6 + camara" active={step === 3} done={completedClips.length > 0} />
      </div>

      {/* ═══ ERROR BANNER ═══ */}
      {error && (
        <div style={{
          backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '10px',
          padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px'
        }}>
          <AlertTriangle size={16} color="#fca5a5" />
          <span style={{ color: '#fca5a5', fontSize: '13px', flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer' }}>
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* ═══ STEP 1: UPLOAD PRODUCT PHOTO ═══ */}
      <div style={{
        backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
        padding: '24px', marginBottom: '20px'
      }}>
        <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Camera size={18} color="#3b82f6" />
          Paso 1 — Foto del Producto
        </h2>

        {!productPhoto ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{
              textAlign: 'center', padding: '48px 20px', border: '2px dashed #2a2d3a',
              borderRadius: '12px', cursor: 'pointer', transition: 'border-color 0.2s'
            }}
          >
            <Upload size={40} color="#4b5563" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '4px' }}>
              {uploading ? 'Subiendo...' : 'Haz click para subir la foto del producto'}
            </p>
            <p style={{ color: '#4b5563', fontSize: '12px' }}>JPEG, PNG o WEBP — una sola foto clara del producto</p>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ borderRadius: '10px', overflow: 'hidden', border: '2px solid #22c55e', width: '200px', flexShrink: 0 }}>
              <img src={`${BASE_URL}${productPhoto.url}`} alt="Product" style={{ width: '100%', display: 'block' }} />
            </div>
            <div style={{ flex: 1, minWidth: '250px' }}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
                  Descripcion del producto
                </label>
                <input
                  type="text" value={productDescription}
                  onChange={(e) => setProductDescription(e.target.value)}
                  style={{
                    width: '100%', backgroundColor: '#0d0f14', border: '1px solid #2a2d3a',
                    borderRadius: '8px', padding: '10px 12px', color: '#e5e7eb', fontSize: '13px',
                    boxSizing: 'border-box'
                  }}
                  placeholder="ej: Jersey Pickles Spicy Garlic Dill jar"
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
                  Cantidad de angulos
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {[6, 8, 12].map(n => (
                    <button key={n} onClick={() => setNumShots(n)}
                      style={{
                        padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: '600', fontSize: '13px',
                        border: numShots === n ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                        backgroundColor: numShots === n ? '#2e1065' : '#141720',
                        color: numShots === n ? '#c4b5fd' : '#9ca3af'
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleGenerateShots} disabled={generatingShots}
                  style={{
                    padding: '10px 20px', backgroundColor: generatingShots ? '#374151' : '#7c3aed',
                    border: 'none', borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: '600',
                    cursor: generatingShots ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {generatingShots ? <><Loader size={14} className="spin" /> Generando {numShots} shots...</> : <><Zap size={14} /> Generar {numShots} Angulos</>}
                </button>
                <button onClick={() => { setProductPhoto(null); setShots([]); setSelectedShots(new Set()); }}
                  style={{ padding: '10px 14px', backgroundColor: '#1f2937', border: 'none', borderRadius: '8px', color: '#9ca3af', fontSize: '13px', cursor: 'pointer' }}>
                  Cambiar foto
                </button>
              </div>
              {generatingShots && (
                <p style={{ color: '#f59e0b', fontSize: '12px', marginTop: '8px' }}>
                  OpenAI esta generando {numShots} angulos... esto toma ~1-2 minutos
                </p>
              )}
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} style={{ display: 'none' }} />
      </div>

      {/* ═══ STEP 2: GENERATED SHOTS ═══ */}
      {shots.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Image size={18} color="#f59e0b" />
              Paso 2 — Shots Generados ({shots.length})
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={selectAllShots}
                style={{
                  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                  padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                <CheckCircle size={14} />
                {selectedShots.size === shots.length ? 'Deseleccionar' : `Seleccionar Todas (${shots.length})`}
              </button>
            </div>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px'
          }}>
            {shots.map(shot => (
              <ShotCard key={shot.filename} shot={shot}
                selected={selectedShots.has(shot.filename)}
                onToggle={() => toggleShot(shot.filename)}
                onDelete={() => handleDeleteShot(shot.filename)}
              />
            ))}
          </div>

          <div style={{ color: '#6b7280', fontSize: '12px', marginTop: '12px' }}>
            {selectedShots.size} de {shots.length} seleccionadas para video
          </div>
        </div>
      )}

      {/* ═══ STEP 3: VIDEO GENERATION ═══ */}
      {shots.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Film size={18} color="#8b5cf6" />
            Paso 3 — Generar Videos (Kling 2.6)
          </h2>

          {/* Camera motion selector */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>
              Movimiento de Camara
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {motions.map(m => (
                <div key={m.key} onClick={() => setSelectedMotion(m.key)}
                  style={{
                    padding: '8px 14px', borderRadius: '8px', cursor: 'pointer',
                    border: selectedMotion === m.key ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                    backgroundColor: selectedMotion === m.key ? '#2e1065' : '#141720'
                  }}>
                  <div style={{ fontWeight: '600', fontSize: '12px', color: selectedMotion === m.key ? '#c4b5fd' : '#e5e7eb' }}>{m.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Duration */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>
              Duracion por clip
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[5, 10].map(d => (
                <button key={d} onClick={() => setDuration(d)}
                  style={{
                    padding: '8px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: '600', fontSize: '13px',
                    border: duration === d ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                    backgroundColor: duration === d ? '#2e1065' : '#141720',
                    color: duration === d ? '#c4b5fd' : '#9ca3af'
                  }}>
                  {d}s
                </button>
              ))}
            </div>
          </div>

          {/* Generate button */}
          <button onClick={handleGenerateClips} disabled={generatingClips || selectedShots.size === 0}
            style={{
              width: '100%', padding: '14px',
              backgroundColor: generatingClips ? '#374151' : '#7c3aed',
              border: 'none', borderRadius: '10px', color: '#fff', fontSize: '14px', fontWeight: '700',
              cursor: (generatingClips || selectedShots.size === 0) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              opacity: selectedShots.size === 0 ? 0.5 : 1
            }}>
            {generatingClips
              ? <><Loader size={18} className="spin" /> Enviando {selectedShots.size} clips a Kling 2.6...</>
              : <><Play size={18} /> Generar {selectedShots.size} Video{selectedShots.size !== 1 ? 's' : ''} con Kling 2.6</>
            }
          </button>

          {selectedShots.size > 0 && (
            <div style={{ textAlign: 'center', marginTop: '8px', color: '#6b7280', fontSize: '12px' }}>
              Costo estimado: ~${(selectedShots.size * duration * 0.07).toFixed(2)} USD ({selectedShots.size} clips x {duration}s x $0.07/s)
            </div>
          )}
        </div>
      )}

      {/* ═══ CLIP RESULTS ═══ */}
      {clips.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Video size={18} color="#22c55e" />
              Videos ({completedClips.length}/{clips.length})
            </h2>
            {pendingClips.length > 0 && (
              <button onClick={refreshPendingClips}
                style={{
                  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                  padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                <RefreshCw size={14} /> {pendingClips.length} en proceso
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '14px' }}>
            {clips.map((clip, i) => (
              <ClipCard key={clip.requestId || i} clip={clip} onRefresh={refreshSingleClip} />
            ))}
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  );
}
