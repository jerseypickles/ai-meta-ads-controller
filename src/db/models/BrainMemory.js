const mongoose = require('mongoose');

/**
 * BrainMemory — Estado recordado de cada entidad.
 * El Brain compara el estado actual vs el último recordado
 * para detectar cambios significativos sin repetir ruido.
 */
const brainMemorySchema = new mongoose.Schema({
  entity_type: {
    type: String,
    enum: ['campaign', 'adset', 'ad', 'account'],
    required: true,
    index: true
  },
  entity_id: { type: String, required: true, unique: true, index: true },
  entity_name: { type: String, required: true },

  // Último estado conocido
  last_status: { type: String, default: 'ACTIVE' },
  last_daily_budget: { type: Number, default: 0 },

  // Métricas recordadas (las últimas que el Brain "vio")
  remembered_metrics: {
    spend_7d: { type: Number, default: 0 },
    roas_7d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    ctr_7d: { type: Number, default: 0 },
    frequency_7d: { type: Number, default: 0 },
    purchases_7d: { type: Number, default: 0 },
    reach_7d: { type: Number, default: 0 },
    spend_today: { type: Number, default: 0 },
    roas_today: { type: Number, default: 0 }
  },

  // Tendencias observadas
  trends: {
    roas_direction: { type: String, enum: ['improving', 'stable', 'declining', 'unknown'], default: 'unknown' },
    spend_direction: { type: String, enum: ['increasing', 'stable', 'decreasing', 'unknown'], default: 'unknown' },
    consecutive_decline_days: { type: Number, default: 0 },
    consecutive_improve_days: { type: Number, default: 0 }
  },

  // Historial de acciones ejecutadas en esta entidad con resultado medido
  // Permite al Brain aprender qué funciona para CADA entidad específica
  action_history: [{
    action_type: { type: String, required: true },   // scale_up, pause, creative_refresh, etc.
    executed_at: { type: Date, required: true },
    result: { type: String, enum: ['improved', 'worsened', 'neutral'], required: true },
    roas_delta_pct: { type: Number, default: 0 },    // +12.5 o -8.3
    cpa_delta_pct: { type: Number, default: 0 },
    context: { type: String, default: '' },           // "high_frequency", "declining_roas", etc.
    concurrent_actions: [{ type: String }],           // Fix 3: e.g. ['scale_up', 'creative_refresh']
    attribution: { type: String, enum: ['sole', 'shared'], default: 'sole' }, // Fix 3: was this result shared?
    _id: false
  }],

  // Contadores de insights generados para esta entidad
  insights_generated: { type: Number, default: 0 },
  last_insight_at: { type: Date, default: null },
  last_insight_id: { type: mongoose.Schema.Types.ObjectId, default: null },

  // ═══ Account Agent assessment fields ═══
  agent_assessment: { type: String, default: '' },
  agent_frequency_status: { type: String, enum: ['ok', 'moderate', 'high', 'critical', 'unknown'], default: 'unknown' },
  agent_creative_health: { type: String, default: '' },
  agent_needs_new_creatives: { type: Boolean, default: false },
  agent_performance_trend: { type: String, enum: ['improving', 'stable', 'declining', 'learning', 'unknown'], default: 'unknown' },
  agent_last_check: { type: Date, default: null },
  agent_next_review_at: { type: Date, default: null },
  agent_pending_plan: { type: String, default: '' },

  // Timestamps
  first_seen_at: { type: Date, default: Date.now },
  last_updated_at: { type: Date, default: Date.now }
});

brainMemorySchema.index({ entity_type: 1, last_updated_at: -1 });
brainMemorySchema.index({ agent_last_check: -1 });

module.exports = mongoose.model('BrainMemory', brainMemorySchema);
