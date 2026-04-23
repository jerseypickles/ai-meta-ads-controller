const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ZeusDirective = require('../../db/models/ZeusDirective');
const { getLatestSnapshots } = require('../../db/queries');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURACION — Ares: Agente de Duplicacion (5to agente)
// Procedural. Duplica ganadores a campanas CBO.
//
// CRITERIOS ENDURECIDOS (Abril 2026) — raíz del problema anterior:
// Ares duplicaba con criterios permisivos → 32 clones en CBO1 → 14 starved.
// Nuevo filtro exige track record SOSTENIDO antes de duplicar.
// ═══════════════════════════════════════════════════════════════════════════════
const DUPLICATE_MIN_ROAS = 3.0;              // ROAS minimo SOSTENIDO 14d (era 4x 7d)
const DUPLICATE_MIN_DAYS = 21;               // Edad minima (era 7d)
const DUPLICATE_MIN_SPEND = 500;             // Spend acumulado minimo (era $100 7d)
const DUPLICATE_MIN_PURCHASES = 30;          // Purchases acumulados minimos (nuevo)
const DUPLICATE_MIN_LEARNING_CONV = 40;      // Learning conv progress minimo (nuevo, o SUCCESS)
const DUPLICATE_MAX_FREQUENCY = 2.0;         // Frequency maxima
const MAX_DUPLICATES_PER_CONCEPT = 2;
const MIN_DAYS_BETWEEN_DUPLICATES = 7;
const CLONE_DAILY_BUDGET = 30;
const MAX_DUPLICATES_PER_CYCLE = 3;

// Fast-track ELIMINADO (abril 2026): 100% fail rate en produccion.
// El criterio original (ROAS 5x + 3 purch en testing) no predice performance en CBO.
const FAST_TRACK_DISABLED = true;

// Patrones a excluir de duplicacion
const EXCLUDE_PATTERNS = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'DONT_TOUCH', 'EXCLUDE', 'MANUAL ONLY'];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtener o crear la campana CBO de Ares.
 * Campana CBO con budget a nivel de campana — Meta distribuye entre clones.
 */
/**
 * Obtener CBO 2 — campaña para nuevos clones (fast-tracks + duplicaciones nuevas).
 * CBO 1 (ares_campaign_id) se queda con los clones existentes.
 */
async function getAresCampaign2Id() {
  const stored = await SystemConfig.get('ares_campaign_2_id', null);
  if (stored) return stored;
  // Fallback a CBO 1 si CBO 2 no existe
  return getAresCampaignId();
}

/**
 * Obtener CBO 3 — tier de medicion/rescate (abril 2026).
 * Recibe ad sets starved de CBO 1/2 para fair test con delivery garantizado.
 * Retorna null si no existe (no auto-create — se crea manual con script).
 */
async function getAresCampaign3Id() {
  return await SystemConfig.get('ares_campaign_3_id', null);
}

async function getAresCampaignId() {
  // 1. SystemConfig
  const stored = await SystemConfig.get('ares_campaign_id', null);
  if (stored) {
    logger.debug(`[ARES] Campana existente: ${stored}`);
    return stored;
  }

  // 2. Auto-crear campana ABO con budget sharing
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  logger.info('[ARES] Creando campana CBO para duplicados...');
  const result = await meta.createCampaign({
    name: '[ARES] Duplicados Ganadores',
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    is_adset_budget_sharing_enabled: true
    // CBO: budget a nivel de campana, Meta distribuye entre clones
  });

  const campaignId = result.campaign_id;
  await SystemConfig.set('ares_campaign_id', campaignId, 'ares_agent');
  logger.info(`[ARES] Campana CBO creada: ${campaignId}`);

  return campaignId;
}

/**
 * Buscar ad sets candidatos para duplicacion.
 * Criterios ENDURECIDOS (abril 2026):
 *   - ROAS >= 3x sostenido 14d (fallback 7d)
 *   - Spend acumulado >= $500
 *   - Purchases acumuladas >= 30
 *   - Frequency < 2.0
 *   - Edad >= 21 dias
 *   - Learning: SUCCESS o >= 40 conv
 *   - Max 2 duplicados por concepto, min 7d entre duplicaciones
 */
async function findDuplicationCandidates() {
  const allSnapshots = await getLatestSnapshots('adset');

  // Filtrar activos, no excluidos
  const active = allSnapshots.filter(s => {
    if (s.status !== 'ACTIVE') return false;
    const name = (s.entity_name || '').toUpperCase();
    return !EXCLUDE_PATTERNS.some(ex => name.includes(ex.toUpperCase()));
  });

  // Filtrar por criterios de performance ENDURECIDOS
  // El objetivo: solo duplicar ad sets que ya probaron sostenibilidad real en ABO.
  // Prevención: no generar starved clones en CBO por dilucion de poblacion debil.
  const candidates = [];
  for (const snap of active) {
    const m14d = snap.metrics?.last_14d || snap.metrics?.last_7d || {};
    const m7d = snap.metrics?.last_7d || {};
    const roasSustained = m14d.roas || m7d.roas || 0;  // 14d preferido, fallback 7d
    const spendAccumulated = m14d.spend || m7d.spend || 0;
    const purchasesAccumulated = m14d.purchases || m7d.purchases || 0;
    const freq = m7d.frequency || 0;
    const learningConv = snap.learning_stage_conversions || 0;
    const isSuccess = snap.learning_stage === 'SUCCESS';

    // Filtro 1: ROAS sostenido (14d preferido)
    if (roasSustained < DUPLICATE_MIN_ROAS) continue;

    // Filtro 2: Spend acumulado (track record real)
    if (spendAccumulated < DUPLICATE_MIN_SPEND) continue;

    // Filtro 3: Purchases acumulados (data suficiente para Meta)
    if (purchasesAccumulated < DUPLICATE_MIN_PURCHASES) continue;

    // Filtro 4: Frequency (no saturado)
    if (freq >= DUPLICATE_MAX_FREQUENCY) continue;

    // Filtro 5: Edad minima (duration)
    if (snap.meta_created_time) {
      const daysOld = (Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000;
      if (daysOld < DUPLICATE_MIN_DAYS) continue;
    } else {
      // Sin meta_created_time no podemos verificar edad → skip por seguridad
      continue;
    }

    // Filtro 6: Learning maturity (SUCCESS o 40+ conv)
    if (!isSuccess && learningConv < DUPLICATE_MIN_LEARNING_CONV) continue;

    candidates.push({
      entity_id: snap.entity_id,
      entity_name: snap.entity_name || snap.entity_id,
      roas_7d: roasSustained,
      spend_7d: spendAccumulated,
      purchases_7d: purchasesAccumulated,
      frequency: freq,
      learning_conv: learningConv,
      learning_stage: snap.learning_stage,
      daily_budget: snap.daily_budget || 0,
      cpa_7d: spendAccumulated > 0 && purchasesAccumulated > 0 ? Math.round(spendAccumulated / purchasesAccumulated * 100) / 100 : 0
    });
  }

  // Verificar historial de duplicaciones — excluir ya duplicados 2x o <7 dias
  const filteredCandidates = [];
  for (const c of candidates) {
    const prevDups = await ActionLog.find({
      action: { $in: ['duplicate_adset', 'fast_track_duplicate'] },
      agent_type: 'ares_agent',
      entity_id: c.entity_id,
      success: true
    }).sort({ executed_at: -1 }).lean();

    // Max 2 duplicados por concepto
    if (prevDups.length >= MAX_DUPLICATES_PER_CONCEPT) {
      logger.debug(`[ARES] ${c.entity_name}: ya tiene ${prevDups.length} duplicados (max ${MAX_DUPLICATES_PER_CONCEPT})`);
      continue;
    }

    // Min 7 dias desde ultima duplicacion
    if (prevDups.length > 0) {
      const lastDupAge = (Date.now() - new Date(prevDups[0].executed_at).getTime()) / 86400000;
      if (lastDupAge < MIN_DAYS_BETWEEN_DUPLICATES) {
        logger.debug(`[ARES] ${c.entity_name}: ultima duplicacion hace ${lastDupAge.toFixed(1)}d (min ${MIN_DAYS_BETWEEN_DUPLICATES}d)`);
        continue;
      }
    }

    c.clone_number = prevDups.length + 1;
    filteredCandidates.push(c);
  }

  // Ordenar por ROAS descendente (los mejores primero)
  filteredCandidates.sort((a, b) => b.roas_7d - a.roas_7d);

  return filteredCandidates;
}

/**
 * Duplicar un ad set ganador a la campana ABO de Ares.
 * Cada clon tiene su propio budget ($30/dia).
 *
 * Fase 2 gate compuesto (2026-04-23): antes de duplicar, chequea el health
 * snapshot de la CBO destino. Si está saturada (conc >70% + favorito sano +
 * no declining) → SKIP duplicación. Meta no distribuiría al clon, sería
 * tirar plata. Requiere un BrainRecommendation de refresh del favorito
 * primero (ver ares-portfolio-manager.js).
 */
async function duplicateWinner(candidate, aresCampaignId) {
  // Gate compuesto — consulta último snapshot de la CBO destino
  try {
    const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
    const { shouldBlockDuplicationToCBO } = require('./ares-portfolio-manager');
    const latestSnap = await CBOHealthSnapshot.findOne({ campaign_id: aresCampaignId })
      .sort({ snapshot_at: -1 }).lean();
    if (latestSnap && !latestSnap.is_zombie) {
      const gate = shouldBlockDuplicationToCBO(latestSnap);
      if (gate.block) {
        logger.warn(`[ARES] SKIP duplicación "${candidate.entity_name}" → CBO ${aresCampaignId}: ${gate.reason} — ${gate.detail}`);
        return {
          skipped: true,
          reason: gate.reason,
          detail: gate.detail,
          cbo_campaign_id: aresCampaignId,
          candidate_name: candidate.entity_name
        };
      }
    }
  } catch (err) {
    // Fail-open: si el gate falla, proceder con la duplicación (modo legacy)
    logger.warn(`[ARES] gate check falló (fail-open): ${err.message}`);
  }

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  const cloneName = `[Ares] ${candidate.entity_name} — Clone ${candidate.clone_number}`;

  logger.info(`[ARES] Duplicando "${candidate.entity_name}" (ROAS ${candidate.roas_7d.toFixed(2)}x) → "${cloneName}"`);

  // Paso 1: Copiar ad set SIN ads (deep_copy: false — Meta limita copies sincronas a <3 objetos)
  // Sin daily_budget — campana CBO maneja el budget a nivel de campana
  const result = await meta.duplicateAdSet(candidate.entity_id, {
    campaign_id: aresCampaignId,
    deep_copy: false,
    name: cloneName,
    status: 'PAUSED'
  });

  if (!result.success || !result.new_adset_id) {
    throw new Error(`Meta API no devolvio new_adset_id: ${JSON.stringify(result)}`);
  }

  // Paso 2: Encontrar el mejor ad del original y copiar su creative al clon
  // Intenta con el mejor ad primero; si falla (ej: crop key deprecated), prueba con el siguiente
  const { getAdsForAdSet } = require('../../db/queries');
  const originalAds = await getAdsForAdSet(candidate.entity_id);
  const activeAds = originalAds.filter(a => a.status === 'ACTIVE')
    .sort((a, b) => (b.metrics?.last_7d?.roas || 0) - (a.metrics?.last_7d?.roas || 0));

  let adCopied = false;
  for (const ad of activeAds) {
    try {
      const adData = await meta.get(`/${ad.entity_id}`, { fields: 'creative{id}' });
      const creativeId = adData.creative?.id;
      if (!creativeId) continue;

      // Verificar si el creative tiene crop key deprecated (191x100)
      try {
        const creativeDetail = await meta.get(`/${creativeId}`, { fields: 'object_story_spec' });
        const hasOldCrop = JSON.stringify(creativeDetail).includes('191x100');
        if (hasOldCrop) {
          logger.warn(`[ARES] Ad "${ad.entity_name}" tiene crop 191x100 deprecated — saltando`);
          continue;
        }
      } catch (_) {} // Si no puede verificar, intentar de todas formas

      await meta.createAd(result.new_adset_id, creativeId, `[Ares] ${ad.entity_name || 'Ad'} Clone`, 'ACTIVE');
      logger.info(`[ARES] Ad creado en clon con creative ${creativeId} de "${ad.entity_name}" (ROAS ${(ad.metrics?.last_7d?.roas || 0).toFixed(2)}x)`);
      adCopied = true;
      break;
    } catch (adErr) {
      logger.warn(`[ARES] Ad "${ad.entity_name}" creative incompatible: ${adErr.message}. Probando siguiente...`);
    }
  }
  if (!adCopied) {
    logger.warn(`[ARES] Ningun ad compatible encontrado para clon de ${candidate.entity_name}. Clon creado sin ads.`);
  }

  // Paso 3: Activar el clon + verificar que los ads esten activos
  try {
    await meta.post(`/${result.new_adset_id}`, { status: 'ACTIVE' });
    logger.info(`[ARES] Clon ${result.new_adset_id} activado`);

    // Verificar ads dentro del clon — a veces Meta los deja PAUSED
    const cloneAds = await meta.get(`/${result.new_adset_id}/ads`, { fields: 'id,name,status' });
    for (const ad of (cloneAds.data || [])) {
      if (ad.status !== 'ACTIVE') {
        try {
          await meta.post(`/${ad.id}`, { status: 'ACTIVE' });
          logger.info(`[ARES] Ad "${ad.name}" en clon activado (estaba ${ad.status})`);
        } catch (adErr) {
          logger.warn(`[ARES] No se pudo activar ad ${ad.id}: ${adErr.message}`);
        }
      }
    }
  } catch (activateErr) {
    logger.warn(`[ARES] Clon creado (${result.new_adset_id}) pero error activando: ${activateErr.message}`);
  }

  // Paso 4: Incrementar budget CBO de la campana (+$30 por cada nuevo duplicado)
  try {
    const campaignData = await meta.get(`/${aresCampaignId}`, { fields: 'daily_budget' });
    const currentCboBudget = campaignData.daily_budget ? parseInt(campaignData.daily_budget) / 100 : 150;
    const newCboBudget = currentCboBudget + CLONE_DAILY_BUDGET;
    await meta.updateBudget(aresCampaignId, newCboBudget);
    logger.info(`[ARES] Budget CBO actualizado: $${currentCboBudget} → $${newCboBudget}/dia`);
  } catch (budgetErr) {
    logger.warn(`[ARES] Error actualizando budget CBO: ${budgetErr.message}`);
  }

  // Registrar en ActionLog
  await ActionLog.create({
    entity_type: 'adset',
    entity_id: candidate.entity_id,
    entity_name: candidate.entity_name,
    action: 'duplicate_adset',
    before_value: candidate.daily_budget,
    after_value: cloneName,
    new_entity_id: result.new_adset_id,
    target_entity_id: aresCampaignId,
    reasoning: `Ares: ROAS ${candidate.roas_7d.toFixed(2)}x 7d, ${candidate.purchases_7d} compras, freq ${candidate.frequency.toFixed(1)}, $${Math.round(candidate.spend_7d)} spend. Clone ${candidate.clone_number}/${MAX_DUPLICATES_PER_CONCEPT} a $${CLONE_DAILY_BUDGET}/dia.`,
    confidence: 'high',
    agent_type: 'ares_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: {
      roas_7d: candidate.roas_7d,
      cpa_7d: candidate.cpa_7d,
      spend_7d: candidate.spend_7d,
      daily_budget: candidate.daily_budget,
      purchases_7d: candidate.purchases_7d,
      frequency: candidate.frequency
    }
  });

  return {
    success: true,
    original: candidate.entity_name,
    clone_name: cloneName,
    new_adset_id: result.new_adset_id,
    roas: candidate.roas_7d,
    clone_number: candidate.clone_number,
    clone_budget: CLONE_DAILY_BUDGET
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 0: PROCESAR DIRECTIVAS DE ZEUS
// ═══════════════════════════════════════════════════════════════════════════════

async function processZeusDirectives(aresCampaignId) {
  // Buscar directivas para 'ares' Y para 'all' que sean relevantes (CBO budget, etc)
  // Fix 2026-04-22: agregar filter de expires_at. Antes Ares podía ejecutar
  // directivas técnicamente active=true pero expiradas — riesgo real con acciones
  // procedurales (duplicaciones, budget changes) que no deberían pasar después
  // del timeout original.
  const now = new Date();
  const directives = await ZeusDirective.find({
    $or: [
      { target_agent: 'ares' },
      { target_agent: 'all', directive_type: 'adjust', 'data.new_budget': { $exists: true } }
    ],
    active: true,
    executed: false,
    $and: [
      { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] }
    ]
  }).sort({ confidence: -1 }).lean();

  if (directives.length === 0) return { processed: 0, results: [] };

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const results = [];

  for (const d of directives) {
    try {
      const data = d.data || {};

      if (d.directive_type === 'force_duplicate') {
        // Zeus ordena duplicar un ad set especifico
        if (!data.adset_id) { logger.warn(`[ARES] force_duplicate sin adset_id — skip`); continue; }

        const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: data.adset_id, status: 'ACTIVE' }).sort({ created_at: -1 }).lean();
        if (!snap) {
          logger.warn(`[ARES] force_duplicate: ad set ${data.adset_id} no encontrado o inactivo`);
          await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: 'ad set not found or inactive' });
          continue;
        }

        // Contar duplicaciones previas
        const prevDups = await ActionLog.countDocuments({ action: 'duplicate_adset', agent_type: 'ares_agent', entity_id: data.adset_id, success: true });
        const candidate = {
          entity_id: snap.entity_id,
          entity_name: snap.entity_name || snap.entity_id,
          roas_7d: snap.metrics?.last_7d?.roas || 0,
          spend_7d: snap.metrics?.last_7d?.spend || 0,
          frequency: snap.metrics?.last_7d?.frequency || 0,
          daily_budget: snap.daily_budget || 0,
          purchases_7d: snap.metrics?.last_7d?.purchases || 0,
          cpa_7d: snap.metrics?.last_7d?.spend > 0 && snap.metrics?.last_7d?.purchases > 0 ? Math.round(snap.metrics.last_7d.spend / snap.metrics.last_7d.purchases * 100) / 100 : 0,
          clone_number: prevDups + 1
        };

        const result = await duplicateWinner(candidate, aresCampaignId);
        logger.info(`[ARES] Zeus force_duplicate ejecutado: "${result.clone_name}"`);
        await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: `duplicated → ${result.clone_name}` });
        results.push({ type: 'force_duplicate', ...result });

      } else if (d.directive_type === 'pause_clone' || (d.directive_type === 'adjust' && data.action === 'pause')) {
        // Zeus ordena pausar un clon
        if (!data.adset_id) { logger.warn(`[ARES] pause_clone sin adset_id — skip`); continue; }

        await meta.post(`/${data.adset_id}`, { status: 'PAUSED' });
        logger.info(`[ARES] Zeus pause_clone ejecutado: ${data.adset_id} — ${data.reason || 'underperforming'}`);

        await ActionLog.create({
          entity_type: 'adset', entity_id: data.adset_id,
          action: 'pause_adset', reasoning: `Zeus directive: ${data.reason || d.directive}`,
          confidence: 'high', agent_type: 'ares_agent', success: true, executed_at: new Date()
        });
        await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: 'clone paused' });
        results.push({ type: 'pause_clone', adset_id: data.adset_id, success: true });

      } else if (d.directive_type === 'adjust' && data.new_budget) {
        // Zeus ordena cambiar budget de una CBO. Seleccionar target segun data.cbo_tier:
        //   'production' | 'rising' | 'rescue' o numero 1/2/3. Default: CBO 1 (production).
        const aresCampaign2IdLocal = await SystemConfig.get('ares_campaign_2_id', null);
        const aresCampaign3IdLocal = await SystemConfig.get('ares_campaign_3_id', null);
        let targetCboId = aresCampaignId;
        let targetTier = 'CBO 1';
        const tierHint = (data.cbo_tier || data.tier || '').toString().toLowerCase();
        if (tierHint.includes('2') || tierHint.includes('rising') || tierHint.includes('prospects')) {
          targetCboId = aresCampaign2IdLocal || aresCampaignId;
          targetTier = 'CBO 2';
        } else if (tierHint.includes('3') || tierHint.includes('rescue') || tierHint.includes('medicion') || tierHint.includes('uci')) {
          targetCboId = aresCampaign3IdLocal || aresCampaignId;
          targetTier = 'CBO 3';
        }

        const currentData = await meta.get(`/${targetCboId}`, { fields: 'daily_budget' });
        const currentCboBudget = currentData.daily_budget ? parseInt(currentData.daily_budget) / 100 : 0;

        await meta.updateBudget(targetCboId, data.new_budget);
        logger.info(`[ARES] Zeus adjust ${targetTier} budget: $${currentCboBudget} → $${data.new_budget}/dia`);

        const action = data.new_budget > currentCboBudget ? 'scale_up' : 'scale_down';
        await ActionLog.create({
          entity_type: 'campaign', entity_id: targetCboId,
          action, before_value: currentCboBudget, after_value: data.new_budget,
          reasoning: `Zeus ${targetTier} budget directive: ${data.reason || d.directive}`,
          confidence: 'high', agent_type: 'ares_agent', success: true, executed_at: new Date()
        });
        await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: `${targetTier} budget $${currentCboBudget} → $${data.new_budget}/dia` });
        results.push({ type: 'adjust_cbo_budget', old_budget: currentCboBudget, new_budget: data.new_budget, success: true });

      } else {
        // prioritize, alert, avoid — directivas informacionales, solo marcar como recibidas
        logger.info(`[ARES] Zeus ${d.directive_type}: "${d.directive}" — acknowledged`);
        await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: 'acknowledged' });
        results.push({ type: d.directive_type, directive: d.directive, acknowledged: true });
      }

    } catch (err) {
      logger.error(`[ARES] Error procesando directiva ${d._id}: ${err.message}`);
      await ZeusDirective.updateOne({ _id: d._id }, { executed: true, executed_at: new Date(), execution_result: `error: ${err.message}` });
      results.push({ type: d.directive_type, error: err.message });
    }
  }

  return { processed: results.length, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 0.5: FAST-TRACK — DESACTIVADO (abril 2026)
// ═══════════════════════════════════════════════════════════════════════════════
// Motivo: 100% fail rate en produccion. Los 9 FTs enviados a CBO en marzo/abril
// 2026 todos terminaron con $0-5 spend / 7d y 0 purchases. El criterio de
// "ROAS >= 5x + 3 purchases en testing" no predice performance en CBO.
// Los graduates deben probar 21+ dias en ABO produccion antes de ser considerados.

const FAST_TRACK_MIN_ROAS = 5.0;      // Deprecated
const FAST_TRACK_MIN_PURCHASES = 3;    // Deprecated
const FAST_TRACK_LOOKBACK_HOURS = 12;  // Deprecated
const FAST_TRACK_MAX_PER_CYCLE = 2;    // Deprecated

async function processFastTrackGraduates(aresCampaignId) {
  if (FAST_TRACK_DISABLED) {
    logger.debug('[ARES] Fast-track disabled (100% fail rate — graduates go via normal 21d ABO path).');
    return { tracked: 0, results: [], disabled: true };
  }
  // Codigo legacy preservado abajo por si se reactiva en el futuro tras cambiar criterios
  const TestRun = require('../../db/models/TestRun');

  const lookback = new Date(Date.now() - FAST_TRACK_LOOKBACK_HOURS * 3600000);
  const recentGrads = await TestRun.find({
    phase: 'graduated',
    graduated_at: { $gte: lookback }
  }).lean();

  if (recentGrads.length === 0) return { tracked: 0, results: [] };

  // Filtrar por umbral alto
  const qualifying = recentGrads.filter(t => {
    const m = t.metrics || {};
    return (m.roas || 0) >= FAST_TRACK_MIN_ROAS && (m.purchases || 0) >= FAST_TRACK_MIN_PURCHASES;
  });

  if (qualifying.length === 0) return { tracked: 0, results: [] };

  // Excluir los que ya fueron fast-tracked o duplicados
  const results = [];
  let tracked = 0;

  for (const test of qualifying) {
    if (tracked >= FAST_TRACK_MAX_PER_CYCLE) break;

    const adsetId = test.test_adset_id;
    if (!adsetId) continue;

    // Verificar si ya fue clonado (fast-track o normal)
    const alreadyCloned = await ActionLog.findOne({
      entity_id: adsetId,
      action: { $in: ['duplicate_adset', 'fast_track_duplicate'] },
      agent_type: 'ares_agent',
      success: true
    }).lean();

    if (alreadyCloned) {
      logger.debug(`[ARES] Fast-track: ${test.test_adset_name} ya fue clonado — skip`);
      continue;
    }

    // Obtener snapshot para metricas actuales
    const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: adsetId }).sort({ created_at: -1 }).lean();
    if (!snap || snap.status !== 'ACTIVE') continue;

    const m = test.metrics || {};
    const candidate = {
      entity_id: adsetId,
      entity_name: test.test_adset_name || snap.entity_name || adsetId,
      roas_7d: m.roas || 0,
      spend_7d: m.spend || 0,
      frequency: snap.metrics?.last_7d?.frequency || 0,
      daily_budget: snap.daily_budget || 10,
      purchases_7d: m.purchases || 0,
      cpa_7d: m.purchases > 0 ? Math.round(m.spend / m.purchases * 100) / 100 : 0,
      clone_number: 1
    };

    try {
      const result = await duplicateWinner(candidate, aresCampaignId);
      tracked++;

      // Registrar como fast_track_duplicate (distinto de duplicate_adset normal)
      await ActionLog.create({
        entity_type: 'adset',
        entity_id: adsetId,
        entity_name: candidate.entity_name,
        action: 'fast_track_duplicate',
        before_value: candidate.daily_budget,
        after_value: result.clone_name,
        new_entity_id: result.new_adset_id,
        target_entity_id: aresCampaignId,
        reasoning: `Fast-track: ROAS ${candidate.roas_7d.toFixed(2)}x, ${candidate.purchases_7d} compras — graduado directo a CBO.`,
        confidence: 'high',
        agent_type: 'ares_agent',
        success: true,
        executed_at: new Date(),
        metrics_at_execution: {
          roas: candidate.roas_7d,
          spend: candidate.spend_7d,
          purchases: candidate.purchases_7d,
          cpa: candidate.cpa_7d
        }
      });

      logger.info(`[ARES] FAST-TRACK: "${candidate.entity_name}" (${candidate.roas_7d.toFixed(2)}x, ${candidate.purchases_7d} compras) → "${result.clone_name}"`);
      results.push({ type: 'fast_track', original: candidate.entity_name, clone_name: result.clone_name, roas: candidate.roas_7d, purchases: candidate.purchases_7d, success: true });
    } catch (err) {
      logger.error(`[ARES] Fast-track error "${candidate.entity_name}": ${err.message}`);
      results.push({ type: 'fast_track', original: candidate.entity_name, error: err.message, success: false });
    }
  }

  return { tracked, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETIREMENT: pausa ad sets que fallaron su "segunda oportunidad" en CBO 3
// ═══════════════════════════════════════════════════════════════════════════════
// Principio: CBO 3 es el tier de rescate/medicion. Los clones que NO rinden ahi
// con delivery garantizado son confirmados como ruido y se pausan.
// IMPORTANTE: esto solo toca CBO 3. NUNCA pausa clones de CBO 1 o CBO 2.
// Si el usuario decidió dejar los starved en CBO 1/2 dormant, Ares respeta eso.

const CBO3_RETIREMENT_MIN_DAYS = 14;        // Edad minima en CBO 3 antes de considerar pause
const CBO3_RETIREMENT_MIN_ROAS = 1.5;       // ROAS bajo el cual se pausa
const CBO3_RETIREMENT_MIN_SPEND = 50;       // Spend minimo acumulado para que el kill sea informado
const CBO3_CAMPAIGN_PATTERN = /Medicion|Segunda Oportunidad|UCI|CBO 3/i;

async function retireFromCBO3() {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const results = [];

  try {
    const allSnapshots = await getLatestSnapshots('adset');
    const cbo3Snaps = allSnapshots.filter(s => {
      if (s.status !== 'ACTIVE') return false;
      const campName = (s.campaign_name || '');
      return CBO3_CAMPAIGN_PATTERN.test(campName);
    });

    if (cbo3Snaps.length === 0) {
      return { evaluated: 0, retired: 0, results: [] };
    }

    // Safety: si el portfolio entero tiene 0 spend hoy (billing freeze / auth issue),
    // el "abandono aparente" puede ser externo, no del ad set. Skip retirement.
    const activeSnapshots = allSnapshots.filter(s => s.status === 'ACTIVE');
    const portfolioSpendToday = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.today?.spend || 0), 0);
    const avgDaily7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0) / 7;
    if (avgDaily7d > 100 && portfolioSpendToday < avgDaily7d * 0.15) {
      logger.warn(`[ARES] Retirement SKIP — portfolio spend today $${Math.round(portfolioSpendToday)} vs avg 7d $${Math.round(avgDaily7d)}/día (posible billing freeze). No retirar ad sets durante freeze externo.`);
      return { evaluated: cbo3Snaps.length, retired: 0, results: [], skipped_reason: 'portfolio_freeze' };
    }

    logger.info(`[ARES] Retirement scan: ${cbo3Snaps.length} ad sets en CBO 3`);

    for (const snap of cbo3Snaps) {
      if (!snap.meta_created_time) continue;
      const ageDays = (Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000;

      // Proteccion: nunca pausar <14d de edad real en CBO 3
      if (ageDays < CBO3_RETIREMENT_MIN_DAYS) continue;

      const m7d = snap.metrics?.last_7d || {};
      const m14d = snap.metrics?.last_14d || {};
      const roas = m7d.roas || 0;
      const spend = m7d.spend || 0;
      const spend14d = m14d.spend || 0;
      const purchases14d = m14d.purchases || 0;

      // Criterios de retirement
      // (a) Bleeder: spend 7d >= $50 Y ROAS 7d < 1.5x sostenido
      // (b) Confirmed dead: spend acumulado 14d < $20 Y 0 purchases 14d
      //     (Meta lo abandono incluso con delivery garantizado; usamos 14d para
      //     evitar falsos positivos por volatilidad de ventana 7d o starvation reciente)
      const isBleeder = spend >= CBO3_RETIREMENT_MIN_SPEND && roas < CBO3_RETIREMENT_MIN_ROAS;
      const isConfirmedDead = ageDays >= CBO3_RETIREMENT_MIN_DAYS && spend14d < 20 && purchases14d === 0;

      if (!isBleeder && !isConfirmedDead) continue;

      const reason = isBleeder
        ? `CBO 3 retirement: bleeder — ROAS ${roas.toFixed(2)}x con $${spend.toFixed(0)} spend 7d (14d+ edad, delivery garantizado)`
        : `CBO 3 retirement: confirmed dead — $${spend14d.toFixed(0)} spend acumulado 14d, 0 purchases 14d despues de ${Math.round(ageDays)}d`;

      logger.info(`[ARES] Retiring "${snap.entity_name}": ${reason}`);

      try {
        await meta.updateStatus(snap.entity_id, 'PAUSED');

        await ActionLog.create({
          entity_type: 'adset',
          entity_id: snap.entity_id,
          entity_name: snap.entity_name,
          campaign_id: snap.campaign_id,
          campaign_name: snap.campaign_name,
          action: 'pause',
          before_value: 'ACTIVE',
          after_value: 'PAUSED',
          reasoning: reason,
          confidence: 'high',
          agent_type: 'ares_agent',
          success: true,
          metrics_at_execution: {
            roas_7d: roas,
            spend_7d: spend,
            purchases_7d: m7d.purchases || 0,
            daily_budget: snap.daily_budget || 0
          }
        });

        results.push({ entity_id: snap.entity_id, name: snap.entity_name, reason, success: true });
      } catch (err) {
        logger.error(`[ARES] Error retiring ${snap.entity_id}: ${err.message}`);
        results.push({ entity_id: snap.entity_id, success: false, error: err.message });
      }
    }

    const ok = results.filter(r => r.success).length;
    if (ok > 0) logger.info(`[ARES] Retirement: ${ok} ad sets pausados en CBO 3`);

    return { evaluated: cbo3Snaps.length, retired: ok, results };
  } catch (err) {
    logger.warn(`[ARES] Error en retirement loop (non-fatal): ${err.message}`);
    return { evaluated: 0, retired: 0, results: [], error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN ARES AGENT
// ═══════════════════════════════════════════════════════════════════════════════
async function runAresAgent() {
  const startTime = Date.now();
  const cycleId = `ares_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Ares Agent [${cycleId}] ═══`);

  // Fase -2: Platform circuit breaker — si Meta está degradada, no duplicamos
  try {
    const { isDegraded } = require('../../safety/platform-circuit-breaker');
    const platform = await isDegraded();
    if (platform.degraded) {
      logger.warn(`[ARES] Cycle SKIP — plataforma degradada: ${platform.reason}`);
      return {
        skipped: true,
        reason: `platform_degraded: ${platform.reason}`,
        elapsed: '0s',
        cycle_id: cycleId
      };
    }
  } catch (err) {
    logger.warn(`[ARES] platform circuit breaker check falló, continúo: ${err.message}`);
  }

  // Fase -1: Chequear directivas 'avoid' activas de Zeus (ej billing freeze)
  try {
    const { isAgentBlocked } = require('../zeus/directive-guard');
    const block = await isAgentBlocked('ares');
    if (block.blocked) {
      logger.info(`[ARES] Cycle SKIP por directiva de Zeus: "${block.reason}"${block.expires_at ? ` (expira ${new Date(block.expires_at).toISOString()})` : ''}`);
      return {
        skipped: true,
        reason: block.reason,
        directive_id: block.directive_id,
        elapsed: '0s',
        cycle_id: cycleId
      };
    }
  } catch (err) {
    logger.warn(`[ARES] directive-guard check falló, continúo: ${err.message}`);
  }

  // Fase 0: Portfolio capacity — si hit limits, skip duplications (solo para este ciclo)
  let capacityBlocked = false;
  try {
    const { canExecuteAction } = require('../zeus/portfolio-capacity');
    const cap = await canExecuteAction('duplicate_adset');
    if (!cap.allowed) {
      logger.warn(`[ARES] Duplications SKIP por capacidad: ${cap.reason}`);
      capacityBlocked = true;
    }
  } catch (err) {
    logger.warn(`[ARES] capacity check falló, continúo: ${err.message}`);
  }
  if (capacityBlocked) {
    return {
      skipped: true,
      reason: 'portfolio_capacity_limit',
      elapsed: '0s',
      cycle_id: cycleId
    };
  }

  // Fase 0.5: CBO Health observation + Portfolio analysis propose-only.
  // Fase 1 del plan: solo lee snapshots y loggea.
  // Fase 2+3A (adelantada 2026-04-23): corre detectores que generan
  // BrainRecommendations pending (propose-only) sobre starved winners,
  // underperformers, saturation, starvation. NINGUNO ejecuta autónomo — el
  // creador aprueba en el panel. Ver src/ai/agent/ares-portfolio-manager.js.
  let cboSnapsCache = null;  // cache para el gate de duplicación más abajo
  try {
    const { runPortfolioAnalysis } = require('./ares-portfolio-manager');
    const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');

    const recentCBOs = await CBOHealthSnapshot.aggregate([
      { $match: { snapshot_at: { $gte: new Date(Date.now() - 3 * 3600000) } } },
      { $sort: { campaign_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } }
    ]);
    cboSnapsCache = recentCBOs;

    if (recentCBOs.length > 0) {
      const zombies = recentCBOs.filter(s => s.is_zombie).length;
      const collapsing = recentCBOs.filter(s => s.collapse_detected).length;
      const saturating = recentCBOs.filter(s =>
        s.concentration_index_3d >= 0.7 && s.favorite_roas_7d >= 2.5 && !s.favorite_declining
      ).length;
      logger.info(`[ARES] CBO health: ${recentCBOs.length} CBOs · zombies=${zombies} · colapsando=${collapsing} · saturando=${saturating}`);

      // Run portfolio analysis — genera BrainRecommendations pending
      const analysis = await runPortfolioAnalysis();
      logger.info(`[ARES] Portfolio analysis: ${analysis.recs_created} recs propuestas (${JSON.stringify(analysis.by_detector)})`);
    } else {
      logger.info('[ARES] CBO health: sin snapshots recientes, skip portfolio analysis');
    }
  } catch (err) {
    logger.warn(`[ARES] CBO health + portfolio analysis falló (no crítico): ${err.message}`);
  }

  // Fase 1: Obtener o crear campana Ares
  let aresCampaignId;
  try {
    aresCampaignId = await getAresCampaignId();
  } catch (err) {
    logger.error(`[ARES] Error obteniendo campana Ares: ${err.message}`);
    return { duplicated: 0, candidates: 0, elapsed: '0s', cycle_id: cycleId, error: err.message };
  }

  // Obtener CBO 2 para nuevos clones
  let aresCampaign2Id;
  try {
    aresCampaign2Id = await getAresCampaign2Id();
  } catch (err) {
    aresCampaign2Id = aresCampaignId; // fallback a CBO 1
  }
  const isUsingCbo2 = aresCampaign2Id !== aresCampaignId;
  if (isUsingCbo2) logger.info(`[ARES] Nuevos clones iran a CBO 2: ${aresCampaign2Id}`);

  // Fase 0: Procesar directivas de Zeus (force_duplicate, pause_clone, adjust)
  // Directivas de adjust budget se aplican a CBO 1 (la principal)
  let zeusResults = { processed: 0, results: [] };
  try {
    zeusResults = await processZeusDirectives(aresCampaignId);
    if (zeusResults.processed > 0) {
      logger.info(`[ARES] ${zeusResults.processed} directivas de Zeus procesadas`);
    }
  } catch (err) {
    logger.error(`[ARES] Error procesando directivas de Zeus: ${err.message}`);
  }

  // Fase 0.5: Fast-track — DESACTIVADO (abril 2026, 100% fail rate)
  let fastTrackResults = { tracked: 0, results: [], disabled: true };
  try {
    fastTrackResults = await processFastTrackGraduates(aresCampaign2Id);
  } catch (err) {
    logger.error(`[ARES] Error en fast-track: ${err.message}`);
  }

  // Fase 0.7: Retirement — pausar ad sets en CBO 3 que fallaron segunda oportunidad
  let retirementResults = { evaluated: 0, retired: 0, results: [] };
  try {
    retirementResults = await retireFromCBO3();
  } catch (err) {
    logger.error(`[ARES] Error en retirement: ${err.message}`);
  }

  // Fase 1: Encontrar candidatos (duplicacion autonoma)
  const candidates = await findDuplicationCandidates();
  logger.info(`[ARES] ${candidates.length} candidatos encontrados para duplicacion`);

  if (candidates.length === 0) {
    const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    logger.info(`═══ Ares Agent completado [${cycleId}]: 0 candidatos — ${elapsed} ═══`);

    // Reportar a Zeus
    try {
      const ZeusConversation = require('../../db/models/ZeusConversation');
      await ZeusConversation.create({
        from: 'ares', to: 'zeus', type: 'report',
        message: `Ciclo completado: 0 candidatos para duplicacion. Requisitos: ROAS >= ${DUPLICATE_MIN_ROAS}x 7d, freq < ${DUPLICATE_MAX_FREQUENCY}, $${DUPLICATE_MIN_SPEND}+ spend, ${DUPLICATE_MIN_DAYS}+ dias.`,
        cycle_id: cycleId,
        context: { candidates: 0, duplicated: 0, requirements: { min_roas: DUPLICATE_MIN_ROAS, min_spend: DUPLICATE_MIN_SPEND, min_days: DUPLICATE_MIN_DAYS, max_freq: DUPLICATE_MAX_FREQUENCY } }
      });
    } catch (_) {}

    return { duplicated: 0, candidates: 0, elapsed, cycle_id: cycleId };
  }

  // Fase 3: Duplicar a CBO 2 (max MAX_DUPLICATES_PER_CYCLE por ciclo)
  const toDuplicate = candidates.slice(0, MAX_DUPLICATES_PER_CYCLE);
  let duplicated = 0;
  const results = [];

  for (const candidate of toDuplicate) {
    try {
      const result = await duplicateWinner(candidate, aresCampaign2Id);
      duplicated++;
      results.push(result);
      logger.info(`[ARES] ✓ Duplicado: "${result.original}" → "${result.clone_name}" (ROAS ${result.roas.toFixed(2)}x)`);
    } catch (err) {
      logger.error(`[ARES] Error duplicando ${candidate.entity_name}: ${err.message}`);
      results.push({ success: false, original: candidate.entity_name, error: err.message });
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Ares Agent completado [${cycleId}]: ${duplicated} duplicados de ${candidates.length} candidatos — ${elapsed} ═══`);

  // Reportar a Zeus con inteligencia
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');
    let msg = `Ciclo completado: ${duplicated} ad sets duplicados a campana Ares de ${candidates.length} candidatos.`;

    // Reportar fast-tracks
    if (fastTrackResults.tracked > 0) {
      msg += `\n\nFAST-TRACK (${fastTrackResults.tracked} graduados directo a CBO):`;
      fastTrackResults.results.filter(r => r.success).forEach(r => {
        msg += `\n  - "${r.original}" ROAS ${r.roas.toFixed(2)}x ${r.purchases} compras → "${r.clone_name}"`;
      });
    }

    // Reportar directivas de Zeus procesadas
    if (zeusResults.processed > 0) {
      msg += `\n\nDIRECTIVAS DE ZEUS PROCESADAS (${zeusResults.processed}):`;
      zeusResults.results.forEach(r => {
        if (r.type === 'force_duplicate' && r.success) msg += `\n  - FORCE_DUPLICATE: "${r.original}" → "${r.clone_name}"`;
        else if (r.type === 'pause_clone') msg += `\n  - PAUSE_CLONE: ${r.adset_id} pausado`;
        else if (r.type === 'adjust_cbo_budget') msg += `\n  - ADJUST CBO: $${r.old_budget} → $${r.new_budget}/dia`;
        else if (r.acknowledged) msg += `\n  - ${r.type.toUpperCase()}: "${r.directive}" — acknowledged`;
        else if (r.error) msg += `\n  - ${r.type.toUpperCase()}: ERROR — ${r.error}`;
      });
    }

    if (duplicated > 0) {
      msg += '\n\nDUPLICADOS:';
      results.filter(r => r.success).forEach(r => {
        msg += `\n  - "${r.original}" ROAS ${r.roas.toFixed(2)}x → "${r.clone_name}" (clone ${r.clone_number})`;
      });
    }

    const skipped = candidates.length - toDuplicate.length;
    if (skipped > 0) {
      msg += `\n\n${skipped} candidatos adicionales no duplicados este ciclo (max ${MAX_DUPLICATES_PER_CYCLE}/ciclo). Proximo ciclo.`;
    }

    if (candidates.length > duplicated) {
      msg += '\n\nCANDIDATOS PENDIENTES:';
      candidates.slice(toDuplicate.length).forEach(c => {
        msg += `\n  - "${c.entity_name}" ROAS ${c.roas_7d.toFixed(2)}x, ${c.purchases_7d} compras`;
      });
    }

    await ZeusConversation.create({
      from: 'ares', to: 'zeus', type: 'report',
      message: msg, cycle_id: cycleId,
      context: {
        candidates: candidates.length,
        duplicated,
        results: results.map(r => ({
          original: r.original,
          clone_name: r.clone_name || null,
          new_adset_id: r.new_adset_id || null,
          roas: r.roas || 0,
          success: r.success
        }))
      }
    });
  } catch (reportErr) {
    logger.warn(`[ARES] Error reportando a Zeus: ${reportErr.message}`);
  }

  return {
    duplicated,
    fast_tracked: fastTrackResults.tracked,
    candidates: candidates.length,
    results,
    fast_track_results: fastTrackResults.results,
    zeus_directives: zeusResults,
    elapsed,
    cycle_id: cycleId
  };
}

module.exports = { runAresAgent };
