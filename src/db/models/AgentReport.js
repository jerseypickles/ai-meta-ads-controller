const mongoose = require('mongoose');

const recommendationSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: [
      'scale_up', 'scale_down', 'pause', 'reactivate', 'no_action',
      'duplicate_adset', 'create_ad', 'update_bid_strategy',
      'update_ad_status', 'move_budget', 'update_ad_creative', 'observe'
    ],
    required: true
  },
  entity_type: { type: String, enum: ['adset', 'ad', 'campaign'], default: 'adset' },
  entity_id: { type: String, required: true },
  entity_name: { type: String, required: true },
  current_value: { type: Number, default: 0 },
  recommended_value: { type: Number, default: 0 },
  change_percent: { type: Number, default: 0 },
  reasoning: { type: String, required: true },
  expected_impact: { type: String, default: '' },
  confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  priority: { type: String, enum: ['critical', 'high', 'medium', 'low'], default: 'medium' },
  metrics: {
    roas_7d: { type: Number, default: 0 },
    roas_3d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },
  // Campos para acciones avanzadas
  target_entity_id: { type: String, default: null },      // Para move_budget: ad set destino
  target_entity_name: { type: String, default: null },
  creative_asset_id: { type: String, default: null },      // Para create_ad: referencia al banco
  bid_strategy: { type: String, default: null },            // Para update_bid_strategy
  duplicate_name: { type: String, default: null },          // Para duplicate_adset/update_ad_creative
  duplicate_strategy: { type: String, default: null },      // Para duplicate_adset: estrategia
  ad_name: { type: String, default: null },                  // Para create_ad: nombre del ad
  ad_headline: { type: String, default: null },              // Para create_ad: headline copy (EN, max 40 chars)
  ad_primary_text: { type: String, default: null },          // Para create_ad: body text (EN, max 125 chars)
  creative_rationale: { type: String, default: null },       // Para create_ad: razon creativa
  ads_to_pause: [{ type: String }],                          // Para create_ad: ads fatigados a pausar
  creative_changes: {                                        // Para update_ad_creative
    headline: { type: String, default: null },
    body: { type: String, default: null },
    cta: { type: String, default: null },
    link_url: { type: String, default: null }
  },
  // Policy scorer fields (Cerebro IA)
  policy_score: { type: Number, default: null },
  confidence_score: { type: Number, default: null },
  expected_impact_pct: { type: Number, default: null },
  risk_score: { type: Number, default: null },
  uncertainty_score: { type: Number, default: null },
  measurement_window_hours: { type: Number, default: null },
  hypothesis: { type: String, default: null },
  evidence: { type: mongoose.Schema.Types.Mixed, default: null },
  policy_bucket: { type: String, default: null },
  past_impact: [{ type: mongoose.Schema.Types.Mixed }],
  // Research context (del deep research del agente)
  research_context: { type: String, default: '' },
  research_sources: [{
    title: { type: String, default: '' },
    url: { type: String, default: '' },
    snippet: { type: String, default: '' }
  }],
  // Flujo de aprobacion
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'executed', 'expired'],
    default: 'pending'
  },
  approved_by: { type: String, default: null },
  approved_at: { type: Date, default: null },
  executed_at: { type: Date, default: null },
  execution_result: { type: mongoose.Schema.Types.Mixed, default: null }
});

const agentReportSchema = new mongoose.Schema({
  agent_type: {
    type: String,
    enum: ['budget', 'performance', 'creative', 'pacing', 'scaling', 'brain'],
    required: true,
  },
  cycle_id: { type: String, required: true, index: true },
  summary: { type: String, required: true },
  status: {
    type: String,
    enum: ['healthy', 'warning', 'critical'],
    default: 'healthy'
  },
  recommendations: [recommendationSchema],
  alerts: [{
    type_name: { type: String },
    message: { type: String },
    severity: { type: String, enum: ['critical', 'warning', 'info'], default: 'info' }
  }],
  prompt_tokens: { type: Number, default: 0 },
  completion_tokens: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now, index: true }
});

// Indice compuesto para consultas por tipo + fecha
agentReportSchema.index({ agent_type: 1, created_at: -1 });

module.exports = mongoose.model('AgentReport', agentReportSchema);
