import React, { useCallback, useEffect, useState } from 'react';
import {
  Rocket,
  Loader,
  CheckCircle,
  XCircle,
  DollarSign,
  Target,
  Image,
  Sparkles,
  AlertTriangle,
  Clock,
  TrendingUp,
  Eye,
  ChevronDown,
  ChevronRight,
  Activity,
  Radio,
  Play,
  Zap,
  Shield,
  Pause,
  Skull,
  Plus,
  Trash2,
  Brain,
  Timer,
  ArrowUpRight,
  ArrowDownRight,
  CircleDot
} from 'lucide-react';
import {
  strategizeAdSet,
  approveAdSet,
  rejectAdSet,
  getAdSetCreatorHistory,
  getCreativePreviewUrl,
  getManagerStatus,
  getManagerStatusLive,
  runAIManager,
  getManagerControlPanel
} from '../api';

// =============================================
// CONSTANTS
// =============================================

const RISK_COLORS = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };
const RISK_LABELS = { low: 'Bajo', medium: 'Medio', high: 'Alto' };
const VERDICT_COLORS = { pending: '#6b7280', positive: '#10b981', neutral: '#f59e0b', negative: '#ef4444' };
const VERDICT_LABELS = { pending: 'Pendiente', positive: 'Positivo', neutral: 'Neutral', negative: 'Negativo' };
const PHASE_COLORS = {
  created: '#6b7280', learning: '#f59e0b', evaluating: '#3b82f6',
  scaling: '#10b981', stable: '#10b981', killing: '#ef4444', dead: '#4b5563'
};
const PHASE_LABELS = {
  created: 'Creado', learning: 'Aprendiendo', evaluating: 'Evaluando',
  scaling: 'Escalando', stable: 'Estable', killing: 'Muriendo', dead: 'Muerto'
};
const FREQ_COLORS = { ok: '#10b981', moderate: '#f59e0b', high: '#f97316', critical: '#ef4444', unknown: '#6b7280' };
const FREQ_LABELS = { ok: 'OK', moderate: 'Moderada', high: 'Alta', critical: 'Critica', unknown: 'Sin datos' };
const TREND_COLORS = { improving: '#10b981', stable: '#3b82f6', declining: '#ef4444', learning: '#f59e0b', unknown: '#6b7280' };
const TREND_LABELS = { improving: 'Mejorando', stable: 'Estable', declining: 'Declinando', learning: 'Aprendiendo', unknown: 'Sin datos' };

const ACTION_ICONS = {
  create_and_activate: Plus,
  scale_budget: TrendingUp,
  pause_ad: Pause,
  add_ad: Plus,
  kill: Skull
};
const ACTION_COLORS = {
  create_and_activate: '#3b82f6',
  scale_budget: '#10b981',
  pause_ad: '#f59e0b',
  add_ad: '#c084fc',
  kill: '#ef4444'
};

// =============================================
// MAIN COMPONENT — state lives here so it persists across tabs
// =============================================

const AdSetCreator = () => {
  const [activeTab, setActiveTab] = useState('create');

  // Create tab state (lifted here to persist)
  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null); // full result with diagnosis + proposals[]
  const [approvedResults, setApprovedResults] = useState({}); // { proposalIdx: result }
  const [approvingIdx, setApprovingIdx] = useState(null);

  return (
    <div style={{ maxWidth: '1200px' }}>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '800', color: '#f3f4f6', margin: 0, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Rocket size={22} color="#c084fc" />
          Ad Sets IA
        </h1>
        <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>
          Claude crea, gestiona y optimiza ad sets de forma autonoma. Tu solo apruebas la creacion.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '2px', marginBottom: '20px', backgroundColor: '#0d1117', borderRadius: '10px', padding: '3px', border: '1px solid #1f2937' }}>
        <TabButton active={activeTab === 'create'} onClick={() => setActiveTab('create')} icon={Sparkles} label="Crear Ad Set" />
        <TabButton active={activeTab === 'manager'} onClick={() => setActiveTab('manager')} icon={Activity} label="AI Manager" />
      </div>

      {/* Use display:none instead of conditional render to persist state */}
      <div style={{ display: activeTab === 'create' ? 'block' : 'none' }}>
        <CreateTab
          loading={loading}
          setLoading={setLoading}
          analysisResult={analysisResult}
          setAnalysisResult={setAnalysisResult}
          approvedResults={approvedResults}
          setApprovedResults={setApprovedResults}
          approvingIdx={approvingIdx}
          setApprovingIdx={setApprovingIdx}
        />
      </div>
      <div style={{ display: activeTab === 'manager' ? 'block' : 'none' }}>
        <ManagerTab />
      </div>
    </div>
  );
};

// =============================================
// TAB BUTTON
// =============================================

const TabButton = ({ active, onClick, icon: Icon, label }) => (
  <button onClick={onClick} style={{
    flex: 1, padding: '9px 16px', borderRadius: '8px', border: 'none',
    backgroundColor: active ? '#1a1a2e' : 'transparent',
    color: active ? '#c084fc' : '#6b7280',
    fontSize: '13px', fontWeight: active ? '700' : '600',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    transition: 'all 0.15s ease'
  }}>
    <Icon size={15} />
    {label}
  </button>
);

// =============================================
// CREATE TAB
// =============================================

const CreateTab = ({
  loading, setLoading,
  analysisResult, setAnalysisResult,
  approvedResults, setApprovedResults,
  approvingIdx, setApprovingIdx
}) => {
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [expandedHistory, setExpandedHistory] = useState(null);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await getAdSetCreatorHistory();
      setHistory(data?.history || []);
    } catch (error) {
      console.error('Error cargando historial:', error);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleStrategize = async () => {
    setLoading(true);
    setAnalysisResult(null);
    setApprovedResults({});
    try {
      const data = await strategizeAdSet();
      setAnalysisResult(data.result);
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (proposalIdx) => {
    if (!analysisResult || !analysisResult.proposals[proposalIdx]) return;
    setApprovingIdx(proposalIdx);
    try {
      const proposal = analysisResult.proposals[proposalIdx];
      const result = await approveAdSet({
        proposal,
        campaign_id: analysisResult.campaign_id,
        campaign_name: analysisResult.campaign_name
      });
      setApprovedResults(prev => ({ ...prev, [proposalIdx]: result }));
      await fetchHistory();
    } catch (error) {
      alert(`Error creando ad set: ${error.response?.data?.error || error.message}`);
    } finally {
      setApprovingIdx(null);
    }
  };

  const handleReject = (proposalIdx) => {
    // Remove from proposals by marking as rejected
    setApprovedResults(prev => ({ ...prev, [proposalIdx]: { rejected: true } }));
    try { rejectAdSet(); } catch (e) { /* ignore */ }
  };

  const handleClearAll = () => {
    setAnalysisResult(null);
    setApprovedResults({});
  };

  const proposals = analysisResult?.proposals || [];
  const pendingProposals = proposals.filter((_, idx) => !approvedResults[idx]);
  const allDecided = proposals.length > 0 && pendingProposals.length === 0;

  return (
    <div>
      {/* Analyze Button — show when no analysis or all decided */}
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        {analysisResult && (
          <button onClick={handleClearAll} style={{
            padding: '9px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer',
            fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px',
            backgroundColor: '#1f2937', color: '#6b7280'
          }}>
            <Trash2 size={13} />
            Limpiar
          </button>
        )}
        {!loading && (
          <button onClick={handleStrategize} style={{
            padding: '11px 22px', borderRadius: '10px', border: 'none', cursor: 'pointer',
            fontSize: '14px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px',
            backgroundColor: '#581c87', color: '#c084fc',
            boxShadow: '0 4px 14px rgba(88, 28, 135, 0.3)'
          }}>
            <Sparkles size={16} />
            {analysisResult ? 'Nuevo Analisis' : 'Analizar y Proponer'}
          </button>
        )}
      </div>

      {/* Loading State */}
      {loading && (
        <div style={{
          padding: '60px', textAlign: 'center', backgroundColor: '#111827',
          borderRadius: '14px', border: '1px solid #1f2937'
        }}>
          <Loader size={36} className="spin" color="#c084fc" style={{ marginBottom: '16px' }} />
          <div style={{ fontSize: '16px', fontWeight: '700', color: '#c084fc', marginBottom: '8px' }}>
            Claude analizando cuenta y creativos...
          </div>
          <div style={{ fontSize: '12px', color: '#6b7280', lineHeight: '1.5' }}>
            Revisando banco creativo, performance de ad sets, frecuencia, historial de IA.<br />
            Esto puede tomar 30-90 segundos.
          </div>
        </div>
      )}

      {/* Analysis Result */}
      {analysisResult && !loading && (
        <div>
          {/* Shared Diagnosis */}
          {analysisResult.diagnosis && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#6b7280', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Eye size={13} />
                Diagnostico de Cuenta
                <span style={{ fontSize: '10px', fontWeight: '500', color: '#4b5563' }}>
                  — {analysisResult.analysis_time_s}s | {analysisResult.creatives_in_bank} creativos | ROAS cuenta: {analysisResult.account_roas}x
                  {analysisResult.fatigued_adsets > 0 && (
                    <span style={{ color: '#f59e0b' }}> | {analysisResult.fatigued_adsets} con fatiga</span>
                  )}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
                {analysisResult.diagnosis.frequency_alert && (
                  <DiagnosisCard icon={Radio} color="#f59e0b" title="Frecuencia" text={analysisResult.diagnosis.frequency_alert} />
                )}
                {analysisResult.diagnosis.scaling_opportunity && (
                  <DiagnosisCard icon={TrendingUp} color="#10b981" title="Escalamiento" text={analysisResult.diagnosis.scaling_opportunity} />
                )}
                {analysisResult.diagnosis.creative_bank_health && (
                  <DiagnosisCard icon={Image} color="#c084fc" title="Banco Creativo" text={analysisResult.diagnosis.creative_bank_health} />
                )}
                {analysisResult.diagnosis.recommendation_for_existing && (
                  <DiagnosisCard icon={Shield} color="#3b82f6" title="Ad Sets Existentes" text={analysisResult.diagnosis.recommendation_for_existing} />
                )}
              </div>
            </div>
          )}

          {/* Creatives Need Alert */}
          {analysisResult.needs_new_creatives && (
            <div style={{
              padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
              backgroundColor: '#f59e0b10', border: '1px solid #f59e0b30',
              display: 'flex', alignItems: 'center', gap: '8px'
            }}>
              <AlertTriangle size={14} color="#f59e0b" />
              <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: '600' }}>
                Se necesitan nuevos creativos.
              </span>
              {analysisResult.suggested_creative_styles?.length > 0 && (
                <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                  Estilos sugeridos: {analysisResult.suggested_creative_styles.join(', ')}
                </span>
              )}
            </div>
          )}

          {/* Notes */}
          {analysisResult.notes && (
            <div style={{
              padding: '8px 14px', borderRadius: '8px', backgroundColor: '#0d1117',
              border: '1px solid #1f2937', marginBottom: '14px',
              fontSize: '11px', color: '#9ca3af', lineHeight: '1.4'
            }}>
              <span style={{ fontWeight: '600', color: '#6b7280' }}>Notas: </span>
              {analysisResult.notes}
            </div>
          )}

          {/* Proposals Header */}
          <div style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Rocket size={14} color="#c084fc" />
            {proposals.length} Propuestas
            {allDecided && <span style={{ fontSize: '10px', color: '#4b5563', fontWeight: '500' }}> — Todas decididas</span>}
          </div>

          {/* Proposal Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
            {proposals.map((proposal, idx) => {
              const result = approvedResults[idx];
              const isApproving = approvingIdx === idx;
              const isApproved = result && !result.rejected;
              const isRejected = result?.rejected;

              return (
                <ProposalCard
                  key={idx}
                  idx={idx}
                  proposal={proposal}
                  isApproving={isApproving}
                  isApproved={isApproved}
                  isRejected={isRejected}
                  approveResult={isApproved ? result : null}
                  onApprove={() => handleApprove(idx)}
                  onReject={() => handleReject(idx)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* History Section */}
      <div style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
          <Clock size={14} color="#6b7280" />
          <span style={{ fontSize: '14px', fontWeight: '700', color: '#e5e7eb' }}>
            Historial de Creaciones
          </span>
          <span style={{ fontSize: '11px', color: '#4b5563' }}>({history.length})</span>
        </div>

        {historyLoading ? (
          <div style={{ padding: '30px', textAlign: 'center' }}><Loader size={18} className="spin" color="#6b7280" /></div>
        ) : history.length === 0 ? (
          <div style={{
            padding: '40px', textAlign: 'center', color: '#4b5563', fontSize: '13px',
            backgroundColor: '#111827', borderRadius: '10px', border: '1px solid #1f2937'
          }}>
            No hay ad sets creados por IA todavia.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {history.map(item => {
              const isExpanded = expandedHistory === item._id;
              return (
                <HistoryCard
                  key={item._id}
                  item={item}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedHistory(isExpanded ? null : item._id)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// =============================================
// PROPOSAL CARD
// =============================================

const ProposalCard = ({ idx, proposal, isApproving, isApproved, isRejected, approveResult, onApprove, onReject }) => {
  const [expanded, setExpanded] = useState(true);
  const [liveData, setLiveData] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [showActions, setShowActions] = useState(false);

  // Fetch live status for this approved ad set
  const fetchLiveStatus = useCallback(async () => {
    if (!isApproved || !approveResult?.ai_creation_id) return;
    setLiveLoading(true);
    try {
      const data = await getManagerStatus();
      const match = (data?.managed || []).find(m =>
        m.adset_id === approveResult.adset_id || m._id === approveResult.ai_creation_id
      );
      if (match) setLiveData(match);
    } catch (e) {
      console.error('Error fetching live status:', e);
    } finally {
      setLiveLoading(false);
    }
  }, [isApproved, approveResult]);

  useEffect(() => {
    if (isApproved && approveResult?.ai_creation_id) {
      fetchLiveStatus();
      const interval = setInterval(fetchLiveStatus, 120000); // refresh every 2 min
      return () => clearInterval(interval);
    }
  }, [isApproved, approveResult, fetchLiveStatus]);

  // Decided state — rich detail for approved, collapsed for rejected
  if (isApproved || isRejected) {
    if (isRejected) {
      return (
        <div style={{
          backgroundColor: '#111827', borderRadius: '10px',
          border: '1px solid #37415740', padding: '12px 16px', opacity: 0.5
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <XCircle size={16} color="#6b7280" />
            <span style={{ fontSize: '13px', fontWeight: '700', color: '#6b7280' }}>{proposal.adset_name}</span>
            <Badge color="#6b7280" label="Rechazado" />
          </div>
        </div>
      );
    }

    const phase = liveData?.phase || 'learning';
    const phaseColor = PHASE_COLORS[phase] || '#6b7280';
    const actions = liveData?.lifecycle_actions || [];
    const budget = liveData?.budget || approveResult?.daily_budget;

    return (
      <div style={{
        backgroundColor: '#111827', borderRadius: '12px',
        border: `1px solid ${phaseColor}30`, overflow: 'hidden'
      }}>
        {/* Header */}
        <div
          onClick={() => setShowActions(!showActions)}
          style={{
            padding: '14px 16px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '10px'
          }}
        >
          {showActions ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
          <CheckCircle size={16} color="#10b981" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {proposal.adset_name}
            </div>
            <div style={{ fontSize: '10px', color: '#4b5563' }}>
              ID: {approveResult.adset_id} | {approveResult.ads_created} ads
              {liveData && ` | ${liveData.days_active?.toFixed(0) || 0}d activo | ${liveData.actions_count || 0} acciones IA`}
            </div>
          </div>
          <Badge color="#10b981" label="Activo" />
          <Badge color={phaseColor} label={PHASE_LABELS[phase] || phase} />
          {liveData?.last_frequency_status && (
            <Badge color={FREQ_COLORS[liveData.last_frequency_status]} label={`Freq: ${FREQ_LABELS[liveData.last_frequency_status] || '?'}`} />
          )}
          {liveData?.verdict && liveData.verdict !== 'pending' && (
            <Badge color={VERDICT_COLORS[liveData.verdict]} label={VERDICT_LABELS[liveData.verdict]} />
          )}
          <span style={{ fontSize: '14px', fontWeight: '800', color: budget > approveResult.daily_budget ? '#10b981' : '#e5e7eb' }}>
            ${budget}/d
          </span>
          {liveLoading && <Loader size={12} className="spin" color="#4b5563" />}
        </div>

        {/* Expanded — live metrics + action timeline */}
        {showActions && (
          <div style={{ padding: '0 16px 16px', borderTop: '1px solid #1f2937' }}>
            {/* Metrics row */}
            {liveData && (liveData.metrics_1d || liveData.metrics_3d || liveData.metrics_7d) && (
              <div style={{ paddingTop: '14px', marginBottom: '14px' }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '8px' }}>Metricas</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  <MetricsSnapshot label="1 Dia" metrics={liveData.metrics_1d} />
                  <MetricsSnapshot label="3 Dias" metrics={liveData.metrics_3d} />
                  <MetricsSnapshot label="7 Dias" metrics={liveData.metrics_7d} />
                </div>
              </div>
            )}

            {/* Last assessment */}
            {liveData?.last_assessment && (
              <div style={{
                padding: '10px 14px', borderRadius: '8px', backgroundColor: '#0d1117',
                border: '1px solid #1f2937', marginBottom: '12px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                  <Eye size={12} color="#c084fc" />
                  <span style={{ fontSize: '10px', fontWeight: '700', color: '#c084fc' }}>Ultimo Assessment del Manager</span>
                  {liveData.last_check && (
                    <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: 'auto' }}>
                      {new Date(liveData.last_check).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5' }}>{liveData.last_assessment}</div>
              </div>
            )}

            {/* Learning phase indicator */}
            {liveData?.learning_ends_at && phase === 'learning' && (
              <div style={{
                padding: '8px 14px', borderRadius: '8px', backgroundColor: '#f59e0b08',
                border: '1px solid #f59e0b20', marginBottom: '12px',
                display: 'flex', alignItems: 'center', gap: '8px'
              }}>
                <Clock size={12} color="#f59e0b" />
                <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: '600' }}>
                  Learning — el Manager no toca nada hasta: {new Date(liveData.learning_ends_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}

            {/* Action timeline */}
            {actions.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '8px' }}>
                  Timeline de Acciones del Manager ({actions.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
                  {[...actions].reverse().map((a, i) => {
                    const ActionIcon = ACTION_ICONS[a.action] || Zap;
                    const actionColor = ACTION_COLORS[a.action] || '#6b7280';
                    return (
                      <div key={i} style={{
                        padding: '8px 12px', borderRadius: '6px', backgroundColor: '#0d1117',
                        border: '1px solid #1f2937',
                        display: 'flex', alignItems: 'flex-start', gap: '10px'
                      }}>
                        <ActionIcon size={12} color={actionColor} style={{ marginTop: '2px', flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                            <span style={{ fontSize: '11px', fontWeight: '700', color: actionColor }}>
                              {a.action.replace(/_/g, ' ')}
                            </span>
                            {a.value && typeof a.value === 'number' && (
                              <span style={{ fontSize: '10px', color: '#e5e7eb', fontWeight: '600' }}>${a.value}</span>
                            )}
                            {a.value && typeof a.value === 'object' && a.value.budget && (
                              <span style={{ fontSize: '10px', color: '#e5e7eb', fontWeight: '600' }}>
                                ${a.value.budget} | {a.value.ads} ads
                              </span>
                            )}
                            <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: 'auto' }}>
                              {a.executed_at && new Date(a.executed_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          {a.reason && (
                            <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.3' }}>{a.reason}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No actions yet */}
            {actions.length <= 1 && phase === 'learning' && (
              <div style={{
                padding: '20px', textAlign: 'center', fontSize: '11px', color: '#4b5563',
                backgroundColor: '#0d1117', borderRadius: '8px', border: '1px solid #1f2937'
              }}>
                El Manager revisara este ad set automaticamente cada 8 horas. Durante learning phase no tomara acciones.
              </div>
            )}

            {/* Refresh button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button onClick={fetchLiveStatus} disabled={liveLoading} style={{
                padding: '5px 12px', borderRadius: '6px', border: 'none',
                backgroundColor: '#1f2937', color: '#6b7280',
                fontSize: '10px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '4px'
              }}>
                {liveLoading ? <Loader size={10} className="spin" /> : <Activity size={10} />}
                Actualizar
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      backgroundColor: '#111827', borderRadius: '12px',
      border: '1px solid #581c8730', overflow: 'hidden'
    }}>
      {/* Proposal Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '10px'
        }}
      >
        {expanded ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
        <span style={{
          padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '800',
          backgroundColor: '#581c8730', color: '#c084fc', minWidth: '20px', textAlign: 'center'
        }}>
          #{idx + 1}
        </span>
        {/* Product thumbnail */}
        {proposal.product_reference_filename && (
          <div style={{
            width: '38px', height: '38px', borderRadius: '7px', overflow: 'hidden',
            flexShrink: 0, backgroundColor: '#0a0a0a', border: '1px solid #f59e0b40'
          }}>
            <img
              src={getCreativePreviewUrl(proposal.product_reference_filename)}
              alt={proposal.product_name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: '800', color: '#e5e7eb' }}>{proposal.adset_name}</div>
          <div style={{ fontSize: '10px', color: '#4b5563' }}>
            {proposal.product_name && (
              <span style={{ color: '#c084fc', fontWeight: '600' }}>{proposal.product_name} | </span>
            )}
            ${proposal.daily_budget}/dia | {proposal.selected_creatives.length} creativos | {proposal.selected_creatives.reduce((sum, s) => sum + (s.headlines?.length || 1), 0)} ads
          </div>
        </div>
        <Badge color={RISK_COLORS[proposal.risk_assessment]} label={`Riesgo: ${RISK_LABELS[proposal.risk_assessment]}`} />
        <span style={{ fontSize: '20px', fontWeight: '800', color: '#10b981' }}>
          ${proposal.daily_budget}
        </span>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #1f2937' }}>
          {/* Strategy */}
          <div style={{ paddingTop: '12px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <Target size={12} color="#c084fc" />
              <span style={{ fontSize: '10px', fontWeight: '700', color: '#c084fc' }}>Estrategia</span>
            </div>
            <div style={{ fontSize: '12px', color: '#e5e7eb', lineHeight: '1.5', marginBottom: '6px' }}>
              {proposal.strategy_summary}
            </div>
            <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.4' }}>
              <span style={{ fontWeight: '600', color: '#f59e0b' }}>Resultado esperado: </span>
              {proposal.expected_outcome}
            </div>
            {proposal.budget_rationale && (
              <div style={{ fontSize: '10px', color: '#4b5563', marginTop: '4px' }}>
                <span style={{ fontWeight: '600' }}>Budget: </span>{proposal.budget_rationale}
              </div>
            )}
          </div>

          {/* Creatives Grid */}
          <div style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <Image size={12} color="#c084fc" />
              <span style={{ fontSize: '10px', fontWeight: '700', color: '#c084fc' }}>
                {proposal.selected_creatives.length} Creativos
              </span>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(proposal.selected_creatives.length, 5)}, 1fr)`,
              gap: '8px'
            }}>
              {proposal.selected_creatives.map((sel, i) => (
                <div key={i} style={{
                  borderRadius: '8px', overflow: 'hidden',
                  border: '1px solid #1f2937', backgroundColor: '#0d1117'
                }}>
                  <div style={{
                    height: '120px', backgroundColor: '#0a0a0a',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    {sel.asset_filename && (
                      <img
                        src={getCreativePreviewUrl(sel.asset_filename)}
                        alt={sel.headline}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                  <div style={{ padding: '6px 8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
                      {sel.asset_style && (
                        <span style={{
                          padding: '2px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700',
                          backgroundColor: '#581c8720', color: '#c084fc', display: 'inline-block'
                        }}>
                          {sel.asset_style}
                        </span>
                      )}
                      <span style={{
                        padding: '2px 6px', borderRadius: '3px',
                        backgroundColor: '#1e3a8a20', color: '#93c5fd',
                        fontSize: '8px', fontWeight: '700', display: 'inline-block'
                      }}>
                        {sel.cta}
                      </span>
                      {sel.asset_ad_format && (
                        <span style={{
                          padding: '2px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700',
                          backgroundColor: sel.asset_ad_format === 'feed' ? '#3b82f615' : '#f59e0b15',
                          color: sel.asset_ad_format === 'feed' ? '#3b82f6' : '#f59e0b',
                          display: 'inline-block'
                        }}>
                          {sel.asset_ad_format === 'feed' ? '1:1' : '9:16'}
                        </span>
                      )}
                      {(sel.headlines?.length || 0) > 1 && (
                        <span style={{
                          padding: '2px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700',
                          backgroundColor: '#10b98115', color: '#10b981', display: 'inline-block'
                        }}>
                          {sel.headlines.length} variants
                        </span>
                      )}
                    </div>
                    {/* Show all headline+body variants */}
                    {(sel.headlines && sel.headlines.length > 1) ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {sel.headlines.map((h, vi) => (
                          <div key={vi} style={{
                            padding: '3px 5px', borderRadius: '4px',
                            backgroundColor: vi === 0 ? '#1f293750' : '#0d111730',
                            borderLeft: `2px solid ${vi === 0 ? '#c084fc' : '#374151'}`
                          }}>
                            <div style={{ fontSize: '9px', fontWeight: '700', color: '#e5e7eb', lineHeight: '1.2' }}>
                              {h}
                            </div>
                            {sel.bodies?.[vi] && (
                              <div style={{ fontSize: '8px', color: '#9ca3af', marginTop: '1px', lineHeight: '1.2', maxHeight: '22px', overflow: 'hidden' }}>
                                {sel.bodies[vi]}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: '10px', fontWeight: '700', color: '#e5e7eb', lineHeight: '1.2' }}>
                          {sel.headlines?.[0] || sel.headline}
                        </div>
                        <div style={{ fontSize: '9px', color: '#9ca3af', marginTop: '3px', lineHeight: '1.2', maxHeight: '32px', overflow: 'hidden' }}>
                          {sel.bodies?.[0] || sel.body}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={onReject} disabled={isApproving} style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              backgroundColor: '#1f2937', color: '#9ca3af',
              fontSize: '12px', fontWeight: '700', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px'
            }}>
              <XCircle size={13} /> Rechazar
            </button>
            <button onClick={onApprove} disabled={isApproving} style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              backgroundColor: isApproving ? '#374151' : '#065f46',
              color: isApproving ? '#6b7280' : '#6ee7b7',
              fontSize: '12px', fontWeight: '700',
              cursor: isApproving ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px',
              boxShadow: isApproving ? 'none' : '0 4px 14px rgba(6, 95, 70, 0.3)'
            }}>
              {isApproving ? <Loader size={13} className="spin" /> : <CheckCircle size={13} />}
              {isApproving ? 'Creando...' : 'Aprobar y Crear'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// =============================================
// HISTORY CARD
// =============================================

const HistoryCard = ({ item, isExpanded, onToggle }) => (
  <div style={{
    backgroundColor: '#111827', borderRadius: '10px',
    border: `1px solid ${PHASE_COLORS[item.lifecycle_phase] || '#1f2937'}25`,
    overflow: 'hidden'
  }}>
    <div onClick={onToggle} style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px' }}>
      {isExpanded ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '13px', fontWeight: '700', color: '#e5e7eb' }}>{item.meta_entity_name}</div>
        <div style={{ fontSize: '10px', color: '#4b5563' }}>
          {new Date(item.created_at).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}
          {' | '}ID: {item.meta_entity_id}
        </div>
      </div>
      <Badge color={PHASE_COLORS[item.lifecycle_phase]} label={item.lifecycle_phase} />
      <Badge color={item.current_status === 'ACTIVE' ? '#10b981' : '#6b7280'} label={item.current_status} />
      <Badge color={VERDICT_COLORS[item.verdict]} label={VERDICT_LABELS[item.verdict] || item.verdict} />
      <span style={{ fontSize: '12px', fontWeight: '700', color: '#10b981' }}>
        ${item.current_budget || item.initial_budget}/d
      </span>
    </div>

    {isExpanded && (
      <div style={{ padding: '0 16px 14px', borderTop: '1px solid #1f2937' }}>
        <div style={{ paddingTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
          <MiniMetric label="Budget Inicial" value={`$${item.initial_budget}`} />
          <MiniMetric label="Ads" value={item.child_ad_ids?.length || 0} />
          <MiniMetric
            label="ROAS 7d"
            value={item.metrics_7d?.roas_7d ? `${item.metrics_7d.roas_7d.toFixed(1)}x` : '-'}
            color={item.metrics_7d?.roas_7d > 2 ? '#10b981' : item.metrics_7d?.roas_7d > 1 ? '#f59e0b' : '#6b7280'}
          />
          <MiniMetric label="Spend 7d" value={item.metrics_7d?.spend ? `$${item.metrics_7d.spend.toFixed(0)}` : '-'} />
        </div>
        {item.strategy_summary && (
          <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.4', marginBottom: '8px' }}>
            <span style={{ fontWeight: '600', color: '#c084fc' }}>Estrategia: </span>{item.strategy_summary}
          </div>
        )}
        {item.learning_ends_at && (
          <div style={{ fontSize: '10px', color: '#f59e0b' }}>
            Learning termina: {new Date(item.learning_ends_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        {item.lifecycle_actions && item.lifecycle_actions.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Acciones del AI Manager:</div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {item.lifecycle_actions.map((a, i) => (
                <span key={i} style={{
                  padding: '2px 6px', borderRadius: '3px', fontSize: '9px', fontWeight: '600',
                  backgroundColor: '#1f2937', color: '#9ca3af'
                }}>
                  {a.action} — {a.reason?.substring(0, 40)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    )}
  </div>
);

// =============================================
// MANAGER TAB
// =============================================

const ManagerTab = () => {
  const [managed, setManaged] = useState([]);
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [controlPanel, setControlPanel] = useState(null);
  const [countdown, setCountdown] = useState({ brain: '', manager: '' });

  const fetchStatus = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [liveData, cpData] = await Promise.all([
        getManagerStatusLive().catch(() => null),
        getManagerControlPanel().catch(() => null)
      ]);
      if (liveData) {
        setManaged(liveData?.managed || []);
        setCampaign(liveData?.campaign || null);
      } else {
        const fallback = await getManagerStatus().catch(() => null);
        setManaged(fallback?.managed || []);
      }
      if (cpData) setControlPanel(cpData);
    } catch (error) {
      console.error('Error cargando status del manager:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => fetchStatus(false), 120000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Countdown timer
  useEffect(() => {
    if (!controlPanel?.cycles) return;
    const tick = () => {
      const now = Date.now();
      const brainNext = controlPanel.cycles.brain.next_run ? new Date(controlPanel.cycles.brain.next_run).getTime() : 0;
      const managerNext = controlPanel.cycles.manager.next_run ? new Date(controlPanel.cycles.manager.next_run).getTime() : 0;
      const fmt = (ms) => {
        if (ms <= 0) return 'Ahora';
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
      };
      setCountdown({
        brain: fmt(brainNext - now),
        manager: fmt(managerNext - now)
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [controlPanel]);

  const handleRunManager = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const result = await runAIManager();
      setRunResult(result);
      await fetchStatus(true);
    } catch (error) {
      alert(`Error ejecutando manager: ${error.response?.data?.error || error.message}`);
    } finally {
      setRunning(false);
    }
  };

  const activeCount = managed.filter(m => m.status === 'ACTIVE').length;
  const deadCount = managed.filter(m => m.phase === 'dead').length;
  const fatiguedCount = managed.filter(m => m.last_frequency_status === 'high' || m.last_frequency_status === 'critical').length;
  const cp = controlPanel;

  return (
    <div>
      {/* ═══ CONTROL PANEL — Cycle Timers ═══ */}
      <div style={{
        padding: '16px', borderRadius: '12px', marginBottom: '16px',
        backgroundColor: '#0d1117', border: '1px solid #1f2937'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
          <Timer size={14} color="#c084fc" />
          <span style={{ fontSize: '13px', fontWeight: '800', color: '#c084fc' }}>Panel de Control</span>
          <span style={{
            marginLeft: 'auto', padding: '3px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: '700',
            backgroundColor: activeCount > 0 ? '#10b98118' : '#6b728018',
            color: activeCount > 0 ? '#10b981' : '#6b7280'
          }}>
            {activeCount > 0 ? 'AUTOMATIZACION ACTIVA' : 'SIN AD SETS ACTIVOS'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
          {/* Brain Cycle */}
          <div style={{
            padding: '12px 14px', borderRadius: '10px',
            backgroundColor: '#111827', border: '1px solid #c084fc20'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <Brain size={14} color="#c084fc" />
              <span style={{ fontSize: '12px', fontWeight: '700', color: '#c084fc' }}>Brain (Analisis)</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>Ultimo ciclo</div>
                <div style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb' }}>
                  {cp?.cycles?.brain?.last_run
                    ? new Date(cp.cycles.brain.last_run).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
                    : 'Sin datos'}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>Proximo en</div>
                <div style={{ fontSize: '11px', fontWeight: '800', color: '#c084fc' }}>
                  {countdown.brain || '-'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: '9px', color: '#4b5563' }}>
              {cp?.cycles?.brain?.schedule || 'Cada 30 min (:15 y :45)'}
            </div>
            {cp?.cycles?.brain?.last_actions && (
              <div style={{ fontSize: '9px', color: '#6b7280', marginTop: '4px' }}>
                Ultimo: {cp.cycles.brain.last_actions.total} recomendaciones, {cp.cycles.brain.last_actions.executed} ejecutadas
              </div>
            )}
          </div>

          {/* Manager Cycle */}
          <div style={{
            padding: '12px 14px', borderRadius: '10px',
            backgroundColor: '#111827', border: '1px solid #3b82f620'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <Activity size={14} color="#3b82f6" />
              <span style={{ fontSize: '12px', fontWeight: '700', color: '#3b82f6' }}>AI Manager (Ejecucion)</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>Ultimo ciclo</div>
                <div style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb' }}>
                  {cp?.cycles?.manager?.last_run
                    ? new Date(cp.cycles.manager.last_run).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
                    : 'Sin datos'}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>Proximo en</div>
                <div style={{ fontSize: '11px', fontWeight: '800', color: '#3b82f6' }}>
                  {countdown.manager || '-'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: '9px', color: '#4b5563' }}>
              {cp?.cycles?.manager?.schedule || 'Cada 8 horas (0:00, 8:00, 16:00)'}
            </div>
          </div>
        </div>

        {/* Summary badges + action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <SummaryBadge label="Activos" value={activeCount} color="#10b981" />
            <SummaryBadge label="Total" value={managed.length} color="#3b82f6" />
            {cp?.directives_total > 0 && <SummaryBadge label="Directivas Brain" value={cp.directives_total} color="#c084fc" />}
            {fatiguedCount > 0 && <SummaryBadge label="Con Fatiga" value={fatiguedCount} color="#f59e0b" />}
            {deadCount > 0 && <SummaryBadge label="Muertos" value={deadCount} color="#6b7280" />}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => fetchStatus(true)} disabled={refreshing} style={{
              padding: '8px 12px', borderRadius: '8px', border: 'none',
              backgroundColor: '#1f2937', color: '#6b7280',
              fontSize: '11px', fontWeight: '600', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px'
            }}>
              {refreshing ? <Loader size={12} className="spin" /> : <Activity size={12} />}
              Refresh
            </button>
            <button onClick={handleRunManager} disabled={running} style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              backgroundColor: running ? '#374151' : '#1e3a8a',
              color: running ? '#6b7280' : '#93c5fd',
              fontSize: '11px', fontWeight: '700',
              cursor: running ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px'
            }}>
              {running ? <Loader size={13} className="spin" /> : <Play size={13} />}
              {running ? 'Ejecutando...' : 'Ejecutar Manager'}
            </button>
          </div>
        </div>
      </div>

      {/* Campaign Metrics */}
      {campaign && (
        <div style={{
          padding: '14px 16px', borderRadius: '10px', marginBottom: '16px',
          backgroundColor: '#111827', border: '1px solid #3b82f625'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Target size={14} color="#3b82f6" />
            <span style={{ fontSize: '13px', fontWeight: '700', color: '#3b82f6' }}>
              Campana: {campaign.campaign_name || campaign.campaign_id}
            </span>
            <span style={{ fontSize: '10px', color: '#4b5563' }}>7 dias</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
            <MiniMetric label="Spend" value={`$${campaign.spend?.toFixed(2) || '0'}`} />
            <MiniMetric label="ROAS" value={`${campaign.roas?.toFixed(2) || '0'}x`}
              color={campaign.roas >= 2 ? '#10b981' : campaign.roas >= 1 ? '#f59e0b' : '#ef4444'} />
            <MiniMetric label="Clicks" value={campaign.clicks?.toLocaleString() || '0'} />
            <MiniMetric label="CTR" value={`${campaign.ctr?.toFixed(2) || '0'}%`} />
            <MiniMetric label="Compras" value={campaign.purchases || 0} color={campaign.purchases > 0 ? '#10b981' : '#e5e7eb'} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: '8px' }}>
            <MiniMetric label="Impresiones" value={campaign.impressions?.toLocaleString() || '0'} />
            <MiniMetric label="Alcance" value={campaign.reach?.toLocaleString() || '0'} />
            <MiniMetric label="Frecuencia" value={campaign.frequency?.toFixed(2) || '0'}
              color={campaign.frequency > 3 ? '#ef4444' : campaign.frequency > 2.5 ? '#f59e0b' : '#10b981'} />
            <MiniMetric label="Valor Compras" value={`$${campaign.purchase_value?.toFixed(2) || '0'}`} color="#10b981" />
          </div>
        </div>
      )}

      {/* Run Result */}
      {runResult && (
        <div style={{
          padding: '14px 16px', borderRadius: '10px', marginBottom: '16px',
          backgroundColor: '#111827', border: '1px solid #1e3a8a40'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Zap size={14} color="#93c5fd" />
            <span style={{ fontSize: '13px', fontWeight: '700', color: '#93c5fd' }}>
              Manager ejecutado: {runResult.managed} gestionados, {runResult.actions_taken} acciones
            </span>
          </div>
          {runResult.results && runResult.results.map((r, i) => (
            <div key={i} style={{
              padding: '8px 12px', borderRadius: '6px', backgroundColor: '#0d1117',
              border: '1px solid #1f2937', marginBottom: '6px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb' }}>{r.adset_name}</span>
                {r.actions_executed > 0 && (
                  <span style={{
                    padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                    backgroundColor: '#10b98115', color: '#10b981'
                  }}>
                    {r.actions_executed} acciones
                  </span>
                )}
                {r.frequency_status && (
                  <Badge color={FREQ_COLORS[r.frequency_status]} label={`Freq: ${FREQ_LABELS[r.frequency_status]}`} />
                )}
                {r.performance_trend && (
                  <Badge color={TREND_COLORS[r.performance_trend]} label={TREND_LABELS[r.performance_trend]} />
                )}
              </div>
              {r.assessment && (
                <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.4' }}>{r.assessment}</div>
              )}
              {r.error && (
                <div style={{ fontSize: '10px', color: '#fca5a5' }}>Error: {r.error}</div>
              )}
            </div>
          ))}
          <button onClick={() => setRunResult(null)} style={{
            marginTop: '6px', padding: '4px 10px', borderRadius: '4px',
            border: 'none', backgroundColor: '#1f2937', color: '#6b7280',
            fontSize: '10px', fontWeight: '600', cursor: 'pointer'
          }}>
            Cerrar
          </button>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ padding: '40px', textAlign: 'center' }}>
          <Loader size={20} className="spin" color="#6b7280" />
          <div style={{ fontSize: '11px', color: '#4b5563', marginTop: '8px' }}>Cargando metricas live de Meta...</div>
        </div>
      ) : managed.length === 0 ? (
        <div style={{
          padding: '50px', textAlign: 'center', color: '#4b5563', fontSize: '13px',
          backgroundColor: '#111827', borderRadius: '10px', border: '1px solid #1f2937'
        }}>
          No hay ad sets gestionados por IA. Crea uno en la pestana "Crear Ad Set".
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {managed.map(item => {
            const isExpanded = expandedId === item._id;
            return (
              <ManagedAdSetCard
                key={item._id}
                item={item}
                isExpanded={isExpanded}
                onToggle={() => setExpandedId(isExpanded ? null : item._id)}
                directives={cp?.directives?.[item.adset_id] || []}
                brainActions={cp?.brain_actions?.[item.adset_id] || []}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

// =============================================
// MANAGED AD SET CARD
// =============================================

const DIRECTIVE_COLORS = { boost: '#10b981', suppress: '#ef4444', override: '#f59e0b', protect: '#3b82f6' };
const DIRECTIVE_ICONS = { boost: ArrowUpRight, suppress: ArrowDownRight, override: AlertTriangle, protect: Shield };
const BRAIN_ACTION_COLORS = {
  scale_up: '#10b981', scale_down: '#f59e0b', pause: '#ef4444', reactivate: '#3b82f6',
  duplicate_adset: '#c084fc', create_ad: '#c084fc', update_bid_strategy: '#6366f1',
  update_ad_status: '#f59e0b', move_budget: '#3b82f6', update_ad_creative: '#c084fc'
};

const ManagedAdSetCard = ({ item, isExpanded, onToggle, directives = [], brainActions = [] }) => {
  const phaseColor = PHASE_COLORS[item.phase] || '#6b7280';

  // Use live metrics from Meta API when available, otherwise fallback to DB snapshot metrics
  const dbMetrics = item.metrics_7d || item.metrics_3d || item.metrics_1d || null;
  const dbFallback = dbMetrics ? {
    roas: dbMetrics.roas_7d || 0,
    spend: dbMetrics.spend || 0,
    impressions: dbMetrics.impressions || 0,
    clicks: 0,
    ctr: dbMetrics.ctr || 0,
    cpm: 0,
    cpc: 0,
    reach: 0,
    frequency: dbMetrics.frequency || 0,
    purchases: dbMetrics.purchases || 0,
    purchase_value: 0,
    cpa: 0,
    _fromDb: true
  } : null;
  const live = item.live_metrics_7d || dbFallback;
  const live3d = item.live_metrics_3d || (item.metrics_3d ? {
    roas: item.metrics_3d.roas_7d || 0,
    spend: item.metrics_3d.spend || 0,
    ctr: item.metrics_3d.ctr || 0,
    frequency: item.metrics_3d.frequency || 0,
    purchases: item.metrics_3d.purchases || 0,
    _fromDb: true
  } : null);
  const isLive = !!item.live_metrics_7d;
  const liveFreq = live?.frequency || 0;
  const liveFreqLevel = liveFreq > 4 ? 'critical' : liveFreq > 3 ? 'high' : liveFreq > 2.5 ? 'moderate' : 'ok';
  const ads = item.ads_performance || [];
  const hasDirectives = directives.length > 0;
  const hasBrainActions = brainActions.length > 0;
  const [showAssessment, setShowAssessment] = useState(false);

  // Learning progress calculation
  const learningProgress = (() => {
    if (item.phase !== 'learning' || !item.learning_ends_at || !item.created_at) return null;
    const start = new Date(item.created_at).getTime();
    const end = new Date(item.learning_ends_at).getTime();
    const now = Date.now();
    const total = end - start;
    const elapsed = now - start;
    const pct = total > 0 ? Math.min(Math.max((elapsed / total) * 100, 0), 100) : 0;
    const hoursLeft = Math.max(0, (end - now) / (1000 * 60 * 60));
    return { pct, hoursLeft };
  })();

  // Sort ads by ROAS descending for ranking
  const sortedAds = [...ads].sort((a, b) => (b.metrics?.roas || 0) - (a.metrics?.roas || 0));
  const maxAdRoas = sortedAds.length > 0 ? (sortedAds[0]?.metrics?.roas || 0) : 0;

  // Budget change
  const budgetDiff = item.budget - item.initial_budget;
  const budgetPct = item.initial_budget > 0 ? Math.round((budgetDiff / item.initial_budget) * 100) : 0;

  return (
    <div style={{
      backgroundColor: '#111827', borderRadius: '14px',
      border: `1px solid ${phaseColor}35`,
      overflow: 'hidden'
    }}>
      {/* ═══ HEADER — Always visible ═══ */}
      <div onClick={onToggle} style={{
        padding: '16px 18px', cursor: 'pointer'
      }}>
        {/* Row 1: Name + Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          {isExpanded ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: '800', color: '#f3f4f6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.adset_name}
              </span>
              {hasDirectives && (
                <span style={{
                  padding: '2px 7px', borderRadius: '4px', fontSize: '9px', fontWeight: '700',
                  backgroundColor: '#c084fc15', color: '#c084fc',
                  display: 'flex', alignItems: 'center', gap: '3px'
                }}>
                  <Brain size={9} /> {directives.length}
                </span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#4b5563', display: 'flex', gap: '10px', marginTop: '2px' }}>
              <span>{item.days_active?.toFixed(1) || 0}d activo</span>
              <span>{ads.length || item.ads_count} ads</span>
              <span>{item.actions_count} acciones IA</span>
              {item.last_check && (
                <span>Check: {new Date(item.last_check).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
            <Badge color={phaseColor} label={PHASE_LABELS[item.phase] || item.phase} />
            <Badge color={item.status === 'ACTIVE' ? '#10b981' : '#6b7280'} label={item.status} />
            {live && (
              <span style={{
                padding: '2px 6px', borderRadius: '4px', fontSize: '8px', fontWeight: '700',
                backgroundColor: isLive ? '#10b98115' : '#f59e0b15',
                color: isLive ? '#10b981' : '#f59e0b'
              }}>
                {isLive ? 'LIVE' : 'DB'}
              </span>
            )}
          </div>
        </div>

        {/* Row 2: KPI Hero Numbers — always visible */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
          {/* ROAS — hero metric */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: live?.roas >= 2 ? '#065f4612' : live?.roas >= 1 ? '#78350f10' : '#7f1d1d10',
            border: `1px solid ${live?.roas >= 2 ? '#10b98120' : live?.roas >= 1 ? '#f59e0b20' : '#ef444420'}`
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>ROAS 7d</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: live?.roas >= 2 ? '#10b981' : live?.roas >= 1 ? '#f59e0b' : '#ef4444', lineHeight: 1 }}>
              {live?.roas?.toFixed(2) || '0.00'}x
            </div>
            {live3d && (
              <div style={{ fontSize: '9px', color: '#4b5563', marginTop: '3px' }}>
                3d: <span style={{ color: live3d.roas >= live.roas ? '#10b981' : '#ef4444', fontWeight: '700' }}>
                  {live3d.roas?.toFixed(2)}x {live3d.roas >= live.roas ? '\u2191' : '\u2193'}
                </span>
              </div>
            )}
          </div>
          {/* Spend */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: '#1e3a8a08', border: '1px solid #1e3a8a20'
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>Spend 7d</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: '#93c5fd', lineHeight: 1 }}>
              ${live?.spend?.toFixed(0) || '0'}
            </div>
            {live3d && (
              <div style={{ fontSize: '9px', color: '#4b5563', marginTop: '3px' }}>
                3d: ${live3d.spend?.toFixed(0) || '0'}
              </div>
            )}
          </div>
          {/* CTR */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: '#0d1117', border: '1px solid #1f2937'
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>CTR</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: live?.ctr >= 1.5 ? '#10b981' : live?.ctr >= 0.8 ? '#f59e0b' : '#e5e7eb', lineHeight: 1 }}>
              {live?.ctr?.toFixed(2) || '0'}%
            </div>
            <div style={{ fontSize: '9px', color: '#4b5563', marginTop: '3px' }}>
              {live?.clicks?.toLocaleString() || '0'} clicks
            </div>
          </div>
          {/* Compras */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: (live?.purchases || 0) > 0 ? '#065f4610' : '#0d1117',
            border: `1px solid ${(live?.purchases || 0) > 0 ? '#10b98120' : '#1f2937'}`
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>Compras</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: (live?.purchases || 0) > 0 ? '#10b981' : '#374151', lineHeight: 1 }}>
              {live?.purchases || 0}
            </div>
            {live?.cpa > 0 && (
              <div style={{ fontSize: '9px', color: '#4b5563', marginTop: '3px' }}>
                CPA: ${live.cpa?.toFixed(2)}
              </div>
            )}
          </div>
          {/* Frecuencia */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: liveFreqLevel === 'critical' ? '#7f1d1d10' : liveFreqLevel === 'high' ? '#78350f10' : '#0d1117',
            border: `1px solid ${FREQ_COLORS[liveFreqLevel]}20`
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>Frecuencia</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: FREQ_COLORS[liveFreqLevel], lineHeight: 1 }}>
              {liveFreq.toFixed(2)}
            </div>
            <div style={{ fontSize: '9px', color: '#4b5563', marginTop: '3px' }}>
              {FREQ_LABELS[liveFreqLevel]}
            </div>
          </div>
          {/* Budget */}
          <div style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            backgroundColor: budgetDiff > 0 ? '#065f4610' : budgetDiff < 0 ? '#7f1d1d10' : '#0d1117',
            border: `1px solid ${budgetDiff > 0 ? '#10b98120' : budgetDiff < 0 ? '#ef444420' : '#1f2937'}`
          }}>
            <div style={{ fontSize: '9px', color: '#6b7280', fontWeight: '600', marginBottom: '2px' }}>Budget/dia</div>
            <div style={{ fontSize: '22px', fontWeight: '900', color: budgetDiff > 0 ? '#10b981' : budgetDiff < 0 ? '#ef4444' : '#e5e7eb', lineHeight: 1 }}>
              ${item.budget}
            </div>
            {budgetDiff !== 0 && (
              <div style={{ fontSize: '9px', color: budgetDiff > 0 ? '#10b981' : '#ef4444', fontWeight: '700', marginTop: '3px' }}>
                {budgetDiff > 0 ? '+' : ''}{budgetPct}% vs ${item.initial_budget}
              </div>
            )}
          </div>
        </div>

        {/* Row 3: Learning progress bar (if in learning) */}
        {learningProgress && (
          <div style={{ marginTop: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Clock size={11} color="#f59e0b" />
                <span style={{ fontSize: '10px', fontWeight: '700', color: '#f59e0b' }}>Learning Phase</span>
              </div>
              <span style={{ fontSize: '10px', color: '#f59e0b', fontWeight: '600' }}>
                {learningProgress.hoursLeft.toFixed(0)}h restantes — {new Date(item.learning_ends_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={{ height: '4px', borderRadius: '2px', backgroundColor: '#1f2937', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: '2px',
                backgroundColor: '#f59e0b',
                width: `${learningProgress.pct}%`,
                transition: 'width 0.3s ease'
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ═══ EXPANDED CONTENT ═══ */}
      {isExpanded && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid #1f2937' }}>

          {/* Secondary Metrics Grid */}
          {live && (
            <div style={{ paddingTop: '14px', marginBottom: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
                <MiniMetric label="Impresiones" value={live.impressions?.toLocaleString() || '0'} />
                <MiniMetric label="Alcance" value={live.reach?.toLocaleString() || '0'} />
                <MiniMetric label="CPM" value={`$${live.cpm?.toFixed(2) || '0'}`} />
                <MiniMetric label="CPC" value={`$${live.cpc?.toFixed(2) || '0'}`} />
                <MiniMetric label="Valor Compras" value={live.purchase_value ? `$${live.purchase_value?.toFixed(0)}` : '-'} color={live.purchase_value > 0 ? '#10b981' : '#4b5563'} />
              </div>
            </div>
          )}

          {/* 3d vs 7d Trend */}
          {live && live3d && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '10px', fontWeight: '600', color: '#4b5563', marginBottom: '6px' }}>Tendencia 3d vs 7d</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                <TrendMetric label="ROAS" val7d={live.roas} val3d={live3d.roas} suffix="x" />
                <TrendMetric label="CTR" val7d={live.ctr} val3d={live3d.ctr} suffix="%" />
                <TrendMetric label="Freq" val7d={live.frequency} val3d={live3d.frequency} suffix="" inverted />
                <TrendMetric label="CPA" val7d={live.cpa || 0} val3d={live3d.cpa || 0} suffix="$" prefix inverted />
              </div>
            </div>
          )}

          {/* ═══ Brain Directives ═══ */}
          {hasDirectives && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '11px', fontWeight: '700', color: '#c084fc', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Brain size={12} />
                Directivas del Brain ({directives.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {directives.map((d, i) => {
                  const DIcon = DIRECTIVE_ICONS[d.type] || CircleDot;
                  const dColor = DIRECTIVE_COLORS[d.type] || '#6b7280';
                  return (
                    <div key={i} style={{
                      padding: '10px 12px', borderRadius: '8px',
                      backgroundColor: `${dColor}08`, border: `1px solid ${dColor}25`,
                      display: 'flex', alignItems: 'flex-start', gap: '10px'
                    }}>
                      <DIcon size={14} color={dColor} style={{ marginTop: '1px', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                          <span style={{ fontSize: '11px', fontWeight: '700', color: dColor, textTransform: 'uppercase' }}>
                            {d.type}
                          </span>
                          <span style={{ fontSize: '10px', color: '#9ca3af' }}>
                            {d.target_action}
                          </span>
                          <Badge color={d.confidence === 'high' ? '#10b981' : d.confidence === 'medium' ? '#f59e0b' : '#6b7280'} label={d.confidence} />
                          <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: 'auto' }}>
                            expira: {new Date(d.expires_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.4' }}>
                          {d.reason?.replace('[BRAIN\u2192AI-MANAGER] ', '')}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ Performance por Creativo — RANKING VISUAL ═══ */}
          {sortedAds.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '11px', fontWeight: '700', color: '#c084fc', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Image size={12} />
                Ranking de Ads ({sortedAds.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                {sortedAds.map((ad, i) => {
                  const m = ad.metrics;
                  const isActive = ad.status === 'ACTIVE';
                  const isTop = i === 0 && m?.roas > 0;
                  const roasBarWidth = maxAdRoas > 0 && m?.roas > 0 ? Math.max((m.roas / maxAdRoas) * 100, 5) : 3;
                  const roasColor = m?.roas >= 2 ? '#10b981' : m?.roas >= 1 ? '#f59e0b' : m?.roas > 0 ? '#ef4444' : '#374151';
                  return (
                    <div key={i} style={{
                      padding: '8px 12px', borderRadius: '8px', backgroundColor: '#0d1117',
                      border: isTop ? '1px solid #f59e0b30' : '1px solid #1f2937',
                      opacity: isActive ? 1 : 0.5,
                      position: 'relative', overflow: 'hidden'
                    }}>
                      {/* Performance bar background */}
                      <div style={{
                        position: 'absolute', left: 0, top: 0, bottom: 0,
                        width: `${roasBarWidth}%`,
                        backgroundColor: `${roasColor}08`,
                        borderRight: `2px solid ${roasColor}25`,
                        transition: 'width 0.3s ease'
                      }} />
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {/* Rank number */}
                        <span style={{
                          fontSize: '12px', fontWeight: '900', minWidth: '18px', textAlign: 'center',
                          color: isTop ? '#f59e0b' : '#374151'
                        }}>
                          #{i + 1}
                        </span>
                        {/* Thumbnail */}
                        {ad.asset?.filename && (
                          <div style={{
                            width: '40px', height: '40px', borderRadius: '6px', overflow: 'hidden',
                            flexShrink: 0, backgroundColor: '#0a0a0a',
                            border: isTop ? '1px solid #f59e0b40' : '1px solid #1f2937'
                          }}>
                            <img
                              src={getCreativePreviewUrl(ad.asset.filename)}
                              alt={ad.ad_name}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          </div>
                        )}
                        {/* Ad info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '11px', fontWeight: '700', color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '2px' }}>
                            {ad.ad_name}
                          </div>
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            {!isActive && <span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700', backgroundColor: '#37415120', color: '#6b7280' }}>PAUSED</span>}
                            {ad.asset?.style && <span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700', backgroundColor: '#581c8715', color: '#c084fc' }}>{ad.asset.style}</span>}
                            {ad.asset?.ad_format && <span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '8px', fontWeight: '700', backgroundColor: '#1e3a8a15', color: '#93c5fd' }}>{ad.asset.ad_format === 'feed' ? '1:1' : '9:16'}</span>}
                          </div>
                        </div>
                        {/* Metrics — compact right side */}
                        {m ? (
                          <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexShrink: 0 }}>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '15px', fontWeight: '900', color: roasColor, lineHeight: 1 }}>
                                {m.roas?.toFixed(2) || '0'}x
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>ROAS</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '12px', fontWeight: '800', color: m.ctr >= 1.5 ? '#10b981' : '#e5e7eb', lineHeight: 1 }}>
                                {m.ctr?.toFixed(2) || '0'}%
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>CTR</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb', lineHeight: 1 }}>
                                ${m.spend?.toFixed(1) || '0'}
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>Spend</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb', lineHeight: 1 }}>
                                {m.clicks || 0}
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>Clicks</div>
                            </div>
                            <div style={{ textAlign: 'center', minWidth: '30px' }}>
                              <div style={{ fontSize: '14px', fontWeight: '900', color: (m.purchases || 0) > 0 ? '#10b981' : '#374151', lineHeight: 1 }}>
                                {m.purchases || 0}
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>Ventas</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '11px', fontWeight: '700', color: m.frequency > 3 ? '#ef4444' : m.frequency > 2.5 ? '#f59e0b' : '#6b7280', lineHeight: 1 }}>
                                {m.frequency?.toFixed(1) || '0'}
                              </div>
                              <div style={{ fontSize: '8px', color: '#4b5563' }}>Freq</div>
                            </div>
                          </div>
                        ) : (
                          <span style={{ fontSize: '10px', color: '#374151' }}>Sin datos</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ Assessment — Collapsible ═══ */}
          {item.last_assessment && (
            <div style={{
              borderRadius: '10px', backgroundColor: '#0d1117',
              border: '1px solid #1f2937', marginBottom: '12px', overflow: 'hidden'
            }}>
              <div
                onClick={(e) => { e.stopPropagation(); setShowAssessment(!showAssessment); }}
                style={{
                  padding: '10px 14px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '8px'
                }}
              >
                <Eye size={12} color="#c084fc" />
                <span style={{ fontSize: '11px', fontWeight: '700', color: '#c084fc' }}>Assessment del Manager</span>
                {item.last_check && (
                  <span style={{ fontSize: '9px', color: '#4b5563' }}>
                    {new Date(item.last_check).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '9px', color: '#4b5563' }}>
                  {showAssessment ? 'Ocultar' : 'Ver detalle'}
                </span>
                {showAssessment ? <ChevronDown size={12} color="#4b5563" /> : <ChevronRight size={12} color="#4b5563" />}
              </div>
              {showAssessment && (
                <div style={{ padding: '0 14px 12px' }}>
                  <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                    {item.last_assessment}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ Strategy — Compact ═══ */}
          {item.strategy_summary && (
            <div style={{
              padding: '10px 14px', borderRadius: '8px', backgroundColor: '#0d1117',
              border: '1px solid #1f2937', marginBottom: '12px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <Target size={12} color="#3b82f6" />
                <span style={{ fontSize: '10px', fontWeight: '700', color: '#3b82f6' }}>Estrategia Original</span>
              </div>
              <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5' }}>{item.strategy_summary}</div>
            </div>
          )}

          {/* ═══ Brain Action Log ═══ */}
          {hasBrainActions && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', fontWeight: '700', color: '#c084fc', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Brain size={12} />
                Acciones del Brain ({brainActions.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                {brainActions.slice(0, 10).map((a, i) => {
                  const actionColor = BRAIN_ACTION_COLORS[a.action] || '#6b7280';
                  return (
                    <div key={i} style={{
                      padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0d1117',
                      border: '1px solid #1f2937',
                      display: 'flex', alignItems: 'flex-start', gap: '8px'
                    }}>
                      <Brain size={10} color={actionColor} style={{ marginTop: '2px', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '10px', fontWeight: '700', color: actionColor }}>
                            {a.action.replace(/_/g, ' ')}
                          </span>
                          {a.change_percent !== 0 && (
                            <span style={{ fontSize: '9px', color: '#e5e7eb', fontWeight: '600' }}>
                              {a.change_percent > 0 ? '+' : ''}{a.change_percent?.toFixed(0)}%
                            </span>
                          )}
                          <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: 'auto' }}>
                            {a.executed_at && new Date(a.executed_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {a.reasoning && (
                          <div style={{ fontSize: '9px', color: '#9ca3af', lineHeight: '1.3' }}>
                            {a.reasoning.length > 120 ? a.reasoning.substring(0, 120) + '...' : a.reasoning}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ AI Manager Action timeline ═══ */}
          {item.lifecycle_actions && item.lifecycle_actions.length > 0 && (
            <div>
              <div style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Activity size={12} />
                Acciones del AI Manager ({item.lifecycle_actions.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                {[...item.lifecycle_actions].reverse().map((a, i) => {
                  const ActionIcon = ACTION_ICONS[a.action] || Zap;
                  const actionColor = ACTION_COLORS[a.action] || '#6b7280';
                  return (
                    <div key={i} style={{
                      padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0d1117',
                      border: '1px solid #1f2937',
                      display: 'flex', alignItems: 'flex-start', gap: '8px'
                    }}>
                      <ActionIcon size={11} color={actionColor} style={{ marginTop: '2px', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '10px', fontWeight: '700', color: actionColor }}>
                            {a.action.replace(/_/g, ' ')}
                          </span>
                          {a.value && typeof a.value === 'number' && (
                            <span style={{ fontSize: '9px', color: '#e5e7eb', fontWeight: '600' }}>${a.value}</span>
                          )}
                          {a.value && typeof a.value === 'object' && a.value.budget && (
                            <span style={{ fontSize: '9px', color: '#e5e7eb', fontWeight: '600' }}>
                              ${a.value.budget} | {a.value.ads} ads
                            </span>
                          )}
                          <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: 'auto' }}>
                            {a.executed_at && new Date(a.executed_at).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {a.reason && (
                          <div style={{ fontSize: '9px', color: '#9ca3af', lineHeight: '1.3' }}>
                            {a.reason.length > 150 ? a.reason.substring(0, 150) + '...' : a.reason}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// =============================================
// SUB-COMPONENTS
// =============================================

const DiagnosisCard = ({ icon: Icon, color, title, text }) => (
  <div style={{
    padding: '10px 14px', borderRadius: '8px', backgroundColor: '#0d1117',
    border: `1px solid ${color}20`
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
      <Icon size={12} color={color} />
      <span style={{ fontSize: '10px', fontWeight: '700', color }}>{title}</span>
    </div>
    <div style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.4' }}>{text}</div>
  </div>
);

const Badge = ({ color, label }) => (
  <span style={{
    padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: '700',
    backgroundColor: color + '15', color: color,
    whiteSpace: 'nowrap'
  }}>
    {label}
  </span>
);

const SummaryBadge = ({ label, value, color }) => (
  <div style={{
    padding: '6px 12px', borderRadius: '8px', backgroundColor: color + '10',
    border: `1px solid ${color}25`, display: 'flex', alignItems: 'center', gap: '6px'
  }}>
    <span style={{ fontSize: '16px', fontWeight: '800', color }}>{value}</span>
    <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600' }}>{label}</span>
  </div>
);

const MiniMetric = ({ label, value, color = '#e5e7eb' }) => (
  <div style={{
    padding: '8px 10px', borderRadius: '6px', backgroundColor: '#0d1117',
    border: '1px solid #1f2937', textAlign: 'center'
  }}>
    <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>{label}</div>
    <div style={{ fontSize: '13px', fontWeight: '800', color }}>{value}</div>
  </div>
);

const TrendMetric = ({ label, val7d, val3d, suffix = '', prefix = false, inverted = false }) => {
  const diff = val3d - val7d;
  const improving = inverted ? diff < 0 : diff > 0;
  const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
  const color = Math.abs(diff) < 0.01 ? '#6b7280' : improving ? '#10b981' : '#ef4444';

  return (
    <div style={{
      padding: '8px 10px', borderRadius: '6px', backgroundColor: '#0d1117',
      border: '1px solid #1f2937', textAlign: 'center'
    }}>
      <div style={{ fontSize: '9px', color: '#4b5563', marginBottom: '2px' }}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '10px', color: '#6b7280' }}>
          {prefix ? `$${val7d?.toFixed(1)}` : `${val7d?.toFixed(2)}${suffix}`}
        </span>
        <span style={{ fontSize: '13px', fontWeight: '800', color }}>
          {arrow}
        </span>
        <span style={{ fontSize: '11px', fontWeight: '700', color }}>
          {prefix ? `$${val3d?.toFixed(1)}` : `${val3d?.toFixed(2)}${suffix}`}
        </span>
      </div>
      <div style={{ fontSize: '8px', color: '#4b5563' }}>7d → 3d</div>
    </div>
  );
};

const MetricsSnapshot = ({ label, metrics }) => {
  if (!metrics) {
    return (
      <div style={{
        padding: '10px', borderRadius: '8px', backgroundColor: '#0d1117',
        border: '1px solid #1f2937', textAlign: 'center'
      }}>
        <div style={{ fontSize: '10px', fontWeight: '600', color: '#4b5563', marginBottom: '4px' }}>{label}</div>
        <div style={{ fontSize: '11px', color: '#374151' }}>Sin datos</div>
      </div>
    );
  }

  const roasColor = metrics.roas_7d >= 2 ? '#10b981' : metrics.roas_7d >= 1 ? '#f59e0b' : '#ef4444';
  const freqColor = (metrics.frequency || 0) > 3 ? '#ef4444' : (metrics.frequency || 0) > 2.5 ? '#f59e0b' : '#10b981';

  return (
    <div style={{
      padding: '10px', borderRadius: '8px', backgroundColor: '#0d1117',
      border: '1px solid #1f2937'
    }}>
      <div style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', marginBottom: '6px', textAlign: 'center' }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
        <div>
          <div style={{ fontSize: '8px', color: '#4b5563' }}>ROAS</div>
          <div style={{ fontSize: '12px', fontWeight: '800', color: roasColor }}>{metrics.roas_7d?.toFixed(1) || '0'}x</div>
        </div>
        <div>
          <div style={{ fontSize: '8px', color: '#4b5563' }}>Spend</div>
          <div style={{ fontSize: '12px', fontWeight: '700', color: '#e5e7eb' }}>${metrics.spend?.toFixed(0) || '0'}</div>
        </div>
        <div>
          <div style={{ fontSize: '8px', color: '#4b5563' }}>CTR</div>
          <div style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af' }}>{metrics.ctr?.toFixed(2) || '0'}%</div>
        </div>
        <div>
          <div style={{ fontSize: '8px', color: '#4b5563' }}>Freq</div>
          <div style={{ fontSize: '11px', fontWeight: '600', color: freqColor }}>{metrics.frequency?.toFixed(1) || '-'}</div>
        </div>
      </div>
      {metrics.purchases > 0 && (
        <div style={{ marginTop: '4px', textAlign: 'center', fontSize: '10px', color: '#10b981', fontWeight: '600' }}>
          {metrics.purchases} compras
        </div>
      )}
    </div>
  );
};

export default AdSetCreator;
