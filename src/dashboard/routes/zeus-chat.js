const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../../utils/logger');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const SystemConfig = require('../../db/models/SystemConfig');
const { runOracle } = require('../../ai/zeus/oracle-runner');

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

module.exports = router;
