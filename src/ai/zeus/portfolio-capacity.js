/**
 * Portfolio Capacity Manager (hueco #3 del Zeus diagnosis).
 *
 * Concepto: la atención del algoritmo de Meta es finita. No solo el budget
 * en dólares, también el número de ad sets activos, la fracción en LEARNING,
 * la concurrencia de scales/duplications por día. Escalar más allá de ciertos
 * umbrales canibaliza performance (audience overlap, pixel stress, learning
 * phase cascading).
 *
 * Este módulo:
 *  1. Assessment de capacidad actual + utilización
 *  2. Gate `canExecuteAction(type)` que los agentes consultan antes de
 *     scale_up / duplicate_adset / create_ad
 *  3. Expone stats para que Zeus (Oracle) las use en decisiones estratégicas
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ActionLog = require('../../db/models/ActionLog');

// ═══ Umbrales ═══ (ajustables — arrancan conservadores para $3k/día)
const LIMITS = {
  max_active_adsets: 200,         // hard cap — >200 empieza canibalization
  max_scale_actions_24h: 15,      // scales + pauses por día
  max_duplications_24h: 8,        // duplicate_adset por día (Ares)
  max_ad_creations_24h: 20,       // create_ad por día
  max_learning_ratio: 0.60,       // >60% en LEARNING = ola de resets, freno
  max_actions_same_entity_24h: 3  // no tocar misma entidad >3x/día
};

async function assessCapacity() {
  const latest = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { created_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  const active = latest.filter(s => s.status === 'ACTIVE');
  const inLearning = active.filter(s => s.learning_stage === 'LEARNING');
  const learningRatio = active.length > 0 ? inLearning.length / active.length : 0;

  const since24h = new Date(Date.now() - 24 * 3600000);
  const [scaleActions, duplicationActions, creationActions] = await Promise.all([
    ActionLog.countDocuments({
      action_type: { $in: ['scale_up', 'scale_down', 'pause', 'reactivate'] },
      executed_at: { $gte: since24h },
      success: true
    }),
    ActionLog.countDocuments({
      action_type: 'duplicate_adset',
      executed_at: { $gte: since24h },
      success: true
    }),
    ActionLog.countDocuments({
      action_type: 'create_ad',
      executed_at: { $gte: since24h },
      success: true
    })
  ]);

  const pct = (num, denom) => denom > 0 ? Math.round((num / denom) * 100) : 0;

  return {
    metrics: {
      active_adsets: active.length,
      in_learning: inLearning.length,
      learning_ratio: +learningRatio.toFixed(3),
      scale_actions_24h: scaleActions,
      duplication_actions_24h: duplicationActions,
      ad_creations_24h: creationActions
    },
    limits: LIMITS,
    utilization: {
      adset_count_pct: pct(active.length, LIMITS.max_active_adsets),
      scale_capacity_pct: pct(scaleActions, LIMITS.max_scale_actions_24h),
      duplication_capacity_pct: pct(duplicationActions, LIMITS.max_duplications_24h),
      ad_creation_capacity_pct: pct(creationActions, LIMITS.max_ad_creations_24h),
      learning_ratio_pct: Math.round(learningRatio * 100)
    },
    flags: {
      near_adset_cap: active.length >= LIMITS.max_active_adsets * 0.85,
      scales_near_limit: scaleActions >= LIMITS.max_scale_actions_24h * 0.85,
      duplications_near_limit: duplicationActions >= LIMITS.max_duplications_24h * 0.85,
      too_much_learning: learningRatio > LIMITS.max_learning_ratio
    }
  };
}

/**
 * Gate principal. Retorna { allowed, reason, capacity } — los agentes llaman
 * esto antes de ejecutar acciones que presionan la capacidad sistémica.
 *
 * actionType: 'scale_up' | 'scale_down' | 'pause' | 'reactivate' |
 *             'duplicate_adset' | 'create_ad'
 * entityId (opcional): chequea límite por entidad
 */
async function canExecuteAction(actionType, entityId = null) {
  const cap = await assessCapacity();
  const m = cap.metrics;

  // Chequeo por entidad (si pasada)
  if (entityId) {
    const since24h = new Date(Date.now() - 24 * 3600000);
    const entityActions = await ActionLog.countDocuments({
      entity_id: entityId,
      executed_at: { $gte: since24h },
      success: true
    });
    if (entityActions >= LIMITS.max_actions_same_entity_24h) {
      return {
        allowed: false,
        reason: `entity ${entityId} ya recibió ${entityActions} acciones en 24h (max ${LIMITS.max_actions_same_entity_24h})`,
        capacity: cap
      };
    }
  }

  // Scale / pause / reactivate
  if (['scale_up', 'scale_down', 'pause', 'reactivate'].includes(actionType)) {
    if (m.scale_actions_24h >= LIMITS.max_scale_actions_24h) {
      return {
        allowed: false,
        reason: `daily scale/pause limit hit (${m.scale_actions_24h}/${LIMITS.max_scale_actions_24h})`,
        capacity: cap
      };
    }
  }

  // Duplicate — más estricto porque crea entidades nuevas
  if (actionType === 'duplicate_adset') {
    if (m.duplication_actions_24h >= LIMITS.max_duplications_24h) {
      return {
        allowed: false,
        reason: `daily duplication limit hit (${m.duplication_actions_24h}/${LIMITS.max_duplications_24h})`,
        capacity: cap
      };
    }
    if (m.active_adsets >= LIMITS.max_active_adsets) {
      return {
        allowed: false,
        reason: `active adset cap hit (${m.active_adsets}/${LIMITS.max_active_adsets}) — consolidar antes de duplicar más`,
        capacity: cap
      };
    }
    if (m.learning_ratio > LIMITS.max_learning_ratio) {
      return {
        allowed: false,
        reason: `learning ratio alto (${Math.round(m.learning_ratio * 100)}% > ${LIMITS.max_learning_ratio * 100}%) — esperar exits antes de sumar nuevos en LEARNING`,
        capacity: cap
      };
    }
  }

  // Create ad — diario cap
  if (actionType === 'create_ad') {
    if (m.ad_creations_24h >= LIMITS.max_ad_creations_24h) {
      return {
        allowed: false,
        reason: `daily ad creation limit hit (${m.ad_creations_24h}/${LIMITS.max_ad_creations_24h})`,
        capacity: cap
      };
    }
  }

  return { allowed: true, capacity: cap };
}

module.exports = { assessCapacity, canExecuteAction, LIMITS };
