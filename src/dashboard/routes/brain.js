const express = require('express');
const router = express.Router();
const BrainAnalyzer = require('../../ai/brain/brain-analyzer');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainChat = require('../../db/models/BrainChat');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const BrainKnowledgeSnapshot = require('../../db/models/BrainKnowledgeSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');
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
            measured_at: phases.day_3.measured_at
          } : null,
          day_7: phases.day_7?.measured ? {
            verdict: phases.day_7.verdict,
            roas_pct: phases.day_7.deltas?.roas_pct,
            cpa_pct: phases.day_7.deltas?.cpa_pct,
            measured_at: phases.day_7.measured_at
          } : null,
          day_14: phases.day_14?.measured ? {
            verdict: phases.day_14.verdict,
            roas_pct: phases.day_14.deltas?.roas_pct,
            cpa_pct: phases.day_14.deltas?.cpa_pct,
            measured_at: phases.day_14.measured_at
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
    const pending = inProgress.map(r => {
      const before = r.follow_up?.metrics_at_recommendation || {};
      const hoursAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 3600000) : 0;
      const currentPhase = r.follow_up?.current_phase || 'awaiting_day_3';
      const phases = r.follow_up?.phases || {};
      return {
        _id: r._id,
        title: r.title,
        action_type: r.action_type,
        entity_name: r.entity?.entity_name,
        priority: r.priority,
        decided_at: r.decided_at,
        hours_since_approved: hoursAgo,
        current_phase: currentPhase,
        action_executed: r.follow_up?.action_executed || false,
        roas_at_approval: before.roas_7d || 0,
        cpa_at_approval: before.cpa_7d || 0,
        // Early phase data if available
        day_3: phases.day_3?.measured ? {
          verdict: phases.day_3.verdict,
          roas_pct: phases.day_3.deltas?.roas_pct
        } : null
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

module.exports = router;
