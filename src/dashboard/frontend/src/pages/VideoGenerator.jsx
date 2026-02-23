import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Video, Upload, Image, Play, Trash2, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Camera, Zap, Download, ChevronDown,
  ChevronRight, Loader, Film, ArrowRight, RotateCcw, Eye
} from 'lucide-react';
import {
  getVideoPresets, uploadVideoPhotos, getVideoPhotos, deleteVideoPhoto,
  generateVideo, generateVideoBatch, getVideoStatus, getVideoStatusBatch,
  getVideoPhotoUrl
} from '../api';

// ═══ HELPERS ═══
const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');

// ═══ STATUS COLORS ═══
const STATUS_CONFIG = {
  submitted: { color: '#f59e0b', bg: '#78350f', label: 'Procesando', icon: Clock },
  processing: { color: '#f59e0b', bg: '#78350f', label: 'Procesando', icon: Clock },
  completed: { color: '#22c55e', bg: '#14532d', label: 'Completado', icon: CheckCircle },
  failed: { color: '#ef4444', bg: '#7f1d1d', label: 'Error', icon: XCircle },
  error: { color: '#ef4444', bg: '#7f1d1d', label: 'Error', icon: XCircle },
  nsfw_rejected: { color: '#ef4444', bg: '#7f1d1d', label: 'Rechazado', icon: XCircle },
  unknown: { color: '#6b7280', bg: '#374151', label: 'Desconocido', icon: Clock }
};

// ═══ STAT BADGE ═══
const StatBadge = ({ icon: Icon, iconColor, label, value }) => (
  <div style={{
    backgroundColor: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: '12px',
    padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '140px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Icon size={15} color={iconColor} />
      <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
    </div>
    <div style={{ fontSize: '22px', fontWeight: '700', color: '#fff' }}>{value}</div>
  </div>
);

// ═══ PRESET CARD ═══
const PresetCard = ({ preset, selected, onClick }) => (
  <div
    onClick={onClick}
    style={{
      padding: '12px 16px',
      borderRadius: '10px',
      border: selected ? '2px solid #3b82f6' : '1px solid #2a2d3a',
      backgroundColor: selected ? '#1e3a5f' : '#141720',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      minWidth: '150px'
    }}
  >
    <div style={{ fontWeight: '600', fontSize: '13px', color: selected ? '#93c5fd' : '#e5e7eb', marginBottom: '4px' }}>
      {preset.label}
    </div>
    <div style={{ fontSize: '11px', color: '#6b7280' }}>{preset.description}</div>
  </div>
);

// ═══ PHOTO THUMBNAIL ═══
const PhotoThumb = ({ photo, selected, onToggle, onDelete }) => (
  <div style={{
    position: 'relative',
    borderRadius: '10px',
    overflow: 'hidden',
    border: selected ? '3px solid #3b82f6' : '2px solid #2a2d3a',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    aspectRatio: '1',
    backgroundColor: '#111'
  }}>
    <img
      src={`${BASE_URL}${photo.url}`}
      alt={photo.filename}
      onClick={onToggle}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
    {selected && (
      <div style={{
        position: 'absolute', top: '6px', right: '6px',
        backgroundColor: '#3b82f6', borderRadius: '50%',
        width: '22px', height: '22px', display: 'flex',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <CheckCircle size={14} color="#fff" />
      </div>
    )}
    <button
      onClick={(e) => { e.stopPropagation(); onDelete(); }}
      style={{
        position: 'absolute', bottom: '6px', right: '6px',
        backgroundColor: 'rgba(127,29,29,0.9)', border: 'none',
        borderRadius: '6px', padding: '4px 6px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '2px'
      }}
    >
      <Trash2 size={12} color="#fca5a5" />
    </button>
  </div>
);

// ═══ JOB CARD ═══
const JobCard = ({ job, onRefresh }) => {
  const cfg = STATUS_CONFIG[job.status] || STATUS_CONFIG.unknown;
  const Icon = cfg.icon;

  return (
    <div style={{
      backgroundColor: '#141720', border: '1px solid #2a2d3a', borderRadius: '12px',
      padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px'
    }}>
      {/* Status */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: cfg.bg, padding: '4px 10px', borderRadius: '6px'
        }}>
          <Icon size={13} color={cfg.color} />
          <span style={{ fontSize: '11px', fontWeight: '600', color: cfg.color }}>{cfg.label}</span>
        </div>
        {(job.status === 'submitted' || job.status === 'processing') && (
          <button
            onClick={() => onRefresh(job.jobSetId)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#6b7280', padding: '4px'
            }}
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      {/* Source image */}
      {job.imageUrl && (
        <div style={{ borderRadius: '8px', overflow: 'hidden', maxHeight: '120px' }}>
          <img
            src={job.imageUrl.startsWith('http') ? job.imageUrl : `${BASE_URL}${job.imageUrl}`}
            alt="Source"
            style={{ width: '100%', height: '120px', objectFit: 'cover' }}
          />
        </div>
      )}

      {/* Result video */}
      {job.status === 'completed' && job.results?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {job.results.map((r, i) => (
            <div key={i}>
              {r.videoUrl && (
                <video
                  src={r.videoUrl}
                  controls
                  style={{ width: '100%', borderRadius: '8px', maxHeight: '240px' }}
                />
              )}
              {r.videoUrl && (
                <a
                  href={r.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    color: '#3b82f6', fontSize: '12px', marginTop: '6px',
                    textDecoration: 'none'
                  }}
                >
                  <Download size={12} /> Descargar video
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Job ID */}
      <div style={{ fontSize: '10px', color: '#4b5563', fontFamily: 'monospace' }}>
        {job.jobSetId}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════
export default function VideoGenerator() {
  // State
  const [photos, setPhotos] = useState([]);
  const [selectedPhotos, setSelectedPhotos] = useState(new Set());
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [prompt, setPrompt] = useState('Smooth cinematic camera movement, studio lighting, professional product video, elegant slow motion');
  const [model, setModel] = useState('dop-turbo');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [showAllPresets, setShowAllPresets] = useState(false);
  const fileInputRef = useRef(null);
  const pollingRef = useRef(null);

  // Load data on mount
  useEffect(() => {
    loadPhotos();
    loadPresets();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // Auto-poll pending jobs
  useEffect(() => {
    const pendingJobs = jobs.filter(j => j.status === 'submitted' || j.status === 'processing');
    if (pendingJobs.length > 0 && !pollingRef.current) {
      pollingRef.current = setInterval(() => refreshPendingJobs(), 10000);
    } else if (pendingJobs.length === 0 && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [jobs]);

  const loadPhotos = async () => {
    try {
      const data = await getVideoPhotos();
      setPhotos(data.photos || []);
    } catch (err) {
      console.error('Error loading photos:', err);
    }
  };

  const loadPresets = async () => {
    try {
      const data = await getVideoPresets();
      setPresets(data.presets || []);
      if (data.presets?.length > 0) {
        setSelectedPreset(data.presets[0].id); // Default: Dolly In
      }
    } catch (err) {
      console.error('Error loading presets:', err);
    }
  };

  const handleUpload = async (e) => {
    const files = e.target.files;
    if (!files?.length) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('photos', file);
      }
      await uploadVideoPhotos(formData);
      await loadPhotos();
    } catch (err) {
      setError(`Upload error: ${err.response?.data?.error || err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (filename) => {
    try {
      await deleteVideoPhoto(filename);
      setPhotos(prev => prev.filter(p => p.filename !== filename));
      setSelectedPhotos(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
    } catch (err) {
      setError(`Delete error: ${err.message}`);
    }
  };

  const togglePhotoSelection = (filename) => {
    setSelectedPhotos(prev => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (selectedPhotos.size === photos.length) {
      setSelectedPhotos(new Set());
    } else {
      setSelectedPhotos(new Set(photos.map(p => p.filename)));
    }
  };

  const handleGenerate = async () => {
    if (selectedPhotos.size === 0) {
      setError('Selecciona al menos 1 foto');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Build public URLs for selected photos
      const origin = window.location.origin;
      const images = [...selectedPhotos].map(filename => ({
        imageUrl: `${origin}/uploads/video-photos/${filename}`,
        prompt,
        motionPresetId: selectedPreset,
        model
      }));

      if (images.length === 1) {
        // Single image
        const result = await generateVideo({
          imageUrl: images[0].imageUrl,
          prompt,
          model,
          motionPresetId: selectedPreset
        });
        setJobs(prev => [{
          ...result,
          imageUrl: `/uploads/video-photos/${[...selectedPhotos][0]}`,
          results: result.results || []
        }, ...prev]);
      } else {
        // Batch
        const result = await generateVideoBatch({ images, prompt, model, motionPresetId: selectedPreset });
        const newJobs = (result.jobs || []).map(j => ({
          ...j,
          results: j.results || []
        }));
        setJobs(prev => [...newJobs, ...prev]);
      }
    } catch (err) {
      setError(`Error generando: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const refreshPendingJobs = useCallback(async () => {
    const pending = jobs.filter(j => j.status === 'submitted' || j.status === 'processing');
    if (pending.length === 0) return;

    try {
      const ids = pending.map(j => j.jobSetId).filter(Boolean);
      if (ids.length === 0) return;
      const data = await getVideoStatusBatch(ids);

      if (data.jobs) {
        setJobs(prev => prev.map(j => {
          const updated = data.jobs.find(u => u.jobSetId === j.jobSetId);
          return updated ? { ...j, ...updated } : j;
        }));
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, [jobs]);

  const refreshSingleJob = async (jobSetId) => {
    try {
      const data = await getVideoStatus(jobSetId);
      setJobs(prev => prev.map(j =>
        j.jobSetId === jobSetId ? { ...j, ...data } : j
      ));
    } catch (err) {
      console.error('Refresh error:', err);
    }
  };

  const completedJobs = jobs.filter(j => j.status === 'completed');
  const pendingJobs = jobs.filter(j => j.status === 'submitted' || j.status === 'processing');
  const failedJobs = jobs.filter(j => j.status === 'failed' || j.status === 'error');

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* ═══ HEADER ═══ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Video size={24} color="#8b5cf6" />
            Video Generator
          </h1>
          <p style={{ color: '#6b7280', fontSize: '13px' }}>
            Genera videos de producto con IA — sube fotos y selecciona movimiento de camara
          </p>
        </div>
      </div>

      {/* ═══ STATS ═══ */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <StatBadge icon={Image} iconColor="#3b82f6" label="Fotos" value={photos.length} />
        <StatBadge icon={CheckCircle} iconColor="#22c55e" label="Seleccionadas" value={selectedPhotos.size} />
        <StatBadge icon={Film} iconColor="#8b5cf6" label="Videos Generados" value={completedJobs.length} />
        <StatBadge icon={Clock} iconColor="#f59e0b" label="En Proceso" value={pendingJobs.length} />
      </div>

      {/* ═══ ERROR BANNER ═══ */}
      {error && (
        <div style={{
          backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '10px',
          padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px'
        }}>
          <AlertTriangle size={16} color="#fca5a5" />
          <span style={{ color: '#fca5a5', fontSize: '13px' }}>{error}</span>
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer' }}>
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* ═══ SECTION 1: PRODUCT PHOTOS ═══ */}
      <div style={{
        backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
        padding: '24px', marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Camera size={18} color="#3b82f6" />
            Fotos del Producto
          </h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {photos.length > 0 && (
              <button
                onClick={selectAll}
                style={{
                  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                  padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}
              >
                <CheckCircle size={14} />
                {selectedPhotos.size === photos.length ? 'Deseleccionar' : 'Seleccionar Todas'}
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                backgroundColor: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: '8px',
                padding: '8px 16px', color: '#93c5fd', fontSize: '12px', fontWeight: '600',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                opacity: uploading ? 0.6 : 1
              }}
            >
              {uploading ? <Loader size={14} className="spin" /> : <Upload size={14} />}
              {uploading ? 'Subiendo...' : 'Subir Fotos'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
          </div>
        </div>

        {photos.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '48px 20px',
            border: '2px dashed #2a2d3a', borderRadius: '12px'
          }}>
            <Upload size={40} color="#4b5563" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '4px' }}>
              Sube hasta 15 fotos del producto
            </p>
            <p style={{ color: '#4b5563', fontSize: '12px' }}>
              Diferentes angulos — frontal, lateral, detalle, etiqueta, etc.
            </p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: '12px'
          }}>
            {photos.map(photo => (
              <PhotoThumb
                key={photo.filename}
                photo={photo}
                selected={selectedPhotos.has(photo.filename)}
                onToggle={() => togglePhotoSelection(photo.filename)}
                onDelete={() => handleDelete(photo.filename)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ═══ SECTION 2: GENERATION SETTINGS ═══ */}
      <div style={{
        backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
        padding: '24px', marginBottom: '20px'
      }}>
        <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={18} color="#f59e0b" />
          Configuracion de Video
        </h2>

        {/* Motion Presets */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ color: '#9ca3af', fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px', display: 'block' }}>
            Movimiento de Camara
          </label>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {presets.map(preset => (
              <PresetCard
                key={preset.key}
                preset={preset}
                selected={selectedPreset === preset.id}
                onClick={() => setSelectedPreset(preset.id)}
              />
            ))}
          </div>
        </div>

        {/* Prompt */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ color: '#9ca3af', fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', display: 'block' }}>
            Prompt (descripcion del video)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            style={{
              width: '100%', backgroundColor: '#0d0f14', border: '1px solid #2a2d3a',
              borderRadius: '10px', padding: '12px', color: '#e5e7eb', fontSize: '13px',
              fontFamily: 'Inter, system-ui, sans-serif', resize: 'vertical',
              boxSizing: 'border-box'
            }}
            placeholder="Describe el estilo de video que quieres..."
          />
        </div>

        {/* Model selector */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ color: '#9ca3af', fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', display: 'block' }}>
            Modelo
          </label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {[
              { value: 'dop-lite', label: 'Lite', desc: 'Rapido, $0.12/video' },
              { value: 'dop-turbo', label: 'Turbo', desc: 'Equilibrado, $0.40/video' },
              { value: 'dop-standard', label: 'Standard', desc: 'Mejor calidad, $0.56/video' }
            ].map(m => (
              <div
                key={m.value}
                onClick={() => setModel(m.value)}
                style={{
                  padding: '10px 16px', borderRadius: '10px', cursor: 'pointer',
                  border: model === m.value ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                  backgroundColor: model === m.value ? '#2e1065' : '#141720',
                  minWidth: '130px'
                }}
              >
                <div style={{ fontWeight: '600', fontSize: '13px', color: model === m.value ? '#c4b5fd' : '#e5e7eb' }}>
                  {m.label}
                </div>
                <div style={{ fontSize: '11px', color: '#6b7280' }}>{m.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={loading || selectedPhotos.size === 0}
          style={{
            width: '100%', padding: '14px',
            backgroundColor: loading ? '#374151' : '#7c3aed',
            border: 'none', borderRadius: '10px',
            color: '#fff', fontSize: '14px', fontWeight: '700',
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            opacity: selectedPhotos.size === 0 ? 0.5 : 1,
            transition: 'all 0.15s ease'
          }}
        >
          {loading ? (
            <>
              <Loader size={18} className="spin" />
              Generando {selectedPhotos.size} video{selectedPhotos.size !== 1 ? 's' : ''}...
            </>
          ) : (
            <>
              <Play size={18} />
              Generar {selectedPhotos.size} Video{selectedPhotos.size !== 1 ? 's' : ''}
            </>
          )}
        </button>

        {selectedPhotos.size > 0 && (
          <div style={{ textAlign: 'center', marginTop: '8px', color: '#6b7280', fontSize: '12px' }}>
            Costo estimado: ~${(selectedPhotos.size * (model === 'dop-lite' ? 0.12 : model === 'dop-turbo' ? 0.40 : 0.56)).toFixed(2)} USD
          </div>
        )}
      </div>

      {/* ═══ SECTION 3: GENERATED VIDEOS ═══ */}
      {jobs.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Film size={18} color="#8b5cf6" />
              Videos Generados ({jobs.length})
            </h2>
            {pendingJobs.length > 0 && (
              <button
                onClick={refreshPendingJobs}
                style={{
                  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                  padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}
              >
                <RefreshCw size={14} />
                Actualizar ({pendingJobs.length} en proceso)
              </button>
            )}
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '16px'
          }}>
            {jobs.map((job, idx) => (
              <JobCard key={job.jobSetId || idx} job={job} onRefresh={refreshSingleJob} />
            ))}
          </div>
        </div>
      )}

      {/* Spinner CSS */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  );
}
