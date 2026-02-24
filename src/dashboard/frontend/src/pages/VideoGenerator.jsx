import React, { useState, useEffect, useRef } from 'react';
import {
  Video, Upload, Play, CheckCircle, XCircle, Clock, AlertTriangle,
  Camera, Download, Loader, Film, Zap, Music, Type, RefreshCw
} from 'lucide-react';
import {
  uploadProductPhoto, getVideoTemplates, getMusicTracks,
  autoGenerateCommercial, getAutoGenerateStatus
} from '../api';

const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');

// ═══ PHASE CONFIG ═══
const PHASE_CFG = {
  director:       { icon: '🧠', label: 'Director Creativo', color: '#c4b5fd' },
  shots:          { icon: '📸', label: 'Generando Imagenes', color: '#f59e0b' },
  clips:          { icon: '🎬', label: 'Enviando Video Clips', color: '#3b82f6' },
  'clips-polling':{ icon: '⏳', label: 'Generando Videos', color: '#3b82f6' },
  stitching:      { icon: '🎞️', label: 'Ensamblando Comercial', color: '#22c55e' },
  complete:       { icon: '✅', label: 'Comercial Listo', color: '#22c55e' }
};

// ═══ TEMPLATE STYLE COLORS ═══
const STYLE_COLORS = {
  'fast-paced':   { color: '#f59e0b', bg: '#78350f', border: '#f59e0b' },
  'recipe':       { color: '#22c55e', bg: '#14532d', border: '#22c55e' },
  'lifestyle':    { color: '#ec4899', bg: '#831843', border: '#ec4899' },
  'asmr':         { color: '#8b5cf6', bg: '#3b0764', border: '#8b5cf6' },
  'before-after': { color: '#3b82f6', bg: '#1e3a5f', border: '#3b82f6' },
  'cinematic':    { color: '#9ca3af', bg: '#1f2937', border: '#6b7280' }
};

// ═══ PROGRESS BAR ═══
const ProgressBar = ({ percent, color }) => (
  <div style={{ width: '100%', height: '10px', backgroundColor: '#1f2937', borderRadius: '5px', overflow: 'hidden' }}>
    <div style={{
      width: `${Math.min(100, percent)}%`, height: '100%', borderRadius: '5px',
      background: `linear-gradient(90deg, ${color}cc, ${color})`,
      transition: 'width 0.8s ease'
    }} />
  </div>
);

// ═══ PHASE TIMELINE ═══
const PhaseTimeline = ({ currentPhase, progress }) => {
  const phases = ['director', 'shots', 'clips-polling', 'stitching', 'complete'];
  const currentIdx = phases.indexOf(currentPhase === 'clips' ? 'clips-polling' : currentPhase);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '16px', flexWrap: 'wrap' }}>
      {phases.map((phase, i) => {
        const cfg = PHASE_CFG[phase];
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <React.Fragment key={phase}>
            {i > 0 && <div style={{ width: '20px', height: '2px', backgroundColor: isDone ? '#22c55e' : '#2a2d3a', flexShrink: 0 }} />}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px',
              borderRadius: '8px', fontSize: '12px', fontWeight: '600',
              backgroundColor: isCurrent ? `${cfg.color}20` : isDone ? '#14532d20' : '#141720',
              border: `1px solid ${isCurrent ? cfg.color : isDone ? '#22c55e40' : '#2a2d3a'}`,
              color: isCurrent ? cfg.color : isDone ? '#22c55e' : '#4b5563',
              opacity: (!isCurrent && !isDone) ? 0.5 : 1
            }}>
              <span>{isDone ? '✅' : cfg.icon}</span>
              <span>{cfg.label}</span>
              {isCurrent && <Loader size={12} className="spin" />}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

// ═══════════════════════════════════════════════
// MAIN COMPONENT — One-Click Video Commercial
// ═══════════════════════════════════════════════
export default function VideoGenerator() {
  // Upload state
  const [productPhoto, setProductPhoto] = useState(null);
  const [productDescription, setProductDescription] = useState('Jersey Pickles product jar');
  const [uploading, setUploading] = useState(false);

  // Template + options
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('quick-cut-food');
  const [musicTracks, setMusicTracks] = useState([]);
  const [selectedMusic, setSelectedMusic] = useState('none');
  const [brandText, setBrandText] = useState('');
  const [showOptions, setShowOptions] = useState(false);

  // Auto-generate job
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);

  // UI
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  // Load templates + music on mount
  useEffect(() => {
    loadTemplates();
    loadMusicTracks();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Poll auto-generate job
  useEffect(() => {
    if (jobId && jobStatus?.status === 'running') {
      pollRef.current = setInterval(pollJob, 5000);
      return () => { clearInterval(pollRef.current); pollRef.current = null; };
    }
  }, [jobId, jobStatus?.status]);

  const loadTemplates = async () => {
    try {
      const data = await getVideoTemplates();
      setTemplates(data.templates || []);
    } catch (err) { console.error('Load templates error:', err); }
  };

  const loadMusicTracks = async () => {
    try {
      const data = await getMusicTracks();
      setMusicTracks(data.tracks || []);
    } catch (err) { console.error('Load music tracks error:', err); }
  };

  // ═══ Upload ═══
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

  // ═══ One-Click Generate ═══
  const handleGenerate = async () => {
    if (!productPhoto) return;
    setError(null);
    setJobStatus(null);
    try {
      const data = await autoGenerateCommercial({
        productImagePath: productPhoto.path || productPhoto.url,
        productDescription,
        templateKey: selectedTemplate,
        musicTrack: selectedMusic,
        brandText
      });
      setJobId(data.jobId);
      setJobStatus({ status: 'running', phase: 'director', phaseLabel: 'Iniciando...', progress: 0 });
    } catch (err) {
      setError(`Error: ${err.response?.data?.error || err.message}`);
    }
  };

  const pollJob = async () => {
    if (!jobId) return;
    try {
      const data = await getAutoGenerateStatus(jobId);
      setJobStatus(data);

      if (data.status === 'done' || data.status === 'failed') {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (data.status === 'failed' && data.error) {
          setError(`Error: ${data.error}`);
        }
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  };

  const handleReset = () => {
    setJobId(null);
    setJobStatus(null);
    setError(null);
  };

  const handleFullReset = () => {
    handleReset();
    setProductPhoto(null);
  };

  const isRunning = jobStatus?.status === 'running';
  const isDone = jobStatus?.status === 'done';
  const phaseCfg = jobStatus?.phase ? PHASE_CFG[jobStatus.phase] : null;

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      {/* ═══ HEADER ═══ */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Video size={24} color="#8b5cf6" />
          Video AI — Comercial en Un Click
        </h1>
        <p style={{ color: '#6b7280', fontSize: '13px' }}>
          Sube la foto del producto, elige un estilo, y genera un video comercial automaticamente
        </p>
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

      {/* ═══ UPLOAD + CONFIG (only when not running or done) ═══ */}
      {!isRunning && !isDone && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          {/* Upload area */}
          {!productPhoto ? (
            <div>
              <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Camera size={18} color="#3b82f6" />
                Foto del Producto
              </h2>
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
            </div>
          ) : (
            <div>
              {/* Photo preview + description */}
              <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap' }}>
                <div style={{ borderRadius: '10px', overflow: 'hidden', border: '2px solid #22c55e', width: '140px', flexShrink: 0 }}>
                  <img src={`${BASE_URL}${productPhoto.url}`} alt="Product" style={{ width: '100%', display: 'block' }} />
                </div>
                <div style={{ flex: 1, minWidth: '250px' }}>
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
                  <button onClick={handleFullReset}
                    style={{ marginTop: '8px', padding: '6px 12px', backgroundColor: '#1f2937', border: 'none', borderRadius: '6px', color: '#9ca3af', fontSize: '12px', cursor: 'pointer' }}>
                    Cambiar foto
                  </button>
                </div>
              </div>

              {/* Template selector */}
              {templates.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>
                    Estilo de Comercial
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' }}>
                    {templates.map(t => {
                      const isSelected = selectedTemplate === t.key;
                      const sc = STYLE_COLORS[t.style] || STYLE_COLORS.cinematic;
                      return (
                        <button key={t.key} onClick={() => setSelectedTemplate(t.key)}
                          style={{
                            textAlign: 'left', padding: '12px 14px', borderRadius: '10px', cursor: 'pointer',
                            border: isSelected ? `2px solid ${sc.border}` : '1px solid #2a2d3a',
                            backgroundColor: isSelected ? sc.bg : '#0d0f14',
                            transition: 'all 0.15s ease'
                          }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                            <span style={{ fontSize: '13px', fontWeight: '700', color: isSelected ? sc.color : '#e5e7eb' }}>
                              {t.label}
                            </span>
                            <span style={{
                              fontSize: '9px', fontWeight: '600', padding: '2px 6px', borderRadius: '4px',
                              backgroundColor: isSelected ? `${sc.color}20` : '#1f2937',
                              color: isSelected ? sc.color : '#6b7280'
                            }}>
                              {t.beats} beats · {t.duration}
                            </span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#6b7280', lineHeight: '1.4' }}>
                            {t.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Optional: Music + closing text toggle */}
              <div style={{ marginBottom: '20px' }}>
                <button onClick={() => setShowOptions(!showOptions)}
                  style={{
                    background: 'none', border: '1px solid #2a2d3a', borderRadius: '8px',
                    padding: '8px 14px', color: '#9ca3af', fontSize: '12px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  <Music size={13} />
                  {showOptions ? 'Ocultar opciones' : 'Musica y texto de cierre'} (opcional)
                </button>

                {showOptions && (
                  <div style={{
                    marginTop: '12px', display: 'flex', gap: '16px', flexWrap: 'wrap',
                    backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '10px',
                    padding: '14px'
                  }}>
                    <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
                      <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
                        <Music size={11} color="#8b5cf6" /> Musica de Fondo
                      </label>
                      <select
                        value={selectedMusic}
                        onChange={(e) => setSelectedMusic(e.target.value)}
                        style={{
                          width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
                          borderRadius: '6px', padding: '8px', color: '#c4b5fd', fontSize: '12px',
                          cursor: 'pointer', boxSizing: 'border-box'
                        }}
                      >
                        {musicTracks.map(t => (
                          <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
                      <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
                        <Type size={11} color="#22c55e" /> Texto de Cierre
                      </label>
                      <input
                        type="text" value={brandText}
                        onChange={(e) => setBrandText(e.target.value)}
                        placeholder="ej: Jersey Pickles"
                        style={{
                          width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
                          borderRadius: '6px', padding: '8px', color: '#e5e7eb', fontSize: '12px',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ═══ THE BIG BUTTON ═══ */}
              <button onClick={handleGenerate}
                style={{
                  width: '100%', padding: '16px',
                  background: 'linear-gradient(135deg, #7c3aed, #3b82f6)',
                  border: 'none', borderRadius: '12px', color: '#fff', fontSize: '16px', fontWeight: '700',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                  boxShadow: '0 4px 20px rgba(124, 58, 237, 0.3)', transition: 'transform 0.1s'
                }}
                onMouseDown={(e) => e.target.style.transform = 'scale(0.98)'}
                onMouseUp={(e) => e.target.style.transform = 'scale(1)'}
              >
                <Zap size={20} />
                Generar Comercial Automatico
              </button>

              <p style={{ color: '#4b5563', fontSize: '11px', textAlign: 'center', marginTop: '8px' }}>
                Claude Director analiza → Grok Imagine genera imagenes → Grok Video genera clips → FFmpeg ensambla el comercial final
              </p>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} style={{ display: 'none' }} />
        </div>
      )}

      {/* ═══ GENERATING — Progress View ═══ */}
      {isRunning && jobStatus && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Loader size={18} color="#8b5cf6" className="spin" />
            Generando Video Comercial...
          </h2>

          {/* Phase timeline */}
          <PhaseTimeline currentPhase={jobStatus.phase} progress={jobStatus.progress} />

          {/* Progress bar */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px', color: phaseCfg?.color || '#9ca3af', fontWeight: '600' }}>
                {jobStatus.phaseLabel}
              </span>
              <span style={{ fontSize: '13px', color: '#9ca3af', fontWeight: '700' }}>
                {jobStatus.progress}%
              </span>
            </div>
            <ProgressBar percent={jobStatus.progress} color={phaseCfg?.color || '#8b5cf6'} />
          </div>

          {/* Director results preview */}
          {jobStatus.directorPlan && (
            <div style={{
              backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '10px',
              padding: '12px 16px', marginBottom: '12px'
            }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#c4b5fd', fontWeight: '600' }}>
                  🧠 {jobStatus.directorPlan.brand} {jobStatus.directorPlan.productName}
                </span>
                <span style={{ fontSize: '11px', color: '#6b7280' }}>·</span>
                <span style={{ fontSize: '11px', color: '#f59e0b' }}>{jobStatus.directorPlan.category}</span>
                <span style={{ fontSize: '11px', color: '#6b7280' }}>·</span>
                <span style={{ fontSize: '11px', color: '#93c5fd' }}>Escena: {jobStatus.directorPlan.sceneLabel}</span>
              </div>
            </div>
          )}

          {/* Stats */}
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {jobStatus.shotsTotal > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#9ca3af' }}>
                <Camera size={13} color="#f59e0b" />
                Imagenes: {jobStatus.shotsGenerated}/{jobStatus.shotsTotal}
              </div>
            )}
            {jobStatus.clipsTotal > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#9ca3af' }}>
                <Film size={13} color="#3b82f6" />
                Clips: {jobStatus.clipsCompleted}/{jobStatus.clipsTotal}
              </div>
            )}
          </div>

          {/* Photo preview while generating */}
          {productPhoto && (
            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center' }}>
              <div style={{ borderRadius: '10px', overflow: 'hidden', border: '1px solid #2a2d3a', width: '120px', opacity: 0.6 }}>
                <img src={`${BASE_URL}${productPhoto.url}`} alt="Product" style={{ width: '100%', display: 'block' }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ DONE — Final Video ═══ */}
      {isDone && jobStatus?.finalVideoUrl && (
        <div style={{
          backgroundColor: '#111318', border: '2px solid #22c55e', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <h2 style={{ color: '#fff', fontSize: '18px', fontWeight: '700', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle size={20} color="#22c55e" />
            Video Comercial Listo!
          </h2>

          <video
            src={`${BASE_URL}${jobStatus.finalVideoUrl}`}
            controls
            autoPlay
            style={{
              width: '100%', maxWidth: '480px', borderRadius: '12px',
              border: '2px solid #22c55e40', margin: '0 auto', display: 'block'
            }}
          />

          {/* Director info */}
          {jobStatus.directorPlan && (
            <div style={{
              marginTop: '16px', backgroundColor: '#0d0f14', border: '1px solid #2a2d3a',
              borderRadius: '10px', padding: '12px 16px', textAlign: 'center',
              display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center'
            }}>
              <span style={{ color: '#c4b5fd', fontSize: '12px', fontWeight: '600' }}>
                {jobStatus.directorPlan.brand} {jobStatus.directorPlan.productName}
              </span>
              <span style={{ color: '#6b7280', fontSize: '11px' }}>
                Escena: {jobStatus.directorPlan.sceneLabel}
              </span>
              <span style={{ color: '#6b7280', fontSize: '11px' }}>
                {jobStatus.clipsCompleted} clips ensamblados
              </span>
            </div>
          )}

          {/* Actions */}
          <div style={{ marginTop: '16px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href={`${BASE_URL}${jobStatus.finalVideoUrl}`} download
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                backgroundColor: '#22c55e', color: '#fff', padding: '12px 24px',
                borderRadius: '10px', textDecoration: 'none', fontWeight: '700', fontSize: '14px'
              }}>
              <Download size={16} /> Descargar Video
            </a>
            <button onClick={handleReset}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                backgroundColor: '#7c3aed', color: '#fff', padding: '12px 20px',
                borderRadius: '10px', border: 'none', fontWeight: '600', fontSize: '13px',
                cursor: 'pointer'
              }}>
              <RefreshCw size={14} /> Generar Otro
            </button>
            <button onClick={handleFullReset}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                backgroundColor: '#1e293b', color: '#93c5fd', padding: '12px 16px',
                borderRadius: '10px', border: '1px solid #334155', fontWeight: '500', fontSize: '13px',
                cursor: 'pointer'
              }}>
              <Camera size={14} /> Otro Producto
            </button>
          </div>
        </div>
      )}

      {/* ═══ FAILED — Retry ═══ */}
      {jobStatus?.status === 'failed' && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #dc2626', borderRadius: '14px',
          padding: '24px', marginBottom: '20px', textAlign: 'center'
        }}>
          <XCircle size={32} color="#ef4444" style={{ margin: '0 auto 12px', display: 'block' }} />
          <h3 style={{ color: '#fca5a5', fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>
            Error en la generacion
          </h3>
          <p style={{ color: '#9ca3af', fontSize: '13px', marginBottom: '16px' }}>
            Fallo en fase: {PHASE_CFG[jobStatus.phase]?.label || jobStatus.phase}
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button onClick={handleGenerate}
              style={{
                padding: '10px 20px', backgroundColor: '#7c3aed', border: 'none', borderRadius: '8px',
                color: '#fff', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px'
              }}>
              <RefreshCw size={14} /> Reintentar
            </button>
            <button onClick={handleReset}
              style={{
                padding: '10px 16px', backgroundColor: '#1f2937', border: 'none', borderRadius: '8px',
                color: '#9ca3af', fontSize: '13px', cursor: 'pointer'
              }}>
              Volver
            </button>
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
