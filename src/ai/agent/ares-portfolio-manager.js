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

// Thresholds configurables — ajustados a la data real observada 2026-04-23/24.
const STARVED_WINNER_SHARE_MAX = 0.03;   // <3% del spend de su CBO
const STARVED_WINNER_ROAS_MIN = 2.0;      // ROAS mínimo para considerar "winner"
const STARVED_WINNER_PURCHASES_MIN = 1;   // al menos 1 compra histórica
const STARVED_RESCUE_BUDGET = 75;         // budget inicial del adset duplicado a CBO 3 ($/d)

const UNDERPERFORMER_SPEND_MIN = 50;      // primera semana conservador (normal $30)
const UNDERPERFORMER_AGE_DAYS_MIN = 5;    // ≥5 días de edad

// Saturation single-favorite (legacy detector)
const CBO_SATURATION_CONC_MIN = 0.70;     // top 1 adset >70% del spend 3d
const CBO_SATURATION_ROAS_MIN = 2.5;      // favorito ROAS mínimo
const CBO_SATURATION_SCALE_PCT = 0.15;    // +15% budget CBO
// Fix 2026-04-24: antes cualquier favorite_declining bloqueaba el scale_up.
// Meta tiene drift natural turno-a-turno (ej. 3.51x→3.27x = 7% drop = OK).
// Ahora solo bloquea si ROAS 3d cae debajo de CBO_SATURATION_DECLINING_FLOOR
// (caída real, no drift normal).
const CBO_SATURATION_DECLINING_FLOOR = 2.0;

// Cluster saturation (nuevo 2026-04-24) — Meta típicamente elige 2-3 ganadores
// y deja el resto muerto. Si top-2 combinado ≥85% o top-3 ≥90% sostenido,
// hay saturation por cluster. Acción: scale_up porque Meta convergió en core
// productivo y el spend adicional va al cluster automáticamente.
const CLUSTER_TOP2_SHARE_MIN = 0.85;
const CLUSTER_TOP3_SHARE_MIN = 0.90;
const CLUSTER_ROAS_MIN = 2.5;
const CLUSTER_SCALE_PCT = 0.15;

// Underperforming CBO (nuevo 2026-04-24) — CBO gasta significativo sin ROAS.
// Trigger: ROAS 3d bajo AND ROAS 7d también bajo (no flash drop) AND spend
// significativo (>50% del daily budget diario efectivo). Acción: scale_down
// para proteger capital.
const CBO_UNDERPERFORMING_ROAS_3D_MAX = 1.5;
const CBO_UNDERPERFORMING_ROAS_7D_MAX = 2.0;
const CBO_UNDERPERFORMING_SPEND_RATIO_MIN = 0.5;  // spend_3d/(budget*3) >= 50%
const CBO_UNDERPERFORMING_SCALE_DOWN_PCT = 0.15;  // bajar 15%
const CBO_UNDERPERFORMING_BUDGET_FLOOR = 50;      // no bajar debajo de $50/d

// Mass zombie kill (nuevo 2026-04-24) — adsets muertos de hambre por
// saturation bimodal. Batch pause para liberar overhead de la CBO.
// Mass zombie kill — 2026-04-24 relajado: en prod vimos que MetricSnapshot
// no popula created_time confiablemente (23/23 adsets con age_days=null en
// Duplicados Ganadores). Meta también marca LEARNING incorrectamente en
// adsets starved (19/23 en LEARNING aunque llevan meses). Dependemos solo
// de spend_cumul como señal "ya tuvo chance".
const ZOMBIE_SHARE_MAX = 0.01;            // <1% del spend 3d
const ZOMBIE_SPEND_CUMUL_MIN = 30;        // ≥$30 gastados en 7d (subido de $20 porque removimos age gate)
const ZOMBIE_MAX_PAUSES_PER_CBO = 10;     // cap pauses por CBO por ciclo

// Stale adsets — Meta nunca les dio delivery real. No los toca el
// underperformer_kill (exige $50) ni el mass_zombie_kill (exige $30 + CBO
// saturado). Quedan ACTIVE en silencio ocupando slot del cap 200.
const STALE_SPEND_MAX = 5;                // spend 7d <$5 = casi cero delivery
const STALE_AGE_DAYS_MIN = 7;             // ≥7d = ya pasó learning fresh
const STALE_MAX_PAUSES_PER_CBO = 10;      // cap por CBO por ciclo

// CBO starvation (Fase 1 original) — pulse bajo + muchos adsets
const CBO_STARVATION_PULSE_MAX = 20;      // budget/adset <$20
const CBO_STARVATION_ADSETS_MIN = 8;      // ≥8 adsets activos
const CBO_STARVATION_TARGET_PULSE = 25;   // pulse objetivo tras scale
const CBO_STARVATION_WEEK1_CAP = 100;     // primera semana: +$100 max por ciclo

// Caps operativos generales
const MAX_ACTIONS_PER_CYCLE = 15;          // subido de 8 → 15 (más detectores activos)
const DEDUP_WINDOW_HOURS = 24;             // no repetir misma action+entity <24h

// CBO 3 ID — hardcoded a la CBO de rescate. Se infiere del snapshot si no
// está configurada, o ENV override.
const RESCUE_CBO_ID = process.env.ARES_RESCUE_CBO_ID || null;
// Auto-creación del CBO rescate — si no hay ARES_RESCUE_CBO_ID ni uno
// persistido, el detector crea uno la primera vez que lo necesita. Se crea
// una sola vez en la vida del sistema; su ID queda guardado en SystemConfig.
const RESCUE_CBO_BUDGET = 100;                                  // $/d del CBO rescate
const RESCUE_CBO_CONFIG_KEY = 'ares_rescue_cbo';                // SystemConfig: ID persistido
const RESCUE_CBO_COOLDOWN_KEY = 'ares_rescue_cbo_last_attempt'; // anti-loop si la creación falla

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
    // metrics_at_execution para scales de CBO — baseline real para la capa de
    // veredicto (antes Ares no lo poblaba → el veredicto medía contra 0). 2026-05-25.
    let metricsAtExecution = null;
    if (success && ['scale_up', 'scale_down'].includes(action) && entity_type === 'campaign') {
      try {
        const cs = await CBOHealthSnapshot.findOne({ campaign_id: entity_id }).sort({ snapshot_at: -1 }).lean();
        if (cs) metricsAtExecution = { roas_7d: cs.cbo_roas_7d || 0, roas_3d: cs.cbo_roas_3d || 0, spend_7d: cs.cbo_spend_7d || 0, daily_budget: before_value || cs.daily_budget || 0 };
      } catch (_) { /* fail-open */ }
    }
    await ActionLog.create({
      entity_type, entity_id, entity_name,
      action, success: !!success,
      executed_at: new Date(),
      agent_type: 'ares_portfolio',
      reasoning,
      before_value, after_value,
      metadata: metadata || {},
      ...(metricsAtExecution ? { metrics_at_execution: metricsAtExecution } : {}),
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
  // -1. Warehouse throttle — bloquea scale_up cuando logística no da
  if (action_type === 'scale_up') {
    try {
      const { isScaleUpBlocked } = require('../../safety/warehouse-throttle');
      if (await isScaleUpBlocked()) {
        return { allowed: false, reason: 'warehouse throttle activo — scale_up bloqueado' };
      }
    } catch (_) { /* fail-open */ }
  }

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
      return { allowed: false, reason: `cooldown: ${cool.hoursLeft}h restantes (last: ${cool.lastAction})` };
    }
  } catch (err) {
    logger.warn(`[ARES-PORTFOLIO] cooldown check failed (fail-open): ${err.message}`);
  }

  // 1.5. Gate de cordura para scale_up de CBO (2026-05-25): cooldown 48h por-CBO
  // unificado cross-agent + freno por degradación marginal + fatiga del favorito.
  // Da "sentido entre cada scale". Cubre Brain y Portfolio (ambos pasan por acá).
  if (action_type === 'scale_up') {
    try {
      const { checkCBOScaleSanity } = require('./ares-scale-gate');
      const sanity = await checkCBOScaleSanity(entity_id);
      if (!sanity.allow) {
        return { allowed: false, reason: sanity.reason };
      }
    } catch (err) {
      logger.warn(`[ARES-PORTFOLIO] CBO scale sanity check failed (fail-open): ${err.message}`);
    }
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
/**
 * Chequea si un campaign_id es el CBO rescate (env o persistido). NO crea
 * uno — solo lee lo ya conocido. Usado para excluir el CBO rescate del
 * detector starved_rescue y así evitar que los clones que ya viven adentro
 * se rescaten a sí mismos en loop.
 */
async function isRescueCbo(campaignId) {
  if (RESCUE_CBO_ID && campaignId === RESCUE_CBO_ID) return true;
  try {
    const SystemConfig = require('../../db/models/SystemConfig');
    const stored = await SystemConfig.get(RESCUE_CBO_CONFIG_KEY);
    if (stored?.campaign_id && stored.campaign_id === campaignId) return true;
  } catch (_) { /* fail-open */ }
  return false;
}

async function executeStarvedRescue(cboSnapshot, adsets, getRescueCbo) {
  const executed = [];
  // No rescatar adsets que ya viven DENTRO del CBO rescate — sería un loop
  // sobre sí mismo (rescatar clones del rescate hacia el mismo rescate).
  if (await isRescueCbo(cboSnapshot.campaign_id)) return executed;
  for (const a of adsets) {
    // No re-rescatar adsets que YA son producto de un rescate previo. El clon
    // de rescate siempre lleva el prefijo "[Ares-Rescue]" (ver cloneName abajo),
    // así que su presencia en el nombre marca un adset ya rescatado. Sin esto,
    // un rescate que vuelve a dar ROAS alto + poco spend se re-rescata en loop,
    // acumulando clones de clones ("[Ares-Rescue] [Ares-Rescue] ...") — adsets
    // ya probados que ensucian el portfolio y diluyen el budget del rescate.
    // El guard isRescueCbo de arriba solo cubre el rescate ACTUAL por campaign_id;
    // esto cubre también clones de rescates viejos que viven en otros CBOs.
    if (a.name && a.name.includes('[Ares-Rescue]')) continue;
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

    // Resolver el CBO rescate de forma lazy — recién acá, con un winner
    // famélico real que ya pasó todos los gates. Memoizado: el CBO rescate
    // se crea como máximo una vez por ciclo (y una vez en la vida del sistema).
    const rescueCboId = await getRescueCbo();
    if (!rescueCboId) {
      logger.warn(`[ARES-PORTFOLIO] sin CBO rescate disponible (auto-creación falló o en cooldown) — skip ${a.name}`);
      continue;
    }

    const cloneName = `[Ares-Rescue] ${a.name}`;
    const reasoning = `Winner starved: ROAS ${a.roas_7d.toFixed(2)}x, ${a.purchases_7d} compras, solo ${(a.spend_share_7d*100).toFixed(1)}% del spend de CBO "${cboSnapshot.campaign_name}" en 7d. Duplicando a CBO rescate con budget $${STARVED_RESCUE_BUDGET}/d.`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      // 2026-04-26: cambiamos de PAUSED → ACTIVE. El sistema ya pasó por
      // safety gates, cooldowns, directives y capacity antes de llegar acá.
      // Forzar review manual era fricción excesiva con muchos rescues por
      // ciclo. Compensación: ping a Zeus al panel notificaciones para
      // traceability instantánea.
      const result = await meta.duplicateAdSet(a.id, {
        campaign_id: rescueCboId,
        deep_copy: true,
        name: cloneName,
        status: 'ACTIVE'
      });

      if (result.success && result.new_adset_id) {
        await cooldowns.setCooldown(a.id, 'adset', 'duplicate_adset', 'ares_portfolio');

        // Pausar el adset ORIGINAL — el rescate es un TRASLADO, no un
        // duplicado. Si el original queda activo en su CBO saturado sigue
        // recibiendo <3% del budget → se re-detectaría como famélico cada
        // 72h y se acumularían clones. Pausándolo, el winner vive solo en
        // el rescate, con espacio, y deja de ser re-detectado.
        let originalPaused = false;
        try {
          await meta.updateStatus(a.id, 'PAUSED');
          originalPaused = true;
        } catch (pauseErr) {
          logger.warn(`[ARES-PORTFOLIO] rescate: no se pudo pausar el original "${a.name}": ${pauseErr.message} — clon ya creado, winner queda en ambos CBOs`);
        }

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
            new_adset_status: 'ACTIVE',
            original_paused: originalPaused,
            used_fallback_relink: !!result.used_fallback_relink,
            source_cbo: cboSnapshot.campaign_name
          },
          success: true
        });
        // Ping a Zeus panel notificaciones — traceability instantánea
        try {
          const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
          const lastMsg = await ZeusChatMessage.findOne({}).sort({ created_at: -1 }).lean();
          if (lastMsg?.conversation_id) {
            await ZeusChatMessage.create({
              conversation_id: lastMsg.conversation_id,
              role: 'assistant',
              content: `🟢 **Ares Rescue**: "${a.name}" → CBO rescate (\`${result.new_adset_id}\`)\n\nROAS source ${a.roas_7d.toFixed(2)}x, ${a.purchases_7d} compras, solo ${(a.spend_share_7d*100).toFixed(1)}% spend share. Clon ACTIVE en el rescate; original ${originalPaused ? 'pausado en su CBO' : '⚠ sigue activo (no se pudo pausar)'}. Si querés frenar, pausar manual en Meta UI.`,
              proactive: true,
              context_snapshot: { source: 'ares_rescue', new_adset_id: result.new_adset_id }
            });
          }
        } catch (_) { /* non-critical */ }
        executed.push({ kind: 'starved_winner_rescue', adset: a.name, new_id: result.new_adset_id });
        logger.info(`[ARES-PORTFOLIO] ✓ rescued "${a.name}" (ROAS ${a.roas_7d.toFixed(2)}x) → CBO rescate · clon ACTIVE, original ${originalPaused ? 'PAUSED' : 'sigue activo'}`);
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
  // Fix 2026-04-24: relajamos favorite_declining — solo bloquea si ROAS 3d
  // cae debajo del floor (caída real). Drift normal turno-a-turno (ej.
  // 3.51x→3.27x = 7% drop) no bloquea scale_up.
  if (cboSnapshot.favorite_declining && cboSnapshot.favorite_roas_3d < CBO_SATURATION_DECLINING_FLOOR) return [];
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
 * Detector 5 → EJECUTOR: cluster_saturation
 * Meta eligió 2-3 ganadores (concentración distribuida). Scale_up al
 * cluster sano. 2026-04-24: complementa cbo_saturated_winner (que solo
 * mira top-1). Este detector captura saturation bimodal/trimodal.
 */
async function executeClusterSaturation(cboSnapshot, adsets) {
  // adsets ya vienen ordenados por spend_share_7d en getAdsetsWithMetrics
  // pero queremos share_3d para saturation actual. Reordenamos.
  const sorted = [...adsets].sort((a, b) => (b.spend_share_3d || 0) - (a.spend_share_3d || 0));
  if (sorted.length < 2) return [];

  const top2Share = (sorted[0]?.spend_share_3d || 0) + (sorted[1]?.spend_share_3d || 0);
  const top3Share = top2Share + (sorted[2]?.spend_share_3d || 0);

  const isCluster2 = top2Share >= CLUSTER_TOP2_SHARE_MIN;
  const isCluster3 = top3Share >= CLUSTER_TOP3_SHARE_MIN && sorted.length >= 3;
  if (!isCluster2 && !isCluster3) return [];

  // Validar que el cluster sea sano: ROAS promedio ponderado por spend >= min
  const clusterSize = isCluster2 ? 2 : 3;
  const clusterAdsets = sorted.slice(0, clusterSize);
  const clusterSpend = clusterAdsets.reduce((s, a) => s + (a.spend_7d || 0), 0);
  const clusterRevenue = clusterAdsets.reduce((s, a) => s + (a.spend_7d * a.roas_7d || 0), 0);
  const clusterRoas = clusterSpend > 0 ? clusterRevenue / clusterSpend : 0;
  if (clusterRoas < CLUSTER_ROAS_MIN) return [];

  // Skip si cbo_saturated_winner (single favorite) ya tocó esta CBO en mismo ciclo
  if (await alreadyActedOn(cboSnapshot.campaign_id, 'scale_up')) return [];

  const currentBudget = cboSnapshot.daily_budget;
  const newBudget = Math.round(currentBudget * (1 + CLUSTER_SCALE_PCT));
  const gate = await validateSafetyGates({
    entity_id: cboSnapshot.campaign_id,
    action_type: 'scale_up',
    before_value: currentBudget,
    after_value: newBudget
  });
  if (!gate.allowed) {
    logger.info(`[ARES-PORTFOLIO] SKIP cluster scale ${cboSnapshot.campaign_name}: ${gate.reason}`);
    return [];
  }

  const reasoning = `Cluster saturation: top-${clusterSize} concentra ${Math.round((isCluster2 ? top2Share : top3Share) * 100)}% spend 3d, ROAS cluster ${clusterRoas.toFixed(2)}x sano. Meta convergió en core productivo. Scale_up +15% va directo al cluster.`;

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
        detector: 'cluster_saturation',
        cluster_size: clusterSize,
        cluster_share: +(isCluster2 ? top2Share : top3Share).toFixed(3),
        cluster_roas: +clusterRoas.toFixed(2),
        top_adsets: clusterAdsets.map(a => ({ name: a.name, share: +(a.spend_share_3d || 0).toFixed(3), roas: +(a.roas_7d || 0).toFixed(2) }))
      },
      success: true
    });
    logger.info(`[ARES-PORTFOLIO] ✓ scaled CBO "${cboSnapshot.campaign_name}" $${currentBudget}→$${newBudget} (cluster-${clusterSize} ${Math.round((isCluster2 ? top2Share : top3Share)*100)}%)`);
    return [{ kind: 'cluster_saturation', cbo: cboSnapshot.campaign_name, before: currentBudget, after: newBudget, cluster_size: clusterSize }];
  } catch (err) {
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'scale_up', reasoning, success: false, error: err.message,
      metadata: { detector: 'cluster_saturation' }
    });
    logger.error(`[ARES-PORTFOLIO] cluster scale falló: ${err.message}`);
    return [];
  }
}

/**
 * Detector 6 → EJECUTOR: cbo_underperforming
 * CBO gastando significativo con ROAS malo sostenido → scale_down para
 * proteger capital. 2026-04-24 nuevo.
 */
async function executeCBOUnderperforming(cboSnapshot, adsets) {
  if (cboSnapshot.cbo_roas_3d >= CBO_UNDERPERFORMING_ROAS_3D_MAX) return [];
  if (cboSnapshot.cbo_roas_7d >= CBO_UNDERPERFORMING_ROAS_7D_MAX) return [];

  const expectedSpend3d = cboSnapshot.daily_budget * 3;
  const spendRatio = expectedSpend3d > 0 ? cboSnapshot.cbo_spend_3d / expectedSpend3d : 0;
  if (spendRatio < CBO_UNDERPERFORMING_SPEND_RATIO_MIN) return [];

  if (await alreadyActedOn(cboSnapshot.campaign_id, 'scale_down')) return [];

  const currentBudget = cboSnapshot.daily_budget;
  const rawNewBudget = Math.round(currentBudget * (1 - CBO_UNDERPERFORMING_SCALE_DOWN_PCT));
  const newBudget = Math.max(rawNewBudget, CBO_UNDERPERFORMING_BUDGET_FLOOR);

  if (newBudget >= currentBudget) return []; // floor ya alcanzado

  const gate = await validateSafetyGates({
    entity_id: cboSnapshot.campaign_id,
    action_type: 'scale_down',
    before_value: currentBudget,
    after_value: newBudget
  });
  if (!gate.allowed) {
    logger.info(`[ARES-PORTFOLIO] SKIP underperforming scale_down ${cboSnapshot.campaign_name}: ${gate.reason}`);
    return [];
  }

  const reasoning = `CBO underperforming: ROAS 3d ${cboSnapshot.cbo_roas_3d.toFixed(2)}x < ${CBO_UNDERPERFORMING_ROAS_3D_MAX} · ROAS 7d ${cboSnapshot.cbo_roas_7d.toFixed(2)}x < ${CBO_UNDERPERFORMING_ROAS_7D_MAX} · spend ratio ${(spendRatio*100).toFixed(0)}% del budget asignado. Scale_down -15% para proteger capital.`;

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateBudget(cboSnapshot.campaign_id, newBudget);

    await cooldowns.setCooldown(cboSnapshot.campaign_id, 'campaign', 'scale_down', 'ares_portfolio');
    await logAction({
      entity_type: 'campaign',
      entity_id: cboSnapshot.campaign_id,
      entity_name: cboSnapshot.campaign_name,
      action: 'scale_down',
      before_value: currentBudget,
      after_value: newBudget,
      reasoning,
      metadata: {
        detector: 'cbo_underperforming',
        roas_3d: +cboSnapshot.cbo_roas_3d.toFixed(2),
        roas_7d: +cboSnapshot.cbo_roas_7d.toFixed(2),
        spend_ratio_3d: +spendRatio.toFixed(2)
      },
      success: true
    });
    logger.info(`[ARES-PORTFOLIO] ↓ scaled CBO "${cboSnapshot.campaign_name}" $${currentBudget}→$${newBudget} (underperforming)`);
    return [{ kind: 'cbo_underperforming', cbo: cboSnapshot.campaign_name, before: currentBudget, after: newBudget }];
  } catch (err) {
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'scale_down', reasoning, success: false, error: err.message,
      metadata: { detector: 'cbo_underperforming' }
    });
    logger.error(`[ARES-PORTFOLIO] underperforming scale_down falló: ${err.message}`);
    return [];
  }
}

/**
 * Detector 7 → EJECUTOR: mass_zombie_kill
 * En CBOs saturadas (cluster or single-favorite), pausar en batch adsets
 * con <1% share + 0 conv + edad >7d + spend_cumul >$20 (ya probaron, no
 * fresh). Libera overhead y budget re-asigna automáticamente al cluster.
 */
async function executeMassZombieKill(cboSnapshot, adsets) {
  // Solo disparar si la CBO está saturada (single o cluster)
  const sorted = [...adsets].sort((a, b) => (b.spend_share_3d || 0) - (a.spend_share_3d || 0));
  const top1 = sorted[0]?.spend_share_3d || 0;
  const top2 = top1 + (sorted[1]?.spend_share_3d || 0);
  const top3 = top2 + (sorted[2]?.spend_share_3d || 0);
  const isSaturated = top1 >= CBO_SATURATION_CONC_MIN || top2 >= CLUSTER_TOP2_SHARE_MIN || top3 >= CLUSTER_TOP3_SHARE_MIN;
  if (!isSaturated) return [];

  // Identificar zombies. Nota 2026-04-24: removidos los filtros de age_days
  // y learning_stage por poco confiables en prod. Usamos solo spend_cumul
  // ≥$30 como "ya tuvo chance real". Es más estricto que antes con $20
  // para compensar la pérdida de protecciones.
  const zombies = adsets.filter(a => {
    if (a.purchases_7d > 0) return false;
    if ((a.spend_share_3d || 0) >= ZOMBIE_SHARE_MAX) return false;
    if ((a.spend_7d || 0) < ZOMBIE_SPEND_CUMUL_MIN) return false;
    return true;
  }).slice(0, ZOMBIE_MAX_PAUSES_PER_CBO);

  if (zombies.length === 0) return [];

  const executed = [];
  for (const z of zombies) {
    if (await alreadyActedOn(z.id, 'pause')) continue;

    const gate = await validateSafetyGates({ entity_id: z.id, action_type: 'pause' });
    if (!gate.allowed) {
      logger.info(`[ARES-PORTFOLIO] SKIP zombie pause ${z.name}: ${gate.reason}`);
      continue;
    }

    const reasoning = `Zombie en CBO saturada: share 3d ${((z.spend_share_3d || 0)*100).toFixed(1)}%, 0 compras 7d, spend 7d $${Math.round(z.spend_7d || 0)}. Meta ya eligió cluster ganador; este adset consume overhead sin retornar. Pause libera budget al cluster.`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      await meta.updateStatus(z.id, 'PAUSED');

      await cooldowns.setCooldown(z.id, 'adset', 'pause', 'ares_portfolio');
      await logAction({
        entity_type: 'adset', entity_id: z.id, entity_name: z.name,
        action: 'pause',
        before_value: 'ACTIVE', after_value: 'PAUSED',
        reasoning,
        metadata: {
          detector: 'mass_zombie_kill',
          parent_cbo: cboSnapshot.campaign_name,
          spend_share_3d: +(z.spend_share_3d || 0).toFixed(4),
          spend_cumul_7d: Math.round(z.spend_7d || 0)
        },
        success: true
      });
      executed.push({ kind: 'mass_zombie_kill', adset: z.name, cbo: cboSnapshot.campaign_name });
      logger.info(`[ARES-PORTFOLIO] ✓ zombie paused "${z.name}" (share ${((z.spend_share_3d || 0)*100).toFixed(1)}% · 0 conv · $${Math.round(z.spend_7d)} gastados)`);
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: z.id, entity_name: z.name,
        action: 'pause', reasoning, success: false, error: err.message,
        metadata: { detector: 'mass_zombie_kill' }
      });
      logger.error(`[ARES-PORTFOLIO] zombie pause falló para ${z.name}: ${err.message}`);
    }
  }

  return executed;
}

/**
 * Detector 8 → EJECUTOR: stale_adset_kill
 * Pausa adsets que llevan ≥7d activos pero Meta nunca les dio delivery
 * (spend 7d <$5). Quedan en silencio ocupando slot del cap 200 sin
 * retornar nada. Pausarlos no afecta delivery (no gastaban) — limpia el
 * portfolio y libera slots para nuevos rescues / tests.
 */
async function executeStaleAdsetKill(cboSnapshot, adsets) {
  const stale = adsets.filter(a => {
    if (a.learning_stage === 'LEARNING') return false;
    if (!a.age_days || a.age_days < STALE_AGE_DAYS_MIN) return false;
    if ((a.spend_7d || 0) >= STALE_SPEND_MAX) return false;
    if (a.purchases_7d > 0) return false;
    return true;
  }).slice(0, STALE_MAX_PAUSES_PER_CBO);

  if (stale.length === 0) return [];

  const executed = [];
  for (const a of stale) {
    if (await alreadyActedOn(a.id, 'pause')) continue;
    const gate = await validateSafetyGates({ entity_id: a.id, action_type: 'pause' });
    if (!gate.allowed) {
      logger.info(`[ARES-PORTFOLIO] SKIP stale ${a.name}: ${gate.reason}`);
      continue;
    }

    const reasoning = `Adset stale: $${(a.spend_7d || 0).toFixed(2)} spend 7d, 0 compras, ${a.age_days}d edad — Meta nunca le dio delivery real. Ocupa slot del cap 200 sin retornar. Pause libera el slot, no afecta delivery (no gastaba).`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      await meta.updateStatus(a.id, 'PAUSED');
      await cooldowns.setCooldown(a.id, 'adset', 'pause', 'ares_portfolio');
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'pause',
        before_value: 'ACTIVE', after_value: 'PAUSED',
        reasoning,
        metadata: {
          detector: 'stale_adset_kill',
          spend_7d: +(a.spend_7d || 0).toFixed(2),
          age_days: a.age_days,
          parent_cbo: cboSnapshot.campaign_name
        },
        success: true
      });
      executed.push({ kind: 'stale_adset_kill', adset: a.name });
      logger.info(`[ARES-PORTFOLIO] ✓ stale paused "${a.name}" ($${(a.spend_7d || 0).toFixed(2)} 7d/0 conv/${a.age_days}d)`);
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'pause', reasoning, success: false, error: err.message,
        metadata: { detector: 'stale_adset_kill' }
      });
      logger.error(`[ARES-PORTFOLIO] stale kill falló para ${a.name}: ${err.message}`);
    }
  }
  return executed;
}

/**
 * Ejecuta los 8 detectores sobre UNA CBO (4 originales + 3 Ola 1 + stale).
 * Cada uno corre autónomo con su propio gate + cooldown.
 * Retorna array de acciones ejecutadas exitosamente.
 */
async function executePortfolioActionsForCBO(cboSnapshot, getRescueCbo, remainingBudget) {
  if (cboSnapshot.is_zombie) return { executed: [], skipped: 'zombie' };

  const adsets = await getAdsetsWithMetrics(cboSnapshot.campaign_id);
  if (adsets.length === 0) return { executed: [], skipped: 'no_adsets' };

  const executed = [];
  // Orden importa: primero las acciones bounded más específicas/seguras
  // (rescue individual, kill individual), después las batch (zombie kill),
  // después scale actions CBO-level. Así si se llena el cap, al menos
  // tocamos las acciones de menor riesgo primero.
  const runners = [
    () => executeStarvedRescue(cboSnapshot, adsets, getRescueCbo),
    () => executeKill(cboSnapshot, adsets),
    () => executeMassZombieKill(cboSnapshot, adsets),         // Ola 1.3
    () => executeStaleAdsetKill(cboSnapshot, adsets),         // limpia adsets con 0 delivery
    () => executeClusterSaturation(cboSnapshot, adsets),      // Ola 1.2 — más específico que saturated_winner, va primero
    () => executeSaturatedWinner(cboSnapshot, adsets),        // single-favorite legacy fallback
    () => executeCBOStarvation(cboSnapshot),
    () => executeCBOUnderperforming(cboSnapshot, adsets)      // Ola 1.1
  ];

  try {
    for (const runner of runners) {
      if (executed.length >= remainingBudget) break;
      const result = await runner();
      executed.push(...result);
    }
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
 * Resuelve el campaign_id del CBO rescate, creándolo si hace falta:
 *   1. env ARES_RESCUE_CBO_ID (override explícito del creador)
 *   2. CBO rescate auto-creado en un ciclo previo (persistido en SystemConfig)
 *   3. crea uno nuevo dedicado (createRescueCbo)
 * Devuelve null solo si la creación falla o está en cooldown anti-loop.
 */
async function resolveOrCreateRescueCbo() {
  if (RESCUE_CBO_ID) return RESCUE_CBO_ID;
  try {
    const SystemConfig = require('../../db/models/SystemConfig');
    const stored = await SystemConfig.get(RESCUE_CBO_CONFIG_KEY);
    if (stored?.campaign_id) return stored.campaign_id;
  } catch (err) {
    logger.warn(`[ARES-PORTFOLIO] lectura de CBO rescate persistido falló: ${err.message}`);
  }
  return await createRescueCbo();
}

/**
 * Crea el CBO rescate dedicado vía Meta API. Persiste su ID para que nunca
 * se cree un segundo. Loguea en ActionLog + emite SafetyEvent para que el
 * creador se entere. Cooldown anti-loop de 24h si un intento falla.
 */
async function createRescueCbo() {
  const SystemConfig = require('../../db/models/SystemConfig');

  // Cooldown anti-loop: si hubo un intento reciente, no reintentar
  try {
    const lastAttempt = await SystemConfig.get(RESCUE_CBO_COOLDOWN_KEY);
    if (lastAttempt?.at) {
      const hoursSince = (Date.now() - new Date(lastAttempt.at).getTime()) / 3600000;
      if (hoursSince < 24) {
        logger.warn(`[ARES-PORTFOLIO] CBO rescate: intento reciente hace ${hoursSince.toFixed(1)}h — cooldown 24h, skip`);
        return null;
      }
    }
  } catch (_) { /* fail-open */ }

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    const name = `[Ares-Rescue] Winners Famélicos ${new Date().toISOString().slice(0, 10)}`;

    // Marcar el intento ANTES de crear — si createCampaign falla a mitad,
    // el cooldown evita un loop de creaciones.
    await SystemConfig.set(RESCUE_CBO_COOLDOWN_KEY, { at: new Date().toISOString() });

    const result = await meta.createCampaign({
      name,
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      daily_budget: RESCUE_CBO_BUDGET
    });
    if (!result?.campaign_id) throw new Error('createCampaign no devolvió campaign_id');

    // Persistir el ID — futuros ciclos lo reusan, nunca se crea un segundo.
    await SystemConfig.set(RESCUE_CBO_CONFIG_KEY, {
      campaign_id: result.campaign_id,
      name,
      created_at: new Date().toISOString()
    });

    await logAction({
      entity_type: 'campaign',
      entity_id: result.campaign_id,
      entity_name: name,
      action: 'create_campaign',
      after_value: RESCUE_CBO_BUDGET,
      reasoning: `CBO rescate auto-creada — destino dedicado para duplicar winners famélicos (ROAS alto pero <3% del budget de su CBO) detectados en CBOs saturados. Budget $${RESCUE_CBO_BUDGET}/d.`,
      metadata: { detector: 'starved_winner_rescue', auto_created: true },
      success: true
    });

    try {
      const SafetyEvent = require('../../db/models/SafetyEvent');
      await SafetyEvent.create({
        event_type: 'autonomous_cbo_created',
        severity: 'high',
        entity_id: result.campaign_id,
        entity_name: name,
        description: `Ares Portfolio auto-creó el CBO rescate "${name}" ($${RESCUE_CBO_BUDGET}/d) — destino para winners famélicos.`,
        details: { campaign_id: result.campaign_id, daily_budget: RESCUE_CBO_BUDGET, source: 'starved_winner_rescue' },
        created_at: new Date()
      });
    } catch (e) {
      logger.warn(`[ARES-PORTFOLIO] SafetyEvent del CBO rescate falló: ${e.message}`);
    }

    logger.info(`[ARES-PORTFOLIO] ✓✓ CBO rescate auto-creada "${name}" id=${result.campaign_id} budget=$${RESCUE_CBO_BUDGET}/d`);
    return result.campaign_id;
  } catch (err) {
    logger.error(`[ARES-PORTFOLIO] creación del CBO rescate falló: ${err.message}`);
    return null;
  }
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

  // Resolver lazy + memoizado del CBO rescate. NO se resuelve/crea upfront —
  // solo si algún detector starved_winner_rescue realmente lo necesita este
  // ciclo (evita crear un CBO rescate vacío sin un winner que rescatar).
  let _rescueResolved;
  const getRescueCbo = async () => {
    if (_rescueResolved !== undefined) return _rescueResolved;
    _rescueResolved = await resolveOrCreateRescueCbo();
    return _rescueResolved;
  };

  const allExecuted = [];
  const byDetector = {};

  for (const snap of latestSnaps) {
    const remaining = MAX_ACTIONS_PER_CYCLE - allExecuted.length;
    if (remaining <= 0) {
      logger.info(`[ARES-PORTFOLIO] cap MAX_ACTIONS_PER_CYCLE=${MAX_ACTIONS_PER_CYCLE} alcanzado, stop`);
      break;
    }
    const { executed } = await executePortfolioActionsForCBO(snap, getRescueCbo, remaining);
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
    executeCBOStarvation,
    executeClusterSaturation,     // Ola 1.2
    executeCBOUnderperforming,    // Ola 1.1
    executeMassZombieKill,        // Ola 1.3
    executeStaleAdsetKill         // adsets con 0 delivery
  },
  _helpers: {
    validateSafetyGates,
    alreadyActedOn,
    resolveOrCreateRescueCbo,
    createRescueCbo,
    logAction
  }
};
