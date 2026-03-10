import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  getBrainInsights, markInsightRead, markAllInsightsRead,
  triggerBrainAnalysis, sendBrainChat, sendBrainChatStream, getBrainChatHistory,
  clearBrainChatHistory, getBrainStats, getBrainRecommendations,
  approveRecommendation, rejectRecommendation, markRecommendationExecuted,
  triggerBrainRecommendations, getFollowUpStats,
  getPolicyState, getKnowledgeHistory, getDeepKnowledge, getCreativePerformance,
  getAdHealth, logout
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
  const [chatThinking, setChatThinking] = useState(null); // { phase, text }
  const [streamingText, setStreamingText] = useState('');
  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);
  const streamAbortRef = useRef(null);

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

  // Load recs on mount so chat picker has data even before visiting recs tab
  useEffect(() => {
    if (recommendations.length === 0) loadRecommendations();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [chatMessages, streamingText, chatThinking]);

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

    // Prepend rec/followup context if attached
    let fullMsg = msg;
    let displayMsg = msg;
    if (attachedRec) {
      let recCtx;
      if (attachedRec._isFollowUp) {
        recCtx = `[Seguimiento: "${attachedRec.title}" — ${attachedRec.action_type} — ${attachedRec.entity?.entity_name || 'N/A'} — ${attachedRec._followUpContext}] `;
      } else {
        recCtx = `[Rec: "${attachedRec.title}" — ${attachedRec.action_type} — ${attachedRec.entity?.entity_name || 'N/A'} — Conf: ${attachedRec.confidence_score || 50}%] `;
      }
      fullMsg = recCtx + msg;
      displayMsg = fullMsg;
      setAttachedRec(null);
    }

    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: displayMsg, created_at: new Date().toISOString() }]);
    setChatSending(true);
    setChatThinking({ phase: 'loading', text: 'Cargando datos...' });
    setStreamingText('');

    const { abort } = sendBrainChatStream(fullMsg, {
      onThinking: (data) => {
        setChatThinking({ phase: data.phase, text: data.text });
      },
      onDelta: (text) => {
        setChatThinking(null);
        setStreamingText(prev => prev + text);
      },
      onDone: (data) => {
        setStreamingText(prev => {
          setChatMessages(msgs => [...msgs, {
            role: 'assistant',
            content: prev,
            tokens_used: data.tokens_used || 0,
            created_at: new Date().toISOString()
          }]);
          return '';
        });
        setChatSending(false);
        setChatThinking(null);
        chatInputRef.current?.focus();
      },
      onError: (err) => {
        setChatMessages(prev => [...prev, {
          role: 'assistant',
          content: `Error: ${err.message}`,
          created_at: new Date().toISOString()
        }]);
        setChatSending(false);
        setChatThinking(null);
        setStreamingText('');
        chatInputRef.current?.focus();
      }
    });

    streamAbortRef.current = abort;
  };

  const handleDiscussRec = (rec) => {
    setAttachedRec(rec);
    setActiveTab('chat');
    setChatInput('');
    setTimeout(() => chatInputRef.current?.focus(), 100);
  };

  const handleDiscussFollowUp = (followUp) => {
    // Build a rich context object that looks like a rec for the chat
    // Handles both in-progress items (day_3, hours_since_approved) and timeline items (phases.day_3, roas_before)
    const d3 = followUp.day_3 || followUp.phases?.day_3;
    const d3Info = d3
      ? ` — Dia 3: ROAS ${(d3.roas_pct || 0) > 0 ? '+' : ''}${d3.roas_pct || 0}%, CPA ${(d3.cpa_pct || 0) > 0 ? '+' : ''}${d3.cpa_pct || 0}%, verdict: ${d3.verdict || 'N/A'}`
      : ' — Sin medicion dia 3 aun';
    const roasRef = followUp.roas_at_approval ?? followUp.roas_before ?? null;
    const ctxRec = {
      title: followUp.title || followUp.impact_summary || 'Seguimiento',
      action_type: followUp.action_type,
      entity: { entity_name: followUp.entity_name },
      confidence_score: followUp.confidence_score || 50,
      _isFollowUp: true,
      _followUpContext: `${followUp.hours_since_approved != null ? Math.floor(followUp.hours_since_approved / 24) + 'd desde aprobacion. ' : ''}ROAS ref: ${roasRef != null ? roasRef.toFixed(2) : '?'}x${d3Info}. Phase: ${followUp.current_phase || followUp.impact_verdict || 'measured'}. Ejecutada: ${followUp.action_executed ? 'si' : 'no'}`
    };
    setAttachedRec(ctxRec);
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
            pendingCount={recsPendingCount}
            entityCount={stats?.entities_tracked || 0}
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
          <FollowUpPanel formatTime={formatTime} onApprovalAction={openApprovalModal} onDiscuss={handleDiscussFollowUp} />
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
            chatThinking={chatThinking}
            streamingText={streamingText}
            chatEndRef={chatEndRef}
            chatInputRef={chatInputRef}
            onInputChange={setChatInput}
            onSend={handleSendChat}
            onClear={handleClearChat}
            formatTime={formatTime}
            attachedRec={attachedRec}
            onClearAttachment={() => setAttachedRec(null)}
            recommendations={recommendations}
            onAttachRec={handleDiscussRec}
            onAttachFollowUp={handleDiscussFollowUp}
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

// ═══ FEED PANEL — Split-panel: compact list left, detail right ═══

function FeedPanel({
  insights, loadingInsights, analyzing, typeFilter, severityFilter,
  insightsPage, totalPages, insightsTotal, stats, unreadCount, pendingCount, entityCount,
  onTypeFilter, onSeverityFilter, onAnalyze, onMarkAllRead, onInsightClick, onPageChange,
  formatTime
}) {
  const [selectedId, setSelectedId] = useState(null);
  const selectedInsight = insights.find(i => i._id === selectedId) || null;

  // Auto-select first insight when list loads
  useEffect(() => {
    if (insights.length > 0 && !selectedId) {
      setSelectedId(insights[0]._id);
      onInsightClick(insights[0]);
    }
  }, [insights]);

  return (
    <div className="feed-panel split-layout">
      {/* Brain Orb Hero — compact inline bar */}
      <div className="feed-hero-compact">
        <div className="feed-hero-orb-mini">
          <Suspense fallback={<div className="brain-orb-fallback-mini"><div className="orb-placeholder-mini" /></div>}>
            <BrainOrb
              stats={stats}
              unreadCount={unreadCount || 0}
              analyzing={analyzing}
              brainState={analyzing ? 'analyzing' : 'idle'}
              thoughtText={analyzing ? 'Procesando patrones...' : ''}
              pendingCount={pendingCount || 0}
              entityCount={entityCount || stats?.entities_tracked || 0}
            />
          </Suspense>
        </div>
        <div className="feed-hero-info-compact">
          <span className="feed-hero-title-compact">Neural Feed</span>
          <span className="feed-hero-counts">
            {insightsTotal > 0 && <span className="feed-count-chip">{insightsTotal} insights</span>}
            {unreadCount > 0 && <span className="feed-count-chip unread">{unreadCount} sin leer</span>}
            {(entityCount || stats?.entities_tracked || 0) > 0 && (
              <span className="feed-count-chip">{entityCount || stats?.entities_tracked} entidades</span>
            )}
          </span>
        </div>
        <div className="feed-hero-actions-compact">
          <button className="btn-ghost btn-small" onClick={onMarkAllRead} title="Marcar todo leido">
            Todo leido
          </button>
          <button
            className={`btn-primary btn-small ${analyzing ? 'btn-analyzing' : ''}`}
            onClick={onAnalyze}
            disabled={analyzing}
          >
            {analyzing ? '...' : 'Analizar'}
          </button>
        </div>
      </div>

      {/* Split container */}
      <div className="split-container">
        {/* LEFT: Compact list */}
        <div className="split-list">
          {/* Mini toolbar */}
          <div className="split-list-toolbar">
            <select className="feed-select-mini" value={typeFilter} onChange={(e) => onTypeFilter(e.target.value)}>
              <option value="all">Tipo</option>
              {Object.entries(INSIGHT_TYPE_CONFIG).map(([key, cfg]) => (
                <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
              ))}
            </select>
            <select className="feed-select-mini" value={severityFilter} onChange={(e) => onSeverityFilter(e.target.value)}>
              <option value="all">Sev.</option>
              {Object.entries(SEVERITY_CONFIG).map(([key, cfg]) => (
                <option key={key} value={key}>{cfg.label}</option>
              ))}
            </select>
            <span className="split-list-count">{insightsTotal}</span>
          </div>

          {/* List items */}
          <div className="split-list-items">
            {loadingInsights ? (
              <div className="split-list-empty"><div className="feed-loading-pulse" /></div>
            ) : insights.length === 0 ? (
              <div className="split-list-empty">
                <span className="split-list-empty-icon">🧠</span>
                <span>Sin insights aun</span>
              </div>
            ) : (
              insights.map((insight) => {
                const typeCfg = INSIGHT_TYPE_CONFIG[insight.insight_type] || INSIGHT_TYPE_CONFIG.anomaly;
                const sevCfg = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.medium;
                const isSelected = selectedId === insight._id;
                return (
                  <div
                    key={insight._id}
                    className={`split-row ${isSelected ? 'selected' : ''} ${!insight.read ? 'unread' : ''} severity-${insight.severity}`}
                    onClick={() => {
                      setSelectedId(insight._id);
                      onInsightClick(insight);
                    }}
                  >
                    <div className="split-row-accent" style={{ background: sevCfg.color }} />
                    <div className="split-row-icon" style={{ color: typeCfg.color }}>{typeCfg.icon}</div>
                    <div className="split-row-content">
                      <div className="split-row-title">
                        {insight.title}
                        {!insight.read && <span className="split-row-dot" />}
                      </div>
                      <div className="split-row-meta">
                        <span className="split-row-type" style={{ color: typeCfg.color }}>{typeCfg.label}</span>
                        {insight.entities?.[0] && (
                          <span className="split-row-entity">{insight.entities[0].entity_name}</span>
                        )}
                        <span className="split-row-time">{formatTime(insight.created_at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination — compact */}
          {totalPages > 1 && (
            <div className="split-list-pagination">
              <button className="btn-page-mini" disabled={insightsPage <= 1} onClick={() => onPageChange(insightsPage - 1)}>←</button>
              <span className="page-info-mini">{insightsPage}/{totalPages}</span>
              <button className="btn-page-mini" disabled={insightsPage >= totalPages} onClick={() => onPageChange(insightsPage + 1)}>→</button>
            </div>
          )}
        </div>

        {/* RIGHT: Detail panel */}
        <div className="split-detail">
          {selectedInsight ? (
            <InsightDetail insight={selectedInsight} formatTime={formatTime} />
          ) : (
            <div className="split-detail-empty">
              <div className="split-detail-empty-icon">🧠</div>
              <p>Selecciona un insight</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══ INSIGHT DETAIL — Full detail panel for selected insight ═══

function InsightDetail({ insight, formatTime }) {
  const typeCfg = INSIGHT_TYPE_CONFIG[insight.insight_type] || INSIGHT_TYPE_CONFIG.anomaly;
  const sevCfg = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.medium;

  return (
    <div className="insight-detail" style={{ '--card-accent': typeCfg.color, '--severity-color': sevCfg.color }}>
      {/* Header */}
      <div className="insight-detail-header">
        <div className="insight-detail-severity-bar" style={{ background: `linear-gradient(90deg, ${sevCfg.color}, transparent)` }} />
        <div className="insight-detail-top">
          <div className="insight-detail-type-badge" style={{ background: `${typeCfg.color}20`, borderColor: `${typeCfg.color}40` }}>
            <span className="insight-type-icon">{typeCfg.icon}</span>
          </div>
          <div className="insight-detail-title-area">
            <h3 className="insight-detail-title">{insight.title}</h3>
            <div className="insight-detail-tags">
              <span className="insight-tag type" style={{ color: typeCfg.color, backgroundColor: `${typeCfg.color}18` }}>
                {typeCfg.label}
              </span>
              <span className="insight-tag severity" style={{ color: sevCfg.color, backgroundColor: sevCfg.bg }}>
                {sevCfg.label}
              </span>
              {insight.follows_up && <span className="insight-tag followup">Seguimiento</span>}
              {insight.diagnosis && <span className="insight-tag diagnosis">{insight.diagnosis}</span>}
              <span className={`insight-source source-${insight.generated_by}`}>
                {insight.generated_by === 'ai' ? 'IA' : insight.generated_by === 'hybrid' ? 'Hybrid' : insight.generated_by === 'brain' ? 'Brain' : 'Math'}
              </span>
            </div>
          </div>
          <span className="insight-detail-time">{formatTime(insight.created_at)}</span>
        </div>

        {/* Entity badges */}
        {insight.entities && insight.entities.length > 0 && (
          <div className="insight-detail-entities">
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

      {/* Body — always visible in detail panel */}
      <div className="insight-detail-body">
        <div className="insight-detail-body-text markdown-body">
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
            <span>Recomendacion pendiente vinculada</span>
            <span className="rec-link-arrow">→ Recomendaciones</span>
          </div>
        )}

        {insight.follow_up_count > 0 && (
          <div className="insight-follow-info">
            {insight.follow_up_count} seguimiento{insight.follow_up_count > 1 ? 's' : ''} posterior{insight.follow_up_count > 1 ? 'es' : ''}
          </div>
        )}
      </div>
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
  pause:              { icon: '⏸️', label: 'Pausar',        color: '#ef4444', bg: 'rgba(239,68,68,0.10)' },
  scale_up:           { icon: '📈', label: 'Escalar',       color: '#10b981', bg: 'rgba(16,185,129,0.10)' },
  scale_down:         { icon: '📉', label: 'Reducir',       color: '#f59e0b', bg: 'rgba(245,158,11,0.10)' },
  reactivate:         { icon: '▶️', label: 'Reactivar',     color: '#3b82f6', bg: 'rgba(59,130,246,0.10)' },
  create_ad:          { icon: '🎨', label: 'Crear Ad',      color: '#8b5cf6', bg: 'rgba(139,92,246,0.10)' },
  update_ad_status:   { icon: '⏸️', label: 'Pausar Ad',     color: '#f87171', bg: 'rgba(248,113,113,0.10)' },
  duplicate_adset:    { icon: '📋', label: 'Duplicar',      color: '#06b6d4', bg: 'rgba(6,182,212,0.10)' },
  move_budget:        { icon: '🔄', label: 'Mover Budget',  color: '#6366f1', bg: 'rgba(99,102,241,0.10)' },
  update_bid_strategy:{ icon: '💰', label: 'Bid Strategy',  color: '#ec4899', bg: 'rgba(236,72,153,0.10)' },
  observe:            { icon: '👁️', label: 'Observar',      color: '#6b7280', bg: 'rgba(107,114,128,0.10)' },
  // Legacy — para recs históricas
  restructure:        { icon: '🔧', label: 'Reestructurar', color: '#f97316', bg: 'rgba(249,115,22,0.10)' },
  creative_refresh:   { icon: '🎨', label: 'Creativos',     color: '#8b5cf6', bg: 'rgba(139,92,246,0.10)' },
  bid_change:         { icon: '💰', label: 'Puja',          color: '#ec4899', bg: 'rgba(236,72,153,0.10)' },
  monitor:            { icon: '👁️', label: 'Monitorear',    color: '#6b7280', bg: 'rgba(107,114,128,0.10)' },
  other:              { icon: '📋', label: 'Otro',           color: '#9ca3af', bg: 'rgba(156,163,175,0.10)' }
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
  const [selectedId, setSelectedId] = useState(null);
  const [actionFilter, setActionFilter] = useState('');
  const selectedRec = recommendations.find(r => r._id === selectedId) || null;

  // Build ordered list: pending first, then tracking, then history
  const orderedRecs = useMemo(() => {
    let recs = recommendations;
    if (actionFilter) recs = recs.filter(r => r.action_type === actionFilter);
    if (statusFilter) return recs;
    const pending = recs.filter(r => r.status === 'pending' && !r.related_follow_up?.rec_id);
    const tracking = recs.filter(r =>
      r.status === 'approved' && !r.follow_up?.checked && r.follow_up?.current_phase !== 'complete'
    );
    const history = recs.filter(r =>
      r.status !== 'pending' && !(r.status === 'approved' && !r.follow_up?.checked && r.follow_up?.current_phase !== 'complete')
    );
    return [...pending, ...tracking, ...history];
  }, [recommendations, statusFilter, actionFilter]);

  // Auto-select first rec when list loads
  useEffect(() => {
    if (orderedRecs.length > 0 && !selectedId) {
      setSelectedId(orderedRecs[0]._id);
    }
  }, [orderedRecs]);

  return (
    <div className="recs-panel split-layout">
      {/* Compact hero bar */}
      <div className="recs-hero-compact">
        <div className="recs-hero-stats-compact">
          <div className="recs-hero-stat-mini highlight">
            <span className="recs-stat-val">{pendingCount}</span>
            <span className="recs-stat-lbl">Pendientes</span>
          </div>
          <div className="recs-hero-stat-mini">
            <span className="recs-stat-val">{recsTotal}</span>
            <span className="recs-stat-lbl">Total</span>
          </div>
        </div>
        <div className="recs-hero-actions-compact">
          <select className="feed-select-mini" value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)}>
            <option value="">Todas</option>
            <option value="pending">Pendientes</option>
            <option value="approved">Aprobadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="expired">Expiradas</option>
          </select>
          <select className="feed-select-mini" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">Accion</option>
            <option value="pause">⏸️ Pausar</option>
            <option value="scale_up">📈 Escalar</option>
            <option value="scale_down">📉 Reducir</option>
            <option value="reactivate">▶️ Reactivar</option>
            <option value="create_ad">🎨 Crear Ad</option>
            <option value="update_ad_status">⏸️ Pausar Ad</option>
            <option value="duplicate_adset">📋 Duplicar</option>
            <option value="move_budget">🔄 Mover Budget</option>
            <option value="observe">👁️ Observar</option>
          </select>
          <button
            className={`btn-primary btn-small ${generating ? 'btn-analyzing' : ''}`}
            onClick={!generating ? onGenerate : undefined}
            disabled={generating}
          >
            {generating ? '...' : '+ Generar'}
          </button>
        </div>
      </div>

      {/* Split container */}
      <div className="split-container">
        {/* LEFT: Compact rec list */}
        <div className="split-list">
          <div className="split-list-items">
            {loading ? (
              <div className="split-list-empty"><div className="feed-loading-pulse" /></div>
            ) : orderedRecs.length === 0 ? (
              <div className="split-list-empty">
                <span className="split-list-empty-icon">🎯</span>
                <span>Sin recomendaciones</span>
              </div>
            ) : (
              orderedRecs.map((rec) => {
                const priorityCfg = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.evaluar;
                const actionCfg = ACTION_TYPE_CONFIG[rec.action_type] || ACTION_TYPE_CONFIG.other;
                const statusCfg = STATUS_LABELS[rec.status] || STATUS_LABELS.pending;
                const isSelected = selectedId === rec._id;
                const isTracking = rec.status === 'approved' && !rec.follow_up?.checked && rec.follow_up?.current_phase !== 'complete';
                return (
                  <div
                    key={rec._id}
                    className={`split-row ${isSelected ? 'selected' : ''} rec-status-${rec.status} ${isTracking ? 'tracking' : ''}`}
                    onClick={() => setSelectedId(rec._id)}
                  >
                    <div className="split-row-accent" style={{ background: priorityCfg.color }} />
                    <div className="split-row-icon" style={{ background: actionCfg.bg, color: actionCfg.color, borderRadius: 6, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>{actionCfg.icon}</div>
                    <div className="split-row-content">
                      <div className="split-row-title">{rec.title}</div>
                      <div className="split-row-meta">
                        <span className={`rec-status-tag status-${rec.status}`} style={{ color: statusCfg.color, borderColor: statusCfg.color }}>
                          {statusCfg.label}
                        </span>
                        <span className="rec-action-chip" style={{ color: actionCfg.color, background: actionCfg.bg }}>
                          {actionCfg.label}
                        </span>
                        <span className="split-row-type" style={{ color: priorityCfg.color }}>{priorityCfg.label}</span>
                        {rec.entity && (
                          <span className="split-row-entity">
                            <span className="entity-type-indicator" style={{
                              background: rec.entity.entity_type === 'ad' ? '#10b981' : rec.entity.entity_type === 'campaign' ? '#8b5cf6' : '#3b82f6'
                            }} />
                            {rec.entity.entity_name}
                          </span>
                        )}
                        {rec.parent_adset_name && <span className="split-row-entity" style={{ opacity: 0.6 }}>en {rec.parent_adset_name}</span>}
                        <span className="split-row-time">{formatTime(rec.created_at)}</span>
                      </div>
                    </div>
                    <div className="split-row-actions">
                      <div className="split-row-confidence" title={`${rec.confidence_score || 50}%`}>
                        <span className="split-row-conf-val">{rec.confidence_score || 50}</span>
                      </div>
                      {onDiscussRec && (
                        <button
                          className="btn-discuss-mini"
                          title="Discutir con Brain"
                          onClick={(e) => { e.stopPropagation(); onDiscussRec(rec); }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="split-list-pagination">
              <button className="btn-page-mini" disabled={recsPage <= 1} onClick={() => onPageChange(recsPage - 1)}>←</button>
              <span className="page-info-mini">{recsPage}/{totalPages}</span>
              <button className="btn-page-mini" disabled={recsPage >= totalPages} onClick={() => onPageChange(recsPage + 1)}>→</button>
            </div>
          )}
        </div>

        {/* RIGHT: Rec detail */}
        <div className="split-detail">
          {selectedRec ? (
            <RecDetail
              rec={selectedRec}
              onApprove={() => onApprove(selectedRec._id)}
              onReject={() => onReject(selectedRec._id)}
              onDiscuss={onDiscussRec ? () => onDiscussRec(selectedRec) : undefined}
              onGoToFollowUp={onGoToFollowUp}
              formatTime={formatTime}
            />
          ) : (
            <div className="split-detail-empty">
              <div className="split-detail-empty-icon">🎯</div>
              <p>Selecciona una recomendacion</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══ REC DETAIL — Full detail panel for selected recommendation ═══

function RecDetail({ rec, onApprove, onReject, onDiscuss, onGoToFollowUp, formatTime }) {
  const priorityCfg = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.evaluar;
  const actionCfg = ACTION_TYPE_CONFIG[rec.action_type] || ACTION_TYPE_CONFIG.other;
  const statusCfg = STATUS_LABELS[rec.status] || STATUS_LABELS.pending;
  const confidencePct = rec.confidence_score || 50;
  const [showContext, setShowContext] = useState(false);

  const followUp = rec.follow_up || {};
  const currentPhase = followUp.current_phase || 'awaiting_day_3';
  const phases = followUp.phases || {};
  const isTracking = rec.status === 'approved' && !followUp.checked && currentPhase !== 'complete';
  const hoursSinceApproval = rec.decided_at ? Math.round((Date.now() - new Date(rec.decided_at).getTime()) / 3600000) : 0;
  const daysAgo = hoursSinceApproval >= 24
    ? `${Math.floor(hoursSinceApproval / 24)}d ${hoursSinceApproval % 24}h`
    : `${hoursSinceApproval}h`;

  // Contar secciones colapsables para el toggle
  const hasContextSections = rec.diagnosis || rec.expected_outcome || rec.risk || (rec.body && rec.body.length > 10);

  return (
    <div className="rec-detail">
      {/* Header */}
      <div className="rec-detail-header">
        <div className="rec-detail-priority-bar" style={{ background: `linear-gradient(90deg, ${priorityCfg.color}, transparent)` }} />
        <div className="rec-detail-top">
          <div className="rec-action-icon" style={{ background: actionCfg.bg, color: actionCfg.color }}>
            {actionCfg.icon}
          </div>
          <div className="rec-detail-title-area">
            <h3 className="rec-detail-title">{rec.title}</h3>
            <div className="rec-detail-tags">
              <span className="rec-tag priority" style={{ color: priorityCfg.color, backgroundColor: priorityCfg.bg }}>
                {priorityCfg.label}
              </span>
              <span className="rec-tag action" style={{ color: actionCfg.color, background: actionCfg.bg }}>{actionCfg.icon} {actionCfg.label}</span>
              <span className="rec-status-pill" style={{ color: statusCfg.color, borderColor: statusCfg.color }}>
                {statusCfg.label}
              </span>
            </div>
          </div>
          <div className="rec-detail-right">
            <span className="rec-detail-time">{formatTime(rec.created_at)}</span>
            <div className="rec-confidence-gauge" title={`Confianza: ${confidencePct}%`}>
              <svg width="44" height="44" viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                <circle cx="22" cy="22" r="18" fill="none"
                  stroke={confidencePct >= 70 ? '#10b981' : confidencePct >= 45 ? '#f59e0b' : '#ef4444'}
                  strokeWidth="3"
                  strokeDasharray={`${(confidencePct / 100) * 113.1} 113.1`}
                  strokeLinecap="round"
                  transform="rotate(-90 22 22)"
                />
                <text x="22" y="23" textAnchor="middle" dominantBaseline="middle"
                  fill="var(--text-primary)" fontSize="11" fontWeight="700">
                  {confidencePct}
                </text>
              </svg>
            </div>
          </div>
        </div>

        {/* Entity badge */}
        {rec.entity && (
          <div className="rec-detail-entity">
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
            {rec.parent_adset_name && (
              <span className="rec-entity-parent">
                <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>en</span>
                <span className="rec-entity-badge" style={{ opacity: 0.7 }}>
                  <span className="entity-type-dot" style={{ background: '#3b82f6' }} />
                  <span className="entity-type-label">Ad Set</span>
                  <span className="entity-name">{rec.parent_adset_name}</span>
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="rec-detail-body">
        {/* Related follow-up context — compact inline */}
        {rec.related_follow_up?.rec_id && (
          <div className={`rec-followup-context-inline ${rec.related_follow_up.day_3_verdict || 'pending'}`}>
            <span className={`rec-followup-verdict-dot ${rec.related_follow_up.day_3_verdict || 'pending'}`} />
            <span className="rec-followup-inline-label">
              {rec.related_follow_up.day_3_verdict === 'negative' ? 'Seguimiento negativo' :
               rec.related_follow_up.day_3_verdict === 'positive' ? 'Seguimiento positivo' : 'Seguimiento previo'}
            </span>
            <span className="rec-followup-inline-action">
              {ACTION_TYPE_CONFIG[rec.related_follow_up.action_type]?.icon}{' '}
              {ACTION_TYPE_CONFIG[rec.related_follow_up.action_type]?.label || rec.related_follow_up.action_type}
            </span>
            <span className="rec-followup-inline-phase">
              {rec.related_follow_up.current_phase === 'awaiting_day_7' ? 'dia 3' :
               rec.related_follow_up.current_phase === 'awaiting_day_14' ? 'dia 7' :
               rec.related_follow_up.current_phase === 'complete' ? 'completo' : 'dia 3'}
            </span>
          </div>
        )}

        {/* === ACCION PRINCIPAL — siempre visible y prominente === */}
        <div className="rec-action-detail">
          <strong>Que hacer:</strong> {rec.action_detail}
        </div>

        {/* Metrics strip — compact horizontal */}
        {rec.supporting_data && (
          <div className="rec-metrics-strip">
            {rec.supporting_data.current_roas_7d > 0 && (
              <span className={`rec-metric-chip ${rec.supporting_data.account_avg_roas_7d > 0 && rec.supporting_data.current_roas_7d < rec.supporting_data.account_avg_roas_7d * 0.7 ? 'bad' : rec.supporting_data.current_roas_7d >= rec.supporting_data.account_avg_roas_7d ? 'good' : ''}`}>
                ROAS <strong>{rec.supporting_data.current_roas_7d.toFixed(2)}x</strong>
                {rec.supporting_data.account_avg_roas_7d > 0 && (
                  <span className="rec-metric-ref">/ {rec.supporting_data.account_avg_roas_7d.toFixed(2)}x</span>
                )}
              </span>
            )}
            {rec.supporting_data.current_cpa_7d > 0 && (
              <span className="rec-metric-chip">
                CPA <strong>${rec.supporting_data.current_cpa_7d.toFixed(0)}</strong>
              </span>
            )}
            {rec.supporting_data.current_spend_7d > 0 && (
              <span className="rec-metric-chip">
                Spend <strong>${rec.supporting_data.current_spend_7d.toFixed(0)}</strong>
              </span>
            )}
            {rec.supporting_data.current_frequency_7d > 0 && (
              <span className={`rec-metric-chip ${rec.supporting_data.current_frequency_7d >= 3.5 ? 'bad' : rec.supporting_data.current_frequency_7d >= 2.5 ? 'warn' : ''}`}>
                Freq <strong>{rec.supporting_data.current_frequency_7d.toFixed(1)}</strong>
              </span>
            )}
            {rec.supporting_data.current_ctr_7d > 0 && (
              <span className="rec-metric-chip">
                CTR <strong>{rec.supporting_data.current_ctr_7d.toFixed(2)}%</strong>
              </span>
            )}
            {rec.supporting_data.current_purchases_7d > 0 && (
              <span className="rec-metric-chip">
                Compras <strong>{rec.supporting_data.current_purchases_7d}</strong>
              </span>
            )}
            {rec.supporting_data.trend_direction && rec.supporting_data.trend_direction !== 'unknown' && (
              <span className={`rec-metric-chip ${rec.supporting_data.trend_direction === 'declining' ? 'bad' : rec.supporting_data.trend_direction === 'improving' ? 'good' : ''}`}>
                {rec.supporting_data.trend_direction === 'declining' ? '\u2198' :
                 rec.supporting_data.trend_direction === 'improving' ? '\u2197' : '\u2192'}
                {rec.supporting_data.days_declining > 0 && ` ${rec.supporting_data.days_declining}d`}
              </span>
            )}
          </div>
        )}

        {/* === CONTEXTO COLAPSABLE === */}
        {hasContextSections && (
          <div className="rec-context-toggle-wrap">
            <button className="rec-context-toggle" onClick={() => setShowContext(!showContext)}>
              <span className="rec-context-toggle-icon">{showContext ? '\u25BC' : '\u25B6'}</span>
              {showContext ? 'Ocultar contexto' : 'Ver contexto'}
              {rec.diagnosis && !showContext && <span className="rec-context-preview"> — {rec.diagnosis.slice(0, 60)}...</span>}
            </button>
          </div>
        )}

        {showContext && (
          <div className="rec-context-sections">
            {rec.diagnosis && (
              <div className="rec-structured-section rec-section-diagnosis">
                <span className="rec-section-icon">{'\uD83D\uDD0D'}</span>
                <div className="rec-section-content">
                  <span className="rec-section-label">Causa raiz</span>
                  <span className="rec-section-text">{rec.diagnosis}</span>
                </div>
              </div>
            )}

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
          </div>
        )}

        {/* Follow-up info */}
        {followUp.checked && (
          <div className={`rec-followup ${followUp.impact_verdict}`}>
            <div className="rec-followup-header">
              <span className="rec-followup-icon">
                {followUp.impact_verdict === 'positive' ? '\u2705' : followUp.impact_verdict === 'negative' ? '\u274C' : '\u2796'}
              </span>
              <strong>Follow-up: {followUp.action_executed ? 'Accion ejecutada' : 'Accion no detectada'}</strong>
            </div>
            <p className="rec-followup-text">{followUp.impact_summary}</p>
          </div>
        )}

        {/* Tracking timeline */}
        {isTracking && (
          <div className="rec-tracker">
            <div className="rec-tracker-header">
              <div className="rec-tracker-status">
                <span className={`rec-tracker-exec ${followUp.action_executed ? 'done' : 'waiting'}`}>
                  {followUp.action_executed ? 'Ejecutada' : 'Pendiente ejecucion'}
                </span>
                {!followUp.action_executed && (
                  <button
                    className="rec-btn-mark-executed"
                    onClick={async () => {
                      try { await markRecommendationExecuted(rec._id); } catch (err) { console.error(err); }
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
              </div>
            )}
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
                  {phases.day_3.verdict === 'positive' ? '\u2705' : phases.day_3.verdict === 'negative' ? '\u274C' : '\u2796'}
                </span>
              </div>
            )}
            {rec.decision_note && (
              <div className="rec-tracker-note">📝 {rec.decision_note}</div>
            )}
          </div>
        )}

        {/* Action bar — sticky at bottom of detail */}
        <div className="rec-detail-action-bar">
          {rec.status === 'pending' && (
            <>
              <button className="rec-btn approve" onClick={onApprove}>Aprobar</button>
              <button className="rec-btn reject" onClick={onReject}>Rechazar</button>
            </>
          )}
          {onDiscuss && (
            <button className="rec-btn discuss" onClick={onDiscuss}>Discutir con Brain</button>
          )}
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
        </div>
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

function FollowUpPanel({ formatTime, onApprovalAction, onDiscuss }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedItem, setExpandedItem] = useState(null);
  const [expandedCard, setExpandedCard] = useState(null);      // accordion: only 1 card expanded
  const [expandedInlineRec, setExpandedInlineRec] = useState(null); // collapsed inline recs

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

      {/* ═══ ZONE 1: Score Strip — orb + headline + chips ═══ */}
      <div className="fu-score-strip">
        <div className="fu-score-orb">
          <Suspense fallback={<div className="fu-score-orb-fallback"><span>{summary.win_rate}%</span></div>}>
            <ImpactOrb winRate={summary.win_rate} summary={summary} latestPhases={latestPhases} />
          </Suspense>
        </div>
        <div className="fu-score-body">
          <div className="fu-score-headline">
            <span className="fu-score-pct">{summary.win_rate}%</span> efectividad
            <span className="fu-score-sep">&middot;</span>{summary.total_measured} medidas
            <span className="fu-score-sep">&middot;</span>
            <span className="fu-score-pos">{summary.positive}</span> positivas
            {summary.negative > 0 && <><span className="fu-score-sep">&middot;</span><span className="fu-score-neg">{summary.negative}</span> negativas</>}
            {summary.pending_follow_up > 0 && <><span className="fu-score-sep">&middot;</span><span className="fu-score-pending">{summary.pending_follow_up} en espera</span></>}
          </div>
          <div className="fu-score-chips">
            {summary.avg_roas_delta_pct != null && (
              <span className={`fu-chip ${summary.avg_roas_delta_pct >= 0 ? 'positive' : 'negative'}`}>
                ROAS {summary.avg_roas_delta_pct > 0 ? '+' : ''}{summary.avg_roas_delta_pct}%
              </span>
            )}
            {summary.avg_cpa_delta_pct != null && (
              <span className={`fu-chip ${(summary.avg_cpa_delta_pct || 0) <= 0 ? 'positive' : 'negative'}`}>
                CPA {(summary.avg_cpa_delta_pct || 0) > 0 ? '+' : ''}{summary.avg_cpa_delta_pct || 0}%
              </span>
            )}
            {summary.avg_ctr_delta_pct != null && summary.avg_ctr_delta_pct !== 0 && (
              <span className={`fu-chip ${(summary.avg_ctr_delta_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                CTR {(summary.avg_ctr_delta_pct || 0) > 0 ? '+' : ''}{summary.avg_ctr_delta_pct || 0}%
              </span>
            )}
            <span className="fu-chip-divider" />
            {Object.entries(by_action_type).slice(0, 4).map(([action, stats]) => {
              const cfg = ACTION_TYPE_CONFIG[action] || ACTION_TYPE_CONFIG.other;
              const wr = stats.total > 0 ? Math.round((stats.positive / stats.total) * 100) : 0;
              return (
                <span key={action} className="fu-chip type">{cfg.icon} {cfg.label} {wr}%</span>
              );
            })}
          </div>
        </div>
      </div>

      {/* ═══ ZONE 2: Activos — clean monitoring cards ═══ */}
      {pending.length > 0 && (() => {
        const groupedByEntity = {};
        for (const p of pending) {
          const key = p.entity_name || p._id;
          if (!groupedByEntity[key]) groupedByEntity[key] = [];
          groupedByEntity[key].push(p);
        }
        const entityGroups = Object.entries(groupedByEntity);

        return (
          <div className="fu-section">
            <h3 className="fu-section-title">
              <span className="fu-pulse" />
              Activos ({pending.length})
            </h3>
            <div className="fu-activos-list">
              {entityGroups.map(([entityName, items]) => (
                <div key={entityName} className="fu-entity-group">
                  {items.length > 1 && (
                    <div className="fu-group-header">
                      <span className="fu-group-name">{entityName}</span>
                      <span className="fu-group-count">{items.length}</span>
                    </div>
                  )}
                  {items.map(p => {
                    const actionCfg = ACTION_TYPE_CONFIG[p.action_type] || ACTION_TYPE_CONFIG.other;
                    const daysAgo = p.hours_since_approved >= 24
                      ? `${Math.floor(p.hours_since_approved / 24)}d`
                      : `${p.hours_since_approved}h`;
                    const phaseIdx = p.current_phase === 'awaiting_day_3' ? 0
                      : p.current_phase === 'awaiting_day_7' ? 1
                      : p.current_phase === 'awaiting_day_14' ? 2 : 3;
                    const phasePct = phaseIdx === 0 ? 15 : phaseIdx === 1 ? 40 : phaseIdx === 2 ? 70 : 100;
                    const phaseLabel = ['3d', '7d', '14d', 'done'][Math.min(phaseIdx, 3)];
                    const d3Verdict = p.day_3?.verdict;
                    const isOpen = expandedCard === p._id;
                    const phases = [
                      { key: 'day_3', label: '3d', done: phaseIdx > 0, active: phaseIdx === 0, data: p.day_3 },
                      { key: 'day_7', label: '7d', done: phaseIdx > 1, active: phaseIdx === 1, data: null },
                      { key: 'day_14', label: '14d', done: phaseIdx > 2, active: phaseIdx === 2, data: null },
                    ];

                    return (
                      <div key={p._id} className={`fu-activo ${d3Verdict ? `verdict-${d3Verdict}` : ''} ${isOpen ? 'open' : ''}`}>
                        {/* Compact row */}
                        <div className="fu-activo-row" onClick={() => setExpandedCard(isOpen ? null : p._id)}>
                          <span className="fu-activo-icon" style={{ color: actionCfg.color }}>{actionCfg.icon}</span>
                          <div className="fu-activo-info">
                            <span className="fu-activo-name">{items.length === 1 ? p.entity_name : actionCfg.label}</span>
                            {items.length === 1 && <span className="fu-activo-action">{actionCfg.label}</span>}
                          </div>
                          <div className="fu-activo-progress" title={`Fase: ${phaseLabel}`}>
                            <div className="fu-activo-progress-fill" style={{ width: `${phasePct}%` }} />
                            <span className="fu-activo-progress-label">{phaseLabel}</span>
                          </div>
                          {p.day_3?.roas_pct != null ? (
                            <span className={`fu-activo-delta ${(p.day_3.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                              {p.day_3.roas_pct > 0 ? '+' : ''}{p.day_3.roas_pct}%
                            </span>
                          ) : (
                            <span className="fu-activo-delta waiting">{daysAgo}</span>
                          )}
                          {d3Verdict && (
                            <span className={`fu-activo-verdict ${d3Verdict}`}>
                              {d3Verdict === 'positive' ? '\u2705' : d3Verdict === 'negative' ? '\u274C' : '\u2796'}
                            </span>
                          )}
                          <span className={`fu-activo-chevron ${isOpen ? 'open' : ''}`}>{'\u25B8'}</span>
                        </div>

                        {/* Expanded detail */}
                        {isOpen && (
                          <div className="fu-activo-detail">
                            <div className="fu-activo-title">{p.title}</div>

                            {/* Phase timeline */}
                            <div className="followup-phase-track">
                              {phases.map((ph, i) => (
                                <React.Fragment key={ph.key}>
                                  {i > 0 && <div className={`followup-phase-connector ${ph.done ? 'done' : ''}`} />}
                                  <div className={`followup-phase-node-v2 ${ph.done ? 'done' : ph.active ? 'active' : ''}`}>
                                    <span className="followup-phase-circle">
                                      {ph.done ? '\u2713' : ph.active ? '\u25CF' : '\u25CB'}
                                    </span>
                                    <span className="followup-phase-label-v2">{ph.label}</span>
                                    {ph.data && (
                                      <span className={`followup-phase-delta ${(ph.data.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                                        {(ph.data.roas_pct || 0) > 0 ? '+' : ''}{ph.data.roas_pct}%
                                      </span>
                                    )}
                                  </div>
                                </React.Fragment>
                              ))}
                            </div>

                            {/* Before → After (day_3 available) */}
                            {p.day_3 && p.day_3.current_roas > 0 && (
                              <div className="followup-comparison">
                                <div className="followup-compare-col before">
                                  <span className="followup-compare-header">Al aprobar</span>
                                  <div className="followup-compare-grid">
                                    <div className="followup-compare-item"><span className="followup-compare-label">ROAS</span><span className="followup-compare-val">{p.roas_at_approval.toFixed(2)}x</span></div>
                                    <div className="followup-compare-item"><span className="followup-compare-label">CPA</span><span className="followup-compare-val">${p.cpa_at_approval.toFixed(2)}</span></div>
                                  </div>
                                </div>
                                <div className="followup-compare-arrow"><span className={`followup-arrow-icon ${(p.day_3.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>{'\u2192'}</span></div>
                                <div className="followup-compare-col after">
                                  <span className="followup-compare-header">Dia 3</span>
                                  <div className="followup-compare-grid">
                                    <div className="followup-compare-item"><span className="followup-compare-label">ROAS</span><span className={`followup-compare-val highlight ${p.day_3.current_roas >= 3 ? 'good' : p.day_3.current_roas >= 1.5 ? 'ok' : 'bad'}`}>{p.day_3.current_roas.toFixed(2)}x</span></div>
                                    <div className="followup-compare-item"><span className="followup-compare-label">CPA</span><span className="followup-compare-val highlight">${p.day_3.current_cpa?.toFixed(2) || '\u2014'}</span></div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Snapshot (no day_3 yet) */}
                            {!p.day_3 && (
                              <div className="followup-pending-snapshot">
                                {p.roas_at_approval > 0 && <div className="followup-snap-metric"><span className="followup-snap-label">ROAS</span><span className="followup-snap-value">{p.roas_at_approval.toFixed(2)}x</span></div>}
                                {p.cpa_at_approval > 0 && <div className="followup-snap-metric"><span className="followup-snap-label">CPA</span><span className="followup-snap-value">${p.cpa_at_approval.toFixed(2)}</span></div>}
                                {p.spend_at_approval > 0 && <div className="followup-snap-metric"><span className="followup-snap-label">Spend</span><span className="followup-snap-value">${p.spend_at_approval.toFixed(0)}</span></div>}
                              </div>
                            )}

                            {/* Execution + action */}
                            {!p.action_executed && (
                              <div className="followup-exec-row">
                                <span className="followup-exec-badge not-executed">{'\u23F3'} Pendiente ejecucion</span>
                                <button className="rec-btn-mark-executed" onClick={async () => { try { await markRecommendationExecuted(p._id); loadFollowUpStats(); } catch (err) { console.error(err); } }}>Marcar ejecutada</button>
                              </div>
                            )}
                            {p.action_detail && <div className="followup-pending-detail">{p.action_detail}</div>}

                            {/* New creative metrics */}
                            {p.new_ad_name && (
                              <div className="followup-new-ad-section">
                                <div className="followup-new-ad-header"><span>{'\uD83C\uDFA8'}</span><span>Creativo: {p.new_ad_name}</span></div>
                                {p.day_3?.new_ad_metrics ? (
                                  <div className="followup-new-ad-metrics">
                                    <div className="followup-new-ad-metric"><span className="followup-new-ad-label">ROAS</span><span className={`followup-new-ad-value ${p.day_3.new_ad_metrics.roas >= 3 ? 'good' : p.day_3.new_ad_metrics.roas >= 1.5 ? 'ok' : 'bad'}`}>{(p.day_3.new_ad_metrics.roas || 0).toFixed(2)}x</span></div>
                                    <div className="followup-new-ad-metric"><span className="followup-new-ad-label">CTR</span><span className={`followup-new-ad-value ${p.day_3.new_ad_metrics.ctr >= 1.5 ? 'good' : 'ok'}`}>{(p.day_3.new_ad_metrics.ctr || 0).toFixed(2)}%</span></div>
                                    <div className="followup-new-ad-metric"><span className="followup-new-ad-label">CPA</span><span className="followup-new-ad-value">${(p.day_3.new_ad_metrics.cpa || 0).toFixed(2)}</span></div>
                                  </div>
                                ) : (
                                  <div className="followup-new-ad-waiting">Metricas en dia 3</div>
                                )}
                              </div>
                            )}

                            {/* Inline new recommendation */}
                            {p.new_recommendation && (
                              <div className={`followup-inline-rec ${expandedInlineRec === p._id ? 'open' : ''}`}>
                                <div className="followup-inline-rec-header" onClick={(e) => { e.stopPropagation(); setExpandedInlineRec(expandedInlineRec === p._id ? null : p._id); }} style={{ cursor: 'pointer' }}>
                                  <span className="followup-inline-rec-badge">{'\u26A1'} Nueva sugerencia</span>
                                  <span className={`followup-inline-rec-chevron ${expandedInlineRec === p._id ? 'open' : ''}`}>{'\u25B8'}</span>
                                </div>
                                {expandedInlineRec === p._id && (
                                  <>
                                    <div className="followup-inline-rec-title">{(ACTION_TYPE_CONFIG[p.new_recommendation.action_type] || ACTION_TYPE_CONFIG.other).icon} {p.new_recommendation.title}</div>
                                    {p.new_recommendation.action_detail && <div className="followup-inline-rec-detail"><span className="followup-inline-rec-detail-label">Accion:</span> {p.new_recommendation.action_detail}</div>}
                                    <div className="followup-inline-rec-actions">
                                      <button className="rec-btn approve" onClick={() => onApprovalAction && onApprovalAction(p.new_recommendation._id, 'approve', p.new_recommendation)}>Aprobar</button>
                                      <button className="rec-btn reject" onClick={() => onApprovalAction && onApprovalAction(p.new_recommendation._id, 'reject', p.new_recommendation)}>Rechazar</button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                            {onDiscuss && (
                              <button className="btn-discuss-followup" onClick={() => onDiscuss(p)}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                                Discutir
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ═══ ZONE 3: Resultados — chronological feed with inline lessons ═══ */}
      {timeline.length > 0 && (
        <div className="fu-section">
          <h3 className="fu-section-title">Resultados ({timeline.length})</h3>
          <div className="fu-resultados-list">
            {timeline.map(item => {
              const vCfg = VERDICT_CONFIG[item.impact_verdict] || VERDICT_CONFIG.neutral;
              const actionCfg = ACTION_TYPE_CONFIG[item.action_type] || ACTION_TYPE_CONFIG.other;
              const lesson = item.ai_analysis?.lesson_learned;
              const isOpen = expandedItem === item._id;
              return (
                <div key={item._id} className={`fu-resultado ${isOpen ? 'open' : ''}`} onClick={() => setExpandedItem(isOpen ? null : item._id)}>
                  {/* Compact: verdict + action + entity + delta + lesson */}
                  <div className="fu-resultado-row">
                    <span className="fu-resultado-verdict" style={{ color: vCfg.color }}>{vCfg.icon}</span>
                    <div className="fu-resultado-body">
                      <div className="fu-resultado-line">
                        <span className="fu-resultado-action">{actionCfg.icon} {actionCfg.label}</span>
                        <span className="fu-resultado-entity">{item.entity_name}</span>
                        <span className={`fu-resultado-delta ${item.roas_delta_pct >= 0 ? 'positive' : 'negative'}`}>
                          ROAS {item.roas_delta_pct > 0 ? '+' : ''}{item.roas_delta_pct}%
                        </span>
                      </div>
                      {lesson && <div className="fu-resultado-lesson">{lesson}</div>}
                    </div>
                    <div className="fu-resultado-meta">
                      {item.impact_trend && (
                        <span className={`fu-resultado-trend ${item.impact_trend}`}>
                          {item.impact_trend === 'improving' ? '\u2191' : item.impact_trend === 'declining' ? '\u2193' : '\u2194'}
                        </span>
                      )}
                      <span className="fu-resultado-time">{formatTime(item.checked_at)}</span>
                      <span className={`fu-activo-chevron ${isOpen ? 'open' : ''}`}>{'\u25B8'}</span>
                    </div>
                  </div>

                  {/* Expanded: full analysis */}
                  {isOpen && (
                    <div className="fu-resultado-detail">
                      {/* Metrics */}
                      <div className="fu-resultado-metrics">
                        <span className="fu-resultado-metric">ROAS: {item.roas_before.toFixed(2)}x {'\u2192'} {item.roas_after.toFixed(2)}x</span>
                        {item.cpa_before > 0 && <span className="fu-resultado-metric">CPA: ${item.cpa_before.toFixed(2)} {'\u2192'} ${item.cpa_after.toFixed(2)}</span>}
                        {item.ctr_before > 0 && <span className="fu-resultado-metric">CTR: {item.ctr_before.toFixed(2)}% {'\u2192'} {item.ctr_after.toFixed(2)}%</span>}
                      </div>

                      {/* Phase progression */}
                      {(item.phases?.day_3 || item.phases?.day_7 || item.phases?.day_14) && (
                        <div className="fu-resultado-phases">
                          {['day_3', 'day_7', 'day_14'].map(phase => {
                            const ph = item.phases?.[phase];
                            if (!ph) return <span key={phase} className="fu-resultado-phase empty">{phase.replace('day_', '')}d</span>;
                            return (
                              <span key={phase} className={`fu-resultado-phase ${(ph.roas_pct || 0) >= 0 ? 'positive' : 'negative'}`}>
                                {phase.replace('day_', '')}d: {(ph.roas_pct || 0) > 0 ? '+' : ''}{ph.roas_pct || 0}%
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {/* AI Analysis */}
                      {item.ai_analysis && (
                        <div className="fu-resultado-ai">
                          {item.ai_analysis.root_cause && <div className="fu-resultado-ai-row"><span className="fu-resultado-ai-label">Causa raiz</span><span>{item.ai_analysis.root_cause}</span></div>}
                          {item.ai_analysis.what_worked && item.ai_analysis.what_worked !== 'N/A' && <div className="fu-resultado-ai-row positive"><span className="fu-resultado-ai-label">Funciono</span><span>{item.ai_analysis.what_worked}</span></div>}
                          {item.ai_analysis.what_didnt && item.ai_analysis.what_didnt !== 'N/A' && <div className="fu-resultado-ai-row negative"><span className="fu-resultado-ai-label">No funciono</span><span>{item.ai_analysis.what_didnt}</span></div>}
                        </div>
                      )}

                      {onDiscuss && (
                        <button className="btn-discuss-followup" onClick={(e) => { e.stopPropagation(); onDiscuss(item); }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                          Discutir
                        </button>
                      )}
                    </div>
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

  const iq = data.iq_score || 10;
  const iqColor = iq >= 80 ? '#10b981' : iq >= 60 ? '#6366f1' : iq >= 40 ? '#3b82f6' : iq >= 25 ? '#f59e0b' : '#ef4444';
  const iqLabel = iq >= 80 ? 'Experto' : iq >= 60 ? 'Competente' : iq >= 40 ? 'Aprendiendo' : iq >= 25 ? 'Novato' : 'Inicial';
  const breakdown = data.iq_breakdown || [];

  // Zone preview helpers
  const hypConfirmed = (data.hypotheses || []).filter(h => h.status === 'confirmed').length;
  const hypActive = (data.hypotheses || []).filter(h => h.status === 'active').length;
  const hypRejected = (data.hypotheses || []).filter(h => h.status === 'rejected').length;
  const temporalPatterns = data.temporal_patterns || [];
  const todayPattern = temporalPatterns.find(t => t.is_today);
  const bestDay = temporalPatterns.filter(t => t.sample_count > 0).sort((a, b) => (b.metrics?.avg_roas || 0) - (a.metrics?.avg_roas || 0))[0];
  const dayLabelsMap = { sunday: 'Dom', monday: 'Lun', tuesday: 'Mar', wednesday: 'Mie', thursday: 'Jue', friday: 'Vie', saturday: 'Sab' };
  const topPolicyAction = (data.policy?.top_actions || [])[0];
  const topPolicyCfg = topPolicyAction ? (ACTION_TYPE_CONFIG[topPolicyAction.action] || ACTION_TYPE_CONFIG.other) : null;

  const zones = [
    { key: 'memory', icon: '\uD83E\uDDE0', label: 'Memoria', count: data.entities_with_history, color: '#3b82f6' },
    { key: 'hypothesis', icon: '\uD83E\uDD14', label: 'Hipotesis', count: data.hypotheses?.length || 0, color: '#a855f7' },
    { key: 'temporal', icon: '\uD83D\uDCC5', label: 'Temporal', count: temporalPatterns.filter(t => t.sample_count > 0).length, color: '#f97316' },
    { key: 'policy', icon: '\uD83C\uDFAF', label: 'Decisiones', count: data.policy?.total_samples || 0, color: '#10b981' }
  ];

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

      {/* ── IQ Breakdown Bar ── */}
      {breakdown.length > 0 && (
        <div className="kv2-iq-breakdown">
          <div className="kv2-iq-breakdown-bar">
            {breakdown.map(seg => (
              <div
                key={seg.key}
                className="kv2-iq-breakdown-seg"
                style={{
                  width: `${(seg.max / 90) * 100}%`,
                  '--seg-color': seg.color
                }}
                title={`${seg.label}: ${seg.points}/${seg.max}`}
              >
                <div
                  className="kv2-iq-breakdown-fill"
                  style={{ width: seg.max > 0 ? `${(seg.points / seg.max) * 100}%` : '0%', background: seg.color }}
                />
              </div>
            ))}
          </div>
          <div className="kv2-iq-breakdown-labels">
            {breakdown.map(seg => (
              <div key={seg.key} className="kv2-iq-breakdown-item" style={{ width: `${(seg.max / 90) * 100}%` }}>
                <span className="kv2-iq-breakdown-dot" style={{ background: seg.color }} />
                <span className="kv2-iq-breakdown-name">{seg.label}</span>
                <span className="kv2-iq-breakdown-pts" style={{ color: seg.points > 0 ? seg.color : 'var(--text-muted)' }}>
                  {seg.points}/{seg.max}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Cycle Memory Card (promoted from footer) ── */}
      {data.last_cycle && (
        <div className="kv2-cycle-card">
          <div className="kv2-cycle-card-header">
            <span className="kv2-cycle-card-icon">{'\uD83D\uDD04'}</span>
            <span className="kv2-cycle-card-title">Ultimo Ciclo del Brain</span>
            <span className="kv2-cycle-card-time">
              {data.last_cycle.created_at && formatTime(data.last_cycle.created_at)}
            </span>
          </div>
          <div className="kv2-cycle-card-body">
            <span className="kv2-cycle-card-assess">{data.last_cycle.account_assessment || 'N/A'}</span>
            <span className="kv2-cycle-card-meta">{data.last_cycle.conclusions_count} conclusiones</span>
          </div>
        </div>
      )}

      {/* ── Zone Selector with Previews ── */}
      <div className="kv2-zone-tabs">
        {zones.map(z => (
          <button
            key={z.key}
            className={`kv2-zone-tab ${activeZone === z.key ? 'active' : ''}`}
            style={{ '--zone-color': z.color }}
            onClick={() => setActiveZone(activeZone === z.key ? null : z.key)}
          >
            <span className="kv2-zone-icon">{z.icon}</span>
            <span className="kv2-zone-label">{z.label}</span>
            <span className="kv2-zone-count">{z.count}</span>
            {/* ── Zone Previews ── */}
            <div className="kv2-zone-preview">
              {z.key === 'memory' && data.total_action_outcomes > 0 && (
                <div className="kv2-preview-bar">
                  <div className="kv2-preview-seg" style={{ width: `${(data.action_outcomes.improved / data.total_action_outcomes) * 100}%`, background: '#10b981' }} />
                  <div className="kv2-preview-seg" style={{ width: `${(data.action_outcomes.neutral / data.total_action_outcomes) * 100}%`, background: '#6b7280' }} />
                  <div className="kv2-preview-seg" style={{ width: `${(data.action_outcomes.worsened / data.total_action_outcomes) * 100}%`, background: '#ef4444' }} />
                </div>
              )}
              {z.key === 'hypothesis' && (data.hypotheses?.length || 0) > 0 && (
                <span className="kv2-preview-text">
                  {hypConfirmed > 0 && <span style={{ color: '#10b981' }}>{hypConfirmed} ok</span>}
                  {hypActive > 0 && <span style={{ color: '#a855f7' }}>{hypActive} act</span>}
                  {hypRejected > 0 && <span style={{ color: '#ef4444' }}>{hypRejected} rej</span>}
                </span>
              )}
              {z.key === 'temporal' && todayPattern && (
                <span className="kv2-preview-text">
                  <span>Hoy {todayPattern.metrics?.avg_roas?.toFixed(1) || '-'}x</span>
                  {bestDay && <span style={{ color: '#f97316' }}>Mejor: {dayLabelsMap[bestDay.day]}</span>}
                </span>
              )}
              {z.key === 'policy' && topPolicyAction && (
                <span className="kv2-preview-text">
                  <span>{topPolicyCfg.icon} {topPolicyAction.success_rate}%</span>
                </span>
              )}
            </div>
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
                      <span key={j} className={`kv2-action-chip ${a.result} ${a.attribution === 'shared' ? 'shared' : ''}`}>
                        {acfg.icon} {acfg.label}
                        {a.roas_delta_pct !== 0 && (
                          <span className="kv2-action-delta">
                            {a.roas_delta_pct > 0 ? '+' : ''}{Math.round(a.roas_delta_pct)}%
                          </span>
                        )}
                        {a.attribution === 'shared' && (
                          <span className="kv2-action-shared" title={`Compartido con: ${(a.concurrent_actions || []).join(', ')}`}>
                            shared
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
            {(!data.entity_memories || data.entity_memories.length === 0) && (
              <div className="kv2-empty-zone">
                <div className="kv2-empty-icon">{'\uD83E\uDDE0'}</div>
                <div className="kv2-empty-msg">Aprueba recomendaciones y espera la medicion de impacto (dia 3-14) para generar historial.</div>
              </div>
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
              <div className="kv2-empty-zone">
                <div className="kv2-empty-icon">{'\uD83E\uDD14'}</div>
                <div className="kv2-empty-msg">Se generan automaticamente al final de cada ciclo del Brain (4x/dia).</div>
              </div>
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
              const tp = temporalPatterns.find(t => t.day === day);
              const samples = tp?.sample_count || 0;
              const isToday = tp?.is_today;
              const roas = tp?.metrics?.avg_roas || 0;
              const cpa = tp?.metrics?.avg_cpa || 0;
              const maxRoas = Math.max(...temporalPatterns.map(t => t.metrics?.avg_roas || 0), 1);
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
              <div className="kv2-empty-zone">
                <div className="kv2-empty-icon">{'\uD83C\uDFAF'}</div>
                <div className="kv2-empty-msg">Se llena cuando acciones aprobadas completan su seguimiento de 14 dias.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ CREATIVES PANEL ═══

const CREATIVE_VERDICT = {
  good:     { label: 'Buen rendimiento', color: '#10b981', glow: 'rgba(16,185,129,0.25)', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.3)' },
  bad:      { label: 'Bajo rendimiento', color: '#ef4444', glow: 'rgba(239,68,68,0.25)', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)' },
  watch:    { label: 'Monitorear',       color: '#f59e0b', glow: 'rgba(245,158,11,0.25)', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)' },
  learning: { label: 'Aprendiendo',      color: '#3b82f6', glow: 'rgba(59,130,246,0.25)', bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.3)' },
  new:      { label: 'Sin datos',        color: '#6b7280', glow: 'rgba(107,114,128,0.15)', bg: 'rgba(107,114,128,0.06)', border: 'rgba(107,114,128,0.2)' }
};

const SORT_OPTIONS = [
  { key: 'spend', label: 'Gasto' },
  { key: 'roas', label: 'ROAS' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'ctr', label: 'CTR' },
  { key: 'cpa', label: 'CPA' },
  { key: 'purchases', label: 'Compras' }
];

const TIME_WINDOWS = [
  { key: 'today', label: 'Hoy' },
  { key: 'last_3d', label: '3d' },
  { key: 'last_7d', label: '7d' }
];

const ANOMALY_CONFIG = {
  ZERO_CONVERSIONS:        { icon: '\u26D4', label: 'Sin Conversiones', color: '#ef4444' },
  BUDGET_HOG:              { icon: '\uD83D\uDCB8', label: 'Acapara Budget', color: '#f97316' },
  CTR_DEAD:                { icon: '\uD83D\uDCC9', label: 'CTR Muerto', color: '#ef4444' },
  DECLINING_FAST:          { icon: '\u26A1', label: 'Cayendo Rapido', color: '#f59e0b' },
  TOP_PERFORMER_FATIGUING: { icon: '\u2B50', label: 'Top Fatigandose', color: '#a855f7' },
  UNDERPERFORMER:          { icon: '\uD83D\uDCC9', label: 'Bajo Rendimiento', color: '#ef4444' }
};

const ACTION_LABELS = {
  pause: { label: 'PAUSAR', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  monitor: { label: 'MONITOREAR', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  monitor_prepare_replacement: { label: 'PREPARAR REEMPLAZO', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' }
};

function CreativesPanel({ formatTime }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('spend');
  const [filterVerdict, setFilterVerdict] = useState('all');
  const [timeWindow, setTimeWindow] = useState('last_3d');

  // Ad Health state
  const [adHealthData, setAdHealthData] = useState(null);
  const [adHealthLoading, setAdHealthLoading] = useState(true);
  const [expandedAdSet, setExpandedAdSet] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await getCreativePerformance();
        setData(res);
      } catch (err) { console.error('Creative performance error:', err); }
      finally { setLoading(false); }
    })();
    (async () => {
      try {
        const res = await getAdHealth();
        setAdHealthData(res);
      } catch (err) { console.error('Ad health error:', err); }
      finally { setAdHealthLoading(false); }
    })();
  }, []);

  if (loading && adHealthLoading) return <div className="d-flex align-center justify-center p-4 text-muted"><div className="loading" /> Cargando creativos...</div>;

  const hasCreatives = data?.ads?.length > 0;

  const accountAvg = data?.account_avg || {};

  // Verdict counts
  const verdictCounts = { good: 0, bad: 0, watch: 0, learning: 0, new: 0 };
  for (const ad of (data?.ads || [])) verdictCounts[ad.verdict] = (verdictCounts[ad.verdict] || 0) + 1;

  // Filter
  let filtered = data?.ads || [];
  if (filterVerdict !== 'all') filtered = filtered.filter(a => a.verdict === filterVerdict);

  // Sort (uses selected time window)
  filtered = [...filtered].sort((a, b) => {
    const ma = a.metrics?.[timeWindow] || {};
    const mb = b.metrics?.[timeWindow] || {};
    if (sortBy === 'spend') return (mb.spend || 0) - (ma.spend || 0);
    if (sortBy === 'roas') return (mb.roas || 0) - (ma.roas || 0);
    if (sortBy === 'clicks') return (mb.clicks || 0) - (ma.clicks || 0);
    if (sortBy === 'ctr') return (mb.ctr || 0) - (ma.ctr || 0);
    if (sortBy === 'cpa') return (ma.cpa || 0) - (mb.cpa || 0);
    if (sortBy === 'purchases') return (mb.purchases || 0) - (ma.purchases || 0);
    return 0;
  });

  const fmtMoney = (v) => v != null && v > 0 ? `$${v.toFixed(2)}` : '--';
  const fmtPct = (v) => v != null && v > 0 ? `${v.toFixed(2)}%` : '--';
  const fmtNum = (v) => v != null && v > 0 ? v.toFixed(2) : '--';
  const fmtInt = (v) => v != null && v > 0 ? v.toLocaleString() : '--';

  // ROAS gauge helper: returns width % relative to account avg (capped at 200%)
  const windowAvg = accountAvg[timeWindow] || {};
  const avgRoas = windowAvg.roas || accountAvg.roas_3d || 0;
  const avgCtr = windowAvg.ctr || accountAvg.ctr_3d || 0;
  const windowLabel = TIME_WINDOWS.find(w => w.key === timeWindow)?.label || '3d';

  const roasGauge = (roas) => {
    if (!avgRoas || avgRoas === 0 || !roas) return 0;
    return Math.min((roas / avgRoas) * 50, 100);
  };

  return (
    <div className="cv2-panel">
      {!hasCreatives && (
        <div className="feed-empty" style={{ marginBottom: '24px' }}>
          <div className="feed-empty-icon">{'\uD83C\uDFA8'}</div>
          <p>No hay creativos manuales todavia.</p>
          <p className="feed-empty-hint">Cuando subas creativos desde Ad Sets Manager, el Brain rastreara su rendimiento aqui.</p>
        </div>
      )}

      {hasCreatives && <>
      {/* ── Hero: verdict summary cards ── */}
      <div className="cv2-hero">
        {[
          { key: 'good', count: verdictCounts.good },
          { key: 'learning', count: verdictCounts.learning },
          { key: 'watch', count: verdictCounts.watch },
          { key: 'bad', count: verdictCounts.bad },
          { key: 'new', count: verdictCounts.new }
        ].map(({ key, count }) => {
          const v = CREATIVE_VERDICT[key];
          return (
            <button key={key}
              className={`cv2-hero-card ${filterVerdict === key ? 'selected' : ''}`}
              style={{ '--vc': v.color, '--vg': v.glow, '--vbg': v.bg, '--vb': v.border }}
              onClick={() => setFilterVerdict(filterVerdict === key ? 'all' : key)}
            >
              <span className="cv2-hero-count">{count}</span>
              <span className="cv2-hero-label">{v.label}</span>
              <span className="cv2-hero-dot" />
            </button>
          );
        })}
        <div className="cv2-hero-ref">
          <div className="cv2-hero-ref-item">
            <span className="cv2-hero-ref-val">{fmtNum(avgRoas)}x</span>
            <span className="cv2-hero-ref-label">ROAS prom ({windowLabel})</span>
          </div>
          <div className="cv2-hero-ref-item">
            <span className="cv2-hero-ref-val">{fmtPct(avgCtr)}</span>
            <span className="cv2-hero-ref-label">CTR prom ({windowLabel})</span>
          </div>
        </div>
      </div>

      {/* ── Toolbar: time window + sort pills ── */}
      <div className="cv2-toolbar">
        <div className="cv2-time-pills">
          {TIME_WINDOWS.map(w => (
            <button key={w.key}
              className={`cv2-time-pill ${timeWindow === w.key ? 'active' : ''}`}
              onClick={() => setTimeWindow(w.key)}
            >{w.label}</button>
          ))}
        </div>
        <div className="cv2-sort-pills">
          {SORT_OPTIONS.map(s => (
            <button key={s.key}
              className={`cv2-sort-pill ${sortBy === s.key ? 'active' : ''}`}
              onClick={() => setSortBy(s.key)}
            >{s.label}</button>
          ))}
        </div>
        <span className="cv2-count">{filtered.length} de {data.ads.length}</span>
      </div>

      {/* ── Ad cards grid ── */}
      <div className="cv2-grid">
        {filtered.map(ad => {
          const mw = ad.metrics?.[timeWindow] || {};
          const vc = CREATIVE_VERDICT[ad.verdict] || CREATIVE_VERDICT.new;
          const trendIcon = ad.trend === 'improving' ? '\u2197' : ad.trend === 'declining' ? '\u2198' : '\u2192';
          const trendClass = ad.trend === 'improving' ? 'up' : ad.trend === 'declining' ? 'down' : 'flat';
          const gauge = roasGauge(mw.roas);

          return (
            <div key={ad.ad_id} className="cv2-card" style={{ '--vc': vc.color, '--vg': vc.glow, '--vbg': vc.bg, '--vb': vc.border }}>
              {/* Card header */}
              <div className="cv2-card-head">
                <div className="cv2-card-identity">
                  <span className="cv2-card-name" title={ad.ad_name}>
                    {ad.ad_name.replace(' [Manual Upload]', '')}
                  </span>
                  <span className="cv2-card-adset" title={ad.adset_name}>{ad.adset_name}</span>
                </div>
                <div className="cv2-card-badges">
                  <span className={`cv2-status-pill ${ad.status === 'ACTIVE' ? 'active' : 'paused'}`}>
                    {ad.status === 'ACTIVE' ? 'Active' : 'Paused'}
                  </span>
                  <span className="cv2-verdict-pill">{vc.label}</span>
                  {ad.age_days != null && (
                    <span className="cv2-age-pill" title={`${ad.age_hours || 0}h activo`}>
                      {ad.age_days < 1 ? `${ad.age_hours || 0}h` : `${ad.age_days}d`}
                    </span>
                  )}
                </div>
              </div>

              {/* Fatigue indicator bar (only for non-learning, non-new) */}
              {ad.fatigue && ad.fatigue.level !== 'learning' && ad.fatigue.level !== 'healthy' && ad.verdict !== 'new' && (
                <div className={`cv2-fatigue-bar cv2-fatigue-${ad.fatigue.level}`}>
                  <span className="cv2-fatigue-icon">{ad.fatigue.level === 'severe' ? '🔥' : ad.fatigue.level === 'moderate' ? '⚠' : '📊'}</span>
                  <span className="cv2-fatigue-text">
                    {ad.fatigue.level === 'severe' ? 'Fatiga severa' : ad.fatigue.level === 'moderate' ? 'Fatiga moderada' : 'Fatiga temprana'}
                    {ad.fatigue.signals && ad.fatigue.signals.length > 0 && ` (${ad.fatigue.signals.length} señales)`}
                  </span>
                </div>
              )}

              {/* Learning message for learning ads */}
              {ad.verdict === 'learning' && (
                <div className="cv2-learning-bar">
                  <span className="cv2-learning-icon">🧪</span>
                  <span className="cv2-learning-text">
                    En fase de aprendizaje — {ad.age_hours != null ? `${Math.max(0, 72 - ad.age_hours)}h restantes` : 'evaluando'}
                  </span>
                  <div className="cv2-learning-progress">
                    <div className="cv2-learning-fill" style={{ width: `${Math.min(100, ((ad.age_hours || 0) / 72) * 100)}%` }} />
                  </div>
                </div>
              )}

              {/* ROAS hero metric + gauge */}
              <div className="cv2-card-roas">
                <div className="cv2-roas-left">
                  <span className="cv2-roas-value">{mw.roas > 0 ? `${mw.roas.toFixed(2)}x` : '--'}</span>
                  <span className="cv2-roas-label">ROAS {windowLabel}</span>
                </div>
                <div className="cv2-roas-gauge">
                  <div className="cv2-gauge-track">
                    <div className="cv2-gauge-fill" style={{ width: `${gauge}%` }} />
                    <div className="cv2-gauge-marker" style={{ left: '50%' }} title={`Promedio: ${fmtNum(avgRoas)}x`} />
                  </div>
                  <div className="cv2-gauge-labels">
                    <span>0</span>
                    <span>{fmtNum(avgRoas)}x avg</span>
                    <span>{avgRoas ? (avgRoas * 2).toFixed(1) + 'x' : ''}</span>
                  </div>
                </div>
                <span className={`cv2-trend ${trendClass}`}>{trendIcon}</span>
              </div>

              {/* Metrics grid */}
              <div className="cv2-card-metrics">
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{fmtMoney(mw.spend)}</span>
                  <span className="cv2-metric-key">Gasto</span>
                </div>
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{fmtInt(mw.clicks)}</span>
                  <span className="cv2-metric-key">Clicks</span>
                </div>
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{fmtPct(mw.ctr)}</span>
                  <span className="cv2-metric-key">CTR</span>
                </div>
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{fmtInt(mw.purchases)}</span>
                  <span className="cv2-metric-key">Compras</span>
                </div>
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{fmtMoney(mw.cpa)}</span>
                  <span className="cv2-metric-key">CPA</span>
                </div>
                <div className="cv2-metric">
                  <span className="cv2-metric-val">{mw.frequency > 0 ? mw.frequency.toFixed(1) : '--'}</span>
                  <span className={`cv2-metric-key ${(mw.frequency || 0) >= 3.5 ? 'cv2-freq-warn' : ''}`}>
                    Freq{(mw.frequency || 0) >= 3.5 ? ' !' : ''}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </>}

      {/* ═══ AD HEALTH SECTION — Per-ad anomaly diagnostics ═══ */}
      <div className="adhealth-section">
        <div className="adhealth-section-header">
          <h3 className="adhealth-section-title">Salud de Ads — Anomalias Detectadas</h3>
          <button className="btn-ghost btn-small" onClick={async () => {
            setAdHealthLoading(true);
            try { const res = await getAdHealth(); setAdHealthData(res); }
            catch (err) { console.error(err); }
            finally { setAdHealthLoading(false); }
          }}>Refrescar</button>
        </div>

        {adHealthLoading ? (
          <div className="adhealth-loading"><div className="loading" /> Analizando...</div>
        ) : !adHealthData?.adsets?.length ? (
          <div className="adhealth-ok">
            <span className="adhealth-ok-icon">{'\u2705'}</span>
            <span>Todos los ads saludables — sin anomalias detectadas</span>
            {adHealthData?.summary && (
              <span className="adhealth-ok-detail">{adHealthData.summary.adsets_total} ad sets analizados</span>
            )}
          </div>
        ) : (
          <>
            {/* Summary chips */}
            <div className="adhealth-summary">
              <div className="adhealth-summary-stats">
                <div className="adhealth-stat critical">
                  <span className="adhealth-stat-val">{adHealthData.summary.total_anomalies}</span>
                  <span className="adhealth-stat-label">Anomalias</span>
                </div>
                <div className="adhealth-stat warn">
                  <span className="adhealth-stat-val">{adHealthData.summary.total_pause_candidates}</span>
                  <span className="adhealth-stat-label">Pausar</span>
                </div>
                <div className="adhealth-stat waste">
                  <span className="adhealth-stat-val">${Math.round(adHealthData.summary.total_waste_7d)}</span>
                  <span className="adhealth-stat-label">Desperdicio/sem</span>
                </div>
                <div className="adhealth-stat healthy">
                  <span className="adhealth-stat-val">{adHealthData.summary.adsets_healthy}/{adHealthData.summary.adsets_total}</span>
                  <span className="adhealth-stat-label">Ad Sets OK</span>
                </div>
              </div>
            </div>

            {/* Ad set cards with issues */}
            <div className="adhealth-list">
              {adHealthData.adsets.map(adset => {
                const ah = adset.ad_health;
                const isExpanded = expandedAdSet === adset.adset_id;

                return (
                  <div key={adset.adset_id} className={`adhealth-adset ${isExpanded ? 'expanded' : ''}`}>
                    <div className="adhealth-adset-header" onClick={() => setExpandedAdSet(isExpanded ? null : adset.adset_id)}>
                      <div className="adhealth-adset-info">
                        <span className="adhealth-adset-name">{adset.adset_name}</span>
                        <div className="adhealth-adset-meta">
                          <span className="adhealth-meta-chip">{ah.anomalies.length} anomalia{ah.anomalies.length !== 1 ? 's' : ''}</span>
                          {ah.pause_count > 0 && <span className="adhealth-meta-chip pause">{ah.pause_count} pausar</span>}
                          {ah.total_waste_7d > 0 && <span className="adhealth-meta-chip waste">~${Math.round(ah.total_waste_7d)}/sem</span>}
                          <span className="adhealth-meta-chip neutral">{adset.active_ads} ads activos</span>
                          {ah.remaining_after_pause < 3 && ah.pause_count > 0 && (
                            <span className="adhealth-meta-chip alert">Quedarian {ah.remaining_after_pause} ads</span>
                          )}
                        </div>
                      </div>
                      <span className="adhealth-expand-icon">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                    </div>

                    {isExpanded && (
                      <div className="adhealth-anomalies">
                        {ah.summary && (
                          <div className="adhealth-coordinated-summary">
                            <span className="adhealth-coord-icon">{'\uD83C\uDFAF'}</span>
                            <span>{ah.summary}</span>
                          </div>
                        )}
                        {ah.anomalies.map((anomaly, idx) => {
                          const primary = anomaly.primary_anomaly;
                          const anomalyCfg = ANOMALY_CONFIG[primary.type] || ANOMALY_CONFIG.UNDERPERFORMER;
                          const actionCfg = ACTION_LABELS[anomaly.recommended_action] || ACTION_LABELS.monitor;
                          return (
                            <div key={idx} className={`adhealth-anomaly severity-${primary.severity}`}>
                              <div className="adhealth-anomaly-header">
                                <span className="adhealth-anomaly-icon" style={{ color: anomalyCfg.color }}>{anomalyCfg.icon}</span>
                                <div className="adhealth-anomaly-info">
                                  <span className="adhealth-anomaly-name" title={anomaly.ad_name}>{anomaly.ad_name}</span>
                                  <div className="adhealth-anomaly-types">
                                    {anomaly.all_anomalies.map((a, i) => {
                                      const cfg = ANOMALY_CONFIG[a.type] || ANOMALY_CONFIG.UNDERPERFORMER;
                                      return (
                                        <span key={i} className="adhealth-type-tag" style={{ color: cfg.color, borderColor: cfg.color }}>
                                          {cfg.label}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                                <span className="adhealth-action-tag" style={{ color: actionCfg.color, backgroundColor: actionCfg.bg }}>
                                  {actionCfg.label}
                                </span>
                              </div>
                              <div className="adhealth-anomaly-detail">{primary.detail}</div>
                              <div className="adhealth-anomaly-metrics">
                                <span className={`adhealth-metric ${anomaly.roas_7d < 1.5 ? 'bad' : anomaly.roas_7d >= 3 ? 'good' : ''}`}>
                                  ROAS {anomaly.roas_7d.toFixed(2)}x
                                </span>
                                <span className={`adhealth-metric ${anomaly.ctr_7d < 0.5 ? 'bad' : ''}`}>
                                  CTR {anomaly.ctr_7d.toFixed(2)}%
                                </span>
                                <span className={`adhealth-metric ${anomaly.frequency_7d >= 3.5 ? 'bad' : anomaly.frequency_7d >= 2.5 ? 'warn' : ''}`}>
                                  Freq {anomaly.frequency_7d.toFixed(1)}
                                </span>
                                <span className="adhealth-metric">${anomaly.spend_7d.toFixed(0)}/7d</span>
                                <span className="adhealth-metric">{anomaly.purchases_7d} compras</span>
                                <span className="adhealth-metric">{anomaly.age_days}d activo</span>
                                {primary.waste_amount > 0 && (
                                  <span className="adhealth-metric waste">~${primary.waste_amount.toFixed(0)} desperdicio</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ CHAT PANEL ═══

function ChatPanel({
  messages, chatInput, chatSending, chatLoading,
  chatThinking, streamingText,
  chatEndRef, chatInputRef,
  onInputChange, onSend, onClear, formatTime,
  attachedRec, onClearAttachment,
  recommendations, onAttachRec, onAttachFollowUp
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState('recs'); // 'recs' | 'followups'
  const [followUps, setFollowUps] = useState(null);
  const [loadingFollowUps, setLoadingFollowUps] = useState(false);
  const pickerRef = useRef(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handleClick = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pickerOpen]);

  // Load follow-ups when picker opens on that tab
  useEffect(() => {
    if (pickerOpen && pickerTab === 'followups' && !followUps && !loadingFollowUps) {
      setLoadingFollowUps(true);
      getFollowUpStats().then(data => {
        setFollowUps(data?.timeline || []);
      }).catch(() => setFollowUps([])).finally(() => setLoadingFollowUps(false));
    }
  }, [pickerOpen, pickerTab, followUps, loadingFollowUps]);

  const handlePickerToggle = () => {
    setPickerOpen(prev => !prev);
    if (!pickerOpen) setFollowUps(null); // reset for fresh load
  };

  const handlePickRec = (rec) => {
    onAttachRec(rec);
    setPickerOpen(false);
  };

  const handlePickFollowUp = (fu) => {
    onAttachFollowUp(fu);
    setPickerOpen(false);
  };

  // Filter recs to show only pending/approved (relevant ones)
  const pickerRecs = useMemo(() => {
    if (!recommendations) return [];
    return recommendations.filter(r => r.status === 'pending' || r.status === 'approved').slice(0, 15);
  }, [recommendations]);

  const thinkingPhrases = {
    loading: 'Revisando ad sets y metricas...',
    generating: 'Formulando respuesta...'
  };

  return (
    <div className="chat-panel">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-brain-indicator">
            <div className={`chat-brain-dot ${chatSending ? 'active' : ''}`} />
          </div>
          <div>
            <div className="chat-header-title">Brain</div>
            <div className="chat-header-sub">
              {chatThinking ? (
                <span className="chat-status-thinking">{thinkingPhrases[chatThinking.phase] || chatThinking.text}</span>
              ) : chatSending ? (
                <span className="chat-status-active">Escribiendo...</span>
              ) : 'Estratega de campanas'}
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
        ) : messages.length === 0 && !chatSending ? (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">
              <div className="chat-welcome-dot" />
            </div>
            <h3>Brain</h3>
            <p>Soy el que controla tus campanas. Preguntame lo que quieras — te digo la verdad, no lo que quieres oir.</p>
            <div className="chat-suggestions">
              <button className="chat-suggestion" onClick={() => onInputChange('¿Como van las campanas hoy?')}>
                Estado actual
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Que ad sets deberia pausar?')}>
                Que pausar
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Donde esta el problema?')}>
                Diagnostico
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Que oportunidades ves?')}>
                Oportunidades
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="chat-msg-avatar-wrap">
                    <div className="chat-msg-avatar-dot" />
                  </div>
                )}
                <div className="chat-msg-content">
                  {msg.role === 'user' && (msg.content.startsWith('[Rec:') || msg.content.startsWith('[Seguimiento:')) && (
                    <div className="chat-msg-rec-context">
                      {msg.content.startsWith('[Seguimiento:') ? 'Discutiendo seguimiento' : 'Discutiendo recomendacion'}
                    </div>
                  )}
                  <div className={`chat-msg-text ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    ) : (
                      msg.content.startsWith('[Rec:') || msg.content.startsWith('[Seguimiento:')
                        ? msg.content.replace(/^\[(Rec|Seguimiento):.*?\]\s*/, '')
                        : msg.content
                    )}
                  </div>
                  <div className="chat-msg-meta">
                    <span>{formatTime(msg.created_at)}</span>
                    {msg.tokens_used > 0 && <span className="chat-token-count">{msg.tokens_used} tok</span>}
                  </div>
                </div>
              </div>
            ))}

            {/* Thinking state */}
            {chatSending && chatThinking && !streamingText && (
              <div className="chat-message assistant">
                <div className="chat-msg-avatar-wrap">
                  <div className="chat-msg-avatar-dot thinking" />
                </div>
                <div className="chat-msg-content">
                  <div className="chat-msg-thinking">
                    <span className="thinking-pulse" />
                    <span className="thinking-text">{thinkingPhrases[chatThinking.phase] || chatThinking.text}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Streaming text — word by word */}
            {streamingText && (
              <div className="chat-message assistant">
                <div className="chat-msg-avatar-wrap">
                  <div className="chat-msg-avatar-dot streaming" />
                </div>
                <div className="chat-msg-content">
                  <div className="chat-msg-text markdown-body streaming-text">
                    <ReactMarkdown>{streamingText}</ReactMarkdown>
                    <span className="streaming-cursor" />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Attached recommendation/followup chip */}
      {attachedRec && (
        <div className={`chat-attached-rec ${attachedRec._isFollowUp ? 'followup' : ''}`}>
          <div className="chat-attached-inner">
            <span className="chat-attached-icon">&#8226;</span>
            <div className="chat-attached-info">
              <span className="chat-attached-label">{attachedRec._isFollowUp ? 'Seguimiento:' : 'Rec:'}</span>
              <span className="chat-attached-title">{attachedRec.title}</span>
            </div>
            <button className="chat-attached-close" onClick={onClearAttachment}>&times;</button>
          </div>
        </div>
      )}

      {/* Attachment picker */}
      {pickerOpen && (
        <div className="chat-picker" ref={pickerRef}>
          <div className="chat-picker-tabs">
            <button
              className={`chat-picker-tab ${pickerTab === 'recs' ? 'active' : ''}`}
              onClick={() => setPickerTab('recs')}
            >
              Recomendaciones
            </button>
            <button
              className={`chat-picker-tab ${pickerTab === 'followups' ? 'active' : ''}`}
              onClick={() => setPickerTab('followups')}
            >
              Seguimientos
            </button>
          </div>
          <div className="chat-picker-list">
            {pickerTab === 'recs' ? (
              pickerRecs.length === 0 ? (
                <div className="chat-picker-empty">Sin recomendaciones activas</div>
              ) : (
                pickerRecs.map(rec => (
                  <button
                    key={rec._id}
                    className="chat-picker-item"
                    onClick={() => handlePickRec(rec)}
                  >
                    <span className={`chat-picker-status ${rec.status}`} />
                    <div className="chat-picker-item-info">
                      <span className="chat-picker-item-title">{rec.title}</span>
                      <span className="chat-picker-item-meta">
                        {rec.action_type} — {rec.entity?.entity_name || 'N/A'} — {rec.confidence_score}%
                      </span>
                    </div>
                  </button>
                ))
              )
            ) : (
              loadingFollowUps ? (
                <div className="chat-picker-empty">Cargando seguimientos...</div>
              ) : !followUps || followUps.length === 0 ? (
                <div className="chat-picker-empty">Sin seguimientos activos</div>
              ) : (
                followUps.slice(0, 15).map((fu, i) => (
                  <button
                    key={fu.rec_id || i}
                    className="chat-picker-item followup"
                    onClick={() => handlePickFollowUp(fu)}
                  >
                    <span className={`chat-picker-status ${fu.current_phase || 'monitoring'}`} />
                    <div className="chat-picker-item-info">
                      <span className="chat-picker-item-title">{fu.title || fu.impact_summary || fu.entity_name}</span>
                      <span className="chat-picker-item-meta">
                        {fu.action_type} — {fu.entity_name || 'N/A'}{fu.hours_since_approved != null ? ` — ${Math.floor(fu.hours_since_approved / 24)}d` : ''}
                      </span>
                    </div>
                  </button>
                ))
              )
            )}
          </div>
        </div>
      )}

      {/* Input */}
      <form className="chat-input-form" onSubmit={onSend}>
        <button
          type="button"
          className={`btn-attach ${pickerOpen ? 'active' : ''} ${attachedRec ? 'has-attachment' : ''}`}
          onClick={handlePickerToggle}
          disabled={chatSending}
          title="Adjuntar rec o seguimiento"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={chatInputRef}
          type="text"
          className="chat-input"
          value={chatInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={attachedRec ? `Pregunta sobre: ${attachedRec.title}` : 'Preguntale al Brain...'}
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
