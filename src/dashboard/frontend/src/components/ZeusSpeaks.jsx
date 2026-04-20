import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../api';
import { ZeusVoice, ZeusMic } from '../lib/zeus-voice';

const LS_CONV_KEY = 'zeus_oracle_conversation_id';
const LS_MUTED_KEY = 'zeus_voice_muted';
const LS_UNLOCKED_KEY = 'zeus_voice_unlocked';

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

  es.onerror = (err) => {
    if (handlers.error) handlers.error({ error: 'SSE connection error' });
    es.close();
  };

  return es;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function ZeusSpeaks() {
  const [mode, setMode] = useState('loading'); // loading | awaiting_unlock | greeting | collapsed | error | none
  const [streamingText, setStreamingText] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [toolActivity, setToolActivity] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(() => localStorage.getItem(LS_MUTED_KEY) === '1');
  const esRef = useRef(null);
  const voiceRef = useRef(null);

  useEffect(() => {
    voiceRef.current = new ZeusVoice({
      voice: 'onyx',
      onSpeakStart: () => setSpeaking(true),
      onSpeakEnd: () => setSpeaking(false),
      onQueueDrained: () => setSpeaking(false)
    });
    voiceRef.current.setMuted(muted);

    // Si el usuario ya interactuó en alguna sesión, asumimos unlocked
    if (localStorage.getItem(LS_UNLOCKED_KEY) === '1') {
      voiceRef.current.unlock();
    }

    startGreeting();

    // Capture interaction globally for autoplay unlock
    const handleInteraction = () => {
      if (voiceRef.current && !voiceRef.current.isUnlocked()) {
        voiceRef.current.unlock();
        localStorage.setItem(LS_UNLOCKED_KEY, '1');
      }
    };
    window.addEventListener('click', handleInteraction, { once: true });
    window.addEventListener('keydown', handleInteraction, { once: true });

    return () => {
      esRef.current?.close();
      voiceRef.current?.stop();
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStorage.setItem(LS_MUTED_KEY, next ? '1' : '0');
    voiceRef.current?.setMuted(next);
  }

  function unlockAudioAndStart() {
    voiceRef.current?.unlock();
    localStorage.setItem(LS_UNLOCKED_KEY, '1');
    startGreeting();
  }

  async function startGreeting() {
    try {
      const check = await api.post('/api/zeus/greeting/check');
      const checkMode = check.data?.mode || 'greeting_full';

      if (checkMode === 'none') {
        // Restaurar conversación previa si existe
        const prevConv = localStorage.getItem(LS_CONV_KEY);
        if (prevConv) setConversationId(prevConv);
        setMode('collapsed');
        return;
      }

      // Si autoplay bloqueado y no está muteado, pedir unlock primero
      if (!muted && voiceRef.current && !voiceRef.current.isUnlocked()) {
        setMode('awaiting_unlock');
        return;
      }

      setMode('greeting');
      setStreaming(true);
      setStreamingText('');
      setToolActivity([]);

      voiceRef.current?.reset();

      const es = streamSSE('/api/zeus/greeting/stream', {
        start: (data) => {
          if (data.conversation_id) {
            setConversationId(data.conversation_id);
            localStorage.setItem(LS_CONV_KEY, data.conversation_id);
          }
        },
        text_delta: (data) => {
          const txt = data.text || '';
          setStreamingText(prev => prev + txt);
          voiceRef.current?.feed(txt);
        },
        tool_use_start: (data) => {
          setToolActivity(prev => [...prev, { tool: data.tool, status: 'running', at: Date.now() }]);
        },
        tool_use_result: (data) => {
          setToolActivity(prev => prev.map(t =>
            t.tool === data.tool && t.status === 'running' ? { ...t, status: 'done', summary: data.summary } : t
          ));
        },
        error: () => {
          setStreaming(false);
          setMode('error');
        },
        end: () => {
          setStreaming(false);
          voiceRef.current?.finish();
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

        {mode === 'awaiting_unlock' && (
          <motion.div
            key="unlock"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="zeus-speaks-hero zeus-unlock-hero"
            onClick={unlockAudioAndStart}
          >
            <div className="zeus-hero-glow" />
            <div className="zeus-unlock-inner">
              <motion.div
                className="zeus-unlock-orb"
                animate={{ scale: [1, 1.08, 1] }}
                transition={{ duration: 1.8, repeat: Infinity }}
              >
                ⚡
              </motion.div>
              <div>
                <div className="zeus-unlock-title">Zeus quiere hablarte</div>
                <div className="zeus-unlock-sub">Toca aquí para escuchar su saludo</div>
              </div>
              <button
                className="zeus-hero-btn"
                onClick={(e) => { e.stopPropagation(); toggleMute(); setMode('collapsed'); }}
              >
                Preferir silencio
              </button>
            </div>
          </motion.div>
        )}

        {mode === 'greeting' && (
          <ZeusHero
            key="greeting"
            text={streamingText}
            toolActivity={toolActivity}
            streaming={streaming}
            speaking={speaking}
            muted={muted}
            onToggleMute={toggleMute}
            onCollapse={() => { voiceRef.current?.stop(); setMode('collapsed'); }}
            onReply={() => { setMode('collapsed'); setDrawerOpen(true); }}
          />
        )}

        {mode === 'collapsed' && (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="zeus-speaks-banner"
            onClick={() => setDrawerOpen(true)}
          >
            <div className="zeus-orb-mini" />
            <span className="zeus-banner-text">
              Zeus está aquí · {hasConv ? 'continuar conversación' : 'hablar con él'}
            </span>
            <span className="zeus-banner-cta">⟶</span>
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
            <span>Zeus no responde ahora. <button onClick={startGreeting} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>Reintentar</button></span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating button (siempre) */}
      {!drawerOpen && mode !== 'loading' && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5 }}
          onClick={() => setDrawerOpen(true)}
          className="zeus-fab"
          aria-label="Hablar con Zeus"
        >
          <span className="zeus-fab-icon">⚡</span>
        </motion.button>
      )}

      {/* Drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <ZeusDrawer
            conversationId={conversationId}
            onNewConversation={(id) => {
              setConversationId(id);
              localStorage.setItem(LS_CONV_KEY, id);
            }}
            onClose={() => setDrawerOpen(false)}
            greetingText={streamingText}
            voice={voiceRef.current}
            muted={muted}
            onToggleMute={toggleMute}
            speaking={speaking}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HERO — streaming greeting
// ═══════════════════════════════════════════════════════════════════════════

function ZeusHero({ text, toolActivity, streaming, speaking, muted, onToggleMute, onCollapse, onReply }) {
  const pulsing = streaming || speaking;
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
            className={`zeus-orb-hero ${speaking ? 'zeus-orb-speaking' : ''}`}
            animate={pulsing ? { scale: [1, speaking ? 1.14 : 1.08, 1] } : { scale: 1 }}
            transition={pulsing ? { duration: speaking ? 0.9 : 1.6, repeat: Infinity } : {}}
          >
            ⚡
          </motion.div>
          <div style={{ flex: 1 }}>
            <div className="zeus-hero-title">ZEUS</div>
            <div className="zeus-hero-subtitle">
              {speaking ? 'hablando en voz alta...' : streaming ? 'pensando...' : 'ha terminado'}
            </div>
          </div>
          <button
            className={`zeus-mute-toggle ${muted ? 'muted' : ''}`}
            onClick={onToggleMute}
            title={muted ? 'Activar voz' : 'Silenciar voz'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          {!streaming && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="zeus-hero-btn zeus-hero-btn-primary" onClick={onReply}>
                Responder
              </button>
              <button className="zeus-hero-btn" onClick={onCollapse}>
                Ocultar
              </button>
            </div>
          )}
        </div>

        <div className="zeus-hero-text">
          {text}
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
      </div>
    </motion.div>
  );
}

function toolLabel(tool) {
  const labels = {
    query_portfolio: 'revisando el portfolio',
    query_adsets: 'consultando ad sets',
    query_tests: 'mirando los tests',
    query_dnas: 'analizando DNAs',
    query_actions: 'revisando acciones',
    query_directives: 'checando directivas',
    query_insights: 'leyendo insights',
    query_hypotheses: 'revisando hipótesis',
    query_duplications: 'mirando duplicaciones'
  };
  return labels[tool] || tool;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWER — continued chat
// ═══════════════════════════════════════════════════════════════════════════

function ZeusDrawer({ conversationId, onNewConversation, onClose, greetingText, voice, muted, onToggleMute, speaking }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toolActivity, setToolActivity] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(!!conversationId);
  const [listening, setListening] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const scrollRef = useRef(null);
  const esRef = useRef(null);
  const micRef = useRef(null);

  useEffect(() => {
    if (conversationId) loadHistory(conversationId);
    else setLoadingHistory(false);
    return () => { esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

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

  async function sendMessage(overrideMsg = null) {
    const msg = (overrideMsg != null ? overrideMsg : input).trim();
    if (!msg || streaming) return;
    setInput('');
    setPartialTranscript('');
    setStreaming(true);
    setStreamingText('');
    setToolActivity([]);

    voice?.reset();

    // Optimistic user message
    setMessages(prev => [...prev, { role: 'user', content: msg, _local: true, created_at: new Date() }]);

    const params = new URLSearchParams({ message: msg });
    if (conversationId) params.set('conversation_id', conversationId);

    const es = streamSSE(`/api/zeus/chat/stream?${params.toString()}`, {
      start: (data) => {
        if (data.conversation_id && data.conversation_id !== conversationId) {
          onNewConversation(data.conversation_id);
        }
      },
      text_delta: (data) => {
        const txt = data.text || '';
        setStreamingText(prev => prev + txt);
        voice?.feed(txt);
      },
      tool_use_start: (data) => {
        setToolActivity(prev => [...prev, { tool: data.tool, status: 'running' }]);
      },
      tool_use_result: (data) => {
        setToolActivity(prev => prev.map(t =>
          t.tool === data.tool && t.status === 'running' ? { ...t, status: 'done', summary: data.summary } : t
        ));
      },
      end: (data) => {
        voice?.finish();
        // Commit streaming text to messages
        setMessages(prev => {
          const next = [...prev.filter(m => !m._local)];
          next.push({ role: 'user', content: msg, created_at: new Date() });
          next.push({ role: 'assistant', content: streamingTextRef.current || '', created_at: new Date(), tool_calls: toolActivityRef.current });
          return next;
        });
        setStreamingText('');
        setToolActivity([]);
        setStreaming(false);
        es.close();
      },
      error: () => {
        voice?.stop();
        setStreaming(false);
        es.close();
      }
    });

    esRef.current = es;
  }

  function toggleMic() {
    if (!ZeusMic.isSupported()) {
      alert('Tu browser no soporta reconocimiento de voz. Probá con Chrome o Safari.');
      return;
    }

    if (listening) {
      micRef.current?.stop();
      return;
    }

    // Unlock audio al mismo tiempo (primera interacción)
    voice?.unlock();
    localStorage.setItem(LS_UNLOCKED_KEY, '1');

    const mic = new ZeusMic({
      lang: 'es-ES',
      onStart: () => setListening(true),
      onPartial: (t) => setPartialTranscript(t),
      onTranscript: (t) => {
        setPartialTranscript('');
        if (t.trim()) sendMessage(t);
      },
      onEnd: () => setListening(false),
      onError: (e) => { console.warn('Mic error:', e); setListening(false); }
    });
    micRef.current = mic;
    mic.start();
  }

  // Refs for closure capture in end handler
  const streamingTextRef = useRef('');
  const toolActivityRef = useRef([]);
  useEffect(() => { streamingTextRef.current = streamingText; }, [streamingText]);
  useEffect(() => { toolActivityRef.current = toolActivity; }, [toolActivity]);

  const combinedMessages = messages;

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
            <motion.div
              className={`zeus-orb-drawer ${speaking ? 'zeus-orb-speaking' : ''}`}
              animate={speaking ? { scale: [1, 1.12, 1] } : { scale: 1 }}
              transition={speaking ? { duration: 0.8, repeat: Infinity } : {}}
            >
              ⚡
            </motion.div>
            <div>
              <div className="zeus-drawer-title">Zeus</div>
              <div className="zeus-drawer-subtitle">
                {speaking ? 'hablando...' : streaming ? 'pensando...' : 'Oracle · read-only'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              className={`zeus-mute-toggle ${muted ? 'muted' : ''}`}
              onClick={onToggleMute}
              title={muted ? 'Activar voz' : 'Silenciar voz'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <button className="zeus-drawer-close" onClick={onClose}>×</button>
          </div>
        </div>

        <div ref={scrollRef} className="zeus-drawer-messages">
          {loadingHistory ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--bos-text-muted)', fontSize: '0.8rem' }}>
              Cargando conversación...
            </div>
          ) : (
            <>
              {combinedMessages.length === 0 && !streamingText && (
                <div className="zeus-drawer-empty">
                  <div className="zeus-empty-orb">⚡</div>
                  <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
                    Preguntá lo que quieras sobre el sistema.
                  </div>
                  <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--bos-text-muted)' }}>
                    Zeus puede consultar cualquier parte de la base de datos.
                  </div>
                </div>
              )}

              {combinedMessages.map((m, i) => (
                <MessageBubble key={i} message={m} />
              ))}

              {streaming && (
                <div className="zeus-msg zeus-msg-assistant">
                  <div className="zeus-msg-content">
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
                    <div className="zeus-msg-text">
                      {streamingText}
                      <span className="zeus-cursor">▌</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="zeus-drawer-input">
          <button
            onClick={toggleMic}
            disabled={streaming}
            className={`zeus-mic-btn ${listening ? 'listening' : ''}`}
            title={listening ? 'Detener grabación' : 'Hablar'}
          >
            {listening ? (
              <motion.span
                animate={{ scale: [1, 1.3, 1] }}
                transition={{ duration: 0.8, repeat: Infinity }}
                style={{ display: 'inline-block' }}
              >
                🎤
              </motion.span>
            ) : '🎤'}
          </button>
          <textarea
            value={listening ? partialTranscript : input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={listening ? 'Escuchando...' : 'Preguntále a Zeus (o tocá 🎤 para hablar)...'}
            rows={1}
            disabled={streaming || listening}
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

function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const isGreeting = message.role === 'system_greeting';

  return (
    <div className={`zeus-msg ${isUser ? 'zeus-msg-user' : 'zeus-msg-assistant'}`}>
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
        <div className="zeus-msg-text">{message.content}</div>
        {isGreeting && (
          <div style={{ fontSize: '0.58rem', color: 'var(--bos-text-dim)', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            · saludo automático ·
          </div>
        )}
      </div>
    </div>
  );
}
