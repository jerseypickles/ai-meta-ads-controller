/**
 * Ares Portfolio Manager — EJECUTOR AUTÓNOMO con safety bounded.
 * Fase 3 opción B/C adelantada (2026-04-23).
 *
 * Ares ya ejecuta duplicaciones autónomas. Este módulo agrega 3 acciones
 * adicionales que Ares ejecuta sobre CBOs + adsets, con las mismas
 * safety gates que Athena:
 *
 *   1. starved_winner_rescue — adset con ROAS >2 + purchases ≥1 + <3% del
 *      spend de su CBO → DUPLICA a CBO 3 con budget $75/d (exploración
 *      protegida sin competir con favoritos actuales).
 *
 *   2. underperformer_kill — adset con spend >$50 + 0 purchases + edad >5d
 *      + no LEARNING → PAUSA via Meta API. Budget vuelve al pool de la CBO.
 *
 *   3. cbo_saturated_winner — concentración >70% sostenida + favorito ROAS>2.5x
 *      + NO declining → SCALE_UP budget CBO +15% (Meta reasigna al ganador).
 *
 *   4. cbo_starvation — budget_pulse <$20 con ≥8 adsets → SCALE_UP budget
 *      CBO al target (cap primera semana: +$100 max).
 *
 * Safety gates aplicados antes de cada ejecución:
 *   - directive-guard.isAgentBlocked('ares') — respeta avoid de Zeus
 *   - cooldown-manager — per-entity tiered cooldowns
 *   - guard-rail — budget limits ±25%, daily ceiling $5000
 *   - portfolio-capacity — caps de concurrencia (max_scale, max_dup, etc)
 *   - Dedup interno 24h por (entity_id, action_type)
 *
 * Caps conservadores primera semana (2026-04-23 a 2026-04-30):
 *   - underperformer_kill spend_min: $50 (vs $30 normal)
 *   - cbo_starvation cap: +$100 max por ciclo (vs +∞ bounded)
 *   - max actions/ciclo: 8
 *
 * Todo lo ejecutado loggea en ActionLog con agent_type='ares_portfolio'
 * para distinguir de duplicaciones normales de Ares y de acciones de Athena.
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const logger = require('../../utils/logger');
const { isCBO } = require('./cbo-health-monitor');
const { CooldownManager } = require('../../safety/cooldown-manager');
const cooldowns = new CooldownManager();

// Thresholds configurables — ajustados a la data real observada 2026-04-23.
const STARVED_WINNER_SHARE_MAX = 0.03;   // <3% del spend de su CBO
const STARVED_WINNER_ROAS_MIN = 2.0;      // ROAS mínimo para considerar "winner"
const STARVED_WINNER_PURCHASES_MIN = 1;   // al menos 1 compra histórica
const STARVED_RESCUE_BUDGET = 75;         // budget inicial del adset duplicado a CBO 3 ($/d)

const UNDERPERFORMER_SPEND_MIN = 50;      // primera semana conservador (normal $30)
const UNDERPERFORMER_AGE_DAYS_MIN = 5;    // ≥5 días de edad

const CBO_SATURATION_CONC_MIN = 0.70;     // top adset >70% del spend 3d
const CBO_SATURATION_ROAS_MIN = 2.5;      // favorito ROAS mínimo
const CBO_SATURATION_SCALE_PCT = 0.15;    // +15% budget CBO

const CBO_STARVATION_PULSE_MAX = 20;      // budget/adset <$20
const CBO_STARVATION_ADSETS_MIN = 8;      // ≥8 adsets activos
const CBO_STARVATION_TARGET_PULSE = 25;   // pulse objetivo tras scale
const CBO_STARVATION_WEEK1_CAP = 100;     // primera semana: +$100 max por ciclo

// Caps operativos generales
const MAX_ACTIONS_PER_CYCLE = 8;           // total acciones ejecutadas por corrida
const DEDUP_WINDOW_HOURS = 24;             // no repetir misma action+entity <24h

// CBO 3 ID — hardcoded a la CBO de rescate. Se infiere del snapshot si no
// está configurada, o ENV override.
const RESCUE_CBO_ID = process.env.ARES_RESCUE_CBO_ID || null;

// Feature flag — permite desactivar la ejecución desde env sin tocar código
const AUTONOMOUS_ENABLED = process.env.ARES_PORTFOLIO_AUTONOMOUS !== 'false';

/**
 * Chequea si ya se ejecutó acción similar (misma entity + action_type) en
 * las últimas DEDUP_WINDOW_HOURS. Previene re-ejecución obsesiva.
 */
async function alreadyActedOn(entity_id, action_type) {
  const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3600000);
  const existing = await ActionLog.findOne({
    entity_id,
    action: action_type,
    agent_type: 'ares_portfolio',
    executed_at: { $gte: since }
  }).lean();
  return !!existing;
}

/**
 * Persiste ActionLog para trazabilidad de cada acción ejecutada.
 */
async function logAction({ entity_id, entity_name, entity_type, action, before_value, after_value, reasoning, metadata, success, error }) {
  try {
    await ActionLog.create({
      entity_type, entity_id, entity_name,
      action, success: !!success,
      executed_at: new Date(),
      agent_type: 'ares_portfolio',
      reasoning,
      before_value, after_value,
      metadata: metadata || {},
      error: error || null
    });
  } catch (err) {
    logger.error(`[ARES-PORTFOLIO] logAction failed: ${err.message}`);
  }
}

/**
 * Gate pre-acción: valida cooldown + guard-rail + portfolio capacity +
 * directiva Zeus granular por action_type.
 * Retorna { allowed: true } o { allowed: false, reason: '...' }.
 */
async function validateSafetyGates({ entity_id, action_type, before_value, after_value }) {
  // 0. Directiva Zeus granular por action_type — nuevo 2026-04-23
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const directiveBlock = await isActionBlockedForAgent('ares', action_type);
    if (directiveBlock.blocked) {
      return {
        allowed: false,
        reason: `directiva Zeus bloquea '${action_type}': ${directiveBlock.reason}`
      };
    }
  } catch (err) {
    logger.warn(`[ARES-PORTFOLIO] directive check failed (fail-open): ${err.message}`);
  }

  // 1. Cooldown per-entity
  try {
    const cool = await cooldowns.isOnCooldown(entity_id);
    if (cool.onCooldown) {
      return { allowed: false, reason: `cooldown: ${cool.hoursRemaining}h restantes (last: ${cool.lastAction})` };
    }
  } catch (err) {
    logger.warn(`[ARES-PORTFOLIO] cooldown check failed (fail-open): ${err.message}`);
  }

  // 2. Guard-rail para acciones de budget — cap 50% por ciclo
  // (más permisivo que 25% default del sistema global porque estas acciones
  // ya pasan por cooldown 36h + detector con thresholds específicos +
  // cap primera semana +$100. El 25% bloqueaba starvation scales legítimos
  // de Medicion $200→$300 que son exactamente el objetivo del detector.)
  if (action_type === 'scale_up' || action_type === 'scale_down') {
    if (before_value && after_value) {
      const pct = Math.abs((after_value - before_value) / before_value);
      if (pct > 0.50) {
        return { allowed: false, reason: `guard-rail: cambio ${(pct*100).toFixed(0)}% > 50% max` };
      }
    }
  }

  // 3. Portfolio capacity
  try {
    const { canExecuteAction } = require('../zeus/portfolio-capacity');
    const cap = await canExecuteAction(action_type);
    if (!cap.allowed) {
      return { allowed: false, reason: `capacity: ${cap.reason}` };
    }
  } catch (err) {
    logger.warn(`[ARES-PORTFOLIO] capacity check failed (fail-open): ${err.message}`);
  }

  return { allowed: true };
}

/**
 * Agrega adsets activos de una CBO con métricas normalizadas para análisis.
 */
async function getAdsetsWithMetrics(campaign_id) {
  const adsets = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', campaign_id } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);

  const totalSpend7d = adsets.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const totalSpend3d = adsets.reduce((s, a) => s + (a.metrics?.last_3d?.spend || 0), 0);

  return adsets.map(a => {
    const m7 = a.metrics?.last_7d || {};
    const m3 = a.metrics?.last_3d || {};
    const spend7d = m7.spend || 0;
    const spend3d = m3.spend || 0;
    const purchaseValue = m7.purchase_value || 0;
    const ageDays = a.created_time ? Math.floor((Date.now() - new Date(a.created_time).getTime()) / 86400000) : null;
    return {
      id: a.entity_id,
      name: a.entity_name,
      daily_budget: a.daily_budget || 0,
      age_days: ageDays,
      learning_stage: a.learning_stage || 'unknown',
      spend_7d: spend7d,
      spend_3d: spend3d,
      spend_share_7d: totalSpend7d > 0 ? spend7d / totalSpend7d : 0,
      spend_share_3d: totalSpend3d > 0 ? spend3d / totalSpend3d : 0,
      roas_7d: spend7d > 0 ? purchaseValue / spend7d : 0,
      purchases_7d: m7.purchases || 0,
      frequency_7d: m7.frequency || 0,
      ctr_7d: m7.ctr || 0,
      cpa_7d: m7.purchases > 0 ? spend7d / m7.purchases : null
    };
  });
}

/**
 * Detector 1 → EJECUTOR: starved_winner_rescue
 * Duplica adsets starved con ROAS alto a CBO 3 (Rescate).
 */
async function executeStarvedRescue(cboSnapshot, adsets, rescueCboId) {
  const executed = [];
  for (const a of adsets) {
    if (a.spend_share_7d >= STARVED_WINNER_SHARE_MAX) continue;
    if (a.roas_7d < STARVED_WINNER_ROAS_MIN) continue;
    if (a.purchases_7d < STARVED_WINNER_PURCHASES_MIN) continue;
    if (a.age_days && a.age_days < 3) continue;
    if (await alreadyActedOn(a.id, 'duplicate_adset')) continue;

    const gate = await validateSafetyGates({ entity_id: a.id, action_type: 'duplicate_adset' });
    if (!gate.allowed) {
      logger.info(`[ARES-PORTFOLIO] SKIP rescue ${a.name}: ${gate.reason}`);
      continue;
    }

    if (!rescueCboId) {
      logger.warn(`[ARES-PORTFOLIO] rescue CBO no configurada — skip ${a.name}`);
      continue;
    }

    const cloneName = `[Ares-Rescue] ${a.name}`;
    const reasoning = `Winner starved: ROAS ${a.roas_7d.toFixed(2)}x, ${a.purchases_7d} compras, solo ${(a.spend_share_7d*100).toFixed(1)}% del spend de CBO "${cboSnapshot.campaign_name}" en 7d. Duplicando a CBO rescate con budget $${STARVED_RESCUE_BUDGET}/d.`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      const result = await meta.duplicateAdSet(a.id, {
        campaign_id: rescueCboId,
        deep_copy: true,
        name: cloneName,
        status: 'PAUSED'  // creator activa manualmente tras review; safety
      });

      if (result.success && result.new_adset_id) {
        await cooldowns.setCooldown(a.id, 'adset', 'duplicate_adset', 'ares_portfolio');
        await logAction({
          entity_type: 'adset',
          entity_id: a.id,
          entity_name: a.name,
          action: 'duplicate_adset',
          before_value: a.daily_budget,
          after_value: STARVED_RESCUE_BUDGET,
          reasoning,
          metadata: {
            detector: 'starved_winner_rescue',
            roas_7d: +a.roas_7d.toFixed(2),
            spend_share_7d: +(a.spend_share_7d * 100).toFixed(1),
            new_adset_id: result.new_adset_id,
            rescue_cbo_id: rescueCboId,
            new_adset_status: 'PAUSED',  // safety: creador activa
            source_cbo: cboSnapshot.campaign_name
          },
          success: true
        });
        executed.push({ kind: 'starved_winner_rescue', adset: a.name, new_id: result.new_adset_id });
        logger.info(`[ARES-PORTFOLIO] ✓ rescued "${a.name}" (ROAS ${a.roas_7d.toFixed(2)}x) → CBO rescate (PAUSED)`);
      }
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'duplicate_adset', reasoning, success: false, error: err.message,
        metadata: { detector: 'starved_winner_rescue' }
      });
      logger.error(`[ARES-PORTFOLIO] rescue falló para ${a.name}: ${err.message}`);
    }
  }
  return executed;
}

/**
 * Detector 2 → EJECUTOR: underperformer_kill
 * Pausa adsets con spend significativo sin conversiones.
 */
async function executeKill(cboSnapshot, adsets) {
  const executed = [];
  for (const a of adsets) {
    if (a.spend_7d < UNDERPERFORMER_SPEND_MIN) continue;
    if (a.purchases_7d > 0) continue;
    if (!a.age_days || a.age_days < UNDERPERFORMER_AGE_DAYS_MIN) continue;
    if (a.learning_stage === 'LEARNING') continue;
    if (await alreadyActedOn(a.id, 'pause')) continue;

    const gate = await validateSafetyGates({ entity_id: a.id, action_type: 'pause' });
    if (!gate.allowed) {
      logger.info(`[ARES-PORTFOLIO] SKIP kill ${a.name}: ${gate.reason}`);
      continue;
    }

    const reasoning = `Underperformer: $${Math.round(a.spend_7d)} spend 7d, 0 compras, ${a.age_days}d edad, ya salió de learning. Dentro de CBO "${cboSnapshot.campaign_name}". Budget vuelve al pool.`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      await meta.updateStatus(a.id, 'PAUSED');

      await cooldowns.setCooldown(a.id, 'adset', 'pause', 'ares_portfolio');
      await logAction({
        entity_type: 'adset',
        entity_id: a.id,
        entity_name: a.name,
        action: 'pause',
        before_value: 'ACTIVE',
        after_value: 'PAUSED',
        reasoning,
        metadata: {
          detector: 'underperformer_kill',
          spend_7d: Math.round(a.spend_7d),
          purchases_7d: 0,
          age_days: a.age_days,
          ctr_7d: +a.ctr_7d.toFixed(2),
          parent_cbo: cboSnapshot.campaign_name
        },
        success: true
      });
      executed.push({ kind: 'underperformer_kill', adset: a.name, spend: a.spend_7d });
      logger.info(`[ARES-PORTFOLIO] ✓ paused "${a.name}" ($${Math.round(a.spend_7d)}/0 conv/${a.age_days}d)`);
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'pause', reasoning, success: false, error: err.message,
        metadata: { detector: 'underperformer_kill' }
      });
      logger.error(`[ARES-PORTFOLIO] kill falló para ${a.name}: ${err.message}`);
    }
  }
  return executed;
}

/**
 * Detector 3 → EJECUTOR: cbo_saturated_winner
 * Sube budget CBO +15% cuando Meta ya eligió winner sano.
 */
async function executeSaturatedWinner(cboSnapshot, adsets) {
  if (cboSnapshot.concentration_index_3d < CBO_SATURATION_CONC_MIN) return [];
  if (cboSnapshot.favorite_roas_7d < CBO_SATURATION_ROAS_MIN) return [];
  if (cboSnapshot.favorite_declining) return [];
  if (await alreadyActedOn(cboSnapshot.campaign_id, 'scale_up')) return [];

  const currentBudget = cboSnapshot.daily_budget;
  const newBudget = Math.round(currentBudget * (1 + CBO_SATURATION_SCALE_PCT));

  const gate = await validateSafetyGates({
    entity_id: cboSnapshot.campaign_id,
    action_type: 'scale_up',
    before_value: currentBudget,
    after_value: newBudget
  });
  if (!gate.allowed) {
    logger.info(`[ARES-PORTFOLIO] SKIP scale saturated ${cboSnapshot.campaign_name}: ${gate.reason}`);
    return [];
  }

  const reasoning = `CBO saturada con winner sano: conc ${Math.round(cboSnapshot.concentration_index_3d*100)}% en "${cboSnapshot.favorite_adset_name}" ROAS ${cboSnapshot.favorite_roas_7d.toFixed(2)}x tenure ${cboSnapshot.favorite_tenure_days}d (no declining). Subir budget +15% para que Meta explote más al winner.`;

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateBudget(cboSnapshot.campaign_id, newBudget);

    await cooldowns.setCooldown(cboSnapshot.campaign_id, 'campaign', 'scale_up', 'ares_portfolio');
    await logAction({
      entity_type: 'campaign',
      entity_id: cboSnapshot.campaign_id,
      entity_name: cboSnapshot.campaign_name,
      action: 'scale_up',
      before_value: currentBudget,
      after_value: newBudget,
      reasoning,
      metadata: {
        detector: 'cbo_saturated_winner',
        concentration_3d: +(cboSnapshot.concentration_index_3d).toFixed(3),
        favorite_roas_7d: +cboSnapshot.favorite_roas_7d.toFixed(2),
        favorite_tenure_days: cboSnapshot.favorite_tenure_days,
        pct_increase: CBO_SATURATION_SCALE_PCT
      },
      success: true
    });
    logger.info(`[ARES-PORTFOLIO] ✓ scaled CBO "${cboSnapshot.campaign_name}" $${currentBudget}→$${newBudget} (+15% saturated winner)`);
    return [{ kind: 'cbo_saturated_winner', cbo: cboSnapshot.campaign_name, before: currentBudget, after: newBudget }];
  } catch (err) {
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'scale_up', reasoning, success: false, error: err.message,
      metadata: { detector: 'cbo_saturated_winner' }
    });
    logger.error(`[ARES-PORTFOLIO] scale saturated falló: ${err.message}`);
    return [];
  }
}

/**
 * Detector 4 → EJECUTOR: cbo_starvation
 * Sube budget CBO al target cuando budget_pulse < $20.
 * Cap primera semana: +$100 max por ciclo.
 */
async function executeCBOStarvation(cboSnapshot) {
  if (cboSnapshot.budget_pulse >= CBO_STARVATION_PULSE_MAX) return [];
  if (cboSnapshot.active_adsets_count < CBO_STARVATION_ADSETS_MIN) return [];
  if (await alreadyActedOn(cboSnapshot.campaign_id, 'scale_up')) return [];

  const currentBudget = cboSnapshot.daily_budget;
  const targetBudget = Math.round(cboSnapshot.active_adsets_count * CBO_STARVATION_TARGET_PULSE);
  // Cap primera semana: +$100 max por ciclo
  const cappedBudget = Math.min(targetBudget, currentBudget + CBO_STARVATION_WEEK1_CAP);
  if (cappedBudget <= currentBudget) return [];

  const gate = await validateSafetyGates({
    entity_id: cboSnapshot.campaign_id,
    action_type: 'scale_up',
    before_value: currentBudget,
    after_value: cappedBudget
  });
  if (!gate.allowed) {
    logger.info(`[ARES-PORTFOLIO] SKIP starvation scale ${cboSnapshot.campaign_name}: ${gate.reason}`);
    return [];
  }

  const reasoning = `Starvation estructural: ${cboSnapshot.active_adsets_count} adsets con pulse $${cboSnapshot.budget_pulse.toFixed(0)}/adset < $${CBO_STARVATION_PULSE_MAX}. Subiendo budget $${currentBudget}→$${cappedBudget} (cap primera semana +$${CBO_STARVATION_WEEK1_CAP}) para que Meta pueda explorar.`;

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateBudget(cboSnapshot.campaign_id, cappedBudget);

    await cooldowns.setCooldown(cboSnapshot.campaign_id, 'campaign', 'scale_up', 'ares_portfolio');
    await logAction({
      entity_type: 'campaign',
      entity_id: cboSnapshot.campaign_id,
      entity_name: cboSnapshot.campaign_name,
      action: 'scale_up',
      before_value: currentBudget,
      after_value: cappedBudget,
      reasoning,
      metadata: {
        detector: 'cbo_starvation',
        active_adsets: cboSnapshot.active_adsets_count,
        budget_pulse_before: +cboSnapshot.budget_pulse.toFixed(1),
        budget_pulse_after: +(cappedBudget / cboSnapshot.active_adsets_count).toFixed(1),
        target_was: targetBudget,
        week1_cap_applied: cappedBudget < targetBudget
      },
      success: true
    });
    logger.info(`[ARES-PORTFOLIO] ✓ scaled CBO "${cboSnapshot.campaign_name}" $${currentBudget}→$${cappedBudget} (starvation, pulse ${cboSnapshot.budget_pulse.toFixed(0)}→${(cappedBudget/cboSnapshot.active_adsets_count).toFixed(0)})`);
    return [{ kind: 'cbo_starvation', cbo: cboSnapshot.campaign_name, before: currentBudget, after: cappedBudget }];
  } catch (err) {
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'scale_up', reasoning, success: false, error: err.message,
      metadata: { detector: 'cbo_starvation' }
    });
    logger.error(`[ARES-PORTFOLIO] starvation scale falló: ${err.message}`);
    return [];
  }
}

/**
 * Ejecuta los 4 detectores sobre UNA CBO. Cada uno corre autónomo.
 * Retorna array de acciones ejecutadas exitosamente.
 */
async function executePortfolioActionsForCBO(cboSnapshot, rescueCboId, remainingBudget) {
  if (cboSnapshot.is_zombie) return { executed: [], skipped: 'zombie' };

  const adsets = await getAdsetsWithMetrics(cboSnapshot.campaign_id);
  if (adsets.length === 0) return { executed: [], skipped: 'no_adsets' };

  const executed = [];
  try {
    const r1 = await executeStarvedRescue(cboSnapshot, adsets, rescueCboId);
    executed.push(...r1);
    if (executed.length >= remainingBudget) return { executed };

    const r2 = await executeKill(cboSnapshot, adsets);
    executed.push(...r2);
    if (executed.length >= remainingBudget) return { executed };

    const r3 = await executeSaturatedWinner(cboSnapshot, adsets);
    executed.push(...r3);
    if (executed.length >= remainingBudget) return { executed };

    const r4 = await executeCBOStarvation(cboSnapshot);
    executed.push(...r4);
  } catch (err) {
    logger.error(`[ARES-PORTFOLIO] ejecutor falló para ${cboSnapshot.campaign_id}: ${err.message}`);
  }

  return { executed, adsets_analyzed: adsets.length };
}

/**
 * Gate compuesto — retorna true si NO se debería duplicar a esta CBO.
 * Usado por ares-agent.js antes de ejecutar duplicaciones.
 */
function shouldBlockDuplicationToCBO(cboSnapshot) {
  // Saturación clara: concentración alta + favorito sano sostenido
  if (cboSnapshot.concentration_index_3d >= CBO_SATURATION_CONC_MIN &&
      cboSnapshot.favorite_roas_7d >= CBO_SATURATION_ROAS_MIN &&
      !cboSnapshot.favorite_declining) {
    return {
      block: true,
      reason: 'cbo_saturated_winner',
      detail: `CBO tiene ${Math.round(cboSnapshot.concentration_index_3d * 100)}% de concentración con favorito sano (ROAS ${cboSnapshot.favorite_roas_7d.toFixed(2)}x). Meta no distribuiría a nuevos clones.`
    };
  }
  return { block: false };
}

/**
 * Determina el campaign_id de la CBO de rescate — la que tenga budget_pulse
 * más alto dentro de los CBOHealthSnapshots (señal de CBO saludable con
 * capacidad). Fallback a env ARES_RESCUE_CBO_ID.
 */
async function inferRescueCbo(latestSnaps) {
  if (RESCUE_CBO_ID) return RESCUE_CBO_ID;
  // Elegir la CBO con budget_pulse más saludable que NO esté saturada.
  const candidates = latestSnaps
    .filter(s => !s.is_zombie && s.budget_pulse > 20 && s.active_adsets_count < 20)
    .sort((a, b) => b.cbo_roas_7d - a.cbo_roas_7d);
  return candidates[0]?.campaign_id || null;
}

/**
 * Entry point principal: ejecuta acciones autónomas sobre TODAS las CBOs.
 * Llamado desde ares-agent al inicio del ciclo. Respeta:
 *  - directive-guard (si avoid activo sobre 'ares', skip todo)
 *  - feature flag ARES_PORTFOLIO_AUTONOMOUS
 *  - cap MAX_ACTIONS_PER_CYCLE
 */
async function runPortfolioAnalysis() {
  const start = Date.now();

  if (!AUTONOMOUS_ENABLED) {
    logger.info('[ARES-PORTFOLIO] AUTONOMOUS desactivado via env flag, skip');
    return { analyzed: 0, executed: 0, skipped: 'flag_off' };
  }

  // Fix 2026-04-23: antes hacíamos isAgentBlocked global → una directiva
  // "no new duplications" bloqueaba TODO el subsystem (kills + scales).
  // Ahora cada executor chequea granularmente con isActionBlockedForAgent
  // por su tipo de acción. La directiva se respeta pero solo para actions
  // que realmente caen en su scope.

  const since = new Date(Date.now() - 3 * 3600000);
  const latestSnaps = await CBOHealthSnapshot.aggregate([
    { $match: { snapshot_at: { $gte: since } } },
    { $sort: { campaign_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  if (latestSnaps.length === 0) {
    logger.info('[ARES-PORTFOLIO] no snapshots recientes (<3h), skip');
    return { analyzed: 0, executed: 0 };
  }

  const rescueCboId = await inferRescueCbo(latestSnaps);
  logger.info(`[ARES-PORTFOLIO] rescue CBO: ${rescueCboId || 'none'}`);

  const allExecuted = [];
  const byDetector = {};

  for (const snap of latestSnaps) {
    const remaining = MAX_ACTIONS_PER_CYCLE - allExecuted.length;
    if (remaining <= 0) {
      logger.info(`[ARES-PORTFOLIO] cap MAX_ACTIONS_PER_CYCLE=${MAX_ACTIONS_PER_CYCLE} alcanzado, stop`);
      break;
    }
    const { executed } = await executePortfolioActionsForCBO(snap, rescueCboId, remaining);
    allExecuted.push(...executed);
    for (const e of executed) {
      byDetector[e.kind] = (byDetector[e.kind] || 0) + 1;
    }
  }

  const elapsed = Date.now() - start;
  logger.info(`[ARES-PORTFOLIO] ${latestSnaps.length} CBOs analizadas, ${allExecuted.length} acciones EJECUTADAS en ${elapsed}ms · ${JSON.stringify(byDetector)}`);

  return {
    analyzed: latestSnaps.length,
    executed: allExecuted.length,
    actions: allExecuted,
    by_detector: byDetector,
    elapsed_ms: elapsed,
    autonomous: true
  };
}

module.exports = {
  runPortfolioAnalysis,
  executePortfolioActionsForCBO,
  shouldBlockDuplicationToCBO,
  // exports para tests
  _executors: {
    executeStarvedRescue,
    executeKill,
    executeSaturatedWinner,
    executeCBOStarvation
  },
  _helpers: {
    validateSafetyGates,
    alreadyActedOn,
    inferRescueCbo
  }
};
