/**
 * Ares Portfolio Manager — genera BrainRecommendations propose-only sobre el
 * estado del portfolio de CBOs. Fase 3 opción A (adelantada, 2026-04-23).
 *
 * Ares hoy solo duplica ganadores. Este módulo agrega 4 detectores que
 * observan las CBOs completas + sus adsets, y proponen acciones concretas:
 *
 *   1. starved_winner_rescue — adset con ROAS >2 pero recibiendo <3% del
 *      spend de su CBO. Meta no lo está explorando. Propone rescue a CBO 3.
 *
 *   2. underperformer_kill — adset con spend >$30 + 0 purchases + edad >5d.
 *      Consumió budget sin converter. Propone pausar.
 *
 *   3. cbo_saturated_winner — concentración top adset >70% sostenida + ROAS
 *      sano + favorito no declining. Meta eligió ganador. Propone subir
 *      budget de la CBO (Meta lo reasigna al ganador).
 *
 *   4. cbo_starvation — budget_pulse <$20 con ≥8 adsets activos. Falta
 *      budget para que Meta explore. Propone subir budget CBO a
 *      active_adsets × $25.
 *
 * TODO propose-only: escribe BrainRecommendation con status='pending'. El
 * creador aprueba o rechaza en el panel. Sin ejecución autónoma.
 *
 * Fuente de autoría: body prefijado con [ARES-PORTFOLIO] para distinguirse
 * del pipeline legacy de BrainRecommendation (dark desde 10-mar).
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
const BrainRecommendation = require('../../db/models/BrainRecommendation');
const logger = require('../../utils/logger');
const { isCBO } = require('./cbo-health-monitor');

// Thresholds configurables — ajustados a la data real observada 2026-04-23.
const STARVED_WINNER_SHARE_MAX = 0.03;   // <3% del spend de su CBO
const STARVED_WINNER_ROAS_MIN = 2.0;      // ROAS mínimo para considerar "winner"
const STARVED_WINNER_PURCHASES_MIN = 1;   // al menos 1 compra histórica

const UNDERPERFORMER_SPEND_MIN = 30;      // gastó al menos $30
const UNDERPERFORMER_AGE_DAYS_MIN = 5;    // ≥5 días de edad

const CBO_SATURATION_CONC_MIN = 0.70;     // top adset >70% del spend 3d
const CBO_SATURATION_ROAS_MIN = 2.5;      // favorito ROAS mínimo

const CBO_STARVATION_PULSE_MAX = 20;      // budget/adset <$20
const CBO_STARVATION_ADSETS_MIN = 8;      // ≥8 adsets activos

// Dedup: no emitir misma rec para misma entidad si ya hay una pending reciente
const DEDUP_WINDOW_HOURS = 24;

/**
 * Verifica si ya hay una rec pending reciente para esta entidad + action.
 */
async function alreadyRecommended(entity_id, action_type) {
  const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3600000);
  const existing = await BrainRecommendation.findOne({
    'entity.entity_id': entity_id,
    action_type,
    status: 'pending',
    created_at: { $gte: since }
  }).lean();
  return !!existing;
}

/**
 * Crea una BrainRecommendation propose-only con marca ARES-PORTFOLIO.
 */
async function createRec({
  priority, action_type, entity, parent_adset_id, parent_adset_name,
  title, diagnosis, expected_outcome, risk, action_detail,
  supporting_data, confidence, rationale, detector_kind
}) {
  if (await alreadyRecommended(entity.entity_id, action_type)) {
    return null;
  }

  const rec = await BrainRecommendation.create({
    priority,
    action_type,
    entity,
    parent_adset_id: parent_adset_id || null,
    parent_adset_name: parent_adset_name || null,
    title,
    diagnosis,
    expected_outcome,
    risk,
    action_detail,
    body: `[ARES-PORTFOLIO] ${detector_kind}\n\n${rationale}`,
    supporting_data: supporting_data || {},
    confidence: confidence || 'medium',
    confidence_score: confidence === 'high' ? 85 : confidence === 'low' ? 45 : 65,
    status: 'pending',
    follow_up: {
      metrics_at_recommendation: {
        roas_7d: supporting_data?.current_roas_7d || 0,
        cpa_7d: supporting_data?.current_cpa_7d || 0,
        spend_7d: supporting_data?.current_spend_7d || 0,
        frequency_7d: supporting_data?.current_frequency_7d || 0,
        ctr_7d: supporting_data?.current_ctr_7d || 0,
        purchases_7d: supporting_data?.current_purchases_7d || 0
      }
    }
  });

  return rec;
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
 * Detector 1: starved_winner_rescue
 * Adsets con ROAS >2 pero <3% del spend → Meta no los está explorando.
 */
async function detectStarvedWinners(cboSnapshot, adsets) {
  const recs = [];
  for (const a of adsets) {
    if (a.spend_share_7d >= STARVED_WINNER_SHARE_MAX) continue;
    if (a.roas_7d < STARVED_WINNER_ROAS_MIN) continue;
    if (a.purchases_7d < STARVED_WINNER_PURCHASES_MIN) continue;
    if (a.age_days && a.age_days < 3) continue;  // skip learning phase

    const rec = await createRec({
      priority: 'evaluar',
      action_type: 'duplicate_adset',
      entity: { entity_type: 'adset', entity_id: a.id, entity_name: a.name },
      title: `Rescue a CBO 3 — ${a.name} (ROAS ${a.roas_7d.toFixed(2)}x starved)`,
      diagnosis: `Adset con ROAS ${a.roas_7d.toFixed(2)}x y ${a.purchases_7d} compras solo recibió ${Math.round(a.spend_share_7d * 1000) / 10}% del spend de la CBO "${cboSnapshot.campaign_name}" en 7d ($${Math.round(a.spend_7d)} de $${Math.round(cboSnapshot.cbo_spend_7d)}). Meta no lo está explorando.`,
      expected_outcome: `Duplicar a CBO 3 (Rescate) con budget inicial $50-100/d le da chance fresh sin competir con los favoritos de la CBO actual. Winner real merece más runway.`,
      risk: `Sin acción: el ganador potencial queda starved indefinidamente. Estás dejando plata sobre la mesa.`,
      action_detail: `Duplicar adset "${a.name}" a CBO 3 (Rescate/Segunda Oportunidad) con daily_budget ~$75 + creative refresh si aplica.`,
      supporting_data: {
        current_roas_7d: +a.roas_7d.toFixed(2),
        current_spend_7d: Math.round(a.spend_7d),
        current_purchases_7d: a.purchases_7d,
        current_cpa_7d: a.cpa_7d,
        current_ctr_7d: +a.ctr_7d.toFixed(2),
        current_frequency_7d: +a.frequency_7d.toFixed(2),
        trend_direction: 'unknown'
      },
      confidence: 'high',
      rationale: [
        `**Evidencia**:`,
        `- ROAS 7d: ${a.roas_7d.toFixed(2)}x (threshold: >${STARVED_WINNER_ROAS_MIN})`,
        `- Spend share 7d: ${(a.spend_share_7d * 100).toFixed(1)}% (threshold: <${STARVED_WINNER_SHARE_MAX * 100}%)`,
        `- Compras 7d: ${a.purchases_7d}`,
        `- Edad: ${a.age_days}d · Learning: ${a.learning_stage}`,
        ``,
        `**Hipótesis**: Meta concentró en ${cboSnapshot.favorite_adset_name} (${Math.round(cboSnapshot.concentration_index_7d * 100 || cboSnapshot.concentration_index_3d * 100)}% del spend) y este adset no recibe exploración. Al duplicarlo a CBO 3 con budget propio, se rompe la competencia interna.`
      ].join('\n'),
      detector_kind: 'starved_winner_rescue'
    });
    if (rec) recs.push(rec);
  }
  return recs;
}

/**
 * Detector 2: underperformer_kill
 * Adsets con spend significativo pero 0 purchases y edad suficiente.
 */
async function detectUnderperformers(cboSnapshot, adsets) {
  const recs = [];
  for (const a of adsets) {
    if (a.spend_7d < UNDERPERFORMER_SPEND_MIN) continue;
    if (a.purchases_7d > 0) continue;
    if (!a.age_days || a.age_days < UNDERPERFORMER_AGE_DAYS_MIN) continue;
    if (a.learning_stage === 'LEARNING') continue;  // respetar learning

    const rec = await createRec({
      priority: 'urgente',
      action_type: 'pause',
      entity: { entity_type: 'adset', entity_id: a.id, entity_name: a.name },
      parent_adset_id: cboSnapshot.campaign_id,
      parent_adset_name: cboSnapshot.campaign_name,
      title: `Pausar ${a.name} — $${Math.round(a.spend_7d)} sin compras en ${a.age_days}d`,
      diagnosis: `Adset gastó $${Math.round(a.spend_7d)} en 7d con 0 compras. Edad ${a.age_days}d (ya salió de learning phase). Dentro de CBO "${cboSnapshot.campaign_name}".`,
      expected_outcome: `Pausar libera budget que Meta reasigna a ganadores de la misma CBO. Probable recovery parcial del ROAS agregado de la CBO.`,
      risk: `Sin acción: seguirá consumiendo su share hasta que Meta solo lo baje. Mientras tanto, quema ~$${Math.round(a.spend_7d / 7)}/día sin retorno.`,
      action_detail: `Pausar adset "${a.name}" (ID ${a.id}). Budget vuelve al pool de la CBO.`,
      supporting_data: {
        current_roas_7d: 0,
        current_spend_7d: Math.round(a.spend_7d),
        current_purchases_7d: 0,
        current_ctr_7d: +a.ctr_7d.toFixed(2),
        current_frequency_7d: +a.frequency_7d.toFixed(2),
        trend_direction: 'declining'
      },
      confidence: 'high',
      rationale: [
        `**Evidencia**:`,
        `- Spend 7d: $${Math.round(a.spend_7d)} (threshold: >$${UNDERPERFORMER_SPEND_MIN})`,
        `- Compras 7d: 0`,
        `- Edad: ${a.age_days}d (threshold: >${UNDERPERFORMER_AGE_DAYS_MIN}d, ya salió de learning)`,
        `- CTR: ${a.ctr_7d.toFixed(2)}%`,
        ``,
        `**Concentración CBO**: ${Math.round(cboSnapshot.concentration_index_3d * 100)}% del spend está en el favorito. Este adset no compite.`
      ].join('\n'),
      detector_kind: 'underperformer_kill'
    });
    if (rec) recs.push(rec);
  }
  return recs;
}

/**
 * Detector 3: cbo_saturated_winner
 * CBO con concentración alta + favorito sano → Meta ya eligió. Subir budget.
 */
async function detectSaturatedWinner(cboSnapshot, adsets) {
  if (cboSnapshot.concentration_index_3d < CBO_SATURATION_CONC_MIN) return [];
  if (cboSnapshot.favorite_roas_7d < CBO_SATURATION_ROAS_MIN) return [];
  if (cboSnapshot.favorite_declining) return [];

  const cboEntityId = cboSnapshot.campaign_id;
  const currentBudget = cboSnapshot.daily_budget;
  const proposedBudget = Math.round(currentBudget * 1.15);

  const rec = await createRec({
    priority: 'evaluar',
    action_type: 'scale_up',
    entity: {
      entity_type: 'campaign',
      entity_id: cboEntityId,
      entity_name: cboSnapshot.campaign_name
    },
    title: `Subir budget CBO "${cboSnapshot.campaign_name}" +15% — winner consolidado`,
    diagnosis: `La CBO tiene ${Math.round(cboSnapshot.concentration_index_3d * 100)}% de concentración en "${cboSnapshot.favorite_adset_name}" (ROAS ${cboSnapshot.favorite_roas_7d.toFixed(2)}x, tenure ${cboSnapshot.favorite_tenure_days}d, no declining). Meta ya decidió quién gana. Más budget va a ir al ganador, no a exploración.`,
    expected_outcome: `Subir budget de $${currentBudget}/d a $${proposedBudget}/d (+15%). Meta reasignará la mayoría al favorito que ya está convirtiendo a ${cboSnapshot.favorite_roas_7d.toFixed(2)}x. Retorno esperado proporcional.`,
    risk: `Sin acción: capital de la CBO es la limitación, no la decisión de Meta. Estás dejando que Meta salte el techo por budget.`,
    action_detail: `Subir daily_budget de "${cboSnapshot.campaign_name}" de $${currentBudget} a $${proposedBudget}.`,
    supporting_data: {
      current_roas_7d: +cboSnapshot.cbo_roas_7d.toFixed(2),
      current_spend_7d: Math.round(cboSnapshot.cbo_spend_7d),
      current_purchases_7d: adsets.reduce((s, a) => s + a.purchases_7d, 0),
      trend_direction: 'stable'
    },
    confidence: 'medium',
    rationale: [
      `**Evidencia**:`,
      `- Concentración 3d: ${Math.round(cboSnapshot.concentration_index_3d * 100)}% (threshold: >${CBO_SATURATION_CONC_MIN * 100}%)`,
      `- Favorito: ${cboSnapshot.favorite_adset_name}`,
      `- Favorito ROAS 7d: ${cboSnapshot.favorite_roas_7d.toFixed(2)}x (threshold: >${CBO_SATURATION_ROAS_MIN}x)`,
      `- Favorito freq: ${cboSnapshot.favorite_freq.toFixed(2)} · tenure: ${cboSnapshot.favorite_tenure_days}d`,
      `- Favorito declining: ${cboSnapshot.favorite_declining ? 'SÍ (NO subir budget)' : 'NO ✓'}`,
      `- CBO ROAS 7d: ${cboSnapshot.cbo_roas_7d.toFixed(2)}x agregado`,
      ``,
      `**Hipótesis**: Meta convergió en el winner y lo está explotando. Más budget = más exploración del winner (no nuevos ads). Patrón confirmado cuando concentración se estabiliza + ROAS sano sostenido.`
    ].join('\n'),
    detector_kind: 'cbo_saturated_winner'
  });
  return rec ? [rec] : [];
}

/**
 * Detector 4: cbo_starvation
 * CBO con budget_pulse bajo y muchos adsets → Meta no tiene plata para explorar.
 */
async function detectCBOStarvation(cboSnapshot) {
  if (cboSnapshot.budget_pulse >= CBO_STARVATION_PULSE_MAX) return [];
  if (cboSnapshot.active_adsets_count < CBO_STARVATION_ADSETS_MIN) return [];

  const currentBudget = cboSnapshot.daily_budget;
  const recommendedPulse = 25;
  const proposedBudget = Math.max(currentBudget + 50, Math.round(cboSnapshot.active_adsets_count * recommendedPulse));

  if (proposedBudget <= currentBudget) return [];

  const rec = await createRec({
    priority: 'evaluar',
    action_type: 'scale_up',
    entity: {
      entity_type: 'campaign',
      entity_id: cboSnapshot.campaign_id,
      entity_name: cboSnapshot.campaign_name
    },
    title: `Subir budget CBO "${cboSnapshot.campaign_name}" por starvation estructural`,
    diagnosis: `La CBO tiene ${cboSnapshot.active_adsets_count} adsets activos con daily_budget $${currentBudget} → pulse $${cboSnapshot.budget_pulse.toFixed(0)}/adset. Bajo el threshold mínimo de $${CBO_STARVATION_PULSE_MAX}. Meta no tiene runway para explorar; concentra en 2-3.`,
    expected_outcome: `Subir budget a $${proposedBudget}/d da pulse de ~$${recommendedPulse}/adset. Permite que Meta pruebe más adsets sin ahogar los que ya funcionan.`,
    risk: `Sin acción: adsets de la CBO quedan starved sistémicamente. Winners nuevos nunca salen a la luz por falta de exploración.`,
    action_detail: `Subir daily_budget de "${cboSnapshot.campaign_name}" de $${currentBudget} a $${proposedBudget} (pulse objetivo $${recommendedPulse}/adset).`,
    supporting_data: {
      current_roas_7d: +cboSnapshot.cbo_roas_7d.toFixed(2),
      current_spend_7d: Math.round(cboSnapshot.cbo_spend_7d),
      trend_direction: 'stable'
    },
    confidence: 'medium',
    rationale: [
      `**Evidencia**:`,
      `- Budget pulse actual: $${cboSnapshot.budget_pulse.toFixed(0)}/adset (threshold: >$${CBO_STARVATION_PULSE_MAX})`,
      `- Adsets activos: ${cboSnapshot.active_adsets_count} (threshold: ≥${CBO_STARVATION_ADSETS_MIN})`,
      `- Daily budget CBO: $${currentBudget}`,
      `- ROAS 7d: ${cboSnapshot.cbo_roas_7d.toFixed(2)}x`,
      ``,
      `**Hipótesis**: budget insuficiente para runway de exploración. Subir a $${proposedBudget}/d (pulse $${recommendedPulse}) da aire sin sobreescalar.`
    ].join('\n'),
    detector_kind: 'cbo_starvation'
  });
  return rec ? [rec] : [];
}

/**
 * Analiza UNA CBO corriendo los 4 detectores y generando recs pending.
 */
async function analyzeCBOForPortfolioRecs(cboSnapshot) {
  // Gate: zombies no se analizan (ya tienen otro alert)
  if (cboSnapshot.is_zombie) return { recs: [], skipped: 'zombie' };

  const adsets = await getAdsetsWithMetrics(cboSnapshot.campaign_id);
  if (adsets.length === 0) return { recs: [], skipped: 'no_adsets' };

  const allRecs = [];
  try {
    const r1 = await detectStarvedWinners(cboSnapshot, adsets);
    const r2 = await detectUnderperformers(cboSnapshot, adsets);
    const r3 = await detectSaturatedWinner(cboSnapshot, adsets);
    const r4 = await detectCBOStarvation(cboSnapshot);
    allRecs.push(...r1, ...r2, ...r3, ...r4);
  } catch (err) {
    logger.error(`[ARES-PORTFOLIO] detector falló para ${cboSnapshot.campaign_id}: ${err.message}`);
  }

  return { recs: allRecs, adsets_analyzed: adsets.length };
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
 * Entry point principal: analiza TODAS las CBOs activas.
 * Llamable desde un cron propio o desde ares-agent al inicio del ciclo.
 */
async function runPortfolioAnalysis() {
  const start = Date.now();

  // Último snapshot por CBO (no stale — últimas 3h)
  const since = new Date(Date.now() - 3 * 3600000);
  const latestSnaps = await CBOHealthSnapshot.aggregate([
    { $match: { snapshot_at: { $gte: since }, is_zombie: false } },
    { $sort: { campaign_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  if (latestSnaps.length === 0) {
    logger.info('[ARES-PORTFOLIO] no snapshots recientes (<3h), skip');
    return { analyzed: 0, recs_created: 0 };
  }

  let totalRecs = 0;
  const byDetector = {};

  for (const snap of latestSnaps) {
    const { recs } = await analyzeCBOForPortfolioRecs(snap);
    totalRecs += recs.length;
    for (const r of recs) {
      const kind = (r.body || '').match(/\[ARES-PORTFOLIO\]\s+(\w+)/)?.[1] || 'unknown';
      byDetector[kind] = (byDetector[kind] || 0) + 1;
    }
  }

  const elapsed = Date.now() - start;
  logger.info(`[ARES-PORTFOLIO] analizadas ${latestSnaps.length} CBOs en ${elapsed}ms · ${totalRecs} recs creadas · detectors: ${JSON.stringify(byDetector)}`);

  return {
    analyzed: latestSnaps.length,
    recs_created: totalRecs,
    by_detector: byDetector,
    elapsed_ms: elapsed
  };
}

module.exports = {
  runPortfolioAnalysis,
  analyzeCBOForPortfolioRecs,
  shouldBlockDuplicationToCBO,
  // export para tests
  _detectors: {
    detectStarvedWinners,
    detectUnderperformers,
    detectSaturatedWinner,
    detectCBOStarvation
  }
};
