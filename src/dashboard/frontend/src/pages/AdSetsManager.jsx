import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain, Bot, CheckCircle, XCircle,
  TrendingUp, DollarSign, Eye, RefreshCw,
  ChevronDown, ChevronRight, Image, Pause, Play,
  Power, Plus, Send, X, Trash2,
  LogOut, Search, ShoppingCart, BarChart2
} from 'lucide-react';
import {
  getAllAdSets, getAdsForAdSet, getAccountOverview,
  runAIManager, runAgents, refreshAIOpsMetrics, autoRefreshAIOps,
  pauseEntity, deleteEntity, getAvailableCreatives,
  addAdToAdSet, generateAdCopy, getCreativePreviewUrl, logout
} from '../api';

// ═══ HELPERS ═══
const fmt = (v, d = 2) => v != null ? Number(v).toFixed(d) : '0';
const fmtK = (v) => {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${fmt(v, 0)}`;
};
const roasColor = (roas) => {
  const v = roas || 0;
  if (v >= 3) return '#22c55e';
  if (v >= 1.5) return '#eab308';
  return '#ef4444';
};
const freqColor = (f) => {
  if (f > 4) return '#ef4444';
  if (f > 3) return '#eab308';
  return '#71717a';
};

// ═══ AD ROW ═══
const AdRow = ({ ad, onAction }) => {
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const m = ad.metrics?.last_7d || {};

  const handlePause = async (e) => {
    e.stopPropagation();
    if (!confirm(`Pause "${ad.entity_name || ad.entity_id}"?`)) return;
    setPausing(true);
    try {
      await pauseEntity(ad.entity_id, { entity_type: 'ad', entity_name: ad.entity_name || ad.entity_id, reason: 'Manual pause' });
      setRemoved(true); if (onAction) onAction();
    } catch (err) { alert('Error: ' + (err.message || 'Unknown')); }
    finally { setPausing(false); }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirm(`DELETE "${ad.entity_name || ad.entity_id}"? Cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteEntity(ad.entity_id, { entity_type: 'ad', entity_name: ad.entity_name || ad.entity_id, reason: 'Manual delete' });
      setRemoved(true); if (onAction) onAction();
    } catch (err) { alert('Error: ' + (err.response?.data?.error || err.message)); }
    finally { setDeleting(false); }
  };

  if (removed) return null;
  const isActive = ad.status === 'ACTIVE';

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 72px 72px 56px 56px 56px 64px',
      gap: '8px', alignItems: 'center', padding: '8px 12px',
      backgroundColor: '#18181b', borderRadius: '8px', border: '1px solid #27272a',
      opacity: isActive ? 1 : 0.5
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isActive ? <Play size={9} color="#22c55e" fill="#22c55e" /> : <Pause size={9} color="#ef4444" />}
          <span style={{ fontSize: '12px', color: '#d4d4d8', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ad.entity_name || ad.entity_id}
          </span>
        </div>
      </div>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>${fmt(m.spend, 0)}</span>
      <span style={{ fontSize: '12px', fontWeight: '700', textAlign: 'right', color: roasColor(m.roas) }}>{fmt(m.roas)}x</span>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>{m.purchases || 0}</span>
      <span style={{ fontSize: '11px', color: '#a1a1aa', textAlign: 'right' }}>{fmt(m.ctr, 1)}%</span>
      <span style={{ fontSize: '11px', textAlign: 'right', color: freqColor(m.frequency || 0) }}>{fmt(m.frequency, 1)}</span>
      <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
        {isActive && (
          <button onClick={handlePause} disabled={pausing || deleting} title="Pause" style={{
            width: '26px', height: '26px', borderRadius: '6px',
            border: '1px solid #eab30833', backgroundColor: '#18181b',
            color: '#eab308', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
          }}>
            {pausing ? <RefreshCw size={10} className="spin" /> : <Pause size={10} />}
          </button>
        )}
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
    } catch (err) { setError(err.message); } finally { setGeneratingCopy(false); }
  };

  const handleCreate = async () => {
    if (!selected || !generatedCopy) return;
    setCreating(true); setError(null);
    try {
      const headline = generatedCopy.headlines[selectedVariant];
      const body = generatedCopy.bodies[selectedVariant];
      const res = await addAdToAdSet(adsetId, selected, headline, body);
      setResult(res.result || res);
      if (onSuccess) onSuccess();
    } catch (err) { setError(err.message); } finally { setCreating(false); }
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
            <button onClick={() => { setGeneratedCopy(null); setError(null); }} style={{
              fontSize: '10px', color: '#71717a', background: 'none', border: '1px solid #27272a', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer'
            }}>Back</button>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#52525b', cursor: 'pointer', padding: '2px' }}><X size={14} /></button>
      </div>

      {loading && <div style={{ fontSize: '11px', color: '#52525b', padding: '8px 0' }}>Loading...</div>}
      {error && <div style={{ fontSize: '11px', color: '#fca5a5', padding: '6px 8px', backgroundColor: '#450a0a', borderRadius: '6px', marginBottom: '8px' }}>{error}</div>}
      {result && <div style={{ fontSize: '11px', color: '#86efac', padding: '10px 12px', backgroundColor: '#052e1688', borderRadius: '6px' }}><CheckCircle size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />{result.ads_created} ad(s) created!</div>}

      {!result && !loading && !generatedCopy && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', maxHeight: '300px', overflowY: 'auto', marginBottom: '10px' }}>
            {availableAssets.map(asset => (
              <div key={asset._id} onClick={() => setSelected(asset._id)} style={{
                borderRadius: '8px', cursor: 'pointer', overflow: 'hidden',
                backgroundColor: selected === asset._id ? '#052e1622' : '#18181b',
                border: `2px solid ${selected === asset._id ? '#22c55e' : '#27272a'}`,
              }}>
                <div style={{ width: '100%', height: '110px', backgroundColor: '#09090b', overflow: 'hidden' }}>
                  <img src={getCreativePreviewUrl(asset.filename)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { e.target.style.display = 'none'; }} />
                </div>
                <div style={{ padding: '6px 8px' }}>
                  <div style={{ fontSize: '10px', color: '#d4d4d8', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.original_name}</div>
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
              {generatingCopy ? <><RefreshCw size={13} className="spin" /> Generating...</> : <><Brain size={13} /> Generate Copy</>}
            </button>
          )}
        </>
      )}

      {!result && generatedCopy && (
        <>
          {selectedAsset && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 10px', backgroundColor: '#18181b', borderRadius: '8px', marginBottom: '10px' }}>
              <img src={getCreativePreviewUrl(selectedAsset.filename)} alt="" style={{ width: '44px', height: '44px', objectFit: 'cover', borderRadius: '6px' }} onError={(e) => { e.target.style.display = 'none'; }} />
              <div style={{ fontSize: '11px', color: '#d4d4d8', fontWeight: '600' }}>{selectedAsset.original_name}</div>
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
  const [ads, setAds] = useState(null);
  const [loadingAds, setLoadingAds] = useState(false);
  const [showAddCreative, setShowAddCreative] = useState(false);

  const m7 = adset.metrics?.last_7d || {};
  const m3 = adset.metrics?.last_3d || {};
  const mT = adset.metrics?.today || {};
  const isActive = adset.status === 'ACTIVE';
  const roas7d = m7.roas || 0;
  const analysis = adset.analysis || {};

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && ads === null) {
      setLoadingAds(true);
      try {
        const data = await getAdsForAdSet(adset.entity_id);
        setAds((data || []).filter(a => a.status === 'ACTIVE' || a.status === 'PAUSED'));
      } catch { setAds([]); }
      finally { setLoadingAds(false); }
    }
  };

  const reloadAds = async () => {
    setLoadingAds(true);
    try {
      const data = await getAdsForAdSet(adset.entity_id);
      setAds((data || []).filter(a => a.status === 'ACTIVE' || a.status === 'PAUSED'));
    } catch { /* ignore */ }
    finally { setLoadingAds(false); }
    if (onRefresh) onRefresh();
  };

  const activeAds = (ads || []).filter(a => a.status === 'ACTIVE');
  const totalAds = (ads || []).length;
  const trendIcon = analysis.roas_trend === 'improving' ? '\u2191' : analysis.roas_trend === 'declining' ? '\u2193' : '\u2192';
  const trendColor = analysis.roas_trend === 'improving' ? '#22c55e' : analysis.roas_trend === 'declining' ? '#ef4444' : '#71717a';

  return (
    <div style={{
      backgroundColor: '#18181b', border: '1px solid #27272a',
      borderRadius: '12px', overflow: 'hidden', opacity: isActive ? 1 : 0.6
    }}>
      {!isActive && (
        <div style={{
          padding: '4px 16px', display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: adset.status === 'DELETED' ? '#27272a' : '#450a0a',
          borderBottom: '1px solid #27272a'
        }}>
          <Power size={10} color={adset.status === 'DELETED' ? '#71717a' : '#fca5a5'} />
          <span style={{ fontSize: '10px', fontWeight: '700', color: adset.status === 'DELETED' ? '#71717a' : '#fca5a5', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {adset.status}
          </span>
        </div>
      )}

      <div onClick={handleExpand} style={{
        padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',
        borderBottom: expanded ? '1px solid #27272a' : 'none'
      }}>
        {expanded ? <ChevronDown size={14} color="#52525b" /> : <ChevronRight size={14} color="#52525b" />}
        <div style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: isActive ? '#22c55e' : adset.status === 'PAUSED' ? '#eab308' : '#71717a', flexShrink: 0
        }} />
        <span style={{
          fontSize: '13px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: isActive ? '#e4e4e7' : '#71717a'
        }}>
          {adset.entity_name || adset.entity_id}
        </span>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '9px', color: '#52525b', fontWeight: '600' }}>SPEND</div>
            <div style={{ fontSize: '12px', color: '#a1a1aa', fontWeight: '600' }}>{fmtK(m7.spend)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '9px', color: '#52525b', fontWeight: '600' }}>ROAS</div>
            <div style={{ fontSize: '13px', color: roasColor(roas7d), fontWeight: '800' }}>{fmt(roas7d)}x</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '9px', color: '#52525b', fontWeight: '600' }}>PURCH</div>
            <div style={{ fontSize: '12px', color: '#a1a1aa', fontWeight: '600' }}>{m7.purchases || 0}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '9px', color: '#52525b', fontWeight: '600' }}>BUDGET</div>
            <div style={{ fontSize: '12px', color: '#a1a1aa', fontWeight: '600' }}>${fmt(adset.daily_budget, 0)}/d</div>
          </div>
          <span style={{ fontSize: '14px', color: trendColor, fontWeight: '700' }}>{trendIcon}</span>
          {analysis.frequency_alert && <span style={{ fontSize: '9px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#451a03', color: '#fde68a' }}>FREQ</span>}
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '16px' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
            gap: '12px', padding: '14px 16px', marginBottom: '12px',
            backgroundColor: '#09090b', borderRadius: '10px', border: '1px solid #27272a'
          }}>
            {[
              { label: 'Budget/day', value: `$${fmt(adset.daily_budget, 0)}` },
              { label: 'Spend 7d', value: `$${fmt(m7.spend, 0)}` },
              { label: 'ROAS 7d', value: `${fmt(m7.roas)}x`, color: roasColor(m7.roas) },
              { label: 'ROAS 3d', value: `${fmt(m3.roas)}x`, color: roasColor(m3.roas) },
              { label: 'Today Spend', value: `$${fmt(mT.spend, 0)}` },
              { label: 'Today ROAS', value: `${fmt(mT.roas)}x`, color: roasColor(mT.roas) },
              { label: 'Purchases 7d', value: m7.purchases || 0 },
              { label: 'CPA 7d', value: `$${fmt(m7.cpa, 2)}` },
              { label: 'CTR 7d', value: `${fmt(m7.ctr, 2)}%` },
              { label: 'Frequency', value: fmt(m7.frequency, 2), color: freqColor(m7.frequency || 0) },
              { label: 'CPM', value: `$${fmt(m7.cpm, 2)}` },
              { label: 'CPC', value: `$${fmt(m7.cpc, 2)}` },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: '#52525b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{item.label}</span>
                <span style={{ fontSize: '14px', color: item.color || '#d4d4d8', fontWeight: '700' }}>{item.value}</span>
              </div>
            ))}
          </div>

          {(analysis.roas_trend || analysis.frequency_alert) && (
            <div style={{ padding: '8px 12px', backgroundColor: '#09090b', borderRadius: '8px', borderLeft: '3px solid #3b82f644', marginBottom: '10px', fontSize: '11px', color: '#a1a1aa' }}>
              <span style={{ color: trendColor, fontWeight: '700' }}>Trend: {analysis.roas_trend || 'stable'}</span>
              {analysis.roas_3d_vs_7d ? <span style={{ marginLeft: '12px' }}>3d vs 7d: {analysis.roas_3d_vs_7d > 0 ? '+' : ''}{fmt(analysis.roas_3d_vs_7d, 1)}%</span> : null}
              {analysis.frequency_alert && <span style={{ marginLeft: '12px', color: '#eab308' }}>Frequency alert</span>}
            </div>
          )}

          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: '700', color: '#52525b', textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '6px' }}>
              Ads {ads !== null && <span style={{ color: '#3f3f46' }}>({activeAds.length} active / {totalAds} total)</span>}
            </div>

            {loadingAds && <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: '#52525b' }}><RefreshCw size={12} className="spin" style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />Loading ads...</div>}

            {!loadingAds && ads !== null && (
              <>
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
                  {ads.map((ad, i) => <AdRow key={ad.entity_id || i} ad={ad} onAction={reloadAds} />)}
                </div>
                {ads.length === 0 && <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: '#3f3f46' }}>No ads</div>}
              </>
            )}

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
            <AddCreativePanel adsetId={adset.entity_id} onClose={() => setShowAddCreative(false)} onSuccess={reloadAds} />
          )}
        </div>
      )}
    </div>
  );
};

// ═══ MAIN PAGE ═══
export default function AdSetsManager() {
  const [adSets, setAdSets] = useState([]);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [adsetData, overviewData] = await Promise.all([
        getAllAdSets(),
        getAccountOverview().catch(() => null)
      ]);
      setAdSets(adsetData || []);
      setOverview(overviewData);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { await autoRefreshAIOps(); if (!cancelled) fetchData(); } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleAction = async (key, fn) => {
    setRunning(key);
    try { await fn(); await fetchData(); } catch (err) { setError(err.message); } finally { setRunning(null); }
  };

  const counts = useMemo(() => {
    const c = { active: 0, paused: 0, deleted: 0, total: adSets.length };
    for (const as of adSets) {
      if (as.status === 'ACTIVE') c.active++;
      else if (as.status === 'PAUSED') c.paused++;
      else c.deleted++;
    }
    return c;
  }, [adSets]);

  const totals = useMemo(() => {
    const active = adSets.filter(as => as.status === 'ACTIVE');
    const m7 = (as) => as.metrics?.last_7d || {};
    return {
      spend7d: active.reduce((s, as) => s + (m7(as).spend || 0), 0),
      purchases7d: active.reduce((s, as) => s + (m7(as).purchases || 0), 0),
      avgRoas: active.length > 0 ? active.reduce((s, as) => s + (m7(as).roas || 0), 0) / active.length : 0,
      totalBudget: active.reduce((s, as) => s + (as.daily_budget || 0), 0)
    };
  }, [adSets]);

  const filtered = useMemo(() => {
    let list = adSets;
    if (filter === 'active') list = list.filter(as => as.status === 'ACTIVE');
    else if (filter === 'paused') list = list.filter(as => as.status === 'PAUSED');
    else if (filter === 'off') list = list.filter(as => as.status !== 'ACTIVE' && as.status !== 'PAUSED');

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(as => (as.entity_name || '').toLowerCase().includes(q) || (as.entity_id || '').includes(q));
    }

    return [...list].sort((a, b) => {
      if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
      if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
      return ((b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));
    });
  }, [adSets, filter, search]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#09090b', color: '#71717a', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <RefreshCw size={18} className="spin" /><span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading ad sets...</span>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#09090b', minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
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
            <BarChart2 size={17} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '16px', fontWeight: '800', color: '#fafafa', margin: 0, letterSpacing: '-0.02em' }}>Ad Sets</h1>
            <span style={{ fontSize: '11px', color: '#52525b' }}>
              {counts.total} total &middot; {counts.active} active &middot; {counts.paused} paused
            </span>
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
              display: 'flex', alignItems: 'center', gap: '5px', opacity: running && running !== key ? 0.3 : 1
            }}>
              {running === key ? <RefreshCw size={12} className="spin" /> : <Icon size={12} />}{label}
            </button>
          ))}
          <button onClick={() => { setLoading(true); fetchData(); }} style={{
            padding: '7px', borderRadius: '8px', border: '1px solid #27272a',
            backgroundColor: '#18181b', color: '#52525b', cursor: 'pointer', display: 'flex', alignItems: 'center'
          }}><RefreshCw size={14} /></button>
          <button onClick={logout} title="Logout" style={{
            padding: '7px', borderRadius: '8px', border: '1px solid #27272a',
            backgroundColor: '#18181b', color: '#52525b', cursor: 'pointer', display: 'flex', alignItems: 'center'
          }}><LogOut size={14} /></button>
        </div>
      </div>

      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '20px 24px' }}>
        {error && (
          <div style={{ padding: '10px 14px', backgroundColor: '#450a0a', border: '1px solid #dc2626', borderRadius: '10px', marginBottom: '16px', color: '#fca5a5', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {error}
            <button onClick={() => { setLoading(true); fetchData(); }} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #dc2626', backgroundColor: '#7f1d1d', color: '#fca5a5', cursor: 'pointer', fontSize: '11px' }}>Retry</button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '20px' }}>
          {[
            { icon: Eye, color: '#22c55e', label: 'Active', value: counts.active, sub: `${counts.total} total` },
            { icon: Pause, color: '#eab308', label: 'Paused', value: counts.paused, sub: `${counts.deleted} off/deleted` },
            { icon: DollarSign, color: '#3b82f6', label: 'Spend 7d', value: fmtK(totals.spend7d), sub: `$${fmt(totals.totalBudget, 0)}/day budget` },
            { icon: TrendingUp, color: roasColor(totals.avgRoas), label: 'Avg ROAS 7d', value: `${fmt(totals.avgRoas)}x`, sub: 'active ad sets' },
            { icon: ShoppingCart, color: '#a78bfa', label: 'Purchases 7d', value: totals.purchases7d, sub: 'from active' },
          ].map(({ icon: Icon, color, label, value, sub }, i) => (
            <div key={i} style={{
              backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '10px',
              padding: '14px 16px', borderLeft: `3px solid ${color}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <Icon size={12} color={color} />
                <span style={{ fontSize: '10px', color: '#52525b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
              </div>
              <div style={{ fontSize: '22px', fontWeight: '800', color: '#fafafa', letterSpacing: '-0.02em' }}>{value}</div>
              <div style={{ fontSize: '11px', color: '#52525b', marginTop: '2px' }}>{sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '12px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 12px',
            backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px', flex: 1, maxWidth: '320px'
          }}>
            <Search size={13} color="#52525b" />
            <input type="text" placeholder="Search ad sets..." value={search} onChange={e => setSearch(e.target.value)} style={{
              background: 'none', border: 'none', outline: 'none', color: '#e4e4e7',
              fontSize: '12px', fontFamily: 'Inter, system-ui, sans-serif', width: '100%'
            }} />
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {[
              { value: 'active', label: 'Active', count: counts.active },
              { value: 'all', label: 'All', count: counts.total },
              { value: 'paused', label: 'Paused', count: counts.paused },
              { value: 'off', label: 'Deleted', count: counts.deleted }
            ].map(opt => (
              <button key={opt.value} onClick={() => setFilter(opt.value)} style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: '600',
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {filtered.map((as, i) => <AdSetCard key={as.entity_id || i} adset={as} onRefresh={fetchData} />)}
          {filtered.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center', color: '#3f3f46', fontSize: '13px', backgroundColor: '#18181b', borderRadius: '12px', border: '1px solid #27272a' }}>
              {search ? `No ad sets match "${search}"` : `No ${filter} ad sets`}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
      `}</style>
    </div>
  );
}
