import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  getBrainInsights, markInsightRead, markAllInsightsRead,
  triggerBrainAnalysis, sendBrainChat, getBrainChatHistory,
  clearBrainChatHistory, getBrainStats, getBrainRecommendations,
  approveRecommendation, rejectRecommendation, markRecommendationExecuted,
  triggerBrainRecommendations, getFollowUpStats,
  getPolicyState, getKnowledgeHistory, getDeepKnowledge, getCreativePerformance, logout
} from '../api';

const BrainOrb = React.lazy(() => import('../components/BrainOrb'));
const ImpactOrb = React.lazy(() => import('../components/ImpactOrb'));
const BrainKnowledgeOrb = React.lazy(() => import('../components/BrainKnowledgeOrb'));

// ═══ CONSTANTES ═══

const INSIGHT_TYPE_CONFIG = {
  anomaly:        { icon: '⚡', label: 'Anomalía', color: '#ef4444' },
  trend:          { icon: '📈', label: 'Tendencia', color: '#3b82f6' },
  opportunity:    { icon: '💡', label: 'Oportunidad', color: '#10b981' },
  warning:        { icon: '⚠️', label: 'Alerta', color: '#f59e0b' },
  milestone:      { icon: '🏆', label: 'Hito', color: '#8b5cf6' },
  status_change:  { icon: '🔄', label: 'Cambio', color: '#6366f1' },
  summary:        { icon: '📊', label: 'Resumen', color: '#06b6d4' },
  follow_up:      { icon: '🔗', label: 'Seguimiento', color: '#ec4899' },
  brain_thinking: { icon: '💭', label: 'Pensamiento', color: '#a78bfa' },
  brain_activity: { icon: '🧠', label: 'Actividad', color: '#818cf8' }
};

const SEVERITY_CONFIG = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: 'CRÍTICO' },
  high:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'ALTO' },
  medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.15)', label: 'MEDIO' },
  low:      { color: '#6b7280', bg: 'rgba(107,114,128,0.15)', label: 'BAJO' },
  info:     { color: '#06b6d4', bg: 'rgba(6,182,212,0.15)', label: 'INFO' }
};

// ═══ COMPONENTE PRINCIPAL ═══

export default function BrainIntelligence() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('feed'); // 'feed' | 'recs' | 'followup' | 'knowledge' | 'creatives' | 'chat'
  const [insights, setInsights] = useState([]);
  const [insightsTotal, setInsightsTotal] = useState(0);
  const [insightsPage, setInsightsPage] = useState(1);
  const [unreadCount, setUnreadCount] = useState(0);
  const [stats, setStats] = useState(null);
  const [loadingInsights, setLoadingInsights] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);

  // Recommendations state
  const [recommendations, setRecommendations] = useState([]);
  const [recsTotal, setRecsTotal] = useState(0);
  const [recsPage, setRecsPage] = useState(1);
  const [recsPendingCount, setRecsPendingCount] = useState(0);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [generatingRecs, setGeneratingRecs] = useState(false);
  const [recsStatusFilter, setRecsStatusFilter] = useState('');

  // Attached rec for chat
  const [attachedRec, setAttachedRec] = useState(null);

  // Filter
  const [typeFilter, setTypeFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');

  // ═══ CARGA INICIAL ═══

  const loadInsights = useCallback(async (page = 1) => {
    setLoadingInsights(true);
    try {
      const filters = {};
      if (typeFilter !== 'all') filters.type = typeFilter;
      if (severityFilter !== 'all') filters.severity = severityFilter;
      const data = await getBrainInsights(page, 20, filters);
      setInsights(data.insights || []);
      setInsightsTotal(data.total || 0);
      setInsightsPage(page);
      setUnreadCount(data.unread || 0);
    } catch (err) {
      console.error('Error loading insights:', err);
    } finally {
      setLoadingInsights(false);
    }
  }, [typeFilter, severityFilter]);

  const loadStats = useCallback(async () => {
    try {
      const data = await getBrainStats();
      setStats(data);
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  }, []);

  const loadChatHistory = useCallback(async () => {
    setChatLoading(true);
    try {
      const data = await getBrainChatHistory();
      setChatMessages(data.messages || []);
    } catch (err) {
      console.error('Error loading chat:', err);
    } finally {
      setChatLoading(false);
    }
  }, []);

  const loadRecommendations = useCallback(async (page = 1) => {
    setLoadingRecs(true);
    try {
      const data = await getBrainRecommendations(page, 20, recsStatusFilter);
      setRecommendations(data.recommendations || []);
      setRecsTotal(data.total || 0);
      setRecsPage(page);
      setRecsPendingCount(data.pending_count || 0);
    } catch (err) {
      console.error('Error loading recommendations:', err);
    } finally {
      setLoadingRecs(false);
    }
  }, [recsStatusFilter]);

  useEffect(() => {
    loadInsights();
    loadStats();
  }, [loadInsights, loadStats]);

  useEffect(() => {
    if (activeTab === 'chat' && chatMessages.length === 0) {
      loadChatHistory();
    }
  }, [activeTab, chatMessages.length, loadChatHistory]);

  useEffect(() => {
    if (activeTab === 'recs') {
      loadRecommendations();
    }
  }, [activeTab, loadRecommendations]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // ═══ ACCIONES ═══

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      await triggerBrainAnalysis();
      await loadInsights();
      await loadStats();
    } catch (err) {
      console.error('Error analyzing:', err);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllInsightsRead();
      setInsights(prev => prev.map(i => ({ ...i, read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Error marking read:', err);
    }
  };

  const handleInsightClick = async (insight) => {
    if (!insight.read) {
      try {
        await markInsightRead(insight._id);
        setInsights(prev => prev.map(i => i._id === insight._id ? { ...i, read: true } : i));
        setUnreadCount(prev => Math.max(0, prev - 1));
      } catch (err) {
        console.error('Error marking read:', err);
      }
    }
  };

  const handleSendChat = async (e) => {
    e.preventDefault();
    const msg = chatInput.trim();
    if (!msg || chatSending) return;

    // Prepend rec context if attached
    let fullMsg = msg;
    let displayMsg = msg;
    if (attachedRec) {
      const recCtx = `[Rec: "${attachedRec.title}" — ${attachedRec.action_type} — ${attachedRec.entity?.entity_name || 'N/A'} — Conf: ${attachedRec.confidence_score || 50}%] `;
      fullMsg = recCtx + msg;
      displayMsg = fullMsg;
      setAttachedRec(null);
    }

    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: displayMsg, created_at: new Date().toISOString() }]);
    setChatSending(true);

    try {
      const result = await sendBrainChat(fullMsg);
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: result.message,
        tokens_used: result.tokens_used,
        created_at: new Date().toISOString()
      }]);
    } catch (err) {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err.response?.data?.error || err.message}`,
        created_at: new Date().toISOString()
      }]);
    } finally {
      setChatSending(false);
      chatInputRef.current?.focus();
    }
  };

  const handleDiscussRec = (rec) => {
    setAttachedRec(rec);
    setActiveTab('chat');
    setChatInput('');
    setTimeout(() => chatInputRef.current?.focus(), 100);
  };

  const handleClearChat = async () => {
    try {
      await clearBrainChatHistory();
      setChatMessages([]);
    } catch (err) {
      console.error('Error clearing chat:', err);
    }
  };

  // Approval modal state
  const [approvalModal, setApprovalModal] = useState(null); // { id, action: 'approve'|'reject', rec }
  const [approvalNote, setApprovalNote] = useState('');
  const approvalNoteRef = useRef(null);

  const openApprovalModal = (id, action, rec) => {
    setApprovalModal({ id, action, rec });
    setApprovalNote('');
    setTimeout(() => approvalNoteRef.current?.focus(), 100);
  };

  const closeApprovalModal = () => {
    setApprovalModal(null);
    setApprovalNote('');
  };

  const handleConfirmDecision = async () => {
    if (!approvalModal) return;
    const { id, action } = approvalModal;
    const note = approvalNote.trim();
    try {
      if (action === 'approve') {
        await approveRecommendation(id, note);
        setRecommendations(prev => prev.map(r =>
          r._id === id ? { ...r, status: 'approved', decided_at: new Date().toISOString(), decision_note: note } : r
        ));
      } else {
        await rejectRecommendation(id, note);
        setRecommendations(prev => prev.map(r =>
          r._id === id ? { ...r, status: 'rejected', decided_at: new Date().toISOString(), decision_note: note } : r
        ));
      }
      setRecsPendingCount(prev => Math.max(0, prev - 1));
      closeApprovalModal();
    } catch (err) {
      console.error(`Error ${action}ing:`, err);
    }
  };

  // Legacy quick approve/reject (fallback if modal not used)
  const handleApproveRec = (id) => {
    const rec = recommendations.find(r => r._id === id);
    openApprovalModal(id, 'approve', rec);
  };

  const handleRejectRec = (id) => {
    const rec = recommendations.find(r => r._id === id);
    openApprovalModal(id, 'reject', rec);
  };

  const handleGenerateRecs = async () => {
    setGeneratingRecs(true);
    try {
      await triggerBrainRecommendations();
      await loadRecommendations();
    } catch (err) {
      console.error('Error generating recommendations:', err);
    } finally {
      setGeneratingRecs(false);
    }
  };

  // ═══ HELPERS ═══

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'ahora';
    if (diffMin < 60) return `hace ${diffMin}m`;
    if (diffH < 24) return `hace ${diffH}h`;
    if (diffD < 7) return `hace ${diffD}d`;
    return d.toLocaleDateString('es', { month: 'short', day: 'numeric' });
  };

  const totalPages = Math.ceil(insightsTotal / 20);

  // ═══ RENDER ═══

  return (
    <div className="brain-page">
      {/* Header */}
      <div className="brain-header">
        <div className="brain-header-left">
          <button className="btn-back" onClick={() => navigate('/')} title="Volver a Ad Sets">
            ← Ad Sets
          </button>
          <h1 className="brain-title">
            <span className="brain-icon">🧠</span>
            Brain Intelligence
          </h1>
          <p className="brain-subtitle">Análisis proactivo y chat con tus campañas</p>
        </div>
        <div className="brain-header-right">
          {stats && (
            <div className="brain-stats-bar">
              <div className="brain-stat-chip">
                <span className="stat-number">{stats.entities_tracked}</span>
                <span className="stat-label">Entidades</span>
              </div>
              <div className="brain-stat-chip">
                <span className="stat-number">{stats.total_insights}</span>
                <span className="stat-label">Insights</span>
              </div>
              <div className="brain-stat-chip">
                <span className="stat-number">{stats.today_insights}</span>
                <span className="stat-label">Hoy</span>
              </div>
              {unreadCount > 0 && (
                <div className="brain-stat-chip unread">
                  <span className="stat-number">{unreadCount}</span>
                  <span className="stat-label">Sin leer</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="brain-tabs">
        <button
          className={`brain-tab ${activeTab === 'feed' ? 'active' : ''}`}
          onClick={() => setActiveTab('feed')}
        >
          Feed de Insights
          {unreadCount > 0 && <span className="tab-badge">{unreadCount}</span>}
        </button>
        <button
          className={`brain-tab ${activeTab === 'recs' ? 'active' : ''}`}
          onClick={() => setActiveTab('recs')}
        >
          Recomendaciones
          {(stats?.pending_recommendations || recsPendingCount) > 0 && (
            <span className="tab-badge rec-badge">{stats?.pending_recommendations || recsPendingCount}</span>
          )}
        </button>
        <button
          className={`brain-tab ${activeTab === 'followup' ? 'active' : ''}`}
          onClick={() => setActiveTab('followup')}
        >
          Seguimiento
        </button>
        <button
          className={`brain-tab ${activeTab === 'knowledge' ? 'active' : ''}`}
          onClick={() => setActiveTab('knowledge')}
        >
          Conocimiento
        </button>
        <button
          className={`brain-tab ${activeTab === 'creatives' ? 'active' : ''}`}
          onClick={() => setActiveTab('creatives')}
        >
          Creativos
        </button>
        <button
          className={`brain-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          Chat con el Brain
        </button>
      </div>

      {/* Content */}
      <div className="brain-content">
        {activeTab === 'feed' ? (
          <FeedPanel
            insights={insights}
            loadingInsights={loadingInsights}
            analyzing={analyzing}
            typeFilter={typeFilter}
            severityFilter={severityFilter}
            insightsPage={insightsPage}
            totalPages={totalPages}
            insightsTotal={insightsTotal}
            stats={stats}
            unreadCount={unreadCount}
            onTypeFilter={setTypeFilter}
            onSeverityFilter={setSeverityFilter}
            onAnalyze={handleAnalyze}
            onMarkAllRead={handleMarkAllRead}
            onInsightClick={handleInsightClick}
            onPageChange={(p) => loadInsights(p)}
            formatTime={formatTime}
          />
        ) : activeTab === 'recs' ? (
          <RecommendationsPanel
            recommendations={recommendations}
            loading={loadingRecs}
            generating={generatingRecs}
            statusFilter={recsStatusFilter}
            recsPage={recsPage}
            totalPages={Math.ceil(recsTotal / 20)}
            recsTotal={recsTotal}
            pendingCount={recsPendingCount}
            onStatusFilter={setRecsStatusFilter}
            onGenerate={handleGenerateRecs}
            onApprove={handleApproveRec}
            onReject={handleRejectRec}
            onPageChange={(p) => loadRecommendations(p)}
            onDiscussRec={handleDiscussRec}
            onGoToFollowUp={() => setActiveTab('followup')}
            formatTime={formatTime}
          />
        ) : activeTab === 'followup' ? (
          <FollowUpPanel formatTime={formatTime} onApprovalAction={openApprovalModal} />
        ) : activeTab === 'knowledge' ? (
          <KnowledgePanel formatTime={formatTime} />
        ) : activeTab === 'creatives' ? (
          <CreativesPanel formatTime={formatTime} />
        ) : (
          <ChatPanel
            messages={chatMessages}
            chatInput={chatInput}
            chatSending={chatSending}
            chatLoading={chatLoading}
            chatEndRef={chatEndRef}
            chatInputRef={chatInputRef}
            onInputChange={setChatInput}
            onSend={handleSendChat}
            onClear={handleClearChat}
            formatTime={formatTime}
            attachedRec={attachedRec}
            onClearAttachment={() => setAttachedRec(null)}
          />
        )}
      </div>

      {/* ═══ APPROVAL MODAL ═══ */}
      {approvalModal && (
        <div className="approval-modal-overlay" onClick={closeApprovalModal}>
          <div className="approval-modal" onClick={e => e.stopPropagation()}>
            <div className={`approval-modal-header ${approvalModal.action}`}>
              <span className="approval-modal-icon">
                {approvalModal.action === 'approve' ? '\u2705' : '\u274C'}
              </span>
              <span className="approval-modal-title">
                {approvalModal.action === 'approve' ? 'Aprobar recomendacion' : 'Rechazar recomendacion'}
              </span>
              <button className="approval-modal-close" onClick={closeApprovalModal}>&times;</button>
            </div>
            {approvalModal.rec && (
              <div className="approval-modal-rec-summary">
                <div className="approval-modal-rec-action">
                  {(ACTION_TYPE_CONFIG[approvalModal.rec.action_type] || ACTION_TYPE_CONFIG.other).icon}{' '}
                  {(ACTION_TYPE_CONFIG[approvalModal.rec.action_type] || ACTION_TYPE_CONFIG.other).label}
                </div>
                <div className="approval-modal-rec-title">{approvalModal.rec.title}</div>
                <div className="approval-modal-rec-entity">
                  {approvalModal.rec.entity?.entity_name || 'Entidad'}
                </div>
                {approvalModal.rec.action_detail && (
                  <div className="approval-modal-rec-detail">{approvalModal.rec.action_detail}</div>
                )}
              </div>
            )}
            <div className="approval-modal-body">
              <label className="approval-modal-label">
                Nota opcional {approvalModal.action === 'reject' ? '(razon del rechazo)' : '(contexto adicional)'}
              </label>
              <textarea
                ref={approvalNoteRef}
                className="approval-modal-textarea"
                value={approvalNote}
                onChange={e => setApprovalNote(e.target.value)}
                placeholder={approvalModal.action === 'approve'
                  ? 'Ej: Lo ejecutare manana cuando baje el CPM...'
                  : 'Ej: Prefiero esperar mas datos antes de pausar...'}
                rows={3}
              />
            </div>
            <div className="approval-modal-footer">
              <button className="approval-modal-btn cancel" onClick={closeApprovalModal}>
                Cancelar
              </button>
              <button
                className={`approval-modal-btn confirm ${approvalModal.action}`}
                onClick={handleConfirmDecision}
              >
                {approvalModal.action === 'approve' ? 'Confirmar aprobacion' : 'Confirmar rechazo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ FEED PANEL ═══

function FeedPanel({
  insights, loadingInsights, analyzing, typeFilter, severityFilter,
  insightsPage, totalPages, insightsTotal, stats, unreadCount,
  onTypeFilter, onSeverityFilter, onAnalyze, onMarkAllRead, onInsightClick, onPageChange,
  formatTime
}) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div className="feed-panel">
      {/* Brain Orb Hero */}
      <div className="feed-hero">
        <Suspense fallback={<div className="brain-orb-fallback"><div className="orb-placeholder" /></div>}>
          <BrainOrb stats={stats} unreadCount={unreadCount || 0} analyzing={analyzing} />
        </Suspense>
        <div className="feed-hero-info">
          <h2 className="feed-hero-title">Brain Neural Feed</h2>
          <p className="feed-hero-subtitle">
            {analyzing ? 'Procesando nuevos patrones...' :
             insightsTotal > 0 ? `${insightsTotal} observaciones del cerebro` :
             'Esperando primer ciclo de análisis'}
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="feed-toolbar">
        <div className="feed-filters">
          <select
            className="feed-select"
            value={typeFilter}
            onChange={(e) => onTypeFilter(e.target.value)}
          >
            <option value="all">Todos los tipos</option>
            {Object.entries(INSIGHT_TYPE_CONFIG).map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
            ))}
          </select>
          <select
            className="feed-select"
            value={severityFilter}
            onChange={(e) => onSeverityFilter(e.target.value)}
          >
            <option value="all">Toda severidad</option>
            {Object.entries(SEVERITY_CONFIG).map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.label}</option>
            ))}
          </select>
        </div>
        <div className="feed-actions">
          <button className="btn-secondary btn-small" onClick={onMarkAllRead}>
            Marcar todo leído
          </button>
          <button
            className={`btn-primary ${analyzing ? 'btn-analyzing' : ''}`}
            onClick={onAnalyze}
            disabled={analyzing}
          >
            {analyzing ? 'Analizando...' : 'Analizar ahora'}
          </button>
        </div>
      </div>

      {/* Insights List — separated by urgency */}
      <div className="insights-list">
        {loadingInsights ? (
          <div className="feed-empty">
            <div className="feed-loading-pulse" />
            <p>Cargando insights...</p>
          </div>
        ) : insights.length === 0 ? (
          <div className="feed-empty">
            <div className="feed-empty-icon">🧠</div>
            <p>El Brain aún no ha generado insights.</p>
            <p className="feed-empty-hint">Ejecuta un análisis o espera al próximo ciclo de datos.</p>
          </div>
        ) : (() => {
          const urgent = insights.filter(i => i.severity === 'critical' || i.severity === 'high');
          const info = insights.filter(i => i.severity !== 'critical' && i.severity !== 'high');
          return (
            <>
              {urgent.length > 0 && (
                <div className="feed-urgency-section">
                  <div className="feed-section-header urgent">
                    <span className="feed-section-dot urgent" />
                    <span>Requiere atención ({urgent.length})</span>
                  </div>
                  {urgent.map((insight, idx) => (
                    <InsightCard
                      key={insight._id}
                      insight={insight}
                      expanded={expandedId === insight._id}
                      animDelay={idx * 0.05}
                      onToggle={() => {
                        setExpandedId(expandedId === insight._id ? null : insight._id);
                        onInsightClick(insight);
                      }}
                      formatTime={formatTime}
                    />
                  ))}
                </div>
              )}
              {info.length > 0 && (
                <div className="feed-urgency-section">
                  {urgent.length > 0 && (
                    <div className="feed-section-header informative">
                      <span className="feed-section-dot informative" />
                      <span>Informativo ({info.length})</span>
                    </div>
                  )}
                  {info.map((insight, idx) => (
                    <InsightCard
                      key={insight._id}
                      insight={insight}
                      expanded={expandedId === insight._id}
                      animDelay={(urgent.length + idx) * 0.05}
                      onToggle={() => {
                        setExpandedId(expandedId === insight._id ? null : insight._id);
                        onInsightClick(insight);
                      }}
                      formatTime={formatTime}
                    />
                  ))}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="feed-pagination">
          <button
            className="btn-page"
            disabled={insightsPage <= 1}
            onClick={() => onPageChange(insightsPage - 1)}
          >
            Anterior
          </button>
          <span className="page-info">
            Página {insightsPage} de {totalPages} ({insightsTotal} insights)
          </span>
          <button
            className="btn-page"
            disabled={insightsPage >= totalPages}
            onClick={() => onPageChange(insightsPage + 1)}
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ INSIGHT CARD ═══

function InsightCard({ insight, expanded, onToggle, formatTime, animDelay = 0 }) {
  const typeCfg = INSIGHT_TYPE_CONFIG[insight.insight_type] || INSIGHT_TYPE_CONFIG.anomaly;
  const sevCfg = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.medium;

  return (
    <div
      className={`insight-card ${!insight.read ? 'unread' : ''} ${expanded ? 'expanded' : ''} severity-${insight.severity || 'medium'} insight-type-${insight.insight_type || 'anomaly'}`}
      onClick={onToggle}
      style={{
        '--card-accent': typeCfg.color,
        '--severity-color': sevCfg.color,
        animationDelay: `${animDelay}s`,
      }}
    >
      {/* Severity glow bar */}
      <div className="insight-severity-bar" style={{ background: `linear-gradient(180deg, ${sevCfg.color}, transparent)` }} />

      <div className="insight-header">
        <div className="insight-left">
          <div className="insight-type-badge" style={{ background: `${typeCfg.color}20`, borderColor: `${typeCfg.color}40` }}>
            <span className="insight-type-icon">{typeCfg.icon}</span>
          </div>
          <div className="insight-meta">
            <div className="insight-title-row">
              <span className="insight-title">{insight.title}</span>
              {!insight.read && <span className="insight-dot" />}
            </div>
            <div className="insight-tags">
              <span className="insight-tag type" style={{ color: typeCfg.color, backgroundColor: `${typeCfg.color}18` }}>
                {typeCfg.label}
              </span>
              <span className="insight-tag severity" style={{ color: sevCfg.color, backgroundColor: sevCfg.bg }}>
                {sevCfg.label}
              </span>
              {insight.follows_up && (
                <span className="insight-tag followup">Seguimiento</span>
              )}
              {insight.diagnosis && (
                <span className="insight-tag diagnosis">{insight.diagnosis}</span>
              )}
            </div>
            {/* Entity badges - prominent */}
            {insight.entities && insight.entities.length > 0 && (
              <div className="insight-entities">
                {insight.entities.map((e, i) => (
                  <span key={i} className="insight-entity-badge">
                    <span className="entity-type-dot" style={{
                      background: e.entity_type === 'adset' ? '#3b82f6' :
                                  e.entity_type === 'campaign' ? '#8b5cf6' :
                                  e.entity_type === 'ad' ? '#10b981' : '#6b7280'
                    }} />
                    <span className="entity-type-label">
                      {e.entity_type === 'adset' ? 'Ad Set' :
                       e.entity_type === 'campaign' ? 'Campaign' :
                       e.entity_type === 'ad' ? 'Ad' : 'Account'}
                    </span>
                    <span className="entity-name">{e.entity_name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="insight-right">
          <span className="insight-time">{formatTime(insight.created_at)}</span>
          <span className={`insight-source source-${insight.generated_by}`}>
            {insight.generated_by === 'ai' ? 'IA' : insight.generated_by === 'hybrid' ? 'Hybrid' : insight.generated_by === 'brain' ? 'Brain' : 'Math'}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="insight-body">
          <div className="insight-body-text markdown-body">
            <ReactMarkdown>{insight.body}</ReactMarkdown>
          </div>
          {insight.data_points && Object.keys(insight.data_points).length > 0 && (
            <div className="insight-data-points">
              {Object.entries(insight.data_points).map(([k, v]) => (
                <span key={k} className="data-point">
                  <span className="dp-key">{k}</span>
                  <span className="dp-value">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
                </span>
              ))}
            </div>
          )}
          {insight.related_recommendation && (
            <div className="insight-rec-link">
              <span className="rec-link-icon">📋</span>
              <span>Recomendación pendiente vinculada</span>
              <span className="rec-link-arrow">→ Recomendaciones</span>
            </div>
          )}
          {insight.follow_up_count > 0 && (
            <div className="insight-follow-info">
              {insight.follow_up_count} seguimiento{insight.follow_up_count > 1 ? 's' : ''} posterior{insight.follow_up_count > 1 ? 'es' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ RECOMMENDATIONS PANEL ═══

const PRIORITY_CONFIG = {
  urgente:    { icon: '🔴', color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: 'URGENTE' },
  evaluar:    { icon: '🟡', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'EVALUAR' },
  monitorear: { icon: '🔵', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)', label: 'MONITOREAR' }
};

const ACTION_TYPE_CONFIG = {
  pause:           { icon: '⏸️', label: 'Pausar' },
  scale_up:        { icon: '📈', label: 'Escalar' },
  scale_down:      { icon: '📉', label: 'Reducir' },
  reactivate:      { icon: '▶️', label: 'Reactivar' },
  restructure:     { icon: '🔧', label: 'Reestructurar' },
  creative_refresh:{ icon: '🎨', label: 'Creativos' },
  bid_change:      { icon: '💰', label: 'Puja' },
  monitor:         { icon: '👁️', label: 'Monitorear' },
  other:           { icon: '📋', label: 'Otro' }
};

const STATUS_LABELS = {
  pending:    { label: 'Pendiente', color: '#f59e0b' },
  approved:   { label: 'Aprobada', color: '#10b981' },
  rejected:   { label: 'Rechazada', color: '#ef4444' },
  expired:    { label: 'Expirada', color: '#6b7280' },
  superseded: { label: 'Reemplazada', color: '#6b7280' }
};

function RecommendationsPanel({
  recommendations, loading, generating, statusFilter,
  recsPage, totalPages, recsTotal, pendingCount,
  onStatusFilter, onGenerate, onApprove, onReject, onPageChange,
  onDiscussRec, onGoToFollowUp, formatTime
}) {
  const [expandedId, setExpandedId] = useState(null);

  const pendingRecs = recommendations.filter(r => r.status === 'pending' && !r.related_follow_up?.rec_id);
  // Approved with active follow-up (not yet fully measured)
  const trackingRecs = recommendations.filter(r =>
    r.status === 'approved' && !r.follow_up?.checked && r.follow_up?.current_phase !== 'complete'
  );
  // Everything else that's been decided
  const historyRecs = recommendations.filter(r =>
    r.status !== 'pending' && !(r.status === 'approved' && !r.follow_up?.checked && r.follow_up?.current_phase !== 'complete')
  );

  return (
    <div className="recs-panel">
      {/* Hero stats row */}
      <div className="recs-hero-stats">
        <div className="recs-hero-stat highlight">
          <span className="recs-hero-value">{pendingCount}</span>
          <span className="recs-hero-label">Pendientes</span>
        </div>
        <div className="recs-hero-stat">
          <span className="recs-hero-value">{recsTotal}</span>
          <span className="recs-hero-label">Total</span>
        </div>
        <div className="recs-hero-stat">
          <span className="recs-hero-value generate-action" onClick={!generating ? onGenerate : undefined}>
            {generating ? '...' : '+'}
          </span>
          <span className="recs-hero-label">{generating ? 'Generando' : 'Generar'}</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="feed-toolbar">
        <div className="feed-filters">
          <select
            className="feed-select"
            value={statusFilter}
            onChange={(e) => onStatusFilter(e.target.value)}
          >
            <option value="">Todas</option>
            <option value="pending">Pendientes ({pendingCount})</option>
            <option value="approved">Aprobadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="expired">Expiradas</option>
          </select>
        </div>
        <div className="recs-info-inline">
          El Brain aprende de tus decisiones — aprueba o rechaza cada recomendacion.
        </div>
      </div>

      {/* Recommendations List */}
      <div className="recs-list">
        {loading ? (
          <div className="feed-empty">Cargando recomendaciones...</div>
        ) : recommendations.length === 0 ? (
          <div className="feed-empty">
            <div className="feed-empty-icon">🎯</div>
            <p>Sin recomendaciones aun.</p>
            <p className="feed-empty-hint">Genera recomendaciones manualmente o espera al proximo ciclo automatico (cada 6h).</p>
          </div>
        ) : (
          <>
            {pendingRecs.length > 0 && !statusFilter && (
              <div className="recs-section-label">Requieren tu decision</div>
            )}
            {(statusFilter ? recommendations : pendingRecs).map((rec, idx) => (
              <RecommendationCard
                key={rec._id}
                rec={rec}
                expanded={expandedId === rec._id}
                onToggle={() => setExpandedId(expandedId === rec._id ? null : rec._id)}
                onApprove={() => onApprove(rec._id)}
                onReject={() => onReject(rec._id)}
                onDiscuss={onDiscussRec ? () => onDiscussRec(rec) : undefined}
                formatTime={formatTime}
                animDelay={idx * 0.04}
                showTracker={rec.status === 'approved' && !rec.follow_up?.checked && rec.follow_up?.current_phase !== 'complete'}
              />
            ))}
            {!statusFilter && trackingRecs.length > 0 && (
              <>
                <div className="recs-section-label tracking">
                  <span className="recs-tracking-dot" />
                  En seguimiento ({trackingRecs.length})
                  {onGoToFollowUp && (
                    <span className="recs-followup-link" onClick={(e) => { e.stopPropagation(); onGoToFollowUp(); }}>
                      Ver panel completo →
                    </span>
                  )}
                </div>
                {trackingRecs.map((rec, idx) => (
                  <RecommendationCard
                    key={rec._id}
                    rec={rec}
                    expanded={expandedId === rec._id}
                    onToggle={() => setExpandedId(expandedId === rec._id ? null : rec._id)}
                    onApprove={() => onApprove(rec._id)}
                    onReject={() => onReject(rec._id)}
                    onDiscuss={onDiscussRec ? () => onDiscussRec(rec) : undefined}
                    formatTime={formatTime}
                    animDelay={idx * 0.04}
                    showTracker
                  />
                ))}
              </>
            )}
            {!statusFilter && historyRecs.length > 0 && (
              <>
                <div className="recs-section-label decided">Historial</div>
                {historyRecs.map((rec, idx) => (
                  <RecommendationCard
                    key={rec._id}
                    rec={rec}
                    expanded={expandedId === rec._id}
                    onToggle={() => setExpandedId(expandedId === rec._id ? null : rec._id)}
                    onApprove={() => onApprove(rec._id)}
                    onReject={() => onReject(rec._id)}
                    onDiscuss={onDiscussRec ? () => onDiscussRec(rec) : undefined}
                    formatTime={formatTime}
                    animDelay={idx * 0.04}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="feed-pagination">
          <button
            className="btn-page"
            disabled={recsPage <= 1}
            onClick={() => onPageChange(recsPage - 1)}
          >
            Anterior
          </button>
          <span className="page-info">
            Pagina {recsPage} de {totalPages} ({recsTotal} recomendaciones)
          </span>
          <button
            className="btn-page"
            disabled={recsPage >= totalPages}
            onClick={() => onPageChange(recsPage + 1)}
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ RECOMMENDATION CARD ═══

function RecommendationCard({ rec, expanded, onToggle, onApprove, onReject, onDiscuss, formatTime, animDelay = 0, showTracker = false }) {
  const priorityCfg = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.evaluar;
  const actionCfg = ACTION_TYPE_CONFIG[rec.action_type] || ACTION_TYPE_CONFIG.other;
  const statusCfg = STATUS_LABELS[rec.status] || STATUS_LABELS.pending;
  const confidencePct = rec.confidence_score || 50;

  // Follow-up tracking data
  const followUp = rec.follow_up || {};
  const currentPhase = followUp.current_phase || 'awaiting_day_3';
  const phases = followUp.phases || {};
  const isTracking = showTracker && rec.status === 'approved';
  const hoursSinceApproval = rec.decided_at ? Math.round((Date.now() - new Date(rec.decided_at).getTime()) / 3600000) : 0;
  const daysAgo = hoursSinceApproval >= 24
    ? `${Math.floor(hoursSinceApproval / 24)}d ${hoursSinceApproval % 24}h`
    : `${hoursSinceApproval}h`;

  return (
    <div
      className={`rec-card ${rec.status} ${expanded ? 'expanded' : ''} ${isTracking ? 'tracking' : ''}`}
      onClick={onToggle}
      style={{ animationDelay: `${animDelay}s` }}
    >
      {/* Priority accent bar */}
      <div className="rec-priority-bar" style={{ background: priorityCfg.color }} />

      <div className="rec-inner">
        <div className="rec-header">
          <div className="rec-left">
            <div className="rec-action-icon" style={{ background: priorityCfg.bg, color: priorityCfg.color }}>
              {actionCfg.icon}
            </div>
            <div className="rec-meta">
              <div className="rec-title-row">
                <span className="rec-title">{rec.title}</span>
                <span className="rec-status-pill" style={{ color: statusCfg.color, borderColor: statusCfg.color }}>
                  {statusCfg.label}
                </span>
              </div>
              <div className="rec-tags">
                <span className="rec-tag priority" style={{ color: priorityCfg.color, backgroundColor: priorityCfg.bg }}>
                  {priorityCfg.label}
                </span>
                <span className="rec-tag action">
                  {actionCfg.label}
                </span>
              </div>
              {/* Entity badge */}
              {rec.entity && (
                <div className="rec-entity-row">
                  <span className="rec-entity-badge">
                    <span className="entity-type-dot" style={{
                      background: rec.entity.entity_type === 'adset' ? '#3b82f6' :
                                  rec.entity.entity_type === 'campaign' ? '#8b5cf6' : '#10b981'
                    }} />
                    <span className="entity-type-label">
                      {rec.entity.entity_type === 'adset' ? 'Ad Set' :
                       rec.entity.entity_type === 'campaign' ? 'Campaign' : 'Ad'}
                    </span>
                    <span className="entity-name">{rec.entity.entity_name}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="rec-right">
            <span className="rec-time">{formatTime(rec.created_at)}</span>
            {/* Confidence gauge */}
            <div className="rec-confidence-gauge" title={`Confianza: ${confidencePct}%`}>
              <svg width="36" height="36" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none"
                  stroke={confidencePct >= 70 ? '#10b981' : confidencePct >= 45 ? '#f59e0b' : '#ef4444'}
                  strokeWidth="3"
                  strokeDasharray={`${(confidencePct / 100) * 94.2} 94.2`}
                  strokeLinecap="round"
                  transform="rotate(-90 18 18)"
                />
                <text x="18" y="19" textAnchor="middle" dominantBaseline="middle"
                  fill="var(--text-primary)" fontSize="9" fontWeight="700">
                  {confidencePct}
                </text>
              </svg>
            </div>
          </div>
        </div>

        {expanded && (
          <div className="rec-body">
            {/* Related follow-up context badge */}
            {rec.related_follow_up?.rec_id && (
              <div className={`rec-followup-context ${rec.related_follow_up.day_3_verdict || 'pending'}`}>
                <div className="rec-followup-context-header">
                  <span className="rec-followup-context-icon">{'\uD83D\uDD17'}</span>
                  <span className="rec-followup-context-title">
                    Seguimiento previo: "{rec.related_follow_up.title}"
                  </span>
                  <span className="rec-followup-context-phase">
                    {rec.related_follow_up.current_phase === 'awaiting_day_7' ? 'dia 3 medido' :
                     rec.related_follow_up.current_phase === 'awaiting_day_14' ? 'dia 7 medido' :
                     rec.related_follow_up.current_phase === 'complete' ? 'completo' : 'dia 3'}
                  </span>
                </div>
                {rec.related_follow_up.day_3_verdict && (
                  <div className="rec-followup-context-verdict">
                    <span className={`rec-followup-verdict-badge ${rec.related_follow_up.day_3_verdict}`}>
                      {rec.related_follow_up.day_3_verdict === 'negative' ? '\u274C' :
                       rec.related_follow_up.day_3_verdict === 'positive' ? '\u2705' : '\u2796'}
                      {' '}Veredicto dia 3: {rec.related_follow_up.day_3_verdict === 'negative' ? 'negativo' :
                       rec.related_follow_up.day_3_verdict === 'positive' ? 'positivo' : 'neutral'}
                    </span>
                    <span className="rec-followup-context-action">
                      Accion previa: {ACTION_TYPE_CONFIG[rec.related_follow_up.action_type]?.label || rec.related_follow_up.action_type}
                    </span>
                  </div>
                )}
              </div>
            )}
            {/* Structured diagnosis section */}
            {rec.diagnosis && (
              <div className="rec-structured-section rec-section-diagnosis">
                <span className="rec-section-icon">{'\uD83D\uDD0D'}</span>
                <div className="rec-section-content">
                  <span className="rec-section-label">Causa raiz</span>
                  <span className="rec-section-text">{rec.diagnosis}</span>
                </div>
              </div>
            )}

            <div className="rec-action-detail">
              <strong>Accion:</strong> {rec.action_detail}
            </div>

            {rec.expected_outcome && (
              <div className="rec-structured-section rec-section-outcome">
                <span className="rec-section-icon">{'\uD83C\uDFAF'}</span>
                <div className="rec-section-content">
                  <span className="rec-section-label">Resultado esperado</span>
                  <span className="rec-section-text">{rec.expected_outcome}</span>
                </div>
              </div>
            )}

            {rec.risk && (
              <div className="rec-structured-section rec-section-risk">
                <span className="rec-section-icon">{'\u26A0\uFE0F'}</span>
                <div className="rec-section-content">
                  <span className="rec-section-label">Riesgo si no actuas</span>
                  <span className="rec-section-text">{rec.risk}</span>
                </div>
              </div>
            )}

            {/* Extra context (body) — only show if there's meaningful content */}
            {rec.body && !rec.diagnosis && (
              <div className="rec-body-text markdown-body">
                <ReactMarkdown>{rec.body}</ReactMarkdown>
              </div>
            )}
            {rec.body && rec.diagnosis && rec.body.length > 10 && (
              <div className="rec-body-text rec-body-extra">
                <ReactMarkdown>{rec.body}</ReactMarkdown>
              </div>
            )}

            {/* Supporting data — visual comparison grid */}
            {rec.supporting_data && (
              <div className="rec-data-grid">
                {rec.supporting_data.current_roas_7d > 0 && (
                  <div className={`rec-data-item ${rec.supporting_data.account_avg_roas_7d > 0 && rec.supporting_data.current_roas_7d < rec.supporting_data.account_avg_roas_7d * 0.7 ? 'bad' : rec.supporting_data.current_roas_7d >= rec.supporting_data.account_avg_roas_7d ? 'good' : ''}`}>
                    <span className="rec-data-label">ROAS 7d</span>
                    <span className="rec-data-value">{rec.supporting_data.current_roas_7d.toFixed(2)}x</span>
                    {rec.supporting_data.account_avg_roas_7d > 0 && (
                      <span className="rec-data-ref">cuenta: {rec.supporting_data.account_avg_roas_7d.toFixed(2)}x</span>
                    )}
                  </div>
                )}
                {rec.supporting_data.current_cpa_7d > 0 && (
                  <div className="rec-data-item">
                    <span className="rec-data-label">CPA 7d</span>
                    <span className="rec-data-value">${rec.supporting_data.current_cpa_7d.toFixed(2)}</span>
                  </div>
                )}
                {rec.supporting_data.current_spend_7d > 0 && (
                  <div className="rec-data-item">
                    <span className="rec-data-label">Spend 7d</span>
                    <span className="rec-data-value">${rec.supporting_data.current_spend_7d.toFixed(0)}</span>
                  </div>
                )}
                {rec.supporting_data.current_frequency_7d > 0 && (
                  <div className={`rec-data-item ${rec.supporting_data.current_frequency_7d >= 3.5 ? 'bad' : rec.supporting_data.current_frequency_7d >= 2.5 ? 'warn' : ''}`}>
                    <span className="rec-data-label">Freq 7d</span>
                    <span className="rec-data-value">{rec.supporting_data.current_frequency_7d.toFixed(1)}</span>
                  </div>
                )}
                {rec.supporting_data.current_ctr_7d > 0 && (
                  <div className="rec-data-item">
                    <span className="rec-data-label">CTR 7d</span>
                    <span className="rec-data-value">{rec.supporting_data.current_ctr_7d.toFixed(2)}%</span>
                  </div>
                )}
                {rec.supporting_data.current_purchases_7d > 0 && (
                  <div className="rec-data-item">
                    <span className="rec-data-label">Compras 7d</span>
                    <span className="rec-data-value">{rec.supporting_data.current_purchases_7d}</span>
                  </div>
                )}
                {rec.supporting_data.trend_direction && rec.supporting_data.trend_direction !== 'unknown' && (
                  <div className={`rec-data-item ${rec.supporting_data.trend_direction === 'declining' ? 'bad' : rec.supporting_data.trend_direction === 'improving' ? 'good' : ''}`}>
                    <span className="rec-data-label">Tendencia</span>
                    <span className="rec-data-value">
                      {rec.supporting_data.trend_direction === 'declining' ? '\u2198 Bajando' :
                       rec.supporting_data.trend_direction === 'improving' ? '\u2197 Subiendo' : '\u2192 Estable'}
                      {rec.supporting_data.days_declining > 0 && ` (${rec.supporting_data.days_declining}d)`}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Follow-up info */}
            {rec.follow_up?.checked && (
              <div className={`rec-followup ${rec.follow_up.impact_verdict}`}>
                <div className="rec-followup-header">
                  <span className="rec-followup-icon">
                    {rec.follow_up.impact_verdict === 'positive' ? '\u2705' : rec.follow_up.impact_verdict === 'negative' ? '\u274C' : '\u2796'}
                  </span>
                  <strong>Follow-up: {rec.follow_up.action_executed ? 'Accion ejecutada' : 'Accion no detectada'}</strong>
                </div>
                <p className="rec-followup-text">{rec.follow_up.impact_summary}</p>
              </div>
            )}

            {/* Action bar */}
            <div className="rec-action-bar">
              {rec.status === 'pending' && (
                <>
                  <button
                    className="rec-btn approve"
                    onClick={(e) => { e.stopPropagation(); onApprove(); }}
                  >
                    Aprobar
                  </button>
                  <button
                    className="rec-btn reject"
                    onClick={(e) => { e.stopPropagation(); onReject(); }}
                  >
                    Rechazar
                  </button>
                </>
              )}
              {onDiscuss && (
                <button
                  className="rec-btn discuss"
                  onClick={(e) => { e.stopPropagation(); onDiscuss(); }}
                >
                  Discutir con Brain
                </button>
              )}
            </div>

            {/* Decided info — simple for rejected/completed, rich tracker for active follow-up */}
            {rec.status === 'rejected' && rec.decided_at && (
              <div className="rec-decided-info">
                Rechazada {formatTime(rec.decided_at)}
                {rec.decision_note && ` — "${rec.decision_note}"`}
              </div>
            )}
            {rec.status === 'approved' && rec.decided_at && !isTracking && (
              <div className="rec-decided-info">
                Aprobada {formatTime(rec.decided_at)}
                {rec.decision_note && ` — "${rec.decision_note}"`}
              </div>
            )}
            {isTracking && (
              <div className="rec-tracker">
                <div className="rec-tracker-header">
                  <div className="rec-tracker-status">
                    <span className={`rec-tracker-exec ${followUp.action_executed ? 'done' : 'waiting'}`}>
                      {followUp.action_executed ? '✅ Ejecutada' : '⏳ Pendiente ejecucion'}
                    </span>
                    {!followUp.action_executed && (
                      <button
                        className="rec-btn-mark-executed"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await markRecommendationExecuted(rec._id);
                            setRecommendations(prev => prev.map(r =>
                              r._id === rec._id
                                ? { ...r, follow_up: { ...r.follow_up, action_executed: true, execution_detected_at: new Date().toISOString() } }
                                : r
                            ));
                          } catch (err) { console.error('Error marking executed:', err); }
                        }}
                        title="Ya hice este cambio en Meta Ads"
                      >
                        Marcar ejecutada
                      </button>
                    )}
                    <span className="rec-tracker-time">{daysAgo}</span>
                  </div>
                  <div className="rec-tracker-phases">
                    <span className={`rec-tracker-phase ${phases.day_3?.measured ? 'done' : currentPhase === 'awaiting_day_3' ? 'active' : ''}`}>3d</span>
                    <span className="rec-tracker-phase-line" />
                    <span className={`rec-tracker-phase ${phases.day_7?.measured ? 'done' : currentPhase === 'awaiting_day_7' ? 'active' : ''}`}>7d</span>
                    <span className="rec-tracker-phase-line" />
                    <span className={`rec-tracker-phase ${phases.day_14?.measured ? 'done' : currentPhase === 'awaiting_day_14' ? 'active' : ''}`}>14d</span>
                  </div>
                </div>
                {/* Metrics at approval */}
                {followUp.metrics_at_recommendation && (
                  <div className="rec-tracker-metrics">
                    {followUp.metrics_at_recommendation.roas_7d > 0 && (
                      <div className="rec-tracker-metric">
                        <span className="rec-tracker-metric-label">ROAS</span>
                        <span className="rec-tracker-metric-value">{followUp.metrics_at_recommendation.roas_7d.toFixed(2)}x</span>
                      </div>
                    )}
                    {followUp.metrics_at_recommendation.cpa_7d > 0 && (
                      <div className="rec-tracker-metric">
                        <span className="rec-tracker-metric-label">CPA</span>
                        <span className="rec-tracker-metric-value">${followUp.metrics_at_recommendation.cpa_7d.toFixed(2)}</span>
                      </div>
                    )}
                    {followUp.metrics_at_recommendation.daily_budget > 0 && (
                      <div className="rec-tracker-metric">
                        <span className="rec-tracker-metric-label">Budget</span>
                        <span className="rec-tracker-metric-value">${followUp.metrics_at_recommendation.daily_budget.toFixed(0)}/d</span>
                      </div>
                    )}
                    {followUp.metrics_at_recommendation.ctr_7d > 0 && (
                      <div className="rec-tracker-metric">
                        <span className="rec-tracker-metric-label">CTR</span>
                        <span className="rec-tracker-metric-value">{followUp.metrics_at_recommendation.ctr_7d.toFixed(2)}%</span>
                      </div>
                    )}
                  </div>
                )}
                {/* Early signal from day 3 */}
                {phases.day_3?.measured && (
                  <div className="rec-tracker-signal">
                    <span className="rec-tracker-signal-label">Dia 3:</span>
                    {phases.day_3.deltas?.roas_pct != null && (
                      <span className={`rec-tracker-signal-delta ${(phases.day_3.deltas.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                        ROAS {phases.day_3.deltas.roas_pct > 0 ? '+' : ''}{phases.day_3.deltas.roas_pct?.toFixed(0)}%
                      </span>
                    )}
                    {phases.day_3.deltas?.cpa_pct != null && (
                      <span className={`rec-tracker-signal-delta ${(phases.day_3.deltas.cpa_pct || 0) <= 0 ? 'positive' : 'negative'}`}>
                        CPA {phases.day_3.deltas.cpa_pct > 0 ? '+' : ''}{phases.day_3.deltas.cpa_pct?.toFixed(0)}%
                      </span>
                    )}
                    <span className={`rec-tracker-signal-verdict ${phases.day_3.verdict}`}>
                      {phases.day_3.verdict === 'positive' ? '✅' : phases.day_3.verdict === 'negative' ? '❌' : phases.day_3.verdict === 'too_early' ? '⏳' : '➖'}
                    </span>
                  </div>
                )}
                {rec.decision_note && (
                  <div className="rec-tracker-note">📝 {rec.decision_note}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ FOLLOW-UP PANEL ═══

const VERDICT_CONFIG = {
  positive: { icon: '\u2705', label: 'Positivo', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  negative: { icon: '\u274C', label: 'Negativo', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  neutral:  { icon: '\u2796', label: 'Neutral', color: '#6b7280', bg: 'rgba(107,114,128,0.12)' }
};

function FollowUpPanel({ formatTime, onApprovalAction }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedItem, setExpandedItem] = useState(null);

  const loadFollowUpStats = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getFollowUpStats();
      setData(result);
    } catch (err) {
      console.error('Error loading follow-up stats:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFollowUpStats(); }, [loadFollowUpStats]);

  if (loading) return <div className="feed-empty">Cargando seguimiento...</div>;
  if (!data) return <div className="feed-empty">Error al cargar datos de seguimiento.</div>;

  const { summary, by_action_type, timeline, pending, lessons_learned } = data;

  // Compute which phases have data across all timeline items
  const latestPhases = {
    day_3: timeline.some(t => t.phases?.day_3),
    day_7: timeline.some(t => t.phases?.day_7),
    day_14: timeline.some(t => t.phases?.day_14)
  };

  return (
    <div className="followup-panel">
      {/* Hero: ImpactOrb + Summary Stats */}
      <div className="followup-hero">
        <div className="followup-hero-orb">
          <Suspense fallback={<div className="followup-orb-fallback"><span className="followup-orb-pct">{summary.win_rate}%</span></div>}>
            <ImpactOrb
              winRate={summary.win_rate}
              summary={summary}
              latestPhases={latestPhases}
            />
          </Suspense>
        </div>
        <div className="followup-hero-stats">
          <div className="followup-stat-row">
            <div className="followup-stat main">
              <span className="followup-stat-value">{summary.win_rate}%</span>
              <span className="followup-stat-label">Efectividad</span>
            </div>
            <div className="followup-stat">
              <span className="followup-stat-value">{summary.total_measured}</span>
              <span className="followup-stat-label">Medidas</span>
            </div>
            <div className="followup-stat">
              <span className="followup-stat-value">{summary.total_approved || 0}</span>
              <span className="followup-stat-label">Aprobadas</span>
            </div>
          </div>
          <div className="followup-verdict-row">
            <span className="followup-verdict-pill positive">{summary.positive} positivas</span>
            <span className="followup-verdict-pill negative">{summary.negative} negativas</span>
            <span className="followup-verdict-pill neutral">{summary.neutral} neutrales</span>
          </div>
          <div className="followup-delta-row">
            <div className="followup-delta-item">
              <span className="followup-delta-label">ROAS</span>
              <span className={`followup-delta-val ${summary.avg_roas_delta_pct >= 0 ? 'positive' : 'negative'}`}>
                {summary.avg_roas_delta_pct > 0 ? '+' : ''}{summary.avg_roas_delta_pct}%
              </span>
            </div>
            <div className="followup-delta-item">
              <span className="followup-delta-label">CPA</span>
              <span className={`followup-delta-val ${(summary.avg_cpa_delta_pct || 0) <= 0 ? 'positive' : 'negative'}`}>
                {(summary.avg_cpa_delta_pct || 0) > 0 ? '+' : ''}{summary.avg_cpa_delta_pct || 0}%
              </span>
            </div>
            <div className="followup-delta-item">
              <span className="followup-delta-label">CTR</span>
              <span className={`followup-delta-val ${(summary.avg_ctr_delta_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                {(summary.avg_ctr_delta_pct || 0) > 0 ? '+' : ''}{summary.avg_ctr_delta_pct || 0}%
              </span>
            </div>
            {summary.pending_follow_up > 0 && (
              <div className="followup-delta-item pending">
                <span className="followup-delta-label">En espera</span>
                <span className="followup-delta-val">{summary.pending_follow_up}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* By Action Type — with avg ROAS delta */}
      {Object.keys(by_action_type).length > 0 && (
        <div className="followup-section">
          <h3 className="followup-section-title">Rendimiento por tipo de accion</h3>
          <div className="followup-action-grid">
            {Object.entries(by_action_type).map(([action, stats]) => {
              const actionCfg = ACTION_TYPE_CONFIG[action] || ACTION_TYPE_CONFIG.other;
              const wr = stats.total > 0 ? Math.round((stats.positive / stats.total) * 100) : 0;
              return (
                <div key={action} className="followup-action-row">
                  <div className="followup-action-name">
                    <span>{actionCfg.icon}</span> {actionCfg.label}
                  </div>
                  <div className="followup-action-bar-container">
                    <div className="followup-action-bar">
                      {stats.positive > 0 && (
                        <div className="bar-segment positive" style={{ width: `${(stats.positive / stats.total) * 100}%` }} />
                      )}
                      {stats.neutral > 0 && (
                        <div className="bar-segment neutral" style={{ width: `${(stats.neutral / stats.total) * 100}%` }} />
                      )}
                      {stats.negative > 0 && (
                        <div className="bar-segment negative" style={{ width: `${(stats.negative / stats.total) * 100}%` }} />
                      )}
                    </div>
                    <span className="followup-action-wr">
                      {wr}% ({stats.total})
                      {stats.avg_roas_delta != null && (
                        <span className={`followup-action-delta ${stats.avg_roas_delta >= 0 ? 'positive' : 'negative'}`}>
                          {stats.avg_roas_delta > 0 ? '+' : ''}{stats.avg_roas_delta}%
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI Lessons Learned */}
      {lessons_learned && lessons_learned.length > 0 && (
        <div className="followup-section followup-lessons">
          <h3 className="followup-section-title">Lecciones del Brain</h3>
          <div className="followup-lessons-list">
            {lessons_learned.map((l, i) => {
              const actionCfg = ACTION_TYPE_CONFIG[l.action_type] || ACTION_TYPE_CONFIG.other;
              const vCfg = VERDICT_CONFIG[l.verdict] || VERDICT_CONFIG.neutral;
              return (
                <div key={i} className="followup-lesson-card">
                  <div className="followup-lesson-header">
                    <span className="followup-lesson-action">{actionCfg.icon} {actionCfg.label}</span>
                    <span className="followup-lesson-verdict" style={{ color: vCfg.color }}>{vCfg.icon}</span>
                  </div>
                  <div className="followup-lesson-text">{l.lesson}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* In-Progress (pending measurement) */}
      {pending.length > 0 && (
        <div className="followup-section">
          <h3 className="followup-section-title">En progreso ({pending.length})</h3>
          <div className="followup-pending-list">
            {pending.map(p => {
              const actionCfg = ACTION_TYPE_CONFIG[p.action_type] || ACTION_TYPE_CONFIG.other;
              const phaseLabel = p.current_phase === 'awaiting_day_3' ? 'Esperando dia 3'
                : p.current_phase === 'awaiting_day_7' ? 'Esperando dia 7'
                : p.current_phase === 'awaiting_day_14' ? 'Esperando dia 14'
                : 'Midiendo...';
              const daysAgo = p.hours_since_approved >= 24
                ? `${Math.floor(p.hours_since_approved / 24)}d ${p.hours_since_approved % 24}h`
                : `${p.hours_since_approved}h`;
              const priorityColor = p.priority === 'urgente' ? '#ef4444' : p.priority === 'evaluar' ? '#f59e0b' : '#3b82f6';
              return (
                <div key={p._id} className="followup-pending-item">
                  {/* Header row: action type + entity + phase dots */}
                  <div className="followup-pending-header">
                    <div className="followup-pending-action-badge" style={{ borderLeftColor: priorityColor }}>
                      <span className="followup-pending-action-icon">{actionCfg.icon}</span>
                      <span className="followup-pending-action-label">{actionCfg.label}</span>
                    </div>
                    <div className="followup-pending-right">
                      <div className="followup-phase-dots">
                        <span className={`phase-dot ${p.day_3 ? 'done' : p.current_phase === 'awaiting_day_3' ? 'active' : ''}`} title="Dia 3">3d</span>
                        <span className={`phase-dot ${p.current_phase === 'awaiting_day_7' ? 'active' : p.current_phase === 'awaiting_day_14' || p.current_phase === 'complete' ? 'done' : ''}`} title="Dia 7">7d</span>
                        <span className={`phase-dot ${p.current_phase === 'awaiting_day_14' ? 'active' : p.current_phase === 'complete' ? 'done' : ''}`} title="Dia 14">14d</span>
                      </div>
                      <span className="followup-pending-hours">{daysAgo}</span>
                    </div>
                  </div>

                  {/* Title + entity */}
                  <div className="followup-pending-info">
                    <span className="followup-pending-title">{p.title}</span>
                    <span className="followup-pending-entity">{p.entity_name}</span>
                  </div>

                  {/* Metrics at approval snapshot */}
                  <div className="followup-pending-snapshot">
                    {p.roas_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">ROAS</span>
                        <span className="followup-snap-value">{p.roas_at_approval.toFixed(2)}x</span>
                      </div>
                    )}
                    {p.cpa_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">CPA</span>
                        <span className="followup-snap-value">${p.cpa_at_approval.toFixed(2)}</span>
                      </div>
                    )}
                    {p.ctr_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">CTR</span>
                        <span className="followup-snap-value">{p.ctr_at_approval.toFixed(2)}%</span>
                      </div>
                    )}
                    {p.spend_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">Spend 7d</span>
                        <span className="followup-snap-value">${p.spend_at_approval.toFixed(0)}</span>
                      </div>
                    )}
                    {p.daily_budget_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">Budget</span>
                        <span className="followup-snap-value">${p.daily_budget_at_approval.toFixed(0)}/d</span>
                      </div>
                    )}
                    {p.frequency_at_approval > 0 && (
                      <div className="followup-snap-metric">
                        <span className="followup-snap-label">Freq</span>
                        <span className="followup-snap-value">{p.frequency_at_approval.toFixed(1)}</span>
                      </div>
                    )}
                  </div>

                  {/* Status row: execution + phase + note */}
                  <div className="followup-pending-status-row">
                    <span className={`followup-exec-badge ${p.action_executed ? 'executed' : 'not-executed'}`}>
                      {p.action_executed ? '\u2705 Ejecutada' : '\u23F3 Pendiente ejecucion'}
                    </span>
                    {!p.action_executed && (
                      <button
                        className="rec-btn-mark-executed"
                        onClick={async () => {
                          try {
                            await markRecommendationExecuted(p._id);
                            loadFollowUpStats();
                          } catch (err) { console.error('Error marking executed:', err); }
                        }}
                        title="Ya hice este cambio en Meta Ads"
                      >
                        Marcar ejecutada
                      </button>
                    )}
                    <span className="followup-pending-phase">{phaseLabel}</span>
                  </div>

                  {/* Decision note */}
                  {p.decision_note && (
                    <div className="followup-pending-note">
                      <span className="followup-note-icon">{'\uD83D\uDCDD'}</span> {p.decision_note}
                    </div>
                  )}

                  {/* Action detail */}
                  {p.action_detail && (
                    <div className="followup-pending-detail">{p.action_detail}</div>
                  )}

                  {/* Early signal from day 3 */}
                  {p.day_3 && (
                    <div className="followup-pending-early">
                      <span className="followup-early-label">Senal dia 3:</span>
                      <span className={`followup-early-metric ${(p.day_3.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                        ROAS {p.day_3.roas_pct > 0 ? '+' : ''}{p.day_3.roas_pct}%
                      </span>
                      {p.day_3.cpa_pct != null && (
                        <span className={`followup-early-metric ${(p.day_3.cpa_pct || 0) <= 0 ? 'positive' : 'negative'}`}>
                          CPA {p.day_3.cpa_pct > 0 ? '+' : ''}{p.day_3.cpa_pct}%
                        </span>
                      )}
                      {p.day_3.ctr_pct != null && (
                        <span className={`followup-early-metric ${(p.day_3.ctr_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                          CTR {p.day_3.ctr_pct > 0 ? '+' : ''}{p.day_3.ctr_pct}%
                        </span>
                      )}
                      <span className={`followup-early-verdict ${p.day_3.verdict}`}>
                        {p.day_3.verdict === 'positive' ? '\u2705' : p.day_3.verdict === 'negative' ? '\u274C' : p.day_3.verdict === 'too_early' ? '\u23F3' : '\u2796'}
                      </span>
                    </div>
                  )}

                  {/* New creative individual metrics (creative_refresh only) */}
                  {p.new_ad_name && (
                    <div className="followup-new-ad-section">
                      <div className="followup-new-ad-header">
                        <span>{'\uD83C\uDFA8'}</span>
                        <span>Creativo nuevo: {p.new_ad_name}</span>
                      </div>
                      {p.day_3?.new_ad_metrics ? (
                        <div className="followup-new-ad-metrics">
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">ROAS</span>
                            <span className={`followup-new-ad-value ${p.day_3.new_ad_metrics.roas >= 3 ? 'good' : p.day_3.new_ad_metrics.roas >= 1.5 ? 'ok' : 'bad'}`}>
                              {(p.day_3.new_ad_metrics.roas || 0).toFixed(2)}x
                            </span>
                          </div>
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">CTR</span>
                            <span className={`followup-new-ad-value ${p.day_3.new_ad_metrics.ctr >= 1.5 ? 'good' : p.day_3.new_ad_metrics.ctr >= 0.8 ? 'ok' : 'bad'}`}>
                              {(p.day_3.new_ad_metrics.ctr || 0).toFixed(2)}%
                            </span>
                          </div>
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">CPA</span>
                            <span className="followup-new-ad-value">
                              ${(p.day_3.new_ad_metrics.cpa || 0).toFixed(2)}
                            </span>
                          </div>
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">Spend</span>
                            <span className="followup-new-ad-value">${(p.day_3.new_ad_metrics.spend || 0).toFixed(0)}</span>
                          </div>
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">Clicks</span>
                            <span className="followup-new-ad-value">{p.day_3.new_ad_metrics.clicks || 0}</span>
                          </div>
                          <div className="followup-new-ad-metric">
                            <span className="followup-new-ad-label">Compras</span>
                            <span className="followup-new-ad-value">{p.day_3.new_ad_metrics.purchases || 0}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="followup-new-ad-waiting">
                          Metricas disponibles en la medicion dia 3
                        </div>
                      )}
                    </div>
                  )}

                  {/* New recommendation inlined from Brain */}
                  {p.new_recommendation && (
                    <div className="followup-inline-rec">
                      <div className="followup-inline-rec-header">
                        <span className="followup-inline-rec-badge">{'\u26A1'} Nueva sugerencia del Brain</span>
                      </div>
                      <div className="followup-inline-rec-title">
                        {(ACTION_TYPE_CONFIG[p.new_recommendation.action_type] || ACTION_TYPE_CONFIG.other).icon}{' '}
                        {p.new_recommendation.title}
                      </div>
                      {p.new_recommendation.diagnosis && (
                        <div className="followup-inline-rec-detail">
                          <span className="followup-inline-rec-detail-label">Causa raiz:</span> {p.new_recommendation.diagnosis}
                        </div>
                      )}
                      {p.new_recommendation.action_detail && (
                        <div className="followup-inline-rec-detail">
                          <span className="followup-inline-rec-detail-label">Accion:</span> {p.new_recommendation.action_detail}
                        </div>
                      )}
                      {p.new_recommendation.expected_outcome && (
                        <div className="followup-inline-rec-detail outcome">
                          <span className="followup-inline-rec-detail-label">Resultado esperado:</span> {p.new_recommendation.expected_outcome}
                        </div>
                      )}
                      {p.new_recommendation.risk && (
                        <div className="followup-inline-rec-detail risk">
                          <span className="followup-inline-rec-detail-label">Riesgo:</span> {p.new_recommendation.risk}
                        </div>
                      )}
                      <div className="followup-inline-rec-actions">
                        <button
                          className="rec-btn approve"
                          onClick={() => onApprovalAction && onApprovalAction(p.new_recommendation._id, 'approve', p.new_recommendation)}
                        >
                          Aprobar
                        </button>
                        <button
                          className="rec-btn reject"
                          onClick={() => onApprovalAction && onApprovalAction(p.new_recommendation._id, 'reject', p.new_recommendation)}
                        >
                          Rechazar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Timeline — with phase progression and AI analysis */}
      {timeline.length > 0 && (
        <div className="followup-section">
          <h3 className="followup-section-title">Historial de impacto ({timeline.length})</h3>
          <div className="followup-timeline">
            {timeline.map(item => {
              const vCfg = VERDICT_CONFIG[item.impact_verdict] || VERDICT_CONFIG.neutral;
              const isExpanded = expandedItem === item._id;
              return (
                <div key={item._id}
                  className={`followup-timeline-item ${isExpanded ? 'expanded' : ''}`}
                  style={{ borderLeftColor: vCfg.color }}
                  onClick={() => setExpandedItem(isExpanded ? null : item._id)}
                >
                  <div className="followup-timeline-header">
                    <span className="followup-timeline-verdict" style={{ color: vCfg.color, backgroundColor: vCfg.bg }}>
                      {vCfg.icon} {vCfg.label}
                    </span>
                    <div className="followup-timeline-header-right">
                      {item.impact_trend && (
                        <span className={`followup-trend-badge ${item.impact_trend}`}>
                          {item.impact_trend === 'improving' ? '\u2191' : item.impact_trend === 'declining' ? '\u2193' : '\u2194'}
                        </span>
                      )}
                      <span className="followup-timeline-time">{formatTime(item.checked_at)}</span>
                    </div>
                  </div>
                  <div className="followup-timeline-title">{item.title}</div>
                  <div className="followup-timeline-entity">{item.entity_name}</div>

                  {/* Multi-metric comparison */}
                  <div className="followup-timeline-metrics">
                    <span className="followup-metric">
                      ROAS: {item.roas_before.toFixed(2)}x
                      <span className={`followup-arrow ${item.roas_delta_pct >= 0 ? 'up' : 'down'}`}>
                        {item.roas_delta_pct >= 0 ? '\u2191' : '\u2193'}
                      </span>
                      {item.roas_after.toFixed(2)}x
                      <span className={`followup-delta ${item.roas_delta_pct >= 0 ? 'positive' : 'negative'}`}>
                        ({item.roas_delta_pct > 0 ? '+' : ''}{item.roas_delta_pct}%)
                      </span>
                    </span>
                    {item.cpa_before > 0 && (
                      <span className="followup-metric">
                        CPA: ${item.cpa_before.toFixed(2)} {'\u2192'} ${item.cpa_after.toFixed(2)}
                      </span>
                    )}
                    {item.ctr_before > 0 && (
                      <span className="followup-metric">
                        CTR: {item.ctr_before.toFixed(2)}% {'\u2192'} {item.ctr_after.toFixed(2)}%
                      </span>
                    )}
                    {item.freq_before > 0 && (
                      <span className="followup-metric">
                        Freq: {item.freq_before.toFixed(1)} {'\u2192'} {item.freq_after.toFixed(1)}
                      </span>
                    )}
                  </div>

                  {/* Phase progression */}
                  {(item.phases?.day_3 || item.phases?.day_7 || item.phases?.day_14) && (
                    <div className="followup-phase-timeline">
                      {['day_3', 'day_7', 'day_14'].map(phase => {
                        const p = item.phases?.[phase];
                        if (!p) return <div key={phase} className="followup-phase-node empty"><span className="phase-label">{phase.replace('day_', '')}d</span></div>;
                        const pVCfg = VERDICT_CONFIG[p.verdict] || VERDICT_CONFIG.neutral;
                        return (
                          <div key={phase} className="followup-phase-node" style={{ borderColor: pVCfg.color }}>
                            <span className="phase-label">{phase.replace('day_', '')}d</span>
                            <span className="phase-roas" style={{ color: (p.roas_pct || 0) >= 0 ? '#10b981' : '#ef4444' }}>
                              {(p.roas_pct || 0) > 0 ? '+' : ''}{p.roas_pct || 0}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Expanded: AI Analysis */}
                  {isExpanded && item.ai_analysis && (
                    <div className="followup-ai-analysis">
                      <div className="followup-ai-header">Analisis del Brain</div>
                      {item.ai_analysis.root_cause && (
                        <div className="followup-ai-field">
                          <span className="followup-ai-label">Causa raiz</span>
                          <span className="followup-ai-text">{item.ai_analysis.root_cause}</span>
                        </div>
                      )}
                      {item.ai_analysis.what_worked && item.ai_analysis.what_worked !== 'N/A' && (
                        <div className="followup-ai-field positive">
                          <span className="followup-ai-label">Funciono</span>
                          <span className="followup-ai-text">{item.ai_analysis.what_worked}</span>
                        </div>
                      )}
                      {item.ai_analysis.what_didnt && item.ai_analysis.what_didnt !== 'N/A' && (
                        <div className="followup-ai-field negative">
                          <span className="followup-ai-label">No funciono</span>
                          <span className="followup-ai-text">{item.ai_analysis.what_didnt}</span>
                        </div>
                      )}
                      {item.ai_analysis.lesson_learned && (
                        <div className="followup-ai-field lesson">
                          <span className="followup-ai-label">Leccion</span>
                          <span className="followup-ai-text">{item.ai_analysis.lesson_learned}</span>
                        </div>
                      )}
                      {item.ai_analysis.confidence_adjustment != null && (
                        <div className="followup-ai-confidence">
                          Ajuste confianza: <span className={item.ai_analysis.confidence_adjustment >= 0 ? 'positive' : 'negative'}>
                            {item.ai_analysis.confidence_adjustment > 0 ? '+' : ''}{item.ai_analysis.confidence_adjustment}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {item.impact_summary && !isExpanded && (
                    <div className="followup-timeline-summary">{item.impact_summary}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {timeline.length === 0 && pending.length === 0 && (
        <div className="feed-empty">
          <div className="feed-empty-icon">{'\uD83D\uDCCA'}</div>
          <p>Sin datos de seguimiento aun.</p>
          <p className="feed-empty-hint">Aprueba recomendaciones y el Brain medira su impacto en 3 fases: dia 3, dia 7, y dia 14.</p>
        </div>
      )}
    </div>
  );
}

// ═══ KNOWLEDGE PANEL ═══

function KnowledgePanel({ formatTime }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeZone, setActiveZone] = useState(null); // memory | hypothesis | temporal | policy

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const deepData = await getDeepKnowledge();
        setData(deepData);
      } catch (err) {
        console.error('Error loading deep knowledge:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="feed-empty">Cargando conocimiento del Brain...</div>;
  if (!data) return <div className="feed-empty"><p>Error cargando datos de conocimiento.</p></div>;

  const iq = data.iq_score || 30;
  const iqColor = iq >= 75 ? '#10b981' : iq >= 55 ? '#6366f1' : iq >= 40 ? '#3b82f6' : '#f59e0b';
  const iqLabel = iq >= 75 ? 'Experto' : iq >= 55 ? 'Aprendiendo' : iq >= 40 ? 'Principiante' : 'Inicial';

  return (
    <div className="knowledge-panel knowledge-panel-v2">
      {/* ── Hero: 3D Brain + IQ Score ── */}
      <div className="kv2-hero">
        <div className="kv2-brain-wrap">
          <Suspense fallback={<div className="kv2-brain-placeholder" />}>
            <BrainKnowledgeOrb data={data} />
          </Suspense>
        </div>
        <div className="kv2-iq-panel">
          <div className="kv2-iq-score" style={{ '--iq-color': iqColor }}>
            <svg viewBox="0 0 120 120" className="kv2-iq-ring">
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
              <circle cx="60" cy="60" r="52" fill="none" stroke={iqColor} strokeWidth="6"
                strokeDasharray={`${(iq / 100) * 327} 327`} strokeLinecap="round"
                transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray 1s ease' }} />
            </svg>
            <div className="kv2-iq-number">{iq}</div>
            <div className="kv2-iq-label" style={{ color: iqColor }}>{iqLabel}</div>
          </div>
          <div className="kv2-iq-subtitle">Brain IQ</div>
          <div className="kv2-stats-mini">
            <div className="kv2-stat-pill">
              <span className="kv2-stat-val">{data.entities_tracked}</span>
              <span className="kv2-stat-lbl">Entidades</span>
            </div>
            <div className="kv2-stat-pill">
              <span className="kv2-stat-val">{data.total_measured}</span>
              <span className="kv2-stat-lbl">Medidas</span>
            </div>
            <div className="kv2-stat-pill">
              <span className="kv2-stat-val">{data.win_rate}%</span>
              <span className="kv2-stat-lbl">Win Rate</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Zone Selector ── */}
      <div className="kv2-zone-tabs">
        {[
          { key: 'memory', icon: '\uD83E\uDDE0', label: 'Memoria', count: data.entities_with_history, color: '#3b82f6' },
          { key: 'hypothesis', icon: '\uD83E\uDD14', label: 'Hipotesis', count: data.hypotheses?.length || 0, color: '#a855f7' },
          { key: 'temporal', icon: '\uD83D\uDCC5', label: 'Temporal', count: data.temporal_patterns?.filter(t => t.sample_count > 0).length || 0, color: '#f97316' },
          { key: 'policy', icon: '\uD83C\uDFAF', label: 'Decisiones', count: data.policy?.total_samples || 0, color: '#10b981' }
        ].map(z => (
          <button
            key={z.key}
            className={`kv2-zone-tab ${activeZone === z.key ? 'active' : ''}`}
            style={{ '--zone-color': z.color }}
            onClick={() => setActiveZone(activeZone === z.key ? null : z.key)}
          >
            <span className="kv2-zone-icon">{z.icon}</span>
            <span className="kv2-zone-label">{z.label}</span>
            <span className="kv2-zone-count">{z.count}</span>
          </button>
        ))}
      </div>

      {/* ── Zone Detail Panels ── */}
      {activeZone === 'memory' && (
        <div className="kv2-zone-detail" style={{ '--zone-color': '#3b82f6' }}>
          <div className="kv2-zone-header">
            <h3>Memoria por Entidad</h3>
            <span className="kv2-zone-desc">Historial de acciones y resultados por ad set</span>
          </div>
          {/* Outcome summary */}
          {data.total_action_outcomes > 0 && (
            <div className="kv2-outcome-bar">
              <div className="kv2-outcome-seg improved" style={{ width: `${(data.action_outcomes.improved / data.total_action_outcomes) * 100}%` }}>
                {data.action_outcomes.improved > 0 && <span>{data.action_outcomes.improved}</span>}
              </div>
              <div className="kv2-outcome-seg neutral" style={{ width: `${(data.action_outcomes.neutral / data.total_action_outcomes) * 100}%` }}>
                {data.action_outcomes.neutral > 0 && <span>{data.action_outcomes.neutral}</span>}
              </div>
              <div className="kv2-outcome-seg worsened" style={{ width: `${(data.action_outcomes.worsened / data.total_action_outcomes) * 100}%` }}>
                {data.action_outcomes.worsened > 0 && <span>{data.action_outcomes.worsened}</span>}
              </div>
            </div>
          )}
          <div className="kv2-outcome-legend">
            <span className="improved">Mejoro</span>
            <span className="neutral">Neutral</span>
            <span className="worsened">Empeoro</span>
          </div>
          {/* Entity list */}
          <div className="kv2-entity-list">
            {(data.entity_memories || []).map((entity, i) => (
              <div key={entity.entity_id} className="kv2-entity-card" style={{ animationDelay: `${i * 0.04}s` }}>
                <div className="kv2-entity-header">
                  <span className="kv2-entity-name">{entity.entity_name}</span>
                  <span className={`kv2-entity-trend ${entity.trends?.roas_direction || ''}`}>
                    {entity.trends?.roas_direction === 'improving' ? '\u2191' : entity.trends?.roas_direction === 'declining' ? '\u2193' : '\u2192'}
                  </span>
                </div>
                <div className="kv2-entity-actions">
                  {entity.action_history.slice(-5).map((a, j) => {
                    const acfg = ACTION_TYPE_CONFIG[a.action_type] || { icon: '', label: a.action_type };
                    return (
                      <span key={j} className={`kv2-action-chip ${a.result}`}>
                        {acfg.icon} {acfg.label}
                        {a.roas_delta_pct !== 0 && (
                          <span className="kv2-action-delta">
                            {a.roas_delta_pct > 0 ? '+' : ''}{Math.round(a.roas_delta_pct)}%
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
            {(!data.entity_memories || data.entity_memories.length === 0) && (
              <div className="kv2-empty-zone">Aun no hay entidades con historial. Se llenara cuando se midan acciones aprobadas.</div>
            )}
          </div>
        </div>
      )}

      {activeZone === 'hypothesis' && (
        <div className="kv2-zone-detail" style={{ '--zone-color': '#a855f7' }}>
          <div className="kv2-zone-header">
            <h3>Hipotesis del Brain</h3>
            <span className="kv2-zone-desc">Ideas que el Brain esta probando o ya valido</span>
          </div>
          <div className="kv2-hyp-list">
            {(data.hypotheses || []).map((h, i) => (
              <div key={i} className={`kv2-hyp-card ${h.status}`} style={{ animationDelay: `${i * 0.04}s` }}>
                <div className="kv2-hyp-status">
                  {h.status === 'confirmed' ? '\u2705' : h.status === 'rejected' ? '\u274C' : '\u23F3'}
                  <span>{h.status === 'confirmed' ? 'Confirmada' : h.status === 'rejected' ? 'Rechazada' : 'Activa'}</span>
                </div>
                <div className="kv2-hyp-text">{h.hypothesis}</div>
                {h.proposed_action && (
                  <div className="kv2-hyp-action">Accion propuesta: {h.proposed_action}</div>
                )}
                {h.validation_result && (
                  <div className="kv2-hyp-result">{h.validation_result}</div>
                )}
              </div>
            ))}
            {(!data.hypotheses || data.hypotheses.length === 0) && (
              <div className="kv2-empty-zone">El Brain aun no ha generado hipotesis. Se crean al final de cada ciclo de analisis.</div>
            )}
          </div>
        </div>
      )}

      {activeZone === 'temporal' && (
        <div className="kv2-zone-detail" style={{ '--zone-color': '#f97316' }}>
          <div className="kv2-zone-header">
            <h3>Patrones Temporales</h3>
            <span className="kv2-zone-desc">Promedios por dia de la semana (se estabilizan con mas datos)</span>
          </div>
          <div className="kv2-temporal-grid">
            {['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map((day, i) => {
              const dayLabels = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
              const tp = (data.temporal_patterns || []).find(t => t.day === day);
              const samples = tp?.sample_count || 0;
              const isToday = tp?.is_today;
              const roas = tp?.metrics?.avg_roas || 0;
              const cpa = tp?.metrics?.avg_cpa || 0;
              const maxRoas = Math.max(...(data.temporal_patterns || []).map(t => t.metrics?.avg_roas || 0), 1);
              return (
                <div key={day} className={`kv2-temporal-card ${isToday ? 'today' : ''} ${samples === 0 ? 'empty' : ''}`}>
                  <div className="kv2-temporal-day">{dayLabels[i]}</div>
                  {isToday && <div className="kv2-temporal-today-badge">HOY</div>}
                  <div className="kv2-temporal-bar-wrap">
                    <div className="kv2-temporal-bar" style={{ height: `${roas > 0 ? Math.max(10, (roas / maxRoas) * 100) : 5}%` }} />
                  </div>
                  <div className="kv2-temporal-metrics">
                    <div className="kv2-temporal-val">{roas > 0 ? roas.toFixed(2) : '-'}</div>
                    <div className="kv2-temporal-lbl">ROAS</div>
                    {cpa > 0 && <div className="kv2-temporal-cpa">${cpa.toFixed(0)} CPA</div>}
                  </div>
                  <div className="kv2-temporal-samples">{samples} muestras</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeZone === 'policy' && (
        <div className="kv2-zone-detail" style={{ '--zone-color': '#10b981' }}>
          <div className="kv2-zone-header">
            <h3>Politica de Decisiones</h3>
            <span className="kv2-zone-desc">Thompson Sampling — {data.policy?.total_samples || 0} muestras en {data.policy?.total_buckets || 0} contextos</span>
          </div>
          <div className="kv2-policy-actions">
            {(data.policy?.top_actions || []).map((a, i) => {
              const acfg = ACTION_TYPE_CONFIG[a.action] || { icon: '', label: a.action };
              const barWidth = Math.min(100, a.success_rate);
              const barColor = a.success_rate >= 60 ? '#10b981' : a.success_rate >= 45 ? '#f59e0b' : '#ef4444';
              return (
                <div key={a.action} className="kv2-policy-row" style={{ animationDelay: `${i * 0.04}s` }}>
                  <div className="kv2-policy-action">
                    <span className="kv2-policy-icon">{acfg.icon}</span>
                    <span className="kv2-policy-name">{acfg.label}</span>
                    <span className="kv2-policy-count">{a.count}x</span>
                  </div>
                  <div className="kv2-policy-bar-wrap">
                    <div className="kv2-policy-bar" style={{ width: `${barWidth}%`, background: barColor }} />
                    <span className="kv2-policy-pct">{a.success_rate}%</span>
                  </div>
                </div>
              );
            })}
            {(!data.policy?.top_actions || data.policy.top_actions.length === 0) && (
              <div className="kv2-empty-zone">Aun no hay datos de Thompson Sampling. Se llena cuando se miden acciones aprobadas.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Cycle Memory ── */}
      {data.last_cycle && (
        <div className="kv2-cycle-footer">
          <span className="kv2-cycle-assess">{data.last_cycle.account_assessment || 'N/A'}</span>
          <span className="kv2-cycle-meta">
            Ultimo ciclo: {data.last_cycle.conclusions_count} conclusiones
            {data.last_cycle.created_at && ` \u00B7 ${formatTime(data.last_cycle.created_at)}`}
          </span>
        </div>
      )}
    </div>
  );
}

// ═══ CREATIVES PANEL ═══

const CREATIVE_VERDICT = {
  good: { icon: '✅', label: 'Buen rendimiento', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  bad:  { icon: '🔴', label: 'Bajo rendimiento', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  watch:{ icon: '👁️', label: 'Monitorear', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  new:  { icon: '🆕', label: 'Sin datos', color: '#6b7280', bg: 'rgba(107,114,128,0.12)' }
};

function CreativesPanel({ formatTime }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('spend');
  const [filterVerdict, setFilterVerdict] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    (async () => {
      try {
        const res = await getCreativePerformance();
        setData(res);
      } catch (err) { console.error('Creative performance error:', err); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div className="d-flex align-center justify-center p-4 text-muted"><div className="loading" /> Cargando creativos...</div>;
  if (!data || !data.ads || data.ads.length === 0) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-icon">🎨</div>
        <p>No hay creativos manuales todavia.</p>
        <p className="feed-empty-hint">Cuando subas creativos desde Ad Sets Manager, el Brain rastreara su rendimiento aqui con metricas de 3 dias.</p>
      </div>
    );
  }

  const accountAvg = data.account_avg || {};

  // Filter
  let filtered = data.ads;
  if (filterVerdict !== 'all') filtered = filtered.filter(a => a.verdict === filterVerdict);
  if (filterStatus !== 'all') filtered = filtered.filter(a => a.status === filterStatus);

  // Sort
  filtered = [...filtered].sort((a, b) => {
    const m3a = a.metrics?.last_3d || {};
    const m3b = b.metrics?.last_3d || {};
    if (sortBy === 'spend') return (m3b.spend || 0) - (m3a.spend || 0);
    if (sortBy === 'roas') return (m3b.roas || 0) - (m3a.roas || 0);
    if (sortBy === 'ctr') return (m3b.ctr || 0) - (m3a.ctr || 0);
    if (sortBy === 'cpa') return (m3a.cpa || 0) - (m3b.cpa || 0);
    if (sortBy === 'purchases') return (m3b.purchases || 0) - (m3a.purchases || 0);
    return 0;
  });

  // Summary stats
  const verdictCounts = { good: 0, bad: 0, watch: 0, new: 0 };
  for (const ad of data.ads) verdictCounts[ad.verdict] = (verdictCounts[ad.verdict] || 0) + 1;

  const fmtMoney = (v) => v != null ? `$${v.toFixed(2)}` : '$0.00';
  const fmtPct = (v) => v != null ? `${v.toFixed(2)}%` : '0.00%';
  const fmtNum = (v, d = 2) => v != null ? v.toFixed(d) : '0';

  return (
    <div className="creatives-panel">
      {/* Summary hero */}
      <div className="creatives-hero">
        <div className="creatives-hero-stat">
          <span className="creatives-hero-value" style={{ color: '#10b981' }}>{verdictCounts.good}</span>
          <span className="creatives-hero-label">Buenos</span>
        </div>
        <div className="creatives-hero-stat">
          <span className="creatives-hero-value" style={{ color: '#f59e0b' }}>{verdictCounts.watch}</span>
          <span className="creatives-hero-label">Monitorear</span>
        </div>
        <div className="creatives-hero-stat">
          <span className="creatives-hero-value" style={{ color: '#ef4444' }}>{verdictCounts.bad}</span>
          <span className="creatives-hero-label">Bajo rend.</span>
        </div>
        <div className="creatives-hero-stat">
          <span className="creatives-hero-value" style={{ color: '#6b7280' }}>{verdictCounts.new}</span>
          <span className="creatives-hero-label">Sin datos</span>
        </div>
        <div className="creatives-hero-stat creatives-hero-ref">
          <span className="creatives-hero-value">{fmtNum(accountAvg.roas_3d)}x</span>
          <span className="creatives-hero-label">ROAS prom 3d</span>
        </div>
        <div className="creatives-hero-stat creatives-hero-ref">
          <span className="creatives-hero-value">{fmtPct(accountAvg.ctr_3d)}</span>
          <span className="creatives-hero-label">CTR prom 3d</span>
        </div>
      </div>

      {/* Filters & Sort */}
      <div className="creatives-filters">
        <div className="d-flex gap-2 align-center">
          <select className="creatives-select" value={filterVerdict} onChange={(e) => setFilterVerdict(e.target.value)}>
            <option value="all">Todos los veredictos</option>
            <option value="good">✅ Buenos</option>
            <option value="watch">👁️ Monitorear</option>
            <option value="bad">🔴 Bajo rendimiento</option>
            <option value="new">🆕 Sin datos</option>
          </select>
          <select className="creatives-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="all">Todos los status</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
          </select>
        </div>
        <div className="d-flex gap-2 align-center">
          <span className="text-xs text-tertiary">Ordenar:</span>
          {['spend', 'roas', 'ctr', 'cpa', 'purchases'].map(s => (
            <button key={s} onClick={() => setSortBy(s)}
              className={`creatives-sort-btn ${sortBy === s ? 'active' : ''}`}>
              {s === 'spend' ? 'Gasto' : s === 'roas' ? 'ROAS' : s === 'ctr' ? 'CTR' : s === 'cpa' ? 'CPA' : 'Compras'}
            </button>
          ))}
        </div>
      </div>

      {/* Ads table */}
      <div className="creatives-table-wrap">
        <table className="creatives-table">
          <thead>
            <tr>
              <th>Ad</th>
              <th>Ad Set</th>
              <th>Status</th>
              <th>Veredicto</th>
              <th style={{ textAlign: 'right' }}>Spend 3d</th>
              <th style={{ textAlign: 'right' }}>ROAS 3d</th>
              <th style={{ textAlign: 'right' }}>Compras 3d</th>
              <th style={{ textAlign: 'right' }}>CPA 3d</th>
              <th style={{ textAlign: 'right' }}>CTR 3d</th>
              <th style={{ textAlign: 'right' }}>Freq 3d</th>
              <th>Tendencia</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(ad => {
              const m3 = ad.metrics?.last_3d || {};
              const vc = CREATIVE_VERDICT[ad.verdict] || CREATIVE_VERDICT.new;
              const roasClass = m3.roas >= (accountAvg.roas_3d || 0) * 1.2 ? 'cv-good' : m3.roas < (accountAvg.roas_3d || 0) * 0.5 ? 'cv-bad' : '';
              const freqClass = (m3.frequency || 0) >= 3.5 ? 'cv-bad' : (m3.frequency || 0) >= 2.5 ? 'cv-warn' : '';
              const trendIcon = ad.trend === 'improving' ? '📈' : ad.trend === 'declining' ? '📉' : '➡️';

              return (
                <tr key={ad.ad_id}>
                  <td className="creatives-ad-name" title={ad.ad_name}>
                    {ad.ad_name.length > 35 ? ad.ad_name.substring(0, 35) + '...' : ad.ad_name}
                  </td>
                  <td className="text-tertiary text-xs">{ad.adset_name?.length > 20 ? ad.adset_name.substring(0, 20) + '...' : ad.adset_name}</td>
                  <td>
                    <span className={`creatives-status ${ad.status === 'ACTIVE' ? 'active' : 'paused'}`}>
                      {ad.status === 'ACTIVE' ? 'Active' : 'Paused'}
                    </span>
                  </td>
                  <td>
                    <span className="creatives-verdict" style={{ background: vc.bg, color: vc.color }}>
                      {vc.icon} {vc.label}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }} className="font-mono">{fmtMoney(m3.spend)}</td>
                  <td style={{ textAlign: 'right' }} className={`font-mono font-bold ${roasClass}`}>{fmtNum(m3.roas)}x</td>
                  <td style={{ textAlign: 'right' }} className="font-mono">{m3.purchases || 0}</td>
                  <td style={{ textAlign: 'right' }} className="font-mono">{m3.cpa > 0 ? fmtMoney(m3.cpa) : '—'}</td>
                  <td style={{ textAlign: 'right' }} className="font-mono">{fmtPct(m3.ctr)}</td>
                  <td style={{ textAlign: 'right' }} className={`font-mono ${freqClass}`}>{fmtNum(m3.frequency)}</td>
                  <td className="text-center">{trendIcon}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-tertiary" style={{ marginTop: '8px', textAlign: 'right' }}>
        {filtered.length} de {data.ads.length} ads — Datos de los ultimos snapshots
      </div>
    </div>
  );
}

// ═══ CHAT PANEL ═══

function ChatPanel({
  messages, chatInput, chatSending, chatLoading,
  chatEndRef, chatInputRef,
  onInputChange, onSend, onClear, formatTime,
  attachedRec, onClearAttachment
}) {
  return (
    <div className="chat-panel">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-brain-orb">
            <div className="chat-orb-ring" />
            <span className="chat-brain-icon">🧠</span>
          </div>
          <div>
            <div className="chat-header-title">Brain Analyst</div>
            <div className="chat-header-sub">
              {chatSending ? (
                <span className="chat-status-active">Analizando...</span>
              ) : 'Pregunta sobre tus campanas'}
            </div>
          </div>
        </div>
        {messages.length > 0 && (
          <button className="btn-clear-chat" onClick={onClear}>
            Limpiar
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {chatLoading ? (
          <div className="chat-loading">Cargando historial...</div>
        ) : messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-welcome-orb">
              <div className="chat-welcome-ring" />
              <span>🧠</span>
            </div>
            <h3>Brain Analyst</h3>
            <p>Soy el analista inteligente de tus campanas de Meta Ads. Conozco cada ad set, sus metricas, tendencias y rendimiento.</p>
            <div className="chat-suggestions">
              <button className="chat-suggestion" onClick={() => onInputChange('¿Cual es el ad set con mejor ROAS?')}>
                Mejor ROAS
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Que ad sets deberia considerar pausar?')}>
                Ad sets a pausar
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('Dame un resumen del estado de las campanas')}>
                Resumen general
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Hay alguna anomalia o problema?')}>
                Anomalias
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Cuales son las tendencias de esta semana?')}>
                Tendencias
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Que oportunidades de escalado hay?')}>
                Oportunidades
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`chat-message ${msg.role}`}>
              {msg.role === 'assistant' && (
                <div className="chat-msg-avatar-wrap">
                  <span className="chat-msg-avatar">🧠</span>
                </div>
              )}
              <div className="chat-msg-content">
                {/* Show attached rec context if this is a user message with rec prefix */}
                {msg.role === 'user' && msg.content.startsWith('[Rec:') && (
                  <div className="chat-msg-rec-context">
                    Discutiendo recomendacion
                  </div>
                )}
                <div className={`chat-msg-text ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  ) : (
                    msg.content.startsWith('[Rec:') ? msg.content.replace(/^\[Rec:.*?\]\s*/, '') : msg.content
                  )}
                </div>
                <div className="chat-msg-meta">
                  <span>{formatTime(msg.created_at)}</span>
                  {msg.tokens_used > 0 && <span className="chat-token-count">{msg.tokens_used} tokens</span>}
                </div>
              </div>
            </div>
          ))
        )}
        {chatSending && (
          <div className="chat-message assistant">
            <div className="chat-msg-avatar-wrap">
              <span className="chat-msg-avatar">🧠</span>
            </div>
            <div className="chat-msg-content">
              <div className="chat-msg-text typing">
                <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Attached recommendation chip */}
      {attachedRec && (
        <div className="chat-attached-rec">
          <div className="chat-attached-inner">
            <span className="chat-attached-icon">🎯</span>
            <div className="chat-attached-info">
              <span className="chat-attached-label">Discutiendo:</span>
              <span className="chat-attached-title">{attachedRec.title}</span>
            </div>
            <button className="chat-attached-close" onClick={onClearAttachment}>&times;</button>
          </div>
        </div>
      )}

      {/* Input */}
      <form className="chat-input-form" onSubmit={onSend}>
        <input
          ref={chatInputRef}
          type="text"
          className="chat-input"
          value={chatInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={attachedRec ? `Pregunta sobre: ${attachedRec.title}` : 'Pregunta sobre tus campanas...'}
          disabled={chatSending}
          autoFocus
        />
        <button type="submit" className="btn-send" disabled={chatSending || !chatInput.trim()}>
          {chatSending ? (
            <span className="send-loading" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </form>
    </div>
  );
}
