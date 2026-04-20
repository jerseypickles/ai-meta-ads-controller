/**
 * Zeus Execution Gate (Level 5) — decide si Zeus puede auto-ejecutar
 * una acción basado en authority + calibration track record + safety.
 *
 * Design principle: **defense in depth**. Cada ejecución pasa 4 gates:
 * 1. Authority enabled para la categoría
 * 2. Calibration sobre threshold con samples suficientes
 * 3. Daily cap no alcanzado
 * 4. Safety systems (kill switch, cooldowns) permiten
 *
 * Si cualquier gate falla, rebota a modo "propose to creator".
 */

const ZeusExecutionAuthority = require('../../db/models/ZeusExecutionAuthority');
const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');
const logger = require('../../utils/logger');

/**
 * Chequea si Zeus tiene autoridad para ejecutar una acción de esta categoría.
 * Retorna { allowed, reason, authority } — decision + diagnostic.
 */
async function checkAuthority(category, options = {}) {
  const auth = await ZeusExecutionAuthority.findOne({ category });
  if (!auth) {
    return {
      allowed: false,
      reason: `No authority configurado para ${category}. Creador debe setup primero.`,
      authority: null
    };
  }

  if (!auth.enabled) {
    return {
      allowed: false,
      reason: `Authority ${category} está DISABLED. Creador debe habilitarla explícitamente.`,
      authority: auth
    };
  }

  // Reset daily counter si pasaron 24h
  const now = new Date();
  if (!auth.last_reset_at || now - auth.last_reset_at > 86400000) {
    auth.daily_executions = 0;
    auth.last_reset_at = now;
    await auth.save();
  }

  if (auth.daily_executions >= auth.max_per_day) {
    return {
      allowed: false,
      reason: `Daily cap alcanzado para ${category} (${auth.daily_executions}/${auth.max_per_day}). Reset en 24h.`,
      authority: auth
    };
  }

  // Calibration gate — Zeus tiene que ser suficientemente bueno en esta categoría
  const outcomes = await ZeusRecommendationOutcome.find({
    category,
    'measurement_7d.verdict': { $ne: null }
  }).lean();

  if (outcomes.length < auth.min_calibration_samples) {
    return {
      allowed: false,
      reason: `Calibration samples insuficientes: ${outcomes.length}/${auth.min_calibration_samples}. Zeus necesita track record más extenso antes de auto-ejecutar ${category}.`,
      authority: auth
    };
  }

  const avgAccuracy = outcomes.reduce((s, o) => s + (o.measurement_7d.accuracy_score || 0), 0) / outcomes.length;
  if (avgAccuracy < auth.min_confidence) {
    return {
      allowed: false,
      reason: `Calibration accuracy ${(avgAccuracy * 100).toFixed(0)}% < threshold ${(auth.min_confidence * 100).toFixed(0)}%. Zeus no tiene suficiente track record para auto-${category}.`,
      authority: auth
    };
  }

  // Impact cap
  if (options.impact != null && options.impact > auth.max_impact_per_exec) {
    return {
      allowed: false,
      reason: `Impact ${options.impact} > max per exec ${auth.max_impact_per_exec}. Demasiado grande para auto.`,
      authority: auth
    };
  }

  return {
    allowed: true,
    authority: auth,
    calibration: {
      samples: outcomes.length,
      avg_accuracy: +avgAccuracy.toFixed(2),
      confidence_threshold: auth.min_confidence
    }
  };
}

/**
 * Registra una auto-ejecución. Incrementa counters.
 */
async function recordExecution(category) {
  await ZeusExecutionAuthority.updateOne(
    { category },
    {
      $inc: { daily_executions: 1, total_executions: 1 },
      $set: { last_executed_at: new Date() }
    }
  );
}

/**
 * Helper para habilitar authority con guardrails.
 */
async function enableAuthority(category, options = {}) {
  const auth = await ZeusExecutionAuthority.findOneAndUpdate(
    { category },
    {
      $set: {
        enabled: true,
        min_confidence: options.min_confidence ?? 0.85,
        min_calibration_samples: options.min_calibration_samples ?? 20,
        max_impact_per_exec: options.max_impact_per_exec ?? 100,
        max_per_day: options.max_per_day ?? 3,
        enabled_by: options.enabled_by || 'creator',
        enabled_at: new Date(),
        enable_reason: options.reason || '',
        updated_at: new Date()
      }
    },
    { upsert: true, new: true }
  );
  logger.info(`[ZEUS-AUTH] ENABLED ${category} — min_conf=${auth.min_confidence}, max_per_day=${auth.max_per_day}, max_impact=${auth.max_impact_per_exec}`);
  return auth;
}

async function disableAuthority(category, reason = '') {
  await ZeusExecutionAuthority.updateOne(
    { category },
    { $set: { enabled: false, updated_at: new Date() } }
  );
  logger.warn(`[ZEUS-AUTH] DISABLED ${category} — reason: ${reason}`);
}

async function getAllAuthorities() {
  return await ZeusExecutionAuthority.find({}).sort({ category: 1 }).lean();
}

module.exports = {
  checkAuthority,
  recordExecution,
  enableAuthority,
  disableAuthority,
  getAllAuthorities
};
