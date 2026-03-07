/**
 * StatisticalConfidence — Calcula intervalos de confianza reales para métricas de ad sets.
 *
 * En vez de tratar ROAS=1.3 con 3 compras igual que ROAS=1.3 con 30 compras,
 * este módulo calcula cuánta confianza tenemos en cada métrica basándose en
 * volumen de datos (compras, clicks, spend).
 *
 * Usa distribución Beta-Binomial para conversion rates y bootstrap-style
 * confidence intervals para métricas de revenue.
 *
 * Resultado: un confidence_level de 0-1 por entidad que alimenta el
 * uncertainty_penalty del AdaptiveScorer con datos reales.
 */

/**
 * Calcula la confianza estadística para un ad set basándose en volumen de datos.
 *
 * @param {Object} metrics - Métricas mapeadas (spend_7d, purchases_7d, clicks_7d, etc.)
 * @param {Object} options - Overrides opcionales
 * @returns {Object} { confidence_level, confidence_label, sample_quality, roas_interval, details }
 */
function computeStatisticalConfidence(metrics, options = {}) {
  const purchases7d = metrics.purchases_7d || 0;
  const clicks7d = metrics.clicks_7d || 0;
  const impressions7d = metrics.impressions_7d || 0;
  const spend7d = metrics.spend_7d || 0;
  const purchaseValue7d = metrics.purchase_value_7d || 0;
  const roas7d = metrics.roas_7d || 0;

  // 1. Purchase volume confidence (most important — conversions are what we optimize for)
  //    Statistical rule of thumb: need ~30 conversions for reliable CPA/ROAS
  //    With <10, any metric is essentially noise
  const purchaseConfidence = _purchaseVolumeConfidence(purchases7d);

  // 2. Click volume confidence (CTR reliability)
  //    Need ~100 clicks for CTR to stabilize, ~300 for high confidence
  const clickConfidence = _clickVolumeConfidence(clicks7d);

  // 3. Spend volume confidence (is there enough spend to judge?)
  //    Below $20 spend in 7d, metrics are unreliable
  const spendConfidence = _spendVolumeConfidence(spend7d);

  // 4. Impression confidence (statistical mass)
  const impressionConfidence = _impressionVolumeConfidence(impressions7d);

  // Weighted blend — purchases matter most for ROAS/CPA decisions
  const overallConfidence = clamp(
    (purchaseConfidence * 0.45) +
    (clickConfidence * 0.20) +
    (spendConfidence * 0.20) +
    (impressionConfidence * 0.15),
    0, 1
  );

  // ROAS confidence interval (rough estimation)
  const roasInterval = _estimateRoasInterval(roas7d, purchases7d, spend7d, purchaseValue7d);

  // Conversion rate confidence interval (Beta-Binomial)
  const conversionRateCI = _betaBinomialCI(purchases7d, clicks7d);

  // Label
  let confidenceLabel;
  if (overallConfidence >= 0.80) confidenceLabel = 'high';
  else if (overallConfidence >= 0.55) confidenceLabel = 'medium';
  else if (overallConfidence >= 0.30) confidenceLabel = 'low';
  else confidenceLabel = 'insufficient';

  return {
    confidence_level: round(overallConfidence, 3),
    confidence_label: confidenceLabel,
    sample_quality: {
      purchases_7d: purchases7d,
      clicks_7d: clicks7d,
      spend_7d: round(spend7d, 2),
      purchase_confidence: round(purchaseConfidence, 3),
      click_confidence: round(clickConfidence, 3),
      spend_confidence: round(spendConfidence, 3)
    },
    roas_interval: roasInterval,
    conversion_rate_ci: conversionRateCI,
    details: _buildConfidenceDetails(overallConfidence, purchases7d, clicks7d, spend7d)
  };
}

/**
 * Purchase volume → confidence.
 * 0 purchases = 0 confidence in ROAS/CPA
 * 1-5 = very low (noise)
 * 6-15 = low-medium (directional only)
 * 16-30 = medium (reasonably reliable)
 * 30+ = high (statistically significant)
 */
function _purchaseVolumeConfidence(purchases) {
  if (purchases === 0) return 0;
  if (purchases <= 2) return 0.10;
  if (purchases <= 5) return 0.25;
  if (purchases <= 10) return 0.45;
  if (purchases <= 20) return 0.65;
  if (purchases <= 30) return 0.80;
  if (purchases <= 50) return 0.90;
  return 0.95;
}

function _clickVolumeConfidence(clicks) {
  if (clicks < 20) return 0.10;
  if (clicks < 50) return 0.30;
  if (clicks < 100) return 0.50;
  if (clicks < 300) return 0.75;
  if (clicks < 500) return 0.85;
  return 0.95;
}

function _spendVolumeConfidence(spend) {
  if (spend < 5) return 0.05;
  if (spend < 20) return 0.25;
  if (spend < 50) return 0.50;
  if (spend < 100) return 0.70;
  if (spend < 250) return 0.85;
  return 0.95;
}

function _impressionVolumeConfidence(impressions) {
  if (impressions < 500) return 0.10;
  if (impressions < 2000) return 0.35;
  if (impressions < 5000) return 0.55;
  if (impressions < 10000) return 0.75;
  if (impressions < 25000) return 0.85;
  return 0.95;
}

/**
 * Estimate ROAS confidence interval using coefficient of variation approach.
 * With few purchases, each purchase has high variance impact on ROAS.
 *
 * With n purchases, the standard error of the mean revenue is roughly:
 *   SE ≈ mean_revenue / sqrt(n)
 * So ROAS interval width ≈ ROAS * (1/sqrt(n)) * z_score
 */
function _estimateRoasInterval(roas, purchases, spend, purchaseValue) {
  if (purchases < 2 || spend <= 0 || roas <= 0) {
    return { lower: 0, upper: roas * 3, width: roas * 3, reliable: false };
  }

  // Average order value and its implied variance
  const avgOrderValue = purchaseValue / purchases;

  // Coefficient of variation for purchase values (estimated)
  // In e-commerce, AOV typically has CV of 0.3-0.8
  const estimatedCV = purchases < 10 ? 0.6 : 0.4;

  // Standard error of ROAS using delta method approximation
  // SE(ROAS) ≈ ROAS * sqrt(CV²/n + 1/n)
  const se = roas * Math.sqrt((estimatedCV * estimatedCV / purchases) + (1 / purchases));

  // 90% confidence interval (z=1.645)
  const z = 1.645;
  const margin = se * z;

  const lower = Math.max(0, roas - margin);
  const upper = roas + margin;

  return {
    lower: round(lower, 2),
    upper: round(upper, 2),
    width: round(upper - lower, 2),
    reliable: purchases >= 10,
    margin_pct: round((margin / Math.max(roas, 0.01)) * 100, 1)
  };
}

/**
 * Beta-Binomial confidence interval for conversion rate.
 * Uses Bayesian approach: Beta(1+successes, 1+failures) posterior.
 * Returns 90% credible interval.
 */
function _betaBinomialCI(successes, trials) {
  if (trials < 10) {
    return { lower: 0, upper: 1, rate: 0, reliable: false };
  }

  const alpha = 1 + successes; // Prior + observed successes
  const beta = 1 + (trials - successes); // Prior + observed failures
  const mean = alpha / (alpha + beta);

  // Approximate 90% credible interval using normal approximation to Beta
  const variance = (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  const z = 1.645;

  return {
    lower: round(Math.max(0, mean - z * sd) * 100, 2),
    upper: round(Math.min(1, mean + z * sd) * 100, 2),
    rate: round(mean * 100, 2),
    reliable: trials >= 50 && successes >= 3
  };
}

function _buildConfidenceDetails(confidence, purchases, clicks, spend) {
  if (confidence >= 0.80) {
    return `Datos suficientes (${purchases} compras, ${clicks} clicks, $${spend.toFixed(0)} spend) — métricas confiables`;
  }
  if (confidence >= 0.55) {
    return `Datos moderados (${purchases} compras, ${clicks} clicks) — métricas direccionalmente útiles pero no concluyentes`;
  }
  if (confidence >= 0.30) {
    return `Datos limitados (${purchases} compras, ${clicks} clicks) — alto riesgo de ruido estadístico, actuar con precaución`;
  }
  return `Datos insuficientes (${purchases} compras, ${clicks} clicks) — métricas NO confiables, esperar más datos`;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

module.exports = { computeStatisticalConfidence };
