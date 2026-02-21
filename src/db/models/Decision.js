const mongoose = require('mongoose');

const decisionItemSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['scale_up', 'scale_down', 'pause', 'reactivate', 'no_action'],
    required: true
  },
  entity_type: { type: String, enum: ['adset', 'ad'], required: true },
  entity_id: { type: String, required: true },
  entity_name: { type: String },
  campaign_name: { type: String },
  current_value: { type: mongoose.Schema.Types.Mixed },
  new_value: { type: mongoose.Schema.Types.Mixed },
  change_percent: { type: Number, default: 0 },
  reasoning: { type: String },
  confidence: { type: String, enum: ['high', 'medium', 'low'] },
  priority: { type: String, enum: ['critical', 'high', 'medium', 'low'] },
  metrics_snapshot: {
    roas_3d: Number,
    roas_7d: Number,
    cpa_3d: Number,
    spend_today: Number,
    frequency: Number,
    ctr: Number
  },
  policy_score: { type: Number, default: 0 },
  policy_bucket: { type: String, default: '' },
  expected_impact: { type: String, default: '' },
  expected_impact_pct: { type: Number, default: 0 },
  risk_score: { type: Number, default: 0 },
  uncertainty_score: { type: Number, default: 0 },
  confidence_score: { type: Number, default: 0 },
  measurement_window_hours: { type: Number, default: 72 },
  hypothesis: { type: String, default: '' },
  rationale_evidence: [{ type: String }],
  research_context: { type: String, default: '' },
  decision_category: { type: String, default: '' },
  data_quality_score: { type: Number, default: 0 },
  recommendation_status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'executed'],
    default: 'pending'
  },
  reviewed_by: { type: String, default: null },
  reviewed_at: { type: Date, default: null },
  executed_at: { type: Date, default: null },
  // Resultado del safety check
  safety_check: {
    approved: { type: Boolean, default: false },
    modified: { type: Boolean, default: false },
    reason: { type: String, default: '' },
    original_value: { type: mongoose.Schema.Types.Mixed }
  }
}, { _id: true });

const decisionSchema = new mongoose.Schema({
  cycle_id: { type: String, required: true, index: true },
  analysis_summary: { type: String },
  total_daily_spend: { type: Number, default: 0 },
  account_roas: { type: Number, default: 0 },
  decisions: [decisionItemSchema],
  alerts: [{
    type_name: String,
    message: String,
    severity: { type: String, enum: ['critical', 'warning', 'info'] }
  }],
  // Metadata
  total_actions: { type: Number, default: 0 },
  approved_actions: { type: Number, default: 0 },
  rejected_actions: { type: Number, default: 0 },
  executed_actions: { type: Number, default: 0 },
  claude_model: { type: String },
  knowledge_version: { type: String, default: '' },
  learning_samples_total: { type: Number, default: 0 },
  decision_mix: {
    adset: { type: Number, default: 0 },
    ad: { type: Number, default: 0 }
  },
  research_digest: { type: String, default: '' },
  prompt_tokens: { type: Number, default: 0 },
  completion_tokens: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('Decision', decisionSchema);
