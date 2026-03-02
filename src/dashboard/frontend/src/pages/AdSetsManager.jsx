import React, { useState, useEffect, useCallback, useMemo, Suspense, lazy } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain, Bot, CheckCircle,
  TrendingUp, TrendingDown, Minus,
  DollarSign, Eye, RefreshCw,
  ChevronDown, ChevronRight, Pause, Play,
  Power, Plus, Send, X, Trash2,
  LogOut, Search, ShoppingCart, BarChart3,
  Clock, Zap, AlertTriangle, ArrowUpDown,
  Calendar, Target, Activity, Lightbulb, Sparkles
} from 'lucide-react';
import {
  getAllAdSets, getAdsForAdSet, getAccountOverview,
  runAIManager, runAgents, refreshAIOpsMetrics,
  refreshLiveCache, connectSSE,
  pauseEntity, deleteEntity, getAvailableCreatives,
  addAdToAdSet, generateAdCopy, getCreativePreviewUrl, logout,
  getBrainRecommendations, getBrainInsights
} from '../api';

const AccountOrb = lazy(() => import('../components/AccountOrb'));

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

const isActiveStatus = (s) => s === 'ACTIVE';
const isPausedStatus = (s) => s === 'PAUSED' || s === 'ADSET_PAUSED' || s === 'CAMPAIGN_PAUSED';

const statusClass = (status) => {
  if (isActiveStatus(status)) return 'status-active';
  if (isPausedStatus(status)) return 'status-paused';
  if (status === 'DELETED' || status === 'ARCHIVED') return 'status-archived';
  if (status === 'PENDING_REVIEW' || status === 'IN_PROCESS') return 'status-pending';
  if (status === 'DISAPPROVED' || status === 'WITH_ISSUES') return 'status-error';
  return 'status-paused';
};

const statusLabel = (status) => {
  if (status === 'ADSET_PAUSED') return 'PAUSED';
  if (status === 'CAMPAIGN_PAUSED') return 'CAMP PAUSED';
  if (status === 'PENDING_REVIEW') return 'REVIEW';
  if (status === 'WITH_ISSUES') return 'ISSUES';
  if (status === 'IN_PROCESS') return 'PROCESSING';
  if (status === 'PENDING_BILLING_INFO') return 'BILLING';
  return status;
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

const AdSetDetail = ({ adset, timeWindow, onRefresh, brainRecs, brainInsights }) => {
  const [ads, setAds] = useState(null);
  const [loadingAds, setLoadingAds] = useState(true);
  const [showAddCreative, setShowAddCreative] = useState(false);

  const mT = adset.metrics?.today || {};
  const m3 = adset.metrics?.last_3d || {};
  const m7 = adset.metrics?.last_7d || {};
  const m14 = adset.metrics?.last_14d || {};
  const isActive = isActiveStatus(adset.status);
  const analysis = adset.analysis || {};

  // Brain data for this ad set
  const entityRecs = brainRecs || [];
  const entityInsights = brainInsights || [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAdsForAdSet(adset.entity_id);
        if (!cancelled) setAds(data || []);
      } catch { if (!cancelled) setAds([]); }
      finally { if (!cancelled) setLoadingAds(false); }
    })();
    return () => { cancelled = true; };
  }, [adset.entity_id]);

  const reloadAds = async () => {
    setLoadingAds(true);
    try {
      const data = await getAdsForAdSet(adset.entity_id);
      setAds(data || []);
    } catch { /* ignore */ }
    finally { setLoadingAds(false); }
    onRefresh?.();
  };

  const activeAds = (ads || []).filter(a => isActiveStatus(a.status)).length;
  const totalAds = (ads || []).length;

  const windows = [
    { key: 'today', label: 'Today', m: mT },
    { key: 'last_3d', label: '3d', m: m3 },
    { key: 'last_7d', label: '7d', m: m7 },
    { key: 'last_14d', label: '14d', m: m14 },
  ];

  return (
    <div className="adset-detail animate-fade-in">
      {/* Detail layout: two columns — metrics left, ads right */}
      <div className="detail-grid">

        {/* LEFT: Budget bar + Comparison table */}
        <div className="detail-left">
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
                <AlertTriangle size={12} /> High freq
              </div>
            )}
          </div>

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
                  <td className="comparison-label">Revenue</td>
                  {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtMoney(w.m.purchase_value)}</td>)}
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
                  <td className="comparison-label">Frequency</td>
                  {windows.map(w => <td key={w.key} className={`comparison-val ${freqColor(w.m.frequency)} ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmt(w.m.frequency, 2)}</td>)}
                </tr>
                <tr>
                  <td className="comparison-label">Reach</td>
                  {windows.map(w => <td key={w.key} className={`comparison-val ${w.key === timeWindow ? 'comparison-active' : ''}`}>{fmtInt(w.m.reach)}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT: Ads */}
        <div className="detail-right">
          <div className="ads-section">
            <div className="d-flex align-center justify-between mb-2">
              <h6 className="text-tertiary text-xs font-bold mb-0" style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Ads {ads !== null && <span className="text-muted">({activeAds} active / {totalAds})</span>}
              </h6>
            </div>

            {loadingAds && (
              <div className="d-flex align-center justify-center gap-2 p-3 text-muted text-sm">
                <div className="loading" /> Loading...
              </div>
            )}

            {!loadingAds && ads !== null && ads.length > 0 && (
              <div className="table-container" style={{ marginBottom: '8px' }}>
                <div className="table-wrapper">
                  <table className="table ads-table">
                    <thead>
                      <tr>
                        <th>Ad</th>
                        <th style={{ textAlign: 'right' }}>Spend</th>
                        <th style={{ textAlign: 'right' }}>ROAS</th>
                        <th style={{ textAlign: 'right' }}>Purch</th>
                        <th style={{ textAlign: 'right' }}>CPA</th>
                        <th style={{ textAlign: 'right' }}>CTR</th>
                        <th style={{ textAlign: 'right' }}>Freq</th>
                        <th style={{ textAlign: 'right', width: '70px' }}></th>
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
      </div>

      {/* Brain Intelligence Section */}
      {(entityRecs.length > 0 || entityInsights.length > 0) && (
        <div className="detail-brain-section">
          <div className="detail-brain-header">
            <Brain size={13} />
            <span>Brain Intelligence</span>
          </div>
          <div className="detail-brain-grid">
            {entityRecs.length > 0 && (
              <div className="detail-brain-col">
                <div className="detail-brain-col-title">
                  <Sparkles size={11} /> Recommendations ({entityRecs.length})
                </div>
                {entityRecs.map((rec, i) => {
                  const priorityColor = rec.priority === 'high' ? 'var(--red)' : rec.priority === 'medium' ? 'var(--yellow)' : 'var(--blue-light)';
                  return (
                    <div key={rec._id || i} className="detail-brain-rec">
                      <div className="detail-brain-rec-bar" style={{ backgroundColor: priorityColor }} />
                      <div className="detail-brain-rec-body">
                        <div className="detail-brain-rec-title">{rec.title}</div>
                        <div className="detail-brain-rec-meta">
                          <span className="detail-brain-rec-action">{rec.action_type?.replace(/_/g, ' ')}</span>
                          {rec.confidence_score && <span className="detail-brain-rec-conf">{rec.confidence_score}%</span>}
                          <span className={`detail-brain-rec-priority priority-${rec.priority}`}>{rec.priority}</span>
                        </div>
                        {rec.reasoning && <div className="detail-brain-rec-reason">{rec.reasoning}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {entityInsights.length > 0 && (
              <div className="detail-brain-col">
                <div className="detail-brain-col-title">
                  <Lightbulb size={11} /> Insights ({entityInsights.length})
                </div>
                {entityInsights.slice(0, 5).map((ins, i) => {
                  const sevColor = ins.severity === 'critical' ? 'var(--red)' : ins.severity === 'warning' ? 'var(--yellow)' : ins.severity === 'positive' ? 'var(--green)' : 'var(--blue-light)';
                  return (
                    <div key={ins._id || i} className="detail-brain-insight">
                      <div className="detail-brain-insight-dot" style={{ backgroundColor: sevColor }} />
                      <div className="detail-brain-insight-body">
                        <div className="detail-brain-insight-title">{ins.title}</div>
                        {ins.description && <div className="detail-brain-insight-desc">{ins.description}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ══════════════════════════════════════════
   MAIN AD SET ROW (in the table)
   ══════════════════════════════════════════ */

const AdSetRow = ({ adset, timeWindow, onRefresh, brainRecs, brainInsights }) => {
  const [expanded, setExpanded] = useState(false);

  const m = getMetrics(adset, timeWindow);
  const isActive = isActiveStatus(adset.status);
  const analysis = adset.analysis || {};

  const recCount = brainRecs?.length || 0;
  const insightCount = brainInsights?.length || 0;
  const hasHighPriority = brainRecs?.some(r => r.priority === 'high');
  const hasCriticalInsight = brainInsights?.some(i => i.severity === 'critical' || i.severity === 'warning');

  return (
    <>
      <tr onClick={() => setExpanded(!expanded)} className={`adset-row ${expanded ? 'expanded' : ''} ${!isActive ? 'inactive-row' : ''}`}>
        <td>
          <span className="d-inline-flex align-center gap-2">
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
            <span className={`badge badge-sm badge-dot badge-pill ${statusClass(adset.status)}`}>{statusLabel(adset.status)}</span>
          </span>
        </td>
        <td className="primary">
          <div className="adset-name-wrap">
            <div className="adset-name-cell">{adset.entity_name || adset.entity_id}</div>
            {(recCount > 0 || insightCount > 0) && (
              <span className="brain-badges">
                {recCount > 0 && (
                  <span className={`brain-badge brain-badge-rec ${hasHighPriority ? 'high' : ''}`} title={`${recCount} recommendation${recCount > 1 ? 's' : ''}`}>
                    <Sparkles size={9} />
                    <span>{recCount}</span>
                  </span>
                )}
                {insightCount > 0 && (
                  <span className={`brain-badge brain-badge-insight ${hasCriticalInsight ? 'warn' : ''}`} title={`${insightCount} insight${insightCount > 1 ? 's' : ''}`}>
                    <Lightbulb size={9} />
                    <span>{insightCount}</span>
                  </span>
                )}
              </span>
            )}
          </div>
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
            <AdSetDetail adset={adset} timeWindow={timeWindow} onRefresh={onRefresh}
              brainRecs={brainRecs} brainInsights={brainInsights} />
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
  const navigate = useNavigate();
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

  // Brain Intelligence data
  const [brainRecs, setBrainRecs] = useState([]);
  const [brainInsights, setBrainInsights] = useState([]);

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

  // Fetch Brain data (recommendations + insights) for entity badges
  useEffect(() => {
    const fetchBrainData = async () => {
      try {
        const [recsRes, insightsRes] = await Promise.allSettled([
          getBrainRecommendations(1, 100, 'pending'),
          getBrainInsights(1, 100, { read: false })
        ]);
        if (recsRes.status === 'fulfilled') setBrainRecs(recsRes.value?.recommendations || []);
        if (insightsRes.status === 'fulfilled') setBrainInsights(insightsRes.value?.insights || []);
      } catch { /* silent — Brain data is supplemental */ }
    };
    fetchBrainData();
    const brainInterval = setInterval(fetchBrainData, 120000);
    return () => clearInterval(brainInterval);
  }, []);

  // Maps: entity_id → [recs] and entity_id → [insights]
  const recsMap = useMemo(() => {
    const map = {};
    for (const rec of brainRecs) {
      const eid = rec.entity?.entity_id;
      if (eid) { (map[eid] = map[eid] || []).push(rec); }
    }
    return map;
  }, [brainRecs]);

  const insightsMap = useMemo(() => {
    const map = {};
    for (const ins of brainInsights) {
      const entities = ins.entities || [];
      for (const ent of entities) {
        const eid = ent.entity_id;
        if (eid) { (map[eid] = map[eid] || []).push(ins); }
      }
    }
    return map;
  }, [brainInsights]);

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
    const c = { active: 0, paused: 0, other: 0, total: adSets.length };
    for (const as of adSets) {
      if (isActiveStatus(as.status)) c.active++;
      else if (isPausedStatus(as.status)) c.paused++;
      else c.other++;
    }
    return c;
  }, [adSets]);

  const totals = useMemo(() => {
    const active = adSets.filter(as => isActiveStatus(as.status));
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

    if (filter === 'active') list = list.filter(as => isActiveStatus(as.status));
    else if (filter === 'paused') list = list.filter(as => isPausedStatus(as.status));
    else if (filter === 'off') list = list.filter(as => !isActiveStatus(as.status) && !isPausedStatus(as.status));

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
          <div className="header-orb-wrap">
            <Suspense fallback={<div className="header-orb-fallback"><BarChart3 size={18} color="#818cf8" /></div>}>
              <AccountOrb roas={totals.roas} roasTarget={KPI.roas_target} roasMinimum={KPI.roas_minimum} roasExcellent={KPI.roas_excellent} />
            </Suspense>
          </div>
          <div>
            <h1 className="mb-0" style={{ fontSize: '1.125rem' }}>Ad Sets Manager</h1>
            <span className="text-muted text-xs">
              {counts.total} ad sets &middot; {counts.active} active &middot; {counts.paused} paused
              {brainRecs.length > 0 && <span className="header-brain-count"> &middot; <Sparkles size={9} style={{ verticalAlign: 'middle' }} /> {brainRecs.length} recs</span>}
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
          <button onClick={() => navigate('/brain')}
            className="btn btn-sm btn-secondary" title="Brain Intelligence">
            <Brain size={13} /> Intel
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

        {/* KPI Summary Cards — Glassmorphism */}
        <div className="kpi-cards-v2">
          <div className="kpi-card-v2 kpi-card-active">
            <div className="kpi-card-v2-glow" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(16,185,129,0.12), transparent 70%)' }} />
            <div className="kpi-card-v2-header">
              <span className="kpi-card-v2-label">Active</span>
              <div className="kpi-card-v2-icon" style={{ background: 'rgba(16,185,129,0.15)', color: 'var(--green)' }}>
                <Eye size={14} />
              </div>
            </div>
            <div className="kpi-card-v2-value">{counts.active}</div>
            <div className="kpi-card-v2-sub">{counts.total} total &middot; {fmtMoney(totals.totalBudget)}/d budget</div>
          </div>

          <div className="kpi-card-v2 kpi-card-spend">
            <div className="kpi-card-v2-glow" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(59,130,246,0.12), transparent 70%)' }} />
            <div className="kpi-card-v2-header">
              <span className="kpi-card-v2-label">Spend {windowLabel}</span>
              <div className="kpi-card-v2-icon" style={{ background: 'rgba(59,130,246,0.15)', color: 'var(--blue-light)' }}>
                <DollarSign size={14} />
              </div>
            </div>
            <div className="kpi-card-v2-value">{fmtMoney(totals.spend)}</div>
            <div className="kpi-card-v2-sub">{fmtMoney(totals.revenue)} revenue</div>
          </div>

          <div className="kpi-card-v2 kpi-card-roas">
            <div className="kpi-card-v2-glow" style={{ background: `radial-gradient(circle at 30% 30%, ${totals.roas >= KPI.roas_target ? 'rgba(16,185,129,0.12)' : totals.roas >= KPI.roas_minimum ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)'}, transparent 70%)` }} />
            <div className="kpi-card-v2-header">
              <span className="kpi-card-v2-label">ROAS {windowLabel}</span>
              <div className="kpi-card-v2-icon" style={{ background: totals.roas >= KPI.roas_target ? 'rgba(16,185,129,0.15)' : totals.roas >= KPI.roas_minimum ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)', color: totals.roas >= KPI.roas_target ? 'var(--green)' : totals.roas >= KPI.roas_minimum ? 'var(--yellow)' : 'var(--red)' }}>
                <Target size={14} />
              </div>
            </div>
            <div className={`kpi-card-v2-value ${roasColor(totals.roas)}`}>{fmt(totals.roas)}x</div>
            <div className="kpi-card-v2-sub">target {KPI.roas_target}x</div>
            {/* Mini ROAS bar */}
            <div className="kpi-roas-bar">
              <div className="kpi-roas-bar-fill" style={{ width: `${Math.min((totals.roas / KPI.roas_excellent) * 100, 100)}%`, backgroundColor: totals.roas >= KPI.roas_target ? 'var(--green)' : totals.roas >= KPI.roas_minimum ? 'var(--yellow)' : 'var(--red)' }} />
              <div className="kpi-roas-bar-target" style={{ left: `${(KPI.roas_target / KPI.roas_excellent) * 100}%` }} />
            </div>
          </div>

          <div className="kpi-card-v2 kpi-card-purchases">
            <div className="kpi-card-v2-glow" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(99,102,241,0.12), transparent 70%)' }} />
            <div className="kpi-card-v2-header">
              <span className="kpi-card-v2-label">Purchases {windowLabel}</span>
              <div className="kpi-card-v2-icon" style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--blue-primary)' }}>
                <ShoppingCart size={14} />
              </div>
            </div>
            <div className="kpi-card-v2-value">{fmtInt(totals.purchases)}</div>
            <div className={`kpi-card-v2-sub ${cpaColor(totals.cpa)}`}>CPA: {fmtMoney(totals.cpa)}</div>
          </div>

          {/* Brain Summary mini-card */}
          <div className="kpi-card-v2 kpi-card-brain" onClick={() => navigate('/brain')}>
            <div className="kpi-card-v2-glow" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(139,92,246,0.15), transparent 70%)' }} />
            <div className="kpi-card-v2-header">
              <span className="kpi-card-v2-label">Brain Intel</span>
              <div className="kpi-card-v2-icon" style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}>
                <Brain size={14} />
              </div>
            </div>
            <div className="kpi-card-v2-value" style={{ fontSize: '1.1rem' }}>
              {brainRecs.length > 0 ? (
                <span className="d-inline-flex align-center gap-2">
                  <span>{brainRecs.length}</span>
                  <span className="kpi-brain-label">recs</span>
                  {brainInsights.length > 0 && <>
                    <span className="kpi-brain-sep">/</span>
                    <span>{brainInsights.length}</span>
                    <span className="kpi-brain-label">insights</span>
                  </>}
                </span>
              ) : (
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>No pending</span>
              )}
            </div>
            <div className="kpi-card-v2-sub" style={{ color: '#a78bfa' }}>View Intelligence →</div>
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
              { v: 'off', l: 'Off', c: counts.other },
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
                  <AdSetRow key={as.entity_id || i} adset={as} timeWindow={timeWindow} onRefresh={() => fetchData(true)}
                    brainRecs={recsMap[as.entity_id]} brainInsights={insightsMap[as.entity_id]} />
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

        /* Status badge extras */
        .status-pending { background-color: var(--blue-primary) !important; color: white !important; }
        .status-error { background-color: var(--red) !important; color: white !important; }

        /* ═══ HEADER ═══ */
        .manager-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 24px;
          border-bottom: 1px solid var(--border-color);
          position: sticky;
          top: 0;
          z-index: 100;
          background-color: rgba(17, 24, 39, 0.92);
          backdrop-filter: blur(12px);
        }
        .header-orb-wrap {
          width: 42px; height: 42px;
          flex-shrink: 0;
        }
        .header-orb-wrap .account-orb-wrap {
          width: 42px; height: 42px;
        }
        .header-orb-fallback {
          width: 42px; height: 42px;
          border-radius: 50%;
          background: linear-gradient(135deg, var(--blue-primary), #8b5cf6);
          display: flex; align-items: center; justify-content: center;
        }
        .account-orb-wrap {
          width: 100%; height: 100%;
        }
        .header-brain-count { color: #a78bfa; font-weight: 600; }
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

        /* ═══ CONTENT ═══ */
        .manager-content {
          max-width: 1600px;
          margin: 0 auto;
          padding: 20px 24px 40px;
        }

        /* ═══ KPI CARDS V2 — GLASSMORPHISM ═══ */
        .kpi-cards-v2 {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 14px;
          margin-bottom: 20px;
        }
        .kpi-card-v2 {
          position: relative;
          background: rgba(30, 41, 59, 0.5);
          border: 1px solid rgba(71, 85, 105, 0.35);
          border-radius: 14px;
          padding: 16px 18px;
          overflow: hidden;
          backdrop-filter: blur(10px);
          transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
        }
        .kpi-card-v2:hover {
          border-color: rgba(139, 92, 246, 0.3);
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
        }
        .kpi-card-v2-glow {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none;
        }
        .kpi-card-v2-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          position: relative;
        }
        .kpi-card-v2-label {
          font-size: 0.6875rem;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .kpi-card-v2-icon {
          width: 28px; height: 28px;
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
        }
        .kpi-card-v2-value {
          font-size: 1.4rem;
          font-weight: 800;
          color: var(--text-primary);
          line-height: 1.1;
          margin-bottom: 4px;
          position: relative;
        }
        .kpi-card-v2-sub {
          font-size: 0.6875rem;
          color: var(--text-muted);
          position: relative;
        }

        /* ROAS progress bar */
        .kpi-roas-bar {
          position: relative;
          height: 3px;
          background: rgba(55, 65, 81, 0.5);
          border-radius: 2px;
          margin-top: 8px;
          overflow: visible;
        }
        .kpi-roas-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.6s ease;
        }
        .kpi-roas-bar-target {
          position: absolute;
          top: -2px;
          width: 2px; height: 7px;
          background: var(--text-muted);
          border-radius: 1px;
          opacity: 0.5;
        }

        /* Brain KPI card */
        .kpi-card-brain { cursor: pointer; }
        .kpi-card-brain:hover { border-color: rgba(139, 92, 246, 0.5); }
        .kpi-brain-label { font-size: 0.65rem; color: var(--text-muted); font-weight: 500; }
        .kpi-brain-sep { color: var(--text-muted); opacity: 0.4; }

        /* ═══ BRAIN BADGES ON ROWS ═══ */
        .adset-name-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .brain-badges {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }
        .brain-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 6px;
          border-radius: 10px;
          font-size: 0.5625rem;
          font-weight: 700;
          line-height: 1;
          white-space: nowrap;
        }
        .brain-badge-rec {
          background: rgba(139, 92, 246, 0.15);
          color: #a78bfa;
          border: 1px solid rgba(139, 92, 246, 0.25);
        }
        .brain-badge-rec.high {
          background: rgba(239, 68, 68, 0.12);
          color: #f87171;
          border-color: rgba(239, 68, 68, 0.25);
          animation: badge-pulse 2.5s ease-in-out infinite;
        }
        .brain-badge-insight {
          background: rgba(59, 130, 246, 0.12);
          color: #60a5fa;
          border: 1px solid rgba(59, 130, 246, 0.2);
        }
        .brain-badge-insight.warn {
          background: rgba(245, 158, 11, 0.12);
          color: #fbbf24;
          border-color: rgba(245, 158, 11, 0.25);
        }
        @keyframes badge-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }

        /* ═══ TOOLBAR ═══ */
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

        /* ═══ TABLE ═══ */
        .adsets-table { font-size: 0.8125rem; }
        .adsets-table thead th { white-space: nowrap; }
        .adsets-table .adset-row { cursor: pointer; }
        .adsets-table .adset-row:hover { background-color: var(--bg-hover); }
        .adsets-table .adset-row.expanded { background-color: var(--bg-tertiary); }
        .adsets-table .adset-row.inactive-row { opacity: 0.5; }
        .adsets-table .adset-row.inactive-row:hover { opacity: 0.7; }
        .adset-name-cell {
          max-width: 240px;
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

        /* ═══ DETAIL (EXPANDED) ═══ */
        .adset-detail {
          padding: 16px 24px 20px;
          border-top: 1px solid var(--border-color);
        }
        .detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
          gap: 20px;
        }
        .detail-left { min-width: 0; }
        .detail-right { min-width: 0; }

        .detail-comparison { overflow-x: auto; }
        .comparison-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.75rem;
        }
        .comparison-table th {
          padding: 6px 14px;
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
          padding: 4px 14px;
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

        .detail-info-bar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 8px 12px;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          margin-bottom: 12px;
          font-size: 0.6875rem;
          flex-wrap: wrap;
        }
        .detail-info-item {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .detail-info-label {
          color: var(--text-muted);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          font-size: 0.5625rem;
        }
        .detail-info-value {
          color: var(--text-primary);
          font-weight: 600;
        }

        .ads-section { margin-top: 0; }
        .ads-table { font-size: 0.75rem; }

        /* ═══ BRAIN SECTION IN DETAIL ═══ */
        .detail-brain-section {
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid rgba(139, 92, 246, 0.15);
        }
        .detail-brain-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.6875rem;
          font-weight: 700;
          color: #a78bfa;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 10px;
        }
        .detail-brain-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }
        .detail-brain-col-title {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.625rem;
          font-weight: 700;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 8px;
        }

        /* Rec cards in detail */
        .detail-brain-rec {
          display: flex;
          gap: 8px;
          padding: 8px 10px;
          background: rgba(139, 92, 246, 0.06);
          border: 1px solid rgba(139, 92, 246, 0.12);
          border-radius: 8px;
          margin-bottom: 6px;
        }
        .detail-brain-rec-bar {
          width: 3px;
          border-radius: 2px;
          flex-shrink: 0;
        }
        .detail-brain-rec-body { flex: 1; min-width: 0; }
        .detail-brain-rec-title {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 3px;
        }
        .detail-brain-rec-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.625rem;
          flex-wrap: wrap;
        }
        .detail-brain-rec-action {
          background: rgba(99, 102, 241, 0.12);
          color: var(--blue-light);
          padding: 1px 6px;
          border-radius: 4px;
          font-weight: 600;
          text-transform: capitalize;
        }
        .detail-brain-rec-conf {
          color: var(--green);
          font-weight: 700;
        }
        .detail-brain-rec-priority {
          font-weight: 700;
          text-transform: uppercase;
          font-size: 0.5625rem;
        }
        .detail-brain-rec-priority.priority-high { color: var(--red); }
        .detail-brain-rec-priority.priority-medium { color: var(--yellow); }
        .detail-brain-rec-priority.priority-low { color: var(--blue-light); }
        .detail-brain-rec-reason {
          font-size: 0.6875rem;
          color: var(--text-muted);
          margin-top: 4px;
          line-height: 1.35;
        }

        /* Insight cards in detail */
        .detail-brain-insight {
          display: flex;
          gap: 8px;
          padding: 6px 10px;
          background: rgba(59, 130, 246, 0.05);
          border: 1px solid rgba(59, 130, 246, 0.1);
          border-radius: 8px;
          margin-bottom: 5px;
        }
        .detail-brain-insight-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          margin-top: 5px;
          flex-shrink: 0;
        }
        .detail-brain-insight-body { flex: 1; min-width: 0; }
        .detail-brain-insight-title {
          font-size: 0.725rem;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 2px;
        }
        .detail-brain-insight-desc {
          font-size: 0.6875rem;
          color: var(--text-muted);
          line-height: 1.3;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* ═══ CREATIVE PANEL ═══ */
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

        /* ═══ KPI LEGEND ═══ */
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

        /* ═══ RESPONSIVE ═══ */
        @media (max-width: 1200px) {
          .detail-grid { grid-template-columns: 1fr; }
          .detail-brain-grid { grid-template-columns: 1fr; }
          .kpi-cards-v2 { grid-template-columns: repeat(3, 1fr); }
        }
        @media (max-width: 1024px) {
          .manager-header { padding: 12px 16px; flex-wrap: wrap; gap: 8px; }
          .manager-content { padding: 16px; }
          .toolbar { flex-direction: column; align-items: stretch; }
          .search-box { max-width: none; }
          .kpi-cards-v2 { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 640px) {
          .kpi-cards-v2 { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
