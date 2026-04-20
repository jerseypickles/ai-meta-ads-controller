import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api';
import { renderVizBlock } from './zeus-viz';

const LS_CONV_KEY = 'zeus_oracle_conversation_id';

function getApiBase() {
  return import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3500');
}

function getToken() {
  return localStorage.getItem('auth_token');
}

/**
 * Streaming helper: abre EventSource a `path` y emite callbacks por tipo de evento.
 */
function streamSSE(path, handlers) {
  const token = getToken();
  const url = `${getApiBase()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);

  for (const [event, handler] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      try {
        const data = e.data ? JSON.parse(e.data) : {};
        handler(data);
      } catch (err) {
        handler({ raw: e.data });
      }
    });
  }

  es.onerror = () => {
    if (handlers.error) handlers.error({ error: 'SSE connection error' });
    es.close();
  };

  return es;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function ZeusSpeaks() {
  const [mode, setMode] = useState('loading'); // loading | greeting | collapsed | error
  const [streamingText, setStreamingText] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [toolActivity, setToolActivity] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingInitialMessage, setPendingInitialMessage] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadPreview, setUnreadPreview] = useState(null);
  const esRef = useRef(null);

  // Poll unread count cada 45s
  useEffect(() => {
    async function checkUnread() {
      try {
        const res = await api.get('/api/zeus/chat/unread');
        setUnreadCount(res.data.unread || 0);
        setUnreadPreview(res.data.latest);
      } catch (err) { /* silent */ }
    }
    checkUnread();
    const interval = setInterval(checkUnread, 45000);
    return () => clearInterval(interval);
  }, []);

  // Cuando se abre el drawer, marcá proactivos como leídos
  useEffect(() => {
    if (drawerOpen && unreadCount > 0) {
      api.post('/api/zeus/chat/mark-read').catch(() => {});
      setUnreadCount(0);
      setUnreadPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  useEffect(() => {
    startGreeting();
    return () => { esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startGreeting() {
    try {
      const check = await api.post('/api/zeus/greeting/check');
      const checkMode = check.data?.mode || 'greeting_full';

      if (checkMode === 'none') {
        const prevConv = localStorage.getItem(LS_CONV_KEY);
        if (prevConv) setConversationId(prevConv);
        setMode('collapsed');
        return;
      }

      setMode('greeting');
      setStreaming(true);
      setStreamingText('');
      setToolActivity([]);

      const prevConv = localStorage.getItem(LS_CONV_KEY);
      const greetingPath = prevConv
        ? `/api/zeus/greeting/stream?conversation_id=${encodeURIComponent(prevConv)}`
        : '/api/zeus/greeting/stream';

      const es = streamSSE(greetingPath, {
        start: (data) => {
          if (data.conversation_id) {
            setConversationId(data.conversation_id);
            localStorage.setItem(LS_CONV_KEY, data.conversation_id);
          }
        },
        thinking: () => {
          // Ya se muestra el orb pulsando; no cambiamos mode
        },
        text_delta: (data) => {
          setStreamingText(prev => prev + (data.text || ''));
        },
        tool_use_start: (data) => {
          setToolActivity(prev => [...prev, { tool: data.tool, status: 'running', at: Date.now() }]);
        },
        tool_use_result: (data) => {
          setToolActivity(prev => prev.map(t =>
            t.tool === data.tool && t.status === 'running' ? { ...t, status: 'done', summary: data.summary } : t
          ));
        },
        followups: () => { /* saludo típicamente no usa followups */ },
        error: () => {
          setStreaming(false);
          setMode('error');
        },
        end: () => {
          setStreaming(false);
          es.close();
        }
      });
      esRef.current = es;
    } catch (err) {
      console.error('Zeus greeting error:', err);
      setMode('error');
    }
  }

  const hasConv = !!conversationId;

  return (
    <>
      <AnimatePresence mode="wait">
        {mode === 'loading' && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="zeus-speaks-hero zeus-speaks-idle"
          >
            <div className="zeus-speaks-pulse" />
            <span>Zeus está despertando...</span>
          </motion.div>
        )}

        {mode === 'greeting' && (
          <ZeusHero
            key="greeting"
            text={streamingText}
            toolActivity={toolActivity}
            streaming={streaming}
            onCollapse={() => setMode('collapsed')}
            onReply={(msgMaybe) => {
              setMode('collapsed');
              setDrawerOpen(true);
              if (msgMaybe) setPendingInitialMessage(msgMaybe);
            }}
          />
        )}

        {mode === 'collapsed' && (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="zeus-speaks-banner"
          >
            <div className="zeus-orb-mini" />
            <span className="zeus-banner-text">
              Zeus está aquí · {hasConv ? 'continuar conversación' : 'listo para hablar'}
            </span>
            <button
              className="zeus-banner-action zeus-banner-primary"
              onClick={() => setDrawerOpen(true)}
              title="Abrir chat con Zeus"
            >
              💬 Abrir chat
            </button>
            <button
              className="zeus-banner-action zeus-banner-subtle"
              onClick={async () => {
                try {
                  await api.post('/api/zeus/greeting/seen', { reset: true }).catch(() => {});
                  localStorage.removeItem(LS_CONV_KEY);
                  setConversationId(null);
                  setStreamingText('');
                  setMode('loading');
                  setTimeout(startGreeting, 100);
                } catch (err) { console.error(err); }
              }}
              title="Que me salude de nuevo"
            >
              🔄
            </button>
          </motion.div>
        )}

        {mode === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="zeus-speaks-banner zeus-speaks-error"
          >
            <span>
              Zeus no responde ahora.{' '}
              <button onClick={startGreeting} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
                Reintentar
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating action button + preview de mensaje proactivo */}
      {!drawerOpen && mode !== 'loading' && (
        <div className="zeus-fab-wrap">
          {unreadPreview && unreadCount > 0 && (
            <motion.button
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(true)}
              className="zeus-unread-preview"
              title="Abrir chat"
            >
              <span className="zeus-unread-preview-label">Zeus:</span>
              <span className="zeus-unread-preview-text">{unreadPreview.preview}</span>
            </motion.button>
          )}
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5 }}
            onClick={() => setDrawerOpen(true)}
            className={`zeus-fab ${unreadCount > 0 ? 'has-unread' : ''}`}
            aria-label="Hablar con Zeus"
            title="Abrir chat con Zeus"
          >
            <span className="zeus-fab-icon">⚡</span>
            {unreadCount > 0 && (
              <span className="zeus-fab-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
          </motion.button>
        </div>
      )}

      {/* Drawer — rendereado en portal al body para escapar overflow/transform de ancestros */}
      {createPortal(
        <AnimatePresence>
          {drawerOpen && (
            <ZeusDrawer
              conversationId={conversationId}
              onNewConversation={(id) => {
                setConversationId(id);
                localStorage.setItem(LS_CONV_KEY, id);
              }}
              onClose={() => { setDrawerOpen(false); setPendingInitialMessage(null); }}
              initialMessage={pendingInitialMessage}
              onInitialMessageConsumed={() => setPendingInitialMessage(null)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HERO — streaming greeting
// ═══════════════════════════════════════════════════════════════════════════

function ZeusHero({ text, toolActivity, streaming, onCollapse, onReply }) {
  const [input, setInput] = useState('');

  function submit() {
    const msg = input.trim();
    if (!msg || streaming) return;
    setInput('');
    onReply(msg);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.5 }}
      className="zeus-speaks-hero"
    >
      <div className="zeus-hero-glow" />
      <div className="zeus-hero-inner">
        <div className="zeus-hero-header">
          <motion.div
            className="zeus-orb-hero"
            animate={streaming ? { scale: [1, 1.08, 1] } : { scale: 1 }}
            transition={streaming ? { duration: 1.6, repeat: Infinity } : {}}
          >
            ⚡
          </motion.div>
          <div style={{ flex: 1 }}>
            <div className="zeus-hero-title">ZEUS</div>
            <div className="zeus-hero-subtitle">
              {streaming ? 'pensando...' : 'tu turno'}
            </div>
          </div>
          <button className="zeus-hero-btn" onClick={onCollapse} title="Ocultar hero">
            Ocultar
          </button>
        </div>

        <div className="zeus-hero-text zeus-markdown">
          <ZeusMarkdown>{text}</ZeusMarkdown>
          {streaming && <span className="zeus-cursor">▌</span>}
        </div>

        <AnimatePresence>
          {toolActivity.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="zeus-hero-tools"
            >
              {toolActivity.map((t, i) => (
                <div key={i} className={`zeus-tool-chip zeus-tool-${t.status}`}>
                  <span className="zeus-tool-dot" />
                  <span className="zeus-tool-name">{toolLabel(t.tool)}</span>
                  {t.summary && <span className="zeus-tool-summary">— {t.summary}</span>}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input inline — responder sin abrir drawer */}
        <div className="zeus-hero-reply">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={streaming ? 'Esperá a que Zeus termine...' : 'Escribí tu respuesta y apretá Enter...'}
            rows={1}
            disabled={streaming}
          />
          <button
            onClick={submit}
            disabled={streaming || !input.trim()}
            className="zeus-send-btn"
            title="Enviar"
          >
            ⟶
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Handler global para links zeus:// — navega al panel correspondiente.
 * Se dispara un custom event que BrainOS escucha y abre el panel.
 */
function handleZeusLink(url) {
  const m = url.match(/^zeus:\/\/([^/]+)\/(.+)$/);
  if (!m) return false;
  const [, kind, id] = m;

  window.dispatchEvent(new CustomEvent('zeus-navigate', {
    detail: { kind, id }
  }));
  return true;
}

function ZeusMarkdown({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...props }) => {
          if (href && href.startsWith('zeus://')) {
            return (
              <a
                href="#"
                className="zeus-entity-link"
                onClick={(e) => {
                  e.preventDefault();
                  handleZeusLink(href);
                }}
                {...props}
              >
                {children}
              </a>
            );
          }
          return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
        },
        code: ({ inline, className, children: codeChildren, ...props }) => {
          const match = /^language-zeus:(\w+)$/.exec(className || '');
          if (match && !inline) {
            const type = match[1];
            try {
              const raw = Array.isArray(codeChildren) ? codeChildren.join('') : String(codeChildren || '');
              const spec = JSON.parse(raw);
              const rendered = renderVizBlock(type, spec);
              if (rendered) return rendered;
            } catch (err) {
              console.warn('[ZeusMarkdown] viz parse error', err);
            }
          }
          // Default code rendering
          return <code className={className} {...props}>{codeChildren}</code>;
        }
      }}
    >
      {children || ''}
    </ReactMarkdown>
  );
}

function stripFollowupsBlock(text) {
  if (!text) return text;
  return text.replace(/---FOLLOWUPS---[\s\S]*?---END---\s*$/, '').trim();
}

function formatConvDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `hace ${days}d`;
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

function toolLabel(tool) {
  const labels = {
    query_portfolio: 'portfolio',
    query_adsets: 'ad sets',
    query_tests: 'tests',
    query_dnas: 'DNAs',
    query_actions: 'acciones',
    query_directives: 'directivas',
    query_insights: 'insights',
    query_hypotheses: 'hipótesis',
    query_duplications: 'duplicaciones',
    query_adset_detail: 'detalle ad set',
    query_overview_history: 'historia portfolio',
    query_time_series: 'serie temporal',
    query_brain_memory: 'memoria',
    query_safety_events: 'safety',
    query_creative_proposals: 'creativos',
    query_ai_creations: 'creaciones AI',
    query_ads: 'ads',
    query_campaigns: 'campañas',
    query_recommendations: 'recomendaciones',
    query_products: 'productos',
    query_strategic_directives: 'estratégia',
    query_agent_conversations: 'comunicación agentes',
    ask_athena: '🦉 consultando a Athena',
    ask_apollo: '☀️ consultando a Apollo',
    ask_prometheus: '🔥 consultando a Prometheus',
    ask_ares: '⚔️ consultando a Ares'
  };
  return labels[tool] || tool;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWER — chat de texto
// ═══════════════════════════════════════════════════════════════════════════

function ZeusDrawer({ conversationId, onNewConversation, onClose, initialMessage, onInitialMessageConsumed }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toolActivity, setToolActivity] = useState([]);
  const [pendingFollowups, setPendingFollowups] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(!!conversationId);
  const [showConversationList, setShowConversationList] = useState(false);
  const [conversationList, setConversationList] = useState([]);
  const scrollRef = useRef(null);
  const esRef = useRef(null);
  const streamingTextRef = useRef('');
  const toolActivityRef = useRef([]);
  const followupsRef = useRef([]);
  const initialHandledRef = useRef(false);

  async function loadConversationList() {
    try {
      const res = await api.get('/api/zeus/chat/conversations');
      setConversationList(res.data.conversations || []);
    } catch (err) { console.error(err); }
  }

  function switchConversation(newId) {
    setShowConversationList(false);
    if (newId === conversationId) return;
    onNewConversation(newId);
    setMessages([]);
    setStreamingText('');
    setToolActivity([]);
  }

  function startNewConversation() {
    setShowConversationList(false);
    setMessages([]);
    setStreamingText('');
    setToolActivity([]);
    onNewConversation(null);
    localStorage.removeItem(LS_CONV_KEY);
  }

  useEffect(() => { streamingTextRef.current = streamingText; }, [streamingText]);
  useEffect(() => { toolActivityRef.current = toolActivity; }, [toolActivity]);
  useEffect(() => { followupsRef.current = pendingFollowups; }, [pendingFollowups]);

  useEffect(() => {
    if (conversationId) loadHistory(conversationId);
    else setLoadingHistory(false);
    return () => { esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Si el drawer se abrió con un initial message desde el hero, enviarlo auto
  useEffect(() => {
    if (!initialMessage || initialHandledRef.current) return;
    if (loadingHistory) return;
    initialHandledRef.current = true;
    sendMessage(initialMessage);
    onInitialMessageConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, loadingHistory]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText]);

  async function loadHistory(convId) {
    setLoadingHistory(true);
    try {
      const res = await api.get('/api/zeus/chat/history', { params: { conversation_id: convId } });
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function sendMessage(override) {
    const msg = (override != null ? override : input).trim();
    if (!msg || streaming) return;
    if (override == null) setInput('');
    setStreaming(true);
    setThinking(false);
    setStreamingText('');
    setToolActivity([]);
    setPendingFollowups([]);

    setMessages(prev => [...prev, { role: 'user', content: msg, _local: true, created_at: new Date() }]);

    const params = new URLSearchParams({ message: msg });
    if (conversationId) params.set('conversation_id', conversationId);

    const es = streamSSE(`/api/zeus/chat/stream?${params.toString()}`, {
      start: (data) => {
        if (data.conversation_id && data.conversation_id !== conversationId) {
          onNewConversation(data.conversation_id);
        }
      },
      thinking: () => setThinking(true),
      text_delta: (data) => {
        setThinking(false);
        setStreamingText(prev => prev + (data.text || ''));
      },
      tool_use_start: (data) => {
        setToolActivity(prev => [...prev, { tool: data.tool, status: 'running' }]);
      },
      tool_use_result: (data) => {
        setToolActivity(prev => prev.map(t =>
          t.tool === data.tool && t.status === 'running' ? { ...t, status: 'done', summary: data.summary } : t
        ));
      },
      followups: (data) => {
        setPendingFollowups(data.items || []);
      },
      end: () => {
        setMessages(prev => {
          const next = [...prev.filter(m => !m._local)];
          next.push({ role: 'user', content: msg, created_at: new Date() });
          const cleanText = stripFollowupsBlock(streamingTextRef.current || '');
          next.push({
            role: 'assistant',
            content: cleanText,
            followups: followupsRef.current,
            created_at: new Date(),
            tool_calls: toolActivityRef.current
          });
          return next;
        });
        setStreamingText('');
        setToolActivity([]);
        setPendingFollowups([]);
        setStreaming(false);
        setThinking(false);
        es.close();
      },
      api_error: (data) => {
        setMessages(prev => {
          const next = [...prev.filter(m => !m._local)];
          next.push({ role: 'user', content: msg, created_at: new Date() });
          next.push({
            role: 'assistant',
            content: `⚠️ Algo falló del lado de Zeus: \`${(data.error || 'error').substring(0, 200)}\`. Reintentá en un momento.`,
            _error: true,
            created_at: new Date()
          });
          return next;
        });
        setStreaming(false);
        setThinking(false);
        es.close();
      },
      error: (data) => {
        setMessages(prev => {
          const next = [...prev.filter(m => !m._local)];
          next.push({ role: 'user', content: msg, created_at: new Date() });
          next.push({
            role: 'assistant',
            content: `⚠️ Se cortó la conexión${data?.error ? ': `' + data.error + '`' : '.'} Reintentá.`,
            _error: true,
            created_at: new Date()
          });
          return next;
        });
        setStreaming(false);
        setThinking(false);
        es.close();
      }
    });

    esRef.current = es;
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="zeus-drawer-backdrop"
        onClick={onClose}
      />
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 260 }}
        className="zeus-drawer"
      >
        <div className="zeus-drawer-header">
          <div className="zeus-drawer-header-inner">
            <div className="zeus-orb-drawer">⚡</div>
            <div>
              <div className="zeus-drawer-title">Zeus</div>
              <div className="zeus-drawer-subtitle">
                {streaming ? '💭 pensando...' : 'Oracle · read-only'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              className="zeus-drawer-icon-btn"
              onClick={() => {
                if (!showConversationList) loadConversationList();
                setShowConversationList(!showConversationList);
              }}
              title="Conversaciones"
            >
              📁
            </button>
            <button
              className="zeus-drawer-icon-btn"
              onClick={startNewConversation}
              title="Nueva conversación"
            >
              ＋
            </button>
            <button className="zeus-drawer-close" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Panel de conversaciones */}
        <AnimatePresence>
          {showConversationList && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-conversations-panel"
            >
              {conversationList.length === 0 ? (
                <div className="zeus-conversations-empty">No hay conversaciones previas</div>
              ) : (
                conversationList.map(c => (
                  <button
                    key={c.conversation_id}
                    onClick={() => switchConversation(c.conversation_id)}
                    className={`zeus-conversation-item ${c.conversation_id === conversationId ? 'active' : ''}`}
                  >
                    <div className="zeus-conv-preview">{c.preview || '(sin mensajes)'}</div>
                    <div className="zeus-conv-meta">
                      {c.message_count} mensajes · {formatConvDate(c.last_at)}
                    </div>
                  </button>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={scrollRef} className="zeus-drawer-messages">
          {loadingHistory ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--bos-text-muted)', fontSize: '0.8rem' }}>
              Cargando conversación...
            </div>
          ) : (
            <>
              {messages.length === 0 && !streamingText && (
                <div className="zeus-drawer-empty">
                  <div className="zeus-empty-orb">⚡</div>
                  <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
                    Preguntále a Zeus lo que quieras.
                  </div>
                  <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--bos-text-muted)' }}>
                    Puede consultar cualquier parte de la base de datos.
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <MessageBubble
                  key={i}
                  message={m}
                  onFollowup={(q) => sendMessage(q)}
                />
              ))}

              {streaming && (
                <div className="zeus-msg zeus-msg-assistant">
                  <div className="zeus-msg-avatar">⚡</div>
                  <div className="zeus-msg-content">
                    {thinking && !streamingText && (
                      <div className="zeus-thinking-indicator">
                        <span className="zeus-thinking-dot" />
                        <span className="zeus-thinking-dot" />
                        <span className="zeus-thinking-dot" />
                        <span style={{ marginLeft: 6 }}>pensando profundamente...</span>
                      </div>
                    )}
                    {toolActivity.length > 0 && (
                      <div className="zeus-msg-tools">
                        {toolActivity.map((t, i) => (
                          <div key={i} className={`zeus-tool-chip zeus-tool-${t.status}`}>
                            <span className="zeus-tool-dot" />
                            <span>{toolLabel(t.tool)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {streamingText && (
                      <div className="zeus-msg-text zeus-markdown">
                        <ZeusMarkdown>{stripFollowupsBlock(streamingText)}</ZeusMarkdown>
                        <span className="zeus-cursor">▌</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </>
          )}
        </div>

        <div className="zeus-drawer-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Preguntále a Zeus..."
            rows={1}
            disabled={streaming}
          />
          <button
            onClick={() => sendMessage()}
            disabled={streaming || !input.trim()}
            className="zeus-send-btn"
          >
            {streaming ? '...' : '⟶'}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function MessageBubble({ message, onFollowup }) {
  const isUser = message.role === 'user';
  const isGreeting = message.role === 'system_greeting';
  const followups = !isUser ? (message.followups || []) : [];

  return (
    <div className={`zeus-msg ${isUser ? 'zeus-msg-user' : 'zeus-msg-assistant'}`}>
      {!isUser && <div className="zeus-msg-avatar">⚡</div>}
      <div className="zeus-msg-content">
        {!isUser && (message.tool_calls?.length > 0) && (
          <div className="zeus-msg-tools">
            {message.tool_calls.map((t, i) => (
              <div key={i} className="zeus-tool-chip zeus-tool-done">
                <span className="zeus-tool-dot" />
                <span>{toolLabel(t.tool)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="zeus-msg-text zeus-markdown">
          {isUser
            ? message.content
            : <ZeusMarkdown>{stripFollowupsBlock(message.content || '')}</ZeusMarkdown>}
        </div>
        {isGreeting && (
          <div className="zeus-msg-meta">saludo automático</div>
        )}
        {message.proactive && (
          <div className="zeus-msg-meta zeus-msg-meta-proactive">⚡ Zeus te avisa</div>
        )}
        {followups.length > 0 && onFollowup && (
          <div className="zeus-followups zeus-followups-inline">
            {followups.map((f, i) => (
              <button key={i} className="zeus-followup-btn" onClick={() => onFollowup(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
