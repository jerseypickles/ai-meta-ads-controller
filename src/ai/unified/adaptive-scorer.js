const kpiTargets = require('../../../config/kpi-targets');

class AdaptiveScorer {
  constructor(options = {}) {
    this.config = options.config || {};
    this.knowledge = options.knowledge || {};
  }

  buildAccountContext(accountOverview = {}, features = []) {
    const activeFeatures = features.filter(f => f.status === 'ACTIVE');
    const fatigueCount = activeFeatures.filter(
      f => toNumber(f.metrics?.frequency_7d) >= toNumber(kpiTargets.frequency_warning, 2.5)
    ).length;

    const totalDailyBudget = toNumber(accountOverview.total_daily_budget);
    const todaySpend = toNumber(accountOverview.today_spend);
    const roas7d = toNumber(accountOverview.roas_7d);
    const roasGap = (toNumber(kpiTargets.roas_target, 3) - roas7d) / Math.max(toNumber(kpiTargets.roas_target, 3), 0.1);

    return {
      accountRoas7d: roas7d,
      deliveryPressure: clamp(totalDailyBudget > 0 ? 1 - (todaySpend / totalDailyBudget) : 0, 0, 1),
      accountStress: clamp(Math.max(0, roasGap), 0, 1),
      fatiguePressure: clamp(
        activeFeatures.length > 0 ? fatigueCount / activeFeatures.length : 0,
        0,
        1
      )
    };
  }

  scoreCandidate({ feature, candidate, learningSignal, accountContext }) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};
    const actionPrior = this.knowledge.action_priors?.[candidate.action] || {};
    const entityModifiers = this.knowledge.entity_modifiers?.[feature.entity_type] || {};
    const scoringCfg = this.config.scoring || {};

    const dataQuality = clamp(toNumber(derived.data_quality_score, 0.35), 0, 1);
    const roasVolatility = clamp(toNumber(derived.roas_volatility), 0, 1.5);
    const freqGap = Math.max(0, toNumber(metrics.frequency_7d) - toNumber(kpiTargets.frequency_warning, 2.5));

    const expectedImpactPct = this._estimateExpectedImpactPct({
      feature,
      candidate,
      learningSignal,
      accountContext,
      actionPrior,
      entityModifiers
    });

    const riskScore = this._estimateRisk({
      feature,
      candidate,
      accountContext,
      actionPrior,
      entityModifiers,
      dataQuality,
      roasVolatility,
      freqGap,
      learningSignal
    });

    const uncertaintyScore = this._estimateUncertainty({
      feature,
      learningSignal,
      dataQuality,
      roasVolatility
    });

    const impactScore = this._normalizeImpact(expectedImpactPct);
    let policyScore =
      (impactScore * toNumber(scoringCfg.impact_weight, 0.38)) +
      (toNumber(candidate.baseScore, 0.5) * toNumber(scoringCfg.base_score_weight, 0.32)) +
      (dataQuality * toNumber(scoringCfg.quality_weight, 0.12));

    policyScore -= riskScore * toNumber(scoringCfg.risk_penalty_weight, 0.22);
    policyScore -= uncertaintyScore * toNumber(scoringCfg.uncertainty_penalty_weight, 0.18);
    policyScore += toNumber(learningSignal?.bias) * toNumber(scoringCfg.learning_bias_weight, 1);

    if (candidate.decision_category?.startsWith('creative') && uncertaintyScore <= 0.65) {
      policyScore += 0.03;
    }
    policyScore = clamp(policyScore, 0, 1);

    const confidenceScore = clamp(
      policyScore * (1 - (riskScore * 0.55)) * (1 - (uncertaintyScore * 0.65)),
      0,
      1
    );

    const confidence = this._confidenceFromScore(confidenceScore);
    const priority = this._priorityFromScore(policyScore, expectedImpactPct, riskScore);
    const measurementWindowHours = toNumber(
      candidate.measurement_window_hours,
      toNumber(actionPrior.measurement_window_hours, 72)
    );

    const hypothesis = this._buildHypothesis({
      feature,
      candidate,
      expectedImpactPct,
      confidenceScore
    });

    const evidence = this._buildEvidence({
      feature,
      learningSignal,
      expectedImpactPct,
      riskScore,
      uncertaintyScore
    });

    return {
      policyScore,
      confidence,
      confidenceScore,
      priority,
      expectedImpactPct,
      expectedImpactText: this._buildExpectedImpactText(expectedImpactPct, measurementWindowHours),
      riskScore,
      uncertaintyScore,
      measurementWindowHours,
      hypothesis,
      evidence,
      researchContext: this._buildResearchContext(candidate.action)
    };
  }

  _estimateExpectedImpactPct({ feature, candidate, learningSignal, accountContext, actionPrior, entityModifiers }) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};

    const roas7d = toNumber(metrics.roas_7d);
    const roas3d = toNumber(metrics.roas_3d);
    const cpa7d = toNumber(metrics.cpa_7d);
    const frequency = toNumber(metrics.frequency_7d);
    const trendSignal = clamp((roas3d - roas7d) / Math.max(Math.abs(roas7d), 0.5), -1, 1);
    const roasSignal = clamp((roas7d - toNumber(kpiTargets.roas_target, 3)) / Math.max(toNumber(kpiTargets.roas_target, 3), 0.5), -1, 1);
    const cpaSignal = cpa7d > 0
      ? clamp((toNumber(kpiTargets.cpa_target, 25) - cpa7d) / Math.max(toNumber(kpiTargets.cpa_target, 25), 1), -1, 1)
      : 0;
    const concentration = clamp(toNumber(derived.top_creative_share_7d), 0, 1);

    // Blend static prior with learned impact when we have confidence.
    // learnedImpact maps mean [0..1] to an impact range of [-5..+20] pct.
    const lConf = clamp(toNumber(learningSignal?.confidence), 0, 1);
    const staticImpact = toNumber(candidate.baseImpactPct, toNumber(actionPrior.baseline_impact_pct, 5));
    const learnedImpact = (toNumber(learningSignal?.mean, 0.5) - 0.2) * 25; // 0→-5, 0.5→+7.5, 1→+20
    let impact = staticImpact * (1 - lConf * 0.6) + learnedImpact * (lConf * 0.6);

    if (candidate.action === 'scale_up') {
      impact += (roasSignal * 8);
      impact += (trendSignal * 4);
      impact += (toNumber(accountContext.deliveryPressure) * 5);
      impact -= (Math.max(0, frequency - toNumber(kpiTargets.frequency_warning, 2.5)) * 2.5);
      impact -= (concentration * 5);
    } else if (candidate.action === 'scale_down') {
      impact += (Math.max(0, -roasSignal) * 7);
      impact += (Math.max(0, -cpaSignal) * 6);
      impact += (Math.max(0, concentration - 0.65) * 6);
    } else if (candidate.action === 'pause') {
      impact += (Math.max(0, frequency - toNumber(kpiTargets.frequency_warning, 2.5)) * 7);
      impact += (Math.max(0, -roasSignal) * 6);
      impact += (Math.max(0, -cpaSignal) * 4);
    } else if (candidate.action === 'reactivate') {
      impact += (Math.max(0, roasSignal) * 6);
      impact += (Math.max(0, cpaSignal) * 4);
      impact += (toNumber(accountContext.deliveryPressure) * 2);
    }

    // Contextual learning adjustment — scaled by confidence so early samples
    // contribute less and well-trained buckets can shift impact significantly.
    impact += (toNumber(learningSignal?.mean, 0.5) - 0.5) * (6 + lConf * 10);
    impact *= toNumber(entityModifiers.growth_multiplier || entityModifiers.efficiency_multiplier, 1);
    return clamp(impact, -20, 35);
  }

  _estimateRisk({
    feature,
    candidate,
    accountContext,
    actionPrior,
    entityModifiers,
    dataQuality,
    roasVolatility,
    freqGap,
    learningSignal
  }) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};

    // Blend static risk prior with learned failure rate.
    // learnedFailureRate = 1 - mean (mean is success probability from bandit).
    const lConf = clamp(toNumber(learningSignal?.confidence), 0, 1);
    const staticRisk = toNumber(candidate.baseRisk, toNumber(actionPrior.baseline_risk, 0.35));
    const learnedFailureRate = 1 - toNumber(learningSignal?.mean, 0.5);
    let risk = staticRisk * (1 - lConf * 0.5) + learnedFailureRate * (lConf * 0.5);

    risk += toNumber(entityModifiers.risk_offset, 0);
    risk += roasVolatility * 0.30;
    risk += (1 - dataQuality) * 0.28;
    risk += toNumber(accountContext.accountStress) * 0.22;
    risk += toNumber(accountContext.fatiguePressure) * 0.10;
    risk += clamp(toNumber(derived.top_creative_share_7d) - 0.7, 0, 0.5) * 0.25;

    if (candidate.action === 'scale_up') {
      risk += 0.12;
      risk += freqGap * 0.06;
    } else if (candidate.action === 'reactivate') {
      risk += 0.08;
    } else if (candidate.action === 'scale_down') {
      risk -= 0.04;
    } else if (candidate.action === 'pause') {
      risk -= 0.07;
    }

    if (toNumber(metrics.roas_7d) < toNumber(kpiTargets.roas_minimum, 1.5) && candidate.action === 'scale_up') {
      risk += 0.08;
    }
    return clamp(risk, 0.05, 0.95);
  }

  _estimateUncertainty({ feature, learningSignal, dataQuality, roasVolatility }) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};
    const minSpend = toNumber(this.config.min_spend_for_action, 20);

    // Use real statistical confidence if available (from StatisticalConfidence module)
    const statConfidence = toNumber(derived.statistical_confidence, 0);
    const attributionMaturity = toNumber(derived.attribution_maturity, 0);

    if (statConfidence > 0) {
      // New path: use computed statistical confidence + attribution maturity
      const learningConfidence = clamp(toNumber(learningSignal?.confidence), 0, 1);
      const stabilitySignal = 1 - clamp(roasVolatility, 0, 1);

      const certainty =
        (statConfidence * 0.40) +         // Statistical confidence is primary signal
        (attributionMaturity * 0.15) +     // Attribution maturity
        (learningConfidence * 0.15) +      // Bandit learning confidence
        (stabilitySignal * 0.15) +         // ROAS stability between windows
        (dataQuality * 0.15);              // Legacy data quality score

      return clamp(1 - certainty, 0, 1);
    }

    // Fallback: original heuristic-based uncertainty (for ads without stat confidence)
    const spendSignal = clamp(toNumber(metrics.spend_7d) / Math.max(minSpend * 4, 1), 0, 1);
    const impressionSignal = clamp(toNumber(metrics.impressions_7d) / 12000, 0, 1);
    const purchaseSignal = clamp(toNumber(metrics.purchases_7d) / 10, 0, 1);
    const learningConfidence = clamp(toNumber(learningSignal?.confidence), 0, 1);
    const stabilitySignal = 1 - clamp(roasVolatility, 0, 1);

    const certainty =
      (spendSignal * 0.30) +
      (impressionSignal * 0.15) +
      (purchaseSignal * 0.20) +
      (learningConfidence * 0.15) +
      (stabilitySignal * 0.10) +
      (dataQuality * 0.10);

    return clamp(1 - certainty, 0, 1);
  }

  _normalizeImpact(expectedImpactPct) {
    return clamp((toNumber(expectedImpactPct) + 20) / 55, 0, 1);
  }

  _confidenceFromScore(score) {
    if (score >= 0.72) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  _priorityFromScore(policyScore, expectedImpactPct, riskScore) {
    if (policyScore >= 0.84 && expectedImpactPct >= 10 && riskScore <= 0.45) return 'critical';
    if (policyScore >= 0.72 && expectedImpactPct >= 6) return 'high';
    if (policyScore >= 0.60 && expectedImpactPct >= 3) return 'medium';
    return 'low';
  }

  _buildExpectedImpactText(expectedImpactPct, measurementWindowHours) {
    const sign = expectedImpactPct > 0 ? '+' : '';
    return `Impacto esperado ${sign}${expectedImpactPct.toFixed(1)}% en ${measurementWindowHours}h`;
  }

  _buildHypothesis({ feature, candidate, expectedImpactPct, confidenceScore }) {
    const metrics = feature.metrics || {};
    const sign = expectedImpactPct > 0 ? '+' : '';
    const confidencePct = Math.round(confidenceScore * 100);
    const base = candidate.hypothesis || 'Accion propuesta por evidencia de entrega y calidad.';
    return `${base} Esperamos ${sign}${expectedImpactPct.toFixed(1)}% con ${confidencePct}% de confianza (ROAS7d ${toNumber(metrics.roas_7d).toFixed(2)}x, CPA7d $${toNumber(metrics.cpa_7d).toFixed(2)}).`;
  }

  _buildEvidence({ feature, learningSignal, expectedImpactPct, riskScore, uncertaintyScore }) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};
    return [
      `ROAS 3d/7d: ${toNumber(metrics.roas_3d).toFixed(2)}x / ${toNumber(metrics.roas_7d).toFixed(2)}x; CPA7d $${toNumber(metrics.cpa_7d).toFixed(2)}.`,
      `Frecuencia ${toNumber(metrics.frequency_7d).toFixed(2)} y CTR7d ${toNumber(metrics.ctr_7d).toFixed(2)}% (fatiga=${derived.frequency_alert ? 'alta' : 'normal'}).`,
      `Calidad de datos ${Math.round(clamp(toNumber(derived.data_quality_score, 0) * 100, 0, 100))}% y señal de aprendizaje ${Math.round(clamp(toNumber(learningSignal?.confidence, 0) * 100, 0, 100))}%.`,
      `Impacto esperado ${expectedImpactPct.toFixed(1)}%, riesgo ${Math.round(riskScore * 100)}%, incertidumbre ${Math.round(uncertaintyScore * 100)}%.`
    ];
  }

  _buildResearchContext(action) {
    const principles = this.knowledge.principles || [];
    if (!principles.length) return '';

    if (action === 'scale_up' || action === 'reactivate') {
      return principles[0] || '';
    }
    if (action === 'pause' || action === 'scale_down') {
      return principles[2] || principles[0] || '';
    }
    return principles[1] || principles[0] || '';
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = AdaptiveScorer;
