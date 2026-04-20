const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const OpenAI = require('openai');
const config = require('../../../config');
const logger = require('../../utils/logger');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const SystemConfig = require('../../db/models/SystemConfig');
const { runOracle } = require('../../ai/zeus/oracle-runner');

const OPENAI_VOICES = ['onyx', 'echo', 'ash', 'sage', 'verse', 'coral', 'alloy', 'ballad'];
const DEFAULT_OPENAI_VOICE = 'onyx';

// ElevenLabs voice IDs curados para Zeus (hombre, tono CEO)
// Podés sobreescribir con env var ELEVENLABS_VOICE_ID
const DEFAULT_ELEVENLABS_VOICE_ID = 'ErXwobaYiN019PkySvjV'; // "Antoni" — español warm masculine
const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2';

function getElevenLabsConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
    model: process.env.ELEVENLABS_MODEL || DEFAULT_ELEVENLABS_MODEL
  };
}

function getOpenAIKey() {
  return config.openai?.apiKey || process.env.OPENAI_API_KEY;
}

// ═══ GET /voice/diagnostics — info de qué provider está activo ═══
router.get('/voice/diagnostics', async (req, res) => {
  const openaiKey = getOpenAIKey();
  const elevenConfig = getElevenLabsConfig();
  res.json({
    active_provider: elevenConfig ? 'elevenlabs' : (openaiKey ? 'openai' : 'browser_speech'),
    elevenlabs: {
      set: !!elevenConfig,
      voice_id: elevenConfig?.voiceId || null,
      model: elevenConfig?.model || null
    },
    openai: {
      set: !!openaiKey,
      key_length: openaiKey ? openaiKey.length : 0,
      voices: OPENAI_VOICES,
      default_voice: DEFAULT_OPENAI_VOICE
    }
  });
});

const LAST_SEEN_KEY = 'zeus_oracle_last_seen';
const GREETING_GAP_HOURS = 2;

// ═══ POST /greeting/check — decide qué modo (full / short / none) ═══
router.post('/greeting/check', async (req, res) => {
  try {
    const lastSeenRaw = await SystemConfig.get(LAST_SEEN_KEY, null);
    const lastSeen = lastSeenRaw?.at ? new Date(lastSeenRaw.at) : null;

    if (!lastSeen) return res.json({ mode: 'greeting_full', last_seen_at: null });

    const hoursSince = (Date.now() - lastSeen.getTime()) / 3600000;
    if (hoursSince < 0.17) return res.json({ mode: 'none', last_seen_at: lastSeen }); // <10 min
    if (hoursSince < GREETING_GAP_HOURS) return res.json({ mode: 'greeting_short', last_seen_at: lastSeen });
    return res.json({ mode: 'greeting_full', last_seen_at: lastSeen });
  } catch (err) {
    logger.error(`[ZEUS-CHAT] /greeting/check error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /greeting/seen — marca last_seen_at (al cerrar saludo) ═══
// Si body.reset === true, borra last_seen para forzar saludo completo la próxima.
router.post('/greeting/seen', async (req, res) => {
  try {
    if (req.body?.reset) {
      await SystemConfig.set(LAST_SEEN_KEY, { at: null });
    } else {
      await SystemConfig.set(LAST_SEEN_KEY, { at: new Date().toISOString() });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /greeting/stream?token=... — SSE streaming greeting ═══
router.get('/greeting/stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const lastSeenRaw = await SystemConfig.get(LAST_SEEN_KEY, null);
    const lastSeen = lastSeenRaw?.at ? new Date(lastSeenRaw.at) : null;
    const hoursSince = lastSeen ? (Date.now() - lastSeen.getTime()) / 3600000 : null;
    const mode = (!lastSeen || hoursSince >= GREETING_GAP_HOURS) ? 'greeting_full' : 'greeting_short';

    const conversationId = 'conv_' + crypto.randomBytes(8).toString('hex');
    sendEvent('start', { mode, conversation_id: conversationId });

    const result = await runOracle({
      userMessage: null,
      mode,
      history: [],
      lastSeenAt: lastSeen,
      onEvent: sendEvent
    });

    // Persist
    await ZeusChatMessage.create({
      conversation_id: conversationId,
      role: 'system_greeting',
      content: result.text,
      tool_calls: result.tool_calls,
      context_snapshot: result.context_snapshot,
      tokens_used: result.tokens_used,
      ai_model: result.model
    });

    // Update last_seen
    await SystemConfig.set(LAST_SEEN_KEY, { at: new Date().toISOString() });

    sendEvent('end', { conversation_id: conversationId });
  } catch (err) {
    logger.error(`[ZEUS-CHAT] /greeting/stream error: ${err.message}`);
    sendEvent('error', { error: err.message });
  } finally {
    res.end();
  }
});

// ═══ GET /chat/stream?conversation_id=&message=&token= — SSE chat ═══
router.get('/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let { conversation_id, message } = req.query;
    if (!message) {
      sendEvent('error', { error: 'message requerido' });
      return res.end();
    }

    if (!conversation_id) {
      conversation_id = 'conv_' + crypto.randomBytes(8).toString('hex');
    }

    // Load history
    const prev = await ZeusChatMessage.find({ conversation_id })
      .sort({ created_at: 1 })
      .limit(40)
      .lean();

    const history = [];
    for (const m of prev) {
      if (m.role === 'system_greeting' || m.role === 'assistant') {
        history.push({ role: 'assistant', content: m.content });
      } else if (m.role === 'user') {
        history.push({ role: 'user', content: m.content });
      }
    }

    sendEvent('start', { conversation_id });

    // Persist user message first
    await ZeusChatMessage.create({
      conversation_id,
      role: 'user',
      content: message
    });

    const result = await runOracle({
      userMessage: message,
      mode: 'chat',
      history,
      lastSeenAt: new Date(),
      onEvent: sendEvent
    });

    // Persist assistant response
    await ZeusChatMessage.create({
      conversation_id,
      role: 'assistant',
      content: result.text,
      tool_calls: result.tool_calls,
      tokens_used: result.tokens_used,
      ai_model: result.model
    });

    sendEvent('end', { conversation_id });
  } catch (err) {
    logger.error(`[ZEUS-CHAT] /chat/stream error: ${err.message}`);
    sendEvent('error', { error: err.message });
  } finally {
    res.end();
  }
});

// ═══ GET /chat/history?conversation_id=... ═══
router.get('/chat/history', async (req, res) => {
  try {
    const { conversation_id } = req.query;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id requerido' });

    const messages = await ZeusChatMessage.find({ conversation_id })
      .sort({ created_at: 1 })
      .limit(60)
      .lean();

    res.json({ conversation_id, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /chat/conversations — últimas conversaciones agrupadas ═══
router.get('/chat/conversations', async (req, res) => {
  try {
    const convs = await ZeusChatMessage.aggregate([
      { $sort: { created_at: -1 } },
      { $group: {
        _id: '$conversation_id',
        last_at: { $first: '$created_at' },
        first_at: { $last: '$created_at' },
        message_count: { $sum: 1 },
        preview: { $first: '$content' }
      }},
      { $sort: { last_at: -1 } },
      { $limit: 15 }
    ]);

    res.json({
      conversations: convs.map(c => ({
        conversation_id: c._id,
        last_at: c.last_at,
        first_at: c.first_at,
        message_count: c.message_count,
        preview: (c.preview || '').substring(0, 120)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /tts — ElevenLabs primario, OpenAI fallback ═══
router.post('/tts', async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text requerido' });
    }
    const clean = text.trim().substring(0, 4000);
    if (!clean) return res.status(400).json({ error: 'text vacío' });

    // Intento 1: ElevenLabs
    const elevenConfig = getElevenLabsConfig();
    if (elevenConfig) {
      try {
        const buffer = await synthesizeElevenLabs(clean, elevenConfig);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-TTS-Provider', 'elevenlabs');
        return res.send(buffer);
      } catch (elevenErr) {
        logger.warn(`[ZEUS-CHAT] ElevenLabs failed, intentando OpenAI: ${elevenErr.message}`);
      }
    }

    // Intento 2: OpenAI
    const openaiKey = getOpenAIKey();
    if (openaiKey) {
      try {
        const selectedVoice = OPENAI_VOICES.includes(voice) ? voice : DEFAULT_OPENAI_VOICE;
        const client = new OpenAI({ apiKey: openaiKey });
        const response = await client.audio.speech.create({
          model: 'tts-1-hd',
          voice: selectedVoice,
          input: clean,
          response_format: 'mp3',
          speed: 1.0
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-TTS-Provider', 'openai');
        return res.send(buffer);
      } catch (openaiErr) {
        logger.error(`[ZEUS-CHAT] OpenAI TTS también falló: ${openaiErr.message}`);
        return res.status(500).json({ error: openaiErr.message });
      }
    }

    return res.status(503).json({ error: 'No hay provider de TTS configurado (ELEVENLABS_API_KEY u OPENAI_API_KEY)' });
  } catch (err) {
    logger.error(`[ZEUS-CHAT] /tts error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

async function synthesizeElevenLabs(text, { apiKey, voiceId, model }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      }
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ${resp.status}: ${errText.substring(0, 200)}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = router;
