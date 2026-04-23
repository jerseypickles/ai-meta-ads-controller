const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../../utils/logger');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusPreference = require('../../db/models/ZeusPreference');
const ZeusStrategicPlan = require('../../db/models/ZeusStrategicPlan');
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

    // Reusar conversation_id existente si el cliente lo pasa — confiamos en el
    // cliente. Antes se hacía findOne() para validar la existencia pero eso causaba
    // que ante un lag de replica de Mongo Atlas (o una conv recién creada sin
    // mensajes persistidos aún) el server generara un conv_id NUEVO, el frontend
    // sobreescribiera LS_CONV_KEY y la conversación quedara abandonada.
    let conversationId = req.query.conversation_id || null;
    if (!conversationId) {
      conversationId = 'conv_' + crypto.randomBytes(8).toString('hex');
      logger.info(`[ZEUS-CHAT] /greeting/stream sin conv_id del cliente, generando ${conversationId}`);
    }

    // Computar lastSeen desde SystemConfig (mismo pattern que /greeting/check)
    const lastSeenRaw = await SystemConfig.get(LAST_SEEN_KEY, null);
    const lastSeen = lastSeenRaw?.at ? new Date(lastSeenRaw.at) : null;

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
      cache_read_tokens: result.cache_read_tokens || 0,
      cache_creation_tokens: result.cache_creation_tokens || 0,
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

    // Load history — últimos N mensajes (no los primeros N).
    // Bug histórico fijado 2026-04-21: antes hacía sort ASC + limit 40, que cargaba
    // los primeros 40 mensajes de la conversación (el inicio), no los últimos. En
    // conversaciones largas Zeus respondía basado en el arranque del hilo, no en
    // el thread reciente. Eso causaba history-pull dominante de temas antiguos.
    //
    // Fix: sort DESC + limit 18 + reverse → últimos 18 en orden cronológico.
    // Trim a 18 (de 40) para que debates largos no dominen el context y Zeus
    // pueda respetar la REGLA #1 del persona (scope drift).
    const prev = (await ZeusChatMessage.find({ conversation_id })
      .sort({ created_at: -1 })
      .limit(18)
      .lean()).reverse();

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
    const savedUser = await ZeusChatMessage.create({
      conversation_id,
      role: 'user',
      content: message
    });

    // Fix 2026-04-22: buffer el text_delta para poder persistir una respuesta
    // parcial si runOracle falla mid-stream (antes: user message quedaba
    // huérfano si el stream se cortaba, sin assistant response en DB).
    let partialText = '';
    const toolCallsPartial = [];
    const wrappedSend = (type, data) => {
      if (type === 'text_delta' && data?.text) partialText += data.text;
      if (type === 'tool_use_start') toolCallsPartial.push({ tool: data?.tool, at: new Date() });
      return sendEvent(type, data);
    };

    let result;
    try {
      result = await runOracle({
        userMessage: message,
        mode: 'chat',
        history,
        lastSeenAt: new Date(),
        uiContext,
        onEvent: wrappedSend
      });
    } catch (oracleErr) {
      // Runo falló mid-stream — persistir lo que alcanzamos a recibir
      logger.error(`[ZEUS-CHAT] runOracle falló: ${oracleErr.message}`);
      if (partialText.trim().length > 0) {
        try {
          await ZeusChatMessage.create({
            conversation_id,
            role: 'assistant',
            content: partialText,
            partial: true,
            partial_reason: oracleErr.message?.substring(0, 200) || 'stream_error',
            tool_calls: toolCallsPartial
          });
          logger.info(`[ZEUS-CHAT] persistí respuesta parcial (${partialText.length} chars) para conv ${conversation_id}`);
        } catch (saveErr) {
          logger.error(`[ZEUS-CHAT] fallé al persistir parcial: ${saveErr.message}`);
        }
      }
      throw oracleErr; // re-lanzo para que el catch exterior mande api_error
    }

    // Persist assistant response
    const savedAssistant = await ZeusChatMessage.create({
      conversation_id,
      role: 'assistant',
      content: result.text,
      followups: result.followups || [],
      tool_calls: result.tool_calls,
      tokens_used: result.tokens_used,
      cache_read_tokens: result.cache_read_tokens || 0,
      cache_creation_tokens: result.cache_creation_tokens || 0,
      ai_model: result.model
    });

    // Post-hoc self-audit (async, non-blocking) — Hilo B / Fase 1 + Hilo D / Phase 1
    // Incluye tool calls + context snapshot del turno para el linter de
    // unverified_self_assertion (detecta claims fácticos sin backing).
    try {
      const { auditResponsePostHoc } = require('../../ai/zeus/response-auditor');
      // Fire-and-forget; errores internos se loggean dentro del auditor.
      auditResponsePostHoc({
        userMessage: message,
        assistantResponse: result.text,
        conversation_id,
        message_id: savedAssistant._id,
        toolCallsExecuted: result.tool_calls || [],
        contextSnapshot: result.context_snapshot || null
      }).catch(err => logger.warn(`[ZEUS-CHAT] post-hoc audit dispatch failed: ${err.message}`));
    } catch (auditErr) {
      logger.warn(`[ZEUS-CHAT] post-hoc audit require/dispatch failed: ${auditErr.message}`);
    }

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

    // Fix 2026-04-22: traer los ÚLTIMOS 60 mensajes, no los primeros. Antes era
    // sort ASC + limit 60 → en conversaciones con >60 turnos, después de refresh
    // el usuario veía el inicio del hilo y los mensajes recientes quedaban
    // invisibles (aunque sí persistidos en MongoDB). Mismo patrón que ya estaba
    // aplicado en /chat/stream para cargar history al LLM.
    const total = await ZeusChatMessage.countDocuments({ conversation_id });
    const recent = await ZeusChatMessage.find({ conversation_id })
      .sort({ created_at: -1 })
      .limit(60)
      .lean();
    const messages = recent.reverse();

    res.json({ conversation_id, messages, total, truncated: total > 60 });
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

// Strip markdown básico para previews de notificaciones
function stripMarkdownForPreview(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '')              // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // bold
    .replace(/\*([^*]+)\*/g, '$1')               // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links — keep label
    .replace(/^#+\s+/gm, '')                     // headings
    .replace(/^>\s+/gm, '')                      // blockquotes
    .replace(/---FOLLOWUPS---[\s\S]*?---END---/g, '') // followups block
    .replace(/\n+/g, ' ')                        // collapse newlines
    .replace(/\s+/g, ' ')                        // collapse spaces
    .trim();
}

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
        preview: stripMarkdownForPreview(latest.content || '').substring(0, 120),
        full: (latest.content || '').substring(0, 400),
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

    // Trigger verificación automática cuando se marca 'applied'
    if (status === 'applied') {
      try {
        const { onCodeRecApplied } = require('../../ai/zeus/rec-verifier');
        const verification = await onCodeRecApplied(rec);
        return res.json({ ...rec.toObject(), verification });
      } catch (verifyErr) {
        logger.error(`[REC-VERIFY] ${verifyErr.message}`);
      }
    }

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
    const { category, include_inactive, status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    else if (!include_inactive) filter.active = true;
    if (category && category !== 'all') filter.category = category;
    const prefs = await ZeusPreference.find(filter).sort({ status: 1, category: 1, updated_at: -1 }).lean();

    // Contar proposed separado para badge
    const proposedCount = await ZeusPreference.countDocuments({ status: 'proposed' });

    res.json({ preferences: prefs, proposed_count: proposedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /preferences/:id/decide — confirmar/rechazar un draft auto-detected ═══
router.post('/preferences/:id/decide', async (req, res) => {
  try {
    const { decision, note, value, category, context } = req.body || {};
    if (!['accept', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision debe ser accept o reject' });
    }
    const pref = await ZeusPreference.findById(req.params.id);
    if (!pref) return res.status(404).json({ error: 'No encontrada' });
    if (pref.status !== 'proposed') return res.status(400).json({ error: 'ya fue decidida' });

    // Permite editar value/category/context al aceptar
    if (decision === 'accept') {
      if (value) pref.value = value;
      if (category) pref.category = category;
      if (context) pref.context = context;
      pref.status = 'active';
      pref.active = true;
    } else {
      pref.status = 'rejected';
      pref.active = false;
    }
    pref.decided_at = new Date();
    pref.decision_note = note || '';
    pref.updated_at = new Date();
    await pref.save();
    res.json(pref);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /preferences/detect — dispara detector manual ═══
router.post('/preferences/detect', async (req, res) => {
  try {
    const { detectPreferences } = require('../../ai/zeus/preference-detector');
    const result = await detectPreferences();
    res.json(result);
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

// ═══ GET /strategic-plans — lista planes (weekly/monthly/quarterly) ═══
router.get('/strategic-plans', async (req, res) => {
  try {
    const { horizon, status } = req.query;
    const filter = {};
    if (horizon && horizon !== 'all') filter.horizon = horizon;
    if (status && status !== 'all') filter.status = status;
    else filter.status = { $in: ['draft', 'active'] };

    const plans = await ZeusStrategicPlan.find(filter)
      .sort({ generated_at: -1 })
      .limit(20)
      .lean();

    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /strategic-plans/:id ═══
router.get('/strategic-plans/:id', async (req, res) => {
  try {
    const plan = await ZeusStrategicPlan.findById(req.params.id).lean();
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /strategic-plans/:id/approve ═══
router.post('/strategic-plans/:id/approve', async (req, res) => {
  try {
    const { adjustments } = req.body || {};
    const plan = await ZeusStrategicPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });

    await ZeusStrategicPlan.updateMany(
      { horizon: plan.horizon, status: 'active', _id: { $ne: plan._id } },
      { $set: { status: 'superseded' } }
    );

    plan.status = 'active';
    plan.approved_by_creator = true;
    plan.approved_at = new Date();
    if (adjustments) plan.creator_adjustments = adjustments;
    await plan.save();

    // Propagar plan → directivas operativas a cada agente
    let propagation = null;
    try {
      const { propagatePlan } = require('../../ai/zeus/plan-propagator');
      propagation = await propagatePlan(plan);
    } catch (propErr) {
      logger.error(`[PLAN-APPROVE] Propagation falló: ${propErr.message}`);
    }

    res.json({ ok: true, plan, propagation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /strategic-plans/generate ═══
router.post('/strategic-plans/generate', async (req, res) => {
  try {
    const { horizon } = req.body || {};
    if (!['weekly', 'monthly', 'quarterly'].includes(horizon)) {
      return res.status(400).json({ error: 'horizon inválido' });
    }
    const { generatePlan } = require('../../ai/zeus/strategic-planner');
    const plan = await generatePlan(horizon);
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ DELETE /strategic-plans/:id ═══
router.delete('/strategic-plans/:id', async (req, res) => {
  try {
    await ZeusStrategicPlan.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /strategic-plans/:id/evaluate — trigger manual evaluación ═══
router.post('/strategic-plans/:id/evaluate', async (req, res) => {
  try {
    const { evaluatePlan } = require('../../ai/zeus/plan-evaluator');
    const plan = await ZeusStrategicPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    const evaluation = await evaluatePlan(plan.toObject());

    // Persistir
    plan.goals = evaluation.goals.map(g => ({
      metric: g.metric,
      target: g.target,
      current: g.current,
      baseline: g.baseline,
      priority: g.priority,
      by_date: g.by_date,
      progress_pct: g.progress_pct,
      trajectory_pct: g.trajectory_pct,
      status: g.status
    }));
    plan.milestones = evaluation.milestones.map(m => ({
      description: m.description,
      by_date: m.by_date,
      status: m.status,
      achieved_at: m.achieved_at
    }));
    plan.last_evaluation = {
      at: evaluation.evaluated_at,
      health_score: evaluation.health_score,
      health_status: evaluation.health_status,
      summary: evaluation.summary
    };
    await plan.save();
    res.json({ ok: true, plan, evaluation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /strategic-plans/:id/milestones/:index/mark — manual achieved/missed ═══
router.post('/strategic-plans/:id/milestones/:index/mark', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['achieved', 'missed', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    const plan = await ZeusStrategicPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    const idx = parseInt(req.params.index);
    if (!plan.milestones[idx]) return res.status(404).json({ error: 'Milestone no encontrado' });

    plan.milestones[idx].status = status;
    plan.milestones[idx].achieved_at = status === 'achieved' ? new Date() : null;
    await plan.save();
    res.json({ ok: true, milestone: plan.milestones[idx] });
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

// ═══ GET /seasonal-events — lista calendario ═══
router.get('/seasonal-events', async (req, res) => {
  try {
    const SeasonalEvent = require('../../db/models/SeasonalEvent');
    const { getUpcomingEvents } = require('../../ai/zeus/seasonal-calendar');
    const [all, upcoming] = await Promise.all([
      SeasonalEvent.find({}).sort({ priority: 1, month: 1, day: 1 }).lean(),
      getUpcomingEvents(parseInt(req.query.days_ahead) || 120)
    ]);
    res.json({ all, upcoming });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /seasonal-events/:id/toggle — activar/desactivar un evento ═══
router.post('/seasonal-events/:id/toggle', async (req, res) => {
  try {
    const SeasonalEvent = require('../../db/models/SeasonalEvent');
    const ev = await SeasonalEvent.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'No encontrado' });
    ev.activated = !ev.activated;
    ev.updated_at = new Date();
    await ev.save();
    res.json({ ok: true, event: ev });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ Architecture Proposals (Lens 3) ═══
router.get('/architecture-proposals', async (req, res) => {
  try {
    const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
    const { status } = req.query;
    const query = status && status !== 'all' ? { status } : {};
    const proposals = await ZeusArchitectureProposal.find(query)
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    const counts = await ZeusArchitectureProposal.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const countsMap = counts.reduce((acc, c) => { acc[c._id] = c.count; return acc; }, {});
    res.json({ proposals, counts: countsMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/architecture-proposals/:id/decide', async (req, res) => {
  try {
    const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
    const { decision, note } = req.body;
    const p = await ZeusArchitectureProposal.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'No encontrada' });
    p.creator_decision = decision || '';
    p.creator_note = note || '';
    p.decided_at = new Date();
    if (decision === 'no-op' || decision === 'reject') p.status = 'rejected';
    else if (decision === 'accepted' || (decision && decision !== 'no-op')) p.status = 'accepted';
    await p.save();
    res.json({ ok: true, proposal: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/architecture-proposals/:id/mark-built', async (req, res) => {
  try {
    const ZeusArchitectureProposal = require('../../db/models/ZeusArchitectureProposal');
    const p = await ZeusArchitectureProposal.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'No encontrada' });
    p.status = 'built';
    p.built_at = new Date();
    await p.save();

    // Trigger verificación automática (architectural)
    let verification = null;
    try {
      const { onArchitectureBuilt } = require('../../ai/zeus/rec-verifier');
      verification = await onArchitectureBuilt(p);
    } catch (verifyErr) {
      logger.error(`[ARCH-VERIFY] ${verifyErr.message}`);
    }

    res.json({ ok: true, proposal: p, verification });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/architecture-proposals/generate', async (req, res) => {
  try {
    const { runArchitectReflection } = require('../../ai/zeus/architect');
    const result = await runArchitectReflection({ kind: 'manual' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ Agent Stances (Fase 1+2 — morning briefing + override + calibración) ═══
router.get('/agent-stances', async (req, res) => {
  try {
    const ZeusAgentStance = require('../../db/models/ZeusAgentStance');
    const { getCurrentStance } = require('../../ai/zeus/agent-stance');
    const agents = ZeusAgentStance.AGENTS;
    const current = {};
    for (const a of agents) {
      current[a] = await getCurrentStance(a);
    }
    res.json({ current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/agent-stances/:agent/history', async (req, res) => {
  try {
    const ZeusAgentStance = require('../../db/models/ZeusAgentStance');
    const limit = Math.min(50, parseInt(req.query.limit) || 14);
    const history = await ZeusAgentStance.find({ agent: req.params.agent })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agent-stances/override', async (req, res) => {
  try {
    const { agent, stance, focus, reason, expires_in_hours } = req.body || {};
    if (!agent || !stance) return res.status(400).json({ error: 'agent y stance requeridos' });
    const { setOverride } = require('../../ai/zeus/agent-stance');
    const created = await setOverride({ agent, stance, focus, reason, expires_in_hours, by: 'creator' });
    res.json({ ok: true, stance: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agent-stances/:id/renew', async (req, res) => {
  try {
    const { additional_hours } = req.body || {};
    const { renewStance } = require('../../ai/zeus/agent-stance');
    const updated = await renewStance(req.params.id, additional_hours || 24);
    res.json({ ok: true, stance: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agent-stances/briefing/:agent', async (req, res) => {
  try {
    const { runMorningBriefing } = require('../../ai/zeus/agent-stance');
    const stance = await runMorningBriefing(req.params.agent);
    res.json({ ok: true, stance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ Response Calibration (Hilo B) ═══

// GET /api/zeus/calibration/entries — listar journal entries con filtros
//   query: ?type=reference_response|anti_reference_response|trap_execution|audit_report&limit=50
router.get('/calibration/entries', async (req, res) => {
  try {
    const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
    const { type, principle, limit } = req.query;
    const filter = {};
    if (type && type !== 'all') filter.entry_type = type;
    if (principle) filter.violated_principles = principle;
    const entries = await ZeusJournalEntry.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200))
      .lean();
    // Counts por tipo para el panel
    const counts = await ZeusJournalEntry.aggregate([
      { $group: { _id: '$entry_type', count: { $sum: 1 } } }
    ]);
    const countsMap = counts.reduce((acc, c) => { acc[c._id] = c.count; return acc; }, {});
    res.json({ entries, counts: countsMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zeus/calibration/entries/:id
router.get('/calibration/entries/:id', async (req, res) => {
  try {
    const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
    const entry = await ZeusJournalEntry.findById(req.params.id).lean();
    if (!entry) return res.status(404).json({ error: 'no encontrado' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/calibration/entries/:id/promote — marcar un entry como reference o anti-reference manualmente
router.post('/calibration/entries/:id/promote', async (req, res) => {
  try {
    const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
    const { mark, principles, failure_mode, correction_learned } = req.body || {};
    // mark: 'reference' | 'anti_reference' | 'clear'
    const entry = await ZeusJournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'no encontrado' });
    if (mark === 'reference') {
      entry.is_reference_response = true;
      entry.is_anti_reference_response = false;
      if (entry.entry_type !== 'reference_response') entry.entry_type = 'reference_response';
      if (Array.isArray(principles)) entry.principles_exemplified = principles;
    } else if (mark === 'anti_reference') {
      entry.is_anti_reference_response = true;
      entry.is_reference_response = false;
      if (entry.entry_type !== 'anti_reference_response') entry.entry_type = 'anti_reference_response';
      if (Array.isArray(principles)) entry.violated_principles = principles;
      if (failure_mode) entry.failure_mode = failure_mode;
      if (correction_learned) entry.correction_learned = correction_learned;
    } else if (mark === 'clear') {
      entry.is_reference_response = false;
      entry.is_anti_reference_response = false;
    }
    await entry.save();
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/zeus/calibration/entries/:id
router.delete('/calibration/entries/:id', async (req, res) => {
  try {
    const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
    await ZeusJournalEntry.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zeus/calibration/traps — listar trampas con filtros
router.get('/calibration/traps', async (req, res) => {
  try {
    const ZeusTrap = require('../../db/models/ZeusTrap');
    const { status, outcome, limit } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (outcome && outcome !== 'all') filter.outcome = outcome;
    const traps = await ZeusTrap.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(parseInt(limit) || 40, 100))
      .lean();
    // Counts últimos 90d
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
    const countsAgg = await ZeusTrap.aggregate([
      { $match: { executed_at: { $gte: ninetyDaysAgo } } },
      { $group: { _id: '$outcome', count: { $sum: 1 } } }
    ]);
    const counts90d = countsAgg.reduce((acc, c) => { acc[c._id || 'pending'] = c.count; return acc; }, {});
    res.json({ traps, counts_90d: counts90d });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/calibration/traps — crear trampa
router.post('/calibration/traps', async (req, res) => {
  try {
    const ZeusTrap = require('../../db/models/ZeusTrap');
    const { content, expected_contradiction, source, created_by, category, expected_tool_invocation } = req.body || {};
    if (!content || !expected_contradiction) return res.status(400).json({ error: 'content y expected_contradiction requeridos' });
    if (!['creator', 'team', 'adversarial_llm'].includes(source)) return res.status(400).json({ error: 'source inválido' });
    const trap = await ZeusTrap.create({
      content,
      expected_contradiction,
      source,
      created_by: created_by || '',
      category: category || '',
      expected_tool_invocation: expected_tool_invocation || ''
    });
    res.json({ ok: true, trap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/calibration/traps/:id/execute — ejecutar trampa
router.post('/calibration/traps/:id/execute', async (req, res) => {
  try {
    const { executeTrap } = require('../../ai/zeus/trap-runner');
    const trap = await executeTrap(req.params.id);
    res.json({ ok: true, trap });
  } catch (err) {
    logger.error(`[CALIBRATION] execute trap ${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/zeus/calibration/traps/:id
router.delete('/calibration/traps/:id', async (req, res) => {
  try {
    const ZeusTrap = require('../../db/models/ZeusTrap');
    await ZeusTrap.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/calibration/audit/run — trigger manual de la auditoría trimestral
router.post('/calibration/audit/run', async (req, res) => {
  try {
    const { runQuarterlyAudit } = require('../../ai/zeus/response-auditor');
    const report = await runQuarterlyAudit({ manual: true });
    res.json({ ok: true, report });
  } catch (err) {
    logger.error(`[CALIBRATION] manual audit failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ Auto-Pause endpoints (Hilo C) ═══

// GET /api/zeus/auto-pause/status — modo actual + stats recientes
router.get('/auto-pause/status', async (req, res) => {
  try {
    const { getMode, isYellowZoneActive, autopausesTodayCount } = require('../../ai/zeus/auto-pause-executor');
    const { computeFPRate } = require('../../ai/zeus/auto-pause-maintenance');
    const ZeusAutoPauseShadowLog = require('../../db/models/ZeusAutoPauseShadowLog');
    const ZeusAutoPauseLog = require('../../db/models/ZeusAutoPauseLog');

    const [mode, yellow, todayCount, fpStats, shadowCount, shadowVerdicts, liveCount, liveVerdicts] = await Promise.all([
      getMode(),
      isYellowZoneActive(),
      autopausesTodayCount(),
      computeFPRate(),
      ZeusAutoPauseShadowLog.countDocuments({}),
      ZeusAutoPauseShadowLog.aggregate([{ $group: { _id: '$verdict', count: { $sum: 1 } } }]),
      ZeusAutoPauseLog.countDocuments({}),
      ZeusAutoPauseLog.aggregate([{ $group: { _id: '$verdict', count: { $sum: 1 } } }])
    ]);

    res.json({
      mode,
      yellow_zone_active: yellow,
      today_count: todayCount,
      daily_cap: 3,
      fp_stats: fpStats,
      shadow: {
        total: shadowCount,
        by_verdict: shadowVerdicts.reduce((acc, v) => { acc[v._id || 'pending'] = v.count; return acc; }, {})
      },
      live: {
        total: liveCount,
        by_verdict: liveVerdicts.reduce((acc, v) => { acc[v._id || 'pending'] = v.count; return acc; }, {})
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/auto-pause/mode — cambiar modo (disabled/shadow/live)
router.post('/auto-pause/mode', async (req, res) => {
  try {
    const { mode, reason } = req.body || {};
    if (!['disabled', 'shadow', 'live'].includes(mode)) {
      return res.status(400).json({ error: 'mode inválido: disabled | shadow | live' });
    }
    const { setMode } = require('../../ai/zeus/auto-pause-executor');
    await setMode(mode, reason || 'manual toggle');
    res.json({ ok: true, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/auto-pause/yellow-zone/clear — limpiar yellow zone manual
router.post('/auto-pause/yellow-zone/clear', async (req, res) => {
  try {
    const { clearYellowZone } = require('../../ai/zeus/auto-pause-executor');
    await clearYellowZone();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zeus/auto-pause/shadow-logs?limit=&verdict= — lista shadow logs
router.get('/auto-pause/shadow-logs', async (req, res) => {
  try {
    const ZeusAutoPauseShadowLog = require('../../db/models/ZeusAutoPauseShadowLog');
    const { limit, verdict } = req.query;
    const filter = {};
    if (verdict && verdict !== 'all') filter.verdict = verdict;
    const logs = await ZeusAutoPauseShadowLog.find(filter)
      .sort({ detected_at: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200))
      .lean();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zeus/auto-pause/logs?limit=&verdict= — lista live auto-pause logs
router.get('/auto-pause/logs', async (req, res) => {
  try {
    const ZeusAutoPauseLog = require('../../db/models/ZeusAutoPauseLog');
    const { limit, verdict } = req.query;
    const filter = {};
    if (verdict && verdict !== 'all') filter.verdict = verdict;
    const logs = await ZeusAutoPauseLog.find(filter)
      .sort({ paused_at: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200))
      .lean();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/auto-pause/logs/:id/reactivate — registrar reactivación manual (creator)
router.post('/auto-pause/logs/:id/reactivate', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const ZeusAutoPauseLog = require('../../db/models/ZeusAutoPauseLog');
    const log = await ZeusAutoPauseLog.findById(req.params.id);
    if (!log) return res.status(404).json({ error: 'no encontrado' });
    if (log.reactivated_at) return res.status(400).json({ error: 'ya reactivado' });
    // Ejecutar reactivación en Meta
    try {
      const client = require('../../meta/client');
      if (typeof client.updateAdSet === 'function') {
        await client.updateAdSet(log.adset_id, { status: 'ACTIVE' });
      }
    } catch (metaErr) {
      logger.warn(`[AUTO-PAUSE] Meta reactivate failed: ${metaErr.message}`);
    }
    const { recordReactivation } = require('../../ai/zeus/auto-pause-executor');
    await recordReactivation({ adset_id: log.adset_id, reactivated_by: 'creator', reason: reason || '' });
    const updated = await ZeusAutoPauseLog.findById(log._id).lean();
    res.json({ ok: true, log: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zeus/auto-pause/health/run — correr health check manual
router.post('/auto-pause/health/run', async (req, res) => {
  try {
    const { runHealthCheckCron } = require('../../ai/zeus/auto-pause-maintenance');
    const report = await runHealthCheckCron();
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zeus/entity/adset/:id/detail — drill-in del adset para cards inline en el chat.
// Devuelve la misma data que el tool query_adset_detail pero vía HTTP directo (sin LLM).
router.get('/entity/adset/:id/detail', async (req, res) => {
  try {
    const { getLatestSnapshots, getSnapshotHistory, getAdsForAdSet } = require('../../db/queries');
    const ActionLog = require('../../db/models/ActionLog');
    const BrainMemory = require('../../db/models/BrainMemory');
    const TestRun = require('../../db/models/TestRun');

    const adsetId = req.params.id;
    const days = Math.min(parseInt(req.query.days || '14', 10), 90);

    // Resolver adset snapshot
    const adsetSnapshots = await getLatestSnapshots('adset');
    const match = adsetSnapshots.find(s => s.entity_id === adsetId);
    if (!match) return res.status(404).json({ error: 'adset no encontrado' });

    // Ads adentro + history + actions + tests + memory en paralelo
    const [adsRaw, history, actions, tests, memory] = await Promise.all([
      getAdsForAdSet(adsetId).catch(() => []),
      getSnapshotHistory(adsetId, days).catch(() => []),
      ActionLog.find({ entity_id: adsetId, success: true })
        .sort({ executed_at: -1 }).limit(10).lean().catch(() => []),
      TestRun.find({ source_adset_id: adsetId })
        .sort({ launched_at: -1 }).limit(5).lean().catch(() => []),
      BrainMemory.findOne({ entity_id: adsetId }).lean().catch(() => null)
    ]);

    const adsInside = adsRaw.map(s => {
      const m7 = s.metrics?.last_7d || {};
      const mToday = s.metrics?.today || {};
      const roas7d = m7.spend > 0 ? (m7.purchase_value || 0) / m7.spend : 0;
      return {
        id: s.entity_id,
        name: s.entity_name,
        status: s.status,
        spend_today: Math.round(mToday.spend || 0),
        spend_7d: Math.round(m7.spend || 0),
        roas_7d: +roas7d.toFixed(2),
        purchases_7d: m7.purchases || 0,
        ctr: +(m7.ctr || 0).toFixed(2),
        frequency: +(m7.frequency || 0).toFixed(2)
      };
    }).sort((a, b) => b.spend_7d - a.spend_7d);

    const mToday = match.metrics?.today || {};
    const m3 = match.metrics?.last_3d || {};
    const m7 = match.metrics?.last_7d || {};
    const m14 = match.metrics?.last_14d || {};

    function windowMetrics(m) {
      const spend = m.spend || 0;
      const revenue = m.purchase_value || 0;
      const purchases = m.purchases || 0;
      return {
        spend: Math.round(spend),
        revenue: Math.round(revenue),
        roas: spend > 0 ? +(revenue / spend).toFixed(2) : 0,
        purchases,
        cpa: purchases > 0 ? +(spend / purchases).toFixed(2) : null,
        ctr: +(m.ctr || 0).toFixed(2),
        frequency: +(m.frequency || 0).toFixed(2)
      };
    }

    // Serie diaria — agrupar snapshots por día (último snapshot de cada día)
    // y calcular spend/revenue/roas del día usando metrics.today
    const byDay = new Map();
    for (const snap of history) {
      const day = new Date(snap.snapshot_at).toISOString().slice(0, 10);
      // Tomamos el último snapshot del día (history viene ASC, así sobrescribimos)
      byDay.set(day, snap);
    }
    const dailyHistory = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, snap]) => {
        const t = snap.metrics?.today || {};
        const spend = t.spend || 0;
        const revenue = t.purchase_value || 0;
        return {
          date,
          spend: Math.round(spend),
          revenue: Math.round(revenue),
          roas: spend > 0 ? +(revenue / spend).toFixed(2) : 0,
          purchases: t.purchases || 0
        };
      });

    res.json({
      entity: {
        id: match.entity_id,
        name: match.entity_name,
        campaign_id: match.campaign_id,
        status: match.status,
        daily_budget: match.daily_budget,
        learning_stage: match.learning_stage,
        learning_conversions: match.learning_conversions
      },
      windows: {
        today: windowMetrics(mToday),
        last_3d: windowMetrics(m3),
        last_7d: windowMetrics(m7),
        last_14d: windowMetrics(m14)
      },
      daily_history: dailyHistory,
      ads: adsInside,
      ads_count: adsInside.length,
      recent_actions: actions.map(a => ({
        action: a.action,
        agent: a.agent_type,
        executed_at: a.executed_at,
        reasoning: a.reasoning?.substring(0, 200),
        before_value: a.before_value,
        after_value: a.after_value,
        impact_7d_roas_delta: a.impact_7d?.roas_delta ?? null
      })),
      tests: tests.map(t => ({
        id: t._id,
        phase: t.phase,
        launched_at: t.launched_at,
        roas: t.metrics?.roas,
        purchases: t.metrics?.purchases
      })),
      brain_memory: memory ? {
        // Assessment operativo del Account Agent
        assessment: memory.agent_assessment || '',
        frequency_status: memory.agent_frequency_status,
        creative_health: memory.agent_creative_health || '',
        needs_new_creatives: !!memory.agent_needs_new_creatives,
        performance_trend: memory.agent_performance_trend,
        pending_plan: memory.agent_pending_plan || '',
        last_check: memory.agent_last_check,
        next_review_at: memory.agent_next_review_at,
        // Tendencias observadas
        trends: memory.trends || null,
        // Métricas que el brain recordaba la última vez
        remembered_metrics: memory.remembered_metrics || null,
        // Historial de acciones con resultado medido — últimas 8
        action_history: (memory.action_history || []).slice(-8).reverse().map(a => ({
          action_type: a.action_type,
          executed_at: a.executed_at,
          result: a.result,
          roas_delta_pct: a.roas_delta_pct,
          cpa_delta_pct: a.cpa_delta_pct,
          context: a.context,
          attribution: a.attribution
        })),
        action_count: memory.action_history?.length || 0,
        insights_generated: memory.insights_generated || 0,
        last_insight_at: memory.last_insight_at,
        last_updated: memory.last_updated_at
      } : null
    });
  } catch (err) {
    logger.error(`[ZEUS entity/adset/detail] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
