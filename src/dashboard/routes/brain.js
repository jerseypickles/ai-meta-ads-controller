const express = require('express');
const router = express.Router();
const BrainAnalyzer = require('../../ai/brain/brain-analyzer');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainChat = require('../../db/models/BrainChat');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const BrainKnowledgeSnapshot = require('../../db/models/BrainKnowledgeSnapshot');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');
const BrainCycleMemory = require('../../db/models/BrainCycleMemory');
const BrainTemporalPattern = require('../../db/models/BrainTemporalPattern');
const logger = require('../../utils/logger');

const analyzer = new BrainAnalyzer();

// ═══ INSIGHTS ═══

/**
 * GET /api/brain/insights — Lista de insights paginados
 * Query: ?page=1&limit=20&type=anomaly&severity=high
 */
router.get('/insights', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.type) filter.insight_type = req.query.type;
    if (req.query.severity) filter.severity = req.query.severity;
    if (req.query.entity_id) filter['entities.entity_id'] = req.query.entity_id;

    const [insights, total] = await Promise.all([
      BrainInsight.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit)
        .populate('related_recommendation', 'title action_type status entity priority')
        .lean(),
      BrainInsight.countDocuments(filter)
    ]);

    res.json({
      insights,
      total,
      page,
      pages: Math.ceil(total / limit),
      unread: await BrainInsight.countDocuments({ ...filter, read: false })
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error obteniendo insights: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/insights/:id/read — Marcar insight como leído
 */
router.post('/insights/:id/read', async (req, res) => {
  try {
    await BrainInsight.updateOne(
      { _id: req.params.id },
      { $set: { read: true, read_at: new Date() } }
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/insights/read-all — Marcar todos como leídos
 */
router.post('/insights/read-all', async (req, res) => {
  try {
    const result = await BrainInsight.updateMany(
      { read: false },
      { $set: { read: true, read_at: new Date() } }
    );
    res.json({ ok: true, marked: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/analyze — Trigger manual de análisis
 */
router.post('/analyze', async (req, res) => {
  try {
    const result = await analyzer.analyze();
    res.json(result);
  } catch (error) {
    logger.error(`[BRAIN-API] Error en análisis manual: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ CHAT ═══

/**
 * POST /api/brain/chat — Enviar mensaje al Brain
 * Body: { message: "string" }
 */
router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    const result = await analyzer.chat(message.trim());
    res.json(result);
  } catch (error) {
    logger.error(`[BRAIN-API] Error en chat: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/chat/stream — Chat con streaming SSE word-by-word
 * Body: { message: "string" }
 */
router.post('/chat/stream', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Phase 1: thinking — data loading
    res.write(`data: ${JSON.stringify({ type: 'thinking', phase: 'loading', text: 'Cargando datos de campañas...' })}\n\n`);

    const { stream, onComplete } = await analyzer.chatStream(message.trim());

    // Phase 2: thinking — generating
    res.write(`data: ${JSON.stringify({ type: 'thinking', phase: 'generating', text: 'Analizando y formulando respuesta...' })}\n\n`);

    let fullText = '';
    let usage = null;

    stream.on('text', (text) => {
      fullText += text;
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    });

    stream.on('message', (msg) => {
      usage = msg.usage;
    });

    stream.on('end', async () => {
      try {
        await onComplete(fullText, usage);
        const tokensUsed = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
        res.write(`data: ${JSON.stringify({ type: 'done', tokens_used: tokensUsed })}\n\n`);
      } catch (saveErr) {
        logger.error(`[BRAIN-API] Error saving stream chat: ${saveErr.message}`);
        res.write(`data: ${JSON.stringify({ type: 'done', tokens_used: 0 })}\n\n`);
      }
      res.end();
    });

    stream.on('error', (err) => {
      logger.error(`[BRAIN-API] Stream error: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      stream.controller?.abort();
    });

  } catch (error) {
    logger.error(`[BRAIN-API] Error en chat stream: ${error.message}`);
    // If headers already sent, send SSE error
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * GET /api/brain/chat/history — Historial de chat
 * Query: ?limit=50
 */
router.get('/chat/history', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const messages = await BrainChat.find({})
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({ messages: messages.reverse() }); // Cronológico
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/brain/chat/history — Limpiar historial de chat
 */
router.delete('/chat/history', async (req, res) => {
  try {
    const result = await BrainChat.deleteMany({});
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══ MEMORY ═══

/**
 * GET /api/brain/memory — Estado de la memoria del Brain
 */
router.get('/memory', async (req, res) => {
  try {
    const memories = await BrainMemory.find({})
      .sort({ last_updated_at: -1 })
      .lean();

    const totalInsights = await BrainInsight.countDocuments({});
    const unreadInsights = await BrainInsight.countDocuments({ read: false });

    res.json({
      entities_tracked: memories.length,
      total_insights: totalInsights,
      unread_insights: unreadInsights,
      memories: memories.map(m => ({
        entity_id: m.entity_id,
        entity_name: m.entity_name,
        entity_type: m.entity_type,
        last_status: m.last_status,
        remembered_metrics: m.remembered_metrics,
        trends: m.trends,
        insights_generated: m.insights_generated,
        last_insight_at: m.last_insight_at,
        first_seen_at: m.first_seen_at,
        last_updated_at: m.last_updated_at
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/brain/stats — Estadísticas generales del Brain
 */
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600000);

    const [
      totalInsights,
      unreadInsights,
      todayInsights,
      weekInsights,
      entitiesTracked,
      totalChats,
      insightsByType,
      pendingRecs,
      approvedRecs,
      rejectedRecs
    ] = await Promise.all([
      BrainInsight.countDocuments({}),
      BrainInsight.countDocuments({ read: false }),
      BrainInsight.countDocuments({ created_at: { $gte: today } }),
      BrainInsight.countDocuments({ created_at: { $gte: weekAgo } }),
      BrainMemory.countDocuments({}),
      BrainChat.countDocuments({}),
      BrainInsight.aggregate([
        { $group: { _id: '$insight_type', count: { $sum: 1 } } }
      ]),
      BrainRecommendation.countDocuments({ status: 'pending' }),
      BrainRecommendation.countDocuments({ status: 'approved' }),
      BrainRecommendation.countDocuments({ status: 'rejected' })
    ]);

    const typeBreakdown = {};
    for (const t of insightsByType) {
      typeBreakdown[t._id] = t.count;
    }

    res.json({
      total_insights: totalInsights,
      unread_insights: unreadInsights,
      today_insights: todayInsights,
      week_insights: weekInsights,
      entities_tracked: entitiesTracked,
      total_chats: totalChats,
      insights_by_type: typeBreakdown,
      pending_recommendations: pendingRecs,
      approved_recommendations: approvedRecs,
      rejected_recommendations: rejectedRecs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══ RECOMMENDATIONS ═══

/**
 * GET /api/brain/recommendations — Lista recomendaciones activas + historial
 * Query: ?status=pending|approved|rejected|expired&page=1&limit=20
 */
router.get('/recommendations', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const [recommendations, total, pendingCount] = await Promise.all([
      BrainRecommendation.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
      BrainRecommendation.countDocuments(filter),
      BrainRecommendation.countDocuments({ status: 'pending' })
    ]);

    res.json({
      recommendations,
      total,
      page,
      pages: Math.ceil(total / limit),
      pending_count: pendingCount
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error obteniendo recomendaciones: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/recommendations/:id/approve — Aprobar recomendación
 * Body: { note: "optional note" }
 */
router.post('/recommendations/:id/approve', async (req, res) => {
  try {
    const rec = await BrainRecommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (rec.status !== 'pending') return res.status(400).json({ error: `No se puede aprobar una recomendación con estado "${rec.status}"` });

    rec.status = 'approved';
    rec.decided_at = new Date();
    rec.decision_note = req.body.note || '';
    rec.updated_at = new Date();

    // Refresh baseline metrics from latest snapshot (más preciso que al generar la rec)
    try {
      const latestSnap = await MetricSnapshot.findOne({
        entity_type: 'adset',
        entity_id: rec.entity?.entity_id
      }).sort({ snapshot_at: -1 }).lean();

      if (latestSnap) {
        const m7d = latestSnap.metrics?.last_7d || {};
        rec.follow_up = rec.follow_up || {};
        rec.follow_up.metrics_at_recommendation = {
          roas_7d: m7d.roas || 0,
          cpa_7d: m7d.cpa || 0,
          spend_7d: m7d.spend || 0,
          frequency_7d: m7d.frequency || 0,
          ctr_7d: m7d.ctr || 0,
          purchases_7d: m7d.purchases || 0,
          purchase_value_7d: m7d.purchase_value || 0,
          daily_budget: latestSnap.daily_budget || 0,
          active_ads: latestSnap.ads_count || 0,
          status: latestSnap.status
        };
        logger.info(`[BRAIN-API] Baseline refreshed at approval: ROAS ${m7d.roas?.toFixed(2)}, ads_count ${latestSnap.ads_count || 0}`);
      }
    } catch (snapErr) {
      logger.warn(`[BRAIN-API] Error refreshing baseline (non-fatal): ${snapErr.message}`);
    }

    await rec.save();

    logger.info(`[BRAIN-API] Recomendación aprobada: ${rec.title}`);
    res.json({ ok: true, recommendation: rec });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/recommendations/:id/reject — Rechazar recomendación
 * Body: { note: "optional reason" }
 */
router.post('/recommendations/:id/reject', async (req, res) => {
  try {
    const rec = await BrainRecommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (rec.status !== 'pending') return res.status(400).json({ error: `No se puede rechazar una recomendación con estado "${rec.status}"` });

    rec.status = 'rejected';
    rec.decided_at = new Date();
    rec.decision_note = req.body.note || '';
    rec.updated_at = new Date();
    await rec.save();

    logger.info(`[BRAIN-API] Recomendación rechazada: ${rec.title}`);
    res.json({ ok: true, recommendation: rec });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/recommendations/:id/mark-executed — Marcar manualmente como ejecutada
 * Para cuando el usuario ya ejecutó la acción en Meta Ads directamente.
 */
router.post('/recommendations/:id/mark-executed', async (req, res) => {
  try {
    const rec = await BrainRecommendation.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (rec.status !== 'approved') return res.status(400).json({ error: 'Solo se pueden marcar recomendaciones aprobadas' });

    await BrainRecommendation.updateOne({ _id: rec._id }, { $set: {
      'follow_up.action_executed': true,
      'follow_up.execution_detected_at': new Date(),
      updated_at: new Date()
    }});

    logger.info(`[BRAIN-API] Recomendación marcada como ejecutada manualmente: ${rec.title}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/brain/recommendations/pending-creative/:adsetId
 * Check if there's an approved creative_refresh recommendation pending execution for an ad set.
 * Used by AddCreativePanel to show a banner when uploading a creative that fulfills a Brain rec.
 */
router.get('/recommendations/pending-creative/:adsetId', async (req, res) => {
  try {
    const rec = await BrainRecommendation.findOne({
      status: 'approved',
      action_type: 'creative_refresh',
      'entity.entity_id': req.params.adsetId,
      'follow_up.action_executed': { $ne: true }
    }).select('title action_detail entity priority created_at').lean();

    res.json({ has_pending: !!rec, recommendation: rec || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/recommendations/generate — Trigger manual de ciclo de recomendaciones
 */
router.post('/recommendations/generate', async (req, res) => {
  try {
    const result = await analyzer.generateRecommendations();
    res.json(result);
  } catch (error) {
    logger.error(`[BRAIN-API] Error generando recomendaciones: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/brain/recommendations/history — Historial de decisiones (aprobadas/rechazadas con follow-up)
 */
router.get('/recommendations/history', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const decided = await BrainRecommendation.find({
      status: { $in: ['approved', 'rejected'] }
    }).sort({ decided_at: -1 }).limit(limit).lean();

    res.json({ recommendations: decided });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══ FOLLOW-UP STATS v2 — Multi-phase intelligent tracking ═══

/**
 * GET /api/brain/recommendations/follow-up-stats — Rich follow-up data
 * Returns win rate, multi-phase timelines, AI analyses, multi-metric deltas
 */
router.get('/recommendations/follow-up-stats', async (req, res) => {
  try {
    // All approved recs (both measured and pending)
    const allApproved = await BrainRecommendation.find({
      status: 'approved'
    }).sort({ decided_at: -1 }).lean();

    // Split into measured (at least day_7 checked) and in-progress
    const measured = allApproved.filter(r =>
      r.follow_up?.checked === true || r.follow_up?.phases?.day_7?.measured
    );
    const inProgress = allApproved.filter(r =>
      !r.follow_up?.checked && !r.follow_up?.phases?.day_7?.measured
    );

    // Stats globales
    const positive = measured.filter(r => r.follow_up?.impact_verdict === 'positive').length;
    const negative = measured.filter(r => r.follow_up?.impact_verdict === 'negative').length;
    const neutral = measured.filter(r => r.follow_up?.impact_verdict === 'neutral').length;
    const winRate = measured.length > 0 ? Math.round((positive / measured.length) * 100) : 0;

    // Calculate average deltas from the best available phase
    let totalRoasDelta = 0, totalCpaDelta = 0, totalCtrDelta = 0;
    let deltaCount = 0;

    for (const r of measured) {
      // Use the latest phase data, falling back to legacy metrics_after
      const bestPhase = r.follow_up?.phases?.day_14?.measured ? r.follow_up.phases.day_14
        : r.follow_up?.phases?.day_7?.measured ? r.follow_up.phases.day_7
        : null;

      if (bestPhase?.deltas) {
        totalRoasDelta += bestPhase.deltas.roas_pct || 0;
        totalCpaDelta += bestPhase.deltas.cpa_pct || 0;
        totalCtrDelta += bestPhase.deltas.ctr_pct || 0;
        deltaCount++;
      } else {
        // Legacy fallback
        const before = r.follow_up?.metrics_at_recommendation;
        const after = r.follow_up?.metrics_after;
        if (before?.roas_7d > 0 && after?.roas_7d > 0) {
          totalRoasDelta += ((after.roas_7d - before.roas_7d) / before.roas_7d) * 100;
          deltaCount++;
        }
      }
    }

    const avgRoasDelta = deltaCount > 0 ? totalRoasDelta / deltaCount : 0;
    const avgCpaDelta = deltaCount > 0 ? totalCpaDelta / deltaCount : 0;
    const avgCtrDelta = deltaCount > 0 ? totalCtrDelta / deltaCount : 0;

    // Desglose por tipo de acción
    const byActionType = {};
    for (const r of measured) {
      const at = r.action_type || 'other';
      if (!byActionType[at]) byActionType[at] = { total: 0, positive: 0, negative: 0, neutral: 0, avg_roas_delta: 0 };
      byActionType[at].total++;
      const verdict = r.follow_up?.impact_verdict || 'neutral';
      if (byActionType[at][verdict] !== undefined) byActionType[at][verdict]++;
      // Per-action ROAS delta
      const bestPhase = r.follow_up?.phases?.day_14?.measured ? r.follow_up.phases.day_14
        : r.follow_up?.phases?.day_7?.measured ? r.follow_up.phases.day_7 : null;
      if (bestPhase?.deltas?.roas_pct != null) {
        byActionType[at].avg_roas_delta += bestPhase.deltas.roas_pct;
      }
    }
    // Finalize averages
    for (const at of Object.keys(byActionType)) {
      if (byActionType[at].total > 0) {
        byActionType[at].avg_roas_delta = Math.round((byActionType[at].avg_roas_delta / byActionType[at].total) * 10) / 10;
      }
    }

    // Rich timeline (últimas 30 medidas) with phase data and AI analysis
    const timeline = measured.slice(0, 30).map(r => {
      const before = r.follow_up?.metrics_at_recommendation || {};
      const after = r.follow_up?.metrics_after || {};
      const phases = r.follow_up?.phases || {};
      const roasDelta = before.roas_7d > 0 ? ((after.roas_7d || 0) - before.roas_7d) / before.roas_7d * 100 : 0;

      return {
        _id: r._id,
        title: r.title,
        action_type: r.action_type,
        entity_name: r.entity?.entity_name,
        entity_id: r.entity?.entity_id,
        priority: r.priority,
        confidence_score: r.confidence_score,
        decided_at: r.decided_at,
        checked_at: r.follow_up?.checked_at,
        action_executed: r.follow_up?.action_executed,
        impact_verdict: r.follow_up?.impact_verdict,
        impact_summary: r.follow_up?.impact_summary,
        impact_trend: r.follow_up?.impact_trend,
        // Before metrics
        roas_before: before.roas_7d || 0,
        cpa_before: before.cpa_7d || 0,
        ctr_before: before.ctr_7d || 0,
        freq_before: before.frequency_7d || 0,
        purchases_before: before.purchases_7d || 0,
        spend_before: before.spend_7d || 0,
        // After metrics
        roas_after: after.roas_7d || 0,
        cpa_after: after.cpa_7d || 0,
        ctr_after: after.ctr_7d || 0,
        freq_after: after.frequency_7d || 0,
        purchases_after: after.purchases_7d || 0,
        spend_after: after.spend_7d || 0,
        // Deltas
        roas_delta_pct: Math.round(roasDelta * 10) / 10,
        // Phase progression
        phases: {
          day_3: phases.day_3?.measured ? {
            verdict: phases.day_3.verdict,
            roas_pct: phases.day_3.deltas?.roas_pct,
            cpa_pct: phases.day_3.deltas?.cpa_pct,
            measured_at: phases.day_3.measured_at,
            new_ad_metrics: phases.day_3.new_ad_metrics || null
          } : null,
          day_7: phases.day_7?.measured ? {
            verdict: phases.day_7.verdict,
            roas_pct: phases.day_7.deltas?.roas_pct,
            cpa_pct: phases.day_7.deltas?.cpa_pct,
            measured_at: phases.day_7.measured_at,
            new_ad_metrics: phases.day_7.new_ad_metrics || null
          } : null,
          day_14: phases.day_14?.measured ? {
            verdict: phases.day_14.verdict,
            roas_pct: phases.day_14.deltas?.roas_pct,
            cpa_pct: phases.day_14.deltas?.cpa_pct,
            measured_at: phases.day_14.measured_at,
            new_ad_metrics: phases.day_14.new_ad_metrics || null
          } : null
        },
        // AI analysis
        ai_analysis: r.follow_up?.ai_analysis?.generated ? {
          root_cause: r.follow_up.ai_analysis.root_cause,
          what_worked: r.follow_up.ai_analysis.what_worked,
          what_didnt: r.follow_up.ai_analysis.what_didnt,
          lesson_learned: r.follow_up.ai_analysis.lesson_learned,
          confidence_adjustment: r.follow_up.ai_analysis.confidence_adjustment
        } : null
      };
    });

    // In-progress (approved but not fully measured yet)
    // Find pending recs that reference these follow-ups (new rec for same ad set)
    const inProgressIds = inProgress.map(r => r._id);
    const linkedPendingRecs = await BrainRecommendation.find({
      status: 'pending',
      'related_follow_up.rec_id': { $in: inProgressIds }
    }).lean();

    const linkedRecsMap = {};
    for (const lr of linkedPendingRecs) {
      const fuId = lr.related_follow_up?.rec_id?.toString();
      if (fuId) {
        linkedRecsMap[fuId] = {
          _id: lr._id,
          title: lr.title,
          action_type: lr.action_type,
          priority: lr.priority,
          diagnosis: lr.diagnosis || '',
          expected_outcome: lr.expected_outcome || '',
          risk: lr.risk || '',
          action_detail: lr.action_detail || '',
          confidence_score: lr.confidence_score || 50,
          supporting_data: lr.supporting_data || null
        };
      }
    }

    const pending = inProgress.map(r => {
      const before = r.follow_up?.metrics_at_recommendation || {};
      const hoursAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 3600000) : 0;
      const currentPhase = r.follow_up?.current_phase || 'awaiting_day_3';
      const phases = r.follow_up?.phases || {};
      return {
        _id: r._id,
        title: r.title,
        action_type: r.action_type,
        action_detail: r.action_detail,
        entity_name: r.entity?.entity_name,
        entity_type: r.entity?.entity_type,
        priority: r.priority,
        confidence: r.confidence,
        confidence_score: r.confidence_score,
        decided_at: r.decided_at,
        decision_note: r.decision_note || '',
        hours_since_approved: hoursAgo,
        current_phase: currentPhase,
        action_executed: r.follow_up?.action_executed || false,
        // Metrics at approval snapshot
        roas_at_approval: before.roas_7d || 0,
        cpa_at_approval: before.cpa_7d || 0,
        ctr_at_approval: before.ctr_7d || 0,
        spend_at_approval: before.spend_7d || 0,
        frequency_at_approval: before.frequency_7d || 0,
        purchases_at_approval: before.purchases_7d || 0,
        daily_budget_at_approval: before.daily_budget || 0,
        // Early phase data if available
        day_3: phases.day_3?.measured ? {
          verdict: phases.day_3.verdict,
          roas_pct: phases.day_3.deltas?.roas_pct,
          cpa_pct: phases.day_3.deltas?.cpa_pct,
          ctr_pct: phases.day_3.deltas?.ctr_pct,
          // Absolute current metrics from day 3 measurement
          current_roas: phases.day_3.metrics?.roas_7d || 0,
          current_cpa: phases.day_3.metrics?.cpa_7d || 0,
          current_spend: phases.day_3.metrics?.spend_7d || 0,
          current_purchases: phases.day_3.metrics?.purchases_7d || 0,
          current_budget: phases.day_3.metrics?.daily_budget || 0,
          new_ad_metrics: phases.day_3.new_ad_metrics || null
        } : null,
        // New ad info (for creative_refresh tracking)
        new_ad_id: r.follow_up?.new_ad_id || null,
        new_ad_name: r.follow_up?.new_ad_name || null,
        // New pending rec linked to this follow-up (if any)
        new_recommendation: linkedRecsMap[r._id.toString()] || null
      };
    });

    // Count AI analyses
    const aiAnalyzed = measured.filter(r => r.follow_up?.ai_analysis?.generated).length;
    const lessonsLearned = measured
      .filter(r => r.follow_up?.ai_analysis?.lesson_learned)
      .slice(0, 5)
      .map(r => ({
        action_type: r.action_type,
        lesson: r.follow_up.ai_analysis.lesson_learned,
        verdict: r.follow_up.impact_verdict
      }));

    res.json({
      summary: {
        total_measured: measured.length,
        positive,
        negative,
        neutral,
        win_rate: winRate,
        avg_roas_delta_pct: Math.round(avgRoasDelta * 10) / 10,
        avg_cpa_delta_pct: Math.round(avgCpaDelta * 10) / 10,
        avg_ctr_delta_pct: Math.round(avgCtrDelta * 10) / 10,
        pending_follow_up: inProgress.length,
        ai_analyzed: aiAnalyzed,
        total_approved: allApproved.length
      },
      by_action_type: byActionType,
      timeline,
      pending,
      lessons_learned: lessonsLearned
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en follow-up stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ KNOWLEDGE / POLICY STATE ═══

/**
 * GET /api/brain/policy/state — Estado actual del Policy Learner (Thompson Sampling)
 */
router.get('/policy/state', async (req, res) => {
  try {
    const state = await SystemConfig.get('unified_policy_learning_v1', null);

    if (!state) {
      return res.json({
        total_samples: 0,
        total_buckets: 0,
        updated_at: null,
        top_actions: [],
        buckets_summary: []
      });
    }

    const buckets = state.buckets || {};
    const bucketKeys = Object.keys(buckets);

    // Resumir acciones globales
    const actionStats = {};
    for (const bKey of bucketKeys) {
      for (const [action, stats] of Object.entries(buckets[bKey])) {
        if (!actionStats[action]) actionStats[action] = { count: 0, total_reward: 0, alpha: 0, beta: 0 };
        actionStats[action].count += stats.count || 0;
        actionStats[action].total_reward += stats.total_reward || 0;
        actionStats[action].alpha += stats.alpha || 0;
        actionStats[action].beta += stats.beta || 0;
      }
    }

    const topActions = Object.entries(actionStats)
      .map(([action, s]) => ({
        action,
        count: s.count,
        avg_reward: s.count > 0 ? Math.round((s.total_reward / s.count) * 1000) / 1000 : 0,
        success_rate: (s.alpha + s.beta) > 0 ? Math.round((s.alpha / (s.alpha + s.beta)) * 100) : 50
      }))
      .sort((a, b) => b.count - a.count);

    // Top 15 buckets por muestra
    const bucketsSummary = bucketKeys
      .map(bKey => {
        const actions = buckets[bKey];
        let totalSamples = 0;
        let totalReward = 0;
        const actionList = [];
        for (const [action, stats] of Object.entries(actions)) {
          totalSamples += stats.count || 0;
          totalReward += stats.total_reward || 0;
          actionList.push({
            action,
            count: stats.count || 0,
            mean: (stats.alpha || 1) / ((stats.alpha || 1) + (stats.beta || 1)),
            avg_reward: stats.count > 0 ? (stats.total_reward || 0) / stats.count : 0
          });
        }
        return {
          bucket: bKey,
          total_samples: totalSamples,
          avg_reward: totalSamples > 0 ? totalReward / totalSamples : 0,
          actions: actionList.sort((a, b) => b.count - a.count)
        };
      })
      .sort((a, b) => b.total_samples - a.total_samples)
      .slice(0, 15);

    res.json({
      total_samples: state.total_samples || 0,
      total_buckets: bucketKeys.length,
      updated_at: state.updated_at || null,
      top_actions: topActions,
      buckets_summary: bucketsSummary
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en policy state: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/brain/knowledge/history — Evolución diaria del conocimiento del Brain
 * Query: ?days=30
 */
router.get('/knowledge/history', async (req, res) => {
  try {
    const days = Math.min(90, parseInt(req.query.days) || 30);
    const since = new Date(Date.now() - days * 24 * 3600000);

    const snapshots = await BrainKnowledgeSnapshot.find({
      created_at: { $gte: since }
    }).sort({ created_at: 1 }).lean();

    res.json({
      snapshots: snapshots.map(s => ({
        date: s.date,
        total_samples: s.total_samples,
        total_buckets: s.total_buckets,
        total_actions_measured: s.total_actions_measured,
        win_rate: s.win_rate,
        avg_reward: s.avg_reward,
        top_actions: s.top_actions,
        actions_by_verdict: s.actions_by_verdict,
        insights_generated: s.insights_generated,
        recommendations_generated: s.recommendations_generated,
        recommendations_approved: s.recommendations_approved,
        created_at: s.created_at
      })),
      total: snapshots.length
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en knowledge history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ DEEP KNOWLEDGE — All 4 intelligence systems in one call ═══

/**
 * GET /api/brain/knowledge/deep
 * Returns unified view of all Brain knowledge systems:
 *   1. Entity memories with action_history
 *   2. Temporal patterns (day-of-week baselines)
 *   3. Hypotheses (active, confirmed, rejected)
 *   4. Thompson Sampling policy stats (summary)
 */
router.get('/knowledge/deep', async (req, res) => {
  try {
    const [memories, temporalPatterns, cycleMemories, policyRaw, followUpRecs] = await Promise.all([
      BrainMemory.find({}).sort({ last_updated_at: -1 }).lean(),
      BrainTemporalPattern.find({ pattern_type: 'day_of_week' }).sort({ pattern_key: 1 }).lean(),
      BrainCycleMemory.find({}).sort({ created_at: -1 }).limit(10).lean(),
      SystemConfig.get('unified_policy_learning_v1', null),
      BrainRecommendation.find({ status: { $in: ['approved', 'measured'] } })
        .sort({ decided_at: -1 }).limit(50).lean()
    ]);

    // 1. Entity memories — only those with action_history
    const entitiesWithHistory = memories
      .filter(m => m.action_history && m.action_history.length > 0)
      .map(m => ({
        entity_id: m.entity_id,
        entity_name: m.entity_name,
        entity_type: m.entity_type,
        last_status: m.last_status,
        trends: m.trends,
        action_history: m.action_history.slice(-10),
        last_updated_at: m.last_updated_at
      }));

    // Count all action outcomes across entities
    let totalActions = 0, improved = 0, worsened = 0, neutral = 0;
    for (const m of memories) {
      if (m.action_history) {
        for (const a of m.action_history) {
          totalActions++;
          if (a.result === 'improved') improved++;
          else if (a.result === 'worsened') worsened++;
          else neutral++;
        }
      }
    }

    // 2. Temporal patterns — day of week
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const todayKey = dayNames[new Date().getDay()];
    const temporal = temporalPatterns.map(tp => ({
      day: tp.pattern_key,
      is_today: tp.pattern_key === todayKey,
      metrics: tp.metrics,
      sample_count: tp.metrics?.sample_count || 0
    }));

    // 3. Hypotheses — collect from all cycle memories
    const allHypotheses = [];
    for (const cm of cycleMemories) {
      if (cm.hypotheses) {
        for (const h of cm.hypotheses) {
          allHypotheses.push({
            hypothesis: h.hypothesis,
            proposed_action: h.proposed_action,
            status: h.status,
            created_cycle_id: h.created_cycle_id || cm.cycle_id,
            validated_at: h.validated_at,
            validation_result: h.validation_result
          });
        }
      }
    }
    // Dedup by hypothesis text — keep most recent
    const hypMap = new Map();
    for (const h of allHypotheses) {
      const key = h.hypothesis.substring(0, 80);
      if (!hypMap.has(key)) hypMap.set(key, h);
    }
    const hypotheses = Array.from(hypMap.values());

    // 4. Thompson Sampling summary
    let policySummary = { total_samples: 0, total_buckets: 0, top_actions: [] };
    if (policyRaw) {
      const buckets = policyRaw.buckets || {};
      const actionStats = {};
      for (const bKey of Object.keys(buckets)) {
        for (const [action, stats] of Object.entries(buckets[bKey])) {
          if (!actionStats[action]) actionStats[action] = { count: 0, alpha: 0, beta: 0 };
          actionStats[action].count += stats.count || 0;
          actionStats[action].alpha += stats.alpha || 0;
          actionStats[action].beta += stats.beta || 0;
        }
      }
      policySummary = {
        total_samples: policyRaw.total_samples || 0,
        total_buckets: Object.keys(buckets).length,
        top_actions: Object.entries(actionStats)
          .map(([action, s]) => ({
            action,
            count: s.count,
            success_rate: (s.alpha + s.beta) > 0 ? Math.round((s.alpha / (s.alpha + s.beta)) * 100) : 50
          }))
          .sort((a, b) => b.count - a.count)
      };
    }

    // 5. Win/loss from follow-ups
    const measured = followUpRecs.filter(r => r.status === 'measured');
    const winRate = measured.length > 0
      ? Math.round((measured.filter(r => r.measurement?.verdict === 'positive').length / measured.length) * 100)
      : 0;

    res.json({
      // Summary stats
      iq_score: _calculateIQ(memories, temporalPatterns, hypotheses, policySummary, measured),
      entities_tracked: memories.length,
      entities_with_history: entitiesWithHistory.length,
      total_action_outcomes: totalActions,
      action_outcomes: { improved, worsened, neutral },
      win_rate: winRate,
      total_measured: measured.length,

      // Detailed data
      entity_memories: entitiesWithHistory.slice(0, 20),
      temporal_patterns: temporal,
      hypotheses,
      policy: policySummary,

      // Cycle memory count
      cycle_memories_count: cycleMemories.length,
      last_cycle: cycleMemories[0] ? {
        cycle_id: cycleMemories[0].cycle_id,
        account_assessment: cycleMemories[0].account_assessment,
        conclusions_count: cycleMemories[0].conclusions?.length || 0,
        created_at: cycleMemories[0].created_at
      } : null
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en knowledge/deep: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Calculate Brain IQ score (0-100) from knowledge systems
 */
function _calculateIQ(memories, temporalPatterns, hypotheses, policy, measured) {
  let score = 30; // base

  // Memory breadth: +1 per entity with history, max +15
  const withHistory = memories.filter(m => m.action_history && m.action_history.length > 0).length;
  score += Math.min(15, withHistory * 2);

  // Temporal maturity: +2 per day with 4+ samples, max +14
  const matureDays = temporalPatterns.filter(t => (t.metrics?.sample_count || 0) >= 4).length;
  score += Math.min(14, matureDays * 2);

  // Hypothesis validation: +3 per validated, max +12
  const validated = hypotheses.filter(h => h.status === 'confirmed' || h.status === 'rejected').length;
  score += Math.min(12, validated * 3);

  // Active hypotheses: +1 per active, max +4
  const active = hypotheses.filter(h => h.status === 'active').length;
  score += Math.min(4, active);

  // Thompson samples: logarithmic scale, max +15
  const samples = policy.total_samples || 0;
  if (samples > 0) score += Math.min(15, Math.round(Math.log2(samples + 1) * 2));

  // Win rate bonus: if measured > 5 and win > 60%, +5-10
  if (measured.length >= 5) {
    const wr = measured.filter(r => r.measurement?.verdict === 'positive').length / measured.length;
    score += Math.min(10, Math.round(wr * 15));
  }

  return Math.min(100, Math.round(score));
}

// ═══ CREATIVE / AD PERFORMANCE TRACKING ═══

/**
 * GET /api/brain/creative-performance
 * Returns ONLY manually uploaded ads (created via manual upload flow)
 * with 3d metrics, trend analysis, and Brain verdict.
 * Manual ads are identified by "[Manual Upload]" in the ad name.
 */
router.get('/creative-performance', async (req, res) => {
  try {
    // Get latest snapshot per ad — only manual uploads (name contains "[Manual Upload]")
    const adSnapshots = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'ad' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: {
        status: { $in: ['ACTIVE', 'PAUSED'] },
        entity_name: { $regex: '\\[Manual Upload\\]' }
      }},
      { $sort: { 'metrics.last_3d.spend': -1 } }
    ]);

    // Get latest snapshot per adset for context (name, fatigue)
    const adsetSnapshots = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset' } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } }
    ]);
    const adsetMap = {};
    for (const s of adsetSnapshots) {
      adsetMap[s.entity_id] = {
        name: s.entity_name,
        daily_budget: s.daily_budget || 0,
        frequency_7d: s.metrics?.last_7d?.frequency || 0,
        ads_count: s.ads_count || 0
      };
    }

    // Build sibling map: group ads by adset for per-ad comparison
    const siblingsByAdSet = {};
    for (const ad of adSnapshots) {
      const pid = ad.parent_id;
      if (!pid) continue;
      if (!siblingsByAdSet[pid]) siblingsByAdSet[pid] = [];
      siblingsByAdSet[pid].push({
        entity_id: ad.entity_id,
        roas_7d: ad.metrics?.last_7d?.roas || 0,
        ctr_7d: ad.metrics?.last_7d?.ctr || 0,
        spend_7d: ad.metrics?.last_7d?.spend || 0,
        frequency_7d: ad.metrics?.last_7d?.frequency || 0
      });
    }

    // Compute averages across manual ads for 3d (for comparison)
    // Only include non-learning ads in the average (ads with >= 72h)
    const now = new Date();
    let totalSpend3d = 0, totalRevenue3d = 0, totalCTR3d = 0, ctrCount = 0;
    for (const ad of adSnapshots) {
      const createdTime = ad.meta_created_time || ad.created_at;
      const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : Infinity;
      if (ageHours < 72) continue; // Don't include learning ads in averages
      const m3 = ad.metrics?.last_3d || {};
      totalSpend3d += m3.spend || 0;
      totalRevenue3d += m3.purchase_value || 0;
      if (m3.ctr > 0) { totalCTR3d += m3.ctr; ctrCount++; }
    }
    const avgROAS3d = totalSpend3d > 0 ? totalRevenue3d / totalSpend3d : 0;
    const avgCTR3d = ctrCount > 0 ? totalCTR3d / ctrCount : 0;

    // Build response
    const ads = adSnapshots.map(ad => {
      const m3 = ad.metrics?.last_3d || {};
      const m7 = ad.metrics?.last_7d || {};
      const mT = ad.metrics?.today || {};

      // Calculate ad age
      const createdTime = ad.meta_created_time || ad.created_at;
      const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : Infinity;
      const ageDays = Math.floor(ageHours / 24);

      // Trend: compare today vs 3d ROAS
      const roas3 = m3.roas || 0;
      const roasToday = mT.roas || 0;
      let trend = 'stable';
      if (roas3 > 0) {
        const ratio = roasToday / roas3;
        if (ratio > 1.2) trend = 'improving';
        else if (ratio < 0.7) trend = 'declining';
      }

      // Brain verdict — age-aware
      let verdict = 'new'; // default for ads with no spend/data
      const spend3 = m3.spend || 0;

      if (ageHours < 72) {
        // LEARNING: Ad is less than 72h old — don't judge it regardless of spend
        verdict = 'learning';
      } else if (spend3 >= 3) {
        if (roas3 >= avgROAS3d * 1.2 && (m3.ctr || 0) >= avgCTR3d * 0.8) {
          verdict = 'good';
        } else if (roas3 < avgROAS3d * 0.5 || (m3.frequency || 0) >= 3.5) {
          verdict = 'bad';
        } else {
          verdict = 'watch';
        }
      }

      // Per-ad fatigue signals
      const freq7d = m7.frequency || 0;
      const ctr7d = m7.ctr || 0;
      const roas7d = m7.roas || 0;
      let fatigueLevel = 'healthy';
      const fatigueSignals = [];

      if (ageHours < 72) {
        fatigueLevel = 'learning';
      } else {
        if (freq7d >= 4.0) { fatigueSignals.push('frequency_critical'); fatigueLevel = 'severe'; }
        else if (freq7d >= 2.5) { fatigueSignals.push('frequency_warning'); }

        if (ageDays >= 28) { fatigueSignals.push('age_severe'); if (fatigueLevel !== 'severe') fatigueLevel = 'severe'; }
        else if (ageDays >= 21) { fatigueSignals.push('age_moderate'); if (fatigueLevel === 'healthy') fatigueLevel = 'moderate'; }
        else if (ageDays >= 14) { fatigueSignals.push('age_early'); if (fatigueLevel === 'healthy') fatigueLevel = 'early'; }

        // CTR decline vs siblings
        const siblings = siblingsByAdSet[ad.parent_id] || [];
        if (siblings.length > 1) {
          const avgSiblingCTR = siblings.reduce((s, a) => s + a.ctr_7d, 0) / siblings.length;
          if (avgSiblingCTR > 0 && ctr7d < avgSiblingCTR * 0.6) {
            fatigueSignals.push('ctr_below_siblings');
          }
        }

        if (fatigueSignals.length >= 2 && fatigueLevel === 'healthy') fatigueLevel = 'early';
        if (fatigueSignals.length >= 3 && fatigueLevel === 'early') fatigueLevel = 'moderate';
      }

      return {
        ad_id: ad.entity_id,
        ad_name: ad.entity_name,
        status: ad.status,
        adset_id: ad.parent_id,
        adset_name: adsetMap[ad.parent_id]?.name || ad.parent_id,
        snapshot_at: ad.snapshot_at,
        age_hours: Math.round(ageHours),
        age_days: ageDays,
        metrics: {
          today: { spend: mT.spend || 0, roas: mT.roas || 0, purchases: mT.purchases || 0, ctr: mT.ctr || 0, clicks: mT.clicks || 0 },
          last_3d: {
            spend: m3.spend || 0, roas: m3.roas || 0, purchases: m3.purchases || 0,
            ctr: m3.ctr || 0, cpa: m3.cpa || 0, frequency: m3.frequency || 0,
            impressions: m3.impressions || 0, cpm: m3.cpm || 0, clicks: m3.clicks || 0
          }
        },
        trend,
        verdict,
        fatigue: {
          level: fatigueLevel,
          signals: fatigueSignals
        },
        siblings_count: (siblingsByAdSet[ad.parent_id] || []).length
      };
    });

    res.json({
      ads,
      account_avg: { roas_3d: Math.round(avgROAS3d * 100) / 100, ctr_3d: Math.round(avgCTR3d * 100) / 100 },
      total: ads.length
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en creative-performance: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
