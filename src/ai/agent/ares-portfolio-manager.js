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
// STARVATION RELATIVA + ABSOLUTA (2026-06-10, pedido del creador): el 3% fijo era
// ciego al tamaño del CBO. En un CBO de $1000/d, 3% = $30/d (NO es hambre); en uno
// de $75/d con 3 adsets el share justo es 33% y el 3% es trivial. Famélico ahora =
// recibe menos de la MITAD de su parte justa (1/N adsets) Y menos de $8/día absolutos.
const STARVED_FAIR_SHARE_RATIO = 0.5;     // share < 50% de su fair share (1/N adsets del CBO)
const STARVED_SHARE_HARD_CEIL = 0.20;     // techo duro: nunca considerar famélico arriba de 20% share
const STARVED_DAILY_SPEND_MAX = 8;        // $/día promedio 7d — con más que esto no es hambre, aunque el share sea bajo
const STARVED_WINNER_ROAS_MIN = 2.0;      // ROAS mínimo para considerar "winner"
// 2026-06-10 (caso "43x" = 1 compra sobre centavos en un clon de 1 día):
const STARVED_WINNER_PURCHASES_MIN = 2;   // 1→2 — una compra es moneda al aire, no winner (misma lección que Prometheus)
const STARVED_WINNER_MIN_SPEND_7D = 10;   // piso de spend 7d: ROAS calculado sobre centavos no es señal
const STARVED_WINNER_MIN_AGE_DAYS = 3;    // edad mínima REAL (first-seen) — fail-closed si edad desconocida
const RESCUE_SRC_CBO_MIN_AGE_DAYS = 5;    // no medir "starvation" en CBOs que aún rampean su reparto de budget
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

// BUDGET HOG que NO rinde (2026-06-19, pedido del creador): el hueco que ningún gate
// cubría — un adset que se COME la mayoría del budget del CBO (alto share) pero gasta sin
// generar (ROAS pobre), mientras hermanos mejores se mueren de hambre. underperformer_kill
// lo salta (es LEARNING + tiene alguna compra); zombie_kill lo salta (exige <1% share, este
// tiene ~100%). Caso real: Rescate con "That First Crack" 1.25x comiéndose 97.5% del budget.
// Ares ahora lo pausa → Meta redistribuye a los demás. "Si gasta tanto y no genera, ¿qué esperamos?"
const HOG_SHARE_MIN = parseFloat(process.env.ARES_HOG_SHARE_MIN || '0.5');        // se come ≥50% del budget
const HOG_SPEND_MIN_3D = parseFloat(process.env.ARES_HOG_SPEND_MIN_3D || '50');   // gastó suficiente para juzgar (no prematuro)
const HOG_META_ROAS_FLOOR = parseFloat(process.env.ARES_HOG_META_FLOOR || '1.5'); // Meta crudo debajo = obvio malo (robusto al haircut)
const HOG_CASH_ROAS_FLOOR = parseFloat(process.env.ARES_HOG_CASH_FLOOR || '2.0'); // cash-ajustado debajo = no rinde lo que gasta

// FASE 1 del rebuild de Ares (2026-06-19): DIENTES DECISIVOS. Un CBO loser persistente
// (caso real: Rescate a 1.48x por 18 DÍAS) no se baja 15% por vez — se MATA entero y el
// budget se consolida en los winners. El piso es cash-aware (Demeter) y exige badness
// SOSTENIDA (7d Y 3d), con gasto significativo (no matar un CBO chico/nuevo). El cerebro
// de portfolio (Fase 2) va a hacer esto con razonamiento; esto es la teeth procedural ya.
const KILL_CASH_FLOOR = parseFloat(process.env.ARES_KILL_CASH_FLOOR || '1.8');    // cash-ROAS debajo = loser
const KILL_MIN_SPEND_7D = parseFloat(process.env.ARES_KILL_MIN_SPEND_7D || '150'); // gastó ≥esto en 7d → es loser real, no chico/nuevo
const KILL_RECOVERY_MULT = parseFloat(process.env.ARES_KILL_RECOVERY_MULT || '1.2'); // si 3d ya >floor×esto, se está recuperando → no matar
// CONSOLIDACIÓN de capital: el budget liberado por kills va al MEJOR winner (no se reparte
// parejo ni se pierde). Solo a un winner real (cash ≥ esto), con bump capeado para no shockear
// el learning de Meta.
const CONSOLIDATE_MIN_CASH_ROAS = parseFloat(process.env.ARES_CONSOLIDATE_MIN_CASH || '2.5');
const CONSOLIDATE_MAX_PCT = parseFloat(process.env.ARES_CONSOLIDATE_MAX_PCT || '0.5'); // máx +50% al winner por ciclo

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
async function validateSafetyGates({ entity_id, action_type, before_value, after_value, agent = 'ares_portfolio' }) {
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
      const { checkCBOScaleSanity, logScaleHold } = require('./ares-scale-gate');
      const sanity = await checkCBOScaleSanity(entity_id);
      if (!sanity.allow) {
        // Holds marginal/fatiga → loguear en ActionLog (señal alta) para que se
        // vean en las acciones de Ares. Cooldown NO (pacing rutinario = ruido).
        let logged = false;
        if (sanity.holdType === 'marginal' || sanity.holdType === 'fatigue') {
          await logScaleHold({ campaignId: entity_id, reason: sanity.reason, holdType: sanity.holdType, agent });
          logged = true;
        }
        return { allowed: false, reason: sanity.reason, logged };
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

  // EDAD REAL vía first-seen del collector (2026-06-10): Meta no popula created_time
  // (23/23 null) → los gates de edad eran código muerto. Caso real: el rescate se llevó
  // un clon de 1 día desde un CBO creado el día anterior porque el gate nunca disparó.
  // El primer snapshot del adset es un proxy confiable (el collector corre cada 10 min).
  const ids = adsets.map(a => a.entity_id);
  let firstSeenAt = {};
  if (ids.length) {
    try {
      const firstSeen = await MetricSnapshot.aggregate([
        { $match: { entity_type: 'adset', entity_id: { $in: ids } } },
        { $group: { _id: '$entity_id', first_at: { $min: '$snapshot_at' } } }
      ]);
      for (const f of firstSeen) firstSeenAt[f._id] = f.first_at;
    } catch (e) { logger.warn(`[ARES-PORTFOLIO] first-seen lookup falló: ${e.message}`); }
  }

  const totalSpend7d = adsets.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const totalSpend3d = adsets.reduce((s, a) => s + (a.metrics?.last_3d?.spend || 0), 0);

  return adsets.map(a => {
    const m7 = a.metrics?.last_7d || {};
    const m3 = a.metrics?.last_3d || {};
    const spend7d = m7.spend || 0;
    const spend3d = m3.spend || 0;
    const purchaseValue = m7.purchase_value || 0;
    const firstAt = a.created_time || firstSeenAt[a.entity_id];
    const ageDays = firstAt ? Math.floor((Date.now() - new Date(firstAt).getTime()) / 86400000) : null;
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

  // CBO RECIÉN NACIDA (2026-06-10): en una campaña de <5 días el reparto de budget
  // de Meta aún está rampeando — un spend_share bajo ahí es APRENDIZAJE, no hambre.
  // Caso real: se "rescató" un clon de 1 día desde un CBO que Ares mismo había creado
  // el día anterior → churn de campañas. Edad vía first-seen del collector.
  try {
    const firstCboSnap = await MetricSnapshot.findOne({ entity_type: 'campaign', entity_id: cboSnapshot.campaign_id })
      .sort({ snapshot_at: 1 }).select('snapshot_at').lean();
    const cboAgeDays = firstCboSnap ? (Date.now() - new Date(firstCboSnap.snapshot_at).getTime()) / 86400000 : 0;
    if (cboAgeDays < RESCUE_SRC_CBO_MIN_AGE_DAYS) {
      logger.info(`[ARES-PORTFOLIO] SKIP starved_rescue en "${cboSnapshot.campaign_name}": CBO de ${cboAgeDays.toFixed(1)}d (<${RESCUE_SRC_CBO_MIN_AGE_DAYS}d) — el reparto aún rampea, share bajo no es hambre`);
      return executed;
    }
  } catch (e) {
    logger.warn(`[ARES-PORTFOLIO] edad de CBO no determinable (${e.message}) — skip rescue por seguridad`);
    return executed;
  }
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
    // FAMÉLICO = share relativo bajo Y dólares absolutos bajos (escala con el CBO):
    // en un CBO de 15 adsets el umbral de share es ~3.3%; en uno de 3 es ~16.7% —
    // pero SIEMPRE con <$8/día reales. Un adset con $30/d en un CBO de $1000/d no
    // está famélico aunque su share sea 3% (caso planteado por el creador).
    const fairShare = 1 / Math.max(1, adsets.length);
    const shareCeil = Math.min(STARVED_SHARE_HARD_CEIL, fairShare * STARVED_FAIR_SHARE_RATIO);
    const dailySpend7d = a.spend_7d / 7;
    if (a.spend_share_7d >= shareCeil) continue;
    if (dailySpend7d >= STARVED_DAILY_SPEND_MAX) continue;
    if (a.roas_7d < STARVED_WINNER_ROAS_MIN) continue;
    if (a.purchases_7d < STARVED_WINNER_PURCHASES_MIN) continue;
    if (a.spend_7d < STARVED_WINNER_MIN_SPEND_7D) continue; // ROAS sobre centavos ≠ winner
    // FAIL-CLOSED en edad (2026-06-10): antes era `a.age_days &&` — con edad null/0 el
    // gate se saltaba (bug). Edad desconocida = no rescatar.
    if (a.age_days == null || a.age_days < STARVED_WINNER_MIN_AGE_DAYS) continue;
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
    const reasoning = `Winner starved: ROAS ${a.roas_7d.toFixed(2)}x con ${a.purchases_7d} compras sobre $${a.spend_7d.toFixed(0)} en 7d, recibiendo solo $${dailySpend7d.toFixed(1)}/día (${(a.spend_share_7d*100).toFixed(1)}% share vs ${(fairShare*100).toFixed(0)}% justo entre ${adsets.length} adsets) en CBO "${cboSnapshot.campaign_name}". Duplicando a CBO rescate con budget $${STARVED_RESCUE_BUDGET}/d.`;

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

// ═══ CBO FILL (2026-06-11, pedido del creador) ═══════════════════════════════
// Los CBOs de Ares nacían con 1-3 adsets — muy pocos para que Meta optimice el
// reparto (un CBO sano necesita 4+ opciones). Este detector COMPLETA los CBOs
// existentes de Ares con winners probados de la cuenta, en vez de crear más
// campañas: "mejorar los CBOs que ya creó".
const CBO_FILL_TARGET_ADSETS = parseInt(process.env.ARES_CBO_FILL_TARGET || '4', 10);
const CBO_FILL_MAX_PER_CYCLE = 2;       // gradual: máx 2 clones por CBO por ciclo
const CBO_FILL_MIN_CBO_AGE_DAYS = 1;    // dejar respirar al CBO recién creado
const CBO_FILL_SRC_ROAS_MIN = 2.0;      // el candidato es winner probado…
const CBO_FILL_SRC_PURCHASES_MIN = 2;   // …con ≥2 compras (1 = moneda al aire)
const CBO_FILL_SRC_SPEND_MIN_7D = 30;   // …sobre spend real
const CBO_FILL_SRC_AGE_MIN_DAYS = 5;    // …y fuera del learning fresco

/** Winners de la cuenta candidatos a poblar un CBO de Ares (excluye Ares/clones/test/excluidos). */
async function getFillCandidates(targetCampaignId, targetAdsetNames) {
  const { isExcludedEntity } = require('../../config/excluded-entities');
  const all = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset' } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $match: { status: 'ACTIVE' } }
  ]);
  // Edad real vía first-seen (created_time de Meta viene null — ver gates 2026-06-10)
  const ids = all.map(a => a.entity_id);
  let firstSeenAt = {};
  if (ids.length) {
    try {
      const fs = await MetricSnapshot.aggregate([
        { $match: { entity_type: 'adset', entity_id: { $in: ids } } },
        { $group: { _id: '$entity_id', first_at: { $min: '$snapshot_at' } } }
      ]);
      for (const f of fs) firstSeenAt[f._id] = f.first_at;
    } catch (_) { /* fail-closed via age==null */ }
  }
  const targetNorm = (targetAdsetNames || []).map(n => String(n || '').replace(/^\[Ares[^\]]*\]\s*/i, '').slice(0, 25).toLowerCase());
  return all
    .map(a => {
      const m7 = a.metrics?.last_7d || {};
      const firstAt = a.created_time || firstSeenAt[a.entity_id];
      return {
        id: a.entity_id, name: a.entity_name || '', campaign_id: a.campaign_id,
        daily_budget: a.daily_budget || 0,
        roas_7d: (m7.spend || 0) > 0 ? (m7.purchase_value || 0) / m7.spend : 0,
        purchases_7d: m7.purchases || 0,
        spend_7d: m7.spend || 0,
        age_days: firstAt ? Math.floor((Date.now() - new Date(firstAt).getTime()) / 86400000) : null
      };
    })
    .filter(c => {
      const up = c.name.toUpperCase();
      if (c.campaign_id === targetCampaignId) return false;            // ya vive ahí
      if (up.includes('[ARES')) return false;                          // no reciclar clones de Ares
      if (up.includes(' - COPY') || up.includes('[TEST]')) return false;
      if (isExcludedEntity({ campaign_id: c.campaign_id, name: c.name })) return false;
      if (c.roas_7d < CBO_FILL_SRC_ROAS_MIN) return false;
      if (c.purchases_7d < CBO_FILL_SRC_PURCHASES_MIN) return false;
      if (c.spend_7d < CBO_FILL_SRC_SPEND_MIN_7D) return false;
      if (c.age_days == null || c.age_days < CBO_FILL_SRC_AGE_MIN_DAYS) return false; // fail-closed
      // dedup contra lo que YA está en el CBO destino (por nombre base)
      const base = c.name.slice(0, 25).toLowerCase();
      if (targetNorm.some(t => t && (t.includes(base) || base.includes(t)))) return false;
      return true;
    })
    .sort((x, y) => (y.purchases_7d - x.purchases_7d) || (y.roas_7d - x.roas_7d));
}

/**
 * Detector → EJECUTOR: cbo_undercapacity_fill
 * Puebla CBOs de Ares con <4 adsets usando winners probados (cobertura ADICIONAL:
 * el original NO se pausa — a diferencia del rescate, esto no es un traslado).
 */
async function executeCboFill(cboSnapshot, adsets) {
  const executed = [];
  if (!/^\[ares/i.test(cboSnapshot.campaign_name || '')) return executed; // solo CBOs de Ares
  // El CBO rescate NO se rellena con winners genéricos: su población viene de los
  // rescates de famélicos (mezclar diluiría la medición de ese experimento).
  if (await isRescueCbo(cboSnapshot.campaign_id)) return executed;
  if (adsets.length >= CBO_FILL_TARGET_ADSETS) return executed;

  // Si Meta ya concentra sano en un favorito, meter más adsets diluye — respetar el
  // gate de saturación, PERO solo con 3+ adsets: con 1-2, el "favorito" se lleva
  // 60-70% del spend por matemática pura (2 opciones), no por saturación real — y el
  // gate bloqueaba el fill justo en los CBOs chicos que queremos poblar (visto en el
  // primer ciclo 2026-06-11: SKIP fill por cbo_saturated_winner en CBOs de 2 adsets).
  if (adsets.length >= 3) {
    const blocked = shouldBlockDuplicationToCBO(cboSnapshot);
    if (blocked.block) {
      logger.info(`[ARES-PORTFOLIO] SKIP fill "${cboSnapshot.campaign_name}": ${blocked.reason}`);
      return executed;
    }
  }

  // Edad mínima del CBO (first-seen) — recién creado hoy ya viene seedeado por el Brain
  try {
    const firstCboSnap = await MetricSnapshot.findOne({ entity_type: 'campaign', entity_id: cboSnapshot.campaign_id })
      .sort({ snapshot_at: 1 }).select('snapshot_at').lean();
    const cboAgeDays = firstCboSnap ? (Date.now() - new Date(firstCboSnap.snapshot_at).getTime()) / 86400000 : 0;
    if (cboAgeDays < CBO_FILL_MIN_CBO_AGE_DAYS) return executed;
  } catch (_) { return executed; }

  // Una tanda de fill EXITOSA por CBO cada 18h — gradual, evalúa el efecto antes de
  // seguir. success:true (2026-06-11): los intentos FALLIDOS (Meta rechazando creativos
  // deprecados) no deben consumir la ventana — bloqueaban el retry en Mature Winners.
  const recentFill = await ActionLog.findOne({
    action: 'duplicate_adset', 'metadata.detector': 'cbo_undercapacity_fill',
    'metadata.target_cbo_id': cboSnapshot.campaign_id, success: true,
    executed_at: { $gte: new Date(Date.now() - 18 * 3600000) }
  }).select('_id').lean();
  if (recentFill) return executed;

  const need = Math.min(CBO_FILL_TARGET_ADSETS - adsets.length, CBO_FILL_MAX_PER_CYCLE);
  const candidates = await getFillCandidates(cboSnapshot.campaign_id, adsets.map(x => x.name));
  if (!candidates.length) {
    logger.info(`[ARES-PORTFOLIO] fill "${cboSnapshot.campaign_name}": ${adsets.length}/${CBO_FILL_TARGET_ADSETS} adsets pero sin candidatos que pasen los gates`);
    return executed;
  }

  for (const c of candidates) {
    if (executed.length >= need) break;
    if (await alreadyActedOn(c.id, 'duplicate_adset')) continue;
    const gate = await validateSafetyGates({ entity_id: c.id, action_type: 'duplicate_adset' });
    if (!gate.allowed) { logger.info(`[ARES-PORTFOLIO] SKIP fill candidato ${c.name}: ${gate.reason}`); continue; }

    const cloneName = `[Ares-Fill] ${c.name}`;
    const reasoning = `CBO fill: "${cboSnapshot.campaign_name}" tiene ${adsets.length}/${CBO_FILL_TARGET_ADSETS} adsets — muy pocos para que Meta optimice el reparto. Poblando con winner probado: ROAS ${c.roas_7d.toFixed(2)}x, ${c.purchases_7d} compras sobre $${c.spend_7d.toFixed(0)} en 7d, ${c.age_days}d de edad. Cobertura ADICIONAL (el original sigue activo en su campaña).`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      const result = await meta.duplicateAdSet(c.id, {
        campaign_id: cboSnapshot.campaign_id,
        deep_copy: true,
        name: cloneName,
        status: 'ACTIVE'
      });
      if (result.success && result.new_adset_id) {
        await cooldowns.setCooldown(c.id, 'adset', 'duplicate_adset', 'ares_portfolio');
        await logAction({
          entity_type: 'adset', entity_id: c.id, entity_name: c.name,
          action: 'duplicate_adset',
          before_value: adsets.length, after_value: adsets.length + executed.length + 1,
          reasoning,
          metadata: {
            detector: 'cbo_undercapacity_fill',
            target_cbo_id: cboSnapshot.campaign_id,
            target_cbo_name: cboSnapshot.campaign_name,
            new_adset_id: result.new_adset_id,
            roas_7d: +c.roas_7d.toFixed(2),
            purchases_7d: c.purchases_7d,
            new_adset_status: 'ACTIVE'
          },
          success: true
        });
        try {
          const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
          const lastMsg = await ZeusChatMessage.findOne({}).sort({ created_at: -1 }).lean();
          if (lastMsg?.conversation_id) {
            await ZeusChatMessage.create({
              conversation_id: lastMsg.conversation_id,
              role: 'assistant',
              content: `🧱 **Ares Fill**: "${c.name}" → "${cboSnapshot.campaign_name}" (\`${result.new_adset_id}\`)\n\nEl CBO tenía ${adsets.length}/${CBO_FILL_TARGET_ADSETS} adsets. Candidato: ROAS ${c.roas_7d.toFixed(2)}x · ${c.purchases_7d} compras · $${c.spend_7d.toFixed(0)} 7d. Clon ACTIVE; el original sigue en su campaña.`,
              proactive: true,
              context_snapshot: { source: 'ares_fill', new_adset_id: result.new_adset_id }
            });
          }
        } catch (_) { /* non-critical */ }
        executed.push({ kind: 'cbo_undercapacity_fill', adset: c.name, new_id: result.new_adset_id, cbo: cboSnapshot.campaign_name });
        logger.info(`[ARES-PORTFOLIO] 🧱 fill: "${c.name}" (ROAS ${c.roas_7d.toFixed(2)}x, ${c.purchases_7d}c) → "${cboSnapshot.campaign_name}" ahora ${adsets.length + executed.length}/${CBO_FILL_TARGET_ADSETS}`);
      }
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: c.id, entity_name: c.name,
        action: 'duplicate_adset', reasoning, success: false, error: err.message,
        metadata: { detector: 'cbo_undercapacity_fill', target_cbo_id: cboSnapshot.campaign_id }
      });
      logger.error(`[ARES-PORTFOLIO] fill falló para ${c.name}: ${err.message}`);
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
 * Detector → EJECUTOR: budget_hog_drag (2026-06-19)
 * Pausa el adset que se COME el budget del CBO pero NO rinde (gasta sin generar),
 * mientras hermanos quedan sin budget. Meta a veces fija el favorito en el adset
 * EQUIVOCADO (peor ROAS) y lo mantiene por inercia → arrastra todo el CBO. Ares lo
 * destraba pausándolo → el budget se reparte a los demás. Cubre el hueco que
 * underperformer_kill (salta LEARNING + exige 0 compras) y zombie_kill (exige <1%
 * share) NO atrapaban. Cash-aware (no pausa por Meta-ROAS sub-atribuido), con doble
 * piso: Meta crudo <1.5x (obvio malo) O cash-ajustado <2x (no rinde lo que gasta).
 */
async function executeBudgetHogDrag(cboSnapshot, adsets) {
  const executed = [];
  if (adsets.length < 2) return executed; // necesita ≥2 adsets para que Meta redistribuya
  // Haircut de cash (Demeter) — el pixel sub/sobre-atribuye; no decidir por Meta solo.
  let haircut = 1;
  try {
    const { getAccountCashSignal } = require('./demeter-cash-signal');
    const cs = await getAccountCashSignal();
    if (cs && cs.available && cs.haircut_factor) haircut = cs.haircut_factor;
  } catch (_) { /* fail-open: haircut 1 */ }

  for (const a of adsets) {
    if (a.spend_share_3d < HOG_SHARE_MIN) continue;   // no se come el budget → no es el hog
    if (a.spend_3d < HOG_SPEND_MIN_3D) continue;       // poco gasto aún → prematuro
    const metaRoas = a.roas_7d || 0;
    const cashRoas = metaRoas * haircut;
    // Rinde si: cash por encima del piso Y Meta crudo no es obviamente malo. Si NINGUNO
    // de los dos pisos se viola, lo dejamos. Pausa solo si claramente no rinde.
    const poor = (metaRoas < HOG_META_ROAS_FLOOR) || (cashRoas < HOG_CASH_ROAS_FLOOR);
    if (!poor) continue;
    if (await alreadyActedOn(a.id, 'pause')) continue;

    const gate = await validateSafetyGates({ entity_id: a.id, action_type: 'pause' });
    if (!gate.allowed) { logger.info(`[ARES-PORTFOLIO] SKIP budget-hog ${a.name}: ${gate.reason}`); continue; }

    const betterSibling = adsets.find(b => b.id !== a.id && b.roas_7d >= metaRoas * 1.5);
    const reasoning = `Budget hog que no rinde: se come ${(a.spend_share_3d * 100).toFixed(0)}% del budget del CBO ($${Math.round(a.spend_3d)} en 3d) pero ROAS Meta ${metaRoas.toFixed(2)}x / cash ${cashRoas.toFixed(2)}x (haircut ${haircut.toFixed(2)}) — debajo del piso (Meta ${HOG_META_ROAS_FLOOR} / cash ${HOG_CASH_ROAS_FLOOR}). ${betterSibling ? `Hermano mejor starved: "${betterSibling.name}" ${betterSibling.roas_7d.toFixed(2)}x. ` : ''}Pausando → Meta redistribuye el budget a los demás adsets del CBO "${cboSnapshot.campaign_name}".`;

    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      await meta.updateStatus(a.id, 'PAUSED');
      await cooldowns.setCooldown(a.id, 'adset', 'pause', 'ares_portfolio');
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'pause', before_value: 'ACTIVE', after_value: 'PAUSED', reasoning,
        metadata: {
          detector: 'budget_hog_drag',
          spend_share_3d: +(a.spend_share_3d * 100).toFixed(1),
          spend_3d: Math.round(a.spend_3d),
          meta_roas_7d: +metaRoas.toFixed(2),
          cash_roas: +cashRoas.toFixed(2),
          haircut: +haircut.toFixed(2),
          parent_cbo: cboSnapshot.campaign_name
        },
        success: true
      });
      executed.push({ kind: 'budget_hog_drag', adset: a.name, share: +(a.spend_share_3d * 100).toFixed(0), cash_roas: +cashRoas.toFixed(2) });
      logger.info(`[ARES-PORTFOLIO] ✓ budget-hog pausado "${a.name}" (${(a.spend_share_3d * 100).toFixed(0)}% share · Meta ${metaRoas.toFixed(2)}x · cash ${cashRoas.toFixed(2)}x) → redistribuye en "${cboSnapshot.campaign_name}"`);
    } catch (err) {
      await logAction({
        entity_type: 'adset', entity_id: a.id, entity_name: a.name,
        action: 'pause', reasoning, success: false, error: err.message,
        metadata: { detector: 'budget_hog_drag' }
      });
      logger.error(`[ARES-PORTFOLIO] budget-hog pause falló para ${a.name}: ${err.message}`);
    }
  }
  return executed;
}

/**
 * Detector → EJECUTOR: decisive_cbo_kill (FASE 1 del rebuild, 2026-06-19)
 * Mata el CBO ENTERO si es un loser persistente — cash-ROAS sostenido bajo el piso (7d Y
 * 3d) con gasto significativo. No más muerte lenta de scale-down 15%: el caso "1.48x por 18
 * días" se corta de raíz. Devuelve el budget liberado para que el portfolio lo consolide en
 * los winners (post-pass en runPortfolioAnalysis). Si dispara, el CBO está muerto → el caller
 * NO corre el resto de detectores sobre él.
 * @returns {Array} acciones (cada una con freed_budget para consolidar)
 */
async function executeDecisiveCboKill(cboSnapshot) {
  let haircut = 1;
  try {
    const { getAccountCashSignal } = require('./demeter-cash-signal');
    const cs = await getAccountCashSignal();
    if (cs && cs.available && cs.haircut_factor) haircut = cs.haircut_factor;
  } catch (_) { /* fail-open */ }

  const spend7 = cboSnapshot.cbo_spend_7d || 0;
  const cash7 = (cboSnapshot.cbo_roas_7d || 0) * haircut;
  const cash3 = (cboSnapshot.cbo_roas_3d || 0) * haircut;

  if (spend7 < KILL_MIN_SPEND_7D) return [];                       // chico/nuevo → no es loser persistente
  if (cash7 >= KILL_CASH_FLOOR) return [];                         // rinde en 7d → no tocar
  if (cash3 >= KILL_CASH_FLOOR * KILL_RECOVERY_MULT) return [];    // 3d recuperándose → darle chance
  if (await alreadyActedOn(cboSnapshot.campaign_id, 'pause')) return [];

  const gate = await validateSafetyGates({ entity_id: cboSnapshot.campaign_id, action_type: 'pause' });
  if (!gate.allowed) { logger.info(`[ARES-PORTFOLIO] SKIP decisive-kill ${cboSnapshot.campaign_name}: ${gate.reason}`); return []; }

  const freed = cboSnapshot.daily_budget || 0;
  const reasoning = `CBO loser persistente — KILL decisivo: cash-ROAS 7d ${cash7.toFixed(2)}x y 3d ${cash3.toFixed(2)}x (Meta 7d ${(cboSnapshot.cbo_roas_7d || 0).toFixed(2)}x × haircut ${haircut.toFixed(2)}), AMBOS debajo del piso ${KILL_CASH_FLOOR}x, sobre $${Math.round(spend7)} gastados en 7d. No se baja gradual — se mata el CBO entero ($${freed}/d liberados → consolidar en winners). "${cboSnapshot.campaign_name}".`;

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateStatus(cboSnapshot.campaign_id, 'PAUSED');
    await cooldowns.setCooldown(cboSnapshot.campaign_id, 'campaign', 'pause', 'ares_portfolio');
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'pause', before_value: 'ACTIVE', after_value: 'PAUSED', reasoning,
      metadata: { detector: 'decisive_cbo_kill', cash_roas_7d: +cash7.toFixed(2), cash_roas_3d: +cash3.toFixed(2), meta_roas_7d: +(cboSnapshot.cbo_roas_7d || 0).toFixed(2), spend_7d: Math.round(spend7), freed_budget: freed, haircut: +haircut.toFixed(2) },
      success: true
    });
    logger.info(`[ARES-PORTFOLIO] ☠️ KILL decisivo del CBO "${cboSnapshot.campaign_name}" (cash 7d ${cash7.toFixed(2)}x/3d ${cash3.toFixed(2)}x · $${Math.round(spend7)} 7d) → $${freed}/d liberados`);
    return [{ kind: 'decisive_cbo_kill', cbo: cboSnapshot.campaign_name, cbo_id: cboSnapshot.campaign_id, freed_budget: freed }];
  } catch (err) {
    await logAction({
      entity_type: 'campaign', entity_id: cboSnapshot.campaign_id, entity_name: cboSnapshot.campaign_name,
      action: 'pause', reasoning, success: false, error: err.message, metadata: { detector: 'decisive_cbo_kill' }
    });
    logger.error(`[ARES-PORTFOLIO] decisive-kill falló para ${cboSnapshot.campaign_name}: ${err.message}`);
    return [];
  }
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

  // FASE 1: KILL decisivo del CBO PRIMERO. Si es un loser persistente, se mata entero y
  // NO se corre el resto de detectores sobre un CBO muerto (sería trabajo + riesgo al pedo).
  const killed = await executeDecisiveCboKill(cboSnapshot);
  if (killed.length) return { executed: killed, killed: true };

  const executed = [];
  // Orden importa: primero las acciones bounded más específicas/seguras
  // (rescue individual, kill individual), después las batch (zombie kill),
  // después scale actions CBO-level. Así si se llena el cap, al menos
  // tocamos las acciones de menor riesgo primero.
  const runners = [
    () => executeStarvedRescue(cboSnapshot, adsets, getRescueCbo),
    () => executeCboFill(cboSnapshot, adsets),                 // 2026-06-11: completa CBOs de Ares sub-poblados con winners probados
    () => executeKill(cboSnapshot, adsets),
    () => executeBudgetHogDrag(cboSnapshot, adsets),          // 2026-06-19: pausa el adset que se come el budget sin rendir → Meta redistribuye
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
        severity: 'warning', // 2026-06-10: 'high' no existe en el enum (critical|warning|info) — el evento fallaba silencioso
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

  // ── CONSOLIDACIÓN DE CAPITAL (Fase 1, 2026-06-19) ──────────────────────────────────
  // El budget liberado por kills decisivos va al MEJOR winner del portfolio (no se pierde
  // ni se reparte parejo). Capital sigue a la performance: concentrá en lo que rinde.
  const freedTotal = allExecuted.filter(e => e.kind === 'decisive_cbo_kill').reduce((s, e) => s + (e.freed_budget || 0), 0);
  if (freedTotal > 0) {
    try {
      const killedIds = new Set(allExecuted.filter(e => e.kind === 'decisive_cbo_kill').map(e => e.cbo_id));
      let haircut = 1;
      try { const { getAccountCashSignal } = require('./demeter-cash-signal'); const cs = await getAccountCashSignal(); if (cs && cs.available && cs.haircut_factor) haircut = cs.haircut_factor; } catch (_) {}
      const winners = latestSnaps
        .filter(s => !killedIds.has(s.campaign_id) && !s.is_zombie && (s.cbo_spend_7d || 0) > 50)
        .map(s => ({ s, cash7: (s.cbo_roas_7d || 0) * haircut }))
        .filter(w => w.cash7 >= CONSOLIDATE_MIN_CASH_ROAS)
        .sort((a, b) => b.cash7 - a.cash7);
      if (winners.length) {
        const best = winners[0].s;
        const cur = best.daily_budget || 0;
        const bump = Math.min(freedTotal, Math.round(cur * CONSOLIDATE_MAX_PCT));
        const newBudget = cur + bump;
        const gate = await validateSafetyGates({ entity_id: best.campaign_id, action_type: 'scale_up' });
        if (bump > 0 && gate.allowed && !(await alreadyActedOn(best.campaign_id, 'scale_up'))) {
          const { getMetaClient } = require('../../meta/client');
          const meta = getMetaClient();
          await meta.updateBudget(best.campaign_id, newBudget);
          await cooldowns.setCooldown(best.campaign_id, 'campaign', 'scale_up', 'ares_portfolio');
          await logAction({
            entity_type: 'campaign', entity_id: best.campaign_id, entity_name: best.campaign_name,
            action: 'scale_up', before_value: cur, after_value: newBudget,
            reasoning: `Consolidación de capital: $${freedTotal}/d liberados de CBO(s) matados → al mejor winner "${best.campaign_name}" (cash-ROAS 7d ${winners[0].cash7.toFixed(2)}x). Budget $${cur}→$${newBudget}/d (bump capeado +${Math.round(CONSOLIDATE_MAX_PCT * 100)}% para no resetear learning).`,
            metadata: { detector: 'capital_consolidation', freed_total: freedTotal, bump, cash_roas_7d: +winners[0].cash7.toFixed(2) },
            success: true
          });
          allExecuted.push({ kind: 'capital_consolidation', cbo: best.campaign_name, from: cur, to: newBudget });
          byDetector['capital_consolidation'] = (byDetector['capital_consolidation'] || 0) + 1;
          logger.info(`[ARES-PORTFOLIO] 💰 consolidación: $${freedTotal}/d → "${best.campaign_name}" $${cur}→$${newBudget} (cash ${winners[0].cash7.toFixed(2)}x)`);
        } else {
          logger.info(`[ARES-PORTFOLIO] consolidación: $${freedTotal}/d liberados pero scale del winner bloqueado (${!gate.allowed ? gate.reason : 'cooldown/bump 0'})`);
        }
      } else {
        logger.info(`[ARES-PORTFOLIO] consolidación: $${freedTotal}/d liberados pero ningún winner ≥${CONSOLIDATE_MIN_CASH_ROAS}x cash para recibir`);
      }
    } catch (e) {
      logger.error(`[ARES-PORTFOLIO] consolidación falló: ${e.message}`);
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
    executeCboFill,
    executeKill,
    executeBudgetHogDrag,         // 2026-06-19: pausa el hog que no rinde
    executeDecisiveCboKill,       // 2026-06-19 Fase 1: mata el CBO loser persistente entero
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
