import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain, Bot, Clock, AlertTriangle, CheckCircle, XCircle,
  TrendingUp, DollarSign, Eye, Zap, RefreshCw,
  ChevronDown, ChevronRight, Image, Pause, Play, Target, Skull,
  Shield, Timer, Power, Palette, Plus, Send, X, Trash2,
  LogOut, Search, ShoppingCart
} from 'lucide-react';
import {
  getAIOpsStatus, runAIManager, runAgents, refreshAIOpsMetrics,
  autoRefreshAIOps, pauseEntity, deleteEntity, getAvailableCreatives,
  addAdToAdSet, generateAdCopy, getCreativePreviewUrl, logout
} from '../api';

// ═══ HELPERS ═══
const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '0';
const fmtK = (v) => {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${fmt(v, 0)}`;
};
const timeAgo = (minutes) => {
  if (minutes == null) return 'Never';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ago`;
};

const roasColor = (roas) => {
  const v = roas || 0;
  if (v >= 3) return '#22c55e';
  if (v >= 1.5) return '#eab308';
  return '#ef4444';
};

const PHASE_COLORS = {
  learning: '#3b82f6', evaluating: '#f59e0b', scaling: '#10b981',
  stable: '#22c55e', killing: '#ef4444', dead: '#6b7280', activating: '#8b5cf6'
};

const URGENCY_COLORS = {
  critical: { bg: '#450a0a', border: '#dc2626', text: '#fca5a5' },
  high: { bg: '#451a03', border: '#f59e0b', text: '#fde68a' },
  medium: { bg: '#172554', border: '#3b82f6', text: '#93c5fd' },
  low: { bg: '#052e16', border: '#22c55e', text: '#86efac' }
};

const CATEGORY_LABELS = {
  low_roas: 'Low ROAS', high_cpa: 'High CPA', creative_fatigue: 'Fatigue',
  no_conversions: 'No Conv', budget_waste: 'Waste', strong_performer: 'Strong',
  recovery_signal: 'Recovery', learning_phase: 'Learning', audience_saturation: 'Saturated', other: 'Other'
};

// ═══ METRIC PILL ═══
const MetricPill = ({ label, value, color, small }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: small ? 'flex-end' : 'center',
    gap: '1px', minWidth: small ? 'auto' : '70px'
  }}>
    <span style={{ fontSize: '9px', color: '#52525b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {label}
    </span>
    <span style={{ fontSize: small ? '12px' : '14px', fontWeight: '700', color: color || '#e4e4e7', letterSpacing: '-0.02em' }}>
      {value}
    </span>
  </div>
);

// ═══ AD ROW ═══
const AdRow = ({ ad, onPause, onDelete }) => {
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const m = ad.metrics_7d || {};

  const handlePause = async (e) => {
    e.stopPropagation();
    if (pausing || deleting || removed) return;
    if (!confirm(`Pause "${ad.ad_name || ad.ad_id}"?`)) return;
    setPausing(true);
    try {
      await pauseEntity(ad.ad_id, { entity_type: 'ad', entity_name: ad.ad_name || ad.ad_id, reason: 'Manual pause from dashboard' });
      setRemoved(true);
      if (onPause) onPause(ad.ad_id);
    } catch (err) {
      alert('Error: ' + (err.message || 'Unknown'));
    } finally { setPausing(false); }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (pausing || deleting || removed) return;
    if (!confirm(`DELETE "${ad.ad_name || ad.ad_id}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteEntity(ad.ad_id, { entity_type: 'ad', entity_name: ad.ad_name || ad.ad_id, reason: 'Manual delete from dashboard' });
      setRemoved(true);
      if (onDelete) onDelete(ad.ad_id);
    } catch (err) {
      alert('Error: ' + (err.response?.data?.error || err.message || 'Unknown'));
    } finally { setDeleting(false); }
  };

  if (removed) return null;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 72px 72px 56px 56px 56px 64px',
      gap: '8px', alignItems: 'center', padding: '8px 12px',
      backgroundColor: '#18181b', borderRadius: '8px',
      border: '1px solid #27272a'
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12px', color: '#d4d4d8', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ad.ad_name || ad.ad_id}
        </div>
        {ad.creative && (
          <div style={{ fontSize: '10px', color: '#52525b', display: 'flex', alignItems: 'center', gap: '3px', marginTop: '1px' }}>
            <Image size={9} /> {ad.creative.style || 'N/A'}
          </div>
        )}
      </div>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>${fmt(m.spend, 0)}</span>
      <span style={{ fontSize: '12px', fontWeight: '700', textAlign: 'right', color: roasColor(m.roas) }}>{fmt(m.roas)}x</span>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>{m.purchases || 0}</span>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>{fmt(m.ctr, 1)}%</span>
      <span style={{
        fontSize: '11px', textAlign: 'right',
        color: (m.frequency || 0) > 4 ? '#ef4444' : (m.frequency || 0) > 3 ? '#eab308' : '#71717a'
      }}>{fmt(m.frequency, 1)}</span>
      <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
        <button onClick={handlePause} disabled={pausing || deleting} title="Pause" style={{
          width: '26px', height: '26px', borderRadius: '6px',
          border: '1px solid #eab30833', backgroundColor: '#18181b',
          color: '#eab308', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
        }}>
          {pausing ? <RefreshCw size={10} className="spin" /> : <Pause size={10} />}
        </button>
        <button onClick={handleDelete} disabled={pausing || deleting} title="Delete" style={{
          width: '26px', height: '26px', borderRadius: '6px',
          border: '1px solid #ef444433', backgroundColor: '#18181b',
          color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
        }}>
          {deleting ? <RefreshCw size={10} className="spin" /> : <Trash2 size={10} />}
        </button>
      </div>
    </div>
  );
};

// ═══ CREATIVE HEALTH ═══
const CreativeHealth = ({ adset }) => {
  const { creative_health: health, needs_new_creatives, creative_rotation_needed, suggested_styles: styles = [], frequency_detail, frequency_status } = adset;
  if (!health && !needs_new_creatives && !creative_rotation_needed && !frequency_detail) return null;

  const freqColor = frequency_status === 'critical' ? '#ef4444' : frequency_status === 'high' ? '#eab308' : '#3b82f6';

  return (
    <div style={{ backgroundColor: '#1c1917', border: '1px solid #292524', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <Palette size={12} color="#a78bfa" />
        <span style={{ fontSize: '10px', fontWeight: '700', color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Creative Health</span>
        {needs_new_creatives && <span style={{ fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#450a0a', color: '#fca5a5' }}>NEEDS NEW</span>}
        {creative_rotation_needed && !needs_new_creatives && <span style={{ fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#451a03', color: '#fde68a' }}>ROTATE</span>}
      </div>
      {frequency_detail && <div style={{ fontSize: '11px', color: freqColor, marginBottom: '4px' }}>{frequency_detail}</div>}
      {health && <div style={{ fontSize: '11px', color: '#a8a29e', lineHeight: '1.5' }}>{health}</div>}
      {styles.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
          {styles.map((s, i) => (
            <span key={i} style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '4px', backgroundColor: '#052e16', color: '#86efac', border: '1px solid #22c55e33' }}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ═══ ADD CREATIVE PANEL ═══
const AddCreativePanel = ({ adsetId, onClose, onSuccess }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [generatingCopy, setGeneratingCopy] = useState(false);
  const [generatedCopy, setGeneratedCopy] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(0);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getAvailableCreatives(adsetId);
        setAssets(data.assets || []);
      } catch (err) { setError(err.message); } finally { setLoading(false); }
    })();
  }, [adsetId]);

  const selectedAsset = assets.find(a => a._id === selected);
  const availableAssets = assets.filter(a => !a.already_in_adset);

  const handleGenerateCopy = async () => {
    if (!selected) return;
    setGeneratingCopy(true); setError(null); setGeneratedCopy(null);
    try {
      const res = await generateAdCopy(adsetId, selected);
      setGeneratedCopy({ headlines: res.headlines, bodies: res.bodies });
      setSelectedVariant(0);
    } catch (err) { setError(err.message || 'Error generating copy'); } finally { setGeneratingCopy(false); }
  };

  const handleCreate = async () => {
    if (!selected || !generatedCopy) return;
    setCreating(true); setError(null);
    try {
      const headline = generatedCopy.headlines[selectedVariant] || generatedCopy.headlines[0];
      const body = generatedCopy.bodies[selectedVariant] || generatedCopy.bodies[0];
      const res = await addAdToAdSet(adsetId, selected, headline, body);
      setResult(res.result || res);
      if (onSuccess) onSuccess();
    } catch (err) { setError(err.message || 'Error creating ad'); } finally { setCreating(false); }
  };

  return (
    <div style={{ backgroundColor: '#09090b', border: '1px solid #22c55e33', borderRadius: '10px', padding: '16px', marginTop: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Plus size={13} color="#22c55e" />
          <span style={{ fontSize: '11px', fontWeight: '700', color: '#22c55e', textTransform: 'uppercase' }}>
            {!generatedCopy ? 'Select Creative' : 'Review Copy'}
          </span>
          {generatedCopy && (
            <button onClick={() => { setGeneratedCopy(null); setSelectedVariant(0); setError(null); }} style={{
              fontSize: '10px', color: '#71717a', background: 'none', border: '1px solid #27272a', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer'
            }}>Back</button>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#52525b', cursor: 'pointer', padding: '2px' }}><X size={14} /></button>
      </div>

      {loading && <div style={{ fontSize: '11px', color: '#52525b', padding: '8px 0' }}>Loading assets...</div>}
      {error && <div style={{ fontSize: '11px', color: '#fca5a5', padding: '6px 8px', backgroundColor: '#450a0a', borderRadius: '6px', marginBottom: '8px' }}>{error}</div>}

      {result && (
        <div style={{ fontSize: '11px', color: '#86efac', padding: '10px 12px', backgroundColor: '#052e1688', borderRadius: '6px' }}>
          <CheckCircle size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
          {result.ads_created} ad(s) created!
        </div>
      )}

      {/* Step 1: Asset selection */}
      {!result && !loading && !generatedCopy && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', maxHeight: '300px', overflowY: 'auto', marginBottom: '10px' }}>
            {availableAssets.map(asset => (
              <div key={asset._id} onClick={() => setSelected(asset._id)} style={{
                borderRadius: '8px', cursor: 'pointer', overflow: 'hidden',
                backgroundColor: selected === asset._id ? '#052e1622' : '#18181b',
                border: `2px solid ${selected === asset._id ? '#22c55e' : '#27272a'}`,
              }}>
                <div style={{ width: '100%', height: '110px', backgroundColor: '#09090b', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  <img src={getCreativePreviewUrl(asset.filename)} alt={asset.original_name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { e.target.style.display = 'none'; e.target.parentNode.innerHTML = '<div style="color: #3f3f46; font-size: 10px;">No preview</div>'; }}
                  />
                </div>
                <div style={{ padding: '6px 8px' }}>
                  <div style={{ fontSize: '10px', color: '#d4d4d8', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '3px' }}>{asset.original_name}</div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {asset.style && <span style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '3px', backgroundColor: '#27272a', color: '#a1a1aa' }}>{asset.style}</span>}
                    <span style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '3px', backgroundColor: asset.times_used === 0 ? '#052e16' : '#451a03', color: asset.times_used === 0 ? '#86efac' : '#fde68a' }}>
                      {asset.times_used === 0 ? 'NEW' : `${asset.times_used}x`}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {availableAssets.length === 0 && <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: '#3f3f46', gridColumn: '1 / -1' }}>No available assets</div>}
          </div>
          {selected && (
            <button onClick={handleGenerateCopy} disabled={generatingCopy} style={{
              width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #7c3aed33',
              background: generatingCopy ? '#2e1065' : 'linear-gradient(135deg, #4c1d95, #7c3aed)',
              color: '#e9d5ff', fontSize: '12px', fontWeight: '700', cursor: generatingCopy ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
            }}>
              {generatingCopy ? <><RefreshCw size={13} className="spin" /> Claude is writing...</> : <><Brain size={13} /> Generate Copy</>}
            </button>
          )}
        </>
      )}

      {/* Step 2: Copy review */}
      {!result && generatedCopy && (
        <>
          {selectedAsset && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 10px', backgroundColor: '#18181b', borderRadius: '8px', marginBottom: '10px' }}>
              <img src={getCreativePreviewUrl(selectedAsset.filename)} alt="" style={{ width: '44px', height: '44px', objectFit: 'cover', borderRadius: '6px' }} onError={(e) => { e.target.style.display = 'none'; }} />
              <div>
                <div style={{ fontSize: '11px', color: '#d4d4d8', fontWeight: '600' }}>{selectedAsset.original_name}</div>
                <div style={{ fontSize: '10px', color: '#71717a' }}>{selectedAsset.style}</div>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            {generatedCopy.headlines.map((headline, i) => (
              <div key={i} onClick={() => setSelectedVariant(i)} style={{
                padding: '10px 12px', borderRadius: '8px', cursor: 'pointer',
                backgroundColor: selectedVariant === i ? '#052e1616' : '#18181b',
                border: `2px solid ${selectedVariant === i ? '#22c55e' : '#27272a44'}`
              }}>
                <div style={{ fontSize: '13px', color: '#f4f4f5', fontWeight: '700', marginBottom: '4px' }}>{headline}</div>
                <div style={{ fontSize: '11px', color: '#a1a1aa', lineHeight: '1.5' }}>{generatedCopy.bodies[i] || ''}</div>
              </div>
            ))}
          </div>
          <button onClick={handleCreate} disabled={creating} style={{
            width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #22c55e33',
            background: creating ? '#064e3b' : 'linear-gradient(135deg, #14532d, #166534)',
            color: '#86efac', fontSize: '12px', fontWeight: '700', cursor: creating ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
          }}>
            {creating ? <><RefreshCw size={13} className="spin" /> Creating...</> : <><Send size={13} /> Create Ad</>}
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
  const m3 = adset.metrics_3d || {};
  const mT = adset.metrics_today || {};
  const phase = adset.phase || 'unknown';
  const phaseColor = PHASE_COLORS[phase] || '#71717a';
  const activeAds = (adset.ads || []).filter(a => a.status === 'ACTIVE');
  const totalAds = (adset.ads || []).length;
  const isActive = adset.status === 'ACTIVE';
  const isDead = phase === 'dead' || phase === 'killing';
  const isPaused = !isActive;
  const roas7d = m7.roas || 0;
  const criticalDirs = (adset.directives || []).filter(d => d.urgency === 'critical');

  return (
    <div style={{
      backgroundColor: '#18181b',
      border: `1px solid ${isDead ? '#27272a' : criticalDirs.length > 0 ? '#dc262644' : '#27272a'}`,
      borderRadius: '12px', overflow: 'hidden',
      opacity: isDead ? 0.4 : isPaused ? 0.7 : 1,
      transition: 'opacity 0.15s'
    }}>
      {/* Status banner */}
      {isPaused && (
        <div style={{
          padding: '4px 16px', display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: isDead ? '#27272a' : '#450a0a',
          borderBottom: `1px solid ${isDead ? '#3f3f46' : '#dc262633'}`
        }}>
          <Power size={10} color={isDead ? '#71717a' : '#fca5a5'} />
          <span style={{ fontSize: '10px', fontWeight: '700', color: isDead ? '#71717a' : '#fca5a5', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {isDead ? 'DEAD' : adset.status}
          </span>
        </div>
      )}

      {/* Header - clickable */}
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
        borderBottom: expanded ? '1px solid #27272a' : 'none'
      }}>
        {expanded ? <ChevronDown size={14} color="#52525b" /> : <ChevronRight size={14} color="#52525b" />}

        {/* Phase badge */}
        <span style={{
          fontSize: '9px', fontWeight: '800', padding: '3px 8px', borderRadius: '4px',
          backgroundColor: phaseColor + '18', color: phaseColor, textTransform: 'uppercase',
          letterSpacing: '0.06em', border: `1px solid ${phaseColor}33`
        }}>{phase}</span>

        {/* Name */}
        <span style={{
          fontSize: '13px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: isDead ? '#52525b' : isPaused ? '#71717a' : '#e4e4e7'
        }}>
          {adset.adset_name}
        </span>

        {/* Quick metrics */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexShrink: 0 }}>
          <MetricPill label="Spend" value={fmtK(m7.spend)} small />
          <MetricPill label="ROAS" value={`${fmt(roas7d)}x`} color={roasColor(roas7d)} small />
          <MetricPill label="Purch" value={m7.purchases || 0} small />
          <MetricPill label="Ads" value={`${activeAds.length}/${totalAds}`} small />
          {criticalDirs.length > 0 && (
            <span style={{ fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#450a0a', color: '#fca5a5' }}>
              {adset.directives.length} DIR
            </span>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '16px' }}>
          {/* Metrics grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
            gap: '12px', padding: '12px 16px', marginBottom: '12px',
            backgroundColor: '#09090b', borderRadius: '10px', border: '1px solid #27272a'
          }}>
            {[
              { label: 'Budget/d', value: `$${fmt(adset.budget, 0)}` },
              { label: 'Days', value: fmt(adset.days_active, 1) },
              { label: 'CPA', value: `$${fmt(m7.cpa, 2)}` },
              { label: 'Freq 7d', value: fmt(m7.frequency, 1), color: (m7.frequency || 0) > 4 ? '#ef4444' : (m7.frequency || 0) > 3 ? '#eab308' : null },
              { label: 'CTR', value: `${fmt(m7.ctr, 2)}%` },
              { label: 'ROAS 3d', value: `${fmt(m3.roas)}x`, color: roasColor(m3.roas) },
              { label: 'Today $', value: `$${fmt(mT.spend, 0)}` },
              { label: 'Today ROAS', value: `${fmt(mT.roas)}x`, color: roasColor(mT.roas) },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: '#52525b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{item.label}</span>
                <span style={{ fontSize: '13px', color: item.color || '#d4d4d8', fontWeight: '600' }}>{item.value}</span>
              </div>
            ))}
          </div>

          {/* AI Assessment */}
          {adset.last_assessment && (
            <div style={{
              padding: '10px 12px', backgroundColor: '#09090b', borderRadius: '8px',
              borderLeft: '3px solid #3b82f644', marginBottom: '10px'
            }}>
              <div style={{ fontSize: '9px', fontWeight: '700', color: '#52525b', textTransform: 'uppercase', marginBottom: '4px' }}>AI Assessment</div>
              <div style={{ fontSize: '11px', color: '#a1a1aa', lineHeight: '1.5' }}>{adset.last_assessment.substring(0, 300)}</div>
            </div>
          )}

          {/* Creative Health */}
          <CreativeHealth adset={adset} />

          {/* Ads table */}
          <div style={{ marginBottom: '10px' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 72px 72px 56px 56px 56px 64px',
              gap: '8px', padding: '4px 12px', fontSize: '9px', color: '#52525b',
              fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em'
            }}>
              <span>Ad</span>
              <span style={{ textAlign: 'right' }}>Spend</span>
              <span style={{ textAlign: 'right' }}>ROAS</span>
              <span style={{ textAlign: 'right' }}>Purch</span>
              <span style={{ textAlign: 'right' }}>CTR</span>
              <span style={{ textAlign: 'right' }}>Freq</span>
              <span></span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {activeAds.map((ad, i) => <AdRow key={ad.ad_id || i} ad={ad} />)}
            </div>
            {activeAds.length === 0 && (
              <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: '#3f3f46' }}>No active ads</div>
            )}
            {totalAds > activeAds.length && (
              <div style={{ padding: '4px 12px', fontSize: '10px', color: '#3f3f46', textAlign: 'right' }}>
                +{totalAds - activeAds.length} paused/off hidden
              </div>
            )}

            {/* Add Creative */}
            {isActive && !showAddCreative && (
              <button onClick={() => setShowAddCreative(true)} style={{
                width: '100%', padding: '7px', marginTop: '6px', borderRadius: '8px',
                border: '1px dashed #22c55e44', backgroundColor: 'transparent',
                color: '#22c55e88', fontSize: '11px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px'
              }}>
                <Plus size={12} /> Add Creative
              </button>
            )}
          </div>

          {showAddCreative && (
            <AddCreativePanel adsetId={adset.adset_id} onClose={() => setShowAddCreative(false)} onSuccess={onRefresh} />
          )}

          {/* Directives */}
          {(adset.directives || []).length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', fontWeight: '700', color: '#52525b', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em' }}>
                Brain Directives ({adset.directives.length})
              </div>
              {adset.directives.map((d, i) => {
                const urg = URGENCY_COLORS[d.urgency] || URGENCY_COLORS.medium;
                return (
                  <div key={i} style={{
                    padding: '6px 10px', backgroundColor: urg.bg + '44', border: `1px solid ${urg.border}22`,
                    borderRadius: '6px', marginBottom: '3px', display: 'flex', gap: '6px', alignItems: 'flex-start'
                  }}>
                    <span style={{ fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '3px', backgroundColor: urg.bg, color: urg.text, flexShrink: 0, textTransform: 'uppercase' }}>{d.urgency}</span>
                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', backgroundColor: '#27272a', color: '#71717a', flexShrink: 0 }}>{CATEGORY_LABELS[d.category] || d.category}</span>
                    <span style={{ fontSize: '11px', color: '#a1a1aa', flex: 1, lineHeight: '1.4' }}>
                      {d.type}/{d.target_action} — {d.reason?.replace('[BRAIN\u2192AI-MANAGER] ', '').substring(0, 150)}
                    </span>
                    <span style={{ fontSize: '10px', color: '#3f3f46', flexShrink: 0 }}>{d.hours_ago}h</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent Actions */}
          {(adset.recent_actions || []).length > 0 && (
            <div>
              <div style={{ fontSize: '10px', fontWeight: '700', color: '#52525b', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em' }}>
                Recent Actions ({adset.recent_actions.length})
              </div>
              {adset.recent_actions.slice(0, 5).map((a, i) => (
                <div key={i} style={{
                  padding: '5px 10px', backgroundColor: '#09090b', borderRadius: '6px', marginBottom: '2px',
                  display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px'
                }}>
                  <span style={{ color: a.success ? '#22c55e' : '#ef4444', flexShrink: 0 }}>
                    {a.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
                  </span>
                  <span style={{ color: '#d4d4d8', fontWeight: '600' }}>{a.action}</span>
                  {a.change_pct != null && <span style={{ color: a.change_pct > 0 ? '#22c55e' : '#ef4444', fontSize: '10px' }}>{a.change_pct > 0 ? '+' : ''}{a.change_pct}%</span>}
                  <span style={{ color: '#52525b', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.reasoning?.replace(/\[.*?\]\s*/g, '').substring(0, 100)}
                  </span>
                  <span style={{ color: '#3f3f46', flexShrink: 0 }}>{a.hours_ago}h</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ═══ MAIN PAGE ═══
export default function AdSetsManager() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [autoRefreshStatus, setAutoRefreshStatus] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await getAIOpsStatus();
      if (result && result.ai_manager) setData(result);
      else if (result?.error) setError(result.error);
      else setData(result || {});
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Auto-refresh on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAutoRefreshStatus('checking');
      try {
        const result = await autoRefreshAIOps();
        if (cancelled) return;
        if (result.action === 'refreshing' || result.status === 'completed') {
          setAutoRefreshStatus('done');
          await fetchData();
        } else {
          setAutoRefreshStatus('fresh');
        }
      } catch { if (!cancelled) setAutoRefreshStatus(null); }
      if (!cancelled) setTimeout(() => { if (!cancelled) setAutoRefreshStatus(null); }, 5000);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleAction = async (key, fn) => {
    setRunning(key);
    try { await fn(); await fetchData(); } catch (err) { setError(err.message); } finally { setRunning(null); }
  };

  const adSets = data?.adsets || [];
  const mgr = data?.ai_manager || {};
  const brain = data?.brain || {};
  const df = data?.data_freshness || {};
  const timeline = data?.timeline || [];
  const dtEvents = data?.decision_tree_events || [];

  // Counts
  const counts = useMemo(() => {
    const c = { active: 0, paused: 0, dead: 0, total: adSets.length };
    for (const as of adSets) {
      if (as.phase === 'dead' || as.phase === 'killing') c.dead++;
      else if (as.status === 'ACTIVE') c.active++;
      else c.paused++;
    }
    return c;
  }, [adSets]);

  // Totals
  const totals = useMemo(() => {
    const active = adSets.filter(as => as.status === 'ACTIVE' && as.phase !== 'dead');
    return {
      spend7d: active.reduce((s, as) => s + (as.metrics_7d?.spend || 0), 0),
      purchases7d: active.reduce((s, as) => s + (as.metrics_7d?.purchases || 0), 0),
      avgRoas: active.length > 0
        ? active.reduce((s, as) => s + (as.metrics_7d?.roas || 0), 0) / active.length : 0
    };
  }, [adSets]);

  // Filter + search
  const filtered = useMemo(() => {
    let list = adSets;
    if (filter === 'active') list = list.filter(as => as.status === 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    else if (filter === 'paused') list = list.filter(as => as.status !== 'ACTIVE' && as.phase !== 'dead' && as.phase !== 'killing');
    else if (filter === 'dead') list = list.filter(as => as.phase === 'dead' || as.phase === 'killing');

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(as => (as.adset_name || '').toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      const order = (as) => as.phase === 'dead' || as.phase === 'killing' ? 2 : as.status !== 'ACTIVE' ? 1 : 0;
      const oa = order(a), ob = order(b);
      if (oa !== ob) return oa - ob;
      return ((b.metrics_7d || {}).spend || 0) - ((a.metrics_7d || {}).spend || 0);
    });
  }, [adSets, filter, search]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#09090b', color: '#71717a', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <RefreshCw size={18} className="spin" />
        <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading...</span>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#09090b', minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* ═══ TOP BAR ═══ */}
      <div style={{
        padding: '16px 24px', borderBottom: '1px solid #27272a',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, backgroundColor: '#09090b', zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '34px', height: '34px', borderRadius: '10px',
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Zap size={17} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '16px', fontWeight: '800', color: '#fafafa', margin: 0, letterSpacing: '-0.02em' }}>
              Ad Sets Manager
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '11px', color: '#52525b' }}>Brain + AI Manager</span>
              {/* Freshness */}
              {(() => {
                const age = df.oldest_snapshot_age_min;
                const isStale = df.is_stale;
                const refreshing = df.refresh_in_progress || autoRefreshStatus === 'checking';
                const color = refreshing ? '#3b82f6' : isStale ? '#ef4444' : '#22c55e';
                return (
                  <span style={{
                    fontSize: '10px', fontWeight: '600', color, padding: '1px 8px', borderRadius: '10px',
                    border: `1px solid ${color}33`, backgroundColor: `${color}0a`,
                    display: 'flex', alignItems: 'center', gap: '4px'
                  }}>
                    {refreshing && <RefreshCw size={8} className="spin" />}
                    {!refreshing && <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: color }} />}
                    {refreshing ? 'Refreshing' : autoRefreshStatus === 'done' ? 'Updated' : age != null ? `${age}m ago` : 'No data'}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {[
            { key: 'manager', fn: () => handleAction('manager', runAIManager), Icon: Bot, color: '#ec4899', label: 'Manager' },
            { key: 'brain', fn: () => handleAction('brain', runAgents), Icon: Brain, color: '#3b82f6', label: 'Brain' },
            { key: 'refresh', fn: () => handleAction('refresh', refreshAIOpsMetrics), Icon: RefreshCw, color: '#22c55e', label: 'Refresh' }
          ].map(({ key, fn, Icon, color, label }) => (
            <button key={key} onClick={fn} disabled={running != null} style={{
              padding: '7px 14px', borderRadius: '8px', border: `1px solid ${color}33`,
              backgroundColor: running === key ? color + '15' : '#18181b',
              color, fontSize: '11px', fontWeight: '600', cursor: running ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px',
              opacity: running && running !== key ? 0.3 : 1
            }}>
              {running === key ? <RefreshCw size={12} className="spin" /> : <Icon size={12} />}
              {label}
            </button>
          ))}
          <button onClick={logout} title="Logout" style={{
            padding: '7px', borderRadius: '8px', border: '1px solid #27272a',
            backgroundColor: '#18181b', color: '#52525b', cursor: 'pointer',
            display: 'flex', alignItems: 'center'
          }}>
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '20px 24px' }}>
        {/* Error */}
        {error && (
          <div style={{ padding: '10px 14px', backgroundColor: '#450a0a', border: '1px solid #dc2626', borderRadius: '10px', marginBottom: '16px', color: '#fca5a5', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {error}
            <button onClick={() => { setLoading(true); fetchData(); }} style={{
              padding: '4px 10px', borderRadius: '6px', border: '1px solid #dc2626', backgroundColor: '#7f1d1d', color: '#fca5a5', cursor: 'pointer', fontSize: '11px'
            }}>Retry</button>
          </div>
        )}

        {/* ═══ STATS ROW ═══ */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px', marginBottom: '20px'
        }}>
          {[
            { icon: Eye, color: '#22c55e', label: 'Active', value: counts.active, sub: `${counts.total} total` },
            { icon: Pause, color: '#eab308', label: 'Paused', value: counts.paused, sub: `${counts.dead} dead` },
            { icon: DollarSign, color: '#3b82f6', label: 'Spend 7d', value: fmtK(totals.spend7d), sub: `$${fmt(totals.spend7d / 7, 0)}/day avg` },
            { icon: TrendingUp, color: roasColor(totals.avgRoas), label: 'Avg ROAS', value: `${fmt(totals.avgRoas)}x`, sub: '7d average' },
            { icon: ShoppingCart, color: '#a78bfa', label: 'Purchases', value: totals.purchases7d, sub: '7d total' },
            { icon: Bot, color: '#ec4899', label: 'Manager', value: mgr.minutes_since_last_run != null ? timeAgo(mgr.minutes_since_last_run) : 'Never', sub: `${mgr.actions_48h || 0} actions 48h` },
          ].map(({ icon: Icon, color, label, value, sub }, i) => (
            <div key={i} style={{
              backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '10px',
              padding: '14px 16px', borderLeft: `3px solid ${color}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <Icon size={12} color={color} />
                <span style={{ fontSize: '10px', color: '#52525b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
              </div>
              <div style={{ fontSize: '20px', fontWeight: '800', color: '#fafafa', letterSpacing: '-0.02em' }}>{value}</div>
              <div style={{ fontSize: '11px', color: '#52525b', marginTop: '2px' }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* ═══ DECISION TREE ═══ */}
        {dtEvents.length > 0 && (
          <div style={{
            backgroundColor: '#1a0a0a', border: '1px solid #dc262633', borderRadius: '12px',
            padding: '14px 16px', marginBottom: '16px'
          }}>
            <div style={{ fontSize: '12px', fontWeight: '700', color: '#ef4444', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Skull size={14} /> Decision Tree — Forced Actions (7d)
              <span style={{ fontSize: '10px', color: '#71717a', fontWeight: '400' }}>{dtEvents.length} events</span>
            </div>
            {dtEvents.slice(0, 5).map((e, i) => (
              <div key={i} style={{ padding: '6px 10px', backgroundColor: '#09090b44', border: '1px solid #dc262622', borderRadius: '6px', marginBottom: '4px' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '2px' }}>
                  <span style={{ fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', backgroundColor: e.action === 'pause' ? '#450a0a' : '#451a03', color: e.action === 'pause' ? '#fca5a5' : '#fde68a' }}>
                    {e.action === 'pause' ? 'KILL' : 'SCALE DOWN'}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: '600', color: '#d4d4d8' }}>{e.entity_name}</span>
                  {e.change_pct != null && <span style={{ fontSize: '11px', color: '#ef4444' }}>{e.change_pct}%</span>}
                  <span style={{ fontSize: '10px', color: '#3f3f46', marginLeft: 'auto' }}>{e.hours_ago}h ago</span>
                </div>
                <div style={{ fontSize: '10px', color: '#71717a', lineHeight: '1.4' }}>{e.reasoning?.replace(/\[.*?\]\s*/g, '')}</div>
              </div>
            ))}
          </div>
        )}

        {/* ═══ FILTER BAR ═══ */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '12px', gap: '12px'
        }}>
          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px',
            backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px', flex: 1, maxWidth: '300px'
          }}>
            <Search size={13} color="#52525b" />
            <input
              type="text" placeholder="Search ad sets..." value={search} onChange={e => setSearch(e.target.value)}
              style={{
                background: 'none', border: 'none', outline: 'none', color: '#e4e4e7',
                fontSize: '12px', fontFamily: 'Inter, system-ui, sans-serif', width: '100%'
              }}
            />
          </div>

          {/* Filter pills */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {[
              { value: 'active', label: 'Active', count: counts.active },
              { value: 'all', label: 'All', count: counts.total },
              { value: 'paused', label: 'Paused', count: counts.paused },
              { value: 'dead', label: 'Dead', count: counts.dead }
            ].map(opt => (
              <button key={opt.value} onClick={() => setFilter(opt.value)} style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '600',
                cursor: 'pointer', border: '1px solid',
                backgroundColor: filter === opt.value ? '#172554' : 'transparent',
                borderColor: filter === opt.value ? '#3b82f6' : '#27272a',
                color: filter === opt.value ? '#93c5fd' : '#52525b'
              }}>
                {opt.label} ({opt.count})
              </button>
            ))}
          </div>
        </div>

        {/* ═══ AD SETS LIST ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
          {filtered.map((as, i) => <AdSetCard key={as.adset_id || i} adset={as} onRefresh={fetchData} />)}
          {filtered.length === 0 && (
            <div style={{
              padding: '40px', textAlign: 'center', color: '#3f3f46', fontSize: '13px',
              backgroundColor: '#18181b', borderRadius: '12px', border: '1px solid #27272a'
            }}>
              {search ? `No ad sets match "${search}"` : `No ${filter} ad sets`}
            </div>
          )}
        </div>

        {/* ═══ TIMELINE ═══ */}
        {timeline.length > 0 && (
          <div style={{
            backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px', padding: '16px'
          }}>
            <h2 style={{
              fontSize: '13px', fontWeight: '700', color: '#d4d4d8', margin: '0 0 12px',
              display: 'flex', alignItems: 'center', gap: '6px'
            }}>
              <Clock size={13} color="#3b82f6" /> Activity
              <span style={{ fontSize: '11px', color: '#3f3f46', fontWeight: '400' }}>{timeline.length}</span>
            </h2>
            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {timeline.slice(0, 30).map((event, i) => {
                const configs = {
                  ai_manager_action: { icon: Bot, color: '#ec4899' },
                  decision_tree: { icon: Skull, color: '#ef4444' },
                  brain_directive: { icon: Brain, color: '#3b82f6' },
                  safety_event: { icon: Shield, color: '#eab308' }
                };
                const cfg = configs[event.type] || configs.ai_manager_action;
                const Icon = cfg.icon;
                const minsAgo = Math.round((Date.now() - new Date(event.timestamp)) / 60000);
                return (
                  <div key={i} style={{ display: 'flex', gap: '10px', padding: '6px 0', borderBottom: '1px solid #27272a22' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '6px', backgroundColor: cfg.color + '12', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon size={11} color={cfg.color} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', fontWeight: '600', color: '#d4d4d8' }}>{event.entity_name}</span>
                        <span style={{ fontSize: '11px', color: '#71717a' }}>{event.action}</span>
                        {event.change && <span style={{ fontSize: '11px', color: String(event.change).startsWith('+') ? '#22c55e' : '#ef4444', fontWeight: '600' }}>{event.change}</span>}
                      </div>
                      <div style={{ fontSize: '10px', color: '#52525b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {event.detail?.replace(/\[.*?\]\s*/g, '').substring(0, 150)}
                      </div>
                    </div>
                    <span style={{ fontSize: '10px', color: '#3f3f46', flexShrink: 0 }}>{timeAgo(minsAgo)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
      `}</style>
    </div>
  );
}
