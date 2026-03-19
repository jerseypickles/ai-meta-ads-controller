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

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../../../config');
const Anthropic = require('@anthropic-ai/sdk');
const CreativeAsset = require('../../db/models/CreativeAsset');
const AICreation = require('../../db/models/AICreation');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots } = require('../../db/queries');

// Multer for launch uploads
const LAUNCH_UPLOAD_DIR = path.join(config.system.uploadsDir, 'creatives');
const launchUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(LAUNCH_UPLOAD_DIR)) fs.mkdirSync(LAUNCH_UPLOAD_DIR, { recursive: true });
    cb(null, LAUNCH_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `launch-${uniqueSuffix}${ext}`);
  }
});
const launchUpload = multer({
  storage: launchUploadStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
  limits: { fileSize: 30 * 1024 * 1024 }
});

// In-memory store for launch jobs
const launchJobs = new Map();
const LAUNCH_JOB_TTL = 10 * 60 * 1000;

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
 * POST /api/brain/insights/manual — Crear insight manual (para log de acciones humanas)
 */
router.post('/insights/manual', async (req, res) => {
  try {
    const { insight_type, severity, title, body, entity_type, entity_id, entity_name, clear_creative_flag } = req.body;
    await BrainInsight.create({
      insight_type: insight_type || 'status_change',
      severity: severity || 'info',
      title: title || 'Accion manual',
      body: body || '',
      entities: [{ entity_type: entity_type || 'adset', entity_id, entity_name }],
      generated_by: 'brain'
    });

    // Clear needs_new_creatives flag immediately when creative is uploaded
    if (clear_creative_flag && entity_id) {
      const BrainMemory = require('../../db/models/BrainMemory');
      await BrainMemory.findOneAndUpdate(
        { entity_id },
        { $set: { agent_needs_new_creatives: false, last_updated_at: new Date() } }
      );
    }

    res.json({ success: true });
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

    // Guard: ad sets managed by Agent Manager v2 — Brain only emits directives, not direct actions
    const entityId = rec.entity?.entity_id;
    if (entityId) {
      const aiManaged = await AICreation.findOne({
        meta_entity_id: String(entityId),
        managed_by_ai: true,
        agent_version: 'v2'
      }).lean();
      if (aiManaged) {
        return res.status(400).json({
          error: `Este ad set está gestionado por el Agent Manager v2. Las acciones se ejecutan automáticamente — no se necesita aprobación manual.`
        });
      }
    }

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
      'follow_up.execution_source': 'user_manual',
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
 * Check if there's a pending or approved create_ad/creative_refresh recommendation for an ad set.
 * Used by AddCreativePanel to show a banner when uploading a creative that fulfills a Brain rec.
 * Busca por entity_id directo O por parent_adset_id (recs a nivel de ad que referencian este ad set).
 */
router.get('/recommendations/pending-creative/:adsetId', async (req, res) => {
  try {
    const adsetId = req.params.adsetId;
    const rec = await BrainRecommendation.findOne({
      status: { $in: ['pending', 'approved'] },
      action_type: { $in: ['create_ad', 'creative_refresh'] },
      $or: [
        { 'entity.entity_id': adsetId },
        { parent_adset_id: adsetId }
      ],
      'follow_up.action_executed': { $ne: true }
    }).sort({ status: 1 }).select('title action_detail entity priority created_at action_type status').lean();

    res.json({ has_pending: !!rec, recommendation: rec || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/recommendations/generate — Trigger manual de ciclo de recomendaciones
 * Ejecuta UnifiedBrain que genera recs con acciones ejecutables (create_ad, update_ad_status, etc.)
 * y las guarda en BrainRecommendation para follow-up unificado.
 */
router.post('/recommendations/generate', async (req, res) => {
  try {
    const UnifiedBrain = require('../../ai/brain/unified-brain');
    const brain = new UnifiedBrain();
    const result = await brain.runCycle();
    res.json({
      recommendations_created: result?.recommendations || 0,
      elapsed: result?.elapsed || '0s',
      cycle_id: result?.cycleId || null
    });
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
      // Prefer phase deltas over legacy metrics_after
      const bestPhaseData = phases.day_14?.measured ? phases.day_14
        : phases.day_7?.measured ? phases.day_7
        : phases.day_3?.measured ? phases.day_3 : null;
      const roasDelta = bestPhaseData?.deltas?.roas_pct != null
        ? bestPhaseData.deltas.roas_pct
        : (before.roas_7d > 0 ? ((after.roas_7d || 0) - before.roas_7d) / before.roas_7d * 100 : 0);

      return {
        _id: r._id,
        title: r.title,
        action_type: r.action_type,
        entity_name: r.entity?.entity_name,
        entity_id: r.entity?.entity_id,
        entity_type: r.entity?.entity_type,
        parent_adset_id: r.parent_adset_id || null,
        parent_adset_name: r.parent_adset_name || null,
        priority: r.priority,
        confidence_score: r.confidence_score,
        decided_at: r.decided_at,
        checked_at: r.follow_up?.checked_at,
        action_executed: r.follow_up?.action_executed,
        execution_source: r.follow_up?.execution_source || null,
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
        execution_source: r.follow_up?.execution_source || null,
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
        // Parent ad set context (for ad-level actions)
        parent_adset_id: r.parent_adset_id || null,
        parent_adset_name: r.parent_adset_name || null,
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
 * GET /api/brain/policy/learning — Real learning data from the Thompson Sampling bandit.
 * Returns reward trends over time, per-action performance, strongest signals, and
 * a clear "is the Brain learning?" verdict.
 */
router.get('/policy/learning', async (req, res) => {
  try {
    const allLearned = await ActionLog.find({
      success: true,
      learned_reward: { $ne: null }
    }).sort({ executed_at: 1 }).lean();

    if (allLearned.length === 0) {
      return res.json({
        total_actions: 0,
        is_learning: false,
        verdict: 'Sin datos — el Brain aun no tiene acciones medidas',
        by_action: [],
        reward_trend: [],
        strongest_signals: [],
        recent_rewards: []
      });
    }

    // 1. Per-action stats
    const actionMap = {};
    for (const a of allLearned) {
      if (!actionMap[a.action]) actionMap[a.action] = { rewards: [], dates: [] };
      actionMap[a.action].rewards.push(a.learned_reward);
      actionMap[a.action].dates.push(a.executed_at);
    }

    const byAction = Object.entries(actionMap).map(([action, data]) => {
      const rewards = data.rewards;
      const avg = rewards.reduce((s, r) => s + r, 0) / rewards.length;
      const positive = rewards.filter(r => r > 0.05).length;
      const negative = rewards.filter(r => r < -0.05).length;
      const neutral = rewards.length - positive - negative;

      // Trend: compare first half vs second half
      const mid = Math.floor(rewards.length / 2);
      const firstAvg = mid > 0 ? rewards.slice(0, mid).reduce((s, r) => s + r, 0) / mid : 0;
      const secondAvg = mid > 0 ? rewards.slice(mid).reduce((s, r) => s + r, 0) / (rewards.length - mid) : 0;
      const improving = secondAvg > firstAvg + 0.02;
      const worsening = secondAvg < firstAvg - 0.02;
      const trend = improving ? 'improving' : worsening ? 'worsening' : 'stable';

      // Signal strength: how far from 0.5 is the Thompson mean?
      const signal = Math.abs(avg);

      return {
        action,
        count: rewards.length,
        avg_reward: Math.round(avg * 1000) / 1000,
        positive,
        negative,
        neutral,
        win_rate: rewards.length > 0 ? Math.round(positive / rewards.length * 100) : 0,
        first_half_avg: Math.round(firstAvg * 1000) / 1000,
        second_half_avg: Math.round(secondAvg * 1000) / 1000,
        trend,
        signal_strength: signal > 0.08 ? 'strong' : signal > 0.03 ? 'moderate' : 'weak'
      };
    }).sort((a, b) => b.count - a.count);

    // 2. Rolling reward trend (weekly windows)
    const rewardTrend = [];
    const weekMs = 7 * 86400000;
    if (allLearned.length > 0) {
      const firstDate = new Date(allLearned[0].executed_at).getTime();
      const lastDate = new Date(allLearned[allLearned.length - 1].executed_at).getTime();

      for (let start = firstDate; start <= lastDate; start += weekMs) {
        const end = start + weekMs;
        const weekActions = allLearned.filter(a => {
          const t = new Date(a.executed_at).getTime();
          return t >= start && t < end;
        });
        if (weekActions.length > 0) {
          const avg = weekActions.reduce((s, a) => s + a.learned_reward, 0) / weekActions.length;
          const pos = weekActions.filter(a => a.learned_reward > 0.05).length;
          rewardTrend.push({
            week_start: new Date(start).toISOString().split('T')[0],
            count: weekActions.length,
            avg_reward: Math.round(avg * 1000) / 1000,
            win_rate: Math.round(pos / weekActions.length * 100)
          });
        }
      }
    }

    // 3. Strongest signals from bandit
    const policyRaw = await SystemConfig.get('unified_policy_learning_v1', null);
    const strongestSignals = [];
    if (policyRaw?.buckets) {
      for (const [bucket, actions] of Object.entries(policyRaw.buckets)) {
        for (const [action, stats] of Object.entries(actions)) {
          if ((stats.count || 0) < 3) continue;
          const mean = (stats.alpha || 1) / ((stats.alpha || 1) + (stats.beta || 1));
          if (mean < 0.44 || mean > 0.56) {
            const avgReward = stats.count > 0 ? (stats.total_reward || 0) / stats.count : 0;
            strongestSignals.push({
              bucket,
              action,
              mean: Math.round(mean * 1000) / 1000,
              count: stats.count,
              avg_reward: Math.round(avgReward * 1000) / 1000,
              verdict: mean > 0.5 ? 'funciona' : 'falla'
            });
          }
        }
      }
      strongestSignals.sort((a, b) => Math.abs(b.mean - 0.5) - Math.abs(a.mean - 0.5));
    }

    // 4. Last 10 rewards (recent activity)
    const recentRewards = allLearned.slice(-10).reverse().map(a => ({
      action: a.action,
      entity_name: a.entity_name || 'N/A',
      reward: Math.round(a.learned_reward * 1000) / 1000,
      executed_at: a.executed_at,
      bucket: a.learned_bucket
    }));

    // 5. Overall verdict
    const globalAvg = allLearned.reduce((s, a) => s + a.learned_reward, 0) / allLearned.length;
    const mid = Math.floor(allLearned.length / 2);
    const firstHalfAvg = allLearned.slice(0, mid).reduce((s, a) => s + a.learned_reward, 0) / mid;
    const secondHalfAvg = allLearned.slice(mid).reduce((s, a) => s + a.learned_reward, 0) / (allLearned.length - mid);
    const isImproving = secondHalfAvg > firstHalfAvg + 0.01;
    const hasStrongSignals = strongestSignals.length >= 2;

    let verdict, verdictType;
    if (hasStrongSignals && isImproving) {
      verdict = `Aprendiendo activamente — ${strongestSignals.length} senales claras, rewards mejorando`;
      verdictType = 'positive';
    } else if (hasStrongSignals) {
      verdict = `Tiene senales claras (${strongestSignals.length}) pero los rewards no mejoran aun`;
      verdictType = 'moderate';
    } else if (allLearned.length < 50) {
      verdict = `Acumulando datos (${allLearned.length}/50 minimo) — necesita mas acciones medidas`;
      verdictType = 'early';
    } else {
      verdict = `${allLearned.length} acciones medidas pero senales debiles — rewards demasiado cercanos a cero`;
      verdictType = 'weak';
    }

    res.json({
      total_actions: allLearned.length,
      global_avg_reward: Math.round(globalAvg * 1000) / 1000,
      first_half_avg: Math.round(firstHalfAvg * 1000) / 1000,
      second_half_avg: Math.round(secondHalfAvg * 1000) / 1000,
      is_learning: hasStrongSignals,
      is_improving: isImproving,
      verdict,
      verdict_type: verdictType,
      by_action: byAction,
      reward_trend: rewardTrend,
      strongest_signals: strongestSignals.slice(0, 10),
      recent_rewards: recentRewards
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en policy/learning: ${error.message}`);
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

    // 5. Win/loss from follow-ups — use approved recs with completed impact measurement
    const measured = followUpRecs.filter(r =>
      r.status === 'approved' &&
      r.follow_up?.impact_verdict &&
      r.follow_up.impact_verdict !== 'pending'
    );
    const winRate = measured.length > 0
      ? Math.round((measured.filter(r => r.follow_up.impact_verdict === 'positive').length / measured.length) * 100)
      : 0;

    const iqResult = _calculateIQ(memories, temporalPatterns, hypotheses, policySummary, measured);

    res.json({
      // Summary stats
      iq_score: iqResult.score,
      iq_breakdown: iqResult.breakdown,
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
  // IQ = conocimiento REAL, no acumulación de datos.
  // Para llegar a 80+ necesitas: muchas acciones medidas, buen win rate, hipótesis validadas.
  const base = 10; // base mínimo — "existe"

  // ═══ EXPERIENCIA REAL (max 35pts) — el factor más importante ═══
  const measuredCount = measured.length;
  const experiencePts = Math.min(35, Math.round(Math.sqrt(measuredCount) * 5));

  // ═══ WIN RATE (max 25pts) — ¿sus decisiones funcionan? ═══
  let winRatePts = 0;
  if (measuredCount >= 3) {
    const wins = measured.filter(r => r.follow_up?.impact_verdict === 'positive').length;
    const wr = wins / measuredCount;
    if (wr > 0.3) {
      winRatePts = Math.min(25, Math.round(Math.pow((wr - 0.3) / 0.7, 1.5) * 25));
    }
  }

  // ═══ HIPÓTESIS VALIDADAS (max 12pts) — ¿probó ideas y aprendió? ═══
  const validated = hypotheses.filter(h => h.status === 'confirmed' || h.status === 'rejected').length;
  const hypothesesPts = Math.min(12, validated * 3);

  // ═══ DIVERSIDAD DE ACCIONES (max 8pts) — ¿sabe hacer más que una cosa? ═══
  const actionTypes = new Set();
  for (const m of memories) {
    if (m.action_history) {
      for (const a of m.action_history) actionTypes.add(a.action_type);
    }
  }
  const diversityPts = Math.min(8, actionTypes.size * 2);

  // ═══ PATRONES TEMPORALES (max 5pts) — data pasiva, bajo peso ═══
  const matureDays = temporalPatterns.filter(t => (t.metrics?.sample_count || 0) >= 4).length;
  const temporalPts = Math.min(5, Math.round(matureDays * 0.7));

  // ═══ THOMPSON SAMPLING DEPTH (max 5pts) — ¿tiene contextos explorados? ═══
  const samples = policy.total_samples || 0;
  const thompsonPts = samples > 0 ? Math.min(5, Math.round(Math.log2(samples + 1))) : 0;

  const totalScore = Math.min(100, Math.round(base + experiencePts + winRatePts + hypothesesPts + diversityPts + temporalPts + thompsonPts));

  return {
    score: totalScore,
    breakdown: [
      { key: 'experience', label: 'Experiencia', points: experiencePts, max: 35, color: '#3b82f6' },
      { key: 'win_rate',   label: 'Win Rate',    points: winRatePts,    max: 25, color: '#10b981' },
      { key: 'hypotheses', label: 'Hipotesis',   points: hypothesesPts, max: 12, color: '#a855f7' },
      { key: 'diversity',  label: 'Diversidad',  points: diversityPts,  max: 8,  color: '#f59e0b' },
      { key: 'temporal',   label: 'Temporal',    points: temporalPts,   max: 5,  color: '#f97316' },
      { key: 'thompson',   label: 'Thompson',    points: thompsonPts,   max: 5,  color: '#06b6d4' }
    ]
  };
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

    // Compute averages across manual ads for each window (for comparison)
    // Only include non-learning ads in the average (ads with >= 72h)
    const now = new Date();
    const avgCalc = { today: { spend: 0, rev: 0, ctr: 0, n: 0 }, last_3d: { spend: 0, rev: 0, ctr: 0, n: 0 }, last_7d: { spend: 0, rev: 0, ctr: 0, n: 0 } };
    for (const ad of adSnapshots) {
      const createdTime = ad.meta_created_time || ad.created_at;
      const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : Infinity;
      if (ageHours < 72) continue; // Don't include learning ads in averages
      for (const w of ['today', 'last_3d', 'last_7d']) {
        const m = ad.metrics?.[w] || {};
        avgCalc[w].spend += m.spend || 0;
        avgCalc[w].rev += m.purchase_value || 0;
        if (m.ctr > 0) { avgCalc[w].ctr += m.ctr; avgCalc[w].n++; }
      }
    }
    const avgROAS3d = avgCalc.last_3d.spend > 0 ? avgCalc.last_3d.rev / avgCalc.last_3d.spend : 0;
    const avgCTR3d = avgCalc.last_3d.n > 0 ? avgCalc.last_3d.ctr / avgCalc.last_3d.n : 0;

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
          today: {
            spend: mT.spend || 0, roas: mT.roas || 0, purchases: mT.purchases || 0,
            ctr: mT.ctr || 0, cpa: mT.cpa || 0, frequency: mT.frequency || 0,
            impressions: mT.impressions || 0, clicks: mT.clicks || 0
          },
          last_3d: {
            spend: m3.spend || 0, roas: m3.roas || 0, purchases: m3.purchases || 0,
            ctr: m3.ctr || 0, cpa: m3.cpa || 0, frequency: m3.frequency || 0,
            impressions: m3.impressions || 0, cpm: m3.cpm || 0, clicks: m3.clicks || 0
          },
          last_7d: {
            spend: m7.spend || 0, roas: m7.roas || 0, purchases: m7.purchases || 0,
            ctr: m7.ctr || 0, cpa: m7.cpa || 0, frequency: m7.frequency || 0,
            impressions: m7.impressions || 0, cpm: m7.cpm || 0, clicks: m7.clicks || 0
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

    const buildAvg = (w) => ({
      roas: avgCalc[w].spend > 0 ? Math.round((avgCalc[w].rev / avgCalc[w].spend) * 100) / 100 : 0,
      ctr: avgCalc[w].n > 0 ? Math.round((avgCalc[w].ctr / avgCalc[w].n) * 100) / 100 : 0
    });

    res.json({
      ads,
      account_avg: {
        roas_3d: Math.round(avgROAS3d * 100) / 100, ctr_3d: Math.round(avgCTR3d * 100) / 100,
        today: buildAvg('today'), last_3d: buildAvg('last_3d'), last_7d: buildAvg('last_7d')
      },
      total: ads.length
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en creative-performance: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ AD HEALTH — Live per-ad anomaly diagnostics ═══

/**
 * GET /api/brain/ad-health — Live ad health diagnostics from DiagnosticEngine.
 * Returns per-ad-set anomaly data computed in real-time from latest snapshots.
 */
router.get('/ad-health', async (req, res) => {
  try {
    const DiagnosticEngine = require('../../ai/brain/diagnostic-engine');
    const { getLatestSnapshots, getAccountOverview } = require('../../db/queries');
    const BrainMemoryModel = require('../../db/models/BrainMemory');

    const diagnosticEngine = new DiagnosticEngine();

    const [adsetSnapshots, adSnapshots, accountOverview, memories] = await Promise.all([
      getLatestSnapshots('adset'),
      getLatestSnapshots('ad'),
      getAccountOverview(),
      BrainMemoryModel.find({}).lean()
    ]);

    const memoryMap = {};
    for (const m of memories) memoryMap[m.entity_id] = m;

    // Agrupar ad snapshots por ad set (parent_id)
    const adsByAdSet = {};
    for (const ad of adSnapshots) {
      const parentId = ad.parent_id;
      if (!parentId) continue;
      if (!adsByAdSet[parentId]) adsByAdSet[parentId] = [];
      adsByAdSet[parentId].push(ad);
    }

    const diagnostics = diagnosticEngine.diagnoseAll(adsetSnapshots, adSnapshots, memoryMap, accountOverview);

    // Consultar pausas recientes por ad set (últimos 7 días)
    const allAdSetIds = adsetSnapshots.map(s => s.entity_id);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000);
    // Buscar en BrainRecommendation ejecutadas (tienen parent_adset_id) + ActionLog
    const recentPauseRecs = await BrainRecommendation.find({
      action_type: 'update_ad_status',
      status: 'executed',
      'entity.entity_type': 'ad',
      executed_at: { $gte: sevenDaysAgo }
    }).select('entity parent_adset_id parent_adset_name executed_at').lean();

    // Construir mapa: adset_id → { last_pause_at, last_pause_ad, days_ago }
    const recentPauseMap = {};
    for (const p of recentPauseRecs) {
      const parentId = p.parent_adset_id || adSnapshots.find(a => a.entity_id === p.entity?.entity_id)?.parent_id;
      if (!parentId) continue;
      const daysAgo = Math.round((Date.now() - new Date(p.executed_at).getTime()) / 86400000);
      if (!recentPauseMap[parentId] || new Date(p.executed_at) > new Date(recentPauseMap[parentId].last_pause_at)) {
        recentPauseMap[parentId] = {
          last_pause_at: p.executed_at,
          last_pause_ad: p.entity?.entity_name || p.entity?.entity_id || 'unknown',
          days_ago: daysAgo,
        };
      }
    }

    // Consultar recs pendientes para todos los ad sets
    const pendingRecs = await BrainRecommendation.find({
      status: { $in: ['pending', 'approved'] },
      action_type: { $in: ['creative_refresh', 'pause', 'update_ad_status'] },
      'entity.entity_id': { $in: allAdSetIds }
    }).select('entity.entity_id action_type title status _id').lean();

    const pendingMap = {};
    for (const r of pendingRecs) {
      pendingMap[r.entity.entity_id] = {
        pending_rec_id: r._id,
        pending_rec_type: r.action_type,
        pending_rec_title: r.title,
        pending_rec_status: r.status
      };
    }

    // Build response: TODOS los ad sets con todos sus ads + diagnóstico
    const adSetResults = [];
    let totalAnomalies = 0;
    let totalWaste = 0;
    let totalPauseCandidates = 0;
    let adSetsHealthy = 0;
    let adSetsTotal = 0;
    let totalAds = 0;
    let totalDeclining = 0;
    let totalImproving = 0;
    const diagnosisCounts = {
      healthy: 0, learning: 0, new_untested: 0, starved: 0,
      zombie: 0, dominant_declining: 0, dominant_healthy: 0, fatigued: 0
    };

    for (const adsetSnap of adsetSnapshots) {
      const entityId = adsetSnap.entity_id;
      const diag = diagnostics[entityId];
      if (!diag) continue;

      adSetsTotal++;
      const ah = diag.ad_health || { anomalies: [], has_issues: false, pause_count: 0, healthy_count: 0, total_waste_7d: 0, remaining_after_pause: 0 };

      if (!ah.has_issues) adSetsHealthy++;
      totalAnomalies += (ah.anomalies || []).length;
      totalWaste += ah.total_waste_7d || 0;
      totalPauseCandidates += ah.pause_count || 0;

      // Construir all_ads con spend share + diagnóstico
      const ads = adsByAdSet[entityId] || [];
      const activeAds = ads.filter(a => a.status === 'ACTIVE');
      const totalSpend7d = activeAds.reduce((sum, a) => sum + ((a.metrics?.last_7d?.spend) || 0), 0);

      // Mapa de anomalías por ad_id
      const anomalyMap = {};
      for (const anom of (ah.anomalies || [])) {
        anomalyMap[anom.ad_id] = anom;
      }

      // Mapa de tendencias por ad_id (del DiagnosticEngine)
      const trendMap = {};
      for (const t of (ah.ad_trends || [])) {
        trendMap[t.ad_id] = t;
      }

      const allAds = activeAds.map(ad => {
        const m7d = ad.metrics?.last_7d || {};
        const m3d = ad.metrics?.last_3d || {};
        const mToday = ad.metrics?.today || {};
        const spend7d = m7d.spend || 0;
        const spendShare = totalSpend7d > 0 ? Math.round((spend7d / totalSpend7d) * 1000) / 10 : 0;
        const ageHours = ad.meta_created_time ? Math.round((Date.now() - new Date(ad.meta_created_time).getTime()) / 3600000) : 0;
        const ageDays = Math.floor(ageHours / 24);
        const roas7d = m7d.roas || 0;
        const roas3d = m3d.roas || 0;
        const clicks7d = m7d.clicks || 0;
        const freq7d = m7d.frequency || 0;

        // Diagnóstico por prioridad
        let diagnosis = 'healthy';
        if (ageHours < 72) {
          diagnosis = spendShare < 5 ? 'new_untested' : 'learning';
        } else if (spendShare < 3 && ageDays > 5 && clicks7d < 5) {
          diagnosis = 'zombie';
        } else if (spendShare < 5 && ageHours > 48 && (m7d.impressions || 0) > 0) {
          diagnosis = 'starved';
        } else if (spendShare > 35 && roas7d > 0 && roas3d > 0 && ((roas7d - roas3d) / roas7d) > 0.20 && trendMap[ad.entity_id]?.trend !== 'improving') {
          diagnosis = 'dominant_declining';
        } else if (spendShare > 35) {
          diagnosis = 'dominant_healthy';
        } else if (freq7d > 3.0 || anomalyMap[ad.entity_id]?.primary_anomaly?.type === 'TOP_PERFORMER_FATIGUING') {
          diagnosis = 'fatigued';
        }

        diagnosisCounts[diagnosis] = (diagnosisCounts[diagnosis] || 0) + 1;
        totalAds++;
        if (trendMap[ad.entity_id]?.trend === 'declining') totalDeclining++;
        if (trendMap[ad.entity_id]?.trend === 'improving') totalImproving++;

        const DIAG_TEXT = {
          learning: 'Tiene menos de 72h — Meta aún lo está evaluando',
          new_untested: 'Es nuevo pero Meta no le está dando presupuesto para probarlo',
          zombie: 'Lleva días activo pero sin clics ni gasto real — Meta lo descartó',
          starved: 'Meta solo le asigna <5% del presupuesto del ad set',
          dominant_declining: 'Es el que más gasta pero su rendimiento está empeorando',
          dominant_healthy: 'Es el creativo principal del ad set y rinde bien',
          fatigued: 'La audiencia ya lo vio demasiadas veces — frequency alta',
          healthy: 'Rendimiento estable'
        };

        return {
          ad_id: ad.entity_id,
          ad_name: ad.entity_name,
          status: ad.status,
          age_hours: ageHours,
          age_days: ageDays,
          // 7d metrics
          spend_7d: Math.round(spend7d * 100) / 100,
          roas_7d: Math.round(roas7d * 100) / 100,
          roas_3d: Math.round(roas3d * 100) / 100,
          ctr_7d: Math.round((m7d.ctr || 0) * 100) / 100,
          cpa_7d: Math.round((m7d.cpa || 0) * 100) / 100,
          frequency_7d: Math.round(freq7d * 10) / 10,
          purchases_7d: m7d.purchases || 0,
          clicks_7d: clicks7d,
          impressions_7d: m7d.impressions || 0,
          // 3d metrics
          spend_3d: Math.round((m3d.spend || 0) * 100) / 100,
          ctr_3d: Math.round((m3d.ctr || 0) * 100) / 100,
          cpa_3d: Math.round((m3d.cpa || 0) * 100) / 100,
          frequency_3d: Math.round((m3d.frequency || 0) * 10) / 10,
          purchases_3d: m3d.purchases || 0,
          clicks_3d: m3d.clicks || 0,
          impressions_3d: m3d.impressions || 0,
          // today metrics
          spend_today: Math.round((mToday.spend || 0) * 100) / 100,
          roas_today: Math.round((mToday.roas || 0) * 100) / 100,
          ctr_today: Math.round((mToday.ctr || 0) * 100) / 100,
          cpa_today: Math.round((mToday.cpa || 0) * 100) / 100,
          frequency_today: Math.round((mToday.frequency || 0) * 10) / 10,
          purchases_today: mToday.purchases || 0,
          clicks_today: mToday.clicks || 0,
          impressions_today: mToday.impressions || 0,
          spend_share_pct: spendShare,
          diagnosis,
          diagnosis_text: DIAG_TEXT[diagnosis] || 'Saludable',
          // Tendencia del DiagnosticEngine
          trend: trendMap[ad.entity_id]?.trend || 'stable',
          trend_pct: trendMap[ad.entity_id]?.trend_pct || 0,
          trend_detail: trendMap[ad.entity_id]?.trend_detail || null,
          has_anomaly: !!anomalyMap[ad.entity_id],
          anomaly: anomalyMap[ad.entity_id] ? {
            type: anomalyMap[ad.entity_id].primary_anomaly?.type,
            severity: anomalyMap[ad.entity_id].primary_anomaly?.severity,
            detail: anomalyMap[ad.entity_id].primary_anomaly?.detail,
            action: anomalyMap[ad.entity_id].recommended_action,
            waste: anomalyMap[ad.entity_id].primary_anomaly?.waste_amount || 0
          } : null
        };
      });

      // Ordenar: dominant primero, luego por spend descendente
      allAds.sort((a, b) => b.spend_share_pct - a.spend_share_pct);

      const pending = pendingMap[entityId] || null;
      const recentPause = recentPauseMap[entityId] || null;

      adSetResults.push({
        adset_id: entityId,
        adset_name: diag.entity_name,
        active_ads: diag.active_ads,
        total_ads: diag.total_ads,
        daily_budget: adsetSnap.daily_budget || 0,
        total_spend_7d: Math.round(totalSpend7d * 100) / 100,
        overall_diagnosis: diag.overall?.labels || [],
        overall_action: diag.overall?.primary_action || 'monitor',
        fatigue_level: diag.fatigue?.fatigue_level || 'none',
        fatigue_score: diag.fatigue?.fatigue_score || 0,
        pending_rec_id: pending?.pending_rec_id || null,
        pending_rec_type: pending?.pending_rec_type || null,
        pending_rec_title: pending?.pending_rec_title || null,
        pending_rec_status: pending?.pending_rec_status || null,
        recent_pause: recentPause,
        ad_health: {
          anomalies: (ah.anomalies || []).map(a => ({
            ad_id: a.ad_id, ad_name: a.ad_name, age_days: a.age_days,
            spend_7d: a.spend_7d, roas_7d: a.roas_7d, ctr_7d: a.ctr_7d,
            frequency_7d: a.frequency_7d, purchases_7d: a.purchases_7d,
            primary_anomaly: a.primary_anomaly, all_anomalies: a.all_anomalies,
            recommended_action: a.recommended_action
          })),
          summary: ah.summary,
          pause_count: ah.pause_count,
          healthy_count: ah.healthy_count,
          total_waste_7d: ah.total_waste_7d,
          remaining_after_pause: ah.remaining_after_pause
        },
        all_ads: allAds
      });
    }

    // Ordenar: ad sets con issues primero (por waste), luego saludables por spend
    adSetResults.sort((a, b) => {
      const aIssues = a.ad_health.total_waste_7d || 0;
      const bIssues = b.ad_health.total_waste_7d || 0;
      if (aIssues !== bIssues) return bIssues - aIssues;
      return b.total_spend_7d - a.total_spend_7d;
    });

    res.json({
      summary: {
        adsets_total: adSetsTotal,
        adsets_with_issues: adSetsTotal - adSetsHealthy,
        adsets_healthy: adSetsHealthy,
        total_anomalies: totalAnomalies,
        total_pause_candidates: totalPauseCandidates,
        total_waste_7d: Math.round(totalWaste * 100) / 100,
        total_ads: totalAds,
        declining_count: totalDeclining,
        improving_count: totalImproving,
        diagnosis_counts: diagnosisCounts,
        computed_at: new Date().toISOString()
      },
      adsets: adSetResults
    });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en ad-health: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ SUGGEST — Generar recomendación on-demand desde Ad Health ═══

router.post('/ad-health/suggest', async (req, res) => {
  try {
    const { adset_id, adset_name, suggestion_type, zombie_ad_ids } = req.body;
    if (!adset_id || !adset_name || !suggestion_type) {
      return res.status(400).json({ error: 'Faltan campos: adset_id, adset_name, suggestion_type' });
    }

    // Evitar duplicados: verificar si ya hay rec pendiente o aprobada similar
    const existing = await BrainRecommendation.findOne({
      status: { $in: ['pending', 'approved'] },
      action_type: suggestion_type === 'refresh' ? 'creative_refresh' : 'update_ad_status',
      'entity.entity_id': adset_id
    }).lean();

    if (existing) {
      return res.json({ ok: false, duplicate: true, existing_status: existing.status, recommendation: existing });
    }

    // Obtener snapshot actual para métricas
    const { getLatestSnapshots } = require('../../db/queries');
    const adsetSnaps = await getLatestSnapshots('adset');
    const snap = adsetSnaps.find(s => s.entity_id === adset_id);
    const m7d = snap?.metrics?.last_7d || {};

    let recData;
    if (suggestion_type === 'refresh') {
      recData = {
        priority: 'evaluar',
        action_type: 'creative_refresh',
        entity: { entity_type: 'adset', entity_id: adset_id, entity_name: adset_name },
        title: `Refresh creativo: ${adset_name}`,
        diagnosis: 'Creativo dominante en declive detectado por Ad Health',
        expected_outcome: 'Nuevo creativo fresco debería estabilizar rendimiento del ad set',
        risk: 'Sin refresh, el ad set seguirá declinando al depender de un creativo fatigado',
        action_detail: `Agregar nuevo creativo al ad set ${adset_name} para reemplazar al dominante en declive`,
        confidence: 'medium',
        generated_by: 'hybrid',
        supporting_data: {
          current_roas_7d: m7d.roas || 0,
          current_cpa_7d: m7d.cpa || 0,
          current_spend_7d: m7d.spend || 0,
          current_frequency_7d: m7d.frequency || 0,
          current_ctr_7d: m7d.ctr || 0,
          current_purchases_7d: m7d.purchases || 0
        },
        follow_up: {
          metrics_at_recommendation: {
            roas_7d: m7d.roas || 0,
            cpa_7d: m7d.cpa || 0,
            spend_7d: m7d.spend || 0,
            frequency_7d: m7d.frequency || 0,
            ctr_7d: m7d.ctr || 0,
            purchases_7d: m7d.purchases || 0,
            daily_budget: snap?.daily_budget || 0
          }
        }
      };
    } else {
      // pause_zombies
      const zombieNames = (zombie_ad_ids || []).join(', ') || 'ads sin rendimiento';
      recData = {
        priority: 'evaluar',
        action_type: 'update_ad_status',
        entity: { entity_type: 'adset', entity_id: adset_id, entity_name: adset_name },
        title: `Pausar ads zombie en ${adset_name}`,
        diagnosis: 'Ads sin actividad real detectados — consumen presupuesto sin generar clicks ni compras',
        expected_outcome: 'Concentrar presupuesto en ads que sí generan rendimiento',
        risk: 'Sin acción, el presupuesto se diluye entre ads que Meta ya descartó',
        action_detail: `Pausar ads sin rendimiento en ${adset_name}: ${zombieNames}`,
        confidence: 'high',
        generated_by: 'hybrid',
        supporting_data: {
          current_roas_7d: m7d.roas || 0,
          current_cpa_7d: m7d.cpa || 0,
          current_spend_7d: m7d.spend || 0,
          current_frequency_7d: m7d.frequency || 0,
          current_ctr_7d: m7d.ctr || 0,
          current_purchases_7d: m7d.purchases || 0
        },
        follow_up: {
          metrics_at_recommendation: {
            roas_7d: m7d.roas || 0,
            cpa_7d: m7d.cpa || 0,
            spend_7d: m7d.spend || 0,
            frequency_7d: m7d.frequency || 0,
            ctr_7d: m7d.ctr || 0,
            purchases_7d: m7d.purchases || 0,
            daily_budget: snap?.daily_budget || 0
          }
        }
      };
    }

    const created = await BrainRecommendation.create(recData);
    logger.info(`[AD-HEALTH] Rec generada: ${suggestion_type} para ${adset_name}`);
    res.json({ ok: true, recommendation: created });
  } catch (error) {
    logger.error(`[BRAIN-API] Error en ad-health/suggest: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══ QUICK-PAUSE — Pausar ad individual directo en Meta API ═══

router.post('/ad-health/quick-pause', async (req, res) => {
  try {
    const { ad_id, ad_name, adset_id, adset_name, reason } = req.body;
    if (!ad_id || !adset_id) {
      return res.status(400).json({ error: 'Faltan campos: ad_id, adset_id' });
    }

    // Verificar que hay al menos 1 ad más activo en el ad set
    const { getLatestSnapshots } = require('../../db/queries');
    const adSnaps = await getLatestSnapshots('ad');
    const siblingsActive = adSnaps.filter(a => a.parent_id === adset_id && a.status === 'ACTIVE' && a.entity_id !== ad_id);
    if (siblingsActive.length === 0) {
      return res.status(400).json({ error: 'No se puede pausar — es el unico ad activo en este ad set' });
    }

    // Ejecutar pausa directo en Meta API
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    try {
      await meta.updateAdStatus(ad_id, 'PAUSED');
    } catch (metaErr) {
      const metaError = metaErr.response?.data?.error || metaErr.message;
      logger.error(`[QUICK-PAUSE] Meta API error: ${JSON.stringify(metaError)}`);
      return res.status(502).json({ error: `Meta API error: ${typeof metaError === 'object' ? metaError.message || JSON.stringify(metaError) : metaError}` });
    }

    // Obtener métricas actuales del ad para registrar
    const adSnap = adSnaps.find(s => s.entity_id === ad_id);
    const m7d = adSnap?.metrics?.last_7d || {};
    const adsetSnaps = await getLatestSnapshots('adset');
    const adsetSnap = adsetSnaps.find(s => s.entity_id === adset_id);
    const adsetM7d = adsetSnap?.metrics?.last_7d || {};

    // Crear ActionLog para que Impact Measurement lo mida
    await ActionLog.create({
      entity_id: ad_id,
      entity_name: ad_name || 'Unknown',
      entity_type: 'ad',
      action: 'update_ad_status',
      before_value: 'ACTIVE',
      after_value: 'PAUSED',
      reasoning: reason || 'Pausa manual desde panel de creativos — creativo perdiendo efectividad',
      agent_type: 'manual',
      metrics_at_execution: {
        roas_7d: m7d.roas || 0,
        cpa_7d: m7d.cpa || 0,
        spend_7d: m7d.spend || 0,
        ctr: m7d.ctr || 0,
        frequency: m7d.frequency || 0,
        purchases_7d: m7d.purchases || 0
      },
      parent_adset_id: adset_id,
      parent_metrics_at_execution: {
        roas_7d: adsetM7d.roas || 0,
        roas_3d: adsetSnap?.metrics?.last_3d?.roas || 0,
        cpa_7d: adsetM7d.cpa || 0,
        spend_today: adsetSnap?.metrics?.today?.spend || 0,
        spend_7d: adsetM7d.spend || 0,
        daily_budget: adsetSnap?.daily_budget || 0,
        purchases_7d: adsetM7d.purchases || 0,
        purchase_value_7d: adsetM7d.purchase_value || 0,
        frequency: adsetM7d.frequency || 0,
        ctr: adsetM7d.ctr || 0
      },
      success: true
    });

    // Crear BrainRecommendation en estado executed para que aparezca en Seguimiento
    await BrainRecommendation.create({
      priority: 'alta',
      action_type: 'update_ad_status',
      entity: { entity_type: 'ad', entity_id: ad_id, entity_name: ad_name || 'Unknown' },
      parent_adset_id: adset_id,
      parent_adset_name: adset_name || 'Unknown',
      title: `Pausar ad: ${ad_name || ad_id}`,
      diagnosis: reason || 'Creativo perdiendo efectividad — pausado desde panel de creativos',
      expected_outcome: `Presupuesto se redistribuye a ${siblingsActive.length} ad${siblingsActive.length > 1 ? 's' : ''} activo${siblingsActive.length > 1 ? 's' : ''}`,
      risk: 'Bajo — hay alternativas activas en el ad set',
      action_detail: `Pausar ad ${ad_name || ad_id} en ad set ${adset_name || adset_id}`,
      recommended_value: 0,
      confidence: 'high',
      generated_by: 'hybrid',
      status: 'executed',
      approved_at: new Date(),
      executed_at: new Date(),
      supporting_data: {
        current_roas_7d: m7d.roas || 0,
        current_cpa_7d: m7d.cpa || 0,
        current_spend_7d: m7d.spend || 0,
        siblings_active: siblingsActive.length,
        execution_method: 'quick_pause'
      },
      follow_up: {
        execution_source: 'user_manual',
        metrics_at_recommendation: {
          roas_7d: adsetM7d.roas || 0,
          cpa_7d: adsetM7d.cpa || 0,
          spend_7d: adsetM7d.spend || 0,
          frequency_7d: adsetM7d.frequency || 0,
          ctr_7d: adsetM7d.ctr || 0,
          purchases_7d: adsetM7d.purchases || 0,
          daily_budget: adsetSnap?.daily_budget || 0
        }
      }
    });

    logger.info(`[QUICK-PAUSE] Ad ${ad_id} (${ad_name}) pausado directo — ${siblingsActive.length} ads activos restantes`);
    res.json({ ok: true, ad_id, paused: true, siblings_remaining: siblingsActive.length });
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.message;
    logger.error(`[QUICK-PAUSE] Error: ${detail}`, { stack: error.stack });
    res.status(500).json({ error: detail });
  }
});

// ═══ LAUNCH AD SET — Upload creatives + Brain proposes + approve ═══

/**
 * POST /api/brain/launch/upload
 * Upload 2-10 images. Saves to disk + creates CreativeAsset records.
 * Body (multipart): images[] + product_name (optional)
 */
router.post('/launch/upload', launchUpload.array('images', 10), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Se necesita al menos 1 imagen' });
    }

    const productName = req.body.product_name || '';
    const assets = [];

    for (const file of files) {
      const asset = await CreativeAsset.create({
        filename: file.filename,
        original_name: file.originalname,
        file_path: file.path,
        file_type: file.mimetype,
        media_type: 'image',
        purpose: 'ad-ready',
        style: 'other',
        generated_by: 'manual',
        ad_format: 'feed',
        product_name: productName,
        product_detected_by: productName ? 'manual' : '',
        tags: ['launch-upload'],
        status: 'active'
      });
      assets.push({
        id: asset._id.toString(),
        filename: asset.filename,
        original_name: asset.original_name,
        product_name: productName
      });
    }

    logger.info(`[BRAIN-LAUNCH] ${assets.length} imágenes subidas para lanzamiento (producto: ${productName || 'no especificado'})`);
    res.json({ success: true, assets, count: assets.length });
  } catch (error) {
    logger.error(`[BRAIN-LAUNCH] Error en upload: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/launch/strategize
 * Brain analyzes account + the uploaded assets and proposes 1 ad set.
 * Body: { asset_ids: string[], product_name?: string }
 */
router.post('/launch/strategize', async (req, res) => {
  try {
    const { asset_ids, product_name } = req.body;
    if (!asset_ids || asset_ids.length === 0) {
      return res.status(400).json({ error: 'Se necesita al menos 1 asset_id' });
    }

    // Load the uploaded assets
    const assets = await CreativeAsset.find({ _id: { $in: asset_ids }, status: 'active' }).lean();
    if (assets.length === 0) {
      return res.status(400).json({ error: 'No se encontraron assets válidos' });
    }

    // Load account performance
    const adsetSnapshots = await getLatestSnapshots('adset').catch(() => []);
    const activeSnapshots = adsetSnapshots.filter(s => s.status === 'ACTIVE');
    const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
    const totalPurchaseValue7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);
    const accountRoas = totalSpend7d > 0 ? totalPurchaseValue7d / totalSpend7d : 0;
    const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);

    // Get campaign
    const meta = getMetaClient();
    const campaigns = await meta.getCampaigns().catch(() => []);
    if (campaigns.length === 0) {
      return res.status(400).json({ error: 'No hay campañas disponibles en la cuenta' });
    }

    // AI creation history
    const aiHistory = await AICreation.find({ creation_type: 'create_adset' })
      .sort({ created_at: -1 }).limit(10).lean();

    // Build context for Claude
    const assetsContext = assets.map(a => ({
      id: a._id.toString(),
      original_name: a.original_name,
      product_name: a.product_name || product_name || '',
      style: a.style || 'other'
    }));

    const performanceContext = activeSnapshots.slice(0, 20).map(s => ({
      name: s.entity_name || s.name,
      status: s.status,
      daily_budget: s.daily_budget || 0,
      roas_7d: s.metrics?.last_7d?.roas || 0,
      cpa_7d: s.metrics?.last_7d?.cpa || 0,
      spend_7d: s.metrics?.last_7d?.spend || 0,
      purchases_7d: s.metrics?.last_7d?.purchases || 0,
      frequency_7d: s.metrics?.last_7d?.frequency || 0
    }));

    const aiHistoryContext = aiHistory.map(h => ({
      name: h.meta_entity_name,
      verdict: h.verdict,
      initial_budget: h.initial_budget,
      lifecycle_phase: h.lifecycle_phase,
      roas_7d: h.metrics_7d?.roas_7d || 0
    }));

    const claudeClient = new Anthropic({ apiKey: config.claude.apiKey });
    const response = await claudeClient.messages.create({
      model: config.claude.model,
      max_tokens: 4000,
      system: `You are Claude, senior media buyer for a DTC ecommerce brand (Jersey Pickles) running Meta Ads in the USA.

The user has uploaded ${assets.length} creative images and wants to launch a NEW ad set. Your job: propose ONE complete ad set ready to launch.

You MUST use ALL the uploaded creatives — the user chose these specifically.

For EACH creative image, write ONE headline + ONE primary text. Each image becomes 1 ad in the ad set:
- **headline**: 1 short, punchy headline. Max 40 chars. English for US audience. USE EMOJIS (🥒🔥💥🤤👀✨🎉💚). Scroll-stopping.
- **body**: 1 primary text. Keep it SHORT: 1-2 sentences max. Use emojis. Hook + benefit. English. Example: "🥒 These aren't your grandma's pickles. Bold, crunchy & addictive!"
- **cta**: SHOP_NOW | LEARN_MORE | BUY_NOW | GET_OFFER | ORDER_NOW
- **link_url**: The destination URL for the ad (use the website URL from account context)

Each image = 1 ad. Make each ad's copy unique — different angle per image (benefit, urgency, curiosity, social proof).

Output STRICT JSON:
{
  "adset_name": "AI - [Product] - [Angle] - [Date]",
  "daily_budget": 25.00,
  "link_url": "https://...",
  "budget_rationale": "In Spanish — why this budget",
  "strategy_summary": "In Spanish — overall strategy for this ad set",
  "risk_assessment": "low|medium|high",
  "selected_creatives": [
    {
      "asset_id": "mongo_id_from_the_uploaded_list",
      "headline": "🥒 Bold Crunch, Zero Compromise 🔥",
      "body": "🔥 Not your average pickle. Handcrafted & dangerously addictive — grab yours before they're gone!",
      "cta": "SHOP_NOW"
    }
  ]
}

RULES:
- Return ONLY valid JSON, no markdown
- Budget: $15-50/day, conservative for new tests
- Use data from account performance to inform budget/strategy
- Ad copy in English, strategy/rationale in Spanish
- Headlines and bodies MUST include relevant emojis
- Bodies must be SHORT — 1-2 sentences max, no long paragraphs
- Be creative with headlines — different angles (benefit, urgency, curiosity, social proof)
- The AI Manager will auto-scale if ROAS is good`,
      messages: [{
        role: 'user',
        content: `Launch a new ad set with these ${assets.length} creatives.

## UPLOADED CREATIVES (use ALL of them)
${JSON.stringify(assetsContext, null, 2)}

## PRODUCT
${product_name || assets[0]?.product_name || 'Not specified — infer from image names'}

## ACCOUNT PERFORMANCE (${activeSnapshots.length} active ad sets)
Account ROAS 7d: ${accountRoas.toFixed(2)}x | Total budget: $${totalBudget.toFixed(0)}/day | Spend 7d: $${totalSpend7d.toFixed(0)}
${JSON.stringify(performanceContext, null, 2)}

## AI HISTORY (last ${aiHistory.length} launches)
${JSON.stringify(aiHistoryContext, null, 2)}

## CAMPAIGN
Campaign: "${campaigns[0].name}" (${campaigns[0].id})

## WEBSITE URL
${await meta.getWebsiteUrl().catch(() => 'Not available — use a generic ecommerce URL')}

Today: ${new Date().toISOString().split('T')[0]}`
      }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let proposal;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      proposal = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      logger.error('[BRAIN-LAUNCH] Error parsing Claude response:', text.substring(0, 500));
      return res.status(500).json({ error: 'Claude no devolvió JSON válido' });
    }

    // Validate and enrich creatives
    const validCreatives = [];
    for (const sel of (proposal.selected_creatives || [])) {
      const asset = assets.find(a => a._id.toString() === sel.asset_id);
      if (asset) {
        const headlines = Array.isArray(sel.headlines) ? sel.headlines : [sel.headline || asset.original_name];
        const bodies = Array.isArray(sel.bodies) ? sel.bodies : [sel.body || ''];
        validCreatives.push({
          ...sel,
          headlines,
          bodies,
          asset_filename: asset.filename,
          asset_style: asset.style || 'other',
          asset_headline: asset.headline || asset.original_name
        });
      }
    }

    // If Claude missed some assets, add them with default copy
    for (const asset of assets) {
      if (!validCreatives.find(c => c.asset_id === asset._id.toString())) {
        validCreatives.push({
          asset_id: asset._id.toString(),
          headlines: [asset.original_name.replace(/\.[^.]+$/, '').substring(0, 40)],
          bodies: [''],
          cta: 'SHOP_NOW',
          asset_filename: asset.filename,
          asset_style: asset.style || 'other',
          asset_headline: asset.headline || asset.original_name
        });
      }
    }

    const result = {
      ...proposal,
      selected_creatives: validCreatives,
      campaign_id: campaigns[0].id,
      campaign_name: campaigns[0].name,
      product_name: product_name || assets[0]?.product_name || ''
    };

    logger.info(`[BRAIN-LAUNCH] Propuesta generada: "${result.adset_name}" — $${result.daily_budget}/day — ${validCreatives.length} creativos`);
    res.json({ success: true, proposal: result });
  } catch (error) {
    logger.error(`[BRAIN-LAUNCH] Error en strategize: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/brain/launch/approve
 * Approve and execute the launch proposal.
 * Body: { proposal } — the proposal object from strategize (optionally edited by user)
 * Returns job_id for polling.
 */
router.post('/launch/approve', async (req, res) => {
  try {
    const { proposal } = req.body;
    if (!proposal || !proposal.selected_creatives || proposal.selected_creatives.length === 0) {
      return res.status(400).json({ error: 'Propuesta inválida — se necesita al menos 1 creativo' });
    }
    if (!proposal.campaign_id) {
      return res.status(400).json({ error: 'Falta campaign_id en la propuesta' });
    }

    const jobId = `brain_launch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    launchJobs.set(jobId, { status: 'running', startedAt: Date.now(), result: null, error: null });

    res.json({ success: true, async: true, job_id: jobId, message: 'Lanzamiento iniciado' });

    // Reuse the same execution logic as adset-creator
    // Import executeAdSetApproval-like logic inline
    (async () => {
      const meta = getMetaClient();

      // Step 1: Account info
      const [pixelInfo, pageId, websiteUrl] = await Promise.all([
        meta.getPixelId(),
        meta.getPageId(),
        meta.getWebsiteUrl()
      ]);
      if (!pixelInfo) throw new Error('No se encontró pixel_id');
      if (!pageId) throw new Error('No se encontró page_id');
      if (!websiteUrl) throw new Error('No se encontró link_url');

      // Step 2: Upload images to Meta
      const uploadedAssets = [];
      for (const sel of proposal.selected_creatives) {
        const asset = await CreativeAsset.findById(sel.asset_id);
        if (!asset) continue;
        if (!asset.uploaded_to_meta) {
          const upload = await meta.uploadImage(asset.file_path);
          asset.meta_image_hash = upload.image_hash;
          asset.uploaded_to_meta = true;
          asset.uploaded_at = new Date();
          await asset.save();
        }
        uploadedAssets.push({ asset, creative_config: sel });
      }

      if (uploadedAssets.length === 0) throw new Error('No se pudo subir ninguna imagen a Meta');

      // Step 3: Create ad set (PAUSED)
      const adSetResult = await meta.createAdSet({
        campaign_id: proposal.campaign_id,
        name: proposal.adset_name,
        daily_budget: proposal.daily_budget,
        optimization_goal: pixelInfo.optimization_goal,
        billing_event: pixelInfo.billing_event,
        bid_strategy: pixelInfo.bid_strategy,
        promoted_object: pixelInfo.promoted_object,
        status: 'PAUSED'
      });

      // Step 4: Create ads — 1 ad per image, 1 headline + 1 body per ad
      const createdAds = [];
      const linkUrl = proposal.link_url || websiteUrl;
      for (const { asset, creative_config } of uploadedAssets) {
        const headline = Array.isArray(creative_config.headlines)
          ? creative_config.headlines[0] || asset.headline
          : creative_config.headline || asset.headline;
        const body = Array.isArray(creative_config.bodies)
          ? creative_config.bodies[0] || ''
          : creative_config.body || '';

        try {
          const creative = await meta.createAdCreative({
            page_id: pageId,
            image_hash: asset.meta_image_hash,
            headline,
            body,
            description: '',
            cta: creative_config.cta || 'SHOP_NOW',
            link_url: linkUrl
          });

          const adName = `${headline} - ${asset.style || 'mix'}`;
          const ad = await meta.createAd(adSetResult.adset_id, creative.creative_id, adName, 'PAUSED');

          createdAds.push({ ad_id: ad.ad_id, creative_id: creative.creative_id, asset_id: asset._id.toString(), name: adName });
        } catch (adErr) {
          logger.warn(`[BRAIN-LAUNCH] Error creando ad: ${adErr.message}`);
        }

        // Update asset tracking
        asset.times_used = (asset.times_used || 0) + 1;
        if (!asset.used_in_adsets) asset.used_in_adsets = [];
        if (!asset.used_in_adsets.includes(adSetResult.adset_id)) asset.used_in_adsets.push(adSetResult.adset_id);
        await asset.save();
      }

      if (createdAds.length === 0) throw new Error('No se pudo crear ningún ad');

      // Step 5: Activate
      await Promise.allSettled(createdAds.map(a => meta.updateAdStatus(a.ad_id, 'ACTIVE')));
      await meta.updateStatus(adSetResult.adset_id, 'ACTIVE');

      // Step 6: Register AICreation
      await AICreation.create({
        creation_type: 'create_adset',
        meta_entity_id: adSetResult.adset_id,
        meta_entity_type: 'adset',
        meta_entity_name: proposal.adset_name,
        parent_entity_id: proposal.campaign_id,
        parent_entity_name: proposal.campaign_name || '',
        agent_type: 'creative',
        agent_version: 'v2',
        reasoning: proposal.strategy_summary || '',
        confidence: proposal.risk_assessment === 'low' ? 'high' : proposal.risk_assessment === 'high' ? 'low' : 'medium',
        initial_budget: proposal.daily_budget,
        managed_by_ai: true,
        child_ad_ids: createdAds.map(a => a.ad_id),
        selected_creative_ids: uploadedAssets.map(u => u.asset._id.toString()),
        current_status: 'ACTIVE',
        current_budget: proposal.daily_budget,
        lifecycle_phase: 'learning',
        activated_at: new Date(),
        learning_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        lifecycle_actions: [{
          action: 'create_and_activate',
          value: { budget: proposal.daily_budget, ads: createdAds.length },
          reason: proposal.strategy_summary || 'Brain launch',
          executed_at: new Date()
        }]
      });

      // Step 7: Notify Brain — create insight so it appears in Feed immediately
      try {
        const learningEnds = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        await BrainInsight.create({
          insight_type: 'status_change',
          severity: 'high',
          title: `Nuevo ad set lanzado: ${proposal.adset_name}`,
          body: `Se lanzó un nuevo ad set con ${createdAds.length} ads y budget de $${proposal.daily_budget}/día. ` +
            `Fase de aprendizaje activa hasta ${learningEnds.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}. ` +
            `No se deben hacer cambios durante los primeros 3 días.` +
            (proposal.strategy_summary ? `\n\nEstrategia: ${proposal.strategy_summary}` : ''),
          entity_id: adSetResult.adset_id,
          entity_name: proposal.adset_name,
          entity_type: 'adset',
          data_points: {
            action: 'brain_launch',
            ads_created: createdAds.length,
            daily_budget: proposal.daily_budget,
            ad_ids: createdAds.map(a => a.ad_id),
            learning_ends_at: learningEnds.toISOString(),
            product_name: proposal.product_name || '',
            link_url: proposal.link_url || ''
          }
        });
      } catch (insightErr) {
        logger.warn(`[BRAIN-LAUNCH] Error creando insight (non-fatal): ${insightErr.message}`);
      }

      const result = {
        success: true,
        adset_id: adSetResult.adset_id,
        adset_name: proposal.adset_name,
        ads_created: createdAds.length,
        daily_budget: proposal.daily_budget,
        created_ads: createdAds
      };

      launchJobs.set(jobId, { status: 'completed', startedAt: launchJobs.get(jobId)?.startedAt, result, error: null });
      logger.info(`[BRAIN-LAUNCH] Ad set lanzado: ${adSetResult.adset_id} — ${createdAds.length} ads — $${proposal.daily_budget}/day`);
    })().catch(error => {
      launchJobs.set(jobId, { status: 'failed', startedAt: launchJobs.get(jobId)?.startedAt, result: null, error: error.message });
      logger.error(`[BRAIN-LAUNCH] Error en ejecución: ${error.message}`);
    }).finally(() => {
      setTimeout(() => launchJobs.delete(jobId), LAUNCH_JOB_TTL);
    });
  } catch (error) {
    logger.error(`[BRAIN-LAUNCH] Error en approve: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/brain/launch/status/:jobId
 * Poll launch job status.
 */
router.get('/launch/status/:jobId', async (req, res) => {
  const job = launchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  if (job.status === 'running') return res.json({ status: 'running', elapsed_seconds: elapsed });
  if (job.status === 'completed') return res.json({ status: 'completed', elapsed_seconds: elapsed, ...job.result });
  return res.json({ status: 'failed', elapsed_seconds: elapsed, error: job.error });
});

module.exports = router;
