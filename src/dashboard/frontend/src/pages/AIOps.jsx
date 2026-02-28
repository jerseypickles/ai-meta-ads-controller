import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, Brain, Bot, Clock, AlertTriangle, CheckCircle, XCircle,
  TrendingUp, TrendingDown, DollarSign, Eye, Zap, RefreshCw,
  ChevronDown, ChevronRight, Image, Pause, Play, Target, Skull,
  ArrowDown, Shield, Timer, Power, Filter, Palette, BarChart3, Plus, Send, X, Trash2
} from 'lucide-react';
import { getAIOpsStatus, runAIManager, runAgents, refreshAIOpsMetrics, pauseEntity, deleteEntity, getAvailableCreatives, addAdToAdSet, generateAdCopy, getCreativePreviewUrl } from '../api';

// ═══ HELPERS ═══
const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '0';
const fmtCurrency = (v) => `$${fmt(v, 2)}`;
const timeAgo = (minutes) => {
  if (minutes == null) return 'Never';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
};

const URGENCY_COLORS = {
  critical: { bg: '#7f1d1d', border: '#dc2626', text: '#fca5a5' },
  high: { bg: '#78350f', border: '#f59e0b', text: '#fde68a' },
  medium: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
  low: { bg: '#14532d', border: '#22c55e', text: '#86efac' }
};

const CATEGORY_LABELS = {
  low_roas: 'ROAS Bajo', high_cpa: 'CPA Alto', creative_fatigue: 'Fatiga Creativa',
  no_conversions: 'Sin Conversiones', budget_waste: 'Desperdicio', strong_performer: 'Buen Rendimiento',
  recovery_signal: 'Recuperacion', learning_phase: 'Learning', audience_saturation: 'Saturacion', other: 'Otro'
};

const PHASE_COLORS = {
  learning: '#3b82f6', evaluating: '#f59e0b', scaling: '#10b981',
  stable: '#22c55e', killing: '#ef4444', dead: '#6b7280', activating: '#8b5cf6'
};

const STATUS_CONFIG = {
  ACTIVE: { label: 'ACTIVE', color: '#22c55e', bg: '#14532d', icon: Play },
  PAUSED: { label: 'PAUSED', color: '#ef4444', bg: '#7f1d1d', icon: Pause },
  DELETED: { label: 'DELETED', color: '#6b7280', bg: '#374151', icon: XCircle },
  ARCHIVED: { label: 'ARCHIVED', color: '#6b7280', bg: '#374151', icon: XCircle }
};

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'paused', label: 'Paused' },
  { value: 'dead', label: 'Dead' }
];

// ═══ ROAS COLOR ═══
const roasColor = (roas) => {
  const v = roas || 0;
  if (v >= 3) return '#22c55e';
  if (v >= 1.5) return '#f59e0b';
  return '#ef4444';
};

// ═══ STAT BADGE ═══
const StatBadge = ({ icon: Icon, iconColor, label, value, subValue, subColor, accentColor }) => (
  <div style={{
    background: 'linear-gradient(135deg, #141720 0%, #1a1d2a 100%)',
    border: '1px solid #2a2d3a',
    borderLeft: `3px solid ${accentColor || iconColor}`,
    borderRadius: '10px',
    padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '150px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <Icon size={13} color={iconColor} />
      <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
    </div>
    <div style={{ fontSize: '20px', fontWeight: '800', color: '#f1f5f9', letterSpacing: '-0.02em' }}>{value}</div>
    {subValue && <div style={{ fontSize: '11px', color: subColor || '#6b7280' }}>{subValue}</div>}
  </div>
);

// ═══ AD ROW (creative inside an ad set — with pause + delete buttons) ═══
const AdRow = ({ ad, onPause, onDelete }) => {
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const m = ad.metrics_7d || {};

  const handlePause = async (e) => {
    e.stopPropagation();
    if (pausing || deleting || removed) return;
    if (!confirm(`Pausar "${ad.ad_name || ad.ad_id}"?`)) return;
    setPausing(true);
    try {
      await pauseEntity(ad.ad_id, { entity_type: 'ad', entity_name: ad.ad_name || ad.ad_id, reason: 'Pausado manualmente desde AI Ops' });
      setRemoved(true);
      if (onPause) onPause(ad.ad_id);
    } catch (err) {
      alert('Error pausando: ' + (err.message || 'Unknown'));
    } finally {
      setPausing(false);
    }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (pausing || deleting || removed) return;
    if (!confirm(`ELIMINAR "${ad.ad_name || ad.ad_id}"? Esta accion no se puede deshacer.`)) return;
    setDeleting(true);
    try {
      await deleteEntity(ad.ad_id, { entity_type: 'ad', entity_name: ad.ad_name || ad.ad_id, reason: 'Eliminado manualmente desde AI Ops' });
      setRemoved(true);
      if (onDelete) onDelete(ad.ad_id);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Unknown';
      alert('Error eliminando: ' + msg);
    } finally {
      setDeleting(false);
    }
  };

  if (removed) return null;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '20px 1fr 70px 70px 55px 50px 55px 60px',
      gap: '6px', alignItems: 'center', padding: '7px 12px',
      backgroundColor: '#0f1119',
      borderRadius: '6px', borderLeft: '2px solid #22c55e44'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Play size={10} color="#22c55e" fill="#22c55e" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
        <span style={{ fontSize: '12px', color: '#e5e7eb', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ad.ad_name || ad.ad_id}
        </span>
        {ad.creative && (
          <span style={{ fontSize: '10px', color: '#4b5563', display: 'flex', alignItems: 'center', gap: '3px' }}>
            <Image size={9} /> {ad.creative.style || 'N/A'} — {ad.creative.headline?.substring(0, 35) || ''}
          </span>
        )}
      </div>
      <span style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>{fmtCurrency(m.spend)}</span>
      <span style={{
        fontSize: '12px', fontWeight: '700', textAlign: 'right',
        color: roasColor(m.roas)
      }}>{fmt(m.roas)}x</span>
      <span style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>{m.purchases || 0}</span>
      <span style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>{fmt(m.ctr, 1)}%</span>
      <span style={{
        fontSize: '11px', textAlign: 'right',
        color: (m.frequency || 0) > 4 ? '#ef4444' : (m.frequency || 0) > 3 ? '#f59e0b' : '#6b7280'
      }}>{fmt(m.frequency, 1)}</span>
      <div style={{ display: 'flex', gap: '3px', justifyContent: 'flex-end' }}>
        <button
          onClick={handlePause}
          disabled={pausing || deleting}
          title="Pausar"
          style={{
            width: '26px', height: '26px', borderRadius: '5px',
            border: '1px solid #f59e0b44', backgroundColor: pausing ? '#78350f' : '#1a1408',
            color: '#f59e0b', cursor: pausing ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s ease', padding: 0
          }}
        >
          {pausing ? <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} /> : <Pause size={10} />}
        </button>
        <button
          onClick={handleDelete}
          disabled={pausing || deleting}
          title="Eliminar"
          style={{
            width: '26px', height: '26px', borderRadius: '5px',
            border: '1px solid #ef444444', backgroundColor: deleting ? '#7f1d1d' : '#1a0a0a',
            color: '#ef4444', cursor: deleting ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s ease', padding: 0
          }}
        >
          {deleting ? <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={10} />}
        </button>
      </div>
    </div>
  );
};

// ═══ CREATIVE HEALTH CARD (structured visual) ═══
const CreativeHealthCard = ({ adset }) => {
  const health = adset.creative_health;
  const needsNew = adset.needs_new_creatives;
  const rotationNeeded = adset.creative_rotation_needed;
  const styles = adset.suggested_styles || [];
  const freqDetail = adset.frequency_detail;
  const freqStatus = adset.frequency_status;

  // Nothing to show
  if (!health && !needsNew && !rotationNeeded && !freqDetail) return null;

  const freqColor = freqStatus === 'critical' ? '#ef4444' : freqStatus === 'high' ? '#f59e0b' : freqStatus === 'moderate' ? '#3b82f6' : '#22c55e';
  const freqBg = freqStatus === 'critical' ? '#7f1d1d' : freqStatus === 'high' ? '#78350f' : freqStatus === 'moderate' ? '#1e3a5f' : '#14532d';

  return (
    <div style={{
      backgroundColor: '#13101f', border: '1px solid #7c3aed22',
      borderRadius: '8px', marginBottom: '10px', overflow: 'hidden'
    }}>
      {/* Header bar */}
      <div style={{
        padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px',
        borderBottom: '1px solid #7c3aed15',
        background: 'linear-gradient(90deg, #1a0d2e 0%, #13101f 100%)'
      }}>
        <Palette size={13} color="#a78bfa" />
        <span style={{ fontSize: '10px', fontWeight: '700', color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Creative Health
        </span>

        {/* Status pills */}
        {freqStatus && freqStatus !== 'unknown' && (
          <span style={{
            fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
            backgroundColor: freqBg, color: freqColor, marginLeft: '4px'
          }}>
            FREQ: {freqStatus.toUpperCase()}
          </span>
        )}
        {needsNew && (
          <span style={{
            fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
            backgroundColor: '#7f1d1d', color: '#fca5a5'
          }}>
            NEEDS NEW CREATIVES
          </span>
        )}
        {rotationNeeded && !needsNew && (
          <span style={{
            fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
            backgroundColor: '#78350f', color: '#fde68a'
          }}>
            ROTATION NEEDED
          </span>
        )}
      </div>

      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Frequency detail */}
        {freqDetail && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <div style={{
              width: '20px', height: '20px', borderRadius: '4px',
              backgroundColor: freqBg + '88', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}>
              <Eye size={10} color={freqColor} />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '2px' }}>Frequency</div>
              <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.4' }}>{freqDetail}</div>
            </div>
          </div>
        )}

        {/* Creative health analysis */}
        {health && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <div style={{
              width: '20px', height: '20px', borderRadius: '4px',
              backgroundColor: '#1a0d2e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}>
              <Palette size={10} color="#a78bfa" />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '2px' }}>Analysis</div>
              <div style={{ fontSize: '11px', color: '#c4b5fd', lineHeight: '1.4' }}>{health}</div>
            </div>
          </div>
        )}

        {/* Suggested styles */}
        {styles.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <div style={{
              width: '20px', height: '20px', borderRadius: '4px',
              backgroundColor: '#14532d88', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}>
              <Zap size={10} color="#22c55e" />
            </div>
            <div>
              <div style={{ fontSize: '9px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '3px' }}>Crear estos estilos</div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {styles.map((s, i) => (
                  <span key={i} style={{
                    fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '4px',
                    backgroundColor: '#14532d', color: '#86efac', border: '1px solid #22c55e44'
                  }}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ═══ ADD CREATIVE PANEL (2-step: select asset → generate copy → review → create) ═══
const AddCreativePanel = ({ adsetId, onClose, onSuccess }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  // Step 2: generated copy preview
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [generatedCopy, setGeneratedCopy] = useState(null); // { headlines: [], bodies: [] }
  const [selectedVariant, setSelectedVariant] = useState(0);

  // Step 3: creating ad
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getAvailableCreatives(adsetId);
        setAssets(data.assets || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [adsetId]);

  const selectedAsset = assets.find(a => a._id === selected);

  // Step 1→2: Generate copy with Claude
  const handleGenerateCopy = async () => {
    if (!selected) return;
    setGeneratingCopy(true);
    setError(null);
    setGeneratedCopy(null);
    try {
      const res = await generateAdCopy(adsetId, selected);
      setGeneratedCopy({ headlines: res.headlines, bodies: res.bodies });
      setSelectedVariant(0);
    } catch (err) {
      setError(err.message || 'Error generating copy');
    } finally {
      setGeneratingCopy(false);
    }
  };

  // Step 2→3: Create ad with chosen variant
  const handleCreate = async () => {
    if (!selected || !generatedCopy) return;
    setCreating(true);
    setError(null);
    try {
      const headline = generatedCopy.headlines[selectedVariant] || generatedCopy.headlines[0];
      const body = generatedCopy.bodies[selectedVariant] || generatedCopy.bodies[0];
      const res = await addAdToAdSet(adsetId, selected, headline, body);
      setResult(res.result || res);
      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err.message || 'Error creating ad');
    } finally {
      setCreating(false);
    }
  };

  // Go back to asset selection
  const handleBack = () => {
    setGeneratedCopy(null);
    setSelectedVariant(0);
    setError(null);
  };

  const availableAssets = assets.filter(a => !a.already_in_adset);

  return (
    <div style={{
      backgroundColor: '#0d0f17', border: '1px solid #22c55e33',
      borderRadius: '8px', padding: '14px', marginBottom: '10px'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Plus size={13} color="#22c55e" />
          <span style={{ fontSize: '11px', fontWeight: '700', color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {!generatedCopy ? 'Select Creative' : 'Review Copy'}
          </span>
          {generatedCopy && (
            <button onClick={handleBack} style={{
              fontSize: '10px', color: '#6b7280', background: 'none', border: '1px solid #1f2937',
              borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', marginLeft: '6px'
            }}>Back</button>
          )}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', padding: '2px'
        }}><X size={14} /></button>
      </div>

      {loading && <div style={{ fontSize: '11px', color: '#4b5563', padding: '8px 0' }}>Loading assets...</div>}
      {error && <div style={{ fontSize: '11px', color: '#fca5a5', padding: '6px 8px', backgroundColor: '#7f1d1d44', borderRadius: '4px', marginBottom: '8px' }}>{error}</div>}

      {/* ═══ RESULT ═══ */}
      {result && (
        <div style={{ fontSize: '11px', color: '#86efac', padding: '10px 12px', backgroundColor: '#14532d44', borderRadius: '6px' }}>
          <CheckCircle size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
          {result.ads_created} ad(s) created!
          {result.headlines && <div style={{ marginTop: '4px', color: '#6b7280' }}>Headlines: {result.headlines.join(' | ')}</div>}
        </div>
      )}

      {/* ═══ STEP 1: Asset selection with image preview ═══ */}
      {!result && !loading && !generatedCopy && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: '8px', maxHeight: '320px', overflowY: 'auto', marginBottom: '10px'
          }}>
            {availableAssets.map(asset => (
              <div
                key={asset._id}
                onClick={() => setSelected(asset._id)}
                style={{
                  borderRadius: '8px', cursor: 'pointer', overflow: 'hidden',
                  backgroundColor: selected === asset._id ? '#14532d22' : '#111827',
                  border: `2px solid ${selected === asset._id ? '#22c55e' : '#1f2937'}`,
                  transition: 'all 0.15s ease'
                }}
              >
                {/* Image preview */}
                <div style={{
                  width: '100%', height: '120px', backgroundColor: '#0a0b0f',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
                }}>
                  <img
                    src={getCreativePreviewUrl(asset.filename)}
                    alt={asset.original_name}
                    style={{
                      width: '100%', height: '100%', objectFit: 'cover'
                    }}
                    onError={(e) => { e.target.style.display = 'none'; e.target.parentNode.innerHTML = '<div style="color: #374151; font-size: 10px;">No preview</div>'; }}
                  />
                </div>
                {/* Info */}
                <div style={{ padding: '6px 8px' }}>
                  <div style={{
                    fontSize: '10px', color: '#d1d5db', fontWeight: '500',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '4px'
                  }}>
                    {asset.original_name}
                  </div>
                  <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                    {asset.style && (
                      <span style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#1f2937', color: '#9ca3af' }}>
                        {asset.style}
                      </span>
                    )}
                    {asset.product_name && (
                      <span style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#1f2937', color: '#9ca3af' }}>
                        {asset.product_name}
                      </span>
                    )}
                    <span style={{
                      fontSize: '8px', padding: '1px 4px', borderRadius: '3px',
                      backgroundColor: asset.times_used === 0 ? '#14532d' : '#78350f',
                      color: asset.times_used === 0 ? '#86efac' : '#fde68a'
                    }}>
                      {asset.times_used === 0 ? 'NEW' : `${asset.times_used}x`}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {availableAssets.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: '#374151', gridColumn: '1 / -1' }}>
                No available assets
              </div>
            )}
          </div>

          {/* Generate Copy button */}
          {selected && (
            <button
              onClick={handleGenerateCopy}
              disabled={generatingCopy}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: '7px',
                border: '1px solid #8b5cf633',
                background: generatingCopy ? '#2e1065' : 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 100%)',
                color: '#e9d5ff', fontSize: '12px', fontWeight: '700', cursor: generatingCopy ? 'wait' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                opacity: generatingCopy ? 0.7 : 1, transition: 'all 0.15s ease'
              }}
            >
              {generatingCopy ? (
                <><RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> Claude is writing copy...</>
              ) : (
                <><Brain size={13} /> Generate Copy with Claude</>
              )}
            </button>
          )}
        </>
      )}

      {/* ═══ STEP 2: Copy preview + variant selection ═══ */}
      {!result && generatedCopy && (
        <>
          {/* Selected asset preview bar */}
          {selectedAsset && (
            <div style={{
              display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 10px',
              backgroundColor: '#111827', borderRadius: '6px', marginBottom: '12px'
            }}>
              <img
                src={getCreativePreviewUrl(selectedAsset.filename)}
                alt={selectedAsset.original_name}
                style={{ width: '50px', height: '50px', objectFit: 'cover', borderRadius: '4px' }}
                onError={(e) => { e.target.style.display = 'none'; }}
              />
              <div>
                <div style={{ fontSize: '11px', color: '#d1d5db', fontWeight: '600' }}>{selectedAsset.original_name}</div>
                <div style={{ fontSize: '10px', color: '#6b7280' }}>{selectedAsset.style} {selectedAsset.product_name ? `- ${selectedAsset.product_name}` : ''}</div>
              </div>
            </div>
          )}

          {/* Variant cards */}
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.06em' }}>
            Select a variant ({generatedCopy.headlines.length} generated)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            {generatedCopy.headlines.map((headline, i) => (
              <div
                key={i}
                onClick={() => setSelectedVariant(i)}
                style={{
                  padding: '10px 12px', borderRadius: '7px', cursor: 'pointer',
                  backgroundColor: selectedVariant === i ? '#14532d22' : '#0f1119',
                  border: `2px solid ${selectedVariant === i ? '#22c55e' : '#1f293766'}`,
                  transition: 'all 0.12s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '50%',
                    border: `2px solid ${selectedVariant === i ? '#22c55e' : '#374151'}`,
                    backgroundColor: selectedVariant === i ? '#22c55e' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                  }}>
                    {selectedVariant === i && <CheckCircle size={10} color="#0d0f17" />}
                  </div>
                  <span style={{ fontSize: '9px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase' }}>
                    Variant {i + 1}
                  </span>
                </div>
                <div style={{ paddingLeft: '24px' }}>
                  <div style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', marginBottom: '2px', fontWeight: '600' }}>Headline</div>
                  <div style={{ fontSize: '13px', color: '#f1f5f9', fontWeight: '700', marginBottom: '6px' }}>{headline}</div>
                  <div style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', marginBottom: '2px', fontWeight: '600' }}>Primary Text</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5' }}>{generatedCopy.bodies[i] || ''}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Create Ad button */}
          <button
            onClick={handleCreate}
            disabled={creating}
            style={{
              width: '100%', padding: '10px 14px', borderRadius: '7px',
              border: '1px solid #22c55e44',
              background: creating ? '#064e3b' : 'linear-gradient(135deg, #14532d 0%, #166534 100%)',
              color: '#86efac', fontSize: '12px', fontWeight: '700', cursor: creating ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              opacity: creating ? 0.7 : 1, transition: 'all 0.15s ease'
            }}
          >
            {creating ? (
              <><RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> Creating ad in Meta...</>
            ) : (
              <><Send size={13} /> Create Ad with Variant {selectedVariant + 1}</>
            )}
          </button>
        </>
      )}
    </div>
  );
};

// ═══ AD SET CARD ═══
const AdSetCard = ({ adset, onRefresh }) => {
  const [expanded, setExpanded] = useState(false);
  const [showAddCreative, setShowAddCreative] = useState(false);
  const m7 = adset.metrics_7d || {};
  const phase = adset.phase || 'unknown';
  const phaseColor = PHASE_COLORS[phase] || '#6b7280';
  const activeAds = (adset.ads || []).filter(a => a.status === 'ACTIVE');
  const totalAds = (adset.ads || []).length;
  const hasDirectives = (adset.directives || []).length > 0;
  const criticalDirectives = (adset.directives || []).filter(d => d.urgency === 'critical');

  const isActive = adset.status === 'ACTIVE';
  const isDead = phase === 'dead' || phase === 'killing';
  const isPaused = !isActive;
  const statusCfg = STATUS_CONFIG[adset.status] || STATUS_CONFIG.PAUSED;
  const isStale = adset.snapshot_age_min != null && adset.snapshot_age_min > 120;

  const roas7d = m7.roas || 0;

  return (
    <div style={{
      background: isDead ? '#0a0b0f' : 'linear-gradient(135deg, #12141e 0%, #161925 100%)',
      border: `1px solid ${isDead ? '#1f2937' : isPaused ? '#ef444433' : criticalDirectives.length > 0 ? '#dc262688' : '#252836'}`,
      borderRadius: '10px', overflow: 'hidden',
      opacity: isDead ? 0.45 : isPaused ? 0.75 : 1,
      transition: 'all 0.15s ease'
    }}>
      {/* PAUSED / DEAD Banner */}
      {isPaused && (
        <div style={{
          padding: '5px 16px', display: 'flex', alignItems: 'center', gap: '6px',
          background: isDead ? 'linear-gradient(90deg, #1f2937 0%, #111827 100%)' : 'linear-gradient(90deg, #7f1d1d 0%, #5b1a1a 100%)',
          borderBottom: `1px solid ${isDead ? '#374151' : '#dc262633'}`
        }}>
          <Power size={11} color={isDead ? '#6b7280' : '#fca5a5'} />
          <span style={{
            fontSize: '10px', fontWeight: '700', color: isDead ? '#6b7280' : '#fca5a5',
            textTransform: 'uppercase', letterSpacing: '0.08em'
          }}>
            {isDead ? 'DEAD' : statusCfg.label}
          </span>
        </div>
      )}

      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px',
          borderBottom: expanded ? '1px solid #1f2937' : 'none',
          ':hover': { backgroundColor: '#ffffff05' }
        }}
      >
        {expanded ? <ChevronDown size={14} color="#4b5563" /> : <ChevronRight size={14} color="#4b5563" />}

        {/* Phase dot + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <div style={{
            width: '7px', height: '7px', borderRadius: '50%',
            backgroundColor: phaseColor,
            boxShadow: `0 0 6px ${phaseColor}66`
          }} />
          <span style={{
            fontSize: '10px', fontWeight: '700', color: phaseColor,
            textTransform: 'uppercase', letterSpacing: '0.05em'
          }}>{phase}</span>
        </div>

        {/* Stale */}
        {isStale && (
          <span title={`Data is ${timeAgo(adset.snapshot_age_min)} old`} style={{
            fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '3px',
            backgroundColor: '#78350f', color: '#fde68a', border: '1px solid #f59e0b33'
          }}>
            STALE
          </span>
        )}

        {/* Name */}
        <span style={{
          fontSize: '13px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: isDead ? '#4b5563' : isPaused ? '#6b7280' : '#e5e7eb',
          textDecoration: isDead ? 'line-through' : 'none'
        }}>
          {adset.adset_name}
        </span>

        {/* Quick metrics row */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            ${fmt(m7.spend, 0)}
          </span>
          <span style={{
            fontSize: '13px', fontWeight: '800', letterSpacing: '-0.02em',
            color: roasColor(roas7d),
            padding: '1px 6px', borderRadius: '4px',
            backgroundColor: roasColor(roas7d) + '15'
          }}>{fmt(roas7d)}x</span>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>{m7.purchases || 0} purch</span>
          <span style={{ fontSize: '10px', color: '#4b5563' }}>
            {activeAds.length}/{totalAds} ads
          </span>
          {adset.frequency_status && adset.frequency_status !== 'unknown' && adset.frequency_status !== 'ok' && (
            <span style={{
              fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '3px',
              backgroundColor: adset.frequency_status === 'critical' ? '#7f1d1d' : '#78350f',
              color: adset.frequency_status === 'critical' ? '#fca5a5' : '#fde68a',
            }}>
              FREQ
            </span>
          )}
          {criticalDirectives.length > 0 && (
            <span style={{
              fontSize: '9px', fontWeight: '700', padding: '2px 5px', borderRadius: '3px',
              backgroundColor: '#7f1d1d', color: '#fca5a5'
            }}>
              {adset.directives.length} DIR
            </span>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: '0 16px 14px' }}>
          {/* Stale warning */}
          {isStale && (
            <div style={{
              padding: '6px 10px', backgroundColor: '#78350f15', border: '1px solid #f59e0b22',
              borderRadius: '6px', marginTop: '10px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px',
              fontSize: '11px', color: '#fde68a'
            }}>
              <AlertTriangle size={12} color="#f59e0b" />
              Datos desactualizados — {timeAgo(adset.snapshot_age_min)}
            </div>
          )}

          {/* Breathing indicator */}
          {(adset.recent_actions || []).length > 0 && (() => {
            const lastAction = adset.recent_actions[0];
            const hoursAgo = lastAction.hours_ago || 0;
            const isBreathing = hoursAgo < 12;
            return isBreathing ? (
              <div style={{
                padding: '6px 10px', backgroundColor: '#1e3a5f15', border: '1px solid #3b82f622',
                borderRadius: '6px', marginTop: '10px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '11px', color: '#93c5fd'
              }}>
                <Timer size={12} color="#3b82f6" />
                Respirando — {hoursAgo}h desde {lastAction.action}. Proximo analisis ~{Math.max(1, 12 - hoursAgo)}h
              </div>
            ) : null;
          })()}

          {/* Metrics grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
            gap: '8px', padding: '12px 0', marginBottom: '10px',
            borderBottom: '1px solid #1f2937'
          }}>
            {[
              { label: 'Budget', value: `${fmtCurrency(adset.budget)}/d` },
              { label: 'Days', value: fmt(adset.days_active, 1) },
              { label: 'CPA', value: fmtCurrency(m7.cpa) },
              { label: 'Freq', value: fmt(m7.frequency, 1), color: (m7.frequency || 0) > 4 ? '#ef4444' : (m7.frequency || 0) > 3 ? '#f59e0b' : null },
              { label: 'CTR', value: `${fmt(m7.ctr, 2)}%` },
              { label: '3d ROAS', value: `${fmt(adset.metrics_3d?.roas)}x` },
              { label: 'Today', value: `${fmtCurrency(adset.metrics_today?.spend)} / ${fmt(adset.metrics_today?.roas)}x` },
              { label: 'Status', value: adset.status || 'UNKNOWN', color: isActive ? '#22c55e' : '#ef4444' }
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <span style={{ fontSize: '9px', color: '#4b5563', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{item.label}</span>
                <span style={{ fontSize: '12px', color: item.color || '#d1d5db', fontWeight: '600' }}>{item.value}</span>
              </div>
            ))}
            {adset.last_manager_check && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <span style={{ fontSize: '9px', color: '#4b5563', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last check</span>
                <span style={{ fontSize: '12px', color: '#d1d5db', fontWeight: '600' }}>{timeAgo(Math.round((Date.now() - new Date(adset.last_manager_check)) / 60000))}</span>
              </div>
            )}
          </div>

          {/* Assessment */}
          {adset.last_assessment && (
            <div style={{
              padding: '8px 10px', backgroundColor: '#0d0f14', borderRadius: '6px',
              fontSize: '11px', color: '#6b7280', marginBottom: '10px', lineHeight: '1.5',
              borderLeft: '2px solid #3b82f644'
            }}>
              <b style={{ color: '#4b5563', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI Assessment</b>
              <div style={{ marginTop: '3px', color: '#9ca3af' }}>{adset.last_assessment.substring(0, 300)}</div>
            </div>
          )}

          {/* Creative Health — structured */}
          <CreativeHealthCard adset={adset} />

          {/* Active Ads */}
          <div style={{ marginBottom: '10px' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '20px 1fr 70px 70px 55px 50px 55px 60px',
              gap: '6px', padding: '3px 12px', fontSize: '9px', color: '#4b5563',
              fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em'
            }}>
              <span></span><span>Ad / Creative</span>
              <span style={{ textAlign: 'right' }}>Spend</span>
              <span style={{ textAlign: 'right' }}>ROAS</span>
              <span style={{ textAlign: 'right' }}>Purch</span>
              <span style={{ textAlign: 'right' }}>CTR</span>
              <span style={{ textAlign: 'right' }}>Freq</span>
              <span></span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {activeAds.map((ad, i) => <AdRow key={ad.ad_id || i} ad={ad} onPause={() => {}} />)}
            </div>
            {activeAds.length === 0 && (
              <div style={{ padding: '10px', textAlign: 'center', fontSize: '11px', color: '#374151' }}>
                No active ads
              </div>
            )}
            {totalAds > activeAds.length && (
              <div style={{ padding: '4px 12px', fontSize: '10px', color: '#374151', textAlign: 'right' }}>
                +{totalAds - activeAds.length} paused/off ads hidden
              </div>
            )}

            {/* Add Creative button */}
            {isActive && !showAddCreative && (
              <button
                onClick={() => setShowAddCreative(true)}
                style={{
                  width: '100%', padding: '6px', marginTop: '4px', borderRadius: '5px',
                  border: '1px dashed #22c55e44', backgroundColor: 'transparent',
                  color: '#22c55e88', fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                  transition: 'all 0.15s ease'
                }}
              >
                <Plus size={12} /> Add Creative
              </button>
            )}
          </div>

          {/* Add Creative Panel */}
          {showAddCreative && (
            <AddCreativePanel
              adsetId={adset.adset_id}
              onClose={() => setShowAddCreative(false)}
              onSuccess={() => { if (onRefresh) onRefresh(); }}
            />
          )}

          {/* Directives */}
          {hasDirectives && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '5px', letterSpacing: '0.06em' }}>
                Brain Directives ({adset.directives.length})
              </div>
              {adset.directives.map((d, i) => {
                const urg = URGENCY_COLORS[d.urgency] || URGENCY_COLORS.medium;
                return (
                  <div key={i} style={{
                    padding: '6px 10px', backgroundColor: urg.bg + '33', border: `1px solid ${urg.border}22`,
                    borderRadius: '6px', marginBottom: '3px', display: 'flex', gap: '6px', alignItems: 'flex-start'
                  }}>
                    <span style={{
                      fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '3px',
                      backgroundColor: urg.bg, color: urg.text, border: `1px solid ${urg.border}`,
                      flexShrink: 0, textTransform: 'uppercase'
                    }}>{d.urgency}</span>
                    <span style={{
                      fontSize: '9px', padding: '1px 5px', borderRadius: '3px',
                      backgroundColor: '#1f2937', color: '#6b7280', flexShrink: 0
                    }}>{CATEGORY_LABELS[d.category] || d.category}</span>
                    <span style={{ fontSize: '11px', color: '#9ca3af', flex: 1, lineHeight: '1.4' }}>
                      {d.type}/{d.target_action} — {d.reason?.replace('[BRAIN→AI-MANAGER] ', '').substring(0, 150)}
                    </span>
                    <span style={{ fontSize: '10px', color: '#374151', flexShrink: 0 }}>{d.hours_ago}h</span>
                    {d.consecutive_count > 1 && (
                      <span style={{
                        fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '3px',
                        backgroundColor: '#78350f', color: '#fde68a', flexShrink: 0
                      }}>x{d.consecutive_count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent actions */}
          {(adset.recent_actions || []).length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: '700', color: '#4b5563', textTransform: 'uppercase', marginBottom: '5px', letterSpacing: '0.06em' }}>
                Recent Actions ({adset.recent_actions.length})
              </div>
              {adset.recent_actions.slice(0, 5).map((a, i) => (
                <div key={i} style={{
                  padding: '5px 10px', backgroundColor: '#0f1119', borderRadius: '5px', marginBottom: '2px',
                  display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px'
                }}>
                  <span style={{ color: a.success ? '#22c55e' : '#ef4444', flexShrink: 0 }}>
                    {a.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
                  </span>
                  <span style={{ color: '#d1d5db', fontWeight: '600' }}>{a.action}</span>
                  {a.change_pct != null && (
                    <span style={{ color: a.change_pct > 0 ? '#22c55e' : '#ef4444', fontSize: '10px' }}>
                      {a.change_pct > 0 ? '+' : ''}{a.change_pct}%
                    </span>
                  )}
                  <span style={{ color: '#4b5563', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.reasoning?.replace(/\[.*?\]\s*/g, '').substring(0, 100)}
                  </span>
                  <span style={{ color: '#374151', flexShrink: 0 }}>{a.hours_ago}h</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ═══ TIMELINE EVENT ═══
const TimelineEvent = ({ event }) => {
  const typeConfig = {
    ai_manager_action: { icon: Bot, color: '#ec4899', label: 'AI Manager' },
    decision_tree: { icon: Skull, color: '#ef4444', label: 'Decision Tree' },
    brain_directive: { icon: Brain, color: '#3b82f6', label: 'Brain' },
    safety_event: { icon: Shield, color: '#f59e0b', label: 'Safety' }
  };
  const cfg = typeConfig[event.type] || typeConfig.ai_manager_action;
  const Icon = cfg.icon;
  const ts = new Date(event.timestamp);
  const minsAgo = Math.round((Date.now() - ts) / 60000);

  return (
    <div style={{
      display: 'flex', gap: '10px', padding: '7px 0',
      borderBottom: '1px solid #1f293722'
    }}>
      <div style={{
        width: '26px', height: '26px', borderRadius: '6px',
        backgroundColor: cfg.color + '15', border: `1px solid ${cfg.color}33`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
      }}>
        <Icon size={12} color={cfg.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '2px' }}>
          <span style={{ fontSize: '9px', fontWeight: '700', color: cfg.color, textTransform: 'uppercase' }}>{cfg.label}</span>
          <span style={{ fontSize: '12px', fontWeight: '600', color: '#d1d5db' }}>{event.entity_name}</span>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>{event.action}</span>
          {event.change && <span style={{ fontSize: '11px', color: String(event.change).startsWith('+') ? '#22c55e' : '#ef4444', fontWeight: '600' }}>{event.change}</span>}
          {event.urgency && event.urgency !== 'medium' && (
            <span style={{
              fontSize: '8px', fontWeight: '700', padding: '1px 4px', borderRadius: '3px',
              backgroundColor: (URGENCY_COLORS[event.urgency] || {}).bg || '#1e3a5f',
              color: (URGENCY_COLORS[event.urgency] || {}).text || '#93c5fd',
              textTransform: 'uppercase'
            }}>{event.urgency}</span>
          )}
        </div>
        <div style={{ fontSize: '10px', color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.detail?.replace(/\[.*?\]\s*/g, '').substring(0, 200)}
        </div>
      </div>
      <span style={{ fontSize: '10px', color: '#374151', flexShrink: 0, whiteSpace: 'nowrap' }}>
        {timeAgo(minsAgo)}
      </span>
    </div>
  );
};

// ═══ DECISION TREE EVENTS ═══
const DecisionTreeCard = ({ events }) => {
  if (!events || events.length === 0) return null;
  return (
    <div style={{
      background: 'linear-gradient(135deg, #1c0d0d 0%, #1a1015 100%)',
      border: '1px solid #dc262633', borderRadius: '10px',
      padding: '14px', marginBottom: '16px'
    }}>
      <div style={{
        fontSize: '12px', fontWeight: '700', color: '#ef4444', marginBottom: '10px',
        display: 'flex', alignItems: 'center', gap: '6px'
      }}>
        <Skull size={14} /> Decision Tree — Forced Actions (7d)
        <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '400' }}>
          {events.length} event{events.length > 1 ? 's' : ''}
        </span>
      </div>
      {events.map((e, i) => (
        <div key={i} style={{
          padding: '8px 10px', backgroundColor: '#12080844', border: '1px solid #dc262622',
          borderRadius: '6px', marginBottom: '4px'
        }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '3px' }}>
            <span style={{
              fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '3px',
              backgroundColor: e.action === 'pause' ? '#7f1d1d' : '#78350f',
              color: e.action === 'pause' ? '#fca5a5' : '#fde68a'
            }}>{e.action === 'pause' ? 'KILL' : 'SCALE DOWN'}</span>
            <span style={{ fontSize: '12px', fontWeight: '600', color: '#d1d5db' }}>{e.entity_name}</span>
            {e.change_pct != null && (
              <span style={{ fontSize: '11px', color: '#ef4444' }}>{e.change_pct}%</span>
            )}
            <span style={{ fontSize: '10px', color: '#374151', marginLeft: 'auto' }}>{e.hours_ago}h ago</span>
          </div>
          <div style={{ fontSize: '10px', color: '#6b7280', lineHeight: '1.4' }}>
            {e.reasoning?.replace(/\[.*?\]\s*/g, '')}
          </div>
        </div>
      ))}
    </div>
  );
};

// ═══ MAIN PAGE ═══
export default function AIOps() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active'); // Default: only active

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await getAIOpsStatus();
      if (result && result.ai_manager) {
        setData(result);
      } else if (result && result.error) {
        setError(result.error);
      } else {
        setData(result || {});
      }
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRunManager = async () => {
    setRunning('manager');
    try {
      await runAIManager();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const handleRunBrain = async () => {
    setRunning('brain');
    try {
      await runAgents();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const handleRefreshMetrics = async () => {
    setRunning('refresh');
    try {
      await refreshAIOpsMetrics();
      await fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const mgr = data?.ai_manager || {};
  const brain = data?.brain || {};
  const compliance = data?.compliance || {};
  const dirSummary = data?.directive_summary || {};
  const adSets = data?.adsets || [];
  const timeline = data?.timeline || [];
  const dtEvents = data?.decision_tree_events || [];

  const statusCounts = useMemo(() => {
    const counts = { active: 0, paused: 0, dead: 0, total: adSets.length };
    for (const as of adSets) {
      if (as.phase === 'dead' || as.phase === 'killing') counts.dead++;
      else if (as.status === 'ACTIVE') counts.active++;
      else counts.paused++;
    }
    return counts;
  }, [adSets]);

  const filteredAdSets = useMemo(() => {
    let filtered = adSets;
    if (statusFilter === 'active') {
      filtered = adSets.filter(as => as.status === 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    } else if (statusFilter === 'paused') {
      filtered = adSets.filter(as => as.status !== 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    } else if (statusFilter === 'dead') {
      filtered = adSets.filter(as => as.phase === 'dead' || as.phase === 'killing');
    }
    return [...filtered].sort((a, b) => {
      const order = (as) => {
        if (as.phase === 'dead' || as.phase === 'killing') return 2;
        if (as.status !== 'ACTIVE') return 1;
        return 0;
      };
      const oa = order(a), ob = order(b);
      if (oa !== ob) return oa - ob;
      // Secondary sort: highest spend first
      return ((b.metrics_7d || {}).spend || 0) - ((a.metrics_7d || {}).spend || 0);
    });
  }, [adSets, statusFilter]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#4b5563' }}>
        <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading AI Operations...</span>
      </div>
    );
  }

  if (!data && error) {
    return (
      <div style={{ maxWidth: '1400px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: '800', color: '#f1f5f9', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={20} color="#3b82f6" /> AI Operations
        </h1>
        <div style={{ padding: '16px', backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '10px', color: '#fca5a5', fontSize: '13px' }}>
          Error: {error}
          <button onClick={() => { setLoading(true); fetchData(); }} style={{
            marginLeft: '12px', padding: '5px 10px', borderRadius: '6px', border: '1px solid #dc2626',
            backgroundColor: '#991b1b', color: '#fca5a5', cursor: 'pointer', fontSize: '11px'
          }}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1400px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px',
        paddingBottom: '16px', borderBottom: '1px solid #1f2937'
      }}>
        <div>
          <h1 style={{
            fontSize: '20px', fontWeight: '800', color: '#f1f5f9', margin: 0,
            display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '-0.02em'
          }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '8px',
              background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <BarChart3 size={17} color="#fff" />
            </div>
            AI Operations
          </h1>
          <p style={{ fontSize: '12px', color: '#374151', margin: '4px 0 0', paddingLeft: '40px' }}>
            Brain + AI Manager — live monitoring
          </p>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[
            { key: 'manager', fn: handleRunManager, Icon: Bot, color: '#ec4899', label: 'Manager' },
            { key: 'brain', fn: handleRunBrain, Icon: Brain, color: '#3b82f6', label: 'Brain' },
            { key: 'refresh', fn: handleRefreshMetrics, Icon: Zap, color: '#10b981', label: 'Metrics' }
          ].map(({ key, fn, Icon, color, label }) => (
            <button
              key={key}
              onClick={fn}
              disabled={running != null}
              style={{
                padding: '6px 12px', borderRadius: '7px', border: `1px solid ${color}33`,
                backgroundColor: running === key ? color + '22' : '#12141d',
                color, fontSize: '11px', fontWeight: '600', cursor: running ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '5px',
                opacity: running && running !== key ? 0.4 : 1,
                transition: 'all 0.15s ease'
              }}
            >
              {running === key ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Icon size={12} />}
              {label}
            </button>
          ))}
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            style={{
              padding: '6px 8px', borderRadius: '7px', border: '1px solid #1f2937',
              backgroundColor: '#12141d', color: '#4b5563', cursor: 'pointer', display: 'flex', alignItems: 'center'
            }}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', backgroundColor: '#7f1d1d', border: '1px solid #dc2626', borderRadius: '8px', marginBottom: '14px', color: '#fca5a5', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {/* Stat badges */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '18px' }}>
        <StatBadge
          icon={Bot} iconColor="#ec4899" accentColor="#ec4899" label="AI Manager"
          value={mgr.minutes_since_last_run != null ? timeAgo(mgr.minutes_since_last_run) : 'Never'}
          subValue={`${mgr.actions_48h || 0} actions (48h)`}
          subColor="#6b7280"
        />
        <StatBadge
          icon={Brain} iconColor="#3b82f6" accentColor="#3b82f6" label="Brain"
          value={brain.minutes_ago != null ? timeAgo(brain.minutes_ago) : 'Never'}
          subValue={brain.status || 'N/A'}
          subColor={brain.status === 'critical' ? '#ef4444' : brain.status === 'warning' ? '#f59e0b' : '#22c55e'}
        />
        <StatBadge
          icon={Target} iconColor="#f59e0b" accentColor="#f59e0b" label="Compliance"
          value={`${compliance.rate || 0}%`}
          subValue={`${compliance.acted_on || 0} acted / ${compliance.ignored || 0} ignored`}
          subColor={compliance.rate < 50 ? '#ef4444' : compliance.rate < 80 ? '#f59e0b' : '#22c55e'}
        />
        <StatBadge
          icon={Zap} iconColor="#a78bfa" accentColor="#a78bfa" label="Directives"
          value={dirSummary.total_active || 0}
          subValue={`${dirSummary.by_urgency?.critical || 0} crit, ${dirSummary.by_urgency?.high || 0} high`}
          subColor={(dirSummary.by_urgency?.critical || 0) > 0 ? '#ef4444' : '#6b7280'}
        />
        <StatBadge
          icon={Eye} iconColor="#22c55e" accentColor="#22c55e" label="Ad Sets"
          value={`${statusCounts.active} active`}
          subValue={`${statusCounts.total} total — ${statusCounts.dead} dead`}
          subColor={statusCounts.dead > 0 ? '#ef4444' : '#6b7280'}
        />
      </div>

      {/* Decision tree */}
      <DecisionTreeCard events={dtEvents} />

      {/* Ad Sets */}
      <div style={{ marginBottom: '18px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px'
        }}>
          <h2 style={{
            fontSize: '14px', fontWeight: '700', color: '#d1d5db', margin: 0,
            display: 'flex', alignItems: 'center', gap: '6px'
          }}>
            <Bot size={14} color="#ec4899" /> Ad Sets
            <span style={{ fontSize: '11px', color: '#374151', fontWeight: '400' }}>
              {filteredAdSets.length} shown
            </span>
          </h2>

          {/* Filter pills */}
          <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
            <Filter size={11} color="#374151" style={{ marginRight: '4px' }} />
            {FILTER_OPTIONS.map(opt => {
              const count = opt.value === 'active' ? statusCounts.active
                : opt.value === 'paused' ? statusCounts.paused
                : opt.value === 'dead' ? statusCounts.dead
                : statusCounts.total;
              const isSelected = statusFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setStatusFilter(opt.value)}
                  style={{
                    padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: '600',
                    cursor: 'pointer', border: '1px solid',
                    backgroundColor: isSelected ? '#1e3a5f' : 'transparent',
                    borderColor: isSelected ? '#3b82f6' : '#1f2937',
                    color: isSelected ? '#93c5fd' : '#4b5563',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {opt.label} ({count})
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {filteredAdSets.map((as, i) => <AdSetCard key={as.adset_id || i} adset={as} onRefresh={fetchData} />)}
          {filteredAdSets.length === 0 && (
            <div style={{
              padding: '30px', textAlign: 'center', color: '#374151', fontSize: '13px',
              background: 'linear-gradient(135deg, #12141e 0%, #161925 100%)',
              borderRadius: '10px', border: '1px solid #1f2937'
            }}>
              No ad sets match "{statusFilter}" filter
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div style={{
        background: 'linear-gradient(135deg, #141720 0%, #1a1d2a 100%)',
        border: '1px solid #252836', borderRadius: '10px',
        padding: '14px'
      }}>
        <h2 style={{
          fontSize: '14px', fontWeight: '700', color: '#d1d5db', margin: '0 0 10px',
          display: 'flex', alignItems: 'center', gap: '6px'
        }}>
          <Clock size={14} color="#3b82f6" /> Activity Timeline
          <span style={{ fontSize: '11px', color: '#374151', fontWeight: '400' }}>{timeline.length} events</span>
        </h2>
        <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
          {timeline.map((event, i) => <TimelineEvent key={i} event={event} />)}
          {timeline.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center', color: '#374151', fontSize: '12px' }}>
              No activity yet
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
