const mongoose = require('mongoose');

const strategicDirectiveSchema = new mongoose.Schema({
  cycle_id: { type: String, required: true, index: true },
  insight_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicInsight', default: null },
  directive_type: {
    type: String,
    enum: ['boost', 'suppress', 'override', 'protect', 'stabilize', 'optimize_ads', 'rescue'],
    required: true
  },
  entity_type: { type: String, enum: ['adset', 'ad', 'campaign'], required: true },
  entity_id: { type: String, required: true },
  entity_name: { type: String, default: '' },
  target_action: {
    type: String,
    enum: ['scale_up', 'scale_down', 'pause', 'reactivate', 'optimize_ads', 'create_ad', 'update_ad_status', 'any'],
    default: 'any'
  },
  score_modifier: { type: Number, default: 0, min: -0.5, max: 0.5 },
  reason: { type: String, required: true },
  source_insight_type: { type: String, default: '' },
  confidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  // ═══ ENRICHED DIRECTIVE FIELDS ═══
  reason_category: {
    type: String,
    enum: [
      'low_roas',           // ROAS below target
      'high_cpa',           // CPA above target
      'creative_fatigue',   // Frequency/CTR decline
      'no_conversions',     // Spending with zero purchases
      'budget_waste',       // High spend, low return
      'strong_performer',   // Scale up signal
      'recovery_signal',    // Was bad, improving
      'learning_phase',     // Just exited learning
      'audience_saturation', // Frequency too high
      'other'
    ],
    default: 'other'
  },
  urgency_level: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  supporting_metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
    // Expected: { roas_7d, roas_3d, cpa_7d, spend_7d, spend_today, frequency, ctr_7d, purchases_7d, daily_budget, fatigue_score }
  },
  suggested_actions: [{
    action: String,
    detail: String
  }],
  consecutive_count: { type: Number, default: 1 }, // How many consecutive cycles Brain has issued same directive for this entity
  // ═══ END ENRICHED FIELDS ═══
  expires_at: { type: Date, required: true, index: true },
  status: {
    type: String,
    enum: ['active', 'applied', 'expired', 'overridden'],
    default: 'active'
  },
  applied_count: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

strategicDirectiveSchema.index({ entity_id: 1, status: 1 });
strategicDirectiveSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('StrategicDirective', strategicDirectiveSchema);
