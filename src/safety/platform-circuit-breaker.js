/**
 * Platform Circuit Breaker (hueco #1 del Zeus diagnosis).
 *
 * Detecta fallas a nivel de plataforma Meta (no del sistema interno) y activa
 * un "modo degradado" global donde los agentes suspenden writes hasta que la
 * plataforma vuelva a entregar normalmente.
 *
 * Señales que dispararán degradación:
 *   - spend_24h < 20% del baseline 7d (delivery colapsado)
 *   - ≥10 ad sets en WITH_ISSUES
 *   - >20 adsets ACTIVE con 0 delivery en 24h (freeze silencioso)
 *
 * Uso:
 *   const { isDegraded } = require('./platform-circuit-breaker');
 *   const state = await isDegraded();
 *   if (state.degraded) { ... skip writes ... }
 *
 * Cron: cada 15 min, registrado en index.js.
 */

const SystemConfig = require('../db/models/SystemConfig');
const MetricSnapshot = require('../db/models/MetricSnapshot');
const SafetyEvent = require('../db/models/SafetyEvent');
const logger = require('../utils/logger');

const STATE_KEY = 'platform_health_state';
const BASELINE_KEY = 'platform_baseline_7d';

const SPEND_RATIO_THRESHOLD = 0.20;
const MIN_WITH_ISSUES_COUNT = 10;
const MIN_ACTIVE_FOR_ZERO_CHECK = 20;
const MIN_BASELINE_FOR_RATIO_CHECK = 500;

/**
 * Calcula el baseline 7d (avg daily spend del portfolio en los últimos 7 días).
 * Se refresca cada vez que el sistema está healthy — así no queda contaminado
 * por los días de freeze.
 */
async function refreshBaselineIfHealthy(assessment) {
  if (assessment.degraded) return; // No contaminar baseline con data degradada
  const spend = assessment.metrics.spend_24h;
  if (spend < MIN_BASELINE_FOR_RATIO_CHECK) return; // ignora días flojos

  const existing = await SystemConfig.get(BASELINE_KEY, { samples: [], avg_daily_spend: 0 });
  const samples = (existing.samples || []).slice(-6); // últimos 6 días
  samples.push({ date: new Date().toISOString().substring(0, 10), spend });
  const avg = samples.reduce((s, x) => s + x.spend, 0) / samples.length;
  await SystemConfig.set(BASELINE_KEY, { samples, avg_daily_spend: avg, updated_at: new Date().toISOString() });
}

async function assessPlatformHealth() {
  const latest = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { created_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  const active = latest.filter(s => s.status === 'ACTIVE');
  const withIssues = latest.filter(s => s.status === 'WITH_ISSUES');

  const spend24h = active.reduce((s, a) => s + (a.last_1d?.spend || 0), 0);
  const impressions24h = active.reduce((s, a) => s + (a.last_1d?.impressions || 0), 0);
  const actuallyDelivering = active.filter(s => (s.last_1d?.spend || 0) > 0).length;

  const baseline = await SystemConfig.get(BASELINE_KEY, { avg_daily_spend: 0 });

  const signals = [];

  // Señal 1: spend colapsado vs baseline
  if (baseline.avg_daily_spend >= MIN_BASELINE_FOR_RATIO_CHECK) {
    const ratio = spend24h / baseline.avg_daily_spend;
    if (ratio < SPEND_RATIO_THRESHOLD) {
      signals.push({
        kind: 'spend_collapsed',
        severity: 'critical',
        detail: `spend_24h $${spend24h.toFixed(0)} vs baseline $${baseline.avg_daily_spend.toFixed(0)} (${(ratio * 100).toFixed(1)}%)`
      });
    }
  }

  // Señal 2: masa de adsets WITH_ISSUES
  if (withIssues.length >= MIN_WITH_ISSUES_COUNT) {
    signals.push({
      kind: 'mass_with_issues',
      severity: 'high',
      detail: `${withIssues.length} adsets en WITH_ISSUES (≥${MIN_WITH_ISSUES_COUNT})`
    });
  }

  // Señal 3: ad sets ACTIVE pero ninguno entrega — freeze silencioso
  if (active.length > MIN_ACTIVE_FOR_ZERO_CHECK && actuallyDelivering === 0) {
    signals.push({
      kind: 'zero_delivery_all_active',
      severity: 'critical',
      detail: `${active.length} adsets ACTIVE, 0 entregando en 24h (delivery silenciosamente cortado)`
    });
  }

  const degraded = signals.some(s => s.severity === 'critical');

  return {
    degraded,
    signals,
    metrics: {
      active_adsets: active.length,
      with_issues_adsets: withIssues.length,
      actually_delivering: actuallyDelivering,
      spend_24h: spend24h,
      impressions_24h: impressions24h,
      baseline_avg: baseline.avg_daily_spend || 0
    }
  };
}

async function updatePlatformState(assessment) {
  const prev = await SystemConfig.get(STATE_KEY, { degraded: false });
  const now = new Date();

  if (assessment.degraded && !prev.degraded) {
    await SystemConfig.set(STATE_KEY, {
      degraded: true,
      since: now.toISOString(),
      reason: assessment.signals.map(s => s.kind).join(','),
      signals: assessment.signals,
      metrics: assessment.metrics,
      last_check: now.toISOString()
    });
    try {
      await SafetyEvent.create({
        event_type: 'platform_degraded_enter',
        severity: 'critical',
        reason: `Platform degradation: ${assessment.signals.map(s => s.detail).join('; ')}`,
        data: assessment
      });
    } catch (_) {}
    logger.error(`[CIRCUIT-BREAKER] Platform DEGRADED — writes paused. Signals: ${assessment.signals.map(s => s.kind).join(', ')}`);
  } else if (!assessment.degraded && prev.degraded) {
    const durationMin = prev.since ? Math.round((now - new Date(prev.since)) / 60000) : null;
    await SystemConfig.set(STATE_KEY, {
      degraded: false,
      last_recovered: now.toISOString(),
      last_degraded_duration_min: durationMin,
      metrics: assessment.metrics
    });
    try {
      await SafetyEvent.create({
        event_type: 'platform_degraded_exit',
        severity: 'medium',
        reason: `Platform recovered after ${durationMin}min`,
        data: { previous_state: prev, current_metrics: assessment.metrics }
      });
    } catch (_) {}
    logger.info(`[CIRCUIT-BREAKER] Platform RECOVERED — writes re-enabled (duration ${durationMin}min)`);
  } else if (assessment.degraded) {
    await SystemConfig.set(STATE_KEY, {
      degraded: true,
      since: prev.since || now.toISOString(),
      reason: assessment.signals.map(s => s.kind).join(','),
      signals: assessment.signals,
      metrics: assessment.metrics,
      last_check: now.toISOString()
    });
  }

  await refreshBaselineIfHealthy(assessment);
}

/**
 * Helper que los agentes llaman para saber si pueden hacer writes.
 * Fail-safe: si la query falla, retornamos { degraded: false } — no queremos
 * que un glitch de Mongo pause todo el sistema silenciosamente.
 */
async function isDegraded() {
  try {
    const state = await SystemConfig.get(STATE_KEY, { degraded: false });
    return {
      degraded: !!state.degraded,
      reason: state.reason || '',
      since: state.since || null,
      signals: state.signals || []
    };
  } catch (err) {
    logger.warn(`[CIRCUIT-BREAKER] isDegraded check failed, assuming healthy: ${err.message}`);
    return { degraded: false };
  }
}

async function runHealthCheckCron() {
  try {
    const assessment = await assessPlatformHealth();
    await updatePlatformState(assessment);
    return assessment;
  } catch (err) {
    logger.error(`[CIRCUIT-BREAKER-CRON] ${err.message}`);
    return { error: err.message };
  }
}

module.exports = {
  assessPlatformHealth,
  isDegraded,
  updatePlatformState,
  runHealthCheckCron
};
