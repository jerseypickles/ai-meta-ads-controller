const CreativeDNA = require('../../db/models/CreativeDNA');

/**
 * DNA Fitness jerárquico — marginal + combo con shrinkage (Pilar A).
 *
 * Problema: el espacio 5D es enorme y casi ningún combo (dna_hash) junta
 * suficientes samples para cruzar el umbral de "winner". El exploit se starvea.
 *
 * Solución (empirical Bayes): el fitness de un combo se ESTIMA mezclando su
 * data propia (rala) con un PRIOR derivado de las marginales de sus dimensiones
 * (que sí tienen volumen):
 *
 *   roas_shrunk(combo) = (n·roas_combo + k·prior) / (n + k)
 *   prior(combo)       = promedio de las marginales shrunk de sus 5 dimensiones
 *   marginal_shrunk(v) = (n_v·roas_v + k_dim·baseline) / (n_v + k_dim)
 *
 * Con n=0 el combo hereda el prior de sus dimensiones (apuesta informada);
 * a medida que junta samples converge a su ROAS observado.
 *
 * Todo en Meta-ROAS crudo (el dato medido). Apollo rankea RELATIVO, que es invariante
 * al haircut de cuenta → no necesita inflar a cash. El cash es lente de display aparte.
 */

const DIM_KEYS = ['scene', 'style', 'copy_angle', 'product', 'hook_type'];
const K_DIM = 4;    // pseudo-cuenta: cuánto encoge una marginal hacia el baseline de cuenta
const K_COMBO = 3;  // pseudo-cuenta: cuánto encoge un combo hacia su prior de dimensiones
const WINNER_PROFIT_FLOOR = 1.8;   // piso absoluto: por debajo de esto no vale la pena escalar
const WINNER_BASELINE_MULT = 1.5;  // un winner debe rendir ≥1.5× el baseline de la cuenta

/**
 * Umbral de "winner" RELATIVO al baseline de la cuenta (Pilar A).
 * En una cuenta a 1.57x cash, exigir 3.0x absoluto starvea el exploit; lo correcto
 * es explotar lo mejor que tenés sobre tu propio promedio, con un piso de rentabilidad.
 *   threshold = max(piso_rentable, baseline × mult)
 */
function winnerThreshold(ctx, config = {}) {
  const floor = config.winner_profit_floor != null ? config.winner_profit_floor : WINNER_PROFIT_FLOOR;
  const mult = config.winner_baseline_mult != null ? config.winner_baseline_mult : WINNER_BASELINE_MULT;
  return Math.max(floor, (ctx.baseline || 1) * mult);
}

/**
 * Construye el contexto de fitness una vez por ciclo de evolución:
 * marginales por (dimensión, valor) + baseline de cuenta.
 */
async function buildFitnessContext() {
  const dnas = await CreativeDNA.find({}).select('dimensions fitness').lean();
  const marg = {};
  for (const k of DIM_KEYS) marg[k] = {};
  let gSpend = 0, gRev = 0, gTests = 0;

  for (const d of dnas) {
    const f = d.fitness || {};
    const sp = f.total_spend || 0, rev = f.total_revenue || 0, n = f.tests_total || 0, g = f.tests_graduated || 0;
    gSpend += sp; gRev += rev; gTests += n;
    for (const k of DIM_KEYS) {
      const v = d.dimensions?.[k];
      if (!v || v === 'unknown') continue;
      const m = marg[k][v] || (marg[k][v] = { spend: 0, rev: 0, n: 0, grad: 0 });
      m.spend += sp; m.rev += rev; m.n += n; m.grad += g;
    }
  }

  const baseline = gSpend > 0 ? gRev / gSpend : 1; // ROAS cash promedio de la cuenta
  for (const k of DIM_KEYS) {
    for (const v in marg[k]) {
      const m = marg[k][v];
      m.roas = m.spend > 0 ? m.rev / m.spend : baseline;
      m.win = m.n > 0 ? m.grad / m.n : 0;
    }
  }
  return { marg, baseline, gTests, dnaCount: dnas.length };
}

/** Marginal de un valor, encogida hacia el baseline por su tamaño de muestra. */
function dimShrunk(m, baseline) {
  if (!m || m.n <= 0) return baseline;
  return (m.n * m.roas + K_DIM * baseline) / (m.n + K_DIM);
}

/** Prior de un combo = promedio de las marginales shrunk de sus 5 dimensiones. */
function priorRoas(dimensions, ctx) {
  let sum = 0;
  for (const k of DIM_KEYS) {
    const v = dimensions?.[k];
    const m = v && v !== 'unknown' ? ctx.marg[k]?.[v] : null;
    sum += dimShrunk(m, ctx.baseline);
  }
  return sum / DIM_KEYS.length;
}

/** ROAS estimado del combo: mezcla su data propia con el prior de dimensiones. */
function shrunkRoas(dna, ctx) {
  const f = dna.fitness || {};
  const n = f.tests_total || 0;
  const roas = f.avg_roas || 0;
  const prior = priorRoas(dna.dimensions, ctx);
  return (n * roas + K_COMBO * prior) / (n + K_COMBO);
}

/**
 * Score compuesto para ranking/sampling: ROAS shrunk (normalizado) + confianza
 * + recencia. Reemplaza al computeFitnessScore crudo de evolution-engine.
 */
function hierarchicalScore(dna, ctx, weights) {
  const f = dna.fitness || {};
  const roasNorm = Math.min(1, shrunkRoas(dna, ctx) / 10);
  const confNorm = f.sample_confidence || 0;
  let recencyNorm = 0;
  if (f.last_test_at) {
    const ageDays = (Date.now() - new Date(f.last_test_at).getTime()) / 86400000;
    recencyNorm = Math.max(0, 1 - ageDays / 60);
  }
  return (weights.roas * roasNorm) + (weights.confidence * confNorm) + (weights.recency * recencyNorm);
}

/** Valores de una dimensión rankeados por su marginal shrunk (mejor → peor). */
function rankDimensionValues(dim, ctx) {
  return Object.entries(ctx.marg[dim] || {})
    .map(([v, m]) => ({ value: v, roas: dimShrunk(m, ctx.baseline), n: m.n }))
    .sort((a, b) => b.roas - a.roas);
}

module.exports = {
  DIM_KEYS,
  buildFitnessContext,
  priorRoas,
  shrunkRoas,
  hierarchicalScore,
  rankDimensionValues,
  winnerThreshold
};
