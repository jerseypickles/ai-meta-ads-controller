const { getAdsForAdSet } = require('../../db/queries');
const ActionLog = require('../../db/models/ActionLog');
const AICreation = require('../../db/models/AICreation');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');
const logger = require('../../utils/logger');

/**
 * Hardcoded decision tree — reglas de emergencia que no requieren Claude.
 * Extraído de manager.js para uso compartido con Account Agent.
 *
 * @param {Object} params
 * @returns {Object|null} - { forced, action, reason, actionsExecuted } o null si no aplica
 */
async function hardcodedDecisionTree({
  creation, adSetId, adSetRoas, adSetSpend, adSetPurchases, adSetFrequency,
  daysSinceCreation, adsData, brainDirectives, roas3d,
  currentBudget, meta, metricsAtExecution
}) {
  const activeAds = adsData.filter(a => a.status === 'ACTIVE');
  const suppressDirectives = brainDirectives.filter(d => d.type === 'suppress');
  const criticalDirectives = brainDirectives.filter(d => d.urgency === 'critical');

  // ─── LEARNING PHASE GUARD: No hardcoded actions during first 7 days ───
  if (daysSinceCreation < 7) {
    logger.info(`[SAFETY-DECISIONS] ${creation.meta_entity_name}: Learning phase (${daysSinceCreation.toFixed(1)}d < 7d) — all hardcoded rules skipped`);
    return null;
  }

  // ─── RULE 1: Zero purchases, enough time and spend → KILL ───
  if (daysSinceCreation >= 7 && adSetSpend >= 50 && adSetPurchases === 0) {
    return await forceKill(creation, adSetId, meta, metricsAtExecution,
      `RULE 1: ${daysSinceCreation.toFixed(0)}d activo, $${adSetSpend.toFixed(0)} gastado, 0 compras — dead weight`);
  }

  // ─── RULE 2: Hemorrhaging money (very low ROAS with significant spend) → KILL ───
  if (daysSinceCreation >= 5 && adSetSpend >= 40 && adSetRoas < 0.5 && adSetRoas > 0) {
    return await forceKill(creation, adSetId, meta, metricsAtExecution,
      `RULE 2: ROAS ${adSetRoas.toFixed(2)}x < 0.5x con $${adSetSpend.toFixed(0)} gastado — hemorrhaging`);
  }

  // ─── RULE 3: Long-running underperformer + Brain agrees → KILL ───
  if (daysSinceCreation >= 10 && adSetRoas < kpiTargets.roas_minimum && suppressDirectives.length >= 5) {
    return await forceKill(creation, adSetId, meta, metricsAtExecution,
      `RULE 3: ${daysSinceCreation.toFixed(0)}d, ROAS ${adSetRoas.toFixed(2)}x < ${kpiTargets.roas_minimum}x, ${suppressDirectives.length} suppress directives`);
  }

  // ─── RULE 4: At or below 1.0x ROAS (breakeven/losing) → FORCE 50% SCALE DOWN ───
  if (daysSinceCreation >= 4 && adSetSpend >= 30 && adSetRoas <= 1.0 && adSetRoas > 0 && adSetPurchases > 0) {
    const minBudget = safetyGuards.min_adset_budget || 10;
    if (currentBudget > minBudget) {
      const newBudget = Math.max(Math.round(currentBudget * 0.5 * 100) / 100, minBudget);
      return await forceScaleDown(creation, adSetId, meta, metricsAtExecution, currentBudget, newBudget,
        `RULE 4: ROAS ${adSetRoas.toFixed(2)}x <= 1.0x con $${adSetSpend.toFixed(0)} gastado en ${daysSinceCreation.toFixed(0)}d — breakeven/perdiendo, forzando 50% corte`);
    }
  }

  // ─── RULE 5: Critical frequency + below target → FORCE SCALE DOWN ───
  if (adSetFrequency >= kpiTargets.frequency_critical && adSetRoas < kpiTargets.roas_target && daysSinceCreation >= 3) {
    const minBudget = safetyGuards.min_adset_budget || 10;
    if (currentBudget > minBudget) {
      const newBudget = Math.max(Math.round(currentBudget * 0.6 * 100) / 100, minBudget);
      return await forceScaleDown(creation, adSetId, meta, metricsAtExecution, currentBudget, newBudget,
        `RULE 5: Frequency ${adSetFrequency.toFixed(1)} >= ${kpiTargets.frequency_critical} + ROAS ${adSetRoas.toFixed(2)}x < target — audience saturated`);
    }
  }

  // ─── RULE 6: Brain says CRITICAL urgency + ROAS below minimum → KILL ───
  if (criticalDirectives.length >= 2 && adSetRoas < kpiTargets.roas_minimum && adSetSpend >= 20) {
    return await forceKill(creation, adSetId, meta, metricsAtExecution,
      `RULE 6: ${criticalDirectives.length} critical directives + ROAS ${adSetRoas.toFixed(2)}x < ${kpiTargets.roas_minimum}x`);
  }

  // ─── RULE 7: Below roas_minimum with significant spend and time → FORCE 40% SCALE DOWN ───
  if (daysSinceCreation >= 5 && adSetSpend >= 100 && adSetRoas < kpiTargets.roas_minimum && adSetRoas > 0 && adSetPurchases > 0) {
    const minBudget = safetyGuards.min_adset_budget || 10;
    if (currentBudget > minBudget) {
      const newBudget = Math.max(Math.round(currentBudget * 0.6 * 100) / 100, minBudget);
      return await forceScaleDown(creation, adSetId, meta, metricsAtExecution, currentBudget, newBudget,
        `RULE 7: ROAS ${adSetRoas.toFixed(2)}x < ${kpiTargets.roas_minimum}x (mínimo) con $${adSetSpend.toFixed(0)} gastado en ${daysSinceCreation.toFixed(0)}d — bajo rendimiento sostenido, forzando 40% corte`);
    }
  }

  // No hardcoded rule triggered — let Claude decide
  return null;
}

/**
 * Pause ALL active ads + scale budget to minimum.
 * Used for dead/hemorrhaging ad sets.
 */
async function forceKill(creation, adSetId, meta, metricsAtExecution, reason) {
  try {
    const minBudget = safetyGuards.min_adset_budget || 10;
    let actionCount = 0;

    // 1. Pause ALL active ads (never pause the ad set itself)
    const adsData = await getAdsForAdSet(adSetId);
    const activeAds = adsData.filter(a => a.status === 'ACTIVE');
    for (const ad of activeAds) {
      try {
        await meta.updateAdStatus(ad.entity_id || ad.ad_id, 'PAUSED');
        logger.info(`[SAFETY-DECISIONS] Paused ad ${ad.entity_id || ad.ad_id} — ${reason}`);
        actionCount++;
      } catch (adErr) {
        logger.error(`[SAFETY-DECISIONS] Error pausing ad ${ad.entity_id || ad.ad_id}: ${adErr.message}`);
      }
    }

    // 2. Scale budget to minimum
    const oldBudget = creation.current_budget || creation.initial_budget;
    if (oldBudget > minBudget) {
      await meta.updateBudget(adSetId, minBudget);
      actionCount++;
    }

    // 3. Update AICreation record if it exists
    if (creation._id) {
      await AICreation.findByIdAndUpdate(creation._id, {
        current_budget: minBudget,
        updated_at: new Date(),
        $push: {
          lifecycle_actions: {
            action: 'kill_forced',
            value: minBudget,
            reason: `[DECISION-TREE] All ${activeAds.length} ads paused + budget → $${minBudget}. ${reason}`,
            executed_at: new Date()
          }
        }
      });
    }

    await ActionLog.create({
      entity_type: 'adset',
      entity_id: adSetId,
      entity_name: creation.meta_entity_name || creation.entity_name || adSetId,
      action: 'scale_down',
      before_value: oldBudget,
      after_value: minBudget,
      change_percent: Math.round(((minBudget - oldBudget) / oldBudget) * 100),
      reasoning: `[DECISION-TREE KILL] ${activeAds.length} ads paused + budget to $${minBudget}. ${reason}`,
      confidence: 'high',
      agent_type: 'unified_agent',
      success: true,
      executed_at: new Date(),
      metrics_at_execution: metricsAtExecution
    });

    logger.error(`[SAFETY-DECISIONS] KILL FORCED: ${creation.meta_entity_name || adSetId} — ${activeAds.length} ads paused, budget $${oldBudget} → $${minBudget} — ${reason}`);
    return { forced: true, action: 'kill_ads_and_minimize', reason, actionsExecuted: actionCount };
  } catch (err) {
    logger.error(`[SAFETY-DECISIONS] Error forcing kill on ${adSetId}: ${err.message}`);
    return null;
  }
}

/**
 * Reduce budget by a forced amount.
 * Used for underperforming ad sets that aren't dead enough to kill.
 */
async function forceScaleDown(creation, adSetId, meta, metricsAtExecution, oldBudget, newBudget, reason) {
  try {
    await meta.updateBudget(adSetId, newBudget);

    if (creation._id) {
      await AICreation.findByIdAndUpdate(creation._id, {
        current_budget: newBudget,
        updated_at: new Date(),
        $push: {
          lifecycle_actions: {
            action: 'scale_down_forced',
            value: newBudget,
            reason: `[DECISION-TREE] ${reason}`,
            executed_at: new Date()
          }
        }
      });
    }

    await ActionLog.create({
      entity_type: 'adset',
      entity_id: adSetId,
      entity_name: creation.meta_entity_name || creation.entity_name || adSetId,
      action: 'scale_down',
      before_value: oldBudget,
      after_value: newBudget,
      change_percent: Math.round(((newBudget - oldBudget) / oldBudget) * 100),
      reasoning: `[DECISION-TREE SCALE DOWN] ${reason}`,
      confidence: 'high',
      agent_type: 'unified_agent',
      success: true,
      executed_at: new Date(),
      metrics_at_execution: metricsAtExecution
    });

    logger.warn(`[SAFETY-DECISIONS] SCALE DOWN FORCED: ${creation.meta_entity_name || adSetId} $${oldBudget} → $${newBudget} — ${reason}`);
    return { forced: true, action: 'scale_down', reason, actionsExecuted: 1 };
  } catch (err) {
    logger.error(`[SAFETY-DECISIONS] Error forcing scale down on ${adSetId}: ${err.message}`);
    return null;
  }
}

module.exports = { hardcodedDecisionTree, forceKill, forceScaleDown };
