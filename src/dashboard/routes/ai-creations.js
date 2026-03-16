const express = require('express');
const router = express.Router();
const AICreation = require('../../db/models/AICreation');
const logger = require('../../utils/logger');

/**
 * GET /api/ai-creations
 * Listar todas las creaciones de la IA con filtros opcionales.
 */
router.get('/', async (req, res) => {
  try {
    const { type, verdict, limit = 50 } = req.query;
    const filter = {};
    if (type) filter.creation_type = type;
    if (verdict) filter.verdict = verdict;

    const creations = await AICreation.find(filter)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .lean();

    // Calcular stats generales
    const all = await AICreation.find({}).lean();
    const total = all.length;
    const positive = all.filter(c => c.verdict === 'positive').length;
    const negative = all.filter(c => c.verdict === 'negative').length;
    const pending = all.filter(c => c.verdict === 'pending').length;
    const successRate = total > 0 && (total - pending) > 0
      ? Math.round((positive / (total - pending)) * 100)
      : 0;

    res.json({
      creations,
      stats: {
        total,
        positive,
        negative,
        neutral: all.filter(c => c.verdict === 'neutral').length,
        pending,
        success_rate: successRate
      }
    });
  } catch (error) {
    logger.error('Error listando AI creations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-creations/stats
 * Estadisticas rapidas para badges/dashboard.
 */
router.get('/stats', async (req, res) => {
  try {
    const [total, positive, negative, pending] = await Promise.all([
      AICreation.countDocuments(),
      AICreation.countDocuments({ verdict: 'positive' }),
      AICreation.countDocuments({ verdict: 'negative' }),
      AICreation.countDocuments({ verdict: 'pending' })
    ]);

    const measured = total - pending;
    res.json({
      total,
      positive,
      negative,
      neutral: measured - positive - negative,
      pending,
      success_rate: measured > 0 ? Math.round((positive / measured) * 100) : 0
    });
  } catch (error) {
    logger.error('Error obteniendo stats de AI creations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-creations/launched-adsets
 * Ad sets launched from the panel, with scaling history and current metrics.
 * NOTE: Must be defined BEFORE /:id to avoid Express matching 'launched-adsets' as an :id param.
 */
router.get('/launched-adsets', async (req, res) => {
  try {
    const ActionLog = require('../../db/models/ActionLog');
    const { getLatestSnapshots } = require('../../db/queries');

    const creations = await AICreation.find({
      creation_type: 'create_adset',
      managed_by_ai: true,
      lifecycle_phase: { $nin: ['dead'] }
    }).sort({ created_at: -1 }).lean();

    const adsetSnaps = await getLatestSnapshots('adset');
    const snapMap = new Map(adsetSnaps.map(s => [s.entity_id, s]));

    // Get scaling actions for all AI ad sets
    const entityIds = creations.map(c => c.meta_entity_id);
    const scaleActions = await ActionLog.find({
      entity_id: { $in: entityIds },
      action: { $in: ['scale_up', 'scale_down'] },
      success: true
    }).sort({ executed_at: -1 }).lean();

    const scaleByEntity = {};
    for (const a of scaleActions) {
      if (!scaleByEntity[a.entity_id]) scaleByEntity[a.entity_id] = [];
      scaleByEntity[a.entity_id].push({
        action: a.action,
        before: a.before_value,
        after: a.after_value,
        change_pct: a.change_percent || 0,
        reward: a.learned_reward,
        reasoning: a.reasoning || '',
        executed_at: a.executed_at,
        agent_type: a.agent_type
      });
    }

    const result = creations.map(c => {
      const snap = snapMap.get(c.meta_entity_id);
      const m7d = snap?.metrics?.last_7d || {};
      const m3d = snap?.metrics?.last_3d || {};
      const scaling = scaleByEntity[c.meta_entity_id] || [];
      const daysOld = Math.round((Date.now() - new Date(c.created_at).getTime()) / 86400000);

      return {
        _id: c._id,
        adset_id: c.meta_entity_id,
        name: c.meta_entity_name,
        campaign_name: c.parent_entity_name || '',
        status: snap?.status || c.current_status || 'UNKNOWN',
        lifecycle_phase: c.lifecycle_phase,
        verdict: c.verdict || 'pending',
        days_old: daysOld,
        is_learning: daysOld < 7,
        // Budget
        initial_budget: c.initial_budget,
        current_budget: c.current_budget || c.initial_budget,
        // Current metrics
        roas_7d: m7d.roas || 0,
        roas_3d: m3d.roas || 0,
        cpa_7d: m7d.cpa || 0,
        spend_7d: m7d.spend || 0,
        purchases_7d: m7d.purchases || 0,
        frequency_7d: m7d.frequency || 0,
        ctr_7d: m7d.ctr || 0,
        daily_budget: snap?.daily_budget || c.current_budget || c.initial_budget,
        // Scaling history
        scale_actions: scaling.slice(0, 15),
        total_scale_ups: scaling.filter(s => s.action === 'scale_up').length,
        total_scale_downs: scaling.filter(s => s.action === 'scale_down').length,
        // AI Manager assessment
        last_assessment: c.last_manager_assessment || '',
        frequency_status: c.last_manager_frequency_status || 'unknown',
        needs_new_creatives: c.last_manager_needs_new_creatives || false,
        last_check: c.last_manager_check || null,
        created_at: c.created_at
      };
    });

    res.json({ adsets: result });
  } catch (error) {
    logger.error('Error listing launched adsets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-creations/:id
 * Detalle de una creacion especifica.
 * NOTE: Must be AFTER all named routes to avoid catching them as :id.
 */
router.get('/:id', async (req, res) => {
  try {
    const creation = await AICreation.findById(req.params.id).lean();
    if (!creation) return res.status(404).json({ error: 'Creacion no encontrada' });
    res.json(creation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
