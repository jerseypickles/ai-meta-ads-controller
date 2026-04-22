import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AdSetDetailModal } from './AdSetDetailCard';

// react-markdown v10 por defecto sanea URLs con un safelist (http/https/mailto).
// Nuestros links `zeus://adset/<id>` NO están en ese safelist — el default
// transform los convierte a string vacío y el componente cae al fallback que
// recarga la página. Este transform preserva zeus:// y delega el resto al
// default de la lib.
function zeusUrlTransform(url) {
  if (url && url.startsWith('zeus://')) return url;
  return defaultUrlTransform(url);
}
import api from '../api';
import { renderVizBlock } from './zeus-viz';

const LS_CONV_KEY = 'zeus_oracle_conversation_id';
const LS_DRAWER_OPEN_KEY = 'zeus_oracle_drawer_open';
const LS_MESSAGES_CACHE_KEY = 'zeus_oracle_messages_cache';

function formatTimeAgo(date) {
  if (!date) return '';
  const d = new Date(date);
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return 'ahora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

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
  const [drawerOpen, setDrawerOpen] = useState(() => {
    // Restaura estado del drawer en refresh — si estaba abierto, vuelve abierto
    try { return localStorage.getItem(LS_DRAWER_OPEN_KEY) === '1'; } catch (_) { return false; }
  });
  const [pendingInitialMessage, setPendingInitialMessage] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadPreview, setUnreadPreview] = useState(null);
  const esRef = useRef(null);

  // Persiste estado del drawer
  useEffect(() => {
    try { localStorage.setItem(LS_DRAWER_OPEN_KEY, drawerOpen ? '1' : '0'); } catch (_) {}
  }, [drawerOpen]);

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
          if (!data.conversation_id) return;
          const currentLS = localStorage.getItem(LS_CONV_KEY);
          // Si el server devuelve una conv_id distinta a la que pasamos, avisamos
          // en consola — antes esto sobreescribía silenciosamente y perdíamos historial.
          if (currentLS && currentLS !== data.conversation_id) {
            console.warn(`[ZEUS] greeting devolvió conv distinta: ${currentLS} → ${data.conversation_id}. Conservo la del cliente.`);
            setConversationId(currentLS);
            return;
          }
          setConversationId(data.conversation_id);
          localStorage.setItem(LS_CONV_KEY, data.conversation_id);
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
                  localStorage.removeItem(LS_MESSAGES_CACHE_KEY);
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

      {/* Notificación Zeus — card discreta top-right cuando hay proactive sin leer */}
      <AnimatePresence>
        {unreadPreview && unreadCount > 0 && !drawerOpen && (
          <motion.button
            initial={{ opacity: 0, x: 20, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.95 }}
            transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            onClick={() => setDrawerOpen(true)}
            className="zeus-notif-card"
          >
            <div className="zeus-notif-top">
              <span className="zeus-notif-avatar">⚡</span>
              <span className="zeus-notif-label">Zeus</span>
              <span className="zeus-notif-time">{formatTimeAgo(unreadPreview.created_at)}</span>
              {unreadCount > 1 && (
                <span className="zeus-notif-count">+{unreadCount - 1}</span>
              )}
            </div>
            <div className="zeus-notif-preview">{unreadPreview.preview}</div>
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

function ZeusMarkdown({ children, onEntityClick }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={zeusUrlTransform}
      components={{
        a: ({ href, children, ...props }) => {
          if (href && href.startsWith('zeus://')) {
            return (
              <a
                href="#"
                className="zeus-entity-link"
                onClick={(e) => {
                  e.preventDefault();
                  const m = href.match(/^zeus:\/\/([^/]+)\/(.+)$/);
                  if (!m) return;
                  const [, kind, id] = m;
                  // onEntityClick local tiene prioridad (para cards inline en chat).
                  // Si no consume el evento, cae al handler global (navega al panel).
                  if (onEntityClick) {
                    const handled = onEntityClick(kind, id);
                    if (handled) return;
                  }
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
        // Envolvemos la tabla en un wrapper con scroll horizontal — resuelve
        // el caso de tablas con muchas columnas donde los headers se parten
        // letra por letra por falta de ancho.
        table: ({ children, ...props }) => (
          <div className="zeus-markdown-table-wrap">
            <table {...props}>{children}</table>
          </div>
        ),
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
    query_code_recommendations: '💡 revisando mis code recs',
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
    list_playbooks: '📘 revisando mis playbooks',
    query_execution_authority: '🔐 revisando autoridad ejecutiva',
    check_execution_readiness: '🔐 chequeando si puedo ejecutar'
  };
  return labels[tool] || tool;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWER — chat de texto
// ═══════════════════════════════════════════════════════════════════════════

function ZeusDrawer({ conversationId, onNewConversation, onClose, initialMessage, onInitialMessageConsumed }) {
  // Inicializa mensajes con cache local (instant show mientras server fetch corre en paralelo)
  const [messages, setMessages] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_MESSAGES_CACHE_KEY);
      if (!raw) return [];
      const cache = JSON.parse(raw);
      // Solo usamos cache si matchea la conversation actual
      if (cache.conversation_id === conversationId && Array.isArray(cache.messages)) {
        return cache.messages;
      }
    } catch (_) {}
    return [];
  });
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
  const [showPlans, setShowPlans] = useState(false);
  const [plans, setPlans] = useState([]);
  const [plansHorizon, setPlansHorizon] = useState('all');
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarUpcoming, setCalendarUpcoming] = useState([]);
  const [calendarAll, setCalendarAll] = useState([]);
  const [showArchitecture, setShowArchitecture] = useState(false);
  const [archProposals, setArchProposals] = useState([]);
  const [archCounts, setArchCounts] = useState({});
  const [archFilter, setArchFilter] = useState('draft');
  const [showPalette, setShowPalette] = useState(false);
  const [prefDraftsCount, setPrefDraftsCount] = useState(0);
  const [showStances, setShowStances] = useState(false);
  const [stancesCurrent, setStancesCurrent] = useState({});
  const [stancesHistory, setStancesHistory] = useState({});
  // Hilo B — panel 📓 de calibración de respuesta
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibTab, setCalibTab] = useState('anti_refs'); // anti_refs | references | traps | audits
  const [calibEntries, setCalibEntries] = useState([]);
  const [calibCounts, setCalibCounts] = useState({});
  const [calibTraps, setCalibTraps] = useState([]);
  const [calibTrapCounts, setCalibTrapCounts] = useState({});
  // Hilo C — panel 🎚️ auto-pause
  const [showAutoPause, setShowAutoPause] = useState(false);
  const [apStatus, setApStatus] = useState(null);
  const [apTab, setApTab] = useState('live'); // live | shadow
  const [apLogs, setApLogs] = useState([]);
  // Modal overlay de drill-in de adset (al clickear link zeus://adset/<id> en el chat)
  const [activeAdsetId, setActiveAdsetId] = useState(null);
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
    localStorage.removeItem(LS_MESSAGES_CACHE_KEY);
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
      const res = await api.get('/api/zeus/preferences', { params: { include_inactive: 1, status: 'all' } });
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

  async function decidePreference(id, decision) {
    try {
      await api.post(`/api/zeus/preferences/${id}/decide`, { decision });
      await loadPreferences();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function triggerPreferenceDetector() {
    if (!window.confirm('Disparar detector manual? Analiza últimos 30d de interacciones (~30s).')) return;
    try {
      await api.post('/api/zeus/preferences/detect');
      await loadPreferences();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showMemory) loadPreferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMemory]);

  async function loadPlans() {
    try {
      const params = plansHorizon !== 'all' ? { horizon: plansHorizon } : {};
      const res = await api.get('/api/zeus/strategic-plans', { params });
      setPlans(res.data.plans || []);
    } catch (err) { console.error(err); }
  }

  async function approvePlan(planId) {
    try {
      await api.post(`/api/zeus/strategic-plans/${planId}/approve`);
      await loadPlans();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function deletePlan(planId) {
    if (!window.confirm('Borrar este plan?')) return;
    try {
      await api.delete(`/api/zeus/strategic-plans/${planId}`);
      await loadPlans();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function regeneratePlan(horizon) {
    if (!window.confirm(`Regenerar plan ${horizon}? El actual se va a supersedear cuando apruebes el nuevo.`)) return;
    try {
      await api.post('/api/zeus/strategic-plans/generate', { horizon });
      await loadPlans();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showPlans) loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlans, plansHorizon]);

  async function loadCalendar() {
    try {
      const res = await api.get('/api/zeus/seasonal-events', { params: { days_ahead: 120 } });
      setCalendarUpcoming(res.data.upcoming || []);
      setCalendarAll(res.data.all || []);
    } catch (err) { console.error(err); }
  }

  async function toggleCalendarEvent(id) {
    try {
      await api.post(`/api/zeus/seasonal-events/${id}/toggle`);
      await loadCalendar();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showCalendar) loadCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCalendar]);

  async function loadArchitecture() {
    try {
      const params = archFilter !== 'all' ? { status: archFilter } : {};
      const res = await api.get('/api/zeus/architecture-proposals', { params });
      setArchProposals(res.data.proposals || []);
      setArchCounts(res.data.counts || {});
    } catch (err) { console.error(err); }
  }

  async function decideArchProposal(id, decision, note = '') {
    try {
      await api.post(`/api/zeus/architecture-proposals/${id}/decide`, { decision, note });
      await loadArchitecture();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function markArchBuilt(id) {
    if (!window.confirm('Marcar como "built" — construida y desplegada?')) return;
    try {
      await api.post(`/api/zeus/architecture-proposals/${id}/mark-built`);
      await loadArchitecture();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function generateArchProposal() {
    if (!window.confirm('Disparar una reflexión arquitectónica ahora? Toma ~30s.')) return;
    try {
      await api.post('/api/zeus/architecture-proposals/generate');
      await loadArchitecture();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showArchitecture) loadArchitecture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchitecture, archFilter]);

  async function loadStances() {
    try {
      const res = await api.get('/api/zeus/agent-stances');
      setStancesCurrent(res.data.current || {});
      const agents = Object.keys(res.data.current || {});
      const histories = {};
      for (const a of agents) {
        try {
          const h = await api.get(`/api/zeus/agent-stances/${a}/history`, { params: { limit: 14 } });
          histories[a] = h.data.history || [];
        } catch (_) {}
      }
      setStancesHistory(histories);
    } catch (err) { console.error(err); }
  }

  async function overrideStance(agent) {
    const stance = window.prompt(`Override ${agent} a qué stance? (aggressive/steady/observe-only/paused/recovering)`);
    if (!stance) return;
    const reason = window.prompt('Razón del override?');
    if (!reason) return;
    const hrsStr = window.prompt('Horas (1-72, default 24)?', '24');
    const hours = Math.min(72, Math.max(1, parseInt(hrsStr) || 24));
    try {
      await api.post('/api/zeus/agent-stances/override', { agent, stance, reason, expires_in_hours: hours });
      await loadStances();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function renewStanceUI(stanceId) {
    try {
      await api.post(`/api/zeus/agent-stances/${stanceId}/renew`, { additional_hours: 24 });
      await loadStances();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function triggerBriefing(agent) {
    if (!window.confirm(`Disparar briefing manual de ${agent}? (~30s)`)) return;
    try {
      await api.post(`/api/zeus/agent-stances/briefing/${agent}`);
      await loadStances();
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showStances) loadStances();
  }, [showStances]);

  // Hilo B — calibración de respuesta
  async function loadCalibrationEntries(tab) {
    try {
      if (tab === 'traps') {
        const res = await api.get('/api/zeus/calibration/traps');
        setCalibTraps(res.data.traps || []);
        setCalibTrapCounts(res.data.counts_90d || {});
        return;
      }
      const typeMap = {
        anti_refs: 'anti_reference_response',
        references: 'reference_response',
        audits: 'audit_report'
      };
      const type = typeMap[tab];
      const res = await api.get('/api/zeus/calibration/entries', { params: { type, limit: 50 } });
      setCalibEntries(res.data.entries || []);
      setCalibCounts(res.data.counts || {});
    } catch (err) {
      console.error('loadCalibrationEntries', err);
    }
  }

  async function createTrap() {
    const content = window.prompt('Contenido de la trampa (afirmación plausible pero falsa que le dirías al chat):');
    if (!content) return;
    const expected = window.prompt('Contradicción esperada (cuál sería la respuesta correcta con data):');
    if (!expected) return;
    const source = window.prompt('Fuente (creator / team / adversarial_llm):', 'creator') || 'creator';
    const category = window.prompt('Categoría opcional (ej: performance_claim, causal_attribution):', '') || '';
    try {
      await api.post('/api/zeus/calibration/traps', { content, expected_contradiction: expected, source, category, created_by: 'creator' });
      await loadCalibrationEntries('traps');
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function executeTrap(trapId) {
    if (!window.confirm('Ejecutar trampa? Zeus la va a procesar como mensaje normal y se evalúa la respuesta. Toma ~30-60s.')) return;
    try {
      await api.post(`/api/zeus/calibration/traps/${trapId}/execute`);
      await loadCalibrationEntries('traps');
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function deleteTrap(trapId) {
    if (!window.confirm('Borrar trampa?')) return;
    try {
      await api.delete(`/api/zeus/calibration/traps/${trapId}`);
      await loadCalibrationEntries('traps');
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function promoteEntry(entryId, mark) {
    try {
      await api.post(`/api/zeus/calibration/entries/${entryId}/promote`, { mark });
      await loadCalibrationEntries(calibTab);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function runManualAudit() {
    if (!window.confirm('Correr auditoría trimestral ahora sobre los últimos 90d?')) return;
    try {
      await api.post('/api/zeus/calibration/audit/run');
      await loadCalibrationEntries('audits');
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showCalibration) loadCalibrationEntries(calibTab);
  }, [showCalibration, calibTab]);

  // Hilo C — auto-pause handlers
  async function loadAutoPause(tab) {
    try {
      const [statusRes, logsRes] = await Promise.all([
        api.get('/api/zeus/auto-pause/status'),
        api.get(`/api/zeus/auto-pause/${tab === 'shadow' ? 'shadow-logs' : 'logs'}`, { params: { limit: 50 } })
      ]);
      setApStatus(statusRes.data);
      setApLogs(logsRes.data.logs || []);
    } catch (err) { console.error('loadAutoPause', err); }
  }

  async function changeApMode(newMode) {
    const currentMode = apStatus?.mode || 'disabled';
    if (newMode === currentMode) return;
    const warnings = {
      'disabled_to_shadow': 'Pasar a SHADOW — el detector va a loggear candidatos pero NO va a pausar. Sin riesgo operativo. ¿Confirmás?',
      'shadow_to_live': '⚠️ Pasar a LIVE — el sistema va a PAUSAR adsets automáticamente. Asegurate de tener 20+ candidatos shadow con <15% FP rate antes. ¿Confirmás?',
      'live_to_shadow': 'Pasar de LIVE a SHADOW — deja de pausar pero sigue loggeando. ¿Confirmás?',
      'to_disabled': 'DESACTIVAR auto-pause completo. Se frena cualquier detección y ejecución. ¿Confirmás?'
    };
    let msg;
    if (newMode === 'disabled') msg = warnings.to_disabled;
    else if (currentMode === 'disabled' && newMode === 'shadow') msg = warnings.disabled_to_shadow;
    else if (currentMode === 'shadow' && newMode === 'live') msg = warnings.shadow_to_live;
    else if (currentMode === 'live' && newMode === 'shadow') msg = warnings.live_to_shadow;
    else msg = `Cambiar mode: ${currentMode} → ${newMode}. ¿Confirmás?`;
    if (!window.confirm(msg)) return;
    const reason = window.prompt('Razón (opcional, queda en el log):', '') || '';
    try {
      await api.post('/api/zeus/auto-pause/mode', { mode: newMode, reason });
      await loadAutoPause(apTab);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function clearApYellowZone() {
    if (!window.confirm('Limpiar yellow zone — esto permite que el detector vuelva a ejecutar nuevas pauses. Solo hacelo si revisaste los FPs y decidiste continuar. ¿Confirmás?')) return;
    try {
      await api.post('/api/zeus/auto-pause/yellow-zone/clear');
      await loadAutoPause(apTab);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function reactivateApLog(logId) {
    if (!window.confirm('Reactivar este adset en Meta y registrar la reactivación? Se va a trackear como FP candidato con review a 7d.')) return;
    const reason = window.prompt('Razón de la reactivación:', '') || '';
    try {
      await api.post(`/api/zeus/auto-pause/logs/${logId}/reactivate`, { reason });
      await loadAutoPause(apTab);
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function runApHealthCheck() {
    if (!window.confirm('Correr health check manual ahora? Evalúa FP rate, delivery confounds, drift behavioral. Puede desactivar el sistema si dispara kill criteria.')) return;
    try {
      const r = await api.post('/api/zeus/auto-pause/health/run');
      alert(`Health check: zone=${r.data.report.zone} · action=${r.data.report.action}${r.data.report.reason ? '\nReason: ' + r.data.report.reason : ''}`);
      await loadAutoPause(apTab);
    } catch (err) { alert('Error: ' + err.message); }
  }

  useEffect(() => {
    if (showAutoPause) loadAutoPause(apTab);
  }, [showAutoPause, apTab]);

  // Load counts al abrir drawer (para el badge del 💡 y 🏛️ y drafts de memoria)
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/api/zeus/code-recs', { params: { limit: 1 } });
        setCodeRecsCounts(res.data.counts || {});
      } catch (_) {}
      try {
        const res = await api.get('/api/zeus/architecture-proposals', { params: { status: 'all' } });
        setArchCounts(res.data.counts || {});
      } catch (_) {}
      try {
        const res = await api.get('/api/zeus/preferences', { params: { status: 'proposed' } });
        setPrefDraftsCount((res.data.preferences || []).length);
      } catch (_) {}
    })();
  }, []);

  useEffect(() => { streamingTextRef.current = streamingText; }, [streamingText]);

  // Persiste cache de mensajes en localStorage — para show instantáneo en refresh.
  // Fix 2026-04-22: si QuotaExceededError, re-intentamos con menos mensajes en vez
  // de fallar silencioso (antes tenía catch (_) {} mudo — el cache se rompía sin
  // aviso cuando algún mensaje tenía tool_calls o context_snapshot grandes).
  useEffect(() => {
    if (!conversationId) return;
    function trySave(count) {
      const trimmed = messages.slice(-count);
      localStorage.setItem(LS_MESSAGES_CACHE_KEY, JSON.stringify({
        conversation_id: conversationId,
        messages: trimmed,
        saved_at: Date.now()
      }));
    }
    try {
      trySave(30);
    } catch (err) {
      if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
        // Quota llena — intentamos con 15, luego 5, luego limpiamos
        for (const fallback of [15, 5]) {
          try {
            trySave(fallback);
            console.warn(`[ZeusSpeaks] localStorage quota — degradé a últimos ${fallback} mensajes`);
            return;
          } catch (_) { /* siguiente fallback */ }
        }
        // Último recurso: limpiar el cache entero
        try { localStorage.removeItem(LS_MESSAGES_CACHE_KEY); } catch (_) {}
        console.warn('[ZeusSpeaks] localStorage quota — cache limpiado; next refresh carga desde API');
      } else {
        console.warn('[ZeusSpeaks] localStorage save falló:', err?.message || err);
      }
    }
  }, [messages, conversationId]);
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
    // Solo mostramos loading si NO tenemos cache — cache visible instantáneo, server reconcila en bg
    const hasCache = messages.length > 0;
    if (!hasCache) setLoadingHistory(true);
    try {
      const res = await api.get('/api/zeus/chat/history', { params: { conversation_id: convId } });
      const serverMessages = res.data.messages || [];
      // Si el server tiene más mensajes que el cache, reemplazamos. Si menos (edge case),
      // mantenemos cache que probablemente tiene mensajes locales recientes aún no persistidos.
      setMessages(prev => {
        if (serverMessages.length >= prev.length) return serverMessages;
        // Preservamos mensajes locales al final que el server todavía no tiene
        const localTail = prev.filter(m => m._local);
        return [...serverMessages, ...localTail];
      });
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
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', position: 'relative' }}>
            <button
              className={`zeus-drawer-icon-btn zeus-palette-btn ${showPalette ? 'active' : ''}`}
              onClick={() => setShowPalette(!showPalette)}
              title="Paneles de Zeus"
            >
              ☰
              {(codeRecsCounts.pending + (archCounts.draft || 0) + prefDraftsCount) > 0 && (
                <span className="zeus-icon-badge">
                  {Math.min(99, codeRecsCounts.pending + (archCounts.draft || 0) + prefDraftsCount)}
                </span>
              )}
            </button>
            <button
              className="zeus-drawer-icon-btn"
              onClick={startNewConversation}
              title="Nueva conversación"
            >
              ＋
            </button>
            <button className="zeus-drawer-close" onClick={onClose}>×</button>
            <AnimatePresence>
              {showPalette && (
                <ZeusPalette
                  onClose={() => setShowPalette(false)}
                  codeRecsPending={codeRecsCounts.pending || 0}
                  archDrafts={archCounts.draft || 0}
                  prefDrafts={prefDraftsCount}
                  onSelect={(key) => {
                    setShowPlans(false);
                    setShowCalendar(false);
                    setShowArchitecture(false);
                    setShowMemory(false);
                    setShowCodeRecs(false);
                    setShowConversationList(false);
                    setShowStances(false);
                    setShowCalibration(false);
                    setShowAutoPause(false);
                    if (key === 'plans') setShowPlans(true);
                    else if (key === 'calendar') setShowCalendar(true);
                    else if (key === 'architecture') setShowArchitecture(true);
                    else if (key === 'memory') setShowMemory(true);
                    else if (key === 'coderecs') setShowCodeRecs(true);
                    else if (key === 'stances') setShowStances(true);
                    else if (key === 'calibration') setShowCalibration(true);
                    else if (key === 'autopause') setShowAutoPause(true);
                    else if (key === 'conversations') {
                      loadConversationList();
                      setShowConversationList(true);
                    }
                    setShowPalette(false);
                  }}
                />
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Panel de planes estratégicos */}
        <AnimatePresence>
          {showPlans && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-plans-panel"
            >
              <div className="zeus-plans-header">
                <button className="zeus-panel-close" onClick={() => setShowPlans(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-plans-title">🗺️ Planes estratégicos</div>
                <div className="zeus-plans-filter">
                  {['all', 'weekly', 'monthly', 'quarterly'].map(h => (
                    <button
                      key={h}
                      onClick={() => setPlansHorizon(h)}
                      className={`zeus-plans-filter-btn ${plansHorizon === h ? 'active' : ''}`}
                    >
                      {h === 'all' ? 'todos' : h}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {['weekly', 'monthly', 'quarterly'].map(h => (
                    <button
                      key={h}
                      onClick={() => regeneratePlan(h)}
                      className="zeus-plans-regen-btn"
                      title={`Regenerar plan ${h}`}
                    >
                      ↻ {h}
                    </button>
                  ))}
                </div>
              </div>
              {plans.length === 0 ? (
                <div className="zeus-plans-empty">No hay planes para este filtro. Los crons los generan los lunes (weekly), día 1 de mes (monthly), y día 1 de Q (quarterly). También podés regenerar a mano con los botones ↻.</div>
              ) : (
                plans.map(p => (
                  <PlanCard
                    key={p._id}
                    plan={p}
                    onApprove={() => approvePlan(p._id)}
                    onDelete={() => deletePlan(p._id)}
                  />
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel calendario estacional */}
        <AnimatePresence>
          {showCalendar && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-calendar-panel"
            >
              <div className="zeus-calendar-header">
                <button className="zeus-panel-close" onClick={() => setShowCalendar(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-calendar-title">📅 Calendario estacional</div>
                <div className="zeus-calendar-sub">Zeus sabe lo que viene (awareness). No activa directivas automáticas — vos decidís cuándo arrancar.</div>
              </div>

              {calendarUpcoming.length === 0 ? (
                <div className="zeus-calendar-empty">No hay eventos activados en los próximos 120 días. Activá abajo los que quieras que Zeus monitoree.</div>
              ) : (
                <div className="zeus-calendar-timeline">
                  {calendarUpcoming.map((ev, i) => (
                    <CalendarEventCard key={i} event={ev} />
                  ))}
                </div>
              )}

              <div className="zeus-calendar-all-title">Todos los eventos en el catálogo</div>
              <div className="zeus-calendar-all-grid">
                {calendarAll.map(ev => (
                  <button
                    key={ev._id}
                    className={`zeus-calendar-toggle ${ev.activated ? 'activated' : ''} priority-${ev.priority}`}
                    onClick={() => toggleCalendarEvent(ev._id)}
                    title={ev.activated ? 'Desactivar' : 'Activar'}
                  >
                    <span className="zeus-cal-name">{ev.name}</span>
                    <span className="zeus-cal-state">{ev.activated ? '● activo' : '○ off'}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel arquitectura (Lens 3) */}
        <AnimatePresence>
          {showArchitecture && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-architecture-panel"
            >
              <div className="zeus-architecture-header">
                <button className="zeus-panel-close" onClick={() => setShowArchitecture(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-architecture-title">🏛️ Propuestas arquitectónicas</div>
                <div className="zeus-architecture-sub">Bottlenecks estructurales — Zeus propone opciones, vos decidís.</div>
                <div className="zeus-architecture-filter">
                  {['draft', 'accepted', 'rejected', 'built', 'all'].map(f => (
                    <button
                      key={f}
                      onClick={() => setArchFilter(f)}
                      className={`zeus-architecture-filter-btn ${archFilter === f ? 'active' : ''}`}
                    >
                      {f === 'all' ? 'todas' : f}
                      {archCounts[f] > 0 && f !== 'all' && ` · ${archCounts[f]}`}
                    </button>
                  ))}
                </div>
                <button
                  onClick={generateArchProposal}
                  className="zeus-architecture-gen-btn"
                  title="Disparar reflexión arquitectónica manual (toma ~30s)"
                >
                  ↻ Generar ahora
                </button>
              </div>

              {archProposals.length === 0 ? (
                <div className="zeus-architecture-empty">
                  {archFilter === 'draft'
                    ? 'No hay propuestas pendientes. Zeus las genera los domingos 11:30am — o dispará una manual con ↻.'
                    : `No hay propuestas con estado ${archFilter}.`}
                </div>
              ) : (
                archProposals.map(p => (
                  <ArchitectureCard
                    key={p._id}
                    proposal={p}
                    onDecide={(decision, note) => decideArchProposal(p._id, decision, note)}
                    onMarkBuilt={() => markArchBuilt(p._id)}
                  />
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel Stances — postura operativa del día de cada agente */}
        <AnimatePresence>
          {showStances && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-stances-panel"
            >
              <div className="zeus-stances-header">
                <button className="zeus-panel-close" onClick={() => setShowStances(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-stances-title">🎯 Stances del día</div>
                <div className="zeus-stances-sub">La postura operativa de cada agente. Morning briefing 7am ET. Podés overridear si ves algo que el agente no ve.</div>
              </div>
              {Object.keys(stancesCurrent).length === 0 ? (
                <div className="zeus-stances-empty">Aún no hay stances registrados. El primer briefing matutino corre mañana 7am ET, o dispará manual abajo.</div>
              ) : (
                Object.entries(stancesCurrent).map(([agent, stance]) => (
                  <StanceCard
                    key={agent}
                    agent={agent}
                    stance={stance}
                    history={stancesHistory[agent] || []}
                    onOverride={() => overrideStance(agent)}
                    onRenew={() => stance && renewStanceUI(stance._id)}
                    onBriefNow={() => triggerBriefing(agent)}
                  />
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel Calibración — Hilo B (references / anti-refs / trampas / auditorías) */}
        <AnimatePresence>
          {showCalibration && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-calib-panel"
            >
              <div className="zeus-calib-header">
                <button className="zeus-panel-close" onClick={() => setShowCalibration(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-calib-title">📓 Calibración de respuesta</div>
                <div className="zeus-calib-sub">Archive de golden / anti-refs + trampas + auditoría trimestral. Detecta drift empíricamente.</div>
                <div className="zeus-calib-tabs">
                  <button
                    className={`zeus-calib-tab ${calibTab === 'anti_refs' ? 'active' : ''}`}
                    onClick={() => setCalibTab('anti_refs')}
                  >Anti-refs {calibCounts.anti_reference_response ? `(${calibCounts.anti_reference_response})` : ''}</button>
                  <button
                    className={`zeus-calib-tab ${calibTab === 'references' ? 'active' : ''}`}
                    onClick={() => setCalibTab('references')}
                  >References {calibCounts.reference_response ? `(${calibCounts.reference_response})` : ''}</button>
                  <button
                    className={`zeus-calib-tab ${calibTab === 'traps' ? 'active' : ''}`}
                    onClick={() => setCalibTab('traps')}
                  >Trampas {calibTrapCounts.passed || calibTrapCounts.failed ? `(${(calibTrapCounts.passed || 0)}✓/${(calibTrapCounts.failed || 0)}✗)` : ''}</button>
                  <button
                    className={`zeus-calib-tab ${calibTab === 'audits' ? 'active' : ''}`}
                    onClick={() => setCalibTab('audits')}
                  >Auditorías {calibCounts.audit_report ? `(${calibCounts.audit_report})` : ''}</button>
                </div>
              </div>

              {calibTab === 'anti_refs' && (
                <>
                  {calibEntries.length === 0 ? (
                    <div className="zeus-calib-empty">Sin anti-refs acumuladas. El auditor post-hoc se dispara después de cada respuesta a juicio del creador.</div>
                  ) : (
                    calibEntries.map(e => (
                      <AntiRefCard key={e._id} entry={e} onPromote={(mark) => promoteEntry(e._id, mark)} />
                    ))
                  )}
                </>
              )}

              {calibTab === 'references' && (
                <>
                  {calibEntries.length === 0 ? (
                    <div className="zeus-calib-empty">Sin golden references todavía. Marcá una respuesta notable de Zeus como reference desde los anti-refs u otras entries.</div>
                  ) : (
                    calibEntries.map(e => (
                      <RefCard key={e._id} entry={e} />
                    ))
                  )}
                </>
              )}

              {calibTab === 'traps' && (
                <>
                  <div className="zeus-calib-toolbar">
                    <button className="zeus-calib-btn" onClick={createTrap}>+ plantar trampa</button>
                    {(calibTrapCounts.passed != null || calibTrapCounts.failed != null) && (
                      <span className="zeus-calib-stats">90d: {calibTrapCounts.passed || 0} passed · {calibTrapCounts.failed || 0} failed</span>
                    )}
                  </div>
                  {calibTraps.length === 0 ? (
                    <div className="zeus-calib-empty">Sin trampas registradas. Plantá una para falsificar el principio "resistí validar por default".</div>
                  ) : (
                    calibTraps.map(t => (
                      <TrapCard key={t._id} trap={t} onExecute={() => executeTrap(t._id)} onDelete={() => deleteTrap(t._id)} />
                    ))
                  )}
                </>
              )}

              {calibTab === 'audits' && (
                <>
                  <div className="zeus-calib-toolbar">
                    <button className="zeus-calib-btn" onClick={runManualAudit}>↻ correr auditoría ahora</button>
                    <span className="zeus-calib-stats">cron automático: 9am ET, 1ro de feb/may/ago/nov</span>
                  </div>
                  {calibEntries.length === 0 ? (
                    <div className="zeus-calib-empty">Sin auditorías todavía. La próxima ejecuta naturalmente al inicio del trimestre, o dispará manual arriba.</div>
                  ) : (
                    calibEntries.map(e => (
                      <AuditCard key={e._id} entry={e} />
                    ))
                  )}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Panel Auto-Pause — Hilo C (palanca ejecutiva bounded) */}
        <AnimatePresence>
          {showAutoPause && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="zeus-ap-panel"
            >
              <div className="zeus-ap-header">
                <button className="zeus-panel-close" onClick={() => setShowAutoPause(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-ap-title">🎚️ Auto-Pause — palanca bounded</div>
                <div className="zeus-ap-sub">Pausa automática de adsets con ROAS_3d &lt;0.3 + spend ≥$150 + 0-1 compras. Criterio matemático auditable, no L5.</div>
              </div>

              {/* Status Bar */}
              {apStatus && (
                <div className="zeus-ap-status-bar">
                  <div className="zeus-ap-status-row">
                    <div className="zeus-ap-mode-group">
                      <span className="zeus-ap-label">modo:</span>
                      <button
                        className={`zeus-ap-mode-btn ${apStatus.mode === 'disabled' ? 'active mode-disabled' : ''}`}
                        onClick={() => changeApMode('disabled')}
                      >disabled</button>
                      <button
                        className={`zeus-ap-mode-btn ${apStatus.mode === 'shadow' ? 'active mode-shadow' : ''}`}
                        onClick={() => changeApMode('shadow')}
                      >shadow</button>
                      <button
                        className={`zeus-ap-mode-btn ${apStatus.mode === 'live' ? 'active mode-live' : ''}`}
                        onClick={() => changeApMode('live')}
                      >live</button>
                    </div>

                    <span className="zeus-ap-stat">
                      hoy: <b>{apStatus.today_count}/{apStatus.daily_cap}</b>
                    </span>

                    {apStatus.fp_stats?.ready ? (
                      <span className={`zeus-ap-stat fp-rate ${apStatus.fp_stats.fp_rate > 0.2 ? 'red' : apStatus.fp_stats.fp_rate > 0.15 ? 'amber' : 'green'}`}>
                        FP rate: <b>{(apStatus.fp_stats.fp_rate * 100).toFixed(1)}%</b> (n={apStatus.fp_stats.count})
                      </span>
                    ) : (
                      <span className="zeus-ap-stat muted">
                        FP rate: pending ({apStatus.fp_stats?.count || 0}/20)
                      </span>
                    )}

                    <span className="zeus-ap-spacer" />

                    <button className="zeus-ap-btn subtle" onClick={runApHealthCheck} title="Correr health check ahora">
                      ↻ health check
                    </button>
                  </div>

                  {apStatus.yellow_zone_active && (
                    <div className="zeus-ap-yellow-banner">
                      <span className="zeus-ap-yellow-icon">⚠️</span>
                      <div className="zeus-ap-yellow-text">
                        <b>Zone AMARILLA — nuevas pauses BLOQUEADAS.</b>
                        <br />FP rate cruzó threshold (&gt;15%). El detector sigue corriendo pero NO ejecuta pauses hasta tu decisión.
                        Revisá los casos, decidí tighten de thresholds o disable, y después clear manualmente.
                      </div>
                      <button className="zeus-ap-btn" onClick={clearApYellowZone}>clear yellow</button>
                    </div>
                  )}

                  <div className="zeus-ap-counts">
                    <span>shadow total: <b>{apStatus.shadow.total}</b> ({Object.entries(apStatus.shadow.by_verdict).map(([v, c]) => `${v}:${c}`).join(' · ') || 'ninguno'})</span>
                    <span>·</span>
                    <span>live total: <b>{apStatus.live.total}</b> ({Object.entries(apStatus.live.by_verdict).map(([v, c]) => `${v}:${c}`).join(' · ') || 'ninguno'})</span>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="zeus-ap-tabs">
                <button
                  className={`zeus-ap-tab ${apTab === 'live' ? 'active' : ''}`}
                  onClick={() => setApTab('live')}
                >Live logs {apStatus ? `(${apStatus.live.total})` : ''}</button>
                <button
                  className={`zeus-ap-tab ${apTab === 'shadow' ? 'active' : ''}`}
                  onClick={() => setApTab('shadow')}
                >Shadow logs {apStatus ? `(${apStatus.shadow.total})` : ''}</button>
              </div>

              {/* Log cards */}
              {apLogs.length === 0 ? (
                <div className="zeus-ap-empty">
                  {apTab === 'shadow'
                    ? 'Sin shadow logs todavía. El detector crea candidatos cuando está en modo shadow o live.'
                    : 'Sin live logs todavía. Las pausas reales aparecen acá cuando el modo es live + criterio dispara.'}
                </div>
              ) : (
                apLogs.map(log => (
                  apTab === 'shadow'
                    ? <ShadowLogCard key={log._id} log={log} />
                    : <LiveLogCard key={log._id} log={log} onReactivate={() => reactivateApLog(log._id)} />
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

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
                <button className="zeus-panel-close" onClick={() => setShowMemory(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-memory-title">💭 Lo que Zeus sabe de vos</div>
                <div className="zeus-memory-sub">Zeus observa patrones en tu forma de operar y propone preferencias. Vos aprobás las que te cierren. Las activas se inyectan en cada respuesta.</div>
                <button
                  onClick={triggerPreferenceDetector}
                  className="zeus-memory-detect-btn"
                  title="Disparar detector manual — analiza los últimos 30d de interacciones"
                >
                  ↻ Detectar ahora
                </button>
              </div>

              {/* Drafts propuestos por Zeus, esperando tu decisión */}
              {preferences.filter(p => p.status === 'proposed').length > 0 && (
                <div className="zeus-memory-drafts-section">
                  <div className="zeus-memory-section-title">✨ Zeus propone (esperando tu confirmación)</div>
                  {preferences.filter(p => p.status === 'proposed').map(p => (
                    <div key={p._id} className="zeus-memory-draft">
                      <div className="zeus-memory-item-head">
                        <span className="zeus-memory-cat">{p.category}</span>
                        <span className="zeus-memory-key">{p.key}</span>
                        <span className="zeus-memory-conf">conf {Math.round((p.confidence || 0) * 100)}%</span>
                      </div>
                      <div className="zeus-memory-value">{p.value}</div>
                      {p.evidence?.summary && (
                        <div className="zeus-memory-evidence">
                          <span className="zeus-memory-evidence-label">Evidencia:</span> {p.evidence.summary}
                        </div>
                      )}
                      {p.evidence?.datapoints?.length > 0 && (
                        <ul className="zeus-memory-datapoints">
                          {p.evidence.datapoints.slice(0, 3).map((d, i) => <li key={i}>{d}</li>)}
                        </ul>
                      )}
                      <div className="zeus-memory-draft-actions">
                        <button className="zeus-memory-reject" onClick={() => decidePreference(p._id, 'reject')}>
                          Rechazar
                        </button>
                        <button className="zeus-memory-accept" onClick={() => decidePreference(p._id, 'accept')}>
                          Aceptar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Preferencias activas */}
              {preferences.filter(p => p.status === 'active').length > 0 && (
                <div className="zeus-memory-section">
                  <div className="zeus-memory-section-title">● Activas</div>
                  {preferences.filter(p => p.status === 'active').map(p => (
                    <div key={p._id} className={`zeus-memory-item ${!p.active ? 'inactive' : ''}`}>
                      <div className="zeus-memory-item-head">
                        <span className="zeus-memory-cat">{p.category}</span>
                        <span className="zeus-memory-key">{p.key}</span>
                        {p.source === 'auto_detected' && (
                          <span className="zeus-memory-source-badge" title="Detectada por Zeus, confirmada por vos">auto</span>
                        )}
                        <span className="zeus-memory-spacer" />
                        <button className="zeus-memory-toggle" onClick={() => togglePreferenceActive(p._id, !p.active)} title={p.active ? 'Desactivar' : 'Reactivar'}>
                          {p.active ? '●' : '○'}
                        </button>
                        <button className="zeus-memory-del" onClick={() => deletePreference(p._id)} title="Borrar">×</button>
                      </div>
                      <div className="zeus-memory-value">{p.value}</div>
                      {p.context && <div className="zeus-memory-context">{p.context}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* Rejected — histórico colapsado */}
              {preferences.filter(p => p.status === 'rejected').length > 0 && (
                <details className="zeus-memory-rejected-section">
                  <summary className="zeus-memory-section-title">Rechazadas · {preferences.filter(p => p.status === 'rejected').length}</summary>
                  {preferences.filter(p => p.status === 'rejected').map(p => (
                    <div key={p._id} className="zeus-memory-item inactive">
                      <div className="zeus-memory-item-head">
                        <span className="zeus-memory-cat">{p.category}</span>
                        <span className="zeus-memory-key">{p.key}</span>
                        <span className="zeus-memory-spacer" />
                        <button className="zeus-memory-del" onClick={() => deletePreference(p._id)} title="Borrar del todo">×</button>
                      </div>
                      <div className="zeus-memory-value">{p.value}</div>
                    </div>
                  ))}
                </details>
              )}

              {preferences.length === 0 && (
                <div className="zeus-memory-empty">
                  Zeus aún no detectó patrones. Semanalmente (domingo 12pm) analiza tus interacciones y propone preferencias — también podés decirle directamente "priorizá X sobre Y", o disparar el detector manual con el botón ↻.
                </div>
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
                <button className="zeus-panel-close" onClick={() => setShowCodeRecs(false)} aria-label="Cerrar panel">×</button>
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
              <div className="zeus-conversations-header">
                <button className="zeus-panel-close" onClick={() => setShowConversationList(false)} aria-label="Cerrar panel">×</button>
                <div className="zeus-conversations-title">📁 Conversaciones previas</div>
              </div>
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
                  onOpenAdset={setActiveAdsetId}
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
                        <ZeusMarkdown onEntityClick={(kind, id) => {
                          if (kind === 'adset' && id) { setActiveAdsetId(id); return true; }
                          return false;
                        }}>{stripFollowupsBlock(streamingText)}</ZeusMarkdown>
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

      {/* Modal overlay — drill-in de adset clickeado en el chat */}
      {activeAdsetId && createPortal(
        <AdSetDetailModal adsetId={activeAdsetId} onClose={() => setActiveAdsetId(null)} />,
        document.body
      )}
    </>
  );
}

function ZeusPalette({ onClose, onSelect, codeRecsPending, archDrafts, prefDrafts }) {
  const items = [
    {
      group: 'Lo que Zeus usa para pensar',
      entries: [
        { key: 'memory', emoji: '💭', label: 'Memoria', desc: 'Preferencias persistentes', badge: prefDrafts },
        { key: 'calendar', emoji: '📅', label: 'Calendario', desc: 'Eventos estacionales' },
        { key: 'conversations', emoji: '📁', label: 'Conversaciones', desc: 'Historial de chats' }
      ]
    },
    {
      group: 'Lo que Zeus produce',
      entries: [
        { key: 'plans', emoji: '🗺️', label: 'Planes', desc: 'Weekly / Monthly / Quarterly' },
        { key: 'coderecs', emoji: '💡', label: 'Code Recs', desc: 'Sugerencias de cambios', badge: codeRecsPending },
        { key: 'architecture', emoji: '🏛️', label: 'Arquitectura', desc: 'Propuestas estructurales', badge: archDrafts }
      ]
    },
    {
      group: 'Estado mental del equipo',
      entries: [
        { key: 'stances', emoji: '🎯', label: 'Stances', desc: 'Postura del día de cada agente' },
        { key: 'calibration', emoji: '📓', label: 'Calibración', desc: 'Golden / anti-refs / trampas / auditorías' }
      ]
    },
    {
      group: 'Palancas ejecutivas bounded',
      entries: [
        { key: 'autopause', emoji: '🎚️', label: 'Auto-Pause', desc: 'Pausa automática de drains con criterio duro' }
      ]
    }
  ];

  return (
    <>
      <div className="zeus-palette-backdrop" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.12 }}
        className="zeus-palette"
      >
        {items.map(g => (
          <div key={g.group} className="zeus-palette-group">
            <div className="zeus-palette-group-title">{g.group}</div>
            <div className="zeus-palette-grid">
              {g.entries.map(e => (
                <button
                  key={e.key}
                  className="zeus-palette-item"
                  onClick={() => onSelect(e.key)}
                >
                  <span className="zeus-palette-emoji">{e.emoji}</span>
                  <div className="zeus-palette-item-body">
                    <div className="zeus-palette-item-label">
                      {e.label}
                      {e.badge > 0 && (
                        <span className="zeus-palette-badge">
                          {e.badge > 9 ? '9+' : e.badge}
                        </span>
                      )}
                    </div>
                    <div className="zeus-palette-item-desc">{e.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </motion.div>
    </>
  );
}

function ArchitectureCard({ proposal, onDecide, onMarkBuilt }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(proposal.recommended || '');
  const [note, setNote] = useState('');

  const isDraft = proposal.status === 'draft';
  const isAccepted = proposal.status === 'accepted';

  return (
    <div className={`zeus-arch-card severity-${proposal.severity} status-${proposal.status}`}>
      <div className="zeus-arch-head" onClick={() => setExpanded(!expanded)}>
        <div className="zeus-arch-title-row">
          <span className={`zeus-arch-severity-dot severity-${proposal.severity}`} />
          <span className="zeus-arch-title">{proposal.bottleneck?.title || 'Sin título'}</span>
        </div>
        <div className="zeus-arch-meta">
          <span className={`zeus-arch-status-badge status-${proposal.status}`}>{proposal.status}</span>
          <span className="zeus-arch-trigger">{proposal.triggered_by}</span>
          <span className="zeus-arch-expand">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="zeus-arch-body">
          <div className="zeus-arch-desc">{proposal.bottleneck?.description}</div>
          {proposal.bottleneck?.evidence_summary && (
            <div className="zeus-arch-evidence">
              <span className="zeus-arch-label">Evidencia:</span> {proposal.bottleneck.evidence_summary}
            </div>
          )}

          <div className="zeus-arch-options">
            {(proposal.options || []).map(opt => (
              <label
                key={opt.label}
                className={`zeus-arch-option ${selected === opt.label ? 'selected' : ''} ${proposal.recommended === opt.label ? 'recommended' : ''}`}
              >
                <div className="zeus-arch-option-head">
                  <input
                    type="radio"
                    name={`arch-${proposal._id}`}
                    value={opt.label}
                    checked={selected === opt.label}
                    onChange={() => setSelected(opt.label)}
                    disabled={!isDraft}
                  />
                  <span className="zeus-arch-option-label">{opt.label}</span>
                  <span className="zeus-arch-option-approach">{opt.approach}</span>
                  {proposal.recommended === opt.label && (
                    <span className="zeus-arch-rec-badge">recomendada</span>
                  )}
                </div>
                {opt.description && <div className="zeus-arch-option-desc">{opt.description}</div>}
                <div className="zeus-arch-tradeoffs">
                  <span>cost: <b className={`val-${opt.cost}`}>{opt.cost}</b></span>
                  <span>risk: <b className={`val-${opt.risk}`}>{opt.risk}</b></span>
                  <span>EV: <b className={`val-${opt.expected_value}`}>{opt.expected_value}</b></span>
                  {opt.effort_days != null && <span>effort: <b>{opt.effort_days}d</b></span>}
                </div>
                {opt.notes && <div className="zeus-arch-option-notes">{opt.notes}</div>}
              </label>
            ))}
          </div>

          {proposal.reasoning && (
            <div className="zeus-arch-reasoning">
              <span className="zeus-arch-label">Recomendación de Zeus:</span> {proposal.reasoning}
            </div>
          )}

          {proposal.devils_critique?.attacks?.length > 0 && (
            <div className={`zeus-arch-devils verdict-${proposal.devils_critique.overall_verdict}`}>
              <div className="zeus-arch-devils-head">
                <span className="zeus-arch-devils-icon">😈</span>
                <span className="zeus-arch-devils-title">Devil's Advocate</span>
                <span className={`zeus-arch-devils-verdict verdict-${proposal.devils_critique.overall_verdict}`}>
                  {(proposal.devils_critique.overall_verdict || '').replace(/_/g, ' ')}
                </span>
              </div>
              {proposal.devils_critique.summary && (
                <div className="zeus-arch-devils-summary">{proposal.devils_critique.summary}</div>
              )}
              <ul className="zeus-arch-devils-attacks">
                {proposal.devils_critique.attacks.map((a, i) => (
                  <li key={i} className={`zeus-arch-devils-attack severity-${a.severity}`}>
                    <span className={`zeus-arch-devils-kind severity-${a.severity}`}>{a.kind?.replace(/_/g, ' ')}</span>
                    <span className="zeus-arch-devils-text">{a.attack}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isDraft && (
            <div className="zeus-arch-decide">
              <input
                type="text"
                placeholder="Nota opcional sobre la decisión..."
                value={note}
                onChange={e => setNote(e.target.value)}
                className="zeus-arch-note-input"
              />
              <div className="zeus-arch-decide-btns">
                <button
                  onClick={() => selected && onDecide(selected, note)}
                  disabled={!selected}
                  className="zeus-arch-accept-btn"
                >
                  Aceptar opción {selected || '...'}
                </button>
                <button
                  onClick={() => onDecide('no-op', note)}
                  className="zeus-arch-noop-btn"
                >
                  No-op (re-evaluar después)
                </button>
              </div>
            </div>
          )}

          {isAccepted && !proposal.built_at && (
            <div className="zeus-arch-built-cta">
              <div className="zeus-arch-built-note">
                Decisión registrada: <b>{proposal.creator_decision}</b>
                {proposal.creator_note && <> — {proposal.creator_note}</>}
              </div>
              <button onClick={onMarkBuilt} className="zeus-arch-built-btn">
                ✓ Marcar como construida
              </button>
            </div>
          )}

          {proposal.built_at && (
            <>
              <div className="zeus-arch-built-done">
                ✓ Construida {new Date(proposal.built_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })}
              </div>
              {proposal.build_verification?.status && (
                <div className={`zeus-arch-verify verdict-${proposal.build_verification.status}`}>
                  <span className="zeus-arch-verify-icon">
                    {proposal.build_verification.status === 'verified' ? '✓' :
                     proposal.build_verification.status === 'partial' ? '◐' : '⚠'}
                  </span>
                  <div className="zeus-arch-verify-body">
                    <div className="zeus-arch-verify-verdict">
                      Build verification: <b>{proposal.build_verification.status}</b>
                    </div>
                    {proposal.build_verification.notes && (
                      <div className="zeus-arch-verify-notes">{proposal.build_verification.notes}</div>
                    )}
                    {proposal.build_verification.files_found?.length > 0 && (
                      <div className="zeus-arch-verify-files">
                        <span className="zeus-arch-label">Evidencia:</span>{' '}
                        {proposal.build_verification.files_found.slice(0, 3).map((f, i) => (
                          <code key={i} className="zeus-arch-verify-file">{f}</code>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CalendarEventCard({ event }) {
  const phaseLabel = {
    peak: 'PEAK NOW',
    anticipation: 'anticipación',
    future: 'futuro',
    cool_down: 'cool-down'
  }[event.phase] || event.phase;

  const prettyDate = (() => {
    try {
      const d = new Date(event.date + 'T00:00:00Z');
      return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return event.date; }
  })();

  const daysLabel = event.days_away === 0
    ? 'HOY'
    : event.days_away < 0
    ? `hace ${Math.abs(event.days_away)}d`
    : `en ${event.days_away}d`;

  return (
    <div className={`zeus-cal-event priority-${event.priority} phase-${event.phase}`}>
      <div className="zeus-cal-event-head">
        <span className="zeus-cal-event-name">{event.name}</span>
        <span className={`zeus-cal-event-days ${event.days_away <= 7 && event.days_away >= -1 ? 'imminent' : ''}`}>{daysLabel}</span>
      </div>
      <div className="zeus-cal-event-meta">
        <span className="zeus-cal-event-date">{prettyDate}</span>
        <span className="zeus-cal-event-sep">·</span>
        <span className={`zeus-cal-event-phase phase-${event.phase}`}>{phaseLabel}</span>
        <span className="zeus-cal-event-sep">·</span>
        <span className={`zeus-cal-event-priority priority-${event.priority}`}>{event.priority}</span>
      </div>
      {event.messaging_theme && (
        <div className="zeus-cal-event-theme">{event.messaging_theme}</div>
      )}
      {event.description && (
        <div className="zeus-cal-event-desc">{event.description}</div>
      )}
    </div>
  );
}

function PlanCard({ plan, onApprove, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [evaluating, setEvaluating] = useState(false);

  const fmtDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  async function triggerEvaluate() {
    setEvaluating(true);
    try {
      await api.post(`/api/zeus/strategic-plans/${plan._id}/evaluate`);
      window.location.reload();
    } catch (err) { alert('Error: ' + err.message); }
    finally { setEvaluating(false); }
  }

  async function markMilestone(index, status) {
    try {
      await api.post(`/api/zeus/strategic-plans/${plan._id}/milestones/${index}/mark`, { status });
      window.location.reload();
    } catch (err) { alert('Error: ' + err.message); }
  }

  const goalStatusColors = {
    achieved: '#10b981',
    on_track: '#3b82f6',
    behind: '#fbbf24',
    off_track: '#f97316',
    missed: '#ef4444',
    unknown: '#6b7280'
  };
  const healthStatusColors = {
    on_track: '#10b981',
    behind: '#fbbf24',
    off_track: '#f97316',
    at_risk: '#ef4444'
  };

  const horizonColors = {
    weekly: '#60a5fa',
    monthly: '#a78bfa',
    quarterly: '#f472b6'
  };
  const statusBadge = {
    draft: { c: '#fbbf24', l: 'DRAFT' },
    active: { c: '#10b981', l: 'ACTIVE' },
    superseded: { c: '#6b7280', l: 'SUPERSEDED' },
    archived: { c: '#6b7280', l: 'ARCHIVED' }
  }[plan.status] || { c: '#6b7280', l: plan.status };

  const priorityColors = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#fbbf24',
    low: '#60a5fa'
  };

  const riskColors = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#fbbf24',
    low: '#60a5fa'
  };

  return (
    <div className="zeus-plan-card" style={{ borderLeftColor: horizonColors[plan.horizon] || '#60a5fa' }}>
      <div className="zeus-plan-head">
        <span className="zeus-plan-horizon" style={{ color: horizonColors[plan.horizon] }}>
          {plan.horizon.toUpperCase()}
        </span>
        <span className="zeus-plan-status" style={{ color: statusBadge.c, borderColor: statusBadge.c + '40' }}>
          {statusBadge.l}
        </span>
        <span className="zeus-plan-period">
          {fmtDate(plan.period_start)} → {fmtDate(plan.period_end)}
        </span>
        <span className="zeus-plan-spacer" />
        <button className="zeus-plan-iconbtn" onClick={onDelete} title="Borrar">×</button>
      </div>

      {plan.north_star?.metric && (
        <div className="zeus-plan-section">
          <span className="zeus-plan-section-label">⭐ North Star:</span>
          <span className="zeus-plan-ns">
            {plan.north_star.metric}
            {plan.north_star.target != null && ` → ${plan.north_star.target}`}
            {plan.north_star.direction && ` (${plan.north_star.direction})`}
          </span>
        </div>
      )}

      {plan.summary && (
        <div className="zeus-plan-summary">{plan.summary}</div>
      )}

      {/* Health score + evaluate button */}
      {plan.last_evaluation && (
        <div className="zeus-plan-health">
          <div className="zeus-plan-health-label">Health</div>
          <div className="zeus-plan-health-bar-wrap">
            <div
              className="zeus-plan-health-bar"
              style={{
                width: `${plan.last_evaluation.health_score || 0}%`,
                background: healthStatusColors[plan.last_evaluation.health_status] || '#6b7280'
              }}
            />
          </div>
          <div className="zeus-plan-health-score" style={{ color: healthStatusColors[plan.last_evaluation.health_status] }}>
            {plan.last_evaluation.health_score}/100
          </div>
          <div className="zeus-plan-health-status" style={{ color: healthStatusColors[plan.last_evaluation.health_status] }}>
            {plan.last_evaluation.health_status?.replace('_', ' ')}
          </div>
        </div>
      )}

      {plan.status === 'active' && (
        <button className="zeus-plan-eval-btn" onClick={triggerEvaluate} disabled={evaluating}>
          {evaluating ? '...' : '↻ Evaluar ahora'}
        </button>
      )}

      <button className="zeus-plan-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? '▾ Ocultar detalle' : '▸ Ver detalle completo'}
      </button>

      {expanded && (
        <div className="zeus-plan-detail">
          {plan.code_readiness?.entries?.length > 0 && (
            <div className="zeus-plan-readiness">
              <div className="zeus-plan-readiness-title">
                🔍 Code readiness — {plan.code_readiness.summary || `${plan.code_readiness.entries.filter(e => e.capable).length}/${plan.code_readiness.entries.length} goals listos`}
              </div>
              {plan.code_readiness.entries.map((e, i) => (
                <div key={i} className={`zeus-plan-readiness-entry ${e.capable ? 'capable' : 'gap'}`}>
                  <span className="zeus-plan-readiness-icon">{e.capable ? '✓' : '⚠'}</span>
                  <div className="zeus-plan-readiness-body">
                    <div className="zeus-plan-readiness-goal">
                      <code>{e.goal_metric}</code>
                      {e.agent && <span className="zeus-plan-readiness-agent"> · {e.agent}</span>}
                    </div>
                    {e.file && <div className="zeus-plan-readiness-file">{e.file}</div>}
                    {!e.capable && e.gap_description && (
                      <div className="zeus-plan-readiness-gap">{e.gap_description}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {plan.narrative && (
            <div className="zeus-plan-narrative zeus-markdown">
              <ZeusMarkdown>{plan.narrative}</ZeusMarkdown>
            </div>
          )}

          {(plan.goals || []).length > 0 && (
            <div className="zeus-plan-block">
              <div className="zeus-plan-block-title">🎯 Goals</div>
              {plan.goals.map((g, i) => {
                const progress = Math.min(100, Math.max(0, g.progress_pct ?? 0));
                const trajectory = Math.min(100, Math.max(0, g.trajectory_pct ?? 0));
                const statusColor = goalStatusColors[g.status] || '#6b7280';
                return (
                  <div key={i} className="zeus-plan-goal">
                    <span className="zeus-plan-priority-dot" style={{ background: priorityColors[g.priority] }} />
                    <div style={{ flex: 1 }}>
                      <div className="zeus-plan-goal-main">
                        <code>{g.metric}</code>
                        <span style={{ color: 'var(--bos-text-muted)', marginLeft: 6 }}>
                          {g.current != null ? g.current.toLocaleString() : '?'} →
                        </span>
                        <span style={{ color: '#93c5fd', fontWeight: 600, marginLeft: 4 }}>
                          {g.target?.toLocaleString()}
                        </span>
                        {g.status && g.status !== 'unknown' && (
                          <span className="zeus-plan-goal-status" style={{ color: statusColor, borderColor: statusColor + '40' }}>
                            {g.status.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                      {/* Dual progress bar — progreso real vs trayectoria esperada */}
                      {g.target != null && (
                        <div className="zeus-plan-progress-wrap">
                          <div className="zeus-plan-progress-track">
                            {/* Trajectory marker (expected by now) */}
                            {trajectory > 0 && trajectory < 100 && (
                              <div
                                className="zeus-plan-progress-expected"
                                style={{ left: `${trajectory}%` }}
                                title={`Trayectoria esperada: ${trajectory.toFixed(0)}%`}
                              />
                            )}
                            <div
                              className="zeus-plan-progress-bar"
                              style={{ width: `${progress}%`, background: statusColor }}
                            />
                          </div>
                          <span className="zeus-plan-progress-label">{progress.toFixed(0)}%</span>
                        </div>
                      )}
                      <div className="zeus-plan-goal-date">by {fmtDate(g.by_date)} · {g.priority}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(plan.milestones || []).length > 0 && (
            <div className="zeus-plan-block">
              <div className="zeus-plan-block-title">🏁 Milestones</div>
              {plan.milestones.map((m, i) => {
                const dueDate = m.by_date ? new Date(m.by_date) : null;
                const isOverdue = dueDate && dueDate < new Date() && m.status === 'pending';
                return (
                  <div key={i} className={`zeus-plan-milestone ${isOverdue ? 'overdue' : ''}`}>
                    <span className={`zeus-plan-ms-status ${m.status}`}>
                      {m.status === 'achieved' ? '✓' : m.status === 'missed' ? '✗' : '○'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div>{m.description}</div>
                      <div className="zeus-plan-goal-date">by {fmtDate(m.by_date)}{isOverdue ? ' · OVERDUE' : ''}</div>
                    </div>
                    {plan.status === 'active' && m.status === 'pending' && (
                      <div className="zeus-plan-ms-actions">
                        <button
                          className="zeus-plan-ms-btn achieved"
                          onClick={() => markMilestone(i, 'achieved')}
                          title="Marcar achieved"
                        >✓</button>
                        <button
                          className="zeus-plan-ms-btn missed"
                          onClick={() => markMilestone(i, 'missed')}
                          title="Marcar missed"
                        >✗</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(plan.risks || []).length > 0 && (
            <div className="zeus-plan-block">
              <div className="zeus-plan-block-title">⚠️ Risks</div>
              {plan.risks.map((r, i) => (
                <div key={i} className="zeus-plan-risk" style={{ borderLeftColor: riskColors[r.impact] }}>
                  <div className="zeus-plan-risk-head">
                    <span style={{ fontSize: '0.55rem', padding: '1px 5px', background: riskColors[r.likelihood] + '20', color: riskColors[r.likelihood], borderRadius: 3 }}>
                      {r.likelihood} prob
                    </span>
                    <span style={{ fontSize: '0.55rem', padding: '1px 5px', background: riskColors[r.impact] + '20', color: riskColors[r.impact], borderRadius: 3 }}>
                      {r.impact} impact
                    </span>
                  </div>
                  <div className="zeus-plan-risk-desc">{r.description}</div>
                  {r.mitigation && (
                    <div className="zeus-plan-risk-mit">→ {r.mitigation}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {plan.status === 'draft' && (
        <div className="zeus-plan-actions">
          <button className="zeus-plan-btn zeus-plan-btn-approve" onClick={onApprove}>
            ✓ Aprobar plan
          </button>
        </div>
      )}
      {plan.approved_at && (
        <div className="zeus-plan-meta">
          Aprobado {fmtDate(plan.approved_at)}
          {plan.creator_adjustments && ` · ${plan.creator_adjustments.substring(0, 80)}`}
        </div>
      )}
    </div>
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
      {rec.status === 'applied' && rec.verification?.syntactic_status && (
        <div className={`zeus-coderec-verification verdict-${rec.verification.syntactic_status}`}>
          <span className="zeus-coderec-verification-icon">
            {rec.verification.syntactic_status === 'verified' ? '✓' :
             rec.verification.syntactic_status === 'skipped' ? '—' : '⚠'}
          </span>
          <div className="zeus-coderec-verification-body">
            <div className="zeus-coderec-verification-verdict">
              Verificación: <b>{rec.verification.syntactic_status.replace('_', ' ')}</b>
            </div>
            {rec.verification.syntactic_notes && (
              <div className="zeus-coderec-verification-notes">{rec.verification.syntactic_notes}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, onFollowup, onOpenAdset }) {
  const isUser = message.role === 'user';
  const isGreeting = message.role === 'system_greeting';
  const followups = !isUser ? (message.followups || []) : [];

  function handleEntityClick(kind, id) {
    if (kind === 'adset' && id && onOpenAdset) {
      onOpenAdset(id);
      return true; // consumido — abre modal overlay, no navegar al panel
    }
    return false; // deja que el handler global navegue al panel
  }

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
            : <ZeusMarkdown onEntityClick={handleEntityClick}>{stripFollowupsBlock(message.content || '')}</ZeusMarkdown>}
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

// ═══ StanceCard — postura operativa del día de un agente ═══
const AGENT_EMOJI = { prometheus: '🔥', athena: '🦉', apollo: '🎨', ares: '⚔️' };
const STANCE_COLOR = {
  aggressive: '#f97316',
  steady: '#60a5fa',
  'observe-only': '#a78bfa',
  paused: '#6b7280',
  recovering: '#fbbf24'
};
const STANCE_LABEL = {
  aggressive: 'AGGRESSIVE',
  steady: 'STEADY',
  'observe-only': 'OBSERVE',
  paused: 'PAUSED',
  recovering: 'RECOVERING'
};
const SOURCE_LABEL = {
  briefing: 'briefing',
  override_creator: 'override tuyo',
  override_zeus: 'override Zeus',
  fallback_stale: 'fallback stale',
  fallback_default: 'fallback default'
};
const VERDICT_COLOR = { correct: '#10b981', wrong: '#ef4444', inconclusive: '#6b7280' };

function fmtStanceTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const absHrs = Math.abs(diffMs) / 3600000;
  if (absHrs < 1) {
    const mins = Math.round(Math.abs(diffMs) / 60000);
    return diffMs < 0 ? `hace ${mins}m` : `en ${mins}m`;
  }
  if (absHrs < 48) {
    const hrs = Math.round(absHrs);
    return diffMs < 0 ? `hace ${hrs}h` : `en ${hrs}h`;
  }
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function StanceCard({ agent, stance, history, onOverride, onRenew, onBriefNow }) {
  const [showHistory, setShowHistory] = useState(false);

  if (!stance) {
    return (
      <div className="zeus-stance-card stance-empty">
        <div className="zeus-stance-head">
          <span className="zeus-stance-agent">{AGENT_EMOJI[agent] || '🤖'} {agent}</span>
          <span className="zeus-stance-spacer" />
          <button className="zeus-stance-btn" onClick={onBriefNow} title="Dispara briefing manual (~30s)">brief now</button>
        </div>
        <div className="zeus-stance-empty-msg">Sin stance activo. Corré briefing manual o esperá el cron matutino.</div>
      </div>
    );
  }

  const color = STANCE_COLOR[stance.stance] || '#94a3b8';
  const label = STANCE_LABEL[stance.stance] || stance.stance.toUpperCase();
  const isExpired = stance.expires_at && new Date(stance.expires_at).getTime() < Date.now();
  const isOverride = stance.source === 'override_creator' || stance.source === 'override_zeus';

  return (
    <div className={`zeus-stance-card ${stance.stale ? 'stance-stale' : ''} ${isExpired ? 'stance-expired' : ''}`} style={{ borderLeftColor: color }}>
      <div className="zeus-stance-head">
        <span className="zeus-stance-agent">{AGENT_EMOJI[agent] || '🤖'} {agent}</span>
        <span className="zeus-stance-badge" style={{ background: color + '22', color, borderColor: color + '55' }}>{label}</span>
        {stance.stale && <span className="zeus-stance-flag stale">stale</span>}
        {isExpired && <span className="zeus-stance-flag expired">expirado</span>}
        {isOverride && <span className="zeus-stance-flag override">{SOURCE_LABEL[stance.source]}</span>}
        <span className="zeus-stance-spacer" />
        <span className="zeus-stance-source" title={`source: ${stance.source}`}>{SOURCE_LABEL[stance.source] || stance.source}</span>
      </div>

      {stance.focus && (
        <div className="zeus-stance-focus">
          <span className="zeus-stance-label">focus:</span> {stance.focus}
        </div>
      )}

      {stance.rationale && (
        <div className="zeus-stance-rationale">{stance.rationale}</div>
      )}

      {(stance.pros?.length > 0 || stance.cons?.length > 0) && (
        <div className="zeus-stance-proscons">
          {stance.pros?.length > 0 && (
            <div className="zeus-stance-pros">
              <span className="zeus-stance-label">pros:</span>
              <ul>{stance.pros.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </div>
          )}
          {stance.cons?.length > 0 && (
            <div className="zeus-stance-cons">
              <span className="zeus-stance-label">cons:</span>
              <ul>{stance.cons.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {stance.override_reason && (
        <div className="zeus-stance-override-reason">
          <span className="zeus-stance-label">razón override:</span> {stance.override_reason}
        </div>
      )}

      <div className="zeus-stance-meta">
        <span>creado {fmtStanceTime(stance.created_at)}</span>
        <span>·</span>
        <span>expira {fmtStanceTime(stance.expires_at)}</span>
      </div>

      <div className="zeus-stance-actions">
        <button className="zeus-stance-btn" onClick={onOverride} title="Overrideá el stance como CEO">override</button>
        <button className="zeus-stance-btn" onClick={onRenew} title="Extendé 24h más">renew 24h</button>
        <button className="zeus-stance-btn" onClick={onBriefNow} title="Forzá un briefing nuevo (~30s)">brief now</button>
        <span className="zeus-stance-spacer" />
        <button className="zeus-stance-btn subtle" onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? '▾' : '▸'} historial ({history?.length || 0})
        </button>
      </div>

      {showHistory && (
        <div className="zeus-stance-history">
          {(!history || history.length === 0) ? (
            <div className="zeus-stance-history-empty">Sin historial previo.</div>
          ) : (
            history.map(h => (
              <div key={h._id} className="zeus-stance-history-row">
                <span className="zeus-stance-history-date">{fmtStanceTime(h.created_at)}</span>
                <span className="zeus-stance-history-badge" style={{ color: STANCE_COLOR[h.stance] || '#94a3b8' }}>
                  {STANCE_LABEL[h.stance] || h.stance}
                </span>
                {h.verdict && (
                  <span className="zeus-stance-verdict" style={{ color: VERDICT_COLOR[h.verdict], borderColor: (VERDICT_COLOR[h.verdict] || '#6b7280') + '55' }}>
                    {h.verdict}
                  </span>
                )}
                {h.source && h.source !== 'briefing' && (
                  <span className="zeus-stance-history-src">{SOURCE_LABEL[h.source] || h.source}</span>
                )}
                {h.focus && <span className="zeus-stance-history-focus" title={h.focus}>focus: {h.focus.substring(0, 40)}{h.focus.length > 40 ? '…' : ''}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ═══ Hilo B — cards de calibración ═══

const PRINCIPLE_LABELS = {
  resist_validation: 'resistió validación',
  separate_measurable_from_intuition: 'separó medible/intuición',
  declared_no_counterfactual: 'declaró sin contrafactual',
  contradicted_creator_judgment: 'contradijo juicio',
  asked_before_asserting: 'pidió verificación',
  committed_to_disconfirmation: 'se ató al mástil (pre-commit falsable)',
  validation_bias: 'validó por default',
  accepted_unverified_factual: 'aceptó sin verificar',
  uncontested_causal_assumption: 'causalidad no señalada',
  suppressed_disagreement: 'suprimió desacuerdo',
  missing_counterfactual: 'sin contrafactual',
  template_execution_without_thinking: 'forma sin fondo',
  trusted_stale_context: 'confió en contexto stale',
  ignored_explicit_correction: 'ignoró corrección explícita',
  conversational_scope_drift: 'salió del scope',
  unverified_self_assertion: 'afirmó sin verificar'
};

function fmtCalibDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const hrs = diffMs / 3600000;
  if (hrs < 1) return `hace ${Math.round(diffMs / 60000)}m`;
  if (hrs < 48) return `hace ${Math.round(hrs)}h`;
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function AntiRefCard({ entry, onPromote }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="zeus-calib-card anti-ref">
      <div className="zeus-calib-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-calib-icon">✗</span>
        <span className="zeus-calib-card-title">{entry.title}</span>
        <span className="zeus-calib-card-date">{fmtCalibDate(entry.created_at)}</span>
        <span className="zeus-calib-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      <div className="zeus-calib-principles">
        {(entry.violated_principles || []).map(p => (
          <span key={p} className="zeus-calib-principle violated">{PRINCIPLE_LABELS[p] || p}</span>
        ))}
      </div>
      {expanded && (
        <div className="zeus-calib-card-body">
          {entry.failure_mode && <div className="zeus-calib-field"><span className="zeus-calib-label">failure mode:</span> <code>{entry.failure_mode}</code></div>}
          {entry.correction_learned && <div className="zeus-calib-field"><span className="zeus-calib-label">corrección:</span> {entry.correction_learned}</div>}
          {entry.original_user_message && (
            <div className="zeus-calib-excerpt">
              <span className="zeus-calib-label">creador dijo:</span>
              <blockquote>{entry.original_user_message}</blockquote>
            </div>
          )}
          {entry.original_assistant_response && (
            <div className="zeus-calib-excerpt">
              <span className="zeus-calib-label">zeus respondió:</span>
              <blockquote>{entry.original_assistant_response}</blockquote>
            </div>
          )}
          {entry.content && <div className="zeus-calib-content">{entry.content}</div>}
          <div className="zeus-calib-actions">
            <button className="zeus-calib-btn subtle" onClick={() => onPromote('clear')}>descartar (no es anti-ref)</button>
            <button className="zeus-calib-btn subtle" onClick={() => onPromote('reference')}>promover a golden</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RefCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="zeus-calib-card reference">
      <div className="zeus-calib-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-calib-icon">★</span>
        <span className="zeus-calib-card-title">{entry.title}</span>
        <span className="zeus-calib-card-date">{fmtCalibDate(entry.created_at)}</span>
        <span className="zeus-calib-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      <div className="zeus-calib-principles">
        {(entry.principles_exemplified || []).map(p => (
          <span key={p} className="zeus-calib-principle exemplified">{PRINCIPLE_LABELS[p] || p}</span>
        ))}
      </div>
      {expanded && (
        <div className="zeus-calib-card-body">
          {entry.original_user_message && (
            <div className="zeus-calib-excerpt">
              <span className="zeus-calib-label">creador dijo:</span>
              <blockquote>{entry.original_user_message}</blockquote>
            </div>
          )}
          {entry.original_assistant_response && (
            <div className="zeus-calib-excerpt">
              <span className="zeus-calib-label">zeus respondió:</span>
              <blockquote>{entry.original_assistant_response}</blockquote>
            </div>
          )}
          {entry.content && <div className="zeus-calib-content">{entry.content}</div>}
        </div>
      )}
    </div>
  );
}

function TrapCard({ trap, onExecute, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const outcomeColor = trap.outcome === 'passed' ? '#10b981' : trap.outcome === 'failed' ? '#ef4444' : '#6b7280';
  const outcomeLabel = trap.outcome || (trap.status === 'pending' ? 'pendiente' : 'sin outcome');
  return (
    <div className={`zeus-calib-card trap ${trap.status}`}>
      <div className="zeus-calib-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-calib-icon" style={{ color: outcomeColor }}>
          {trap.outcome === 'passed' ? '✓' : trap.outcome === 'failed' ? '✗' : '◷'}
        </span>
        <span className="zeus-calib-card-title">{trap.content.substring(0, 80)}{trap.content.length > 80 ? '…' : ''}</span>
        <span className="zeus-calib-trap-outcome" style={{ color: outcomeColor, borderColor: outcomeColor + '55' }}>{outcomeLabel}</span>
        <span className="zeus-calib-card-date">{fmtCalibDate(trap.executed_at || trap.created_at)}</span>
        <span className="zeus-calib-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      <div className="zeus-calib-trap-meta">
        <span className="zeus-calib-trap-src">{trap.source}</span>
        {trap.category && <span className="zeus-calib-trap-cat">{trap.category}</span>}
        {trap.match_score != null && <span>score {(trap.match_score).toFixed(2)}</span>}
      </div>
      {expanded && (
        <div className="zeus-calib-card-body">
          <div className="zeus-calib-field">
            <span className="zeus-calib-label">contenido:</span>
            <blockquote>{trap.content}</blockquote>
          </div>
          <div className="zeus-calib-field">
            <span className="zeus-calib-label">contradicción esperada:</span>
            <blockquote>{trap.expected_contradiction}</blockquote>
          </div>
          {trap.zeus_response && (
            <div className="zeus-calib-field">
              <span className="zeus-calib-label">respuesta de Zeus:</span>
              <blockquote>{trap.zeus_response.substring(0, 600)}{trap.zeus_response.length > 600 ? '…' : ''}</blockquote>
            </div>
          )}
          {trap.match_reasoning && (
            <div className="zeus-calib-field">
              <span className="zeus-calib-label">evaluación:</span> {trap.match_reasoning}
            </div>
          )}
          <div className="zeus-calib-actions">
            {trap.status === 'pending' && (
              <button className="zeus-calib-btn" onClick={onExecute}>ejecutar</button>
            )}
            <button className="zeus-calib-btn subtle" onClick={onDelete}>borrar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const payload = entry.audit_payload || {};
  const flags = payload.flags || [];
  const hasRedFlag = flags.some(f => f.level === 'red');
  const hasAmberFlag = flags.some(f => f.level === 'amber');
  const borderColor = hasRedFlag ? '#ef4444' : hasAmberFlag ? '#fbbf24' : '#10b981';
  return (
    <div className="zeus-calib-card audit" style={{ borderLeftColor: borderColor }}>
      <div className="zeus-calib-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-calib-icon">📊</span>
        <span className="zeus-calib-card-title">{entry.title}</span>
        {flags.length > 0 && (
          <span className="zeus-calib-flag-count" style={{ color: borderColor, borderColor: borderColor + '55' }}>
            {flags.length} flag{flags.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="zeus-calib-card-date">{fmtCalibDate(entry.created_at)}</span>
        <span className="zeus-calib-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="zeus-calib-card-body">
          {payload.diagnosis && payload.diagnosis.length > 0 && (
            <div className="zeus-calib-field">
              <span className="zeus-calib-label">diagnóstico:</span>
              <ul>{payload.diagnosis.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          )}
          {payload.traps && (
            <div className="zeus-calib-audit-block">
              <span className="zeus-calib-label">trampas:</span> {payload.traps.total} total
              {payload.traps.total > 0 && (
                <> · ✓ {payload.traps.passed} passed · ✗ {payload.traps.failed} failed · acc {(payload.traps.falsification_accuracy * 100).toFixed(0)}%</>
              )}
              {payload.traps.long_gaps > 0 && <> · {payload.traps.long_gaps} gap(s) &gt;21d</>}
            </div>
          )}
          {payload.anti_references && (
            <div className="zeus-calib-audit-block">
              <span className="zeus-calib-label">anti-refs:</span> {payload.anti_references.total}
              {(payload.anti_references.top_principles || []).length > 0 && (
                <div className="zeus-calib-principles">
                  {payload.anti_references.top_principles.map(tp => (
                    <span key={tp.principle} className="zeus-calib-principle violated">
                      {PRINCIPLE_LABELS[tp.principle] || tp.principle} × {tp.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {payload.reference_responses && (
            <div className="zeus-calib-audit-block">
              <span className="zeus-calib-label">golden refs:</span> {payload.reference_responses.total}
            </div>
          )}
          {flags.length > 0 && (
            <div className="zeus-calib-audit-flags">
              {flags.map((f, i) => (
                <div key={i} className={`zeus-calib-flag flag-${f.level}`}>
                  <span className="zeus-calib-flag-level">[{f.level}]</span> {f.text}
                </div>
              ))}
            </div>
          )}
          {entry.content && <div className="zeus-calib-content">{entry.content}</div>}
        </div>
      )}
    </div>
  );
}

// ═══ Hilo C — Auto-Pause cards ═══

const AP_VERDICT_COLOR = {
  pending: '#6b7280',
  correct_pause: '#10b981',
  false_positive: '#ef4444',
  ambiguous: '#fbbf24'
};

const AP_VERDICT_ICON = {
  pending: '◷',
  correct_pause: '✓',
  false_positive: '✗',
  ambiguous: '~'
};

function fmtApDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  const diffMs = Date.now() - date.getTime();
  const hrs = diffMs / 3600000;
  if (Math.abs(hrs) < 1) return 'recién';
  if (hrs < 48 && hrs >= 0) return `hace ${Math.round(hrs)}h`;
  if (hrs < 0 && Math.abs(hrs) < 72) return `en ${Math.round(Math.abs(hrs))}h`;
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ShadowLogCard({ log }) {
  const [expanded, setExpanded] = useState(false);
  const ts = log.threshold_snapshot || {};
  const gt = log.ground_truth_7d;
  const verdictColor = AP_VERDICT_COLOR[log.verdict] || '#6b7280';
  return (
    <div className={`zeus-ap-card shadow verdict-${log.verdict}`} style={{ borderLeftColor: verdictColor }}>
      <div className="zeus-ap-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-ap-card-icon" style={{ color: verdictColor }}>
          {AP_VERDICT_ICON[log.verdict] || '?'}
        </span>
        <span className="zeus-ap-card-title">{log.adset_name}</span>
        <span className="zeus-ap-card-metric">
          ROAS_3d {ts.roas_3d?.toFixed(2) || '?'}x · ${Math.round(ts.spend_3d || 0)} · {ts.purchases_3d || 0}c
        </span>
        <span className="zeus-ap-card-verdict" style={{ color: verdictColor, borderColor: verdictColor + '55' }}>
          {log.verdict || 'pending'}
        </span>
        <span className="zeus-ap-card-date">{fmtApDate(log.detected_at)}</span>
        <span className="zeus-ap-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="zeus-ap-card-body">
          <div className="zeus-ap-field">
            <span className="zeus-ap-label">detección:</span>
            <code>ROAS_3d {ts.roas_3d?.toFixed(3)} · spend ${ts.spend_3d} · purchases {ts.purchases_3d} · age {ts.age_days}d · learning {ts.learning_stage}</code>
          </div>
          <div className="zeus-ap-field">
            <span className="zeus-ap-label">would_pause:</span> {log.would_pause ? 'sí' : 'no'}
            <span style={{ marginLeft: 10 }}><span className="zeus-ap-label">criteria:</span> <code>{log.criteria_version}</code></span>
          </div>
          {log.ground_truth_completed ? (
            <>
              <div className="zeus-ap-field">
                <span className="zeus-ap-label">ground truth (7d si NO pausado):</span>
                <code>ROAS {gt?.roas?.toFixed(2)}x · spend ${gt?.spend} · {gt?.purchases} compras</code>
              </div>
              {log.verdict_reason && <div className="zeus-ap-field muted">{log.verdict_reason}</div>}
            </>
          ) : (
            <div className="zeus-ap-field muted">
              ground truth pending · review due {fmtApDate(log.ground_truth_due_at)}
            </div>
          )}
          {log.platform_state_at_detection?.degraded && (
            <div className="zeus-ap-field warning">⚠ platform estaba degraded al detectar — caso de confound</div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveLogCard({ log, onReactivate }) {
  const [expanded, setExpanded] = useState(false);
  const ts = log.threshold_snapshot || {};
  const verdictColor = AP_VERDICT_COLOR[log.verdict] || '#6b7280';
  const isReactivated = !!log.reactivated_at;
  return (
    <div className={`zeus-ap-card live verdict-${log.verdict}`} style={{ borderLeftColor: verdictColor }}>
      <div className="zeus-ap-card-head" onClick={() => setExpanded(!expanded)}>
        <span className="zeus-ap-card-icon" style={{ color: verdictColor }}>
          {AP_VERDICT_ICON[log.verdict] || '?'}
        </span>
        <span className="zeus-ap-card-title">{log.adset_name}</span>
        <span className="zeus-ap-card-metric">
          ROAS_3d {ts.roas_3d?.toFixed(2) || '?'}x · ${Math.round(ts.spend_3d || 0)}
        </span>
        <span className="zeus-ap-card-verdict" style={{ color: verdictColor, borderColor: verdictColor + '55' }}>
          {log.verdict || 'pending'}
        </span>
        {isReactivated && (
          <span className="zeus-ap-card-reactivated" title={`reactivated by ${log.reactivated_by}`}>
            ↻ {log.reactivated_by}
          </span>
        )}
        <span className="zeus-ap-card-date">{fmtApDate(log.paused_at)}</span>
        <span className="zeus-ap-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="zeus-ap-card-body">
          <div className="zeus-ap-field">
            <span className="zeus-ap-label">pausado:</span> {fmtApDate(log.paused_at)}
            {log.meta_api_success === false && <span className="zeus-ap-field warning"> · ⚠ Meta API falló</span>}
          </div>
          <div className="zeus-ap-field">
            <span className="zeus-ap-label">threshold:</span>
            <code>ROAS_3d {ts.roas_3d?.toFixed(3)} · spend ${ts.spend_3d} · purchases {ts.purchases_3d} · age {ts.age_days}d · learning {ts.learning_stage}</code>
          </div>
          <div className="zeus-ap-field">
            <span className="zeus-ap-label">criteria:</span> <code>{log.criteria_version}</code>
            <span style={{ marginLeft: 10 }}><span className="zeus-ap-label">review due:</span> {fmtApDate(log.review_due_at)}</span>
          </div>
          {isReactivated ? (
            <>
              <div className="zeus-ap-field">
                <span className="zeus-ap-label">reactivado:</span> {fmtApDate(log.reactivated_at)} por <b>{log.reactivated_by}</b>
                {log.reactivation_reason && <span> · "{log.reactivation_reason}"</span>}
              </div>
              {log.ground_truth_post_reactivation ? (
                <div className="zeus-ap-field">
                  <span className="zeus-ap-label">post-reactivation 7d:</span>
                  <code>ROAS {log.ground_truth_post_reactivation.roas_7d?.toFixed(2)}x · ${log.ground_truth_post_reactivation.spend_7d} · {log.ground_truth_post_reactivation.purchases_7d} compras</code>
                </div>
              ) : (
                <div className="zeus-ap-field muted">ground truth post-reactivation pending</div>
              )}
            </>
          ) : (
            <div className="zeus-ap-actions">
              <button className="zeus-ap-btn" onClick={onReactivate}>↻ reactivar adset</button>
              <span className="zeus-ap-field muted" style={{ marginLeft: 8 }}>
                si lo reactivás, se trackea como FP candidate y se mide ROAS a 7d post.
              </span>
            </div>
          )}
          {log.verdict_reason && <div className="zeus-ap-field muted">{log.verdict_reason}</div>}
          {log.platform_state_at_pause?.degraded && (
            <div className="zeus-ap-field warning">⚠ platform estaba degraded al pausar — caso de confound (violación gate)</div>
          )}
        </div>
      )}
    </div>
  );
}
