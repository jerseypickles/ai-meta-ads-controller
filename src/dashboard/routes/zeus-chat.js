const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../../utils/logger');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusPreference = require('../../db/models/ZeusPreference');
const SystemConfig = require('../../db/models/SystemConfig');
const { runOracle } = require('../../ai/zeus/oracle-runner');

const LAST_SEEN_KEY = 'zeus_oracle_last_seen';
const GREETING_GAP_HOURS = 12;  // Saludo full una vez por día

// ═══ POST /greeting/check — decide si saludar o mostrar banner ═══
router.post('/greeting/check', async (req, res) => {
  try {
    const lastSeenRaw = await SystemConfig.get(LAST_SEEN_KEY, null);
    const lastSeen = lastSeenRaw?.at ? new Date(lastSeenRaw.at) : null;

    if (!lastSeen) return res.json({ mode: 'greeting_full', last_seen_at: null });

    const hoursSince = (Date.now() - lastSeen.getTime()) / 3600000;
    // Con persistencia de chat, el saludo corto repetido es ruidoso.
    // Solo saludamos completo si pasó el GAP (default 12h = una vez por día).
    // En cualquier caso menor, el banner colapsado alcanza.
    if (hoursSince >= GREETING_GAP_HOURS) {
      return res.json({ mode: 'greeting_full', last_seen_at: lastSeen });
    }
    return res.json({ mode: 'none', last_seen_at: lastSeen });
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

// ═══ GET /greeting/stream?token=&conversation_id=... — SSE streaming greeting ═══
router.get('/greeting/stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Chunk de padding inicial para que proxies abran el stream inmediatamente
  res.write(': ' + ' '.repeat(2048) + '\n\n');

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    // Con persistencia de chat, solo saludamos completo (una vez por día).
    const mode = 'greeting_full';

    // Reusar conversation_id existente si el cliente lo pasa y es válido;
    // si no, crear uno nuevo.
    let conversationId = req.query.conversation_id || null;
    if (conversationId) {
      const exists = await ZeusChatMessage.findOne({ conversation_id: conversationId }).select('_id').lean();
      if (!exists) conversationId = null;
    }
    if (!conversationId) {
      conversationId = 'conv_' + crypto.randomBytes(8).toString('hex');
    }

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
      followups: result.followups || [],
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
  // Chunk de padding inicial para que proxies abran el stream inmediatamente
  res.write(': ' + ' '.repeat(2048) + '\n\n');

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    let { conversation_id, message, ui_context } = req.query;
    if (!message) {
      sendEvent('error', { error: 'message requerido' });
      return res.end();
    }

    let uiContext = null;
    if (ui_context) {
      try { uiContext = JSON.parse(ui_context); } catch (_) {}
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
      uiContext,
      onEvent: sendEvent
    });

    // Persist assistant response
    await ZeusChatMessage.create({
      conversation_id,
      role: 'assistant',
      content: result.text,
      followups: result.followups || [],
      tool_calls: result.tool_calls,
      tokens_used: result.tokens_used,
      ai_model: result.model
    });

    sendEvent('end', { conversation_id });
  } catch (err) {
    logger.error(`[ZEUS-CHAT] /chat/stream error: ${err.message} ${err.stack?.substring(0, 300)}`);
    sendEvent('api_error', { error: err.message });
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

// ═══ GET /chat/unread — cuenta mensajes proactivos no leídos ═══
router.get('/chat/unread', async (req, res) => {
  try {
    const count = await ZeusChatMessage.countDocuments({
      proactive: true,
      read_at: null
    });
    const latest = await ZeusChatMessage.findOne({ proactive: true, read_at: null })
      .sort({ created_at: -1 })
      .select('content conversation_id created_at')
      .lean();
    res.json({
      unread: count,
      latest: latest ? {
        conversation_id: latest.conversation_id,
        preview: (latest.content || '').substring(0, 200),
        created_at: latest.created_at
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /chat/mark-read — marca todos los proactivos como leídos ═══
router.post('/chat/mark-read', async (req, res) => {
  try {
    const { conversation_id } = req.body || {};
    const filter = { proactive: true, read_at: null };
    if (conversation_id) filter.conversation_id = conversation_id;
    const result = await ZeusChatMessage.updateMany(filter, { $set: { read_at: new Date() } });
    res.json({ marked: result.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /code-recs — lista recomendaciones de código ═══
router.get('/code-recs', async (req, res) => {
  try {
    const { status, category, severity, limit } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (category && category !== 'all') filter.category = category;
    if (severity && severity !== 'all') filter.severity = severity;

    const recs = await ZeusCodeRecommendation.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200))
      .lean();

    // Counts por status para el panel
    const counts = await ZeusCodeRecommendation.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const countsByStatus = counts.reduce((acc, c) => { acc[c._id] = c.count; return acc; }, {});

    res.json({ recs, counts: countsByStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /code-recs/:id — detalle ═══
router.get('/code-recs/:id', async (req, res) => {
  try {
    const rec = await ZeusCodeRecommendation.findById(req.params.id).lean();
    if (!rec) return res.status(404).json({ error: 'No encontrado' });
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ PATCH /code-recs/:id — cambia status (accept/reject/apply) ═══
router.patch('/code-recs/:id', async (req, res) => {
  try {
    const { status, review_note } = req.body || {};
    if (!['pending', 'accepted', 'rejected', 'applied'].includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    const update = { status, reviewed_at: new Date() };
    if (review_note !== undefined) update.review_note = review_note;
    const rec = await ZeusCodeRecommendation.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!rec) return res.status(404).json({ error: 'No encontrado' });
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ DELETE /code-recs/:id ═══
router.delete('/code-recs/:id', async (req, res) => {
  try {
    await ZeusCodeRecommendation.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /preferences — memoria persistente del creador ═══
router.get('/preferences', async (req, res) => {
  try {
    const { category, include_inactive } = req.query;
    const filter = include_inactive ? {} : { active: true };
    if (category && category !== 'all') filter.category = category;
    const prefs = await ZeusPreference.find(filter).sort({ category: 1, updated_at: -1 }).lean();
    res.json({ preferences: prefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ PATCH /preferences/:id — editar/reactivar ═══
router.patch('/preferences/:id', async (req, res) => {
  try {
    const allowed = ['value', 'category', 'context', 'confidence', 'active'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    update.updated_at = new Date();
    const pref = await ZeusPreference.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!pref) return res.status(404).json({ error: 'No encontrado' });
    res.json(pref);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /authorities — lista execution authorities (Nivel 5) ═══
router.get('/authorities', async (req, res) => {
  try {
    const { getAllAuthorities } = require('../../ai/zeus/execution-gate');
    const authorities = await getAllAuthorities();
    res.json({ authorities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /authorities/enable — habilita una categoría ═══
router.post('/authorities/enable', async (req, res) => {
  try {
    const { category, min_confidence, min_calibration_samples, max_impact_per_exec, max_per_day, reason } = req.body || {};
    if (!category) return res.status(400).json({ error: 'category requerido' });
    const { enableAuthority } = require('../../ai/zeus/execution-gate');
    const auth = await enableAuthority(category, {
      min_confidence, min_calibration_samples, max_impact_per_exec, max_per_day,
      enabled_by: 'creator_api', reason
    });
    res.json({ ok: true, authority: auth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /authorities/disable ═══
router.post('/authorities/disable', async (req, res) => {
  try {
    const { category, reason } = req.body || {};
    if (!category) return res.status(400).json({ error: 'category requerido' });
    const { disableAuthority } = require('../../ai/zeus/execution-gate');
    await disableAuthority(category, reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ DELETE /preferences/:id — olvidar del todo ═══
router.delete('/preferences/:id', async (req, res) => {
  try {
    await ZeusPreference.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
