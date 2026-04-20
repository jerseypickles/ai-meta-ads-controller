const CreativeDNA = require('../../db/models/CreativeDNA');
const SystemConfig = require('../../db/models/SystemConfig');
const logger = require('../../utils/logger');
const { computeDNAHash, STYLES, ANGLES, HOOK_TYPES } = require('./dna-helper');

/**
 * Evolution Engine — selecciona / muta / cruza DNAs para Apollo evolutivo.
 *
 * Fase 2 del Creative DNA system. Apollo llama aqui cuando decide generar
 * un creativo "evolucionario" (vs random). La engine retorna un DNA concreto
 * que Apollo usa para elegir dimensiones de generacion.
 *
 * Estrategias:
 *  - EXPLOIT: sample desde top-performing DNAs (explota ganadores probados)
 *  - MUTATE:  toma un winner, cambia 1 dimension al azar (explora vecindad)
 *  - CROSSOVER: combina 2 winners (fusion genetica)
 *  - EXPLORE: DNA random (mantiene diversidad, anti-colapso)
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACION — defaults tuneables via SystemConfig
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  // Proporciones de estrategias (deben sumar 1.0)
  exploit_ratio: 0.6,
  mutate_ratio: 0.25,
  crossover_ratio: 0.15,
  explore_ratio: 0.0,

  // Umbrales de elegibilidad
  min_samples_for_exploit: 3,      // DNA necesita 3+ tests para ser exploit target
  min_samples_for_parent: 2,       // mutation/crossover necesita al menos 2 samples
  min_roas_for_winner: 3.0,        // ROAS minimo para ser "winner" elegible
  max_age_days_for_winner: 60,     // DNAs mas viejos pierden elegibilidad

  // Diversidad (anti-colapso)
  diversity_floor: 0.3,            // min 30% de tests deben usar explore/random

  // Scoring
  fitness_score_weights: {
    roas: 0.5,              // peso del avg_roas
    confidence: 0.3,        // peso del sample_confidence (evita DNAs ruidosos)
    recency: 0.2            // peso de recencia (DNAs recientes valen mas)
  }
};

async function loadConfig() {
  const stored = await SystemConfig.get('apollo_evolution_config', {});
  return { ...DEFAULT_CONFIG, ...stored };
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE FLAG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Retorna el ratio actual de evolution en Apollo (0.0 - 1.0).
 * 0.0 = Apollo random (comportamiento legacy)
 * 0.2 = 20% de generaciones usan evolution
 * 1.0 = 100% evolution
 */
async function getEvolutionRatio() {
  const ratio = await SystemConfig.get('apollo_evolution_ratio', 0.0);
  const r = parseFloat(ratio) || 0;
  return Math.max(0, Math.min(1, r));
}

/**
 * Determina si esta generacion particular debe ser evolutiva.
 * Usa sampling probabilistico + floor de diversidad.
 */
async function shouldEvolveThisGeneration() {
  const ratio = await getEvolutionRatio();
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  return Math.random() < ratio;
}

// ═══════════════════════════════════════════════════════════════════════════
// FITNESS SCORING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score compuesto de un DNA para ranking/sampling.
 * Combina ROAS + confidence + recency.
 */
function computeFitnessScore(dna, config) {
  const f = dna.fitness || {};
  const weights = config.fitness_score_weights;

  // Normalizar ROAS (clipping at 10x para no dar demasiado peso a outliers con 1 sample)
  const roasNorm = Math.min(1, (f.avg_roas || 0) / 10);

  // Confidence ya esta 0-1
  const confNorm = f.sample_confidence || 0;

  // Recency: DNAs tested en ultimos 14d = 1.0, decay lineal a 0 en 60d
  let recencyNorm = 0;
  if (f.last_test_at) {
    const ageDays = (Date.now() - new Date(f.last_test_at).getTime()) / 86400000;
    recencyNorm = Math.max(0, 1 - (ageDays / 60));
  }

  return (weights.roas * roasNorm) + (weights.confidence * confNorm) + (weights.recency * recencyNorm);
}

// ═══════════════════════════════════════════════════════════════════════════
// ESTRATEGIAS DE GENERACION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * EXPLOIT — sample weighted por fitness score desde top DNAs ganadores.
 * Retorna el DNA completo (dimensions + hash).
 */
async function exploitSample(config) {
  const candidates = await CreativeDNA.find({
    'fitness.tests_total': { $gte: config.min_samples_for_exploit },
    'fitness.avg_roas': { $gte: config.min_roas_for_winner }
  }).lean();

  if (candidates.length === 0) {
    logger.debug('[EVOLUTION] No exploit candidates — fallback a explore');
    return null;
  }

  // Weighted random por fitness score
  const scored = candidates.map(d => ({
    dna: d,
    score: computeFitnessScore(d, config)
  }));
  const totalScore = scored.reduce((s, x) => s + x.score, 0);
  if (totalScore <= 0) return null;

  let pick = Math.random() * totalScore;
  for (const { dna, score } of scored) {
    pick -= score;
    if (pick <= 0) {
      return { strategy: 'exploit', source_dna: dna, dimensions: dna.dimensions, rationale: `Exploit ${dna.dna_hash.substring(0, 30)}: ${dna.fitness.avg_roas}x ROAS, ${dna.fitness.tests_total} samples` };
    }
  }
  const last = scored[scored.length - 1].dna;
  return { strategy: 'exploit', source_dna: last, dimensions: last.dimensions, rationale: `Exploit fallback` };
}

/**
 * MUTATE — toma un parent winner, cambia 1 dimension al azar.
 * Retorna DNA nuevo (no existe necesariamente en DB aun).
 */
async function mutateFrom(parentOverride, config) {
  let parent = parentOverride;

  if (!parent) {
    const candidates = await CreativeDNA.find({
      'fitness.tests_total': { $gte: config.min_samples_for_parent },
      'fitness.avg_roas': { $gte: config.min_roas_for_winner }
    }).sort({ 'fitness.avg_roas': -1 }).limit(20).lean();

    if (candidates.length === 0) return null;
    parent = candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Elegir cual dimension mutar (random)
  const dimKeys = ['scene', 'style', 'copy_angle', 'product', 'hook_type'];
  const mutateDim = dimKeys[Math.floor(Math.random() * dimKeys.length)];

  // Valores posibles por dimension — leer del pool existente (mas natural que hardcoded)
  const allDnas = await CreativeDNA.find({}).select('dimensions').lean();
  const valuePool = {};
  for (const k of dimKeys) valuePool[k] = new Set();
  for (const d of allDnas) {
    for (const k of dimKeys) {
      if (d.dimensions?.[k]) valuePool[k].add(d.dimensions[k]);
    }
  }

  const possibleValues = Array.from(valuePool[mutateDim] || []).filter(v => v !== parent.dimensions[mutateDim]);
  if (possibleValues.length === 0) return null;

  const newValue = possibleValues[Math.floor(Math.random() * possibleValues.length)];

  const mutatedDims = { ...parent.dimensions, [mutateDim]: newValue };
  return {
    strategy: 'mutate',
    source_dna: parent,
    mutated_dimension: mutateDim,
    dimensions: mutatedDims,
    rationale: `Mutate parent ${parent.dna_hash.substring(0, 30)} (${parent.fitness.avg_roas}x) changing ${mutateDim}: ${parent.dimensions[mutateDim]} → ${newValue}`
  };
}

/**
 * CROSSOVER — toma 2 winners, combina dimensions 50/50.
 * Retorna DNA hybrid nuevo.
 */
async function crossoverFrom(config) {
  const candidates = await CreativeDNA.find({
    'fitness.tests_total': { $gte: config.min_samples_for_parent },
    'fitness.avg_roas': { $gte: config.min_roas_for_winner }
  }).sort({ 'fitness.avg_roas': -1 }).limit(20).lean();

  if (candidates.length < 2) return null;

  const parent1 = candidates[Math.floor(Math.random() * candidates.length)];
  const parent2 = candidates.filter(d => d.dna_hash !== parent1.dna_hash)[Math.floor(Math.random() * (candidates.length - 1))];
  if (!parent2) return null;

  // Para cada dimension, elegir random de cual padre hereda
  const dimKeys = ['scene', 'style', 'copy_angle', 'product', 'hook_type'];
  const childDims = {};
  for (const k of dimKeys) {
    childDims[k] = Math.random() < 0.5 ? parent1.dimensions[k] : parent2.dimensions[k];
  }

  // Si child es identico a parent1 o parent2, forzar al menos 1 dim del otro
  if (JSON.stringify(childDims) === JSON.stringify(parent1.dimensions)) {
    const forceK = dimKeys[Math.floor(Math.random() * dimKeys.length)];
    childDims[forceK] = parent2.dimensions[forceK];
  } else if (JSON.stringify(childDims) === JSON.stringify(parent2.dimensions)) {
    const forceK = dimKeys[Math.floor(Math.random() * dimKeys.length)];
    childDims[forceK] = parent1.dimensions[forceK];
  }

  return {
    strategy: 'crossover',
    source_dnas: [parent1, parent2],
    dimensions: childDims,
    rationale: `Crossover ${parent1.dna_hash.substring(0, 20)} × ${parent2.dna_hash.substring(0, 20)} (${parent1.fitness.avg_roas}x × ${parent2.fitness.avg_roas}x)`
  };
}

/**
 * EXPLORE — DNA random del pool existente (no mutation, no parent).
 * Mantiene diversidad, anti-colapso.
 */
async function exploreRandom() {
  // Random DNA del pool — no filtra por fitness
  const totalCount = await CreativeDNA.countDocuments({});
  if (totalCount === 0) return null;

  const skip = Math.floor(Math.random() * totalCount);
  const random = await CreativeDNA.findOne({}).skip(skip).lean();
  if (!random) return null;

  return {
    strategy: 'explore',
    source_dna: null,
    dimensions: random.dimensions,
    rationale: 'Explore random from DNA pool (diversity)'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EVOLUTION DECISION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Elige estrategia segun ratios config + fallback si strategy falla.
 */
function chooseStrategy(config) {
  const roll = Math.random();
  const cumExploit = config.exploit_ratio;
  const cumMutate = cumExploit + config.mutate_ratio;
  const cumCrossover = cumMutate + config.crossover_ratio;

  if (roll < cumExploit) return 'exploit';
  if (roll < cumMutate) return 'mutate';
  if (roll < cumCrossover) return 'crossover';
  return 'explore';
}

/**
 * Main API — Apollo llama esto cuando quiere un DNA evolucionario.
 * Retorna { strategy, dimensions, rationale, source_dnas? } o null si falla.
 */
async function evolveNextDNA(options = {}) {
  try {
    const config = await loadConfig();
    const forcedStrategy = options.strategy;
    const strategy = forcedStrategy || chooseStrategy(config);

    let result = null;
    if (strategy === 'exploit') result = await exploitSample(config);
    else if (strategy === 'mutate') result = await mutateFrom(options.parent, config);
    else if (strategy === 'crossover') result = await crossoverFrom(config);
    else result = await exploreRandom();

    // Fallback chain: si estrategia elegida falla (no hay candidatos), bajar a explore
    if (!result) {
      logger.debug(`[EVOLUTION] ${strategy} failed, falling back to explore`);
      result = await exploreRandom();
    }
    if (!result) return null;

    // Agregar dna_hash del DNA resultante (puede ser nuevo si mutation/crossover)
    if (result.dimensions) {
      result.dna_hash = computeDNAHash(result.dimensions);
    }

    return result;
  } catch (err) {
    logger.warn(`[EVOLUTION] Error in evolveNextDNA: ${err.message}`);
    return null;
  }
}

/**
 * Registra DNA de generacion nueva con linaje (para mutation/crossover).
 * Permite trackear quien es hijo de quien.
 */
async function registerEvolutionaryDNA(evolutionResult) {
  try {
    if (!evolutionResult || !evolutionResult.dna_hash) return;

    const existing = await CreativeDNA.findOne({ dna_hash: evolutionResult.dna_hash });
    if (existing) return; // ya existe, no duplicar

    const parentHashes = [];
    if (evolutionResult.source_dna?.dna_hash) parentHashes.push(evolutionResult.source_dna.dna_hash);
    if (evolutionResult.source_dnas) {
      for (const p of evolutionResult.source_dnas) {
        if (p.dna_hash) parentHashes.push(p.dna_hash);
      }
    }

    const generation = parentHashes.length > 0
      ? Math.max(...(await CreativeDNA.find({ dna_hash: { $in: parentHashes } }).select('generation').lean()).map(d => d.generation || 0)) + 1
      : 0;

    await CreativeDNA.create({
      dna_hash: evolutionResult.dna_hash,
      dimensions: evolutionResult.dimensions,
      fitness: {
        tests_total: 0, tests_graduated: 0, tests_killed: 0, tests_expired: 0,
        total_spend: 0, total_revenue: 0, total_purchases: 0,
        avg_roas: 0, win_rate: 0, avg_cpa: 0,
        last_test_at: null, last_outcome: null, sample_confidence: 0
      },
      generation,
      parent_dnas: parentHashes,
      created_via: evolutionResult.strategy
    });

    logger.debug(`[EVOLUTION] Registered new DNA ${evolutionResult.dna_hash} gen=${generation} via=${evolutionResult.strategy}`);
  } catch (err) {
    logger.warn(`[EVOLUTION] Error registering DNA: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVABILITY — metrics para Fase 4
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entropy del DNA space — mayor entropy = mas diversidad (menor convergencia).
 * Return: { entropy, unique_dnas, dominant_dna_pct, convergence_status }
 */
async function computeDNASpaceMetrics() {
  const allDnas = await CreativeDNA.find({ 'fitness.tests_total': { $gte: 1 } }).lean();
  if (allDnas.length === 0) {
    return { entropy: 0, unique_dnas: 0, dominant_dna_pct: 0, convergence_status: 'no-data' };
  }

  const totalTests = allDnas.reduce((s, d) => s + (d.fitness?.tests_total || 0), 0);
  if (totalTests === 0) return { entropy: 0, unique_dnas: allDnas.length, dominant_dna_pct: 0, convergence_status: 'no-tests' };

  // Shannon entropy de la distribucion de samples
  let entropy = 0;
  for (const d of allDnas) {
    const p = (d.fitness?.tests_total || 0) / totalTests;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // Normalizar — max entropy = log2(N) donde N es cantidad de DNAs
  const maxEntropy = Math.log2(allDnas.length);
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  // Dominant DNA %
  const maxTests = Math.max(...allDnas.map(d => d.fitness?.tests_total || 0));
  const dominantPct = maxTests / totalTests;

  let status;
  if (normalizedEntropy > 0.85) status = 'explorando';
  else if (normalizedEntropy > 0.6) status = 'balanceado';
  else if (normalizedEntropy > 0.4) status = 'convergiendo';
  else status = 'converged';

  return {
    entropy: Math.round(entropy * 100) / 100,
    normalized_entropy: Math.round(normalizedEntropy * 100) / 100,
    unique_dnas: allDnas.length,
    total_tests: totalTests,
    dominant_dna_pct: Math.round(dominantPct * 100),
    convergence_status: status
  };
}

module.exports = {
  getEvolutionRatio,
  shouldEvolveThisGeneration,
  evolveNextDNA,
  registerEvolutionaryDNA,
  computeDNASpaceMetrics,
  computeFitnessScore,
  chooseStrategy,
  DEFAULT_CONFIG
};
