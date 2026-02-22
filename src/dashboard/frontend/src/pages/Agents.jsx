import React, { useCallback, useEffect, useState, useMemo, Component } from 'react';
import {
  Bot,
  Brain,
  Image,
  Loader,
  Power,
  RefreshCw,
  TrendingUp,
  X,
  Zap,
  Eye,
  ChevronDown,
  ChevronRight,
  Play,
  Sparkles,
  ExternalLink,
  AlertTriangle,
  Clock,
  Activity,
  Settings
} from 'lucide-react';

// Error boundary
class AgentsErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', textAlign: 'center', color: '#ef4444', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <div style={{ fontSize: '16px', fontWeight: '700', marginBottom: '8px' }}>Error en Centro IA</div>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>{String(this.state.error?.message || this.state.error)}</div>
          <button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', backgroundColor: '#1e3a8a', color: '#93c5fd', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

import {
  getAgentReports,
  getPendingRecommendations,
  approveRecommendation,
  rejectRecommendation,
  executeRecommendation,
  runAgents,
  getAutonomyConfig,
  updateAutonomyConfig,
  getControlsStatus,
  toggleAI,
  getCooldowns,
  clearCooldowns,
  getAICreations,
  getImpactData,
  getCreativeAssets,
  getCreativePreviewUrl
} from '../api';

const ACTION_LABELS = {
  scale_up: { label: 'Subir Budget', color: '#10b981', icon: '\u2191' },
  scale_down: { label: 'Bajar Budget', color: '#f59e0b', icon: '\u2193' },
  pause: { label: 'Pausar', color: '#ef4444', icon: '\u23F8' },
  reactivate: { label: 'Reactivar', color: '#3b82f6', icon: '\u25B6' },
  duplicate_adset: { label: 'Duplicar Ad Set', color: '#8b5cf6', icon: '\u29C9' },
  create_ad: { label: 'Crear Ad', color: '#ec4899', icon: '+' },
  update_bid_strategy: { label: 'Cambiar Bid', color: '#06b6d4', icon: '\u26A1' },
  update_ad_status: { label: 'Status Ad', color: '#ef4444', icon: '\u25C9' },
  move_budget: { label: 'Mover Budget', color: '#f97316', icon: '\u21C4' },
  update_ad_creative: { label: 'Actualizar Creative', color: '#ec4899', icon: '\uD83C\uDFA8' },
  no_action: { label: 'Sin Accion', color: '#6b7280', icon: '\u2014' }
};

const PRIORITY_CONFIG = {
  critical: { label: 'Critico', color: '#ef4444', border: '#ef4444', bg: '#7f1d1d' },
  high: { label: 'Alta', color: '#f59e0b', border: '#f59e0b', bg: '#78350f' },
  medium: { label: 'Media', color: '#3b82f6', border: '#3b82f6', bg: '#1e3a8a' },
  low: { label: 'Baja', color: '#6b7280', border: '#4b5563', bg: '#374151' }
};

const AUTONOMY_MODES = [
  { value: 'manual', label: 'Manual', desc: 'Requiere aprobacion humana' },
  { value: 'semi_auto', label: 'Semi-Auto', desc: 'Auto si confianza alta y cambio pequeno' },
  { value: 'auto', label: 'Auto', desc: 'Ejecuta todo, solo notifica' }
];

const REC_STATUS_COLORS = {
  pending: '#93c5fd', approved: '#fcd34d', rejected: '#fca5a5', executed: '#6ee7b7', expired: '#6b7280'
};

function timeAgo(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

// =============================================
// MAIN COMPONENT — Cerebro IA Unificado
// =============================================

const AgentsPage = () => {
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [togglingAI, setTogglingAI] = useState(false);
  const [controls, setControls] = useState({});
  const [brainReport, setBrainReport] = useState(null);
  const [pending, setPending] = useState([]);
  const [autonomy, setAutonomy] = useState({});
  const [cooldowns, setCooldowns] = useState([]);
  const [actionLoadingId, setActionLoadingId] = useState('');
  const [activeTab, setActiveTab] = useState('brain');
  const [showConfig, setShowConfig] = useState(false);
  const [expandedRecId, setExpandedRecId] = useState(null);
  const [aiCreations, setAICreations] = useState({ creations: [], stats: {} });
  const [impactData, setImpactData] = useState({ measured: [], pending: [] });
  const [cycleResult, setCycleResult] = useState(null);
  const [creativeAssets, setCreativeAssets] = useState([]);
  const [selectedCreatives, setSelectedCreatives] = useState({}); // { recId: assetId }
  const [loadingCreatives, setLoadingCreatives] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [status, agentReports, pendingRecs, autonomyCfg, cooldownList, aiCreationsData, impact] = await Promise.all([
        getControlsStatus().catch(() => ({})),
        getAgentReports().catch(() => ({})),
        getPendingRecommendations().catch(() => []),
        getAutonomyConfig().catch(() => ({})),
        getCooldowns().catch(() => []),
        getAICreations().catch(() => ({ creations: [], stats: {} })),
        getImpactData().catch(() => ({ measured: [], pending: [] }))
      ]);
      setControls(status || {});
      setBrainReport(agentReports?.brain || null);
      setPending(Array.isArray(pendingRecs) ? pendingRecs : []);
      setAutonomy(autonomyCfg || {});
      setCooldowns(Array.isArray(cooldownList) ? cooldownList : []);
      setAICreations(aiCreationsData || { creations: [], stats: {} });
      setImpactData(impact || { measured: [], pending: [] });
    } catch (error) {
      console.error('Error cargando datos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000); // 2 min (was 30s)
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleToggleAI = async () => {
    setTogglingAI(true);
    try {
      await toggleAI(!controls?.ai_enabled);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setTogglingAI(false);
    }
  };

  const handleRunCycle = async () => {
    setRunning(true);
    setCycleResult(null);
    try {
      const res = await runAgents();
      const r = res?.result;
      setCycleResult(r);
      await fetchData();
      // Auto-hide after 15s if successful
      if (r && !r.abortReason) {
        setTimeout(() => setCycleResult(null), 15000);
      }
    } catch (error) {
      setCycleResult({ abortReason: error.response?.data?.error || error.message });
    } finally {
      setRunning(false);
    }
  };

  const handleApprove = async (reportId, rec) => {
    const actionLabel = ACTION_LABELS[rec.action]?.label || rec.action;
    // For create_ad, require creative selection
    if (rec.action === 'create_ad') {
      const selectedId = selectedCreatives[rec._id];
      if (!selectedId) {
        alert('Selecciona un creativo del banco antes de ejecutar.');
        return;
      }
      const selectedAsset = creativeAssets.find(a => a._id === selectedId);
      const assetName = selectedAsset?.headline || selectedAsset?.original_name || 'creativo seleccionado';
      if (!window.confirm(`Crear ad con "${assetName}" en ${rec.entity_name}?`)) return;
    } else {
      if (!window.confirm(`Ejecutar "${actionLabel}" en ${rec.entity_name}?`)) return;
    }
    setActionLoadingId(rec._id);
    try {
      await approveRecommendation(reportId, rec._id);
      const body = rec.action === 'create_ad' && selectedCreatives[rec._id]
        ? { creative_asset_id: selectedCreatives[rec._id] }
        : {};
      await executeRecommendation(reportId, rec._id, body);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
      await fetchData();
    } finally {
      setActionLoadingId('');
    }
  };

  const handleReject = async (reportId, recId) => {
    setActionLoadingId(recId);
    try {
      await rejectRecommendation(reportId, recId);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setActionLoadingId('');
    }
  };

  const handleExecute = async (reportId, rec) => {
    const actionLabel = ACTION_LABELS[rec.action]?.label || rec.action;
    if (rec.action === 'create_ad') {
      const selectedId = selectedCreatives[rec._id];
      if (!selectedId) {
        alert('Selecciona un creativo del banco antes de ejecutar.');
        return;
      }
      const selectedAsset = creativeAssets.find(a => a._id === selectedId);
      const assetName = selectedAsset?.headline || selectedAsset?.original_name || 'creativo seleccionado';
      if (!window.confirm(`Crear ad con "${assetName}" en ${rec.entity_name}?`)) return;
    } else {
      if (!window.confirm(`Ejecutar "${actionLabel}" en ${rec.entity_name}?`)) return;
    }
    setActionLoadingId(rec._id);
    try {
      const body = rec.action === 'create_ad' && selectedCreatives[rec._id]
        ? { creative_asset_id: selectedCreatives[rec._id] }
        : {};
      await executeRecommendation(reportId, rec._id, body);
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setActionLoadingId('');
    }
  };

  const handleAutonomyChange = async (mode) => {
    try {
      await updateAutonomyConfig({ mode });
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleClearCooldowns = async () => {
    if (!window.confirm('Limpiar todos los cooldowns activos?')) return;
    try {
      await clearCooldowns();
      await fetchData();
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  // Load creative bank for create_ad selector (only unused ad-ready assets)
  const loadCreatives = async (forceRefresh = false) => {
    if (!forceRefresh && creativeAssets.length > 0) return;
    setLoadingCreatives(true);
    try {
      const res = await getCreativeAssets('active');
      const adReady = (res.assets || []).filter(a => a.purpose !== 'reference' && a.times_used === 0 && a.link_url);
      setCreativeAssets(adReady);
    } catch (error) {
      console.error('Error cargando creativos:', error);
    } finally {
      setLoadingCreatives(false);
    }
  };

  const handleExpandRec = (rec) => {
    const newId = expandedRecId === rec._id ? null : rec._id;
    setExpandedRecId(newId);
    // Load creatives when expanding a create_ad recommendation
    if (newId && rec.action === 'create_ad') {
      loadCreatives();
      // Pre-select the Brain's pick if available
      if (rec.creative_asset_id && !selectedCreatives[rec._id]) {
        setSelectedCreatives(prev => ({ ...prev, [rec._id]: rec.creative_asset_id }));
      }
    }
  };

  // Sort pending by priority
  const sortedPending = useMemo(() => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...pending].sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));
  }, [pending]);

  // Pending impact actions (in measurement)
  const pendingImpactActions = useMemo(() => {
    return (impactData.pending || []).slice(0, 10);
  }, [impactData]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#9ca3af', gap: '10px', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <Loader size={18} className="spin" />
        Cargando Centro IA...
      </div>
    );
  }

  const pendingCount = pending.filter(r => r.status === 'pending').length;
  const approvedCount = pending.filter(r => r.status === 'approved').length;
  const currentMode = autonomy?.mode || 'manual';

  const getChangeText = (rec) => {
    if (['scale_up', 'scale_down'].includes(rec.action)) {
      return `$${rec.current_value} → $${rec.recommended_value}`;
    }
    if (rec.action === 'move_budget') return `$${rec.recommended_value} → ${rec.target_entity_name || 'destino'}`;
    if (rec.action === 'duplicate_adset') return rec.duplicate_name || `Duplicar con $${rec.recommended_value}`;
    if (rec.action === 'create_ad') return rec.ad_name || 'Nuevo ad desde banco';
    if (rec.action === 'update_bid_strategy') return rec.bid_strategy || 'Cambiar bid';
    if (rec.action === 'update_ad_status') return rec.recommended_value === 0 ? 'Pausar ad' : 'Activar ad';
    return '--';
  };

  const hasDetails = (rec) => {
    return (rec.action === 'duplicate_adset' && (rec.duplicate_strategy || rec.duplicate_name)) ||
           rec.action === 'create_ad'; // Always show details for create_ad (creative selector)
  };

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#fff' }}>

      {/* ========= SECTION A: HEADER + CONTROL ========= */}
      <div className="agents-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '10px',
            background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: controls?.ai_enabled ? '0 0 20px #3b82f640' : 'none'
          }}>
            <Brain size={20} color="#fff" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ fontSize: '22px', fontWeight: '700', margin: 0, letterSpacing: '-0.02em' }}>
                Cerebro IA
              </h1>
              <span style={{
                padding: '2px 7px', borderRadius: '4px', fontSize: '10px', fontWeight: '800',
                background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', color: '#fff',
                letterSpacing: '0.06em'
              }}>UNIFIED</span>
            </div>
            <p style={{ color: '#6b7280', fontSize: '12px', margin: '2px 0 0' }}>
              Un cerebro coordinando scaling, rendimiento, creativos y pacing
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Autonomy mode selector */}
          <div style={{
            display: 'flex', gap: '2px', backgroundColor: '#111827', borderRadius: '8px', padding: '2px',
            border: '1px solid #1f2937'
          }}>
            {AUTONOMY_MODES.map(m => (
              <button key={m.value} onClick={() => handleAutonomyChange(m.value)}
                title={m.desc}
                style={{
                  padding: '5px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                  fontSize: '11px', fontWeight: '700',
                  backgroundColor: currentMode === m.value ? (m.value === 'auto' ? '#065f46' : m.value === 'semi_auto' ? '#78350f' : '#1e3a8a') : 'transparent',
                  color: currentMode === m.value ? (m.value === 'auto' ? '#6ee7b7' : m.value === 'semi_auto' ? '#fcd34d' : '#93c5fd') : '#4b5563',
                  transition: 'all 0.15s'
                }}>
                {m.label}
              </button>
            ))}
          </div>
          <button onClick={handleToggleAI} disabled={togglingAI} style={{
            padding: '8px 12px', borderRadius: '8px', border: 'none', cursor: togglingAI ? 'not-allowed' : 'pointer',
            fontSize: '12px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px',
            backgroundColor: controls?.ai_enabled ? '#065f46' : '#7f1d1d',
            color: controls?.ai_enabled ? '#6ee7b7' : '#fca5a5'
          }}>
            <Power size={13} />
            {controls?.ai_enabled ? 'IA ON' : 'IA OFF'}
          </button>
          <button onClick={handleRunCycle} disabled={running || !controls?.ai_enabled} style={{
            padding: '8px 12px', borderRadius: '8px', border: 'none',
            cursor: running || !controls?.ai_enabled ? 'not-allowed' : 'pointer',
            fontSize: '12px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px',
            backgroundColor: running ? '#374151' : '#1e3a8a', color: running ? '#9ca3af' : '#93c5fd'
          }}>
            {running ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
            {running ? 'Analizando...' : 'Ejecutar Ciclo'}
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '14px',
        padding: '8px 14px', borderRadius: '8px', backgroundColor: '#111827', border: '1px solid #1f2937',
        fontSize: '11px', color: '#6b7280', flexWrap: 'wrap'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Clock size={10} />
          Ultimo analisis: <span style={{ color: '#9ca3af', fontWeight: '600' }}>{timeAgo(brainReport?.created_at) || 'nunca'}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Activity size={10} />
          Modo: <span style={{
            fontWeight: '700',
            color: currentMode === 'auto' ? '#10b981' : currentMode === 'semi_auto' ? '#f59e0b' : '#93c5fd'
          }}>{currentMode.replace('_', '-')}</span>
        </span>
        {cooldowns.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ color: '#f59e0b' }}>{cooldowns.length} cooldowns activos</span>
          </span>
        )}
        {pendingImpactActions.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Eye size={10} />
            <span style={{ color: '#8b5cf6' }}>{pendingImpactActions.length} en medicion</span>
          </span>
        )}
      </div>

      {/* Cycle result banner */}
      {cycleResult && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
          backgroundColor: cycleResult.abortReason ? '#7f1d1d15' : '#065f4615',
          border: `1px solid ${cycleResult.abortReason ? '#ef444430' : '#10b98130'}`,
          display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px'
        }}>
          <span style={{ fontWeight: '700', color: cycleResult.abortReason ? '#ef4444' : '#10b981' }}>
            {cycleResult.abortReason ? 'Ciclo con problema' : 'Ciclo completado'}
          </span>
          {cycleResult.abortReason ? (
            <span style={{ color: '#fca5a5' }}>{cycleResult.abortReason}</span>
          ) : (
            <span style={{ color: '#9ca3af' }}>
              {cycleResult.recommendations || 0} recomendaciones en {cycleResult.elapsed || '?'}
              {cycleResult.autoExecuted > 0 && ` | ${cycleResult.autoExecuted} auto-ejecutadas`}
            </span>
          )}
          <button onClick={() => setCycleResult(null)} style={{
            marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            color: '#6b7280', padding: '2px'
          }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ========= TABS ========= */}
      <div style={{ display: 'flex', gap: '2px', marginBottom: '14px', borderBottom: '1px solid #1f2937' }}>
        {[
          { id: 'brain', label: 'Cerebro IA', icon: Brain, badge: pendingCount > 0 ? pendingCount : null },
          { id: 'creatives', label: 'Banco Creativos', icon: Image, badge: null, href: '/creatives' },
          { id: 'ai-creations', label: 'Creaciones IA', icon: Zap, badge: aiCreations.stats?.total > 0 ? aiCreations.stats.total : null }
        ].map(tab => (
          <button key={tab.id} onClick={() => tab.href ? (window.location.href = tab.href) : setActiveTab(tab.id)} style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: '600',
            display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '6px 6px 0 0',
            backgroundColor: 'transparent',
            color: activeTab === tab.id ? '#fff' : '#6b7280',
            borderBottom: activeTab === tab.id ? '2px solid #3b82f6' : '2px solid transparent'
          }}>
            <tab.icon size={14} />
            {tab.label}
            {tab.href && <ExternalLink size={10} style={{ opacity: 0.5 }} />}
            {tab.badge && (
              <span style={{
                padding: '1px 6px', borderRadius: '999px', fontSize: '10px', fontWeight: '700',
                backgroundColor: '#1e3a8a', color: '#93c5fd', minWidth: '18px', textAlign: 'center'
              }}>{tab.badge}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'brain' && (
        <>
          {/* ========= SECTION B: RECOMENDACIONES PENDIENTES ========= */}
          {(pendingCount > 0 || approvedCount > 0) && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <Sparkles size={16} color="#f59e0b" />
                <span style={{ fontSize: '15px', fontWeight: '700', color: '#e5e7eb' }}>
                  Recomendaciones del Cerebro
                </span>
                <span style={{
                  padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: '700',
                  backgroundColor: '#f59e0b15', color: '#f59e0b', border: '1px solid #f59e0b30'
                }}>
                  {pendingCount + approvedCount}
                </span>
              </div>

              {/* Recommendation cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {sortedPending.map((rec) => {
                  const action = ACTION_LABELS[rec.action] || ACTION_LABELS.no_action;
                  const priority = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.medium;
                  const isLoading = actionLoadingId === rec._id;
                  const isPending = rec.status === 'pending';
                  const isApproved = rec.status === 'approved';
                  const raw = rec.metrics || {};
                  const m = {
                    roas_7d: parseFloat(raw.roas_7d) || 0,
                    roas_3d: parseFloat(raw.roas_3d) || 0,
                    cpa_7d: parseFloat(raw.cpa_7d) || 0,
                    spend_today: parseFloat(raw.spend_today) || 0,
                    ctr: parseFloat(raw.ctr) || 0,
                    frequency: parseFloat(raw.frequency) || 0
                  };
                  const hasMetrics = m.roas_7d > 0 || m.cpa_7d > 0 || m.spend_today > 0;

                  return (
                    <div key={rec._id} className="rec-card" style={{
                      borderRadius: '10px',
                      backgroundColor: '#0d1117',
                      border: `1px solid ${priority.border}20`,
                      borderLeft: `3px solid ${priority.border}80`,
                      overflow: 'hidden',
                      transition: 'all 0.15s'
                    }}>
                      <div style={{ padding: '12px 14px' }}>
                        {/* Row 1: Action + Entity + Change + Priority */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                          <span style={{
                            padding: '3px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700',
                            backgroundColor: action.color + '15', color: action.color,
                            whiteSpace: 'nowrap'
                          }}>
                            {action.icon} {action.label}
                          </span>
                          <span style={{ fontSize: '14px', fontWeight: '600', color: '#f3f4f6' }}>
                            {rec.entity_name}
                          </span>
                          <span style={{ fontSize: '13px', color: action.color, fontWeight: '700' }}>
                            {getChangeText(rec)}
                          </span>
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                            {(rec.priority === 'critical' || rec.priority === 'high') && (
                              <span style={{
                                padding: '2px 7px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                                backgroundColor: priority.bg + '40', color: priority.color,
                                display: 'flex', alignItems: 'center', gap: '3px'
                              }}>
                                {rec.priority === 'critical' && <AlertTriangle size={9} />}
                                {priority.label}
                              </span>
                            )}
                            <span style={{
                              padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: '600',
                              backgroundColor: rec.confidence === 'high' ? '#065f4620' : rec.confidence === 'low' ? '#7f1d1d20' : '#78350f20',
                              color: rec.confidence === 'high' ? '#10b981' : rec.confidence === 'low' ? '#ef4444' : '#f59e0b'
                            }}>
                              {rec.confidence}
                            </span>
                          </div>
                        </div>

                        {/* Row 2: Reasoning */}
                        <div style={{
                          fontSize: '12px', color: '#9ca3af', lineHeight: '1.5',
                          marginBottom: hasMetrics ? '10px' : '8px'
                        }}>
                          {rec.reasoning}
                        </div>

                        {/* Row 3: Metrics chips */}
                        {hasMetrics && (
                          <div style={{
                            display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px'
                          }}>
                            {m.roas_7d > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '700',
                                backgroundColor: m.roas_7d >= 2 ? '#065f4625' : m.roas_7d >= 1 ? '#78350f25' : '#7f1d1d25',
                                color: m.roas_7d >= 2 ? '#10b981' : m.roas_7d >= 1 ? '#f59e0b' : '#ef4444'
                              }}>
                                ROAS {m.roas_7d.toFixed(1)}x
                              </span>
                            )}
                            {m.roas_3d > 0 && m.roas_7d > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '600',
                                backgroundColor: '#1e3a8a20', color: '#93c5fd'
                              }}>
                                3d: {m.roas_3d.toFixed(1)}x {m.roas_3d > m.roas_7d ? '\u2191' : m.roas_3d < m.roas_7d ? '\u2193' : '='}
                              </span>
                            )}
                            {m.cpa_7d > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '600',
                                backgroundColor: '#37415120', color: '#d1d5db'
                              }}>
                                CPA ${m.cpa_7d.toFixed(0)}
                              </span>
                            )}
                            {m.spend_today > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '600',
                                backgroundColor: '#37415120', color: '#9ca3af'
                              }}>
                                Hoy ${m.spend_today.toFixed(0)}
                              </span>
                            )}
                            {m.ctr > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '600',
                                backgroundColor: '#37415120', color: '#9ca3af'
                              }}>
                                CTR {m.ctr.toFixed(2)}%
                              </span>
                            )}
                            {m.frequency > 0 && (
                              <span style={{
                                padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: '700',
                                backgroundColor: m.frequency > 3 ? '#7f1d1d25' : m.frequency > 2 ? '#78350f25' : '#37415120',
                                color: m.frequency > 3 ? '#ef4444' : m.frequency > 2 ? '#f59e0b' : '#9ca3af'
                              }}>
                                Freq {m.frequency.toFixed(1)}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Row 4: Past impact */}
                        {rec.past_impact && rec.past_impact.length > 0 && (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px',
                            padding: '5px 10px', borderRadius: '6px', fontSize: '11px',
                            backgroundColor: '#111827', border: '1px solid #1f293750'
                          }}>
                            <Brain size={10} color="#8b5cf6" />
                            <span style={{ color: '#8b5cf6', fontWeight: '600', fontSize: '10px' }}>Historial:</span>
                            {rec.past_impact.slice(0, 3).map((pi, idx) => (
                              <span key={idx} style={{
                                display: 'inline-flex', alignItems: 'center', gap: '3px',
                                padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: '600',
                                backgroundColor: pi.result === 'improved' ? '#065f4615' : pi.result === 'worsened' ? '#7f1d1d15' : '#37415115',
                                color: pi.result === 'improved' ? '#10b981' : pi.result === 'worsened' ? '#ef4444' : '#6b7280'
                              }}>
                                {pi.result === 'improved' ? '\u2191' : pi.result === 'worsened' ? '\u2193' : '\u2014'}
                                {parseFloat(pi.delta_roas_pct) > 0 ? '+' : ''}{parseFloat(pi.delta_roas_pct || 0).toFixed(1)}%
                                <span style={{ color: '#4b5563' }}>({pi.days_ago}d)</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Row 5: Expandable details */}
                        {hasDetails(rec) && (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); handleExpandRec(rec); }} style={{
                              background: 'none', border: 'none', padding: '0', cursor: 'pointer',
                              fontSize: '11px', color: '#3b82f6', fontWeight: '600',
                              display: 'flex', alignItems: 'center', gap: '4px', marginBottom: expandedRecId === rec._id ? '8px' : '10px'
                            }}>
                              {expandedRecId === rec._id ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                              {expandedRecId === rec._id ? 'Ocultar' : rec.action === 'create_ad' ? 'Elegir creativo' : 'Ver plan de la IA'}
                            </button>
                            {expandedRecId === rec._id && (
                              <div style={{
                                padding: '10px 12px', borderRadius: '8px', marginBottom: '10px',
                                backgroundColor: '#111827', border: '1px solid #1f293750',
                                fontSize: '11px', lineHeight: '1.6'
                              }}>
                                {rec.action === 'duplicate_adset' && (
                                  <>
                                    <div style={{ marginBottom: '5px' }}>
                                      <span style={{ color: '#6b7280' }}>Nombre: </span>
                                      <span style={{ color: '#e5e7eb', fontWeight: '700' }}>{rec.duplicate_name || '--'}</span>
                                    </div>
                                    <div style={{ marginBottom: '5px' }}>
                                      <span style={{ color: '#6b7280' }}>Budget: </span>
                                      <span style={{ color: '#10b981', fontWeight: '700' }}>${rec.recommended_value}</span>
                                      <span style={{ color: '#4b5563' }}> (original: ${rec.current_value})</span>
                                    </div>
                                    {rec.duplicate_strategy && (
                                      <div style={{ color: '#9ca3af' }}>{rec.duplicate_strategy}</div>
                                    )}
                                  </>
                                )}
                                {rec.action === 'create_ad' && (
                                  <>
                                    {/* Brain-generated ad copy preview */}
                                    {(rec.ad_headline || rec.ad_primary_text) && (
                                      <div style={{ marginBottom: '8px', padding: '8px 10px', borderRadius: '6px', backgroundColor: '#1e3a8a15', border: '1px solid #1e3a8a30' }}>
                                        <div style={{ fontSize: '10px', fontWeight: '700', color: '#3b82f6', marginBottom: '5px' }}>Ad Copy (EN)</div>
                                        {rec.ad_headline && (
                                          <div style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb', marginBottom: '3px' }}>
                                            {rec.ad_headline}
                                          </div>
                                        )}
                                        {rec.ad_primary_text && (
                                          <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.4' }}>
                                            {rec.ad_primary_text}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {rec.creative_rationale && (
                                      <div style={{ color: '#9ca3af', marginBottom: '8px' }}>
                                        <span style={{ color: '#6b7280', fontWeight: '600' }}>Brain dice: </span>
                                        {rec.creative_rationale}
                                      </div>
                                    )}
                                    {rec.ads_to_pause && rec.ads_to_pause.length > 0 && (
                                      <div style={{ color: '#ef4444', fontWeight: '600', marginBottom: '8px' }}>
                                        Pausar {rec.ads_to_pause.length} ad(s) fatigados al ejecutar
                                      </div>
                                    )}
                                    {/* Creative selector */}
                                    <div style={{
                                      borderTop: '1px solid #1f2937', paddingTop: '8px', marginTop: '4px'
                                    }}>
                                      <div style={{ fontSize: '11px', fontWeight: '700', color: '#ec4899', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                        <Image size={12} />
                                        Creativos disponibles (sin usar)
                                        <button
                                          onClick={(e) => { e.stopPropagation(); loadCreatives(true); }}
                                          disabled={loadingCreatives}
                                          style={{
                                            background: 'none', border: '1px solid #ec489930', borderRadius: '4px',
                                            padding: '2px 6px', cursor: loadingCreatives ? 'not-allowed' : 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '3px',
                                            fontSize: '9px', fontWeight: '600', color: '#ec4899', marginLeft: '4px'
                                          }}
                                          title="Recargar creativos (si acabas de generar nuevos)"
                                        >
                                          <RefreshCw size={9} className={loadingCreatives ? 'spin' : ''} />
                                          Actualizar
                                        </button>
                                      </div>
                                      {loadingCreatives ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#6b7280', fontSize: '11px', padding: '10px 0' }}>
                                          <Loader size={12} className="spin" /> Cargando banco...
                                        </div>
                                      ) : creativeAssets.length === 0 ? (
                                        <div style={{ color: '#ef4444', fontSize: '11px', padding: '10px 0' }}>
                                          No hay creativos listos. Se necesitan creativos sin usar, con link de producto configurado.
                                        </div>
                                      ) : (
                                        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px' }}>
                                          {creativeAssets.map(asset => {
                                            const isSelected = selectedCreatives[rec._id] === asset._id;
                                            const isBrainPick = rec.creative_asset_id === asset._id;
                                            return (
                                              <div key={asset._id}
                                                onClick={() => setSelectedCreatives(prev => ({ ...prev, [rec._id]: asset._id }))}
                                                style={{
                                                  flexShrink: 0, width: '120px',
                                                  borderRadius: '8px', overflow: 'hidden', cursor: 'pointer',
                                                  border: isSelected ? '2px solid #ec4899' : '1px solid #1f2937',
                                                  backgroundColor: isSelected ? '#ec489910' : '#0d1117',
                                                  transition: 'all 0.15s',
                                                  position: 'relative'
                                                }}>
                                                {/* Full image preview */}
                                                <div style={{ width: '100%', backgroundColor: '#1f2937', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                  {asset.media_type === 'image' ? (
                                                    <img
                                                      src={getCreativePreviewUrl(asset.filename)}
                                                      alt={asset.headline || asset.original_name}
                                                      style={{ width: '100%', height: 'auto', display: 'block' }}
                                                      onError={(e) => { e.target.parentElement.style.height = '80px'; e.target.style.display = 'none'; }}
                                                    />
                                                  ) : (
                                                    <div style={{ color: '#6b7280', fontSize: '10px', textAlign: 'center', padding: '20px 0' }}>
                                                      <Play size={16} style={{ marginBottom: '2px' }} /><br />VIDEO
                                                    </div>
                                                  )}
                                                </div>
                                                {/* Info */}
                                                <div style={{ padding: '5px 6px' }}>
                                                  <div style={{
                                                    fontSize: '9px', fontWeight: '600', color: isSelected ? '#f9a8d4' : '#e5e7eb',
                                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                                  }}>
                                                    {asset.headline || asset.original_name}
                                                  </div>
                                                  {asset.style && asset.style !== 'other' && (
                                                    <span style={{
                                                      padding: '1px 4px', borderRadius: '3px', fontSize: '8px', fontWeight: '700',
                                                      backgroundColor: '#8b5cf615', color: '#a78bfa', marginTop: '3px', display: 'inline-block'
                                                    }}>{asset.style}</span>
                                                  )}
                                                </div>
                                                {/* Badges */}
                                                {isBrainPick && (
                                                  <div style={{
                                                    position: 'absolute', top: '3px', left: '3px',
                                                    padding: '1px 5px', borderRadius: '4px', fontSize: '8px', fontWeight: '700',
                                                    backgroundColor: '#3b82f6', color: '#fff'
                                                  }}>IA</div>
                                                )}
                                                {isSelected && (
                                                  <div style={{
                                                    position: 'absolute', top: '3px', right: '3px',
                                                    width: '16px', height: '16px', borderRadius: '50%',
                                                    backgroundColor: '#ec4899', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: '10px', color: '#fff', fontWeight: '800'
                                                  }}>✓</div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                      {selectedCreatives[rec._id] && (
                                        <div style={{
                                          marginTop: '8px', padding: '6px 8px', borderRadius: '6px',
                                          backgroundColor: '#ec489910', border: '1px solid #ec489925',
                                          fontSize: '11px', color: '#f9a8d4', display: 'flex', alignItems: 'center', gap: '6px'
                                        }}>
                                          <span style={{ fontWeight: '700' }}>Seleccionado:</span>
                                          {(() => {
                                            const sel = creativeAssets.find(a => a._id === selectedCreatives[rec._id]);
                                            return sel ? (sel.headline || sel.original_name) : selectedCreatives[rec._id];
                                          })()}
                                          {rec.creative_asset_id && selectedCreatives[rec._id] !== rec.creative_asset_id && (
                                            <span style={{ color: '#6b7280', fontSize: '10px' }}>(diferente al sugerido por IA)</span>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}

                        {/* Row 6: Action buttons */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center' }}>
                          {isLoading && <Loader size={14} className="spin" style={{ color: '#6b7280' }} />}
                          {isPending && (
                            <>
                              <button onClick={() => handleReject(rec.report_id, rec._id)} disabled={isLoading} style={{
                                padding: '7px 16px', borderRadius: '8px', border: '1px solid #374151',
                                backgroundColor: 'transparent', color: '#9ca3af',
                                fontSize: '12px', fontWeight: '600', cursor: isLoading ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '5px', transition: 'all 0.15s'
                              }}>
                                <X size={13} />
                                Rechazar
                              </button>
                              <button onClick={() => handleApprove(rec.report_id, rec)} disabled={isLoading} style={{
                                padding: '7px 20px', borderRadius: '8px', border: 'none',
                                background: 'linear-gradient(135deg, #065f46, #10b981)',
                                color: '#fff', fontSize: '12px', fontWeight: '700',
                                cursor: isLoading ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: '5px',
                                boxShadow: '0 2px 10px #10b98130', transition: 'all 0.15s'
                              }}>
                                <Play size={13} />
                                Ejecutar
                              </button>
                            </>
                          )}
                          {isApproved && (
                            <button onClick={() => handleExecute(rec.report_id, rec)} disabled={isLoading} style={{
                              padding: '7px 20px', borderRadius: '8px', border: 'none',
                              background: 'linear-gradient(135deg, #1e3a8a, #3b82f6)',
                              color: '#fff', fontSize: '12px', fontWeight: '700',
                              cursor: isLoading ? 'not-allowed' : 'pointer',
                              display: 'flex', alignItems: 'center', gap: '5px',
                              boxShadow: '0 2px 10px #3b82f630', transition: 'all 0.15s'
                            }}>
                              <Play size={13} />
                              Ejecutar
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {pendingCount === 0 && approvedCount === 0 && (
            <div style={{
              backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '12px',
              padding: '24px', marginBottom: '14px', textAlign: 'center'
            }}>
              <Brain size={24} color="#374151" style={{ marginBottom: '6px' }} />
              <div style={{ color: '#6b7280', fontSize: '13px' }}>
                Sin recomendaciones pendientes. El cerebro esta monitoreando.
              </div>
            </div>
          )}

          {/* ========= SECTION C: ACCIONES EN MEDICION ========= */}
          {pendingImpactActions.length > 0 && (
            <div style={{
              backgroundColor: '#111827', border: '1px solid #8b5cf620', borderRadius: '12px',
              padding: '14px', marginBottom: '14px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Eye size={15} color="#8b5cf6" />
                <span style={{ fontSize: '14px', fontWeight: '700', color: '#e5e7eb' }}>
                  Observando resultados
                </span>
                <span style={{
                  padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: '700',
                  backgroundColor: '#8b5cf620', color: '#a78bfa'
                }}>
                  {pendingImpactActions.length} acciones
                </span>
                <a href="/impact" style={{
                  marginLeft: 'auto', fontSize: '11px', color: '#6b7280', textDecoration: 'none',
                  display: 'flex', alignItems: 'center', gap: '4px'
                }}>
                  Ver impacto completo <ExternalLink size={10} />
                </a>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '8px' }}>
                {pendingImpactActions.map((a, idx) => {
                  const actionCfg = ACTION_LABELS[a.action] || ACTION_LABELS.no_action;
                  const hoursElapsed = a.hours_elapsed || 0;
                  const hoursLeft = Math.max(0, 72 - hoursElapsed);
                  const progressPct = Math.min(100, (hoursElapsed / 72) * 100);

                  return (
                    <div key={idx} style={{
                      padding: '10px 12px', borderRadius: '8px', backgroundColor: '#0d1117',
                      border: '1px solid #1f2937'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                        <span style={{
                          padding: '2px 7px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                          backgroundColor: actionCfg.color + '15', color: actionCfg.color
                        }}>
                          {actionCfg.icon} {actionCfg.label}
                        </span>
                        <span style={{ fontSize: '12px', fontWeight: '600', color: '#e5e7eb', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.entity_name}
                        </span>
                      </div>

                      {/* Progress bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <div style={{ flex: 1, height: '3px', borderRadius: '2px', backgroundColor: '#1f2937' }}>
                          <div style={{
                            height: '100%', borderRadius: '2px', width: `${progressPct}%`,
                            backgroundColor: progressPct >= 66 ? '#10b981' : progressPct >= 33 ? '#f59e0b' : '#3b82f6',
                            transition: 'width 0.3s'
                          }} />
                        </div>
                        <span style={{ fontSize: '10px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                          {hoursLeft}h restantes
                        </span>
                      </div>

                      {/* Partial 24h results if available */}
                      {a.has_1d_data && a.delta_roas_1d_pct !== null && (
                        <div style={{ fontSize: '10px', color: '#6b7280' }}>
                          Parcial 24h: ROAS{' '}
                          <span style={{
                            fontWeight: '700',
                            color: a.delta_roas_1d_pct > 5 ? '#10b981' : a.delta_roas_1d_pct < -5 ? '#ef4444' : '#f59e0b'
                          }}>
                            {a.delta_roas_1d_pct > 0 ? '+' : ''}{parseFloat(a.delta_roas_1d_pct).toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ========= SECTION D: RESUMEN DEL CEREBRO ========= */}
          {brainReport && (
            <div style={{
              backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '12px',
              padding: '14px', marginBottom: '14px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Brain size={15} color="#3b82f6" />
                <span style={{ fontSize: '14px', fontWeight: '700', color: '#e5e7eb' }}>
                  Resumen del Cerebro
                </span>
                <span style={{ fontSize: '11px', color: '#4b5563' }}>
                  {timeAgo(brainReport.created_at)}
                </span>
              </div>

              {/* Summary text */}
              {brainReport.summary && (
                <p style={{ color: '#9ca3af', fontSize: '12px', lineHeight: '1.6', margin: '0 0 12px' }}>
                  {brainReport.summary}
                </p>
              )}

              {/* Alerts */}
              {(brainReport.alerts || []).length > 0 && (
                <div style={{ marginBottom: '12px' }}>
                  {brainReport.alerts.map((alert, i) => (
                    <div key={i} style={{
                      padding: '6px 10px', borderRadius: '6px', marginBottom: '3px', fontSize: '11px',
                      backgroundColor: alert.severity === 'critical' ? '#7f1d1d15' : '#78350f15',
                      border: `1px solid ${alert.severity === 'critical' ? '#ef444420' : '#f59e0b20'}`,
                      color: '#d1d5db'
                    }}>
                      <span style={{ fontWeight: '700', color: alert.severity === 'critical' ? '#ef4444' : '#f59e0b', marginRight: '6px' }}>
                        {(alert.type_name || '').toUpperCase()}
                      </span>
                      {alert.message}
                    </div>
                  ))}
                </div>
              )}

              {/* Account metrics */}
              {brainReport.account_metrics && (
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  {[
                    { label: 'ROAS 7d', value: parseFloat(brainReport.account_metrics.roas_7d || 0).toFixed(1) + 'x', color: parseFloat(brainReport.account_metrics.roas_7d || 0) >= 2 ? '#10b981' : '#f59e0b' },
                    { label: 'CPA 7d', value: '$' + parseFloat(brainReport.account_metrics.cpa_7d || 0).toFixed(0), color: '#d1d5db' },
                    { label: 'Spend hoy', value: '$' + parseFloat(brainReport.account_metrics.spend_today || 0).toFixed(0), color: '#93c5fd' },
                    { label: 'Freq prom', value: parseFloat(brainReport.account_metrics.frequency || 0).toFixed(1), color: parseFloat(brainReport.account_metrics.frequency || 0) > 3 ? '#ef4444' : '#9ca3af' }
                  ].filter(kpi => kpi.value !== '0x' && kpi.value !== '$0' && kpi.value !== '0.0').map(kpi => (
                    <div key={kpi.label} style={{
                      padding: '8px 14px', borderRadius: '8px', backgroundColor: '#0d1117', textAlign: 'center',
                      minWidth: '80px'
                    }}>
                      <div style={{ fontSize: '16px', fontWeight: '800', color: kpi.color }}>{kpi.value}</div>
                      <div style={{ fontSize: '10px', color: '#4b5563', fontWeight: '600' }}>{kpi.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* All recommendations (compact view) */}
              {brainReport.recommendations && brainReport.recommendations.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '700', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Todas las recomendaciones ({brainReport.recommendations.length})
                  </div>
                  {brainReport.recommendations.map((rec, i) => {
                    const actionStyle = ACTION_LABELS[rec.action] || ACTION_LABELS.no_action;
                    return (
                      <div key={i} style={{
                        padding: '6px 10px', borderRadius: '6px', marginBottom: '3px',
                        backgroundColor: '#0d1117', border: '1px solid #1f2937',
                        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap'
                      }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                          backgroundColor: actionStyle.color + '15', color: actionStyle.color
                        }}>{actionStyle.label}</span>
                        <span style={{ fontSize: '12px', fontWeight: '600', color: '#e5e7eb' }}>{rec.entity_name}</span>
                        <span style={{
                          marginLeft: 'auto', fontSize: '10px', fontWeight: '700',
                          color: REC_STATUS_COLORS[rec.status] || '#6b7280'
                        }}>{rec.status}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ========= CONFIG BAR (Cooldowns) ========= */}
          <div style={{
            backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '10px',
            overflow: 'hidden'
          }}>
            <button onClick={() => setShowConfig(!showConfig)} style={{
              width: '100%', padding: '10px 14px', border: 'none', cursor: 'pointer',
              backgroundColor: 'transparent', display: 'flex', alignItems: 'center', gap: '8px',
              color: '#9ca3af', fontSize: '12px', fontWeight: '600'
            }}>
              {showConfig ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Settings size={13} />
              <span>Configuracion</span>
              <span style={{ color: '#4b5563', fontSize: '11px' }}>
                {cooldowns.length > 0 ? `${cooldowns.length} cooldowns activos` : 'Sin cooldowns'}
              </span>
            </button>

            {showConfig && (
              <div style={{ padding: '0 14px 14px' }}>
                {/* Cooldowns */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Cooldowns ({cooldowns.length})
                  </span>
                  {cooldowns.length > 0 && (
                    <button onClick={handleClearCooldowns} style={{
                      padding: '2px 6px', borderRadius: '4px', border: 'none',
                      backgroundColor: '#7f1d1d', color: '#fca5a5', fontSize: '10px', fontWeight: '700', cursor: 'pointer'
                    }}>Limpiar todos</button>
                  )}
                </div>
                {cooldowns.length === 0 ? (
                  <div style={{ fontSize: '11px', color: '#4b5563' }}>Sin cooldowns activos</div>
                ) : (
                  <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '4px' }}>
                    {cooldowns.map((cd, i) => (
                      <div key={i} style={{
                        padding: '4px 8px', borderRadius: '4px',
                        backgroundColor: '#0d1117', fontSize: '10px', color: '#6b7280'
                      }}>
                        <span style={{ fontWeight: '600', color: '#9ca3af' }}>{cd.entity_name || cd.entity_id}</span>
                        {' '}{cd.last_action} | {cd.minutesLeft ? `${cd.minutesLeft}m` : (cd.hoursLeft || cd.hours_left) ? `${cd.hoursLeft || cd.hours_left}h` : '?'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ========= AI CREATIONS TAB ========= */}
      {activeTab === 'ai-creations' && (
        <div style={{ backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '12px', padding: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
            <Zap size={15} color="#f59e0b" />
            <span style={{ fontSize: '14px', fontWeight: '700', color: '#e5e7eb' }}>
              Creaciones de la IA
            </span>
            {aiCreations.stats?.total > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: '700',
                backgroundColor: '#f59e0b20', color: '#f59e0b'
              }}>
                {aiCreations.stats.success_rate}% exito
              </span>
            )}
          </div>

          {aiCreations.stats?.total > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '14px' }}>
              {[
                { label: 'Total', value: aiCreations.stats.total, color: '#93c5fd', bg: '#1e3a8a20' },
                { label: 'Positivas', value: aiCreations.stats.positive, color: '#10b981', bg: '#065f4620' },
                { label: 'Negativas', value: aiCreations.stats.negative, color: '#ef4444', bg: '#7f1d1d20' },
                { label: 'Midiendo', value: aiCreations.stats.pending, color: '#f59e0b', bg: '#78350f20' }
              ].map(s => (
                <div key={s.label} style={{
                  backgroundColor: s.bg, borderRadius: '8px', padding: '10px', textAlign: 'center'
                }}>
                  <div style={{ fontSize: '20px', fontWeight: '800', color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600' }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {(!aiCreations.creations || aiCreations.creations.length === 0) ? (
            <div style={{ padding: '30px', color: '#4b5563', textAlign: 'center', fontSize: '13px' }}>
              Sin creaciones de IA aun. Cuando ejecutes una recomendacion de duplicar ad set o crear ad, aparecera aqui con seguimiento.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {aiCreations.creations.map(c => {
                const isAdset = c.creation_type === 'duplicate_adset';
                const verdictConfig = {
                  positive: { label: 'Positiva', color: '#10b981', bg: '#065f4620' },
                  negative: { label: 'Negativa', color: '#ef4444', bg: '#7f1d1d20' },
                  neutral: { label: 'Neutra', color: '#6b7280', bg: '#37415120' },
                  pending: { label: 'Midiendo...', color: '#f59e0b', bg: '#78350f20' }
                };
                const v = verdictConfig[c.verdict] || verdictConfig.pending;
                const daysAgo = Math.floor((Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24));

                const lifecycleConfig = {
                  created: { label: 'Esperando', color: '#6b7280', icon: '\u23F3' },
                  activating: { label: 'Activando', color: '#3b82f6', icon: '\u26A1' },
                  learning: { label: 'Learning', color: '#f59e0b', icon: '\uD83E\uDDE0' },
                  evaluating: { label: 'Evaluando', color: '#8b5cf6', icon: '\uD83D\uDD0D' },
                  scaling: { label: 'Escalando', color: '#10b981', icon: '\uD83D\uDE80' },
                  stable: { label: 'Estable', color: '#06b6d4', icon: '\u2714' },
                  killing: { label: 'Pausando', color: '#ef4444', icon: '\u23F8' },
                  dead: { label: 'Muerto', color: '#4b5563', icon: '\u2716' }
                };
                const lc = lifecycleConfig[c.lifecycle_phase] || lifecycleConfig.created;

                const m = c.metrics_7d?.spend > 0 ? c.metrics_7d : c.metrics_3d?.spend > 0 ? c.metrics_3d : c.metrics_1d?.spend > 0 ? c.metrics_1d : null;
                const metricLabel = c.measured_7d ? '7d' : c.measured_3d ? '3d' : c.measured_1d ? '1d' : null;
                const budgetChanged = c.current_budget > 0 && c.current_budget !== c.initial_budget;
                const roasVal = parseFloat(m?.roas_7d || 0);
                const roasColor = roasVal >= 2 ? '#10b981' : roasVal >= 1 ? '#f59e0b' : roasVal > 0 ? '#ef4444' : '#374151';

                return (
                  <div key={c._id} style={{
                    padding: '14px 16px', borderRadius: '12px', backgroundColor: '#0d1117',
                    border: `1px solid ${lc.color}25`
                  }}>
                    {/* Row 1: Type + Name + Status badges */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{
                        padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '700',
                        backgroundColor: isAdset ? '#8b5cf615' : '#ec489915',
                        color: isAdset ? '#a78bfa' : '#f9a8d4'
                      }}>
                        {isAdset ? 'Ad Set' : 'Ad'}
                      </span>
                      <span style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.meta_entity_name}
                      </span>
                      <span style={{
                        padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '700',
                        backgroundColor: lc.color + '18', color: lc.color,
                        border: `1px solid ${lc.color}30`
                      }}>
                        {lc.icon} {lc.label}
                      </span>
                      <span style={{
                        padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                        backgroundColor: c.current_status === 'ACTIVE' ? '#065f4620' : '#78350f20',
                        color: c.current_status === 'ACTIVE' ? '#10b981' : '#f59e0b'
                      }}>
                        {c.current_status || 'PAUSED'}
                      </span>
                      <span style={{
                        padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                        backgroundColor: v.bg, color: v.color
                      }}>
                        {v.label}
                      </span>
                    </div>

                    {/* Row 2: KPI Cards — visual metrics */}
                    {m ? (
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                        <div style={{
                          flex: 1, padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
                          backgroundColor: roasVal >= 2 ? '#065f460d' : roasVal >= 1 ? '#78350f0d' : '#7f1d1d0d',
                          border: `1px solid ${roasColor}20`
                        }}>
                          <div style={{ fontSize: '18px', fontWeight: '900', color: roasColor, lineHeight: 1 }}>
                            {roasVal.toFixed(2)}x
                          </div>
                          <div style={{ fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>ROAS {metricLabel}</div>
                        </div>
                        <div style={{
                          flex: 1, padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
                          backgroundColor: '#0d1117', border: '1px solid #1f2937'
                        }}>
                          <div style={{ fontSize: '18px', fontWeight: '900', color: '#93c5fd', lineHeight: 1 }}>
                            ${parseFloat(m.spend || 0).toFixed(0)}
                          </div>
                          <div style={{ fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>Spend</div>
                        </div>
                        <div style={{
                          flex: 1, padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
                          backgroundColor: '#0d1117', border: '1px solid #1f2937'
                        }}>
                          <div style={{ fontSize: '18px', fontWeight: '900', color: parseFloat(m.ctr || 0) >= 1.5 ? '#10b981' : '#e5e7eb', lineHeight: 1 }}>
                            {parseFloat(m.ctr || 0).toFixed(2)}%
                          </div>
                          <div style={{ fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>CTR</div>
                        </div>
                        <div style={{
                          flex: 1, padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
                          backgroundColor: (m.purchases || 0) > 0 ? '#065f460d' : '#0d1117',
                          border: `1px solid ${(m.purchases || 0) > 0 ? '#10b98120' : '#1f2937'}`
                        }}>
                          <div style={{ fontSize: '18px', fontWeight: '900', color: (m.purchases || 0) > 0 ? '#10b981' : '#374151', lineHeight: 1 }}>
                            {m.purchases || 0}
                          </div>
                          <div style={{ fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>Compras</div>
                        </div>
                        {isAdset && c.initial_budget > 0 && (
                          <div style={{
                            flex: 1, padding: '8px 10px', borderRadius: '8px', textAlign: 'center',
                            backgroundColor: budgetChanged ? '#065f460d' : '#0d1117',
                            border: `1px solid ${budgetChanged ? '#10b98120' : '#1f2937'}`
                          }}>
                            <div style={{ fontSize: '18px', fontWeight: '900', color: budgetChanged ? '#10b981' : '#e5e7eb', lineHeight: 1 }}>
                              ${c.current_budget || c.initial_budget}
                            </div>
                            <div style={{ fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>
                              Budget{budgetChanged ? ` (was $${c.initial_budget})` : '/d'}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', fontSize: '11px', color: '#4b5563' }}>
                        <span>Hace {daysAgo}d</span>
                        {isAdset && c.initial_budget > 0 && (
                          <span>Budget: <span style={{ color: '#10b981', fontWeight: '700' }}>
                            ${c.initial_budget}
                            {budgetChanged && <span style={{ color: '#f59e0b' }}> {'\u2192'} ${c.current_budget}</span>}
                          </span></span>
                        )}
                        <span style={{ color: '#374151' }}>Sin metricas aun</span>
                      </div>
                    )}

                    {/* Row 3: Rationale */}
                    <div style={{ fontSize: '10px', color: '#6b7280', lineHeight: '1.4' }}>
                      <span style={{ color: '#4b5563' }}>Hace {daysAgo}d | Padre: {c.parent_entity_name || c.parent_entity_id}</span>
                    </div>

                    {c.verdict_reason && c.verdict !== 'pending' && (
                      <div style={{ fontSize: '10px', color: v.color, marginTop: '4px', fontWeight: '600' }}>
                        {c.verdict_reason}
                      </div>
                    )}

                    {/* Lifecycle progress bar */}
                    {c.lifecycle_phase && c.lifecycle_phase !== 'dead' && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          {['created', 'activating', 'learning', 'evaluating'].map(phase => {
                            const phases = ['created', 'activating', 'learning', 'evaluating', 'scaling', 'stable', 'killing', 'dead'];
                            const currentIdx = phases.indexOf(c.lifecycle_phase);
                            const phaseIdx = phases.indexOf(phase);
                            const isDone = currentIdx > phaseIdx;
                            const isCurrent = c.lifecycle_phase === phase;
                            const phaseColor = lifecycleConfig[phase]?.color || '#374151';
                            return (
                              <div key={phase} style={{
                                flex: 1, height: '3px', borderRadius: '2px',
                                backgroundColor: isDone ? '#10b981' : isCurrent ? phaseColor : '#1f2937',
                                opacity: isCurrent ? 1 : 0.7
                              }} />
                            );
                          })}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: '#4b5563', marginTop: '2px' }}>
                          <span>Crear</span>
                          <span>Activar</span>
                          <span>Learning</span>
                          <span>Evaluar</span>
                        </div>
                      </div>
                    )}

                    {c.lifecycle_actions && c.lifecycle_actions.length > 0 && (
                      <div style={{ marginTop: '6px', padding: '6px 8px', borderRadius: '6px', backgroundColor: '#111827' }}>
                        <div style={{ fontSize: '9px', fontWeight: '700', color: '#4b5563', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          Acciones del Lifecycle
                        </div>
                        {c.lifecycle_actions.slice(-3).map((la, i) => (
                          <div key={i} style={{ fontSize: '10px', color: '#6b7280', lineHeight: '1.4' }}>
                            <span style={{
                              color: la.action === 'activate' ? '#3b82f6' : la.action === 'scale_up' ? '#10b981' : la.action === 'pause' ? '#ef4444' : '#9ca3af',
                              fontWeight: '600'
                            }}>
                              {la.action}
                            </span>
                            {la.value != null && <span style={{ color: '#9ca3af' }}> {typeof la.value === 'object' ? JSON.stringify(la.value) : `$${la.value}`}</span>}
                            {' '}<span style={{ color: '#4b5563' }}>{la.reason}</span>
                            <span style={{ color: '#374151' }}> | {timeAgo(la.executed_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        .rec-card:hover { border-color: #374151 !important; }

        @media (max-width: 768px) {
          .agents-header {
            flex-direction: column !important;
            align-items: flex-start !important;
          }
        }
      `}</style>

    </div>
  );
};

const AgentsPageWithBoundary = () => (
  <AgentsErrorBoundary>
    <AgentsPage />
  </AgentsErrorBoundary>
);

export default AgentsPageWithBoundary;
