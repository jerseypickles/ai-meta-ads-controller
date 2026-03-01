import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain, Bot, CheckCircle,
  TrendingUp, TrendingDown, Minus,
  DollarSign, Eye, RefreshCw,
  ChevronDown, ChevronRight, Pause, Play,
  Power, Plus, Send, X, Trash2,
  LogOut, Search, ShoppingCart, BarChart3,
  Clock, Zap, AlertTriangle, ArrowUpDown
} from 'lucide-react';
import {
  getAllAdSets, getAdsForAdSet, getAccountOverview,
  runAIManager, runAgents, refreshAIOpsMetrics,
  refreshLiveCache,
  pauseEntity, deleteEntity, getAvailableCreatives,
  addAdToAdSet, generateAdCopy, getCreativePreviewUrl, logout
} from '../api';

/* ══════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════ */

const fmt = (v, d = 2) => (v != null && !isNaN(v)) ? Number(v).toFixed(d) : '—';
const fmtMoney = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (v >= 10000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${Number(v).toFixed(0)}`;
};
const fmtPct = (v) => (v != null && !isNaN(v)) ? `${Number(v).toFixed(2)}%` : '—';

const statusClass = (status) => {
  if (status === 'ACTIVE') return 'status-active';
  if (status === 'PAUSED') return 'status-paused';
  if (status === 'DELETED' || status === 'ARCHIVED') return 'status-archived';
  return 'status-paused';
};

const roasClass = (roas) => {
  const v = roas || 0;
  if (v >= 3) return 'text-success';
  if (v >= 1.5) return 'text-warning';
  return 'text-danger';
};

const TrendIcon = ({ trend }) => {
  if (trend === 'improving') return <TrendingUp size={13} className="text-success" />;
  if (trend === 'declining') return <TrendingDown size={13} className="text-danger" />;
  return <Minus size={13} className="text-muted" />;
};

/* ══════════════════════════════════════════
   AD ROW (inside expanded ad set)
   ══════════════════════════════════════════ */

const AdRow = ({ ad, onAction }) => {
  const [busy, setBusy] = useState(null);
  const [removed, setRemoved] = useState(false);
  const m = ad.metrics?.last_7d || {};

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
      <td className={`numeric font-bold ${roasClass(m.roas)}`}>{fmt(m.roas)}x</td>
      <td className="numeric">{m.purchases || 0}</td>
      <td className="numeric">{fmtPct(m.ctr)}</td>
      <td className="numeric">{fmt(m.frequency, 1)}</td>
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

const AdSetDetail = ({ adset, onRefresh }) => {
  const [ads, setAds] = useState(null);
  const [loadingAds, setLoadingAds] = useState(true);
  const [showAddCreative, setShowAddCreative] = useState(false);

  const m7 = adset.metrics?.last_7d || {};
  const m3 = adset.metrics?.last_3d || {};
  const mT = adset.metrics?.today || {};
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

  const kpis = [
    { label: 'Budget/day', value: fmtMoney(adset.daily_budget) },
    { label: 'Today Spend', value: fmtMoney(mT.spend) },
    { label: 'Today ROAS', value: `${fmt(mT.roas)}x`, cls: roasClass(mT.roas) },
    { label: 'Spend 3d', value: fmtMoney(m3.spend) },
    { label: 'ROAS 3d', value: `${fmt(m3.roas)}x`, cls: roasClass(m3.roas) },
    { label: 'Spend 7d', value: fmtMoney(m7.spend) },
    { label: 'ROAS 7d', value: `${fmt(m7.roas)}x`, cls: roasClass(m7.roas) },
    { label: 'Spend 14d', value: fmtMoney(m14.spend) },
    { label: 'ROAS 14d', value: `${fmt(m14.roas)}x`, cls: roasClass(m14.roas) },
    { label: 'Purchases 7d', value: m7.purchases || 0 },
    { label: 'CPA 7d', value: fmtMoney(m7.cpa) },
    { label: 'CTR 7d', value: fmtPct(m7.ctr) },
    { label: 'CPM 7d', value: fmtMoney(m7.cpm) },
    { label: 'CPC 7d', value: fmtMoney(m7.cpc) },
    { label: 'Frequency', value: fmt(m7.frequency, 2), cls: (m7.frequency || 0) > 4 ? 'text-danger' : (m7.frequency || 0) > 3 ? 'text-warning' : '' },
    { label: 'Reach 7d', value: (m7.reach || 0).toLocaleString() },
  ];

  return (
    <div className="adset-detail animate-fade-in">
      {/* KPI Grid */}
      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div key={i} className="kpi-cell">
            <div className="kpi-label">{k.label}</div>
            <div className={`kpi-value ${k.cls || ''}`}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Analysis bar */}
      {(analysis.roas_trend || analysis.frequency_alert) && (
        <div className="analysis-bar">
          <span className="d-inline-flex align-center gap-1">
            <TrendIcon trend={analysis.roas_trend} />
            <span className="font-semibold">{analysis.roas_trend || 'stable'}</span>
          </span>
          {analysis.roas_3d_vs_7d ? (
            <span className="text-tertiary">3d/7d ratio: {fmt(analysis.roas_3d_vs_7d, 2)}</span>
          ) : null}
          {analysis.frequency_alert && (
            <span className="d-inline-flex align-center gap-1 text-warning">
              <AlertTriangle size={12} /> High frequency
            </span>
          )}
        </div>
      )}

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
                    <th style={{ textAlign: 'right' }}>Spend 7d</th>
                    <th style={{ textAlign: 'right' }}>ROAS 7d</th>
                    <th style={{ textAlign: 'right' }}>Purch</th>
                    <th style={{ textAlign: 'right' }}>CTR</th>
                    <th style={{ textAlign: 'right' }}>Freq</th>
                    <th style={{ textAlign: 'right', width: '80px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map((ad, i) => <AdRow key={ad.entity_id || i} ad={ad} onAction={reloadAds} />)}
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

const AdSetRow = ({ adset, onRefresh }) => {
  const [expanded, setExpanded] = useState(false);

  const m7 = adset.metrics?.last_7d || {};
  const mT = adset.metrics?.today || {};
  const isActive = adset.status === 'ACTIVE';
  const analysis = adset.analysis || {};

  return (
    <>
      <tr onClick={() => setExpanded(!expanded)} className={`adset-row ${expanded ? 'expanded' : ''} ${!isActive ? 'opacity-50' : ''}`}>
        <td>
          <span className="d-inline-flex align-center gap-2">
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
            <span className={`badge badge-sm badge-dot badge-pill ${statusClass(adset.status)}`}>{adset.status}</span>
          </span>
        </td>
        <td className="primary">
          <span className="adset-name-cell">{adset.entity_name || adset.entity_id}</span>
        </td>
        <td className="numeric">{fmtMoney(adset.daily_budget)}/d</td>
        <td className="numeric">{fmtMoney(mT.spend)}</td>
        <td className={`numeric font-bold ${roasClass(mT.roas)}`}>{fmt(mT.roas)}x</td>
        <td className="numeric">{fmtMoney(m7.spend)}</td>
        <td className={`numeric font-bold ${roasClass(m7.roas)}`}>{fmt(m7.roas)}x</td>
        <td className="numeric">{m7.purchases || 0}</td>
        <td className="numeric">{fmtPct(m7.ctr)}</td>
        <td className="numeric">{fmt(m7.frequency, 1)}</td>
        <td className="text-center">
          <TrendIcon trend={analysis.roas_trend} />
        </td>
      </tr>
      {expanded && (
        <tr className="adset-detail-row">
          <td colSpan="11" style={{ padding: 0 }}>
            <AdSetDetail adset={adset} onRefresh={onRefresh} />
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
  const [sortBy, setSortBy] = useState('spend_7d');
  const [sortAsc, setSortAsc] = useState(false);
  const [fetchMeta, setFetchMeta] = useState(null); // { cached, fetched_at, age_seconds }

  const fetchData = useCallback(async (force = false) => {
    try {
      setError(null);
      const result = await getAllAdSets(force);
      setAdSets(result.adsets || result || []);
      setFetchMeta({ cached: result.cached, fetched_at: result.fetched_at, age_seconds: result.age_seconds, fallback: result.fallback });
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to fetch data');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(), 120000); // Auto-refresh every 2 min
    return () => clearInterval(interval);
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
    const m7 = (as) => as.metrics?.last_7d || {};
    const mT = (as) => as.metrics?.today || {};
    const totalSpend7d = active.reduce((s, as) => s + (m7(as).spend || 0), 0);
    const totalRev7d = active.reduce((s, as) => s + (m7(as).purchase_value || 0), 0);
    return {
      spend7d: totalSpend7d,
      revenue7d: totalRev7d,
      roas7d: totalSpend7d > 0 ? totalRev7d / totalSpend7d : 0,
      purchases7d: active.reduce((s, as) => s + (m7(as).purchases || 0), 0),
      spendToday: active.reduce((s, as) => s + (mT(as).spend || 0), 0),
      totalBudget: active.reduce((s, as) => s + (as.daily_budget || 0), 0)
    };
  }, [adSets]);

  const filtered = useMemo(() => {
    let list = adSets;

    // Status filter
    if (filter === 'active') list = list.filter(as => as.status === 'ACTIVE');
    else if (filter === 'paused') list = list.filter(as => as.status === 'PAUSED');
    else if (filter === 'off') list = list.filter(as => as.status !== 'ACTIVE' && as.status !== 'PAUSED');

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(as => (as.entity_name || '').toLowerCase().includes(q) || (as.entity_id || '').includes(q));
    }

    // Sort
    const getSortVal = (as) => {
      const m7 = as.metrics?.last_7d || {};
      const mT = as.metrics?.today || {};
      switch (sortBy) {
        case 'name': return (as.entity_name || '').toLowerCase();
        case 'status': return as.status;
        case 'budget': return as.daily_budget || 0;
        case 'spend_today': return mT.spend || 0;
        case 'roas_today': return mT.roas || 0;
        case 'spend_7d': return m7.spend || 0;
        case 'roas_7d': return m7.roas || 0;
        case 'purchases': return m7.purchases || 0;
        case 'ctr': return m7.ctr || 0;
        case 'frequency': return m7.frequency || 0;
        default: return m7.spend || 0;
      }
    };

    return [...list].sort((a, b) => {
      const va = getSortVal(a);
      const vb = getSortVal(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return sortAsc ? cmp : -cmp;
    });
  }, [adSets, filter, search, sortBy, sortAsc]);

  // ── Render ──

  if (loading) {
    return (
      <div className="d-flex align-center justify-center" style={{ height: '100vh', gap: '12px' }}>
        <div className="loading" />
        <span className="text-muted text-sm">Fetching ad sets from Meta API...</span>
      </div>
    );
  }

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
              {fetchMeta && (
                <span className="fetch-meta">
                  {fetchMeta.cached ? ` · cached (${fetchMeta.age_seconds}s ago)` : ' · live'}
                  {fetchMeta.fallback && ' · snapshot fallback'}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="d-flex align-center gap-2">
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
            {running === 'refresh' ? <RefreshCw size={13} className="loading-spin" /> : <Zap size={13} />} Live Refresh
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

        {/* KPI Summary */}
        <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          {[
            { icon: Eye, label: 'Active Ad Sets', value: counts.active, sub: `${counts.total} total`, color: '--green' },
            { icon: DollarSign, label: 'Today Spend', value: fmtMoney(totals.spendToday), sub: `${fmtMoney(totals.totalBudget)}/day budget`, color: '--blue-primary' },
            { icon: TrendingUp, label: 'ROAS 7d', value: `${fmt(totals.roas7d)}x`, sub: `${fmtMoney(totals.revenue7d)} revenue`, color: totals.roas7d >= 2 ? '--green' : totals.roas7d >= 1 ? '--yellow' : '--red' },
            { icon: DollarSign, label: 'Spend 7d', value: fmtMoney(totals.spend7d), sub: `across ${counts.active} active`, color: '--blue-light' },
            { icon: ShoppingCart, label: 'Purchases 7d', value: totals.purchases7d, sub: 'total conversions', color: '--blue-primary' },
          ].map(({ icon: Icon, label, value, sub, color }, i) => (
            <div key={i} className="metric-card">
              <div className="metric-header">
                <span className="metric-label">{label}</span>
                <div className="metric-icon" style={{ color: `var(${color})` }}><Icon size={18} /></div>
              </div>
              <div className="metric-value">{value}</div>
              <span className="text-muted text-xs">{sub}</span>
            </div>
          ))}
        </div>

        {/* Toolbar: Search + Filters */}
        <div className="toolbar">
          <div className="search-box">
            <Search size={14} />
            <input type="text" placeholder="Search ad sets..." value={search} onChange={e => setSearch(e.target.value)} />
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
                  <SortHeader col="name">Ad Set Name</SortHeader>
                  <SortHeader col="budget" align="right">Budget</SortHeader>
                  <SortHeader col="spend_today" align="right">Spend Today</SortHeader>
                  <SortHeader col="roas_today" align="right">ROAS Today</SortHeader>
                  <SortHeader col="spend_7d" align="right">Spend 7d</SortHeader>
                  <SortHeader col="roas_7d" align="right">ROAS 7d</SortHeader>
                  <SortHeader col="purchases" align="right">Purch 7d</SortHeader>
                  <SortHeader col="ctr" align="right">CTR</SortHeader>
                  <SortHeader col="frequency" align="right">Freq</SortHeader>
                  <th style={{ textAlign: 'center', width: '50px' }}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((as, i) => (
                  <AdSetRow key={as.entity_id || i} adset={as} onRefresh={() => fetchData(true)} />
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
      </div>

      {/* ── Scoped Styles ── */}
      <style>{`
        .adsets-manager {
          min-height: 100vh;
          background-color: var(--bg-primary);
        }

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

        /* Content */
        .manager-content {
          max-width: 1600px;
          margin: 0 auto;
          padding: 20px 24px 40px;
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
        .search-box:focus-within {
          border-color: var(--blue-primary);
        }
        .search-box input {
          background: none;
          border: none;
          outline: none;
          color: var(--text-primary);
          font-family: var(--font-family);
          font-size: 0.875rem;
          width: 100%;
        }
        .search-box input::placeholder { color: var(--text-muted); }
        .search-box svg { color: var(--text-muted); flex-shrink: 0; }

        /* Ad Sets Table */
        .adsets-table { font-size: 0.8125rem; }
        .adsets-table thead th { white-space: nowrap; }
        .adsets-table .adset-row { cursor: pointer; }
        .adsets-table .adset-row:hover { background-color: var(--bg-hover); }
        .adsets-table .adset-row.expanded { background-color: var(--bg-tertiary); }
        .adset-name-cell {
          max-width: 280px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: inline-block;
          vertical-align: middle;
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

        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 1px;
          background-color: var(--border-color);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          overflow: hidden;
          margin-bottom: 16px;
        }
        .kpi-cell {
          background-color: var(--bg-secondary);
          padding: 10px 14px;
        }
        .kpi-label {
          font-size: 0.625rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted);
          margin-bottom: 4px;
        }
        .kpi-value {
          font-size: 0.9375rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .analysis-bar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 8px 14px;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          margin-bottom: 16px;
          font-size: 0.8125rem;
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
        }
        @media (max-width: 640px) {
          .metrics-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
