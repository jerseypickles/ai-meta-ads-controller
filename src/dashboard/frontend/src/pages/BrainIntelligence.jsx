import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  getBrainInsights, markInsightRead, markAllInsightsRead,
  triggerBrainAnalysis, sendBrainChat, getBrainChatHistory,
  clearBrainChatHistory, getBrainStats, logout
} from '../api';

// ═══ CONSTANTES ═══

const INSIGHT_TYPE_CONFIG = {
  anomaly:       { icon: '⚡', label: 'Anomalía', color: '#ef4444' },
  trend:         { icon: '📈', label: 'Tendencia', color: '#3b82f6' },
  opportunity:   { icon: '💡', label: 'Oportunidad', color: '#10b981' },
  warning:       { icon: '⚠️', label: 'Alerta', color: '#f59e0b' },
  milestone:     { icon: '🏆', label: 'Hito', color: '#8b5cf6' },
  status_change: { icon: '🔄', label: 'Cambio', color: '#6366f1' },
  summary:       { icon: '📊', label: 'Resumen', color: '#06b6d4' },
  follow_up:     { icon: '🔗', label: 'Seguimiento', color: '#ec4899' }
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
  const [activeTab, setActiveTab] = useState('feed'); // 'feed' | 'chat'
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

    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: msg, created_at: new Date().toISOString() }]);
    setChatSending(true);

    try {
      const result = await sendBrainChat(msg);
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

  const handleClearChat = async () => {
    try {
      await clearBrainChatHistory();
      setChatMessages([]);
    } catch (err) {
      console.error('Error clearing chat:', err);
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
            onTypeFilter={setTypeFilter}
            onSeverityFilter={setSeverityFilter}
            onAnalyze={handleAnalyze}
            onMarkAllRead={handleMarkAllRead}
            onInsightClick={handleInsightClick}
            onPageChange={(p) => loadInsights(p)}
            formatTime={formatTime}
          />
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
          />
        )}
      </div>
    </div>
  );
}

// ═══ FEED PANEL ═══

function FeedPanel({
  insights, loadingInsights, analyzing, typeFilter, severityFilter,
  insightsPage, totalPages, insightsTotal,
  onTypeFilter, onSeverityFilter, onAnalyze, onMarkAllRead, onInsightClick, onPageChange,
  formatTime
}) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div className="feed-panel">
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
          <button className="btn-secondary" onClick={onMarkAllRead}>
            Marcar todo leído
          </button>
          <button
            className="btn-primary"
            onClick={onAnalyze}
            disabled={analyzing}
          >
            {analyzing ? 'Analizando...' : 'Analizar ahora'}
          </button>
        </div>
      </div>

      {/* Insights List */}
      <div className="insights-list">
        {loadingInsights ? (
          <div className="feed-empty">Cargando insights...</div>
        ) : insights.length === 0 ? (
          <div className="feed-empty">
            <div className="feed-empty-icon">🧠</div>
            <p>El Brain aún no ha generado insights.</p>
            <p className="feed-empty-hint">Ejecuta un análisis o espera al próximo ciclo de datos.</p>
          </div>
        ) : (
          insights.map(insight => (
            <InsightCard
              key={insight._id}
              insight={insight}
              expanded={expandedId === insight._id}
              onToggle={() => {
                setExpandedId(expandedId === insight._id ? null : insight._id);
                onInsightClick(insight);
              }}
              formatTime={formatTime}
            />
          ))
        )}
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

function InsightCard({ insight, expanded, onToggle, formatTime }) {
  const typeCfg = INSIGHT_TYPE_CONFIG[insight.insight_type] || INSIGHT_TYPE_CONFIG.anomaly;
  const sevCfg = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.medium;

  return (
    <div
      className={`insight-card ${!insight.read ? 'unread' : ''} ${expanded ? 'expanded' : ''}`}
      onClick={onToggle}
    >
      <div className="insight-header">
        <div className="insight-left">
          <span className="insight-type-icon" style={{ color: typeCfg.color }}>{typeCfg.icon}</span>
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
              {insight.entities?.map((e, i) => (
                <span key={i} className="insight-tag entity">{e.entity_name}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="insight-right">
          <span className="insight-time">{formatTime(insight.created_at)}</span>
          <span className="insight-source">{insight.generated_by === 'ai' ? 'IA' : insight.generated_by === 'hybrid' ? 'Híbrido' : 'Math'}</span>
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
                  <span className="dp-key">{k}:</span>
                  <span className="dp-value">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
                </span>
              ))}
            </div>
          )}
          {insight.follow_up_count > 0 && (
            <div className="insight-follow-info">
              Tiene {insight.follow_up_count} seguimiento(s) posterior(es)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ CHAT PANEL ═══

function ChatPanel({
  messages, chatInput, chatSending, chatLoading,
  chatEndRef, chatInputRef,
  onInputChange, onSend, onClear, formatTime
}) {
  return (
    <div className="chat-panel">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-brain-icon">🧠</span>
          <div>
            <div className="chat-header-title">Brain Analyst</div>
            <div className="chat-header-sub">Pregunta sobre tus campañas</div>
          </div>
        </div>
        {messages.length > 0 && (
          <button className="btn-secondary btn-small" onClick={onClear}>
            Limpiar chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {chatLoading ? (
          <div className="chat-loading">Cargando historial...</div>
        ) : messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">🧠</div>
            <h3>Brain Analyst</h3>
            <p>Soy el analista inteligente de tus campañas de Meta Ads. Conozco cada ad set, sus métricas, tendencias y rendimiento.</p>
            <div className="chat-suggestions">
              <button className="chat-suggestion" onClick={() => onInputChange('¿Cuál es el ad set con mejor ROAS?')}>
                ¿Mejor ROAS?
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Qué ad sets debería considerar pausar?')}>
                ¿Cuáles pausar?
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('Dame un resumen del estado de las campañas')}>
                Resumen general
              </button>
              <button className="chat-suggestion" onClick={() => onInputChange('¿Hay alguna anomalía o problema?')}>
                ¿Anomalías?
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`chat-message ${msg.role}`}>
              {msg.role === 'assistant' && <span className="chat-msg-avatar">🧠</span>}
              <div className="chat-msg-content">
                <div className={`chat-msg-text ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
                <div className="chat-msg-meta">
                  <span>{formatTime(msg.created_at)}</span>
                  {msg.tokens_used > 0 && <span>{msg.tokens_used} tokens</span>}
                </div>
              </div>
            </div>
          ))
        )}
        {chatSending && (
          <div className="chat-message assistant">
            <span className="chat-msg-avatar">🧠</span>
            <div className="chat-msg-content">
              <div className="chat-msg-text typing">
                <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <form className="chat-input-form" onSubmit={onSend}>
        <input
          ref={chatInputRef}
          type="text"
          className="chat-input"
          value={chatInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Pregunta sobre tus campañas..."
          disabled={chatSending}
          autoFocus
        />
        <button type="submit" className="btn-send" disabled={chatSending || !chatInput.trim()}>
          {chatSending ? '...' : '→'}
        </button>
      </form>
    </div>
  );
}
