/**
 * athena-scale-gate.js — disciplina de scale_up para Athena (account-agent).
 *
 * Athena escala bien por volumen pero su win-rate de scale_up es bajo (~32%):
 * escala adsets en Meta-ROAS 7d ≥3x del momento que después revierten. Esto le da
 * dos frenos en el flujo de scale (ambos sesgan conservador, que es el lado seguro):
 *
 *   1. Freno marginal — no escalar un adset cuya ROAS 3d viene cayendo vs la 7d.
 *      (mismo patrón que el scale-gate de Ares, pero por-adset).
 *   2. Step cap adaptado al win-rate — si el win-rate de scale_up reciente de Athena
 *      es bajo, achica el paso máximo (graduado): mal track → pasos chicos hasta
 *      recuperar. Auto-consciencia + escalado graduado en una.
 *
 * Fail-open: si algo falla, no bloquea y deja el step default.
 */

const ActionLog = require('../../db/models/ActionLog');
const logger = require('../../utils/logger');

const MARGINAL_DECLINE = 0.85;   // ROAS 3d < 7d*0.85 (cae ≥15%) → no escalar
const DEFAULT_STEP = 0.15;       // paso normal +15%
const STEP_MID = 0.10;           // win-rate 40-60% → +10%
const STEP_LOW = 0.07;           // win-rate <40% → +7%
const MIN_SAMPLE = 6;            // mínimo de scales decididos para confiar en el win-rate

/**
 * Freno marginal por-adset. @param snapshot del adset (con metrics.last_3d/7d.roas)
 * @returns {{allow:boolean, reason?:string}}
 */
function checkAdsetScaleSanity(snapshot) {
  const r3 = snapshot?.metrics?.last_3d?.roas || 0;
  const r7 = snapshot?.metrics?.last_7d?.roas || 0;
  if (r7 > 0 && r3 > 0 && r3 < r7 * MARGINAL_DECLINE) {
    return { allow: false, reason: `freno marginal: ROAS 3d ${r3.toFixed(2)}x < 7d ${r7.toFixed(2)}x (cayendo ≥15%) — no escalar un adset en declive, se está por revertir` };
  }
  return { allow: true };
}

/**
 * Step cap adaptado al win-rate de scale_up reciente de Athena (capa de veredicto).
 * @returns {{maxStepPct:number, win_rate:number|null, reason:string}}
 */
async function getAdaptiveScaleStep() {
  try {
    const since = new Date(Date.now() - 30 * 86400000);
    const rows = await ActionLog.aggregate([
      { $match: { agent_type: 'unified_agent', action: 'scale_up', executed_at: { $gte: since }, follow_up_verdict: { $in: ['positive', 'negative'] } } },
      { $group: { _id: null, pos: { $sum: { $cond: [{ $eq: ['$follow_up_verdict', 'positive'] }, 1, 0] } }, neg: { $sum: { $cond: [{ $eq: ['$follow_up_verdict', 'negative'] }, 1, 0] } } } }
    ]);
    const r = rows[0] || { pos: 0, neg: 0 };
    const decided = r.pos + r.neg;
    if (decided < MIN_SAMPLE) {
      return { maxStepPct: DEFAULT_STEP, win_rate: null, reason: `sample chico (${decided}) — step default` };
    }
    const wr = r.pos / decided;
    let maxStep = DEFAULT_STEP;
    if (wr < 0.40) maxStep = STEP_LOW;
    else if (wr < 0.60) maxStep = STEP_MID;
    return { maxStepPct: maxStep, win_rate: Math.round(wr * 100), reason: `scale_up win-rate ${Math.round(wr * 100)}% (${decided} dec) → step max ${Math.round(maxStep * 100)}%` };
  } catch (err) {
    logger.warn(`[ATHENA-SCALE-GATE] adaptive step falló (fail-open): ${err.message}`);
    return { maxStepPct: DEFAULT_STEP, win_rate: null, reason: 'fallo — step default' };
  }
}

module.exports = { checkAdsetScaleSanity, getAdaptiveScaleStep, DEFAULT_STEP };
