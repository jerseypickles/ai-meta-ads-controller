const mongoose = require('mongoose');

const actionLogSchema = new mongoose.Schema({
  decision_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Decision', index: true },
  cycle_id: { type: String, index: true },
  entity_type: { type: String, enum: ['adset', 'ad', 'campaign'], required: true },
  entity_id: { type: String, required: true, index: true },
  entity_name: { type: String },
  campaign_id: { type: String },
  campaign_name: { type: String },
  action: {
    type: String,
    enum: [
      'scale_up', 'scale_down', 'pause', 'reactivate', 'kill_switch',
      'duplicate_adset', 'create_ad', 'update_bid_strategy',
      'update_ad_status', 'move_budget', 'update_ad_creative'
    ],
    required: true
  },
  before_value: { type: mongoose.Schema.Types.Mixed },
  after_value: { type: mongoose.Schema.Types.Mixed },
  change_percent: { type: Number, default: 0 },
  reasoning: { type: String },
  hypothesis: { type: String, default: '' },
  decision_category: { type: String, default: '' },
  expected_impact_pct: { type: Number, default: 0 },
  risk_score: { type: Number, default: 0 },
  uncertainty_score: { type: Number, default: 0 },
  confidence_score: { type: Number, default: 0 },
  measurement_window_hours: { type: Number, default: 72 },
  evidence_points: [{ type: String }],
  research_context: { type: String, default: '' },
  confidence: { type: String, enum: ['high', 'medium', 'low'] },
  agent_type: { type: String, enum: ['scaling', 'performance', 'creative', 'pacing', 'ai_manager', 'brain'], default: null, index: true },
  // Campos para acciones avanzadas
  target_entity_id: { type: String, default: null },
  target_entity_name: { type: String, default: null },
  creative_asset_id: { type: String, default: null },
  new_entity_id: { type: String, default: null },        // ID del nuevo ad set/ad creado
  success: { type: Boolean, default: false },
  error: { type: String, default: null },
  meta_api_response: { type: mongoose.Schema.Types.Mixed },
  executed_at: { type: Date, default: Date.now, index: true },

  // Tracking de impacto: métricas al momento de ejecutar
  metrics_at_execution: {
    roas_7d: { type: Number, default: 0 },
    roas_3d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    spend_7d: { type: Number, default: 0 },
    daily_budget: { type: Number, default: 0 },
    purchases_7d: { type: Number, default: 0 },
    purchase_value_7d: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },

  // Métricas 24 horas después de la ejecución
  metrics_after_1d: {
    roas_7d: { type: Number, default: 0 },
    roas_3d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    spend_7d: { type: Number, default: 0 },
    daily_budget: { type: Number, default: 0 },
    purchases_7d: { type: Number, default: 0 },
    purchase_value_7d: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },
  impact_1d_measured: { type: Boolean, default: false },
  impact_1d_measured_at: { type: Date, default: null },

  // Métricas 3 días después de la ejecución
  metrics_after_3d: {
    roas_7d: { type: Number, default: 0 },
    roas_3d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    spend_7d: { type: Number, default: 0 },
    daily_budget: { type: Number, default: 0 },
    purchases_7d: { type: Number, default: 0 },
    purchase_value_7d: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },

  impact_measured: { type: Boolean, default: false },
  impact_measured_at: { type: Date, default: null },

  // Métricas 7 días después de la ejecución (atribución más completa ~95%)
  metrics_after_7d: {
    roas_7d: { type: Number, default: 0 },
    roas_3d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    spend_7d: { type: Number, default: 0 },
    daily_budget: { type: Number, default: 0 },
    purchases_7d: { type: Number, default: 0 },
    purchase_value_7d: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },
  impact_7d_measured: { type: Boolean, default: false },
  impact_7d_measured_at: { type: Date, default: null },

  // Trazabilidad de aprendizaje de la politica unificada
  learned_at: { type: Date, default: null, index: true },
  learned_reward: { type: Number, default: null },
  learned_bucket: { type: String, default: null }
});

// Índice para buscar acciones recientes por entidad
actionLogSchema.index({ entity_id: 1, executed_at: -1 });

module.exports = mongoose.model('ActionLog', actionLogSchema);
