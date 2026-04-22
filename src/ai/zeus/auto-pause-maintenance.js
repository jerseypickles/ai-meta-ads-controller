/**
 * Auto-Pause Maintenance — crons que mantienen el archive y aplican kill criteria.
 *
 * Tres funciones principales:
 *
 * 1. runShadowGroundTruthCron: a T+7d del detected_at de cada shadow log,
 *    mide qué pasó con el adset (si NO se hubiera pausado) y clasifica verdict.
 *
 * 2. runLivePostReactivationCron: 7d después de cada reactivación por
 *    Athena o creador sobre un auto_pause, mide roas_7d post-reactivación
 *    y clasifica verdict (FP confirmado si ROAS >= 1.5x).
 *
 * 3. runHealthCheckCron: evalúa kill criteria (FP rate, delivery confounds,
 *    drift behavioral). Si cualquiera dispara → setea yellow_zone o
 *    auto-disable según severidad.
 *
 * Todas corren via cron diario.
 */

const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const ZeusAutoPauseShadowLog = require('../../db/models/ZeusAutoPauseShadowLog');
const ZeusAutoPauseLog = require('../../db/models/ZeusAutoPauseLog');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const ZeusCodeRecommendation = require('../../db/models/ZeusCodeRecommendation');
const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
const SafetyEvent = require('../../db/models/SafetyEvent');
const MetricSnapshot = require('../../db/models/MetricSnapshot');

const { setMode } = require('./auto-pause-executor');

const YELLOW_ZONE_KEY = 'auto_pause_yellow_zone_active';
const FP_THRESHOLD_GREEN_TO_YELLOW = 0.15;   // >15% → yellow
const FP_THRESHOLD_YELLOW_TO_RED = 0.20;     // >20% → red (auto-disable)
const MIN_FOR_HEALTH_ASSESSMENT = 20;        // necesitamos 20 verdicts antes de actuar

// ═══════════════════════════════════════════════════════════════════════════
// Ground truth crons
// ═══════════════════════════════════════════════════════════════════════════

async function measureAdsetMetrics7d(adsetId, sinceDate) {
  // Usa el snapshot más reciente (que tiene ventanas agregadas)
  const snap = await MetricSnapshot.findOne({ entity_id: adsetId, entity_type: 'adset' })
    .sort({ snapshot_at: -1 })
    .lean();
  if (!snap) return null;
  const m = snap.metrics?.last_7d || {};
  return {
    roas: m.roas || 0,
    spend: m.spend || 0,
    purchases: m.purchases || 0,
    measured_at: new Date()
  };
}

function classifyShadowVerdict(groundTruth) {
  if (groundTruth.roas < 1.0) return { verdict: 'correct_pause', reason: `roas_7d=${groundTruth.roas} <1.0` };
  if (groundTruth.roas >= 1.5) return { verdict: 'false_positive', reason: `roas_7d=${groundTruth.roas} >=1.5` };
  return { verdict: 'ambiguous', reason: `roas_7d=${groundTruth.roas} in [1.0,1.5)` };
}

async function runShadowGroundTruthCron() {
  const pending = await ZeusAutoPauseShadowLog.find({
    ground_truth_completed: false,
    ground_truth_due_at: { $lte: new Date() }
  }).limit(100);

  let completed = 0;
  for (const log of pending) {
    try {
      const gt = await measureAdsetMetrics7d(log.adset_id, log.detected_at);
      if (!gt) {
        logger.warn(`[AUTO-PAUSE-GT] no metrics for ${log.adset_id}, marking ambiguous`);
        log.verdict = 'ambiguous';
        log.verdict_reason = 'no metrics available at T+7d';
        log.ground_truth_completed = true;
        await log.save();
        continue;
      }
      const verdict = classifyShadowVerdict(gt);
      log.ground_truth_7d = gt;
      log.verdict = verdict.verdict;
      log.verdict_reason = verdict.reason;
      log.ground_truth_completed = true;
      await log.save();
      completed++;
    } catch (err) {
      logger.error(`[AUTO-PAUSE-GT] shadow log ${log._id} failed: ${err.message}`);
    }
  }
  logger.info(`[AUTO-PAUSE-GT-SHADOW] ${completed}/${pending.length} shadow verdicts completed`);
  return { completed, pending: pending.length };
}

async function runLivePostReactivationCron() {
  // Live logs reactivados cuyo review_due está vencido y todavía no tienen verdict
  const pending = await ZeusAutoPauseLog.find({
    reactivated_at: { $ne: null },
    verdict: 'pending',
    review_due_at: { $lte: new Date() }
  }).limit(100);

  let completed = 0;
  for (const log of pending) {
    try {
      const gt = await measureAdsetMetrics7d(log.adset_id, log.reactivated_at);
      if (!gt) {
        log.verdict = 'ambiguous';
        log.verdict_reason = 'no metrics post-reactivation';
        log.verdict_measured_at = new Date();
        await log.save();
        continue;
      }
      log.ground_truth_post_reactivation = gt;
      if (gt.roas >= 1.5) {
        log.verdict = 'false_positive';
        log.verdict_reason = `post-reactivation roas_7d=${gt.roas} >=1.5 — FP confirmado`;
      } else if (gt.roas < 1.0) {
        log.verdict = 'correct_pause';
        log.verdict_reason = `post-reactivation roas_7d=${gt.roas} <1.0 — pausa estaba bien`;
      } else {
        log.verdict = 'ambiguous';
        log.verdict_reason = `post-reactivation roas_7d=${gt.roas} in [1.0,1.5)`;
      }
      log.verdict_measured_at = new Date();
      await log.save();
      completed++;
    } catch (err) {
      logger.error(`[AUTO-PAUSE-GT] live log ${log._id} failed: ${err.message}`);
    }
  }

  // Los NO reactivados en 14d se clasifican correct_pause por default
  const unreactivated = await ZeusAutoPauseLog.find({
    reactivated_at: null,
    verdict: 'pending',
    review_due_at: { $lte: new Date() }
  }).limit(100);

  for (const log of unreactivated) {
    log.verdict = 'correct_pause';
    log.verdict_reason = 'no reactivation within 14d → assumed correct';
    log.verdict_measured_at = new Date();
    await log.save();
  }

  logger.info(`[AUTO-PAUSE-GT-LIVE] ${completed} reactivated verdicts · ${unreactivated.length} unreactivated → correct_pause default`);
  return { reactivated_completed: completed, unreactivated_classified: unreactivated.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Health check — kill criteria + zone detection
// ═══════════════════════════════════════════════════════════════════════════

async function computeFPRate() {
  // Combinar live + shadow logs clasificados, últimos 20
  const liveRecent = await ZeusAutoPauseLog.find({ verdict: { $in: ['correct_pause', 'false_positive', 'ambiguous'] } })
    .sort({ paused_at: -1 })
    .limit(20)
    .lean();
  const count = liveRecent.length;
  if (count < MIN_FOR_HEALTH_ASSESSMENT) return { count, fp_rate: null, ready: false };
  const fp = liveRecent.filter(l => l.verdict === 'false_positive').length;
  return { count, fp_rate: fp / count, ready: true };
}

async function detectDeliveryConfounds() {
  // Casos donde auto_pause disparó durante platform_degraded activo
  const confounded = await ZeusAutoPauseLog.find({
    'platform_state_at_pause.degraded': true
  }).lean();
  return confounded.length;
}

async function detectDriftBehavioral() {
  const signals = [];

  // 1. Code recommendation que proponga relajar thresholds
  // Busca recs que toquen auto-pause-detector.js y mencionen relajar/bajar threshold
  const suspectRecs = await ZeusCodeRecommendation.find({
    file_path: /auto-pause/i,
    $or: [
      { rationale: /relajar|bajar|reducir.*(threshold|roas|spend)/i },
      { proposed_code: /roas_3d_max.*0\.[12]/i }
    ],
    status: { $in: ['pending', 'accepted'] }
  }).lean();
  if (suspectRecs.length > 0) {
    signals.push({
      kind: 'code_rec_threshold_relaxation',
      severity: 'high',
      count: suspectRecs.length,
      rec_ids: suspectRecs.map(r => r._id)
    });
  }

  // 2. Journal entry con tag de relaxation
  const suspectJournals = await ZeusJournalEntry.find({
    tags: { $in: ['threshold_relaxation_proposal', 'relax_auto_pause'] },
    created_at: { $gte: new Date(Date.now() - 30 * 86400000) }
  }).lean();
  if (suspectJournals.length > 0) {
    signals.push({
      kind: 'journal_threshold_relaxation',
      severity: 'medium',
      count: suspectJournals.length,
      journal_ids: suspectJournals.map(j => j._id)
    });
  }

  return signals;
}

async function sendHealthPing(content) {
  try {
    await ZeusChatMessage.create({
      conversation_id: 'auto_pause_health_' + Date.now(),
      role: 'assistant',
      content,
      proactive: true
    });
  } catch (err) {
    logger.warn(`[AUTO-PAUSE-HEALTH] ping failed: ${err.message}`);
  }
}

async function runHealthCheckCron() {
  const fpStats = await computeFPRate();
  const deliveryConfounds = await detectDeliveryConfounds();
  const driftSignals = await detectDriftBehavioral();

  const report = {
    fp_stats: fpStats,
    delivery_confounds: deliveryConfounds,
    drift_signals: driftSignals,
    action: 'none',
    zone: 'green'
  };

  // KILL CRITERIA #2: >=2 casos con platform_degraded
  if (deliveryConfounds >= 2) {
    report.action = 'disable';
    report.reason = `${deliveryConfounds} pauses con platform_degraded concurrente (kill_criteria_2)`;
    await setMode('disabled', report.reason);
    await sendHealthPing(`🚨 **Auto-pause DESACTIVADO** — kill criteria #2 triggered.\n${deliveryConfounds} pauses se ejecutaron con platform circuit breaker degraded concurrente. El threshold no distingue "roto" de "no entregando". Revisar logs y ajustar antes de reactivar.`);
    return report;
  }

  // KILL CRITERIA #3: drift behavioral (Zeus propone relajar antes de 20+ outcomes)
  const hasRelaxationWithoutEvidence = driftSignals.some(s => s.kind.includes('threshold_relaxation'))
    && fpStats.count < MIN_FOR_HEALTH_ASSESSMENT;
  if (hasRelaxationWithoutEvidence) {
    report.action = 'disable';
    report.reason = `drift behavioral: Zeus propone relajar thresholds con solo ${fpStats.count} outcomes (< ${MIN_FOR_HEALTH_ASSESSMENT} requeridos)`;
    await setMode('disabled', report.reason);
    await sendHealthPing(`🚨 **Auto-pause DESACTIVADO** — kill criteria #3 triggered.\nZeus propuso relajar thresholds con solo ${fpStats.count} outcomes cerrados (mínimo ${MIN_FOR_HEALTH_ASSESSMENT}). Esta es señal pre-comprometida de drift propio — la palanca se apagó por diseño. Para reactivar: rechazar la propuesta + toggle manual.\n\nSignals: ${driftSignals.map(s => s.kind).join(', ')}`);
    return report;
  }

  // ZONE detection basado en FP rate
  if (fpStats.ready) {
    if (fpStats.fp_rate > FP_THRESHOLD_YELLOW_TO_RED) {
      report.zone = 'red';
      report.action = 'disable';
      report.reason = `FP rate ${(fpStats.fp_rate * 100).toFixed(1)}% > ${FP_THRESHOLD_YELLOW_TO_RED * 100}% (kill_criteria_1)`;
      await setMode('disabled', report.reason);
      await sendHealthPing(`🚨 **Auto-pause DESACTIVADO** — kill criteria #1 triggered. FP rate ${(fpStats.fp_rate * 100).toFixed(1)}% sobre ${fpStats.count} pauses clasificadas (threshold ${FP_THRESHOLD_YELLOW_TO_RED * 100}%).`);
    } else if (fpStats.fp_rate > FP_THRESHOLD_GREEN_TO_YELLOW) {
      report.zone = 'yellow';
      report.action = 'yellow_zone_activated';
      // Yellow zone: NO auto-tightea — setea flag para que el executor bloquee nuevas pauses
      await SystemConfig.set(YELLOW_ZONE_KEY, {
        active: true,
        triggered_at: new Date().toISOString(),
        fp_rate: fpStats.fp_rate,
        count: fpStats.count
      });
      await sendHealthPing(`⚠️ **Auto-pause ZONA AMARILLA** — FP rate ${(fpStats.fp_rate * 100).toFixed(1)}% sobre ${fpStats.count} pauses (threshold yellow ${FP_THRESHOLD_GREEN_TO_YELLOW * 100}%).\n\nNuevas pauses BLOQUEADAS hasta tu decisión. Opciones:\n1. Aprobar tightening de thresholds (ROAS_3d <0.2 + spend ≥$200) y reactivar\n2. Desactivar palanca (disable)\n3. Investigar casos uno por uno y clear yellow zone sin cambios\n\nEl auto-degrade NO es automático — esperando tu call.`);
    } else {
      // Verde: si había yellow zone activa, podría limpiarse con tu aprobación manual (no auto)
      report.zone = 'green';
    }
  }

  return report;
}

module.exports = {
  runShadowGroundTruthCron,
  runLivePostReactivationCron,
  runHealthCheckCron,
  computeFPRate,
  detectDriftBehavioral,
  FP_THRESHOLD_GREEN_TO_YELLOW,
  FP_THRESHOLD_YELLOW_TO_RED,
  MIN_FOR_HEALTH_ASSESSMENT
};
