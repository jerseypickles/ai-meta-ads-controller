// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO LEARNING — el reconciliador del loop de Dionisio.
// Cruza la PREDICCIÓN del juez (video_judge_score + breakdown) contra el OUTCOME
// REAL (enganche de Meta + conversión) → aprende qué pega y calibra:
//   1. ranking de motions por outcome real → directivas para buildVideoPrompt
//   2. calibración del juez: ¿qué dimensión del juez predijo el outcome? → nota
//      que se inyecta al prompt del juez para que afine su criterio
// El loop de SELECCIÓN (pickWeighted por avg_hold/avg_roas + explore) ya existe en
// video-dna.js; esto agrega la capa de PROMPT + JUEZ que faltaba.
// ═══════════════════════════════════════════════════════════════════════════════

const CreativeProposal = require('../../../db/models/CreativeProposal');
const TestRun = require('../../../db/models/TestRun');
const SystemConfig = require('../../../db/models/SystemConfig');
const logger = require('../../../utils/logger');

const LEARNINGS_KEY = 'dionysus_video_learnings';
const SETTLE_MIN_IMPR = 1500;     // señal suficiente para considerar el veredicto "firme"
const MIN_PER_MOTION = 3;         // mínimo de videos por motion para confiar el ranking
const MIN_PAIRS_CORR = 6;         // mínimo de pares para confiar una correlación

const JUDGE_DIMS = ['fidelidad', 'freno_scroll', 'apetito', 'autenticidad', 'calidad'];

// Pearson simple
function corr(pairs) {
  const n = pairs.length; if (n < 3) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y; }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : +(num / den).toFixed(2);
}

// "Pega real" del video = blend de conversión (domina) + enganche (señal temprana).
// Conversión = graduó/mató + ROAS. Enganche = hold (retención) + thumbstop (gancho).
function outcomeScore(status, m = {}) {
  let s = 0;
  if (status === 'graduated') s += 60;
  if (status === 'killed') s -= 15;
  s += Math.min(m.roas || 0, 5) * 8;            // conversión (0-40)
  s += (m.hold_rate || 0) * 100 * 0.5;          // retención (0-~10)
  s += (m.thumbstop_rate || 0) * 100 * 0.15;    // gancho (0-~10) — pesa poco: no discrimina en JP
  return +s.toFixed(1);
}

/**
 * Recalcula los learnings desde todos los videos con outcome. Cron diario.
 */
async function reconcile() {
  const vids = await CreativeProposal.find({
    media_type: 'video', status: { $in: ['testing', 'graduated', 'killed', 'expired'] }
  }).select('motion_variant product_name video_judge_score video_judge_breakdown status').lean();

  if (!vids.length) { logger.info('[VIDEO-LEARNING] sin videos con outcome aún'); return null; }

  const ids = vids.map(v => v._id);
  const runs = await TestRun.find({ proposal_id: { $in: ids } }).select('proposal_id metrics').lean();
  const byProp = {}; for (const t of runs) byProp[String(t.proposal_id)] = t.metrics || {};

  // "firmes": señal suficiente o estado terminal
  const settled = vids.filter(v => {
    const m = byProp[String(v._id)] || {};
    return (m.impressions || 0) >= SETTLE_MIN_IMPR || ['graduated', 'killed', 'expired'].includes(v.status);
  });

  // ── 1. Ranking de motions por outcome real (para inyectar al prompt) ──
  const byMotion = {};
  for (const v of settled) {
    const k = v.motion_variant; if (!k) continue;
    const m = byProp[String(v._id)] || {};
    const a = byMotion[k] || (byMotion[k] = { n: 0, out: 0, hold: 0, grad: 0, kill: 0 });
    a.n++; a.out += outcomeScore(v.status, m); a.hold += (m.hold_rate || 0);
    if (v.status === 'graduated') a.grad++; if (v.status === 'killed') a.kill++;
  }
  const motionRank = Object.entries(byMotion)
    .filter(([, a]) => a.n >= MIN_PER_MOTION)
    .map(([k, a]) => ({ key: k, n: a.n, avg_outcome: +(a.out / a.n).toFixed(1), avg_hold: +(a.hold / a.n * 100).toFixed(0), graduated: a.grad, killed: a.kill }))
    .sort((x, y) => y.avg_outcome - x.avg_outcome);

  // ── 2. Calibración del juez: ¿su score / dimensiones predijeron el outcome? ──
  const scorePairs = settled.filter(v => v.video_judge_score != null)
    .map(v => [v.video_judge_score, outcomeScore(v.status, byProp[String(v._id)] || {})]);
  const score_corr = scorePairs.length >= MIN_PAIRS_CORR ? corr(scorePairs) : null;

  const dimCorr = {};
  for (const d of JUDGE_DIMS) {
    const pairs = settled
      .filter(v => v.video_judge_breakdown?.breakdown?.[d]?.score != null)
      .map(v => [v.video_judge_breakdown.breakdown[d].score, outcomeScore(v.status, byProp[String(v._id)] || {})]);
    dimCorr[d] = pairs.length >= MIN_PAIRS_CORR ? corr(pairs) : null;
  }

  const learnings = {
    generated_at: new Date(),
    settled_count: settled.length,
    motion_rank: motionRank,
    judge: { score_corr, dim_corr: dimCorr }
  };
  await SystemConfig.set(LEARNINGS_KEY, learnings, 'video_learning');
  logger.info(`[VIDEO-LEARNING] reconciliado: ${settled.length} firmes · top motion ${motionRank[0]?.key || '—'} · juez score_corr ${score_corr ?? 'n/a'}`);
  return learnings;
}

async function _get() { try { return await SystemConfig.get(LEARNINGS_KEY, null); } catch { return null; } }

/**
 * Directiva aprendida para inyectar en buildVideoPrompt según el motion elegido.
 * Devuelve '' si no hay data suficiente (no inventa).
 */
async function getPromptLearning(motionKey) {
  const L = await _get(); if (!L || !L.motion_rank?.length) return '';
  const rank = L.motion_rank; const idx = rank.findIndex(m => m.key === motionKey);
  if (idx === -1) return '';
  const m = rank[idx];
  if (idx === 0 && m.avg_hold >= 14) {
    return `LEARNED: this motion is your top performer (hold ${m.avg_hold}%, ${m.graduated}/${m.n} graduated) — lean into a long, slow, clearly visible drip/interaction; that retention is what holds viewers.`;
  }
  if (idx >= rank.length - 1 && m.killed > m.graduated && m.n >= MIN_PER_MOTION) {
    return `LEARNED: this motion underperforms (${m.killed}/${m.n} killed) — make the interaction more dynamic and the payoff (drip/reveal) more obvious to earn the hold.`;
  }
  return '';
}

/**
 * Nota de calibración para inyectar en el PROMPT DEL JUEZ — le dice qué de su
 * propio criterio históricamente predijo el resultado real (y qué no).
 */
async function getJudgeCalibration() {
  const L = await _get(); if (!L || !L.judge) return '';
  const { score_corr, dim_corr } = L.judge;
  if (score_corr == null && !Object.values(dim_corr || {}).some(v => v != null)) return '';
  const predictive = Object.entries(dim_corr || {}).filter(([, c]) => c != null && c >= 0.25).map(([d]) => d);
  const useless = Object.entries(dim_corr || {}).filter(([, c]) => c != null && c < 0.1).map(([d]) => d);
  let note = `\n\n═══ CALIBRACIÓN (aprendida de ${L.settled_count} videos reales) ═══\n`;
  if (score_corr != null) note += `Tu score histórico correlacionó ${score_corr} con el resultado real (${score_corr < 0.35 ? 'DÉBIL — sé MÁS exigente y discriminá más, no infles a 90+' : 'razonable'}).\n`;
  if (predictive.length) note += `Estas dimensiones SÍ predijeron el resultado real — pesalas MÁS: ${predictive.join(', ')}.\n`;
  if (useless.length) note += `Estas NO correlacionaron con el resultado — no infles el score por ellas: ${useless.join(', ')}.\n`;
  return note;
}

module.exports = { reconcile, getPromptLearning, getJudgeCalibration, outcomeScore, LEARNINGS_KEY };
