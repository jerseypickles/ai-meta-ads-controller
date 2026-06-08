// ═══════════════════════════════════════════════════════════════════════════════
// athena-saturation.js — SATURACIÓN ADELANTADA: el techo de audiencia ANTES de quemar.
//
// El cap de frequency < 3.0 es una señal RETRASADA: cuando la freq llega a 3.0 ya
// sobre-escalaste a una audiencia agotada (le mostraste el ad a la misma gente). Estas
// son las señales que ANTECEDEN al techo de audiencia → aflojar antes de quemar budget:
//   1. FREQUENCY subiendo (3d > 7d) con freq ya elevada → estás agotando la audiencia.
//   2. CPM subiendo → Meta paga más por alcanzar (queda menos gente fresca = saturación).
//   3. CTR cayendo → la audiencia se está cansando del ad (fatiga + saturación).
//
// Cuando satura, el lever correcto NO es más budget (solo sube la freq) — es EXPANDIR
// audiencia (lookalike/broad). Por ahora, la señal hace que Athena afloje el escalamiento.
// ═══════════════════════════════════════════════════════════════════════════════

const FREQ_HIGH = 2.5;    // freq 7d elevada (cerca del cap 3.0)
const FREQ_MIN_RISE = 1.8; // solo cuenta "freq subiendo" si ya está en nivel relevante
const RISE = 1.15;        // 3d > 7d × 1.15 = subiendo ≥15%
const FALL = 0.85;        // 3d < 7d × 0.85 = cayendo ≥15%

function computeSaturation(snap) {
  const m3 = snap?.metrics?.last_3d || {}, m7 = snap?.metrics?.last_7d || {};
  const f3 = m3.frequency || 0, f7 = m7.frequency || 0;
  const cpm3 = m3.cpm || 0, cpm7 = m7.cpm || 0;
  const ctr3 = m3.ctr || 0, ctr7 = m7.ctr || 0;
  if (f7 <= 0 || (m7.impressions || 0) < 500) return null; // sin señal suficiente

  const signals = [];
  const freqRising = f3 > f7 * RISE && f3 > FREQ_MIN_RISE;
  if (freqRising) signals.push(`frequency subiendo (${f3.toFixed(1)} vs ${f7.toFixed(1)} 7d)`);
  if (cpm7 > 0 && cpm3 > cpm7 * RISE) signals.push(`CPM subiendo +${Math.round((cpm3 / cpm7 - 1) * 100)}%`);
  if (ctr7 > 0 && ctr3 < ctr7 * FALL) signals.push(`CTR cayendo −${Math.round((1 - ctr3 / ctr7) * 100)}%`);

  const elevated = f7 > FREQ_HIGH;
  let level, guide;
  if (signals.length >= 2 || (elevated && freqRising)) {
    level = 'SATURANDO';
    guide = 'la audiencia se está agotando — más budget solo sube la frequency, no llega a gente nueva. NO escales (o muy chico). El lever correcto es EXPANDIR audiencia (lookalike/broad), no más plata. Flaggealo para audiencia nueva si la freq sigue subiendo.';
  } else if (signals.length === 1 || f7 > 2.0) {
    level = 'CALENTANDO';
    guide = 'primeras señales de saturación — escalá CHICO (+10%) y vigilá. Si la frequency sigue subiendo o el CPM trepa, pasá a mantener.';
  } else {
    level = 'FRESCO';
    guide = 'audiencia fresca, sin saturación — escalá con confianza, hay gente nueva por alcanzar.';
  }
  return { level, signals, f7: +f7.toFixed(2), cpm7: +cpm7.toFixed(1), guide };
}

/**
 * Contexto de saturación para el prompt de Athena.
 * @returns {{context:string, level:string|null}}
 */
function getSaturationSignal(snap) {
  try {
    const s = computeSaturation(snap);
    if (!s) return { context: '', level: null };
    const sigTxt = s.signals.length ? s.signals.join(' · ') : 'sin señales de fatiga';
    const context = `\n\n## SATURACIÓN DE AUDIENCIA (adelantada): ${s.level}\n` +
      `freq 7d ${s.f7} · ${sigTxt}. ${s.guide}\n` +
      `CLAVE: juzgá el techo de AUDIENCIA por estas señales adelantadas, no esperes a que la frequency llegue a 3.0 (ahí ya quemaste budget).`;
    return { context, level: s.level };
  } catch (e) {
    return { context: '', level: null };
  }
}

module.exports = { computeSaturation, getSaturationSignal };
