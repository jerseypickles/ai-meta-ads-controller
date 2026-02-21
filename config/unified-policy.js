module.exports = {
  // Controls how the unified policy runs.
  // shadow = generate decisions only (no Meta execution)
  // live = validate + execute through existing guard rails
  mode: process.env.UNIFIED_POLICY_MODE || 'shadow',

  // Decision thresholds
  min_action_score: 0.55,
  max_recommendations_per_cycle: 12,
  min_spend_for_action: 20,
  min_impressions_for_action: 2500,

  // Intelligent ranking: expected impact + risk + uncertainty + learning bias.
  scoring: {
    impact_weight: 0.38,
    base_score_weight: 0.32,
    quality_weight: 0.12,
    risk_penalty_weight: 0.22,
    uncertainty_penalty_weight: 0.18,
    learning_bias_weight: 1.0
  },

  // Ensure the policy does not collapse into budget-only recommendations.
  diversity: {
    min_creative_recommendations: 2,
    min_creative_share: 0.30,
    creative_score_floor: 0.48
  },

  // Creative-specific intelligence thresholds.
  creative_intelligence: {
    severe_fatigue_frequency: 3.8,
    weak_ctr_gap_pct: -25,
    weak_roas_gap_pct: -20,
    top_spend_concentration_warning: 0.72
  },

  // Uncertainty-aware behavior.
  uncertainty: {
    low_data_quality_threshold: 0.4,
    high_uncertainty_threshold: 0.7
  },

  // Online learning configuration (contextual bandit style)
  learning: {
    enabled: true,
    version: 'v1',
    prior_alpha: 1,
    prior_beta: 1,
    reward_clip_min: -1,
    reward_clip_max: 1,
    reward_weights: {
      roas: 0.7,
      cpa: 0.3
    }
  }
};
