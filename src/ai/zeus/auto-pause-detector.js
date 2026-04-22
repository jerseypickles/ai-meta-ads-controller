/**
 * Auto-Pause Detector — Hilo C, core de la palanca ejecutiva bounded.
 *
 * Lógica pura de detección de candidatos — SIN side effects (no pausa, no
 * loggea, no llama Meta). Se comparte entre shadow mode y live mode.
 *
 * Diseño:
 * - Corre sobre el último snapshot de cada adset ACTIVE
 * - Aplica los 5 filtros del PRD (AND lógico)
 * - Respeta gates pre-evaluación: platform circuit breaker, Prometheus tests,
 *   delivery anomaly per-adset, anti-flap 24h
 *
 * NO aplica daily_cap aquí — eso se maneja en el executor (porque depende
 * del mode: shadow no cappea, live sí).
 *
 * Config versionada (criteria_version: 'v1'). Si se cambia, bumpear versión.
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const TestRun = require('../../db/models/TestRun');
const SafetyEvent = require('../../db/models/SafetyEvent');

const CRITERIA_VERSION = 'v1';

const CRITERIA = {
  roas_3d_max: 0.3,
  spend_3d_min: 150,
  purchases_3d_max: 1,
  age_days_min: 5,
  anti_flap_hours: 24
};

// ═══════════════════════════════════════════════════════════════════════════
// Platform gate — circuit breaker hard early-exit
// ═══════════════════════════════════════════════════════════════════════════

async function isPlatformHealthy() {
  try {
    const { isDegraded } = require('../../safety/platform-circuit-breaker');
    const state = await isDegraded();
    return {
      healthy: !state.degraded,
      signals: state.signals || [],
      reason: state.reason || null
    };
  } catch (err) {
    // Si no podemos evaluar platform health, fail-safe: asumir degraded.
    // Mejor skip un auto_pause que pausar sobre data corrupta.
    return { healthy: false, signals: [], reason: `circuit_breaker_unavailable: ${err.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-adset gates
// ═══════════════════════════════════════════════════════════════════════════

function meetsHardCriteria(snapshot) {
  const m = snapshot.metrics?.last_3d;
  if (!m) return { meets: false, reason: 'no_last_3d_metrics' };

  if ((m.roas || 0) >= CRITERIA.roas_3d_max) return { meets: false, reason: `roas_3d=${m.roas}` };
  if ((m.spend || 0) < CRITERIA.spend_3d_min) return { meets: false, reason: `spend_3d=${m.spend}` };
  if ((m.purchases || 0) > CRITERIA.purchases_3d_max) return { meets: false, reason: `purchases_3d=${m.purchases}` };

  // Age
  if (!snapshot.meta_created_time) return { meets: false, reason: 'no_meta_created_time' };
  const ageDays = (Date.now() - new Date(snapshot.meta_created_time).getTime()) / 86400000;
  if (ageDays < CRITERIA.age_days_min) return { meets: false, reason: `age_days=${ageDays.toFixed(1)}` };

  // Learning stage — no pausar adsets en LEARNING (ROAS volátil por diseño)
  if (snapshot.learning_stage === 'LEARNING') return { meets: false, reason: 'learning_stage=LEARNING' };

  return {
    meets: true,
    snapshot: {
      roas_3d: m.roas,
      spend_3d: m.spend,
      purchases_3d: m.purchases,
      age_days: +ageDays.toFixed(1),
      learning_stage: snapshot.learning_stage || 'UNKNOWN'
    }
  };
}

async function hasRecentPauseAction(adsetId) {
  const since = new Date(Date.now() - CRITERIA.anti_flap_hours * 3600000);
  const count = await ActionLog.countDocuments({
    entity_id: adsetId,
    action_type: { $in: ['pause', 'reactivate'] },
    executed_at: { $gte: since }
  });
  return count > 0;
}

async function isInActivePrometheusTest(adsetId) {
  const test = await TestRun.findOne({
    'entity_id': adsetId,
    phase: { $in: ['learning', 'evaluating'] }
  }).lean();
  return !!test;
}

async function hasActiveDeliveryAnomaly(adsetId) {
  const recentWindow = new Date(Date.now() - 6 * 3600000);  // últimas 6h
  const anomaly = await SafetyEvent.findOne({
    event_type: { $in: ['delivery_anomaly', 'adset_delivery_issue', 'adset_non_delivery'] },
    created_at: { $gte: recentWindow },
    'data.adset_id': adsetId
  }).lean();
  return !!anomaly;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main detector
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detecta candidatos a auto_pause. NO ejecuta — retorna la lista.
 * Gates aplicados: platform healthy + criterio duro + no recent pause +
 * not in Prometheus test + no active delivery anomaly.
 *
 * @returns {object} { platform, candidates: [...] }
 */
async function detectCandidates() {
  // Gate 1: platform circuit breaker
  const platform = await isPlatformHealthy();
  if (!platform.healthy) {
    return {
      platform,
      candidates: [],
      skipped_reason: 'platform_degraded',
      criteria_version: CRITERIA_VERSION
    };
  }

  // Cargar último snapshot de cada adset ACTIVE
  const latest = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);

  const candidates = [];
  for (const snapshot of latest) {
    const hardCheck = meetsHardCriteria(snapshot);
    if (!hardCheck.meets) continue;

    // Gates per-adset — todos se chequean en paralelo para performance
    const [recentPause, inTest, deliveryAnom] = await Promise.all([
      hasRecentPauseAction(snapshot.entity_id),
      isInActivePrometheusTest(snapshot.entity_id),
      hasActiveDeliveryAnomaly(snapshot.entity_id)
    ]);

    if (recentPause) continue;     // anti-flap
    if (inTest) continue;          // no canibalizar test de Prometheus
    if (deliveryAnom) continue;    // no confundir "roto" con "no entregando"

    candidates.push({
      adset_id: snapshot.entity_id,
      adset_name: snapshot.entity_name,
      campaign_id: snapshot.campaign_id || '',
      threshold_snapshot: hardCheck.snapshot,
      platform_state: {
        degraded: !platform.healthy,
        signals: platform.signals
      }
    });
  }

  return {
    platform,
    candidates,
    criteria_version: CRITERIA_VERSION,
    evaluated_adsets: latest.length
  };
}

module.exports = {
  detectCandidates,
  isPlatformHealthy,
  meetsHardCriteria,
  CRITERIA,
  CRITERIA_VERSION
};
