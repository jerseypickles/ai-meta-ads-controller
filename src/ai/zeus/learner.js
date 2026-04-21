/**
 * Zeus Learner (Level 1) — trackea outcomes, mide impacto real, calibra confidence.
 *
 * Post-mortem cron corre diariamente:
 * - Para cada outcome con applied_at, verifica si pasaron 7/30/90d
 * - Mide snapshot actual de la entity + comparación con baseline
 * - Calcula accuracy_score (0-1) vs predicción
 * - Veredicto: confirmed | partial | missed | inverse
 */

const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const logger = require('../../utils/logger');

const MS_DAY = 86400000;

/**
 * Toma un snapshot actual de una entidad y lo compara con baseline.
 * Retorna objeto con métricas + actual_direction + verdict.
 */
async function measureImpact(outcome, windowDays) {
  if (!outcome.entity_id) {
    // Sin entity — mediciones agregadas del portfolio
    return null;
  }

  const current = await MetricSnapshot.findOne({
    entity_id: outcome.entity_id,
    entity_type: outcome.entity_type || 'adset'
  }).sort({ snapshot_at: -1 }).lean();

  if (!current) return null;

  const baseline = outcome.baseline || {};
  const window = windowDays >= 90 ? 'last_14d' : windowDays >= 30 ? 'last_14d' : 'last_7d';
  const currentMetrics = current.metrics?.[window] || {};

  const baselineRoas = baseline.roas || 0;
  const currentRoas = currentMetrics.roas || 0;
  const roasDelta = currentRoas - baselineRoas;
  const roasPct = baselineRoas > 0 ? (roasDelta / baselineRoas) : 0;

  let actualDirection = 'neutral';
  if (Math.abs(roasPct) < 0.05) actualDirection = 'neutral';
  else if (roasDelta > 0) actualDirection = 'up';
  else actualDirection = 'down';

  // Verdict
  let verdict = 'partial';
  if (outcome.predicted_direction === actualDirection && Math.abs(roasPct) > 0.05) {
    verdict = 'confirmed';
  } else if (outcome.predicted_direction !== 'unknown' &&
             outcome.predicted_direction !== 'neutral' &&
             actualDirection !== 'neutral' &&
             outcome.predicted_direction !== actualDirection) {
    verdict = 'inverse';
  } else if (Math.abs(roasPct) < 0.05) {
    verdict = 'missed';
  }

  // Accuracy 0-1
  let accuracy = 0.5;
  if (verdict === 'confirmed') accuracy = 0.85 + Math.min(0.15, Math.abs(roasPct));
  else if (verdict === 'partial') accuracy = 0.5;
  else if (verdict === 'missed') accuracy = 0.25;
  else if (verdict === 'inverse') accuracy = 0.0;

  return {
    measured_at: new Date(),
    metrics: {
      current_roas: +currentRoas.toFixed(2),
      baseline_roas: +baselineRoas.toFixed(2),
      roas_delta: +roasDelta.toFixed(2),
      roas_pct_change: +(roasPct * 100).toFixed(1),
      current_spend_7d: Math.round(currentMetrics.spend || 0),
      baseline_spend_7d: Math.round(baseline.spend || 0)
    },
    actual_direction: actualDirection,
    actual_magnitude: `${roasPct > 0 ? '+' : ''}${(roasPct * 100).toFixed(1)}% ROAS`,
    accuracy_score: +accuracy.toFixed(2),
    verdict
  };
}

/**
 * Cron diario: busca outcomes aplicados que necesitan medición y las hace.
 */
async function runPostMortemCron() {
  const now = Date.now();
  const results = { measured_7d: 0, measured_30d: 0, measured_90d: 0, errors: 0 };

  try {
    // 7 días
    const ready7d = await ZeusRecommendationOutcome.find({
      applied_at: { $lte: new Date(now - 7 * MS_DAY) },
      'measurement_7d.measured_at': null
    }).limit(50).lean();

    for (const o of ready7d) {
      try {
        const m = await measureImpact(o, 7);
        if (m) {
          await ZeusRecommendationOutcome.updateOne(
            { _id: o._id },
            { $set: { measurement_7d: m } }
          );
          results.measured_7d++;
        }
      } catch (err) {
        results.errors++;
      }
    }

    // 30 días
    const ready30d = await ZeusRecommendationOutcome.find({
      applied_at: { $lte: new Date(now - 30 * MS_DAY) },
      'measurement_30d.measured_at': null
    }).limit(50).lean();

    for (const o of ready30d) {
      try {
        const m = await measureImpact(o, 30);
        if (m) {
          await ZeusRecommendationOutcome.updateOne(
            { _id: o._id },
            { $set: { measurement_30d: m } }
          );
          results.measured_30d++;
        }
      } catch (err) {
        results.errors++;
      }
    }

    // 90 días
    const ready90d = await ZeusRecommendationOutcome.find({
      applied_at: { $lte: new Date(now - 90 * MS_DAY) },
      'measurement_90d.measured_at': null
    }).limit(50).lean();

    for (const o of ready90d) {
      try {
        const m = await measureImpact(o, 90);
        if (m) {
          await ZeusRecommendationOutcome.updateOne(
            { _id: o._id },
            { $set: { measurement_90d: m } }
          );
          results.measured_90d++;
        }
      } catch (err) {
        results.errors++;
      }
    }

    logger.info(`[ZEUS-LEARNER] Post-mortem: 7d=${results.measured_7d}, 30d=${results.measured_30d}, 90d=${results.measured_90d}, err=${results.errors}`);

    // Episodic memory backfill — cuando un outcome tiene 30d medido, lo convertimos
    // en episodio con embedding para que Zeus pueda razonar por analogía después.
    try {
      const { backfillPendingEpisodes } = require('./episodic-memory');
      const ep = await backfillPendingEpisodes(20);
      if (ep.created > 0) results.episodes_created = ep.created;
    } catch (err) {
      logger.warn(`[ZEUS-LEARNER] episodic backfill falló: ${err.message}`);
    }

    return results;
  } catch (err) {
    logger.error(`[ZEUS-LEARNER] Post-mortem failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Genera stats de calibración por categoría/tipo.
 * Retorna: { category: { total, accuracy_avg, verdicts_breakdown } }
 */
async function getCalibrationStats(options = {}) {
  const filter = { 'measurement_7d.verdict': { $ne: null } };
  if (options.rec_type) filter.rec_type = options.rec_type;
  if (options.category) filter.category = options.category;
  if (options.since) filter.applied_at = { $gte: new Date(options.since) };

  const outcomes = await ZeusRecommendationOutcome.find(filter).lean();

  const byCategory = {};
  for (const o of outcomes) {
    const cat = o.category || o.rec_type || 'general';
    if (!byCategory[cat]) {
      byCategory[cat] = {
        total: 0,
        accuracy_sum: 0,
        confirmed: 0,
        partial: 0,
        missed: 0,
        inverse: 0
      };
    }
    const b = byCategory[cat];
    b.total += 1;
    b.accuracy_sum += o.measurement_7d.accuracy_score || 0;
    const v = o.measurement_7d.verdict;
    if (v in b) b[v] += 1;
  }

  const summary = {};
  for (const [cat, b] of Object.entries(byCategory)) {
    summary[cat] = {
      total: b.total,
      accuracy_avg: +(b.accuracy_sum / b.total).toFixed(2),
      confirmed_rate: +((b.confirmed / b.total) * 100).toFixed(1),
      inverse_rate: +((b.inverse / b.total) * 100).toFixed(1),
      verdicts: {
        confirmed: b.confirmed,
        partial: b.partial,
        missed: b.missed,
        inverse: b.inverse
      }
    };
  }

  return {
    total_measured: outcomes.length,
    by_category: summary,
    generated_at: new Date().toISOString()
  };
}

module.exports = { runPostMortemCron, measureImpact, getCalibrationStats };
