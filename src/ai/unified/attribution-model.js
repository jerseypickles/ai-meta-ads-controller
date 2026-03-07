/**
 * AttributionModel — Corrige métricas recientes por el lag de atribución de Meta.
 *
 * Meta Ads usa un attribution window de 7 días (click) / 1 día (view).
 * Esto significa que las conversiones de hoy pueden atribuirse a clicks de hace
 * hasta 7 días. Como resultado:
 *
 * - ROAS de "today" siempre parece bajo (muchas conversiones aún no se atribuyeron)
 * - ROAS de "3d" está sub-reportado ~15-25% (conversiones de clicks de day 1-3 aún llegando)
 * - ROAS de "7d" es más confiable pero aún puede tener un lag marginal del último día
 * - ROAS de "14d" y "30d" son esencialmente completos
 *
 * Este modelo aplica factores de corrección basados en el patrón típico de
 * atribución de Meta para ecommerce (food industry, 7d click window).
 *
 * Attribution curve (typical for food ecommerce with 7d click):
 * Day 0 (same day): ~55% of eventual conversions reported
 * Day 1: ~75%
 * Day 2: ~85%
 * Day 3: ~90%
 * Day 4: ~94%
 * Day 5: ~97%
 * Day 6: ~99%
 * Day 7+: ~100%
 */

// Default attribution curve — percentage of eventual conversions reported by day N.
// These are conservative estimates for food ecommerce with 7d click attribution.
const DEFAULT_ATTRIBUTION_CURVE = {
  0: 0.55,  // Day 0: 55% of final conversions visible
  1: 0.75,  // Day 1: 75%
  2: 0.85,  // Day 2: 85%
  3: 0.90,  // Day 3: 90%
  4: 0.94,  // Day 4: 94%
  5: 0.97,  // Day 5: 97%
  6: 0.99,  // Day 6: 99%
  7: 1.00   // Day 7+: 100%
};

/**
 * Aplica corrección de atribución a métricas de diferentes ventanas de tiempo.
 *
 * @param {Object} metrics - Métricas mapeadas (roas_today, roas_3d, roas_7d, etc.)
 * @param {Object} options - { hourOfDay, attributionCurve }
 * @returns {Object} { corrected_roas, correction_factors, attribution_maturity }
 */
function applyAttributionCorrection(metrics, options = {}) {
  const hourOfDay = options.hourOfDay != null ? options.hourOfDay : new Date().getHours();
  const curve = options.attributionCurve || DEFAULT_ATTRIBUTION_CURVE;

  const roas_today = metrics.roas_today || 0;
  const roas_3d = metrics.roas_3d || 0;
  const roas_7d = metrics.roas_7d || 0;
  const roas_14d = metrics.roas_14d || 0;
  const spend_today = metrics.spend_today || 0;
  const purchases_7d = metrics.purchases_7d || 0;

  // === TODAY correction ===
  // Today's data is partial: both time-of-day incomplete AND attribution lag.
  // Time-of-day factor: at 12pm, ~50% of day's spend has happened,
  // but Meta may not have reported conversions from morning clicks yet.
  const dayCompleteness = hourOfDay >= 1 ? Math.min(hourOfDay / 24, 1) : 0.04;
  const todayAttributionMaturity = curve[0] * dayCompleteness;
  const todayCorrectionFactor = todayAttributionMaturity > 0.05
    ? 1 / todayAttributionMaturity
    : null; // Don't correct if too early / too little data

  // === 3D correction ===
  // 3d window: day 0 is 90% mature, day 1 is 85%, day 2 is 75%.
  // Weighted average maturity for 3d window:
  // Each day contributes roughly equally to the window, so avg maturity:
  const threeDay_maturity = (curve[2] + curve[1] + curve[0]) / 3;
  // But "3d" in Meta means completed days (yesterday, 2 days ago, 3 days ago),
  // so the newest day is 1 day old → curve[1]
  const threeDayCompletedMaturity = (curve[3] + curve[2] + curve[1]) / 3;
  const threeDayCorrectionFactor = threeDayCompletedMaturity > 0 ? 1 / threeDayCompletedMaturity : 1;

  // === 7D correction ===
  // 7d completed days: days 1-7 old. Most are fully mature, only day 1-2 have residual.
  const sevenDayMaturity = (curve[7] + curve[6] + curve[5] + curve[4] + curve[3] + curve[2] + curve[1]) / 7;
  const sevenDayCorrectionFactor = sevenDayMaturity > 0 ? 1 / sevenDayMaturity : 1;

  // === 14D and 30D ===
  // These are essentially fully mature, correction ~1.0
  const fourteenDayCorrectionFactor = 1.0;

  // Apply corrections
  const corrected = {
    roas_today_corrected: todayCorrectionFactor && roas_today > 0
      ? round(roas_today * todayCorrectionFactor, 2)
      : null, // null = unreliable, don't use
    roas_3d_corrected: roas_3d > 0 ? round(roas_3d * threeDayCorrectionFactor, 2) : 0,
    roas_7d_corrected: roas_7d > 0 ? round(roas_7d * sevenDayCorrectionFactor, 2) : 0,
    roas_14d_corrected: roas_14d, // No correction needed
  };

  // Attribution maturity summary
  const maturity = _computeAttributionMaturity(metrics, curve);

  return {
    corrected_roas: corrected,
    correction_factors: {
      today: todayCorrectionFactor ? round(todayCorrectionFactor, 3) : null,
      three_day: round(threeDayCorrectionFactor, 3),
      seven_day: round(sevenDayCorrectionFactor, 3),
      fourteen_day: fourteenDayCorrectionFactor
    },
    attribution_maturity: maturity,
    hour_of_day: hourOfDay,
    details: _buildAttributionDetails(corrected, metrics, maturity)
  };
}

/**
 * Computa un score de madurez de atribución global para la entidad.
 * 0 = datos muy inmaduros (recién creado, pocas horas)
 * 1 = datos completamente maduros (7d+ de historia con volumen)
 */
function _computeAttributionMaturity(metrics, curve) {
  const spend7d = metrics.spend_7d || 0;
  const purchases7d = metrics.purchases_7d || 0;
  const spend3d = metrics.spend_3d || 0;

  // If no 7d spend, data is immature
  if (spend7d < 5) return { score: 0.1, label: 'immature' };

  // Ratio of 3d to 7d spend tells us how "front-loaded" the data is
  // If most spend is in last 3 days, the data is still maturing
  const recencyRatio = spend3d / Math.max(spend7d, 1);

  // With high recency ratio (>0.7), most data is recent and still attributing
  // With low recency ratio (<0.3), most data is old and fully attributed
  let maturityScore;
  if (recencyRatio > 0.8) {
    // Most spend is very recent — high attribution lag risk
    maturityScore = 0.4;
  } else if (recencyRatio > 0.6) {
    // Spend is somewhat recent
    maturityScore = 0.6;
  } else if (recencyRatio > 0.4) {
    // Balanced distribution — good
    maturityScore = 0.8;
  } else {
    // Most spend is older — fully attributed
    maturityScore = 0.95;
  }

  // Boost maturity if we have many purchases (law of large numbers)
  if (purchases7d >= 20) maturityScore = Math.min(maturityScore + 0.15, 1);
  else if (purchases7d >= 10) maturityScore = Math.min(maturityScore + 0.10, 1);

  let label;
  if (maturityScore >= 0.85) label = 'mature';
  else if (maturityScore >= 0.60) label = 'mostly_mature';
  else if (maturityScore >= 0.35) label = 'maturing';
  else label = 'immature';

  return { score: round(maturityScore, 2), label };
}

function _buildAttributionDetails(corrected, metrics, maturity) {
  const roas7d = metrics.roas_7d || 0;
  const corrected7d = corrected.roas_7d_corrected || 0;
  const diff = corrected7d - roas7d;

  if (maturity.label === 'mature') {
    return `Datos maduros — corrección mínima (ROAS 7d: ${roas7d.toFixed(2)}x → ${corrected7d.toFixed(2)}x, +${diff.toFixed(2)})`;
  }
  if (maturity.label === 'mostly_mature') {
    return `Datos mayormente maduros — corrección menor aplicada (ROAS 7d: ${roas7d.toFixed(2)}x → ${corrected7d.toFixed(2)}x, +${diff.toFixed(2)})`;
  }
  if (maturity.label === 'maturing') {
    return `Datos aún madurando — ROAS real probablemente mayor (ROAS 7d reportado: ${roas7d.toFixed(2)}x, estimado: ${corrected7d.toFixed(2)}x)`;
  }
  return `Datos inmaduros — métricas pueden cambiar significativamente en 48-72h`;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

module.exports = { applyAttributionCorrection, DEFAULT_ATTRIBUTION_CURVE };
