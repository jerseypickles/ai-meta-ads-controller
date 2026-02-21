const mongoose = require('mongoose');

const affectedEntitySchema = new mongoose.Schema({
  entity_type: { type: String, enum: ['campaign', 'adset', 'ad', 'account'], required: true },
  entity_id: { type: String, required: true },
  entity_name: { type: String, default: '' }
}, { _id: false });

const researchSourceSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  url: { type: String, default: '' },
  snippet: { type: String, default: '' }
}, { _id: false });

const creativeContextSchema = new mongoose.Schema({
  ad_id: { type: String },
  ad_name: { type: String },
  headline: { type: String },
  body: { type: String },
  cta: { type: String },
  image_url: { type: String }
}, { _id: false });

const strategicInsightSchema = new mongoose.Schema({
  cycle_id: { type: String, required: true, index: true },
  insight_type: {
    type: String,
    enum: [
      'creative_refresh',
      'structure_change',
      'audience_insight',
      'copy_strategy',
      'platform_alert',
      'attribution_insight',
      'testing_suggestion',
      'seasonal_strategy',
      'budget_strategy',
      'scaling_playbook',
      'competitive_insight',
      'general'
    ],
    required: true
  },
  severity: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  title: { type: String, required: true },
  analysis: { type: String, required: true },
  recommendation: { type: String, required: true },
  evidence: [{ type: String }],
  affected_entities: [affectedEntitySchema],
  research_sources: [researchSourceSchema],
  creative_context: [creativeContextSchema],
  actionable: { type: Boolean, default: false },
  auto_action: {
    action: { type: String, enum: ['scale_up', 'scale_down', 'pause', 'reactivate'], default: null },
    entity_id: { type: String, default: null },
    entity_type: { type: String, default: null },
    value: { type: Number, default: null }
  },
  account_summary: { type: String },
  account_health: {
    type: String,
    enum: ['strong', 'stable', 'warning', 'critical']
  },
  status: {
    type: String,
    enum: ['pending', 'acknowledged', 'implemented', 'dismissed'],
    default: 'pending'
  },
  acknowledged_by: { type: String, default: null },
  acknowledged_at: { type: Date, default: null },
  token_usage: {
    input_tokens: { type: Number },
    output_tokens: { type: Number }
  },
  created_at: { type: Date, default: Date.now, index: true }
});

strategicInsightSchema.index({ cycle_id: 1, created_at: -1 });
strategicInsightSchema.index({ insight_type: 1, status: 1 });

module.exports = mongoose.model('StrategicInsight', strategicInsightSchema);
