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
  }).select('motion_variant product_name video_judge_score video_judge_breakdown video_result_verdict creative_signals status').lean();

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

  // ¿El juez de VIDEO (Gemini, ve el mp4) predice mejor que el de imagen (Claude)?
  // (vs OUTCOME = conversión-dominante)
  const videoPairs = settled.filter(v => v.video_result_verdict?.overall != null)
    .map(v => [v.video_result_verdict.overall, outcomeScore(v.status, byProp[String(v._id)] || {})]);
  const video_score_corr = videoPairs.length >= MIN_PAIRS_CORR ? corr(videoPairs) : null;

  // TARGET CORRECTO del juez de VIDEO: ¿un video mejor-juzgado se MIRA más (retención)?
  // Gemini juzga CALIDAD, que mueve el HOLD, no la conversión (que la maneja oferta/producto).
  // Esta es la validación honesta del juez de video. Igual para Claude (foto) como contraste.
  const holdOf = v => (byProp[String(v._id)]?.hold_rate || 0) * 100;
  const videoHoldPairs = settled.filter(v => v.video_result_verdict?.overall != null && holdOf(v) > 0)
    .map(v => [v.video_result_verdict.overall, holdOf(v)]);
  const video_hold_corr = videoHoldPairs.length >= MIN_PAIRS_CORR ? corr(videoHoldPairs) : null;
  const claudeHoldPairs = settled.filter(v => v.video_judge_score != null && holdOf(v) > 0)
    .map(v => [v.video_judge_score, holdOf(v)]);
  const claude_hold_corr = claudeHoldPairs.length >= MIN_PAIRS_CORR ? corr(claudeHoldPairs) : null;

  // Cada dimensión del juez se valida contra SU métrica real del funnel, no contra el
  // outcome mezclado: freno_scroll ↔ thumbstop (el hook real), apetito/autenticidad/calidad
  // ↔ hold (retención), fidelidad ↔ conversión. Así medimos si el juez predice LO QUE
  // esa dimensión controla, no las ventas en general (que dependen de oferta/producto).
  const dimMetric = (d, status, m) => {
    if (d === 'freno_scroll') return (m.thumbstop_rate || 0) * 100;   // hook / scroll-stop real
    if (d === 'fidelidad') return outcomeScore(status, m);            // producto correcto → conversión
    return (m.hold_rate || 0) * 100;                                  // apetito/autenticidad/calidad → retención
  };
  const dimCorr = {};
  for (const d of JUDGE_DIMS) {
    const pairs = settled
      .filter(v => {
        const m = byProp[String(v._id)] || {};
        return v.video_judge_breakdown?.breakdown?.[d]?.score != null && dimMetric(d, v.status, m) > 0;
      })
      .map(v => [v.video_judge_breakdown.breakdown[d].score, dimMetric(d, v.status, byProp[String(v._id)] || {})]);
    dimCorr[d] = pairs.length >= MIN_PAIRS_CORR ? corr(pairs) : null;
  }

  // ── SEÑALES CREATIVAS ABSTRACTAS (Pilar 4): ¿qué palanca creativa explica el outcome? ──
  // Cada señal (hook_strength, curiosity_gap, food_craving, ...) correlacionada contra el
  // resultado real → el sistema aprende QUÉ mueve la aguja, no solo qué motion ganó.
  const SIGNAL_KEYS = ['hook_strength', 'curiosity_gap', 'food_craving', 'visual_energy', 'visual_contrast', 'clarity', 'production_quality', 'authenticity', 'motion_intensity'];
  const signalCorr = {};
  for (const s of SIGNAL_KEYS) {
    const pairs = settled.filter(v => v.creative_signals?.[s] != null)
      .map(v => [v.creative_signals[s], outcomeScore(v.status, byProp[String(v._id)] || {})]);
    signalCorr[s] = pairs.length >= MIN_PAIRS_CORR ? corr(pairs) : null;
  }
  const signal_rank = Object.entries(signalCorr).filter(([, c]) => c != null)
    .map(([s, c]) => ({ signal: s, corr: c })).sort((a, b) => b.corr - a.corr);
  const signals_count = settled.filter(v => v.creative_signals).length;

  // ── CURVA DE RETENCIÓN promedio (dónde se cae la gente) ──
  // p25→p50→p75→p100: la FORMA revela si pierde en el hook (caída temprana) o el payoff.
  const wc = settled.map(v => byProp[String(v._id)]).filter(m => m && (m.thumbstop_rate || m.p50_rate || m.hold_rate));
  const avgAt = key => wc.length ? +(wc.reduce((s, m) => s + (m[key] || 0), 0) / wc.length * 100).toFixed(0) : 0;
  let watch_curve = null;
  if (wc.length) {
    const pts = { p25: avgAt('thumbstop_rate'), p50: avgAt('p50_rate'), p75: avgAt('p75_rate'), p100: avgAt('hold_rate') };
    // segmento con la caída más grande (dónde más se pierde la audiencia)
    const drops = [['hook (0→25%)', 100 - pts.p25], ['25→50%', pts.p25 - pts.p50], ['50→75%', pts.p50 - pts.p75], ['75→100%', pts.p75 - pts.p100]];
    const worst = drops.filter(d => d[1] > 0).sort((a, b) => b[1] - a[1])[0];
    const avgSec = +(wc.reduce((s, m) => s + (m.video_avg_time || 0), 0) / wc.length).toFixed(1);
    const hasMid = wc.some(m => m.p50_rate); // si aún no hay p50 capturado, la curva es parcial
    watch_curve = { ...pts, avg_seconds: avgSec, biggest_drop: worst ? worst[0] : null, biggest_drop_pct: worst ? worst[1] : 0, n: wc.length, partial: !hasMid };
  }

  // ── PERFIL DE SEÑALES POR MOTION (la "receta": qué señales eleva cada patrón) ──
  // Para cada motion top: el LIFT de cada señal vs el promedio global. Revela POR QUÉ
  // funciona un patrón (ej. bite_tease eleva curiosity_gap +18 vs el promedio).
  const sigWithVal = settled.filter(v => v.creative_signals);
  const globalSig = {};
  for (const s of SIGNAL_KEYS) {
    const vals = sigWithVal.map(v => v.creative_signals[s]).filter(x => x != null);
    globalSig[s] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const pattern_signals = {};
  for (const r of motionRank) {
    const mv = sigWithVal.filter(v => v.motion_variant === r.key);
    if (mv.length < 2) continue;
    const prof = [];
    for (const s of SIGNAL_KEYS) {
      const vals = mv.map(v => v.creative_signals[s]).filter(x => x != null);
      if (vals.length) prof.push({ signal: s, lift: +((vals.reduce((a, b) => a + b, 0) / vals.length) - globalSig[s]).toFixed(0) });
    }
    pattern_signals[r.key] = prof.sort((a, b) => b.lift - a.lift);
  }

  const learnings = {
    generated_at: new Date(),
    settled_count: settled.length,
    motion_rank: motionRank,
    signal_corr: signalCorr,
    signal_rank,
    signals_count,
    pattern_signals,
    watch_curve,
    judge: { score_corr, video_score_corr, video_hold_corr, claude_hold_corr, dim_corr: dimCorr }
  };
  await SystemConfig.set(LEARNINGS_KEY, learnings, 'video_learning');
  logger.info(`[VIDEO-LEARNING] reconciliado: ${settled.length} firmes · top motion ${motionRank[0]?.key || '—'} · juez score_corr ${score_corr ?? 'n/a'}`);
  return learnings;
}

// Etiqueta de semana ISO (YYYY-Www) de una fecha.
function weekKey(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

/**
 * Tendencia SEMANAL — cohorta los videos por semana (cuándo corrieron) y mide
 * % positivos + win-rate + outcome por semana, con el Δ vs la semana anterior.
 * Es la prueba de que el loop mejora semana a semana.
 * "Positivo" = graduó o convirtió (≥1 compra).
 */
async function weeklyTrend(weeks = 10) {
  const vids = await CreativeProposal.find({
    media_type: 'video', status: { $in: ['testing', 'graduated', 'killed', 'expired'] }
  }).select('status created_at').lean();
  if (!vids.length) return [];

  const ids = vids.map(v => v._id);
  const runs = await TestRun.find({ proposal_id: { $in: ids } }).select('proposal_id metrics launched_at created_at').lean();
  const byProp = {}; for (const t of runs) byProp[String(t.proposal_id)] = { m: t.metrics || {}, date: t.launched_at || t.created_at };

  const buckets = {};
  for (const v of vids) {
    const r = byProp[String(v._id)];
    const date = r?.date || v.created_at; if (!date) continue;
    const wk = weekKey(new Date(date));
    const b = buckets[wk] || (buckets[wk] = { week: wk, n: 0, grad: 0, kill: 0, pos: 0, out: 0, hold: 0 });
    const m = r?.m || {};
    b.n++;
    if (v.status === 'graduated') b.grad++;
    if (v.status === 'killed') b.kill++;
    if (v.status === 'graduated' || (m.purchases || 0) > 0) b.pos++;
    b.out += outcomeScore(v.status, m);
    b.hold += (m.hold_rate || 0);
  }

  const arr = Object.values(buckets).map(b => ({
    week: b.week, n: b.n,
    pct_positive: Math.round((b.pos / b.n) * 100),
    win_rate: (b.grad + b.kill) > 0 ? Math.round((b.grad / (b.grad + b.kill)) * 100) : null,
    avg_outcome: +(b.out / b.n).toFixed(1),
    avg_hold: +((b.hold / b.n) * 100).toFixed(0)
  })).sort((a, b) => a.week.localeCompare(b.week));

  for (let i = 1; i < arr.length; i++) {
    arr[i].delta_positive = arr[i].pct_positive - arr[i - 1].pct_positive;
    arr[i].delta_outcome = +(arr[i].avg_outcome - arr[i - 1].avg_outcome).toFixed(1);
  }
  return arr.slice(-weeks);
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

module.exports = { reconcile, getPromptLearning, getJudgeCalibration, weeklyTrend, outcomeScore, LEARNINGS_KEY };
