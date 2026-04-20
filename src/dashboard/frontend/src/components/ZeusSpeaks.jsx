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

      {/* Top banner — anuncio mini arriba del dashboard cuando hay proactive sin leer */}
      <AnimatePresence>
        {unreadPreview && unreadCount > 0 && !drawerOpen && (
          <motion.button
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
            onClick={() => setDrawerOpen(true)}
            className="zeus-top-banner"
          >
            <span className="zeus-top-banner-icon">⚡</span>
            <span className="zeus-top-banner-label">Zeus</span>
            <span className="zeus-top-banner-text">{unreadPreview.preview}</span>
            {unreadCount > 1 && (
              <span className="zeus-top-banner-count">+{unreadCount - 1}</span>
            )}
            <span className="zeus-top-banner-cta">abrir ⟶</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Floating action button */}
      {!drawerOpen && mode !== 'loading' && (
        <div className="zeus-fab-wrap">
          {/* preview removido — ahora usamos el top banner arriba */}
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
    ask_ares: '⚔️ consultando a Ares',
    code_overview: '📂 overview del código',
    list_code_files: '📄 listando archivos',
    read_code_file: '📖 leyendo código',
    grep_code: '🔍 buscando en código',
    propose_code_change: '💡 guardando recomendación',
    remember_preference: '💭 recordando',
    forget_preference: '💭 olvidando',
    list_preferences: '💭 revisando memoria',
    create_directive: '📣 emitiendo directiva',
    deactivate_directive: '📣 desactivando directiva',
    query_delivery_health: '🩺 chequeando salud de delivery',
    create_watcher: '👁️ creando watcher',
    cancel_watcher: '👁️ cancelando watcher',
    list_watchers: '👁️ revisando watchers',
    query_calibration: '📊 revisando mi track record',
    track_recommendation: '📊 trackeando recomendación',
    mark_recommendation_applied: '📊 marcando aplicada',
    form_hypothesis: '🔬 formulando hipótesis',
    commission_hypothesis_test: '🔬 comisionando test',
    list_hypotheses: '🔬 revisando hipótesis',
    query_strategic_plan: '🗺️ leyendo plan estratégico',
    generate_plan: '🗺️ generando plan',
    approve_plan: '🗺️ aprobando plan',
    set_north_star: '⭐ seteando north star',
    write_journal_entry: '📓 escribiendo journal',
    list_playbooks: '📘 revisando mis playbooks'
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
  const [showCodeRecs, setShowCodeRecs] = useState(false);
  const [codeRecs, setCodeRecs] = useState([]);
  const [codeRecsCounts, setCodeRecsCounts] = useState({});
  const [codeRecsFilter, setCodeRecsFilter] = useState('pending');
  const [showMemory, setShowMemory] = useState(false);
  const [preferences, setPreferences] = useState([]);
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

  async function loadCodeRecs() {
    try {
      const params = codeRecsFilter !== 'all' ? { status: codeRecsFilter } : {};
      const res = await api.get('/api/zeus/code-recs', { params });
      setCodeRecs(res.data.recs || []);
      setCodeRecsCounts(res.data.counts || {});
    } catch (err) { console.error(err); }
  }

  async function updateRecStatus(id, status) {
    try {
      await api.patch(`/api/zeus/code-recs/${id}`, { status });
      await loadCodeRecs();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function deleteRec(id) {
    if (!window.confirm('Borrar esta recomendación?')) return;
    try {
      await api.delete(`/api/zeus/code-recs/${id}`);
      await loadCodeRecs();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showCodeRecs) loadCodeRecs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCodeRecs, codeRecsFilter]);

  async function loadPreferences() {
    try {
      const res = await api.get('/api/zeus/preferences');
      setPreferences(res.data.preferences || []);
    } catch (err) { console.error(err); }
  }

  async function deletePreference(id) {
    if (!window.confirm('Borrar esta memoria?')) return;
    try { await api.delete(`/api/zeus/preferences/${id}`); await loadPreferences(); }
    catch (err) { alert('Error: ' + err.message); }
  }

  async function togglePreferenceActive(id, active) {
    try {
      await api.patch(`/api/zeus/preferences/${id}`, { active });
      await loadPreferences();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showMemory) loadPreferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMemory]);

  // Load counts al abrir drawer (para el badge del 💡)
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/api/zeus/code-recs', { params: { limit: 1 } });
        setCodeRecsCounts(res.data.counts || {});
      } catch (_) {}
    })();
  }, []);

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
    const uiContext = typeof window !== 'undefined' ? window.__zeusUiContext : null;
    if (uiContext) params.set('ui_context', JSON.stringify(uiContext));

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
                setShowMemory(!showMemory);
                setShowCodeRecs(false);
                setShowConversationList(false);
              }}
              title="Memoria de Zeus"
            >
              💭
            </button>
            <button
              className="zeus-drawer-icon-btn"
              onClick={() => {
                setShowCodeRecs(!showCodeRecs);
                setShowMemory(false);
                setShowConversationList(false);
              }}
              title="Recomendaciones de código"
            >
              💡
              {codeRecsCounts.pending > 0 && (
                <span className="zeus-icon-badge">{codeRecsCounts.pending > 9 ? '9+' : codeRecsCounts.pending}</span>
              )}
            </button>
            <button
              className="zeus-drawer-icon-btn"
              onClick={() => {
                if (!showConversationList) loadConversationList();
                setShowConversationList(!showConversationList);
                setShowCodeRecs(false);
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

        {/* Panel de memoria */}
        <AnimatePresence>
          {showMemory && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-memory-panel"
            >
              <div className="zeus-memory-header">
                <div className="zeus-memory-title">💭 Lo que Zeus recuerda de vos</div>
                <div className="zeus-memory-sub">Preferencias persistentes entre conversaciones. Zeus las inyecta en cada respuesta.</div>
              </div>
              {preferences.length === 0 ? (
                <div className="zeus-memory-empty">Zeus aún no recuerda nada específico. Decíle cosas tipo "priorizá X sobre Y" y las aprenderá.</div>
              ) : (
                preferences.map(p => (
                  <div key={p._id} className={`zeus-memory-item ${!p.active ? 'inactive' : ''}`}>
                    <div className="zeus-memory-item-head">
                      <span className="zeus-memory-cat">{p.category}</span>
                      <span className="zeus-memory-key">{p.key}</span>
                      <span className="zeus-memory-spacer" />
                      <button className="zeus-memory-toggle" onClick={() => togglePreferenceActive(p._id, !p.active)} title={p.active ? 'Desactivar' : 'Reactivar'}>
                        {p.active ? '●' : '○'}
                      </button>
                      <button className="zeus-memory-del" onClick={() => deletePreference(p._id)} title="Borrar">×</button>
                    </div>
                    <div className="zeus-memory-value">{p.value}</div>
                    {p.context && <div className="zeus-memory-context">{p.context}</div>}
                  </div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel de recomendaciones de código */}
        <AnimatePresence>
          {showCodeRecs && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-coderecs-panel"
            >
              <div className="zeus-coderecs-header">
                <div className="zeus-coderecs-title">💡 Recomendaciones de Zeus</div>
                <div className="zeus-coderecs-filter">
                  {['pending', 'accepted', 'rejected', 'applied', 'all'].map(f => (
                    <button
                      key={f}
                      onClick={() => setCodeRecsFilter(f)}
                      className={`zeus-coderecs-filter-btn ${codeRecsFilter === f ? 'active' : ''}`}
                    >
                      {f === 'all' ? 'todas' : f}
                      {codeRecsCounts[f] > 0 && f !== 'all' && ` · ${codeRecsCounts[f]}`}
                    </button>
                  ))}
                </div>
              </div>
              {codeRecs.length === 0 ? (
                <div className="zeus-coderecs-empty">
                  {codeRecsFilter === 'pending'
                    ? 'No hay recomendaciones pendientes. Zeus te las dejará acá cuando detecte mejoras concretas.'
                    : `No hay recomendaciones ${codeRecsFilter}.`}
                </div>
              ) : (
                codeRecs.map(rec => (
                  <CodeRecCard
                    key={rec._id}
                    rec={rec}
                    onAccept={() => updateRecStatus(rec._id, 'accepted')}
                    onReject={() => updateRecStatus(rec._id, 'rejected')}
                    onApply={() => updateRecStatus(rec._id, 'applied')}
                    onDelete={() => deleteRec(rec._id)}
                  />
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

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

function CodeRecCard({ rec, onAccept, onReject, onApply, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const severityColors = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#fbbf24',
    low: '#60a5fa'
  };
  const categoryIcons = {
    threshold: '📊',
    bug: '🐛',
    optimization: '⚡',
    dead_code: '🗑️',
    refactor: '🔧',
    safety: '🛡️',
    naming: '🏷️',
    other: '💡'
  };
  const statusColors = {
    pending: '#fbbf24',
    accepted: '#10b981',
    rejected: '#6b7280',
    applied: '#8b5cf6'
  };

  return (
    <div className="zeus-coderec-card" style={{ borderLeftColor: severityColors[rec.severity] }}>
      <div className="zeus-coderec-head">
        <span className="zeus-coderec-cat">{categoryIcons[rec.category] || '💡'} {rec.category}</span>
        <span className="zeus-coderec-severity" style={{ color: severityColors[rec.severity] }}>{rec.severity}</span>
        <span className="zeus-coderec-status" style={{ color: statusColors[rec.status] }}>{rec.status}</span>
        <span className="zeus-coderec-spacer" />
        <button className="zeus-coderec-iconbtn" onClick={onDelete} title="Borrar">×</button>
      </div>
      <div className="zeus-coderec-path">
        <code>{rec.file_path}{rec.line_start ? `:${rec.line_start}${rec.line_end && rec.line_end !== rec.line_start ? '-' + rec.line_end : ''}` : ''}</code>
      </div>
      <div className="zeus-coderec-rationale">{rec.rationale}</div>
      <div className="zeus-coderec-evidence">
        <span className="zeus-coderec-evidence-label">Evidencia:</span> {rec.evidence_summary}
      </div>
      {(rec.current_code || rec.proposed_code) && (
        <>
          <button
            className="zeus-coderec-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▾' : '▸'} Ver diff
          </button>
          {expanded && (
            <div className="zeus-coderec-diff">
              {rec.current_code && (
                <div>
                  <div className="zeus-coderec-difflabel zeus-coderec-difflabel-old">— actual</div>
                  <pre className="zeus-coderec-code zeus-coderec-code-old">{rec.current_code}</pre>
                </div>
              )}
              {rec.proposed_code && (
                <div>
                  <div className="zeus-coderec-difflabel zeus-coderec-difflabel-new">+ propuesto</div>
                  <pre className="zeus-coderec-code zeus-coderec-code-new">{rec.proposed_code}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {rec.expected_impact && (
        <div className="zeus-coderec-impact">
          <span className="zeus-coderec-evidence-label">Impacto esperado:</span> {rec.expected_impact}
        </div>
      )}
      {rec.status === 'pending' && (
        <div className="zeus-coderec-actions">
          <button className="zeus-coderec-btn zeus-coderec-btn-reject" onClick={onReject}>Rechazar</button>
          <button className="zeus-coderec-btn zeus-coderec-btn-accept" onClick={onAccept}>Aceptar</button>
        </div>
      )}
      {rec.status === 'accepted' && (
        <div className="zeus-coderec-actions">
          <button className="zeus-coderec-btn zeus-coderec-btn-apply" onClick={onApply}>Marcar como aplicada</button>
        </div>
      )}
    </div>
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
          <div className="zeus-msg-meta zeus-msg-meta-proactive">⚡ proactivo</div>
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
