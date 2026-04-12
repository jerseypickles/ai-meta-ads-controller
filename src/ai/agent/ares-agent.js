const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const { getLatestSnapshots } = require('../../db/queries');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURACION — Ares: Agente de Duplicacion (5to agente)
// Procedural. Duplica ganadores a campana ABO con budget sharing.
// ═══════════════════════════════════════════════════════════════════════════════
const DUPLICATE_MIN_ROAS = 4.0;        // ROAS 7d minimo para duplicar
const DUPLICATE_MIN_DAYS = 7;          // Edad minima del ad set (dias)
const DUPLICATE_MIN_SPEND = 100;       // Spend 7d minimo ($)
const DUPLICATE_MAX_FREQUENCY = 2.0;   // Frequency maxima (no saturado)
const MAX_DUPLICATES_PER_CONCEPT = 2;  // Max clones por ad set original
const MIN_DAYS_BETWEEN_DUPLICATES = 7; // Dias minimos entre duplicaciones del mismo original
const CLONE_DAILY_BUDGET = 30;         // Budget diario de cada clon ($30/dia)
const MAX_DUPLICATES_PER_CYCLE = 3;    // Max duplicaciones por ciclo (evitar avalancha)

// Patrones a excluir de duplicacion
const EXCLUDE_PATTERNS = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'DONT_TOUCH', 'EXCLUDE', 'MANUAL ONLY'];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtener o crear la campana ABO de Ares.
 * Campana ABO con is_adset_budget_sharing_enabled (Meta comparte hasta 20% entre ad sets).
 * Cada clon tiene su propio budget ($30/dia).
 */
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

  logger.info('[ARES] Creando campana ABO con budget sharing para duplicados...');
  const result = await meta.createCampaign({
    name: '[ARES] Duplicados Ganadores',
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    is_adset_budget_sharing_enabled: true
    // Sin daily_budget a nivel de campana — cada ad set tiene su propio budget (ABO)
  });

  const campaignId = result.campaign_id;
  await SystemConfig.set('ares_campaign_id', campaignId, 'ares_agent');
  logger.info(`[ARES] Campana ABO creada: ${campaignId} — cada clon tendra $${CLONE_DAILY_BUDGET}/dia`);

  return campaignId;
}

/**
 * Buscar ad sets candidatos para duplicacion.
 * Criterios: ROAS >= 4x (7d), freq < 2.0, $100+ spend, 7+ dias, max 2 duplicados.
 */
async function findDuplicationCandidates() {
  const allSnapshots = await getLatestSnapshots('adset');

  // Filtrar activos, no excluidos
  const active = allSnapshots.filter(s => {
    if (s.status !== 'ACTIVE') return false;
    const name = (s.entity_name || '').toUpperCase();
    return !EXCLUDE_PATTERNS.some(ex => name.includes(ex.toUpperCase()));
  });

  // Filtrar por criterios de performance
  const candidates = [];
  for (const snap of active) {
    const m7d = snap.metrics?.last_7d || {};
    const roas7d = m7d.roas || 0;
    const spend7d = m7d.spend || 0;
    const freq = m7d.frequency || 0;

    // Criterios de performance
    if (roas7d < DUPLICATE_MIN_ROAS) continue;
    if (spend7d < DUPLICATE_MIN_SPEND) continue;
    if (freq >= DUPLICATE_MAX_FREQUENCY) continue;

    // Edad minima
    if (snap.meta_created_time) {
      const daysOld = (Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000;
      if (daysOld < DUPLICATE_MIN_DAYS) continue;
    }

    candidates.push({
      entity_id: snap.entity_id,
      entity_name: snap.entity_name || snap.entity_id,
      roas_7d: roas7d,
      spend_7d: spend7d,
      frequency: freq,
      daily_budget: snap.daily_budget || 0,
      purchases_7d: m7d.purchases || 0,
      cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0
    });
  }

  // Verificar historial de duplicaciones — excluir ya duplicados 2x o <7 dias
  const filteredCandidates = [];
  for (const c of candidates) {
    const prevDups = await ActionLog.find({
      action: 'duplicate_adset',
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
 */
async function duplicateWinner(candidate, aresCampaignId) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  const cloneName = `[Ares] ${candidate.entity_name} — Clone ${candidate.clone_number}`;

  logger.info(`[ARES] Duplicando "${candidate.entity_name}" (ROAS ${candidate.roas_7d.toFixed(2)}x) → "${cloneName}"`);

  // Paso 1: Copiar ad set SIN ads (deep_copy: false — Meta limita copies sincronas a <3 objetos)
  const result = await meta.duplicateAdSet(candidate.entity_id, {
    campaign_id: aresCampaignId,
    deep_copy: false,
    name: cloneName,
    status: 'PAUSED',
    daily_budget: CLONE_DAILY_BUDGET
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

  // Paso 3: Activar el clon
  try {
    await meta.post(`/${result.new_adset_id}`, { status: 'ACTIVE' });
    logger.info(`[ARES] Clon ${result.new_adset_id} activado a $${CLONE_DAILY_BUDGET}/dia`);
  } catch (activateErr) {
    logger.warn(`[ARES] Clon creado (${result.new_adset_id}) pero error activando: ${activateErr.message}`);
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
// MAIN: RUN ARES AGENT
// ═══════════════════════════════════════════════════════════════════════════════
async function runAresAgent() {
  const startTime = Date.now();
  const cycleId = `ares_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Ares Agent [${cycleId}] ═══`);

  // Fase 1: Obtener o crear campana Ares
  let aresCampaignId;
  try {
    aresCampaignId = await getAresCampaignId();
  } catch (err) {
    logger.error(`[ARES] Error obteniendo campana Ares: ${err.message}`);
    return { duplicated: 0, candidates: 0, elapsed: '0s', cycle_id: cycleId, error: err.message };
  }

  // Fase 2: Encontrar candidatos
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

  // Fase 3: Duplicar (max MAX_DUPLICATES_PER_CYCLE por ciclo)
  const toDuplicate = candidates.slice(0, MAX_DUPLICATES_PER_CYCLE);
  let duplicated = 0;
  const results = [];

  for (const candidate of toDuplicate) {
    try {
      const result = await duplicateWinner(candidate, aresCampaignId);
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
    candidates: candidates.length,
    results,
    elapsed,
    cycle_id: cycleId
  };
}

module.exports = { runAresAgent };
