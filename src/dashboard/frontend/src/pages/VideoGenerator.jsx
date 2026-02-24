import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Video, Upload, Image, Play, Trash2, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Camera, Zap, Download,
  Loader, Film, ArrowRight, Eye, Edit3, Brain, LayoutGrid, Star, Award, RotateCcw,
  Music, Type
} from 'lucide-react';
import {
  getVideoMotions, uploadProductPhoto, getVideoShots,
  deleteVideoShot, generateShots, getShotJobStatus,
  analyzeScene, judgeShots, regenerateShot,
  generateClipsBatch, getClipStatus, getClipStatusBatch,
  stitchClips, getStitchStatus, getMusicTracks,
  getVideoModels, getVideoTemplates
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

// ═══ SCORE COLORS ═══
const getScoreColor = (score) => {
  if (score >= 8) return { color: '#22c55e', bg: '#14532d', border: '#22c55e' };
  if (score >= 6) return { color: '#f59e0b', bg: '#78350f', border: '#f59e0b' };
  return { color: '#ef4444', bg: '#7f1d1d', border: '#ef4444' };
};

const getVerdictLabel = (verdict) => {
  if (verdict === 'approve') return 'Aprobado';
  if (verdict === 'marginal') return 'Marginal';
  return 'Rechazado';
};

// ═══ STEP INDICATOR ═══
const StepIndicator = ({ number, title, subtitle, active, done }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
    borderRadius: '10px', backgroundColor: active ? '#1e3a5f' : done ? '#14532d' : '#141720',
    border: `1px solid ${active ? '#3b82f6' : done ? '#22c55e' : '#2a2d3a'}`,
    opacity: (!active && !done) ? 0.5 : 1, transition: 'all 0.2s ease', flex: 1, minWidth: '120px'
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

// ═══ BEAT TYPE COLORS ═══
const BEAT_TYPE_STYLES = {
  context: { color: '#22c55e', bg: '#14532d', border: '#22c55e', label: 'CONTEXTO' },
  product: { color: '#3b82f6', bg: '#1e3a5f', border: '#3b82f6', label: 'PRODUCTO' }
};

// ═══ SHOT CARD with Score Badge + Beat Type ═══
const ShotCard = ({ shot, score, selected, onToggle, onDelete, onRegenerate, regenerating, beatType }) => {
  const scoreInfo = score ? getScoreColor(score.score) : null;
  const typeStyle = BEAT_TYPE_STYLES[beatType] || BEAT_TYPE_STYLES.product;
  return (
    <div style={{
      position: 'relative', borderRadius: '10px', overflow: 'hidden',
      border: selected ? '3px solid #3b82f6' : `2px solid ${typeStyle.border}40`,
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

      {/* Beat Type Badge */}
      <div style={{
        position: 'absolute', top: score ? '52px' : '6px', left: '6px',
        backgroundColor: typeStyle.bg, border: `1px solid ${typeStyle.color}60`,
        borderRadius: '6px', padding: '2px 6px', fontSize: '8px', fontWeight: '700',
        color: typeStyle.color, letterSpacing: '0.05em'
      }}>
        {typeStyle.label}
      </div>

      {/* Score Badge */}
      {score && (
        <div style={{
          position: 'absolute', top: '6px', left: '6px', display: 'flex', flexDirection: 'column', gap: '4px'
        }}>
          <div style={{
            backgroundColor: scoreInfo.bg, border: `1px solid ${scoreInfo.color}`,
            borderRadius: '8px', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px'
          }}>
            <Star size={11} color={scoreInfo.color} fill={score.score >= 7 ? scoreInfo.color : 'none'} />
            <span style={{ fontSize: '12px', fontWeight: '700', color: scoreInfo.color }}>{score.score}/10</span>
          </div>
          <div style={{
            backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: '6px', padding: '2px 6px',
            fontSize: '9px', color: scoreInfo.color, fontWeight: '600', textAlign: 'center'
          }}>
            {getVerdictLabel(score.verdict)}
          </div>
        </div>
      )}

      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 8px',
        background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <span style={{ fontSize: '10px', color: '#d1d5db', fontWeight: '600' }}>{shot.label || shot.angle}</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          {score && score.verdict !== 'approve' && (
            <button onClick={(e) => { e.stopPropagation(); onRegenerate(); }}
              disabled={regenerating}
              style={{ background: 'none', border: 'none', cursor: regenerating ? 'not-allowed' : 'pointer', padding: '2px' }}>
              {regenerating
                ? <Loader size={12} color="#f59e0b" className="spin" />
                : <RotateCcw size={12} color="#f59e0b" />
              }
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
            <Trash2 size={12} color="#fca5a5" />
          </button>
        </div>
      </div>

      {/* Score reason tooltip on hover */}
      {score?.reason && (
        <div style={{
          position: 'absolute', bottom: '28px', left: '4px', right: '4px',
          backgroundColor: 'rgba(0,0,0,0.9)', borderRadius: '6px', padding: '6px 8px',
          fontSize: '9px', color: '#d1d5db', lineHeight: '1.3',
          opacity: 0, transition: 'opacity 0.2s', pointerEvents: 'none'
        }} className="score-tooltip">
          {score.reason}
        </div>
      )}
    </div>
  );
};

// ═══ STORYBOARD CARD (step 4) ═══
const StoryboardCard = ({ index, shot, prompt, cameraMotion, score, beatType, onPromptChange, onMotionChange, motions }) => {
  const scoreInfo = score ? getScoreColor(score.score) : null;
  const typeStyle = BEAT_TYPE_STYLES[beatType] || BEAT_TYPE_STYLES.product;
  return (
    <div style={{
      backgroundColor: '#0d0f14', border: `1px solid ${typeStyle.border}30`, borderRadius: '12px',
      overflow: 'hidden', display: 'flex', flexDirection: 'column'
    }}>
      <div style={{ position: 'relative' }}>
        <img src={`${BASE_URL}${shot.url}`} alt={shot.angle}
          style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover' }} />
        <div style={{
          position: 'absolute', top: '6px', left: '6px', display: 'flex', alignItems: 'center', gap: '6px'
        }}>
          <div style={{
            backgroundColor: '#7c3aed', borderRadius: '50%', width: '26px', height: '26px', display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '12px', color: '#fff'
          }}>
            {index + 1}
          </div>
          <div style={{
            backgroundColor: typeStyle.bg, border: `1px solid ${typeStyle.color}60`,
            borderRadius: '6px', padding: '2px 6px', fontSize: '8px', fontWeight: '700',
            color: typeStyle.color, letterSpacing: '0.05em'
          }}>
            {typeStyle.label}
          </div>
        </div>
        {score && (
          <div style={{
            position: 'absolute', top: '6px', right: '6px',
            backgroundColor: scoreInfo.bg, border: `1px solid ${scoreInfo.color}`,
            borderRadius: '8px', padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '3px'
          }}>
            <Star size={10} color={scoreInfo.color} fill={score.score >= 7 ? scoreInfo.color : 'none'} />
            <span style={{ fontSize: '11px', fontWeight: '700', color: scoreInfo.color }}>{score.score}</span>
          </div>
        )}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 8px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.85))'
        }}>
          <span style={{ fontSize: '10px', color: '#c4b5fd', fontWeight: '600' }}>{shot.label || shot.angle}</span>
        </div>
      </div>

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
};

// ═══ CLIP CARD (step 5 results) ═══
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
  // Step 1: Product photo + template
  const [productPhoto, setProductPhoto] = useState(null);
  const [productDescription, setProductDescription] = useState('Jersey Pickles product jar');
  const [uploading, setUploading] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('quick-cut-food');

  // Step 2: Claude Director Creativo
  const [directorPlan, setDirectorPlan] = useState(null);
  const [analyzingScene, setAnalyzingScene] = useState(false);

  // Step 3: Generated shots (async) + quality scores
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState(new Set());
  const [shotJobId, setShotJobId] = useState(null);
  const [shotJobStatus, setShotJobStatus] = useState(null);
  const [numShots, setNumShots] = useState(12);
  const [shotScores, setShotScores] = useState(null); // { scores: { key: { score, verdict, reason } }, overallAverage, summary }
  const [judging, setJudging] = useState(false);
  const [regeneratingShot, setRegeneratingShot] = useState(null);

  // Step 4: Storyboard + Claude prompts
  const [storyboard, setStoryboard] = useState([]);

  // Step 5: Video clips
  const [motions, setMotions] = useState([]);
  const [duration, setDuration] = useState(5);
  const [clips, setClips] = useState([]);
  const [generatingClips, setGeneratingClips] = useState(false);

  // Video model selection
  const [videoModels, setVideoModels] = useState({});
  const [selectedVideoModel, setSelectedVideoModel] = useState('grok-imagine-720p');

  // Step 6: Final commercial video (stitched)
  const [stitchJobId, setStitchJobId] = useState(null);
  const [stitchStatus, setStitchStatus] = useState(null);

  // Production options: music + closing text
  const [musicTracks, setMusicTracks] = useState([]);
  const [selectedMusic, setSelectedMusic] = useState('none');
  const [brandText, setBrandText] = useState('');

  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const shotPollRef = useRef(null);
  const clipPollRef = useRef(null);
  const stitchPollRef = useRef(null);

  // Load motions + music tracks + video models + templates + existing shots on mount
  useEffect(() => {
    loadMotions();
    loadMusicTracks();
    loadVideoModels();
    loadTemplates();
    loadShots();
    return () => {
      if (shotPollRef.current) clearInterval(shotPollRef.current);
      if (clipPollRef.current) clearInterval(clipPollRef.current);
      if (stitchPollRef.current) clearInterval(stitchPollRef.current);
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

  // Poll stitch job
  useEffect(() => {
    if (stitchJobId && stitchStatus?.status === 'running') {
      stitchPollRef.current = setInterval(pollStitchJob, 5000);
      return () => { clearInterval(stitchPollRef.current); stitchPollRef.current = null; };
    }
  }, [stitchJobId, stitchStatus?.status]);

  const loadMotions = async () => {
    try {
      const data = await getVideoMotions();
      setMotions(data.motions || []);
    } catch (err) { console.error('Load motions error:', err); }
  };

  const loadMusicTracks = async () => {
    try {
      const data = await getMusicTracks();
      setMusicTracks(data.tracks || []);
    } catch (err) { console.error('Load music tracks error:', err); }
  };

  const loadVideoModels = async () => {
    try {
      const data = await getVideoModels();
      setVideoModels(data.models || {});
      if (data.default) setSelectedVideoModel(data.default);
    } catch (err) { console.error('Load video models error:', err); }
  };

  const loadTemplates = async () => {
    try {
      const data = await getVideoTemplates();
      setTemplates(data.templates || []);
    } catch (err) { console.error('Load templates error:', err); }
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

  // ═══ Step 2: Claude Director Creativo ═══
  const handleAnalyzeScene = async () => {
    if (!productPhoto) return;
    setAnalyzingScene(true);
    setError(null);
    setDirectorPlan(null);
    setShots([]);
    setShotScores(null);
    setSelectedShots(new Set());
    setStoryboard([]);
    try {
      const plan = await analyzeScene({
        productImagePath: productPhoto.path || productPhoto.url,
        productDescription,
        templateKey: selectedTemplate
      });
      setDirectorPlan(plan);
      // Set numShots from template beat count
      const tpl = templates.find(t => t.key === selectedTemplate);
      if (tpl) setNumShots(tpl.beats);
      // Set clip duration from template
      if (plan.templateClipDuration) setDuration(plan.templateClipDuration);
      // Pre-fill music, closing text, and video model from Director recommendation
      if (plan.recommendedMusic) setSelectedMusic(plan.recommendedMusic);
      if (plan.closingText) setBrandText(plan.closingText);
      if (plan.videoModel && videoModels[plan.videoModel]) setSelectedVideoModel(plan.videoModel);
    } catch (err) {
      setError(`Error en Director Creativo: ${err.response?.data?.error || err.message}`);
    } finally {
      setAnalyzingScene(false);
    }
  };

  // ═══ Step 3: Generate shots (async) ═══
  const handleGenerateShots = async () => {
    if (!productPhoto || !directorPlan) return;
    setError(null);
    setShotJobStatus(null);
    setShots([]);
    setShotScores(null);
    setSelectedShots(new Set());
    setStoryboard([]);
    try {
      const data = await generateShots({
        productImagePath: productPhoto.path || productPhoto.url,
        productDescription,
        numShots,
        directorPlan
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

      if (data.shots?.length > 0) {
        const completedShots = data.shots.filter(s => s.status === 'completed');
        setShots(completedShots);
      }

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

  // ═══ Step 3b: Quality Judge ═══
  const handleJudgeShots = async () => {
    if (shots.length === 0) return;
    setJudging(true);
    setError(null);
    try {
      const result = await judgeShots({
        shots,
        productDescription,
        originalImagePath: productPhoto?.path || productPhoto?.url,
        directorPlan
      });
      setShotScores(result);
      // Auto-select all approved shots
      const approvedSet = new Set();
      for (const shot of shots) {
        const score = result.scores?.[shot.angle];
        if (score && score.verdict === 'approve') {
          approvedSet.add(shot.filename);
        }
      }
      setSelectedShots(approvedSet);
    } catch (err) {
      setError(`Error en Quality Judge: ${err.response?.data?.error || err.message}`);
    } finally {
      setJudging(false);
    }
  };

  // ═══ Step 3c: Regenerate single shot ═══
  const handleRegenerateShot = async (shot) => {
    if (!productPhoto || !directorPlan) return;
    setRegeneratingShot(shot.angle);
    try {
      const imagePrompt = directorPlan.shots?.[shot.angle]?.imagePrompt || '';
      const beatType = directorPlan.shots?.[shot.angle]?.type || shot.type || 'product';
      const result = await regenerateShot({
        productImagePath: productPhoto.path || productPhoto.url,
        shotKey: shot.angle,
        imagePrompt,
        productDescription,
        beatType
      });

      // Replace the old shot with new one
      setShots(prev => prev.map(s => s.angle === shot.angle ? { ...result, videoPrompt: shot.videoPrompt } : s));

      // Clear the score for this shot
      if (shotScores) {
        setShotScores(prev => ({
          ...prev,
          scores: { ...prev.scores, [shot.angle]: null }
        }));
      }
    } catch (err) {
      setError(`Error regenerando ${shot.angle}: ${err.response?.data?.error || err.message}`);
    } finally {
      setRegeneratingShot(null);
    }
  };

  // ═══ Step 4: Build storyboard ═══
  const handleBuildStoryboard = () => {
    if (selectedShots.size === 0) { setError('Selecciona al menos 1 shot para el storyboard'); return; }

    const selectedShotsList = [...selectedShots]
      .map(filename => shots.find(s => s.filename === filename))
      .filter(Boolean);

    const defaultMotion = 'slow-dolly-in';
    const sb = selectedShotsList.map(shot => ({
      shot,
      prompt: shot.videoPrompt || directorPlan?.shots?.[shot.angle]?.videoPrompt || '',
      cameraMotion: defaultMotion,
      score: shotScores?.scores?.[shot.angle] || null,
      beatType: directorPlan?.shots?.[shot.angle]?.type || shot.type || 'product'
    }));
    setStoryboard(sb);
  };

  const updateStoryboardPrompt = (index, prompt) => {
    setStoryboard(prev => prev.map((item, i) => i === index ? { ...item, prompt } : item));
  };

  const updateStoryboardMotion = (index, cameraMotion) => {
    setStoryboard(prev => prev.map((item, i) => i === index ? { ...item, cameraMotion } : item));
  };

  // ═══ Step 5: Generate videos ═══
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

      const data = await generateClipsBatch({ shots: shotsList, duration, videoModel: selectedVideoModel });
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
      const data = await getClipStatusBatch(ids, selectedVideoModel);
      if (data.jobs) {
        const updatedClips = clips.map(c => {
          const updated = data.jobs.find(u => u.requestId === c.requestId);
          return updated ? { ...c, ...updated } : c;
        });
        setClips(updatedClips);

        // Auto-stitch: if ALL clips are now completed and no stitch running yet
        const allDone = updatedClips.length >= 2 &&
          updatedClips.every(c => c.status === 'completed' && c.videoUrl) &&
          !stitchJobId && !stitchStatus;
        if (allDone) {
          const urls = updatedClips.map(c => c.videoUrl);
          try {
            const stitchData = await stitchClips(urls, {
              musicTrack: selectedMusic,
              brandText: brandText,
              crossfadeDuration: 0.5
            });
            setStitchJobId(stitchData.jobId);
            setStitchStatus({ status: 'running', totalClips: stitchData.totalClips, downloaded: 0 });
          } catch (err) {
            console.error('Auto-stitch error:', err);
          }
        }
      }
    } catch (err) { console.error('Poll error:', err); }
  }, [clips, stitchJobId, stitchStatus, selectedMusic, brandText, selectedVideoModel]);

  const refreshSingleClip = async (requestId) => {
    try {
      const data = await getClipStatus(requestId, selectedVideoModel);
      setClips(prev => prev.map(c => c.requestId === requestId ? { ...c, ...data } : c));
    } catch (err) { console.error('Refresh error:', err); }
  };

  // ═══ Step 6: Stitch clips into ONE commercial ═══
  const handleStitchClips = async () => {
    const completedClipUrls = clips
      .filter(c => c.status === 'completed' && c.videoUrl)
      .map(c => c.videoUrl);

    if (completedClipUrls.length < 2) {
      setError('Se necesitan al menos 2 clips completados para crear el video comercial');
      return;
    }

    setError(null);
    setStitchStatus(null);
    try {
      const data = await stitchClips(completedClipUrls, {
        musicTrack: selectedMusic,
        brandText: brandText,
        crossfadeDuration: 0.5
      });
      setStitchJobId(data.jobId);
      setStitchStatus({ status: 'running', totalClips: data.totalClips, downloaded: 0 });
    } catch (err) {
      setError(`Error iniciando ensamblaje: ${err.response?.data?.error || err.message}`);
    }
  };

  const pollStitchJob = async () => {
    if (!stitchJobId) return;
    try {
      const data = await getStitchStatus(stitchJobId);
      setStitchStatus(data);
      if (data.status === 'done' || data.status === 'failed') {
        if (stitchPollRef.current) { clearInterval(stitchPollRef.current); stitchPollRef.current = null; }
        if (data.status === 'failed' && data.error) {
          setError(`Error en ensamblaje: ${data.error}`);
        }
      }
    } catch (err) {
      console.error('Poll stitch error:', err);
    }
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
  const isStitching = stitchStatus?.status === 'running';

  // Determine current step
  let step = 1;
  if (productPhoto) step = 2;
  if (directorPlan) step = 3;
  if (shots.length > 0 && !isGeneratingShots) step = 3;
  if (storyboard.length > 0) step = 4;
  if (clips.length > 0) step = 5;
  if (stitchStatus?.status === 'done') step = 6;

  const sceneInfo = directorPlan ? {
    label: directorPlan.sceneLabel,
    reason: directorPlan.sceneReason,
    key: directorPlan.chosenScene
  } : null;

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* ═══ HEADER ═══ */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Video size={24} color="#8b5cf6" />
          Video AI — Director Creativo
        </h1>
        <p style={{ color: '#6b7280', fontSize: '13px' }}>
          Foto + Template → Director → Beats → Jurado → Storyboard → Clips ({videoModels[selectedVideoModel]?.label || 'Grok Imagine'}) → Video Comercial Final
        </p>
      </div>

      {/* ═══ STEP INDICATORS ═══ */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
        <StepIndicator number={1} title="Foto" subtitle="+ Template" active={step === 1} done={!!productPhoto} />
        <ArrowRight size={14} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={2} title="Director" subtitle="Claude IA" active={step === 2} done={!!directorPlan} />
        <ArrowRight size={14} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={3} title="Beats" subtitle={`${numShots} tomas`} active={step === 3} done={shots.length > 0 && !isGeneratingShots && shotScores} />
        <ArrowRight size={14} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={4} title="Storyboard" subtitle="Secuencia" active={step === 4} done={storyboard.length > 0} />
        <ArrowRight size={14} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={5} title="Clips" subtitle={videoModels[selectedVideoModel]?.label || 'Grok Imagine'} active={step === 5} done={completedClips.length > 0} />
        <ArrowRight size={14} color="#374151" style={{ flexShrink: 0 }} />
        <StepIndicator number={6} title="Comercial" subtitle="Video Final" active={step === 6} done={stitchStatus?.status === 'done'} />
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
              {/* Template selector */}
              {templates.length > 0 && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>
                    Estilo de Comercial
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                    {templates.map(t => {
                      const isSelected = selectedTemplate === t.key;
                      const styleColors = {
                        'fast-paced': { color: '#f59e0b', bg: '#78350f', border: '#f59e0b' },
                        'recipe': { color: '#22c55e', bg: '#14532d', border: '#22c55e' },
                        'lifestyle': { color: '#ec4899', bg: '#831843', border: '#ec4899' },
                        'asmr': { color: '#8b5cf6', bg: '#3b0764', border: '#8b5cf6' },
                        'before-after': { color: '#3b82f6', bg: '#1e3a5f', border: '#3b82f6' },
                        'cinematic': { color: '#9ca3af', bg: '#1f2937', border: '#6b7280' }
                      };
                      const sc = styleColors[t.style] || styleColors.cinematic;
                      return (
                        <button key={t.key} onClick={() => setSelectedTemplate(t.key)}
                          style={{
                            textAlign: 'left', padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
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

              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleAnalyzeScene} disabled={analyzingScene}
                  style={{
                    padding: '10px 20px', backgroundColor: analyzingScene ? '#374151' : '#7c3aed',
                    border: 'none', borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: '600',
                    cursor: analyzingScene ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {analyzingScene ? <><Loader size={14} className="spin" /> Claude analizando...</> : <><Brain size={14} /> Director Creativo</>}
                </button>
                <button onClick={() => { setProductPhoto(null); setDirectorPlan(null); setShots([]); setSelectedShots(new Set()); setStoryboard([]); setShotScores(null); }}
                  style={{ padding: '10px 14px', backgroundColor: '#1f2937', border: 'none', borderRadius: '8px', color: '#9ca3af', fontSize: '13px', cursor: 'pointer' }}>
                  Cambiar foto
                </button>
              </div>
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} style={{ display: 'none' }} />
      </div>

      {/* ═══ STEP 2: DIRECTOR CREATIVO RECOMMENDATION ═══ */}
      {directorPlan && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Brain size={18} color="#c4b5fd" />
            Paso 2 — Director Creativo
          </h2>

          {/* Product identification */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', color: '#93c5fd' }}>
              {directorPlan.brand} {directorPlan.productName}
            </div>
            <div style={{ backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', color: '#f59e0b' }}>
              {directorPlan.category}
            </div>
            {directorPlan.targetAudience && (
              <div style={{ backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', color: '#a78bfa' }}>
                {directorPlan.targetAudience}
              </div>
            )}
          </div>

          {/* Detected Ingredients */}
          {directorPlan.ingredients && directorPlan.ingredients.length > 0 && (
            <div style={{
              backgroundColor: '#0d1f0d', border: '1px solid #22c55e30', borderRadius: '10px',
              padding: '10px 14px', marginBottom: '16px'
            }}>
              <div style={{ fontSize: '11px', color: '#22c55e', fontWeight: '600', marginBottom: '6px' }}>
                Ingredientes detectados
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {directorPlan.ingredients.map((ing, i) => (
                  <span key={i} style={{
                    backgroundColor: '#14532d', border: '1px solid #22c55e40',
                    padding: '3px 10px', borderRadius: '12px', fontSize: '11px', color: '#86efac'
                  }}>{ing}</span>
                ))}
              </div>
            </div>
          )}

          {/* Shot Type Legend */}
          <div style={{
            display: 'flex', gap: '16px', marginBottom: '16px', fontSize: '11px', flexWrap: 'wrap'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '3px', backgroundColor: '#22c55e' }} />
              <span style={{ color: '#9ca3af' }}>CONTEXTO — Ingredientes, lifestyle, proceso (text-to-image)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '3px', backgroundColor: '#3b82f6' }} />
              <span style={{ color: '#9ca3af' }}>PRODUCTO — Hero, label, accion (image edit)</span>
            </div>
          </div>

          {/* Scene recommendation */}
          <div style={{
            backgroundColor: '#0d0f14', border: '2px solid #7c3aed', borderRadius: '12px',
            padding: '16px', marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Award size={16} color="#c4b5fd" />
              <span style={{ color: '#c4b5fd', fontSize: '13px', fontWeight: '700' }}>
                Escena recomendada: {sceneInfo?.label}
              </span>
            </div>
            <p style={{ color: '#9ca3af', fontSize: '12px', lineHeight: '1.5', margin: 0 }}>
              {sceneInfo?.reason}
            </p>
          </div>

          {/* Music + closing text recommendation */}
          {(directorPlan.recommendedMusic || directorPlan.closingText) && (
            <div style={{
              display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px'
            }}>
              {directorPlan.recommendedMusic && directorPlan.recommendedMusic !== 'none' && (
                <div style={{
                  backgroundColor: '#1e1338', border: '1px solid #7c3aed40', padding: '6px 12px',
                  borderRadius: '8px', fontSize: '12px', color: '#c4b5fd', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <Music size={12} />
                  Musica: {musicTracks.find(t => t.key === directorPlan.recommendedMusic)?.label || directorPlan.recommendedMusic}
                </div>
              )}
              {directorPlan.closingText && (
                <div style={{
                  backgroundColor: '#0d2818', border: '1px solid #22c55e40', padding: '6px 12px',
                  borderRadius: '8px', fontSize: '12px', color: '#86efac', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <Type size={12} />
                  Cierre: "{directorPlan.closingText}"
                </div>
              )}
            </div>
          )}

          {/* Narrative summary */}
          {directorPlan.narrativeSummary && (
            <div style={{
              backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '10px',
              padding: '12px 16px', marginBottom: '16px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <Film size={14} color="#93c5fd" />
                <span style={{ color: '#93c5fd', fontSize: '12px', fontWeight: '600' }}>Narrativa del Comercial</span>
              </div>
              <p style={{ color: '#9ca3af', fontSize: '12px', lineHeight: '1.5', margin: 0 }}>
                {directorPlan.narrativeSummary}
              </p>
            </div>
          )}

          {/* Template info + generate */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            {directorPlan.templateLabel && (
              <div style={{
                backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px',
                fontSize: '12px', color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                <Film size={13} />
                Template: {directorPlan.templateLabel} ({numShots} beats)
              </div>
            )}
            <button onClick={handleGenerateShots} disabled={isGeneratingShots}
              style={{
                padding: '10px 20px', backgroundColor: isGeneratingShots ? '#374151' : '#7c3aed',
                border: 'none', borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: '600',
                cursor: isGeneratingShots ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
              }}>
              {isGeneratingShots ? <><Loader size={14} className="spin" /> Generando...</> : <><Zap size={14} /> Generar {numShots} Tomas</>}
            </button>
          </div>

          {isGeneratingShots && shotJobStatus && (
            <ProgressBar
              completed={shotJobStatus.completed || 0}
              total={shotJobStatus.total || numShots}
              failed={shotJobStatus.failed || 0}
            />
          )}
        </div>
      )}

      {/* ═══ STEP 3: GENERATED SHOTS + QUALITY JUDGE ═══ */}
      {shots.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Image size={18} color="#f59e0b" />
              Paso 3 — Beats Narrativos ({shots.length})
              {isGeneratingShots && <Loader size={14} className="spin" color="#f59e0b" />}
            </h2>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!isGeneratingShots && !shotScores && shots.length > 0 && (
                <button onClick={handleJudgeShots} disabled={judging}
                  style={{
                    backgroundColor: judging ? '#374151' : '#d97706', border: 'none', borderRadius: '8px',
                    padding: '8px 16px', color: '#fff', fontSize: '12px', fontWeight: '600',
                    cursor: judging ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {judging ? <><Loader size={14} className="spin" /> Jurado evaluando...</> : <><Star size={14} /> Evaluar Calidad</>}
                </button>
              )}
              {shotScores && (
                <button onClick={handleJudgeShots} disabled={judging}
                  style={{
                    backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                    padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                    cursor: judging ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {judging ? <><Loader size={14} className="spin" /> Re-evaluando...</> : <><RefreshCw size={14} /> Re-evaluar</>}
                </button>
              )}
              <button onClick={selectAllShots}
                style={{
                  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
                  padding: '8px 14px', color: '#93c5fd', fontSize: '12px', fontWeight: '500',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                <CheckCircle size={14} />
                {selectedShots.size === shots.length ? 'Deseleccionar' : `Seleccionar Todas`}
              </button>
              {selectedShots.size > 0 && !isGeneratingShots && (
                <button onClick={handleBuildStoryboard}
                  style={{
                    backgroundColor: '#7c3aed', border: 'none', borderRadius: '8px',
                    padding: '8px 16px', color: '#fff', fontSize: '12px', fontWeight: '600',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  <LayoutGrid size={14} /> Crear Storyboard ({selectedShots.size})
                </button>
              )}
            </div>
          </div>

          {/* Quality Judge Summary */}
          {shotScores && (
            <div style={{
              backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '10px',
              padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Award size={16} color="#f59e0b" />
                <span style={{ color: '#f59e0b', fontSize: '13px', fontWeight: '700' }}>
                  Promedio: {shotScores.overallAverage}/10
                </span>
              </div>
              <span style={{ color: '#9ca3af', fontSize: '12px', flex: 1 }}>{shotScores.summary}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: '#22c55e' }}>
                  {Object.values(shotScores.scores || {}).filter(s => s?.verdict === 'approve').length} aprobados
                </span>
                <span style={{ fontSize: '11px', color: '#f59e0b' }}>
                  {Object.values(shotScores.scores || {}).filter(s => s?.verdict === 'marginal').length} marginales
                </span>
                <span style={{ fontSize: '11px', color: '#ef4444' }}>
                  {Object.values(shotScores.scores || {}).filter(s => s?.verdict === 'reject').length} rechazados
                </span>
              </div>
            </div>
          )}

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px'
          }}>
            {shots.map(shot => (
              <ShotCard key={shot.filename} shot={shot}
                score={shotScores?.scores?.[shot.angle]}
                selected={selectedShots.has(shot.filename)}
                onToggle={() => toggleShot(shot.filename)}
                onDelete={() => handleDeleteShot(shot.filename)}
                onRegenerate={() => handleRegenerateShot(shot)}
                regenerating={regeneratingShot === shot.angle}
                beatType={directorPlan?.shots?.[shot.angle]?.type || shot.type || 'product'}
              />
            ))}
          </div>

          <div style={{ color: '#6b7280', fontSize: '12px', marginTop: '12px' }}>
            {selectedShots.size} de {shots.length} seleccionadas para storyboard
          </div>
        </div>
      )}

      {/* ═══ STEP 4: STORYBOARD ═══ */}
      {storyboard.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <LayoutGrid size={18} color="#c4b5fd" />
              Paso 4 — Storyboard
            </h2>
            {directorPlan && (
              <div style={{
                backgroundColor: '#1e293b', padding: '6px 12px', borderRadius: '8px',
                fontSize: '12px', color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                <Brain size={13} />
                {directorPlan.brand} {directorPlan.productName} — {sceneInfo?.label}
              </div>
            )}
          </div>

          {/* Model selector + Duration selector */}
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' }}>
            {/* Video Model */}
            <div>
              <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
                Modelo de Video
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {Object.values(videoModels).map(m => (
                  <button key={m.key} onClick={() => setSelectedVideoModel(m.key)}
                    style={{
                      padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '11px',
                      border: selectedVideoModel === m.key ? '2px solid #8b5cf6' : '1px solid #2a2d3a',
                      backgroundColor: selectedVideoModel === m.key ? '#2e1065' : '#141720',
                      color: selectedVideoModel === m.key ? '#c4b5fd' : '#9ca3af'
                    }}>
                    {m.label}
                    <span style={{ fontSize: '9px', opacity: 0.7, marginLeft: '4px' }}>${m.costPerSec}/s</span>
                    {m.recommended && <span style={{ fontSize: '8px', color: '#22c55e', marginLeft: '4px' }}>REC</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Duration */}
            <div>
              <label style={{ color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>
                Duracion por clip
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
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

            {/* Cost estimate */}
            <div style={{ fontSize: '12px', color: '#6b7280', paddingBottom: '4px' }}>
              Costo: ~${(storyboard.length * duration * (videoModels[selectedVideoModel]?.costPerSec || 0.224)).toFixed(2)} ({storyboard.length} clips x {duration}s x ${videoModels[selectedVideoModel]?.costPerSec || 0.224}/s)
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
                score={item.score}
                beatType={item.beatType}
                onPromptChange={(p) => updateStoryboardPrompt(i, p)}
                onMotionChange={(m) => updateStoryboardMotion(i, m)}
                motions={motions}
              />
            ))}
          </div>

          <button onClick={handleGenerateClips} disabled={generatingClips}
            style={{
              width: '100%', padding: '14px',
              backgroundColor: generatingClips ? '#374151' : '#7c3aed',
              border: 'none', borderRadius: '10px', color: '#fff', fontSize: '14px', fontWeight: '700',
              cursor: generatingClips ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
            }}>
            {generatingClips
              ? <><Loader size={18} className="spin" /> Enviando {storyboard.length} segmentos a {videoModels[selectedVideoModel]?.label || 'Grok Imagine'}...</>
              : <><Play size={18} /> Generar {storyboard.length} Segmentos del Comercial ({videoModels[selectedVideoModel]?.label || 'Grok Imagine'})</>
            }
          </button>
        </div>
      )}

      {/* ═══ STEP 5: CLIP RESULTS ═══ */}
      {clips.length > 0 && (
        <div style={{
          backgroundColor: '#111318', border: '1px solid #1f2937', borderRadius: '14px',
          padding: '24px', marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Film size={18} color="#22c55e" />
              Paso 5 — Segmentos del Comercial ({completedClips.length}/{clips.length})
            </h2>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
              {completedClips.length >= 2 && pendingClips.length === 0 && (
                <button onClick={handleStitchClips} disabled={isStitching}
                  style={{
                    padding: '8px 18px',
                    backgroundColor: isStitching ? '#374151' : '#22c55e',
                    border: 'none', borderRadius: '8px', color: '#fff', fontSize: '13px', fontWeight: '700',
                    cursor: isStitching ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}>
                  {isStitching
                    ? <><Loader size={14} className="spin" /> Ensamblando...</>
                    : <><Play size={14} /> Crear Video Comercial ({completedClips.length} clips)</>
                  }
                </button>
              )}
            </div>
          </div>

          {completedClips.length > 0 && pendingClips.length === 0 && (
            <div style={{
              backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '10px',
              padding: '10px 14px', marginBottom: '14px', fontSize: '12px', color: '#9ca3af',
              display: 'flex', alignItems: 'center', gap: '8px'
            }}>
              <Film size={14} color="#22c55e" />
              Estos {completedClips.length} segmentos se ensamblan en UN solo video comercial de ~{completedClips.length * duration}s con crossfades
            </div>
          )}

          {/* ── Production Controls: Music + Closing Text ── */}
          {completedClips.length >= 2 && pendingClips.length === 0 && !isStitching && stitchStatus?.status !== 'done' && (
            <div style={{
              backgroundColor: '#0d0f14', border: '1px solid #2a2d3a', borderRadius: '12px',
              padding: '16px', marginBottom: '14px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end'
            }}>
              {/* Music selector */}
              <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
                <label style={{
                  color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase',
                  letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px'
                }}>
                  <Music size={13} color="#8b5cf6" /> Musica de Fondo
                </label>
                <select
                  value={selectedMusic}
                  onChange={(e) => setSelectedMusic(e.target.value)}
                  style={{
                    width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
                    borderRadius: '8px', padding: '8px 10px', color: '#c4b5fd', fontSize: '12px',
                    cursor: 'pointer', boxSizing: 'border-box'
                  }}
                >
                  {musicTracks.map(t => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
                {selectedMusic !== 'none' && (
                  <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>
                    {musicTracks.find(t => t.key === selectedMusic)?.mood || ''}
                  </div>
                )}
              </div>

              {/* Closing text input */}
              <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
                <label style={{
                  color: '#9ca3af', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase',
                  letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px'
                }}>
                  <Type size={13} color="#22c55e" /> Texto de Cierre
                </label>
                <input
                  type="text"
                  value={brandText}
                  onChange={(e) => setBrandText(e.target.value)}
                  placeholder="ej: Jersey Pickles"
                  style={{
                    width: '100%', backgroundColor: '#141720', border: '1px solid #2a2d3a',
                    borderRadius: '8px', padding: '8px 10px', color: '#e5e7eb', fontSize: '12px',
                    boxSizing: 'border-box'
                  }}
                />
                <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>
                  Aparece sobre el ultimo segmento del comercial
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '14px' }}>
            {clips.map((clip, i) => (
              <ClipCard key={clip.requestId || i} clip={clip} onRefresh={refreshSingleClip} />
            ))}
          </div>
        </div>
      )}

      {/* ═══ STEP 6: FINAL COMMERCIAL VIDEO ═══ */}
      {(stitchStatus?.status === 'running' || stitchStatus?.status === 'done') && (
        <div style={{
          backgroundColor: '#111318', border: stitchStatus.status === 'done' ? '2px solid #22c55e' : '1px solid #1f2937',
          borderRadius: '14px', padding: '24px'
        }}>
          <h2 style={{ color: '#fff', fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Video size={18} color="#22c55e" />
            Paso 6 — Video Comercial Final
          </h2>

          {stitchStatus.status === 'running' && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <Loader size={32} color="#22c55e" className="spin" style={{ margin: '0 auto 12px', display: 'block' }} />
              <p style={{ color: '#9ca3af', fontSize: '14px', marginBottom: '6px' }}>
                Ensamblando video comercial con crossfades...
              </p>
              <p style={{ color: '#6b7280', fontSize: '12px' }}>
                Descargando {stitchStatus.downloaded || 0}/{stitchStatus.totalClips || '?'} clips
                {stitchStatus.musicTrack && stitchStatus.musicTrack !== 'none' ? ' + mezclando musica' : ''}
                {stitchStatus.brandText ? ' + texto de cierre' : ''}
              </p>
            </div>
          )}

          {stitchStatus.status === 'done' && stitchStatus.outputUrl && (
            <div>
              <video
                src={`${BASE_URL}${stitchStatus.outputUrl}`}
                controls
                style={{
                  width: '100%', maxWidth: '540px', borderRadius: '12px',
                  border: '2px solid #22c55e', margin: '0 auto', display: 'block'
                }}
              />
              <div style={{ textAlign: 'center', marginTop: '12px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <a href={`${BASE_URL}${stitchStatus.outputUrl}`} download
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    backgroundColor: '#22c55e', color: '#fff', padding: '10px 20px',
                    borderRadius: '8px', textDecoration: 'none', fontWeight: '600', fontSize: '13px'
                  }}>
                  <Download size={16} /> Descargar Video Comercial
                </a>
                <button onClick={handleStitchClips}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    backgroundColor: '#1e293b', color: '#93c5fd', padding: '10px 16px',
                    borderRadius: '8px', border: '1px solid #334155', fontWeight: '500', fontSize: '13px',
                    cursor: 'pointer'
                  }}>
                  <RefreshCw size={14} /> Re-ensamblar
                </button>
              </div>
              {/* Production details */}
              <div style={{
                marginTop: '16px', backgroundColor: '#0d0f14', border: '1px solid #2a2d3a',
                borderRadius: '10px', padding: '12px 16px', textAlign: 'center',
                display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center'
              }}>
                {directorPlan && (
                  <span style={{ color: '#c4b5fd', fontSize: '12px', fontWeight: '600' }}>
                    {directorPlan.brand} {directorPlan.productName} — {sceneInfo?.label}
                  </span>
                )}
                <span style={{ color: '#6b7280', fontSize: '11px' }}>
                  {completedClips.length} clips con crossfades
                </span>
                {selectedMusic !== 'none' && (
                  <span style={{ color: '#8b5cf6', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Music size={11} /> {musicTracks.find(t => t.key === selectedMusic)?.label || selectedMusic}
                  </span>
                )}
                {brandText && (
                  <span style={{ color: '#22c55e', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Type size={11} /> "{brandText}"
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        .score-tooltip { pointer-events: none; }
        *:hover > .score-tooltip { opacity: 1 !important; }
      `}</style>
    </div>
  );
}
