const mongoose = require('mongoose');

/**
 * AICreation — Registro de entidades creadas por la IA.
 * Cada vez que se ejecuta duplicate_adset o create_ad desde Centro IA,
 * se crea un registro aqui para seguimiento exclusivo.
 */
const aiCreationSchema = new mongoose.Schema({
  // Que tipo de creacion fue
  creation_type: {
    type: String,
    enum: ['duplicate_adset', 'create_ad', 'create_adset'],
    required: true
  },

  // Entidad nueva creada en Meta
  meta_entity_id: { type: String, required: true, index: true },
  meta_entity_type: { type: String, enum: ['adset', 'ad'], required: true },
  meta_entity_name: { type: String, required: true },

  // Entidad origen (el adset original que se duplico, o el adset donde se creo el ad)
  parent_entity_id: { type: String, required: true },
  parent_entity_name: { type: String, default: '' },

  // Que agente lo recomendo y por que
  agent_type: { type: String, enum: ['scaling', 'performance', 'creative', 'pacing'], required: true },
  reasoning: { type: String, default: '' },
  confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },

  // Detalles especificos de la IA
  duplicate_strategy: { type: String, default: null },
  creative_rationale: { type: String, default: null },
  creative_asset_id: { type: String, default: null },
  ads_paused: [{ type: String }],
  initial_budget: { type: Number, default: 0 },

  // AI-managed ad set (Claude tiene control total)
  managed_by_ai: { type: Boolean, default: false },
  child_ad_ids: [{ type: String }],
  strategy_summary: { type: String, default: '' },
  selected_creative_ids: [{ type: String }],

  // Links a reportes
  report_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentReport', default: null },
  action_log_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ActionLog', default: null },

  // Metricas del padre al momento de crear (baseline para comparar)
  parent_metrics_at_creation: {
    roas_7d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    spend_7d: { type: Number, default: 0 },
    daily_budget: { type: Number, default: 0 }
  },

  // Metricas de la NUEVA entidad a 1d, 3d, 7d
  metrics_1d: {
    roas_7d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 }
  },
  measured_1d: { type: Boolean, default: false },
  measured_1d_at: { type: Date, default: null },

  metrics_3d: {
    roas_7d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 }
  },
  measured_3d: { type: Boolean, default: false },
  measured_3d_at: { type: Date, default: null },

  metrics_7d: {
    roas_7d: { type: Number, default: 0 },
    cpa_7d: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 }
  },
  measured_7d: { type: Boolean, default: false },
  measured_7d_at: { type: Date, default: null },

  // Veredicto automatico (calculado despues de 7d)
  verdict: {
    type: String,
    enum: ['pending', 'positive', 'neutral', 'negative'],
    default: 'pending'
  },
  verdict_reason: { type: String, default: '' },

  // Estado en Meta
  current_status: { type: String, enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'UNKNOWN'], default: 'PAUSED' },

  // === LIFECYCLE MANAGEMENT ===
  // La IA controla todo el ciclo de vida de lo que crea
  lifecycle_phase: {
    type: String,
    enum: [
      'created',        // Recien creado, esperando activacion
      'activating',     // Activandose (se acaba de poner ACTIVE)
      'learning',       // En learning phase — NO TOCAR
      'evaluating',     // Learning terminada, evaluando rendimiento
      'scaling',        // Rindiendo bien, la IA decidio escalar
      'stable',         // Rindiendo ok, mantener
      'killing',        // Rindiendo mal, la IA decidio pausar/matar
      'dead'            // Pausado/archivado por la IA
    ],
    default: 'created'
  },
  lifecycle_phase_changed_at: { type: Date, default: Date.now },

  // Configuracion de learning phase
  learning_phase_days: { type: Number, default: 3 },       // Dias de learning phase (no tocar)
  activate_after_hours: { type: Number, default: 1 },       // Horas despues de crear para activar
  activated_at: { type: Date, default: null },               // Cuando se activo
  learning_ends_at: { type: Date, default: null },           // Cuando termina learning phase

  // Acciones automaticas que la IA tomo sobre esta entidad
  lifecycle_actions: [{
    action: { type: String },           // activate, scale_up, scale_down, pause, kill
    value: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String },
    executed_at: { type: Date, default: Date.now }
  }],

  // Budget actual (se actualiza cuando la IA escala)
  current_budget: { type: Number, default: 0 },

  // Manager assessment (ultimo check del AI manager)
  last_manager_assessment: { type: String, default: '' },
  last_manager_frequency_status: { type: String, default: 'unknown' },
  last_manager_creative_health: { type: String, default: '' },
  last_manager_needs_new_creatives: { type: Boolean, default: false },
  last_manager_creative_rotation_needed: { type: Boolean, default: false },
  last_manager_suggested_styles: [{ type: String }],
  last_manager_frequency_detail: { type: String, default: '' },
  last_manager_check: { type: Date, default: null },

  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
});

aiCreationSchema.index({ creation_type: 1, created_at: -1 });
aiCreationSchema.index({ verdict: 1 });
aiCreationSchema.index({ measured_7d: 1 });
aiCreationSchema.index({ lifecycle_phase: 1 });

module.exports = mongoose.model('AICreation', aiCreationSchema);
