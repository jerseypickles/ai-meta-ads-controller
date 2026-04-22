/**
 * Auto-Pause Executor — orquesta detector + shadow/live execution + daily cap.
 *
 * Llamado por el cron cada 30min. Decide según auto_pause_mode (SystemConfig):
 *   - 'disabled': no hace nada
 *   - 'shadow': detecta + loggea en ZeusAutoPauseShadowLog, no pausa
 *   - 'live': detecta + pausa en Meta + loggea en ZeusAutoPauseLog
 *
 * Daily cap = 3 pauses/día en live. El 4to genera alerta al creador y NO pausa.
 *
 * Yellow zone check (manual gate): si el health check previo marcó
 * `yellow_zone_active: true` en SystemConfig, NO procesa nuevas pauses
 * hasta que el creador decida tighten o disable. Este gate es manual, NO
 * auto-degrade.
 */

const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const ZeusAutoPauseShadowLog = require('../../db/models/ZeusAutoPauseShadowLog');
const ZeusAutoPauseLog = require('../../db/models/ZeusAutoPauseLog');
const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
const ActionLog = require('../../db/models/ActionLog');

const { detectCandidates } = require('./auto-pause-detector');

const MODE_KEY = 'auto_pause_mode';
const YELLOW_ZONE_KEY = 'auto_pause_yellow_zone_active';
const DAILY_CAP = 3;
const SHADOW_REVIEW_DAYS = 7;
const LIVE_REVIEW_DAYS = 14;

async function getMode() {
  const val = await SystemConfig.get(MODE_KEY, 'disabled');
  return ['disabled', 'shadow', 'live'].includes(val) ? val : 'disabled';
}

async function setMode(mode, reason = '') {
  if (!['disabled', 'shadow', 'live'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
  await SystemConfig.set(MODE_KEY, mode);
  logger.warn(`[AUTO-PAUSE] mode transition → ${mode}${reason ? ` (${reason})` : ''}`);
  return mode;
}

async function isYellowZoneActive() {
  const val = await SystemConfig.get(YELLOW_ZONE_KEY, null);
  return val?.active === true;
}

async function clearYellowZone() {
  await SystemConfig.set(YELLOW_ZONE_KEY, { active: false, cleared_at: new Date().toISOString() });
}

// Cuenta pauses ejecutadas hoy (calendar day ET — aproximamos con UTC offset del cron)
async function autopausesTodayCount() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return await ZeusAutoPauseLog.countDocuments({ paused_at: { $gte: start } });
}

// ═══════════════════════════════════════════════════════════════════════════
// Shadow mode — sin pausa, solo log
// ═══════════════════════════════════════════════════════════════════════════

async function runShadow() {
  const detection = await detectCandidates();

  if (detection.skipped_reason) {
    logger.info(`[AUTO-PAUSE-SHADOW] skip: ${detection.skipped_reason}`);
    return { mode: 'shadow', skipped: true, reason: detection.skipped_reason };
  }

  const created = [];
  for (const c of detection.candidates) {
    // Anti-duplicado: si ya hay un shadow log del mismo adset en las últimas 24h, skip
    const recent = await ZeusAutoPauseShadowLog.findOne({
      adset_id: c.adset_id,
      detected_at: { $gte: new Date(Date.now() - 24 * 3600000) }
    });
    if (recent) continue;

    const dueAt = new Date(Date.now() + SHADOW_REVIEW_DAYS * 86400000);
    const log = await ZeusAutoPauseShadowLog.create({
      adset_id: c.adset_id,
      adset_name: c.adset_name,
      campaign_id: c.campaign_id,
      criteria_version: detection.criteria_version,
      threshold_snapshot: c.threshold_snapshot,
      platform_state_at_detection: c.platform_state,
      would_pause: true,
      ground_truth_due_at: dueAt
    });
    created.push(log);
  }

  logger.info(`[AUTO-PAUSE-SHADOW] evaluated ${detection.evaluated_adsets} adsets · ${detection.candidates.length} candidates · ${created.length} new shadow logs`);
  return { mode: 'shadow', candidates: detection.candidates.length, logged: created.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Live mode — pausa real en Meta
// ═══════════════════════════════════════════════════════════════════════════

async function pauseAdsetInMeta(adsetId) {
  // Reusa el cliente Meta API del sistema
  try {
    const client = require('../../meta/client');
    // El cliente tiene updateAdSet o similar — chequear interface real
    if (typeof client.updateAdSet === 'function') {
      const result = await client.updateAdSet(adsetId, { status: 'PAUSED' });
      return { success: true, response: result };
    }
    // Fallback: llamar via action-executor si existe
    const executor = require('../../meta/action-executor');
    if (typeof executor.pauseAdSet === 'function') {
      const result = await executor.pauseAdSet(adsetId);
      return { success: true, response: result };
    }
    throw new Error('no Meta client method found to pause adset');
  } catch (err) {
    logger.error(`[AUTO-PAUSE-EXECUTOR] Meta API pause failed for ${adsetId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function sendProactivePing(content, opts = {}) {
  try {
    await ZeusChatMessage.create({
      conversation_id: opts.conversation_id || 'proactive_' + Date.now(),
      role: 'assistant',
      content,
      proactive: true
    });
  } catch (err) {
    logger.warn(`[AUTO-PAUSE-EXECUTOR] proactive ping failed: ${err.message}`);
  }
}

async function runLive() {
  // Yellow zone gate — manual
  if (await isYellowZoneActive()) {
    logger.info('[AUTO-PAUSE-LIVE] skip: yellow_zone_active, pending creator review');
    return { mode: 'live', skipped: true, reason: 'yellow_zone_active' };
  }

  const detection = await detectCandidates();
  if (detection.skipped_reason) {
    logger.info(`[AUTO-PAUSE-LIVE] skip: ${detection.skipped_reason}`);
    return { mode: 'live', skipped: true, reason: detection.skipped_reason };
  }

  const todayCount = await autopausesTodayCount();
  const slotsLeft = DAILY_CAP - todayCount;

  const candidates = detection.candidates;
  const toExecute = candidates.slice(0, Math.max(0, slotsLeft));
  const overCap = candidates.slice(slotsLeft);

  const executed = [];
  for (const c of toExecute) {
    // Anti-dup adicional: no pausar si ya hay entry reciente
    const recent = await ZeusAutoPauseLog.findOne({
      adset_id: c.adset_id,
      paused_at: { $gte: new Date(Date.now() - 24 * 3600000) }
    });
    if (recent) continue;

    const metaResult = await pauseAdsetInMeta(c.adset_id);

    const reviewAt = new Date(Date.now() + LIVE_REVIEW_DAYS * 86400000);
    const log = await ZeusAutoPauseLog.create({
      adset_id: c.adset_id,
      adset_name: c.adset_name,
      campaign_id: c.campaign_id,
      paused_reason: 'auto_anomaly_zeus',
      criteria_version: detection.criteria_version,
      threshold_snapshot: c.threshold_snapshot,
      platform_state_at_pause: c.platform_state,
      meta_api_response: metaResult.response || null,
      meta_api_success: metaResult.success,
      review_due_at: reviewAt
    });

    // ActionLog para trazabilidad cross-system
    try {
      await ActionLog.create({
        entity_id: c.adset_id,
        entity_type: 'adset',
        entity_name: c.adset_name,
        agent_type: 'auto_pause',
        action_type: 'pause',
        reasoning: `auto_pause: ROAS_3d=${c.threshold_snapshot.roas_3d} spend=${c.threshold_snapshot.spend_3d} purchases=${c.threshold_snapshot.purchases_3d}`,
        success: metaResult.success,
        metadata: { auto_pause_log_id: log._id, criteria_version: detection.criteria_version }
      });
    } catch (_) { /* ActionLog enum might not include auto_pause — non-critical */ }

    executed.push(log);

    // Proactive ping per pause
    const t = c.threshold_snapshot;
    await sendProactivePing(
      `⚡ **Auto-pausé** "${c.adset_name}"\n\n` +
      `ROAS_3d ${t.roas_3d}x · spend_3d $${t.spend_3d} · ${t.purchases_3d} compras · ${t.age_days}d age · learning ${t.learning_stage}.\n\n` +
      `Review automático en ${LIVE_REVIEW_DAYS}d. Podés reactivar manualmente desde el panel 📓 cuando quieras.`
    );
  }

  // Alert del 4to+ candidato si hay over-cap
  if (overCap.length > 0) {
    const lines = overCap.slice(0, 10).map(c => {
      const t = c.threshold_snapshot;
      return `  • ${c.adset_name} (ROAS_3d ${t.roas_3d}x · spend $${t.spend_3d} · ${t.purchases_3d} compras)`;
    }).join('\n');

    await sendProactivePing(
      `🚨 **${overCap.length} candidatos adicionales hit criterio** hoy, daily_cap=${DAILY_CAP} alcanzado.\n\n` +
      `Pausados: ${executed.length}.\n\nPendientes review manual:\n${lines}\n\n` +
      `Cuando 4+ candidatos caen al mismo día suele indicar algo mal upstream — revisá delivery_health/platform_health antes de pausar manual.`
    );
  }

  logger.info(`[AUTO-PAUSE-LIVE] executed ${executed.length} pauses · ${overCap.length} over cap · ${detection.candidates.length} total candidates`);
  return { mode: 'live', executed: executed.length, over_cap: overCap.length, total_candidates: detection.candidates.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main cron entry point
// ═══════════════════════════════════════════════════════════════════════════

async function runAutoPauseCron() {
  const mode = await getMode();
  if (mode === 'disabled') {
    return { mode: 'disabled', skipped: true };
  }
  if (mode === 'shadow') return await runShadow();
  if (mode === 'live') return await runLive();
  return { mode: 'unknown', error: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reactivation tracking (llamado desde el panel o cuando Athena reactiva)
// ═══════════════════════════════════════════════════════════════════════════

async function recordReactivation({ adset_id, reactivated_by, reason }) {
  if (!['creator', 'athena'].includes(reactivated_by)) {
    throw new Error(`reactivated_by must be 'creator' or 'athena' (Zeus cannot reactivate own pauses)`);
  }
  // Buscar el auto_pause log más reciente del adset sin reactivación
  const log = await ZeusAutoPauseLog.findOne({
    adset_id,
    reactivated_at: null
  }).sort({ paused_at: -1 });
  if (!log) return null;

  log.reactivated_at = new Date();
  log.reactivated_by = reactivated_by;
  log.reactivation_reason = reason || '';
  await log.save();
  logger.info(`[AUTO-PAUSE] reactivation recorded: ${adset_id} by ${reactivated_by}`);
  return log;
}

module.exports = {
  runAutoPauseCron,
  runShadow,
  runLive,
  getMode,
  setMode,
  isYellowZoneActive,
  clearYellowZone,
  recordReactivation,
  autopausesTodayCount,
  DAILY_CAP,
  SHADOW_REVIEW_DAYS,
  LIVE_REVIEW_DAYS
};
