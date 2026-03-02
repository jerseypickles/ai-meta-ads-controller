const express = require('express');
const router = express.Router();
const BrainAnalyzer = require('../../ai/brain/brain-analyzer');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainChat = require('../../db/models/BrainChat');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
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
      BrainInsight.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
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

module.exports = router;
