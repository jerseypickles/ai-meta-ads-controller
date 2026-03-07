const Decision = require('../../db/models/Decision');
const logger = require('../../utils/logger');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');
const unifiedPolicyConfig = require('../../../config/unified-policy');
const deepResearchPriors = require('../../../config/deep-research-priors');
const { getLatestSnapshots, getAccountOverview, getRecentActions, getActiveDirectives, getSnapshotFreshness } = require('../../db/queries');
const { CooldownManager } = require('../../safety/cooldown-manager');
const ActionExecutor = require('../../meta/action-executor');
const { buildFeatureSet } = require('./feature-builder');
const PolicyLearner = require('./policy-learner');
const AdaptiveScorer = require('./adaptive-scorer');

class UnifiedPolicyAgent {
  constructor(options = {}) {
    this.config = {
      ...unifiedPolicyConfig,
      ...options
    };
    this.knowledge = deepResearchPriors;
    this.learner = new PolicyLearner();
    this.scorer = new AdaptiveScorer({
      config: this.config,
      knowledge: this.knowledge
    });
    this.executor = new ActionExecutor();
    this.cooldownManager = new CooldownManager();
  }

  async runCycle(options = {}) {
    const cycleId = `unified_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const runMode = options.mode || this.config.mode || 'shadow';
    logger.info(`═══ Iniciando ciclo de politica unificada [${cycleId}] (${runMode}) ═══`);

    // Freshness guard — no tomar decisiones con datos stale (> 15 min)
    const freshness = await getSnapshotFreshness('adset');
    if (!freshness.fresh) {
      logger.warn(`[UNIFIED] Datos stale (${freshness.age_minutes} min) — abortando ciclo. Umbral: 15 min.`);
      return null;
    }

    const [adSetSnapshots, adSnapshots, accountOverview, recentActions, activeCooldowns, strategicDirectives] = await Promise.all([
      getLatestSnapshots('adset'),
      getLatestSnapshots('ad'),
      getAccountOverview(),
      getRecentActions(3),
      this.cooldownManager.getActiveCooldowns(),
      getActiveDirectives()
    ]);

    // Indexar directivas por entity_id para lookup rapido
    const directivesByEntity = {};
    for (const d of strategicDirectives) {
      if (!directivesByEntity[d.entity_id]) directivesByEntity[d.entity_id] = [];
      directivesByEntity[d.entity_id].push(d);
    }
    if (strategicDirectives.length > 0) {
      logger.info(`[UNIFIED] ${strategicDirectives.length} directivas estrategicas activas cargadas`);
    }

    if (!adSetSnapshots || adSetSnapshots.length === 0) {
      logger.warn('[UNIFIED] Sin ad sets para analizar');
      return null;
    }

    const learning = await this.learner.consumeImpactFeedback(300);
    const features = buildFeatureSet({
      adSetSnapshots,
      adSnapshots,
      accountOverview,
      recentActions,
      activeCooldowns
    });
    const accountContext = this.scorer.buildAccountContext(accountOverview, features);

    const decisions = [];
    for (const feature of features) {
      const entityDirectives = directivesByEntity[feature.entity_id] || [];
      const decision = this._evaluateEntity(feature, learning.state, accountContext, entityDirectives);
      if (decision) decisions.push(decision);
    }

    const rankedDecisions = this._selectDiverseDecisions(decisions);
    const actionCounts = rankedDecisions.reduce((acc, item) => {
      acc[item.action] = (acc[item.action] || 0) + 1;
      return acc;
    }, {});

    const analysisSummary = this._buildSummary({
      accountOverview,
      actionCounts,
      recommendationCount: rankedDecisions.length,
      learning,
      mode: runMode,
      decisions: rankedDecisions
    });

    const alerts = this._buildAlerts(accountOverview, rankedDecisions, features);
    const decisionMix = this._buildDecisionMix(rankedDecisions);

    const decisionDoc = await Decision.create({
      cycle_id: cycleId,
      analysis_summary: analysisSummary,
      total_daily_spend: accountOverview.today_spend || 0,
      account_roas: accountOverview.roas_7d || 0,
      decisions: rankedDecisions,
      alerts,
      total_actions: rankedDecisions.length,
      approved_actions: 0,
      rejected_actions: 0,
      executed_actions: 0,
      claude_model: `unified-policy-${(this.config.learning || {}).version || 'v1'}`,
      prompt_tokens: 0,
      completion_tokens: 0,
      knowledge_version: this.knowledge.version,
      learning_samples_total: toNumber(learning.state?.total_samples),
      decision_mix: decisionMix,
      research_digest: (this.knowledge.principles || []).slice(0, 2).join(' ')
    });

    let executionResult = { approved: 0, rejected: 0, executed: 0 };
    if (runMode === 'live' && rankedDecisions.length > 0) {
      executionResult = await this.executor.executeBatch(decisionDoc);
      logger.info(`[UNIFIED] Modo LIVE: ${executionResult.executed}/${rankedDecisions.length} ejecutadas`);
    } else {
      logger.info(`[UNIFIED] Modo SHADOW: ${rankedDecisions.length} recomendaciones generadas, 0 ejecutadas`);
    }

    return {
      cycleId,
      mode: runMode,
      decision: decisionDoc,
      recommendations: rankedDecisions.length,
      execution: executionResult,
      learningProcessed: learning.processed,
      learningAverageReward: learning.averageReward
    };
  }

  _evaluateEntity(feature, learningState, accountContext, directives = []) {
    // Check for 'protect' directive — skip evaluation entirely
    const protectDirective = directives.find(d => d.directive_type === 'protect');
    if (protectDirective) {
      logger.debug(`[UNIFIED] Entidad ${feature.entity_name} protegida por directiva estrategica: ${protectDirective.reason}`);
      this._markDirectiveApplied(protectDirective);
      return null;
    }

    if (feature.entity_type === 'ad') {
      return this._evaluateCreative(feature, learningState, accountContext, directives);
    }
    return this._evaluateAdSet(feature, learningState, accountContext, directives);
  }

  _evaluateAdSet(feature, learningState, accountContext, directives = []) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};
    const candidates = [];
    const creativeCfg = this.config.creative_intelligence || {};

    // Inject override directives as high-priority candidates
    for (const d of directives.filter(d => d.directive_type === 'override' && d.target_action !== 'any')) {
      candidates.push({
        action: d.target_action,
        baseScore: 0.90,
        baseImpactPct: 8.0,
        baseRisk: 0.15,
        decision_category: 'strategic_override',
        hypothesis: `[STRATEGIC] ${d.reason}`,
        measurement_window_hours: 72,
        _strategic_directive: d
      });
      this._markDirectiveApplied(d);
    }

    if (feature.cooldown) {
      return null;
    }

    if (feature.status !== 'ACTIVE') {
      if (metrics.roas_30d >= kpiTargets.roas_target && metrics.spend_30d >= this.config.min_spend_for_action) {
        candidates.push({
          action: 'reactivate',
          baseScore: 0.62,
          baseImpactPct: 6.5,
          baseRisk: 0.34,
          decision_category: 'recovery',
          hypothesis: 'Ad set pausado con historico rentable; reactivar recupera volumen sin comprometer eficiencia.',
          measurement_window_hours: 72
        });
      }
      return this._pickBestCandidate({ feature, learningState, accountContext, candidates, directives });
    }

    if (metrics.spend_7d < this.config.min_spend_for_action) {
      return null;
    }

    const severeFatigue = derived.creative_fatigue_score >= 1.0
      || (metrics.frequency_7d >= kpiTargets.frequency_critical && metrics.ctr_7d <= kpiTargets.ctr_minimum);
    const weakPerformance = metrics.roas_7d < kpiTargets.roas_minimum || metrics.cpa_7d > kpiTargets.cpa_maximum;
    const strongPerformance = metrics.roas_7d >= kpiTargets.roas_target
      && metrics.roas_14d >= kpiTargets.roas_minimum
      && metrics.frequency_7d < kpiTargets.frequency_warning
      && derived.data_quality_score >= 0.45;
    const concentrationRisk = derived.top_creative_share_7d >= toNumber(creativeCfg.top_spend_concentration_warning, 0.72)
      && metrics.frequency_7d >= kpiTargets.frequency_warning;
    const underdeliveryWithGoodRoas = derived.spend_velocity < 0.75 && metrics.roas_14d >= kpiTargets.roas_target;

    if (severeFatigue) {
      candidates.push({
        action: 'pause',
        baseScore: 0.82,
        baseImpactPct: 9.0,
        baseRisk: 0.20,
        decision_category: 'creative_fatigue_control',
        hypothesis: 'Fatiga severa del cluster creativo; pausar protege ROAS y evita desperdicio incremental.',
        measurement_window_hours: 72
      });
    }

    if (weakPerformance) {
      candidates.push({
        action: 'scale_down',
        baseScore: 0.73,
        baseImpactPct: 6.0,
        baseRisk: 0.28,
        decision_category: 'efficiency_protection',
        hypothesis: 'Rendimiento por debajo de objetivo; reducir presupuesto limita perdida y estabiliza CPA.',
        measurement_window_hours: 72
      });
    }

    if (concentrationRisk) {
      candidates.push({
        action: 'scale_down',
        baseScore: 0.67,
        baseImpactPct: 5.5,
        baseRisk: 0.26,
        decision_category: 'creative_concentration_risk',
        hypothesis: 'Alta concentracion de gasto en pocos creativos; moderar budget reduce riesgo de fatiga acelerada.',
        measurement_window_hours: 72
      });
    }

    if (strongPerformance) {
      candidates.push({
        action: 'scale_up',
        baseScore: 0.74,
        baseImpactPct: 8.0,
        baseRisk: 0.44,
        decision_category: 'profitable_scaling',
        hypothesis: 'Rendimiento consistente con buena calidad de datos; escalar de forma gradual aumenta volumen rentable.',
        measurement_window_hours: 72
      });
    }

    if (underdeliveryWithGoodRoas) {
      candidates.push({
        action: 'scale_up',
        baseScore: 0.66,
        baseImpactPct: 6.8,
        baseRisk: 0.41,
        decision_category: 'delivery_recovery',
        hypothesis: 'Buen ROAS con delivery por debajo de ritmo esperado; escalar recupera gasto util.',
        measurement_window_hours: 72
      });
    }

    return this._pickBestCandidate({ feature, learningState, accountContext, candidates, directives });
  }

  _evaluateCreative(feature, learningState, accountContext, directives = []) {
    const metrics = feature.metrics || {};
    const derived = feature.derived || {};
    const candidates = [];
    const creativeCfg = this.config.creative_intelligence || {};

    // Inject override directives
    for (const d of directives.filter(d => d.directive_type === 'override' && d.target_action !== 'any')) {
      candidates.push({
        action: d.target_action,
        baseScore: 0.90,
        baseImpactPct: 8.0,
        baseRisk: 0.15,
        decision_category: 'strategic_override',
        hypothesis: `[STRATEGIC] ${d.reason}`,
        measurement_window_hours: 72,
        _strategic_directive: d
      });
      this._markDirectiveApplied(d);
    }

    if (feature.cooldown) {
      return null;
    }

    if (metrics.spend_7d < this.config.min_spend_for_action) {
      return null;
    }

    const ctrWeak = metrics.ctr_7d < kpiTargets.ctr_minimum;
    const roasWeak = metrics.roas_7d < kpiTargets.roas_minimum;
    const freqHigh = metrics.frequency_7d >= toNumber(creativeCfg.severe_fatigue_frequency, 3.8);
    const ctrDrop = derived.ctr_vs_average <= toNumber(creativeCfg.weak_ctr_gap_pct, -25);
    const roasGapPct = ((metrics.roas_3d - metrics.roas_7d) / Math.max(metrics.roas_7d, 0.5)) * 100;
    const roasDrop = roasGapPct <= toNumber(creativeCfg.weak_roas_gap_pct, -20);
    const siblingWeak = derived.sibling_roas_gap <= -0.45;
    const dominantButWeak = derived.sibling_spend_share_7d >= 0.45 && roasWeak;
    const fatigueScoreHigh = derived.creative_fatigue_score >= 0.9;

    if (fatigueScoreHigh || (freqHigh && ctrWeak) || (roasDrop && ctrDrop) || siblingWeak || dominantButWeak) {
      candidates.push({
        action: 'pause',
        baseScore: fatigueScoreHigh ? 0.84 : 0.75,
        baseImpactPct: fatigueScoreHigh ? 9.0 : 6.5,
        baseRisk: 0.18,
        decision_category: 'creative_pruning',
        hypothesis: 'Creativo con señales de desgaste relativo; pausar desplaza gasto hacia piezas con mayor probabilidad de conversion.',
        measurement_window_hours: 72
      });
    }

    if (feature.status !== 'ACTIVE'
      && metrics.roas_14d >= kpiTargets.roas_target
      && metrics.ctr_7d >= kpiTargets.ctr_minimum) {
      candidates.push({
        action: 'reactivate',
        baseScore: 0.64,
        baseImpactPct: 6.0,
        baseRisk: 0.32,
        decision_category: 'creative_reactivation',
        hypothesis: 'Creativo pausado con performance historico fuerte; reactivar para ampliar inventario creativo.',
        measurement_window_hours: 72
      });
    }

    return this._pickBestCandidate({ feature, learningState, accountContext, candidates, directives });
  }

  _pickBestCandidate({ feature, learningState, accountContext, candidates, directives = [] }) {
    if (!candidates.length) return null;

    const bucket = this.learner.bucketFromMetrics({
      roas_7d: feature.metrics?.roas_7d,
      cpa_7d: feature.metrics?.cpa_7d,
      frequency: feature.metrics?.frequency_7d,
      spend_7d: feature.metrics?.spend_7d,
      purchases_7d: feature.metrics?.purchases_7d
    }, {
      hour: new Date().getHours(),
      seasonal_event: this.learner._isSeasonalDate(new Date()),
      account_roas_7d: accountContext?.accountRoas7d || 0
    });

    const scored = candidates.map((candidate) => {
      const learningSignal = this.learner.getActionBias(learningState, bucket, candidate.action);
      const evaluation = this.scorer.scoreCandidate({
        feature,
        candidate,
        learningSignal,
        accountContext
      });
      return {
        ...candidate,
        ...evaluation,
        learningSignal
      };
    });

    // Apply strategic directive score modifiers (boost/suppress)
    const boostSuppressDirectives = directives.filter(d =>
      d.directive_type === 'boost' || d.directive_type === 'suppress'
    );
    for (const candidate of scored) {
      for (const d of boostSuppressDirectives) {
        if (d.target_action === 'any' || d.target_action === candidate.action) {
          candidate.policyScore = clamp(candidate.policyScore + (d.score_modifier || 0), 0, 1);
          candidate._strategicReason = d.reason;
          candidate._strategicType = d.directive_type;
          this._markDirectiveApplied(d);
        }
      }
    }

    scored.sort((a, b) => b.policyScore - a.policyScore);
    const best = scored[0];
    const scoreThreshold = this._resolveScoreThreshold(feature, best);
    if (best.policyScore < scoreThreshold) {
      return null;
    }

    const actionValues = this._buildActionValues(best.action, feature);
    const strategicNote = best._strategicReason
      ? ` [STRATEGIC: ${best._strategicType} — ${best._strategicReason}]`
      : '';
    return {
      action: best.action,
      entity_type: feature.entity_type,
      entity_id: feature.entity_id,
      entity_name: feature.entity_name,
      campaign_name: feature.campaign_id || '',
      current_value: actionValues.currentValue,
      new_value: actionValues.newValue,
      change_percent: actionValues.changePercent,
      reasoning: `[UNIFIED_POLICY] ${best.hypothesis} Aprendizaje(${bucket})=${toNumber(best.learningSignal.mean, 0.5).toFixed(2)}.${strategicNote}`,
      confidence: best.confidence,
      priority: best.priority,
      metrics_snapshot: {
        roas_3d: feature.metrics.roas_3d,
        roas_7d: feature.metrics.roas_7d,
        cpa_3d: feature.metrics.cpa_3d,
        spend_today: feature.metrics.spend_today,
        frequency: feature.metrics.frequency_7d,
        ctr: feature.metrics.ctr_7d
      },
      policy_score: best.policyScore,
      policy_bucket: bucket,
      expected_impact: best.expectedImpactText,
      expected_impact_pct: best.expectedImpactPct,
      risk_score: best.riskScore,
      uncertainty_score: best.uncertaintyScore,
      confidence_score: best.confidenceScore,
      measurement_window_hours: best.measurementWindowHours,
      hypothesis: best.hypothesis,
      rationale_evidence: best.evidence,
      research_context: best.researchContext,
      decision_category: best.decision_category || '',
      data_quality_score: toNumber(feature.derived?.data_quality_score)
    };
  }

  _resolveScoreThreshold(feature, best) {
    const baseThreshold = toNumber(this.config.min_action_score, 0.55);
    if (feature.entity_type !== 'ad') {
      return baseThreshold;
    }
    const creativeFloor = toNumber(this.config.diversity?.creative_score_floor, baseThreshold - 0.07);
    if (best.decision_category?.startsWith('creative')) {
      return Math.min(baseThreshold, creativeFloor);
    }
    return baseThreshold;
  }

  _buildActionValues(action, feature) {
    if (action === 'scale_up' || action === 'scale_down') {
      return this._buildBudgetChange(action, feature.current_budget);
    }

    if (action === 'pause') {
      return { currentValue: feature.status || 'ACTIVE', newValue: 'PAUSED', changePercent: 0 };
    }
    if (action === 'reactivate') {
      return { currentValue: feature.status || 'PAUSED', newValue: 'ACTIVE', changePercent: 0 };
    }

    return { currentValue: 0, newValue: 0, changePercent: 0 };
  }

  _buildBudgetChange(action, currentBudget) {
    const current = toNumber(currentBudget);
    if (action === 'scale_up') {
      const proposed = current * 1.15;
      const capped = Math.min(
        proposed,
        current * (1 + (safetyGuards.max_budget_increase_pct / 100)),
        safetyGuards.max_single_adset_budget
      );
      const newValue = round2(capped);
      return {
        currentValue: current,
        newValue,
        changePercent: current > 0 ? ((newValue - current) / current) * 100 : 0
      };
    }

    if (action === 'scale_down') {
      const proposed = current * 0.85;
      const floorByPct = current * (1 - (safetyGuards.max_budget_decrease_pct / 100));
      const newValue = round2(Math.max(proposed, floorByPct, safetyGuards.min_adset_budget));
      return {
        currentValue: current,
        newValue,
        changePercent: current > 0 ? ((newValue - current) / current) * 100 : 0
      };
    }

    return { currentValue: 0, newValue: 0, changePercent: 0 };
  }

  _selectDiverseDecisions(decisions) {
    const sorted = [...decisions].sort((a, b) => b.policy_score - a.policy_score);
    const maxRecommendations = toNumber(this.config.max_recommendations_per_cycle, 12);
    const minCreativeAbs = Math.max(0, toNumber(this.config.diversity?.min_creative_recommendations, 2));
    const minCreativeShare = clamp(toNumber(this.config.diversity?.min_creative_share, 0.30), 0, 1);
    const creativeFloor = toNumber(this.config.diversity?.creative_score_floor, 0.48);

    const creativeCandidates = sorted.filter(
      d => d.entity_type === 'ad' && d.policy_score >= creativeFloor
    );
    const creativeTarget = Math.min(
      creativeCandidates.length,
      Math.max(minCreativeAbs, Math.floor(maxRecommendations * minCreativeShare))
    );

    const selected = [];
    const selectedIds = new Set();

    for (const decision of creativeCandidates.slice(0, creativeTarget)) {
      if (selected.length >= maxRecommendations) break;
      if (selectedIds.has(decision.entity_id)) continue;
      selected.push(decision);
      selectedIds.add(decision.entity_id);
    }

    for (const decision of sorted) {
      if (selected.length >= maxRecommendations) break;
      if (selectedIds.has(decision.entity_id)) continue;
      selected.push(decision);
      selectedIds.add(decision.entity_id);
    }

    return selected;
  }

  _buildSummary({ accountOverview, actionCounts, recommendationCount, learning, mode, decisions }) {
    const segments = [];
    const avgExpectedImpact = decisions.length
      ? decisions.reduce((sum, d) => sum + toNumber(d.expected_impact_pct), 0) / decisions.length
      : 0;
    const avgRisk = decisions.length
      ? decisions.reduce((sum, d) => sum + toNumber(d.risk_score), 0) / decisions.length
      : 0;
    const mix = this._buildDecisionMix(decisions);

    segments.push(`ROAS cuenta 7d ${toNumber(accountOverview?.roas_7d).toFixed(2)}x`);
    segments.push(`${recommendationCount} recomendaciones`);

    const actionsText = Object.entries(actionCounts)
      .map(([action, count]) => `${count} ${action}`)
      .join(', ');
    if (actionsText) {
      segments.push(actionsText);
    }

    segments.push(`mix adsets=${mix.adset}, creativos=${mix.ad}`);
    segments.push(`impacto esp. medio ${avgExpectedImpact >= 0 ? '+' : ''}${avgExpectedImpact.toFixed(1)}%`);
    segments.push(`riesgo medio ${(avgRisk * 100).toFixed(0)}%`);
    segments.push(`aprendizaje +${learning.processed} muestras (reward medio ${toNumber(learning.averageReward).toFixed(3)})`);
    segments.push(`modo ${mode.toUpperCase()}`);
    return segments.join(' | ');
  }

  _buildDecisionMix(decisions = []) {
    return decisions.reduce((acc, item) => {
      if (item.entity_type === 'ad') acc.ad += 1;
      if (item.entity_type === 'adset') acc.adset += 1;
      return acc;
    }, { adset: 0, ad: 0 });
  }

  _markDirectiveApplied(directive) {
    if (directive._id) {
      const StrategicDirective = require('../../db/models/StrategicDirective');
      StrategicDirective.updateOne(
        { _id: directive._id },
        { $set: { status: 'applied' }, $inc: { applied_count: 1 } }
      ).catch(err => logger.warn(`[UNIFIED] Error marcando directiva aplicada: ${err.message}`));
    }
  }

  _buildAlerts(accountOverview, rankedDecisions, features) {
    const alerts = [];
    const highUncertaintyThreshold = toNumber(this.config.uncertainty?.high_uncertainty_threshold, 0.7);

    if (toNumber(accountOverview?.roas_7d) < kpiTargets.roas_minimum) {
      alerts.push({
        type_name: 'roas_warning',
        message: `ROAS de cuenta por debajo de objetivo minimo (${toNumber(accountOverview?.roas_7d).toFixed(2)}x).`,
        severity: 'warning'
      });
    }

    const fatigueCount = features.filter(f => toNumber(f.derived?.creative_fatigue_score) >= 0.8).length;
    if (fatigueCount > 0) {
      alerts.push({
        type_name: 'fatigue_watch',
        message: `${fatigueCount} entidades muestran senales de fatiga creativa/ audiencia.`,
        severity: fatigueCount >= 4 ? 'critical' : 'warning'
      });
    }

    const highUncertaintyCount = rankedDecisions.filter(d => toNumber(d.uncertainty_score) >= highUncertaintyThreshold).length;
    if (highUncertaintyCount > 0) {
      alerts.push({
        type_name: 'uncertainty_watch',
        message: `${highUncertaintyCount} recomendaciones con alta incertidumbre; validar con mayor supervision.`,
        severity: highUncertaintyCount >= 3 ? 'warning' : 'info'
      });
    }

    const creativeRecs = rankedDecisions.filter(d => d.entity_type === 'ad').length;
    if (fatigueCount > 0 && creativeRecs === 0) {
      alerts.push({
        type_name: 'creative_gap',
        message: 'Hay fatiga detectada pero sin acciones creativas sugeridas; revisar data quality.',
        severity: 'warning'
      });
    }

    if (!rankedDecisions.length) {
      alerts.push({
        type_name: 'no_action',
        message: 'No se detectaron acciones de alta conviccion en este ciclo.',
        severity: 'info'
      });
    }

    return alerts;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = UnifiedPolicyAgent;
