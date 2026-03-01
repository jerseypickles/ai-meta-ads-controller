import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain, Bot, CheckCircle,
  TrendingUp, TrendingDown, Minus,
  DollarSign, Eye, RefreshCw,
  ChevronDown, ChevronRight, Pause, Play,
  Power, Plus, Send, X, Trash2,
  LogOut, Search, ShoppingCart, BarChart3,
  Clock, Zap, AlertTriangle, ArrowUpDown,
  Calendar, Target
} from 'lucide-react';
import {
  getAllAdSets, getAdsForAdSet, getAccountOverview,
  runAIManager, runAgents, refreshAIOpsMetrics,
  refreshLiveCache, connectSSE,
  pauseEntity, deleteEntity, getAvailableCreatives,
  addAdToAdSet, generateAdCopy, getCreativePreviewUrl, logout
} from '../api';

/* ══════════════════════════════════════════
   KPI TARGETS (mirror of config/kpi-targets.js)
   ══════════════════════════════════════════ */

const KPI = {
  roas_excellent: 5.0,
  roas_target: 3.0,
  roas_minimum: 1.5,
  cpa_target: 25.00,
  cpa_maximum: 50.00,
  ctr_minimum: 1.0,
  ctr_low: 0.5,
  frequency_warning: 2.5,
  frequency_critical: 4.0,
  cpm_benchmark: 15.00,
};

/* ══════════════════════════════════════════
   TIME WINDOWS
   ══════════════════════════════════════════ */

const TIME_WINDOWS = [
  { key: 'today', label: 'Today', short: '1d' },
  { key: 'last_7d', label: '7 Days', short: '7d' },
  { key: 'last_14d', label: '14 Days', short: '14d' },
];

/* ══════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════ */

const fmt = (v, d = 2) => (v != null && !isNaN(v)) ? Number(v).toFixed(d) : '—';
const fmtMoney = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (v >= 10000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${Number(v).toFixed(2)}`;
};
const fmtInt = (v) => (v != null && !isNaN(v)) ? Number(v).toLocaleString() : '—';
const fmtPct = (v) => (v != null && !isNaN(v)) ? `${Number(v).toFixed(2)}%` : '—';

const statusClass = (status) => {
  if (status === 'ACTIVE') return 'status-active';
  if (status === 'PAUSED') return 'status-paused';
  if (status === 'DELETED' || status === 'ARCHIVED') return 'status-archived';
  return 'status-paused';
};

// ── Color functions based on KPI targets ──

const roasColor = (roas) => {
  const v = roas || 0;
  if (v >= KPI.roas_target) return 'kpi-good';
  if (v >= KPI.roas_minimum) return 'kpi-warn';
  if (v > 0) return 'kpi-bad';
  return 'kpi-neutral';
};

const ctrColor = (ctr) => {
  const v = ctr || 0;
  if (v >= KPI.ctr_minimum) return 'kpi-good';
  if (v >= KPI.ctr_low) return 'kpi-warn';
  if (v > 0) return 'kpi-bad';
  return 'kpi-neutral';
};

const freqColor = (freq) => {
  const v = freq || 0;
  if (v === 0) return 'kpi-neutral';
  if (v >= KPI.frequency_critical) return 'kpi-bad';
  if (v >= KPI.frequency_warning) return 'kpi-warn';
  return 'kpi-good';
};

const cpaColor = (cpa) => {
  const v = cpa || 0;
  if (v === 0) return 'kpi-neutral';
  if (v <= KPI.cpa_target) return 'kpi-good';
  if (v <= KPI.cpa_maximum) return 'kpi-warn';
  return 'kpi-bad';
};

const cpmColor = (cpm) => {
  const v = cpm || 0;
  if (v === 0) return 'kpi-neutral';
  if (v <= KPI.cpm_benchmark) return 'kpi-good';
  if (v <= KPI.cpm_benchmark * 1.5) return 'kpi-warn';
  return 'kpi-bad';
};

const TrendIcon = ({ trend }) => {
  if (trend === 'improving') return <TrendingUp size={13} className="kpi-good" />;
  if (trend === 'declining') return <TrendingDown size={13} className="kpi-bad" />;
  return <Minus size={13} className="text-muted" />;
};

/** Get metrics for the selected time window */
const getMetrics = (adset, window) => adset.metrics?.[window] || {};

/* ══════════════════════════════════════════
   AD ROW (inside expanded ad set)
   ══════════════════════════════════════════ */

const AdRow = ({ ad, timeWindow, onAction }) => {
  const [busy, setBusy] = useState(null);
  const [removed, setRemoved] = useState(false);
  const m = ad.metrics?.[timeWindow] || ad.metrics?.last_7d || {};

  const handlePause = async (e) => {
    e.stopPropagation();
    if (!confirm(`Pause ad "${ad.entity_name}"?`)) return;
    setBusy('pause');
    try {
      await pauseEntity(ad.entity_id, { entity_type: 'ad', entity_name: ad.entity_name, reason: 'Manual pause' });
      setRemoved(true);
      onAction?.();
    } catch (err) { alert(err.response?.data?.error || err.message); }
    finally { setBusy(null); }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirm(`DELETE "${ad.entity_name}"? This cannot be undone.`)) return;
    setBusy('delete');
    try {
      await deleteEntity(ad.entity_id, { entity_type: 'ad', entity_name: ad.entity_name, reason: 'Manual delete' });
      setRemoved(true);
      onAction?.();
    } catch (err) { alert(err.response?.data?.error || err.message); }
    finally { setBusy(null); }
  };

  if (removed) return null;
  const isActive = ad.status === 'ACTIVE';

  return (
    <tr className={!isActive ? 'opacity-50' : ''}>
      <td className="primary">
        <span className="d-inline-flex align-center gap-2">
          {isActive
            ? <Play size={10} style={{ color: 'var(--green)', fill: 'var(--green)' }} />
            : <Pause size={10} style={{ color: 'var(--red)' }} />}
          <span className="ad-name-cell">{ad.entity_name || ad.entity_id}</span>
        </span>
      </td>
      <td className="numeric">{fmtMoney(m.spend)}</td>
      <td className={`numeric font-bold ${roasColor(m.roas)}`}>{fmt(m.roas)}x</td>
      <td className="numeric">{m.purchases || 0}</td>
      <td className={`numeric ${cpaColor(m.cpa)}`}>{fmtMoney(m.cpa)}</td>
      <td className={`numeric ${ctrColor(m.ctr)}`}>{fmtPct(m.ctr)}</td>
      <td className={`numeric ${freqColor(m.frequency)}`}>{fmt(m.frequency, 1)}</td>
      <td className="numeric">
        <span className="d-inline-flex gap-1">
          {isActive && (
            <button onClick={handlePause} disabled={busy} className="btn btn-ghost btn-icon btn-sm"
              title="Pause" style={{ color: 'var(--yellow)' }}>
              {busy === 'pause' ? <RefreshCw size={12} className="loading-spin" /> : <Pause size={12} />}
            </button>
          )}
          <button onClick={handleDelete} disabled={busy} className="btn btn-ghost btn-icon btn-sm"
            title="Delete" style={{ color: 'var(--red)' }}>
            {busy === 'delete' ? <RefreshCw size={12} className="loading-spin" /> : <Trash2 size={12} />}
          </button>
        </span>
      </td>
    </tr>
  );
};

/* ══════════════════════════════════════════
   ADD CREATIVE PANEL
   ══════════════════════════════════════════ */

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
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
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
    } catch (err) { setError(err.message); }
    finally { setGeneratingCopy(false); }
  };

  const handleCreate = async () => {
    if (!selected || !generatedCopy) return;
    setCreating(true); setError(null);
    try {
      const hl = generatedCopy.headlines[selectedVariant];
      const bd = generatedCopy.bodies[selectedVariant];
      const res = await addAdToAdSet(adsetId, selected, hl, bd);
      setResult(res.result || res);
      onSuccess?.();
    } catch (err) { setError(err.message); }
    finally { setCreating(false); }
  };

  return (
    <div className="card" style={{ borderColor: 'rgba(16,185,129,0.2)', marginTop: '12px' }}>
      <div className="card-header" style={{ paddingBottom: '8px', marginBottom: '12px' }}>
        <div className="d-flex align-center gap-2">
          <Plus size={14} style={{ color: 'var(--green)' }} />
          <span className="font-bold text-sm" style={{ color: 'var(--green)' }}>
            {!generatedCopy ? 'SELECT CREATIVE' : 'REVIEW COPY'}
          </span>
          {generatedCopy && (
            <button onClick={() => { setGeneratedCopy(null); setError(null); }} className="btn btn-secondary btn-sm">Back</button>
          )}
        </div>
        <button onClick={onClose} className="btn btn-ghost btn-icon"><X size={16} /></button>
      </div>

      {loading && <p className="text-muted text-sm">Loading creatives...</p>}
      {error && <div className="alert alert-danger" style={{ padding: '8px 12px', fontSize: '13px' }}>{error}</div>}
      {result && <div className="alert alert-success" style={{ padding: '8px 12px', fontSize: '13px' }}><CheckCircle size={14} style={{ marginRight: '6px' }} />{result.ads_created} ad(s) created</div>}

      {!result && !loading && !generatedCopy && (
        <>
          <div className="creative-grid">
            {availableAssets.map(asset => (
              <div key={asset._id} onClick={() => setSelected(asset._id)}
                className={`creative-thumb ${selected === asset._id ? 'selected' : ''}`}>
                <div className="creative-thumb-img">
                  <img src={getCreativePreviewUrl(asset.filename)} alt=""
                    onError={(e) => { e.target.style.display = 'none'; }} />
                </div>
                <div className="creative-thumb-name">{asset.original_name}</div>
              </div>
            ))}
            {availableAssets.length === 0 && <p className="text-muted text-sm" style={{ gridColumn: '1/-1', textAlign: 'center', padding: '20px 0' }}>No available creatives</p>}
          </div>
          {selected && (
            <button onClick={handleGenerateCopy} disabled={generatingCopy} className="btn btn-primary w-full" style={{ marginTop: '12px' }}>
              {generatingCopy ? <><RefreshCw size={14} className="loading-spin" /> Generating...</> : <><Brain size={14} /> Generate Ad Copy</>}
            </button>
          )}
        </>
      )}

      {!result && generatedCopy && (
        <>
          {selectedAsset && (
            <div className="d-flex align-center gap-3 mb-3" style={{ padding: '8px', backgroundColor: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)' }}>
              <img src={getCreativePreviewUrl(selectedAsset.filename)} alt="" style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '6px' }}
                onError={(e) => { e.target.style.display = 'none'; }} />
              <span className="font-semibold text-sm">{selectedAsset.original_name}</span>
            </div>
          )}
          <div className="d-flex flex-column gap-2 mb-3">
            {generatedCopy.headlines.map((headline, i) => (
              <div key={i} onClick={() => setSelectedVariant(i)}
                className={`copy-variant ${selectedVariant === i ? 'selected' : ''}`}>
                <div className="font-bold text-sm">{headline}</div>
                <div className="text-sm text-tertiary" style={{ marginTop: '4px' }}>{generatedCopy.bodies[i] || ''}</div>
              </div>
            ))}
          </div>
          <button onClick={handleCreate} disabled={creating} className="btn btn-success w-full">
            {creating ? <><RefreshCw size={14} className="loading-spin" /> Creating...</> : <><Send size={14} /> Create Ad</>}
          </button>
        </>
      )}
    </div>
  );
};

/* ══════════════════════════════════════════
   EXPANDED AD SET DETAIL
   ══════════════════════════════════════════ */

const AdSetDetail = ({ adset, timeWindow, onRefresh }) => {
  const [ads, setAds] = useState(null);
  const [loadingAds, setLoadingAds] = useState(true);
  const [showAddCreative, setShowAddCreative] = useState(false);

  const mT = adset.metrics?.today || {};
  const m3 = adset.metrics?.last_3d || {};
  const m7 = adset.metrics?.last_7d || {};
  const m14 = adset.metrics?.last_14d || {};
  const isActive = adset.status === 'ACTIVE';
  const analysis = adset.analysis || {};

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAdsForAdSet(adset.entity_id);
        if (!cancelled) setAds((data || []).filter(a => a.status === 'ACTIVE' || a.status === 'PAUSED'));
      } catch { if (!cancelled) setAds([]); }
      finally { if (!cancelled) setLoadingAds(false); }
    })();
    return () => { cancelled = true; };
  }, [adset.entity_id]);

  const reloadAds = async () => {
    setLoadingAds(true);
    try {
      const data = await getAdsForAdSet(adset.entity_id);
      setAds((data || []).filter(a => a.status === 'ACTIVE' || a.status === 'PAUSED'));
    } catch { /* ignore */ }
    finally { setLoadingAds(false); }
    onRefresh?.();
  };

  const activeAds = (ads || []).filter(a => a.status === 'ACTIVE').length;
  const totalAds = (ads || []).length;

  const windows = [
    { key: 'today', label: 'Today', m: mT },
    { key: 'last_3d', label: '3d', m: m3 },
    { key: 'last_7d', label: '7d', m: m7 },
    { key: 'last_14d', label: '14d', m: m14 },
  ];

  return (
    <div className="adset-detail animate-fade-in">
      {/* Multi-window comparison table */}
      <div className="detail-comparison">
        <table className="comparison-table">
          <thead>
            <tr>
              <th></th>
              {windows.map(w => (
                <th key={w.key} className={w.key === timeWindow ? 'comparison-active' : ''}>{w.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="comparison-label">Spend</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.spend)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">ROAS</td>
              {windows.map(w => <td key={w.key} className={`comparison-val font-bold ${roasColor(w.m.roas)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmt(w.m.roas)}x</td>)}
            </tr>
            <tr>
              <td className="comparison-label">Purchases</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{w.m.purchases || 0}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">Revenue</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.purchase_value)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">CPA</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${cpaColor(w.m.cpa)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.cpa)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">CTR</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${ctrColor(w.m.ctr)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtPct(w.m.ctr)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">CPM</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${cpmColor(w.m.cpm)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.cpm)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">CPC</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.cpc)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">Frequency</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${freqColor(w.m.frequency)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmt(w.m.frequency, 2)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">Reach</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtInt(w.m.reach)}</td>)}
            </tr>
            <tr>
              <td className="comparison-label">Impressions</td>
              {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtInt(w.m.impressions)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Budget + Analysis bar */}
      <div className="detail-info-bar">
        <div className="detail-info-item">
          <span className="detail-info-label">Budget</span>
          <span className="detail-info-value">{fmtMoney(adset.daily_budget)}/day</span>
        </div>
        {adset.optimization_goal && (
          <div className="detail-info-item">
            <span className="detail-info-label">Goal</span>
            <span className="detail-info-value">{adset.optimization_goal.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
        )}
        {adset.bid_strategy && (
          <div className="detail-info-item">
            <span className="detail-info-label">Bid</span>
            <span className="detail-info-value">{adset.bid_strategy.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
        )}
        <div className="detail-info-item">
          <span className="detail-info-label">Trend</span>
          <span className="detail-info-value d-inline-flex align-center gap-1">
            <TrendIcon trend={analysis.roas_trend} />
            <span>{analysis.roas_trend || 'stable'}</span>
          </span>
        </div>
        {analysis.frequency_alert && (
          <div className="detail-info-item kpi-warn">
            <AlertTriangle size={12} /> High frequency
          </div>
        )}
      </div>

      {/* Ads Table */}
      <div className="ads-section">
        <div className="d-flex align-center justify-between mb-2">
          <h6 className="text-tertiary text-xs font-bold mb-0" style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Ads {ads !== null && <span className="text-muted">({activeAds} active / {totalAds} total)</span>}
          </h6>
        </div>

        {loadingAds && (
          <div className="d-flex align-center justify-center gap-2 p-4 text-muted text-sm">
            <div className="loading" /> Loading ads from Meta...
          </div>
        )}

        {!loadingAds && ads !== null && ads.length > 0 && (
          <div className="table-container" style={{ marginBottom: '8px' }}>
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ad Name</th>
                    <th style={{ textAlign: 'right' }}>Spend</th>
                    <th style={{ textAlign: 'right' }}>ROAS</th>
                    <th style={{ textAlign: 'right' }}>Purch</th>
                    <th style={{ textAlign: 'right' }}>CPA</th>
                    <th style={{ textAlign: 'right' }}>CTR</th>
                    <th style={{ textAlign: 'right' }}>Freq</th>
                    <th style={{ textAlign: 'right', width: '80px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map((ad, i) => <AdRow key={ad.entity_id || i} ad={ad} timeWindow={timeWindow} onAction={reloadAds} />)}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loadingAds && ads !== null && ads.length === 0 && (
          <p className="text-muted text-sm text-center p-3">No ads in this ad set</p>
        )}

        {isActive && !showAddCreative && (
          <button onClick={() => setShowAddCreative(true)} className="btn btn-secondary w-full btn-sm" style={{ borderStyle: 'dashed' }}>
            <Plus size={14} /> Add Creative
          </button>
        )}
      </div>

      {showAddCreative && (
        <AddCreativePanel adsetId={adset.entity_id} onClose={() => setShowAddCreative(false)} onSuccess={reloadAds} />
      )}
    </div>
  );
};

/* ══════════════════════════════════════════
   MAIN AD SET ROW (in the table)
   ══════════════════════════════════════════ */

const AdSetRow = ({ adset, timeWindow, onRefresh }) => {
  const [expanded, setExpanded] = useState(false);

  const m = getMetrics(adset, timeWindow);
  const isActive = adset.status === 'ACTIVE';
  const analysis = adset.analysis || {};

  return (
    <>
      <tr onClick={() => setExpanded(!expanded)} className={`adset-row ${expanded ? 'expanded' : ''} ${!isActive ? 'inactive-row' : ''}`}>
        <td>
          <span className="d-inline-flex align-center gap-2">
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
            <span className={`badge badge-sm badge-dot badge-pill ${statusClass(adset.status)}`}>{adset.status}</span>
          </span>
        </td>
        <td className="primary">
          <div className="adset-name-cell">{adset.entity_name || adset.entity_id}</div>
          {adset.campaign_name && <div className="campaign-label">{adset.campaign_name}</div>}
        </td>
        <td className="numeric">{fmtMoney(adset.daily_budget)}</td>
        <td className="numeric">{fmtMoney(m.spend)}</td>
        <td className={`numeric font-bold ${roasColor(m.roas)}`}>{fmt(m.roas)}x</td>
        <td className="numeric">{m.purchases || 0}</td>
        <td className={`numeric ${cpaColor(m.cpa)}`}>{fmtMoney(m.cpa)}</td>
        <td className={`numeric ${ctrColor(m.ctr)}`}>{fmtPct(m.ctr)}</td>
        <td className={`numeric ${cpmColor(m.cpm)}`}>{fmtMoney(m.cpm)}</td>
        <td className={`numeric ${freqColor(m.frequency)}`}>{fmt(m.frequency, 1)}</td>
        <td className="text-center">
          <TrendIcon trend={analysis.roas_trend} />
        </td>
      </tr>
      {expanded && (
        <tr className="adset-detail-row">
          <td colSpan="11" style={{ padding: 0 }}>
            <AdSetDetail adset={adset} timeWindow={timeWindow} onRefresh={onRefresh} />
          </td>
        </tr>
      )}
    </>
  );
};

/* ══════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════ */

export default function AdSetsManager() {
  const [adSets, setAdSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('spend');
  const [sortAsc, setSortAsc] = useState(false);
  const [timeWindow, setTimeWindow] = useState('last_7d');
  const [fetchMeta, setFetchMeta] = useState(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchData = useCallback(async (force = false) => {
    try {
      setError(null);
      const result = await getAllAdSets(force);
      setAdSets(result.adsets || result || []);
      setFetchMeta({ cached: result.cached, fetched_at: result.fetched_at, age_seconds: result.age_seconds, fallback: result.fallback });
      setLastUpdate(new Date());
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to fetch data');
    } finally { setLoading(false); }
  }, []);

  // SSE connection for real-time push updates
  useEffect(() => {
    fetchData();
    const es = connectSSE(
      (data) => {
        setAdSets(data.adsets || []);
        setFetchMeta({ cached: data.cached, fetched_at: data.fetched_at, age_seconds: data.age_seconds, fallback: data.fallback });
        setLastUpdate(new Date());
        setLoading(false);
        setSseConnected(true);
      },
      () => { setSseConnected(false); }
    );
    es.onopen = () => setSseConnected(true);
    const fallbackInterval = setInterval(() => {
      if (!sseConnected) fetchData();
    }, 60000);
    return () => { es.close(); clearInterval(fallbackInterval); setSseConnected(false); };
  }, [fetchData]);

  const handleForceRefresh = async () => {
    setRunning('refresh');
    try {
      await refreshLiveCache();
      await fetchData(true);
    } catch (err) { setError(err.message); }
    finally { setRunning(null); }
  };

  const handleAction = async (key, fn) => {
    setRunning(key);
    try { await fn(); await fetchData(true); }
    catch (err) { setError(err.message); }
    finally { setRunning(null); }
  };

  const handleSort = (col) => {
    if (sortBy === col) { setSortAsc(!sortAsc); }
    else { setSortBy(col); setSortAsc(false); }
  };

  // ── Computed ──

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
    const mw = (as) => getMetrics(as, timeWindow);
    const totalSpend = active.reduce((s, as) => s + (mw(as).spend || 0), 0);
    const totalRev = active.reduce((s, as) => s + (mw(as).purchase_value || 0), 0);
    const totalPurchases = active.reduce((s, as) => s + (mw(as).purchases || 0), 0);
    return {
      spend: totalSpend,
      revenue: totalRev,
      roas: totalSpend > 0 ? totalRev / totalSpend : 0,
      purchases: totalPurchases,
      cpa: totalPurchases > 0 ? totalSpend / totalPurchases : 0,
      totalBudget: active.reduce((s, as) => s + (as.daily_budget || 0), 0)
    };
  }, [adSets, timeWindow]);

  const filtered = useMemo(() => {
    let list = adSets;

    if (filter === 'active') list = list.filter(as => as.status === 'ACTIVE');
    else if (filter === 'paused') list = list.filter(as => as.status === 'PAUSED');
    else if (filter === 'off') list = list.filter(as => as.status !== 'ACTIVE' && as.status !== 'PAUSED');

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(as =>
        (as.entity_name || '').toLowerCase().includes(q) ||
        (as.entity_id || '').includes(q) ||
        (as.campaign_name || '').toLowerCase().includes(q)
      );
    }

    const getSortVal = (as) => {
      const m = getMetrics(as, timeWindow);
      switch (sortBy) {
        case 'name': return (as.entity_name || '').toLowerCase();
        case 'status': return as.status;
        case 'budget': return as.daily_budget || 0;
        case 'spend': return m.spend || 0;
        case 'roas': return m.roas || 0;
        case 'purchases': return m.purchases || 0;
        case 'cpa': return m.cpa || 0;
        case 'ctr': return m.ctr || 0;
        case 'cpm': return m.cpm || 0;
        case 'frequency': return m.frequency || 0;
        default: return m.spend || 0;
      }
    };

    return [...list].sort((a, b) => {
      const va = getSortVal(a);
      const vb = getSortVal(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return sortAsc ? cmp : -cmp;
    });
  }, [adSets, filter, search, sortBy, sortAsc, timeWindow]);

  // ── Render ──

  if (loading) {
    return (
      <div className="d-flex align-center justify-center" style={{ height: '100vh', gap: '12px' }}>
        <div className="loading" />
        <span className="text-muted text-sm">Fetching ad sets from Meta API...</span>
      </div>
    );
  }

  const windowLabel = TIME_WINDOWS.find(w => w.key === timeWindow)?.short || '7d';

  const SortHeader = ({ col, children, align }) => (
    <th className="sortable" style={{ textAlign: align || 'left' }} onClick={() => handleSort(col)}>
      <span className="d-inline-flex align-center gap-1">
        {children}
        {sortBy === col && <ArrowUpDown size={10} style={{ opacity: 0.6 }} />}
      </span>
    </th>
  );

  return (
    <div className="adsets-manager">
      {/* ── Header ── */}
      <header className="manager-header">
        <div className="d-flex align-center gap-3">
          <div className="header-logo">
            <BarChart3 size={18} color="#fff" />
          </div>
          <div>
            <h1 className="mb-0" style={{ fontSize: '1.125rem' }}>Ad Sets Manager</h1>
            <span className="text-muted text-xs">
              {counts.total} ad sets &middot; {counts.active} active &middot; {counts.paused} paused
              <span className="fetch-meta">
                {sseConnected ? (
                  <span className="sse-live"> &middot; <span className="live-dot" /> LIVE</span>
                ) : (
                  <span> &middot; polling</span>
                )}
                {fetchMeta?.fallback && ' · snapshot'}
              </span>
            </span>
          </div>
        </div>
        <div className="d-flex align-center gap-2">
          {/* Time Window Selector */}
          <div className="time-selector">
            {TIME_WINDOWS.map(w => (
              <button key={w.key} onClick={() => setTimeWindow(w.key)}
                className={`time-btn ${timeWindow === w.key ? 'active' : ''}`}>
                {w.short}
              </button>
            ))}
          </div>
          <div className="header-divider" />
          <button onClick={() => handleAction('manager', runAIManager)} disabled={running != null}
            className={`btn btn-sm ${running === 'manager' ? 'btn-primary' : 'btn-secondary'}`}>
            {running === 'manager' ? <RefreshCw size={13} className="loading-spin" /> : <Bot size={13} />} Manager
          </button>
          <button onClick={() => handleAction('brain', runAgents)} disabled={running != null}
            className={`btn btn-sm ${running === 'brain' ? 'btn-primary' : 'btn-secondary'}`}>
            {running === 'brain' ? <RefreshCw size={13} className="loading-spin" /> : <Brain size={13} />} Brain
          </button>
          <div className="header-divider" />
          <button onClick={handleForceRefresh} disabled={running != null}
            className={`btn btn-sm ${running === 'refresh' ? 'btn-success' : 'btn-secondary'}`}
            title="Force refresh from Meta API">
            {running === 'refresh' ? <RefreshCw size={13} className="loading-spin" /> : <Zap size={13} />}
          </button>
          <button onClick={logout} title="Logout" className="btn btn-ghost btn-icon btn-sm">
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {/* ── Content ── */}
      <div className="manager-content">

        {/* Error */}
        {error && (
          <div className="alert alert-danger mb-4">
            <AlertTriangle size={16} />
            <div className="flex-1">{error}</div>
            <button onClick={() => { setLoading(true); fetchData(true); }} className="btn btn-danger btn-sm">Retry</button>
          </div>
        )}

        {/* KPI Summary Cards */}
        <div className="kpi-cards">
          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-card-label">Active</span>
              <Eye size={16} className="kpi-card-icon" style={{ color: 'var(--green)' }} />
            </div>
            <div className="kpi-card-value">{counts.active}</div>
            <div className="kpi-card-sub">{counts.total} total &middot; {fmtMoney(totals.totalBudget)}/d budget</div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-card-label">Spend {windowLabel}</span>
              <DollarSign size={16} className="kpi-card-icon" style={{ color: 'var(--blue-light)' }} />
            </div>
            <div className="kpi-card-value">{fmtMoney(totals.spend)}</div>
            <div className="kpi-card-sub">{fmtMoney(totals.revenue)} revenue</div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-card-label">ROAS {windowLabel}</span>
              <Target size={16} className="kpi-card-icon" style={{ color: totals.roas >= KPI.roas_target ? 'var(--green)' : totals.roas >= KPI.roas_minimum ? 'var(--yellow)' : 'var(--red)' }} />
            </div>
            <div className={`kpi-card-value ${roasColor(totals.roas)}`}>{fmt(totals.roas)}x</div>
            <div className="kpi-card-sub">target {KPI.roas_target}x</div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-card-label">Purchases {windowLabel}</span>
              <ShoppingCart size={16} className="kpi-card-icon" style={{ color: 'var(--blue-primary)' }} />
            </div>
            <div className="kpi-card-value">{fmtInt(totals.purchases)}</div>
            <div className={`kpi-card-sub ${cpaColor(totals.cpa)}`}>CPA: {fmtMoney(totals.cpa)}</div>
          </div>
        </div>

        {/* Toolbar: Search + Filters */}
        <div className="toolbar">
          <div className="search-box">
            <Search size={14} />
            <input type="text" placeholder="Search ad sets or campaigns..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="d-flex gap-1">
            {[
              { v: 'active', l: 'Active', c: counts.active },
              { v: 'all', l: 'All', c: counts.total },
              { v: 'paused', l: 'Paused', c: counts.paused },
              { v: 'off', l: 'Off', c: counts.deleted },
            ].map(f => (
              <button key={f.v} onClick={() => setFilter(f.v)}
                className={`btn btn-sm ${filter === f.v ? 'btn-primary' : 'btn-ghost'}`}>
                {f.l} ({f.c})
              </button>
            ))}
          </div>
        </div>

        {/* Ad Sets Table */}
        <div className="table-container">
          <div className="table-wrapper">
            <table className="table adsets-table">
              <thead>
                <tr>
                  <SortHeader col="status">Status</SortHeader>
                  <SortHeader col="name">Ad Set</SortHeader>
                  <SortHeader col="budget" align="right">Budget/d</SortHeader>
                  <SortHeader col="spend" align="right">Spend {windowLabel}</SortHeader>
                  <SortHeader col="roas" align="right">ROAS</SortHeader>
                  <SortHeader col="purchases" align="right">Purch</SortHeader>
                  <SortHeader col="cpa" align="right">CPA</SortHeader>
                  <SortHeader col="ctr" align="right">CTR</SortHeader>
                  <SortHeader col="cpm" align="right">CPM</SortHeader>
                  <SortHeader col="frequency" align="right">Freq</SortHeader>
                  <th style={{ textAlign: 'center', width: '50px' }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((as, i) => (
                  <AdSetRow key={as.entity_id || i} adset={as} timeWindow={timeWindow} onRefresh={() => fetchData(true)} />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="d-flex align-center justify-center p-5 text-muted text-sm">
              {search ? `No ad sets match "${search}"` : `No ${filter} ad sets`}
            </div>
          )}
        </div>

        {/* KPI Legend */}
        <div className="kpi-legend">
          <span className="kpi-legend-title">KPI Targets:</span>
          <span>ROAS: <span className="kpi-good">{KPI.roas_target}x+</span> <span className="kpi-warn">{KPI.roas_minimum}x</span> <span className="kpi-bad">&lt;{KPI.roas_minimum}x</span></span>
          <span className="kpi-legend-sep">&middot;</span>
          <span>CTR: <span className="kpi-good">{KPI.ctr_minimum}%+</span> <span className="kpi-bad">&lt;{KPI.ctr_low}%</span></span>
          <span className="kpi-legend-sep">&middot;</span>
          <span>CPA: <span className="kpi-good">&lt;${KPI.cpa_target}</span> <span className="kpi-bad">&gt;${KPI.cpa_maximum}</span></span>
          <span className="kpi-legend-sep">&middot;</span>
          <span>Freq: <span className="kpi-warn">{KPI.frequency_warning}</span> <span className="kpi-bad">{KPI.frequency_critical}+</span></span>
        </div>
      </div>

      {/* ── Scoped Styles ── */}
      <style>{`
        .adsets-manager {
          min-height: 100vh;
          background-color: var(--bg-primary);
        }

        /* KPI color classes */
        .kpi-good { color: var(--green); }
        .kpi-warn { color: var(--yellow); }
        .kpi-bad { color: var(--red); }
        .kpi-neutral { color: var(--text-muted); }

        /* Header */
        .manager-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 24px;
          border-bottom: 1px solid var(--border-color);
          position: sticky;
          top: 0;
          z-index: 100;
          background-color: var(--bg-primary);
          backdrop-filter: blur(8px);
        }
        .header-logo {
          width: 36px; height: 36px;
          border-radius: var(--radius-md);
          background: linear-gradient(135deg, var(--blue-primary), #8b5cf6);
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .header-divider {
          width: 1px; height: 24px;
          background-color: var(--border-color);
          margin: 0 4px;
        }
        .fetch-meta { opacity: 0.6; }
        .sse-live { color: var(--green); font-weight: 600; opacity: 1; }
        .live-dot {
          display: inline-block;
          width: 7px; height: 7px;
          background: var(--green);
          border-radius: 50%;
          margin-right: 3px;
          vertical-align: middle;
          animation: pulse-dot 2s ease-in-out infinite;
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,185,129,0.4); }
          50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(16,185,129,0); }
        }

        /* Time Window Selector */
        .time-selector {
          display: flex;
          background-color: var(--bg-tertiary);
          border-radius: var(--radius-md);
          padding: 2px;
          gap: 2px;
        }
        .time-btn {
          background: none;
          border: none;
          color: var(--text-muted);
          font-family: var(--font-family);
          font-size: 0.6875rem;
          font-weight: 600;
          padding: 4px 12px;
          border-radius: calc(var(--radius-md) - 2px);
          cursor: pointer;
          transition: all var(--transition-fast);
          letter-spacing: 0.02em;
        }
        .time-btn:hover { color: var(--text-primary); }
        .time-btn.active {
          background-color: var(--blue-primary);
          color: white;
        }

        /* Content */
        .manager-content {
          max-width: 1600px;
          margin: 0 auto;
          padding: 20px 24px 40px;
        }

        /* KPI Cards */
        .kpi-cards {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          margin-bottom: 20px;
        }
        .kpi-card {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-lg);
          padding: 16px 20px;
          transition: border-color var(--transition-fast);
        }
        .kpi-card:hover { border-color: var(--border-light); }
        .kpi-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .kpi-card-label {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .kpi-card-icon { opacity: 0.8; }
        .kpi-card-value {
          font-size: 1.5rem;
          font-weight: 800;
          color: var(--text-primary);
          line-height: 1.1;
          margin-bottom: 4px;
        }
        .kpi-card-sub {
          font-size: 0.6875rem;
          color: var(--text-muted);
        }

        /* Toolbar */
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 16px;
        }
        .search-box {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          flex: 1;
          max-width: 360px;
          transition: border-color var(--transition-fast);
        }
        .search-box:focus-within { border-color: var(--blue-primary); }
        .search-box input {
          background: none; border: none; outline: none;
          color: var(--text-primary);
          font-family: var(--font-family);
          font-size: 0.875rem; width: 100%;
        }
        .search-box input::placeholder { color: var(--text-muted); }
        .search-box svg { color: var(--text-muted); flex-shrink: 0; }

        /* Ad Sets Table */
        .adsets-table { font-size: 0.8125rem; }
        .adsets-table thead th { white-space: nowrap; }
        .adsets-table .adset-row { cursor: pointer; }
        .adsets-table .adset-row:hover { background-color: var(--bg-hover); }
        .adsets-table .adset-row.expanded { background-color: var(--bg-tertiary); }
        .adsets-table .adset-row.inactive-row { opacity: 0.5; }
        .adsets-table .adset-row.inactive-row:hover { opacity: 0.7; }
        .adset-name-cell {
          max-width: 280px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: block;
        }
        .campaign-label {
          font-size: 0.625rem;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 280px;
          margin-top: 1px;
        }
        .ad-name-cell {
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: inline-block;
          vertical-align: middle;
        }
        .adset-detail-row td {
          background-color: var(--bg-primary) !important;
        }
        .adset-detail-row:hover td {
          background-color: var(--bg-primary) !important;
        }

        /* Ad Set Detail (expanded) */
        .adset-detail {
          padding: 20px 24px;
          border-top: 1px solid var(--border-color);
        }

        /* Comparison table in detail */
        .detail-comparison {
          margin-bottom: 16px;
          overflow-x: auto;
        }
        .comparison-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.75rem;
        }
        .comparison-table th {
          padding: 6px 16px;
          text-align: right;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-size: 0.625rem;
          border-bottom: 1px solid var(--border-color);
        }
        .comparison-table th:first-child { text-align: left; }
        .comparison-table th.comparison-active {
          color: var(--blue-light);
          background-color: rgba(59, 130, 246, 0.05);
        }
        .comparison-table td {
          padding: 5px 16px;
          border-bottom: 1px solid rgba(55, 65, 81, 0.3);
        }
        .comparison-label {
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.03em;
          font-size: 0.625rem;
        }
        .comparison-val {
          text-align: right;
          font-variant-numeric: tabular-nums;
          color: var(--text-secondary);
        }
        .comparison-val.comparison-active {
          background-color: rgba(59, 130, 246, 0.05);
          color: var(--text-primary);
          font-weight: 600;
        }

        /* Detail info bar */
        .detail-info-bar {
          display: flex;
          align-items: center;
          gap: 20px;
          padding: 8px 14px;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          margin-bottom: 16px;
          font-size: 0.75rem;
          flex-wrap: wrap;
        }
        .detail-info-item {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .detail-info-label {
          color: var(--text-muted);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          font-size: 0.625rem;
        }
        .detail-info-value {
          color: var(--text-primary);
          font-weight: 600;
        }

        .ads-section { margin-top: 4px; }

        /* Creative panel */
        .creative-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 10px;
          max-height: 280px;
          overflow-y: auto;
          margin-bottom: 12px;
        }
        .creative-thumb {
          border: 2px solid var(--border-color);
          border-radius: var(--radius-md);
          overflow: hidden;
          cursor: pointer;
          transition: border-color var(--transition-fast);
        }
        .creative-thumb.selected { border-color: var(--green); }
        .creative-thumb:hover { border-color: var(--border-light); }
        .creative-thumb-img {
          width: 100%; height: 100px;
          background-color: var(--bg-tertiary);
          overflow: hidden;
        }
        .creative-thumb-img img {
          width: 100%; height: 100%;
          object-fit: cover;
        }
        .creative-thumb-name {
          padding: 6px 8px;
          font-size: 0.6875rem;
          color: var(--text-secondary);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .copy-variant {
          padding: 12px 14px;
          border: 2px solid var(--border-color);
          border-radius: var(--radius-md);
          cursor: pointer;
          transition: border-color var(--transition-fast);
        }
        .copy-variant.selected { border-color: var(--green); background-color: rgba(16,185,129,0.05); }
        .copy-variant:hover { border-color: var(--border-light); }

        /* KPI Legend */
        .kpi-legend {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 16px;
          padding: 8px 14px;
          font-size: 0.6875rem;
          color: var(--text-muted);
          flex-wrap: wrap;
        }
        .kpi-legend-title { font-weight: 700; }
        .kpi-legend-sep { opacity: 0.3; }

        /* Loading spinner */
        .loading-spin {
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Responsive */
        @media (max-width: 1024px) {
          .manager-header { padding: 12px 16px; flex-wrap: wrap; gap: 8px; }
          .manager-content { padding: 16px; }
          .toolbar { flex-direction: column; align-items: stretch; }
          .search-box { max-width: none; }
          .kpi-cards { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 640px) {
          .kpi-cards { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
