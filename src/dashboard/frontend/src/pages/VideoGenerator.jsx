import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Video, Upload, Image, Play, Trash2, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Camera, Zap, Download,
  Loader, Film, ArrowRight, Eye, Edit3, Brain, LayoutGrid
} from 'lucide-react';
import {
  getVideoMotions, uploadProductPhoto, getVideoShots,
  deleteVideoShot, generateAngleShots, getShotJobStatus,
  analyzeProduct, generateClipsBatch, getClipStatus, getClipStatusBatch
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
    opacity: (!active && !done) ? 0.5 : 1, transition: 'all 0.2s ease', flex: 1, minWidth: '140px'
  }}>
    <div style={{
      width: '32px', height: '32px', borderRadius: '50%', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '14px',
      backgroundColor: done ? '#22c55e' : active ? '#3b82f6' : '#374151',
      color: '#fff', flexShrink: 0
    }}>
      {done ? <CheckCircle size={16} /> : number}
    </div>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: '600', fontSize: '13px', color: active ? '#93c5fd' : done ? '#86efac' : '#9ca3af' }}>{title}</div>
      <div style={{ fontSize: '11px', color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
    </div>
  </div>
);

// ═══ SHOT CARD (used in step 2 grid) ═══
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
      background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
    }}>
      <span style={{ fontSize: '10px', color: '#d1d5db', fontWeight: '600' }}>{shot.label || shot.angle}</span>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
        <Trash2 size={12} color="#fca5a5" />
      </button>
    </div>
  </div>
);

// ═══ STORYBOARD CARD (step 3) ═══
const StoryboardCard = ({ index, shot, prompt, cameraMotion, onPromptChange, onMotionChange, motions }) => (
  <div style={{
    backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '12px',
    overflow: 'hidden', display: 'flex', flexDirection: 'column'
  }}>
    {/* Image + sequence number */}
    <div style={{ position: 'relative' }}>
      <img src={`${BASE_URL}${shot.url}`} alt={shot.angle}
        style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover' }} />
      <div style={{
        position: 'absolute', top: '6px', left: '6px', backgroundColor: '#7c3aed',
        borderRadius: '50%', width: '26px', height: '26px', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '12px', color: '#fff'
      }}>
        {index + 1}
      </div>
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 8px',
        background: 'linear-gradient(transparent, rgba(0,0,0,0.85))'
      }}>
        <span style={{ fontSize: '10px', color: '#c4b5fd', fontWeight: '600' }}>{shot.label || shot.angle}</span>
      </div>
    </div>

    {/* Prompt editor */}
    <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        rows={3}
        style={{
          width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
          borderRadius: '6px', padding: '8px', color: '#e5e7eb', fontSize: '11px',
          resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box', lineHeight: '1.4'
        }}
        placeholder="Video prompt for this shot..."
      />

      {/* Camera motion selector per clip */}
      <select
        value={cameraMotion}
        onChange={(e) => onMotionChange(e.target.value)}
        style={{
          width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
          borderRadius: '6px', padding: '6px 8px', color: '#c4b5fd', fontSize: '11px',
          cursor: 'pointer', boxSizing: 'border-box'
        }}
      >
        {motions.map(m => (
          <option key={m.key} value={m.key}>{m.label}</option>
        ))}
      </select>
    </div>
  </div>
);

// ═══ CLIP CARD (step 4 results) ═══
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
        {clip.shotAngle && (
          <span style={{ fontSize: '10px', color: '#6b7280' }}>{clip.shotAngle}</span>
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

// ═══ PROGRESS BAR ═══
const ProgressBar = ({ completed, total, failed }) => {
  const pct = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;
  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>
          {completed} completadas{failed > 0 ? `, ${failed} fallidas` : ''} de {total}
        </span>
        <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: '600' }}>{pct}%</span>
      </div>
      <div style={{ width: '100%', height: '8px', backgroundColor: '#1f2937', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: '4px', transition: 'width 0.5s ease',
          background: failed > 0 ? 'linear-gradient(90deg, #22c55e, #f59e0b)' : '#22c55e'
        }} />
      </div>
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

  // Step 2: Generated shots (async)
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState(new Set());
  const [shotJobId, setShotJobId] = useState(null);
  const [shotJobStatus, setShotJobStatus] = useState(null);
  const [numShots, setNumShots] = useState(12);

  // Step 3: Storyboard + Claude prompts
  const [storyboard, setStoryboard] = useState([]); // { shot, prompt, cameraMotion }
  const [analyzing, setAnalyzing] = useState(false);
  const [productAnalysis, setProductAnalysis] = useState(null);

  // Step 4: Video clips
  const [motions, setMotions] = useState([]);
  const [duration, setDuration] = useState(5);
  const [clips, setClips] = useState([]);
  const [generatingClips, setGeneratingClips] = useState(false);

  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const shotPollRef = useRef(null);
  const clipPollRef = useRef(null);

  // Load motions + existing shots on mount
  useEffect(() => {
    loadMotions();
    loadShots();
    return () => {
      if (shotPollRef.current) clearInterval(shotPollRef.current);
      if (clipPollRef.current) clearInterval(clipPollRef.current);
    };
  }, []);

  // Poll shot generation job
  useEffect(() => {
    if (shotJobId && shotJobStatus?.status === 'running') {
      shotPollRef.current = setInterval(pollShotJob, 5000);
      return () => { clearInterval(shotPollRef.current); shotPollRef.current = null; };
    }
  }, [shotJobId, shotJobStatus?.status]);

  // Poll pending clips
  useEffect(() => {
    const pending = clips.filter(c => c.status === 'queued' || c.status === 'processing');
    if (pending.length > 0 && !clipPollRef.current) {
      clipPollRef.current = setInterval(refreshPendingClips, 15000);
    } else if (pending.length === 0 && clipPollRef.current) {
      clearInterval(clipPollRef.current);
      clipPollRef.current = null;
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
      if (data.shots?.length > 0) setShots(data.shots);
    } catch (err) { console.error('Load shots error:', err); }
  };

  // ═══ Step 1: Upload ═══
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

  // ═══ Step 2: Generate shots (async) ═══
  const handleGenerateShots = async () => {
    if (!productPhoto) return;
    setError(null);
    setShotJobStatus(null);
    setShots([]);
    setSelectedShots(new Set());
    setStoryboard([]);
    setProductAnalysis(null);
    try {
      const data = await generateAngleShots({
        productImagePath: productPhoto.path || productPhoto.url,
        productDescription,
        numShots
      });
      setShotJobId(data.jobId);
      setShotJobStatus({ status: 'running', total: data.total, completed: 0, failed: 0, shots: [] });
    } catch (err) {
      setError(`Error iniciando generacion: ${err.response?.data?.error || err.message}`);
    }
  };

  const pollShotJob = async () => {
    if (!shotJobId) return;
    try {
      const data = await getShotJobStatus(shotJobId);
      setShotJobStatus(data);

      // Update shots list with completed ones
      if (data.shots?.length > 0) {
        const completedShots = data.shots.filter(s => s.status === 'completed');
        setShots(completedShots);
      }

      // Job done
      if (data.status === 'done' || data.status === 'failed') {
        if (shotPollRef.current) { clearInterval(shotPollRef.current); shotPollRef.current = null; }
        if (data.status === 'failed' && data.error) {
          setError(`Shot generation failed: ${data.error}`);
        }
      }
    } catch (err) {
      console.error('Poll shot job error:', err);
    }
  };

  // ═══ Step 3: Claude analyzes + storyboard ═══
  const handleAnalyzeProduct = async () => {
    if (selectedShots.size === 0) { setError('Selecciona al menos 1 shot para el storyboard'); return; }
    setAnalyzing(true);
    setError(null);
    try {
      const selectedShotsList = [...selectedShots]
        .map(filename => shots.find(s => s.filename === filename))
        .filter(Boolean);

      const analysis = await analyzeProduct({
        shots: selectedShotsList,
        productDescription
      });
      setProductAnalysis(analysis);

      // Build storyboard with Claude-generated prompts
      const defaultMotion = 'slow-dolly-in';
      const sb = selectedShotsList.map(shot => ({
        shot,
        prompt: analysis.prompts?.[shot.angle] || '',
        cameraMotion: defaultMotion
      }));
      setStoryboard(sb);
    } catch (err) {
      setError(`Error analizando producto: ${err.response?.data?.error || err.message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const updateStoryboardPrompt = (index, prompt) => {
    setStoryboard(prev => prev.map((item, i) => i === index ? { ...item, prompt } : item));
  };

  const updateStoryboardMotion = (index, cameraMotion) => {
    setStoryboard(prev => prev.map((item, i) => i === index ? { ...item, cameraMotion } : item));
  };

  // ═══ Step 4: Generate videos ═══
  const handleGenerateClips = async () => {
    if (storyboard.length === 0) { setError('Configura el storyboard primero'); return; }
    setGeneratingClips(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const shotsList = storyboard.map(item => ({
        imageUrl: `${origin}${item.shot.url}`,
        angle: item.shot.angle,
        cameraMotion: item.cameraMotion,
        prompt: item.prompt
      }));

      const data = await generateClipsBatch({ shots: shotsList, duration });
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
  const isGeneratingShots = shotJobStatus?.status === 'running';

  // Determine current step
  let step = 1;
  if (productPhoto) step = 2;
  if (shots.length > 0 && !isGeneratingShots) step = 3;
  if (storyboard.length > 0) step = 4;

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* ═══ HEADER ═══ */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Video size={24} color="#8b5cf6" />
          Video AI — Product Commercials
        </h1>
        <p style={{ color: '#6b7280', fontSize: '13px' }}>
          Foto → Angulos (OpenAI) → Analisis (Claude) → Storyboard → Videos (Kling 2.6)
        </p>
      </div>

      {/* ═══ STEP INDICATORS ═══ */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
        <StepIndicator number={1} title="Subir Foto" subtitle="Producto" active={step === 1} done={!!productPhoto} />
        <ArrowRight size={16} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={2} title="Angulos" subtitle={`${numShots} shots`} active={step === 2} done={shots.length > 0 && !isGeneratingShots} />
        <ArrowRight size={16} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={3} title="Storyboard" subtitle="Claude + prompts" active={step === 3} done={storyboard.length > 0} />
        <ArrowRight size={16} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={4} title="Videos" subtitle="Kling 2.6" active={step === 4} done={completedClips.length > 0} />
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

      {/* ═══ STEP 1: UPLOAD ═══ */}
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
            <div style={{ borderRadius: '10px', overflow: 'hidden', border: '2px solid #22c55e', width: '180px', flexShrink: 0 }}>
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
                <button onClick={handleGenerateShots} disabled={isGeneratingShots}
                  style={{
                    padding: '10px 20px', backgroundColor: isGeneratingShots ? '#374151' : '#7c3aed',
                    border: 'none', borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: '600',
                    cursor: isGeneratingShots ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {isGeneratingShots ? <><Loader size={14} className="spin" /> Generando...</> : <><Zap size={14} /> Generar {numShots} Angulos</>}
                </button>
                <button onClick={() => { setProductPhoto(null); setShots([]); setSelectedShots(new Set()); setStoryboard([]); setProductAnalysis(null); }}
                  style={{ padding: '10px 14px', backgroundColor: '#1f2937', border: 'none', borderRadius: '8px', color: '#9ca3af', fontSize: '13px', cursor: 'pointer' }}>
                  Cambiar foto
                </button>
              </div>
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} style={{ display: 'none' }} />

        {/* Progress bar for async generation */}
        {isGeneratingShots && shotJobStatus && (
          <ProgressBar
            completed={shotJobStatus.completed || 0}
            total={shotJobStatus.total || numShots}
            failed={shotJobStatus.failed || 0}
          />
        )}
      </div>

      {/* ═══ STEP 2: GENERATED SHOTS ═══ */}
      {shots.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Image size={18} color="#f59e0b" />
              Paso 2 — Shots ({shots.length})
              {isGeneratingShots && <Loader size={14} className="spin" color="#f59e0b" />}
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
              {selectedShots.size > 0 && !isGeneratingShots && (
                <button onClick={handleAnalyzeProduct} disabled={analyzing}
                  style={{
                    backgroundColor: analyzing ? '#374151' : '#7c3aed', border: 'none', borderRadius: '8px',
                    padding: '8px 16px', color: '#fff', fontSize: '12px', fontWeight: '600',
                    cursor: analyzing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {analyzing ? <><Loader size={14} className="spin" /> Claude analizando...</> : <><Brain size={14} /> Crear Storyboard ({selectedShots.size})</>}
                </button>
              )}
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
            {selectedShots.size} de {shots.length} seleccionadas para storyboard
          </div>
        </div>
      )}

      {/* ═══ STEP 3: STORYBOARD ═══ */}
      {storyboard.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <LayoutGrid size={18} color="#c4b5fd" />
              Paso 3 — Storyboard
            </h2>
            {productAnalysis && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px',
                  fontSize: '12px', color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <Brain size={13} />
                  {productAnalysis.brand} {productAnalysis.productName} — {productAnalysis.category}
                </div>
              </div>
            )}
          </div>

          {/* Duration selector */}
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <div>
              <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '8px' }}>
                Duracion por clip
              </label>
              <div style={{ display: 'inline-flex', gap: '6px' }}>
                {[5, 10].map(d => (
                  <button key={d} onClick={() => setDuration(d)}
                    style={{
                      padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '12px',
                      border: duration === d ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                      backgroundColor: duration === d ? '#2e1065' : '#141720',
                      color: duration === d ? '#c4b5fd' : '#9ca3af'
                    }}>
                    {d}s
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: '12px', color: '#6b7280' }}>
              Costo: ~${(storyboard.length * duration * 0.07).toFixed(2)} ({storyboard.length} clips x {duration}s x $0.07/s)
            </div>
          </div>

          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Edit3 size={13} />
            Puedes editar cada prompt y movimiento de camara antes de generar
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px',
            marginBottom: '20px'
          }}>
            {storyboard.map((item, i) => (
              <StoryboardCard
                key={item.shot.filename}
                index={i}
                shot={item.shot}
                prompt={item.prompt}
                cameraMotion={item.cameraMotion}
                onPromptChange={(p) => updateStoryboardPrompt(i, p)}
                onMotionChange={(m) => updateStoryboardMotion(i, m)}
                motions={motions}
              />
            ))}
          </div>

          {/* Generate button */}
          <button onClick={handleGenerateClips} disabled={generatingClips}
            style={{
              width: '100%', padding: '14px',
              backgroundColor: generatingClips ? '#374151' : '#7c3aed',
              border: 'none', borderRadius: '10px', color: '#fff', fontSize: '14px', fontWeight: '700',
              cursor: generatingClips ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
            }}>
            {generatingClips
              ? <><Loader size={18} className="spin" /> Enviando {storyboard.length} clips a Kling 2.6...</>
              : <><Play size={18} /> Generar {storyboard.length} Video{storyboard.length !== 1 ? 's' : ''} con Kling 2.6</>
            }
          </button>
        </div>
      )}

      {/* ═══ STEP 4: CLIP RESULTS ═══ */}
      {clips.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Film size={18} color="#22c55e" />
              Paso 4 — Videos ({completedClips.length}/{clips.length})
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
