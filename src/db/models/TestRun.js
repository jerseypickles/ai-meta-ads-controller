const mongoose = require('mongoose');

/**
 * TestRun — Trackea cada test ad set creado por el Testing Agent.
 * Ciclo: learning (0-2d) -> evaluating (3-5d) -> graduated/killed/expired (final)
 */
const testRunSchema = new mongoose.Schema({
  // Referencia a la propuesta creativa
  proposal_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CreativeProposal', required: true, index: true },

  // Ad set original que necesitaba creativos
  source_adset_id: { type: String, required: true },
  source_adset_name: { type: String, default: '' },

  // Entidades de test creadas en Meta
  test_adset_id: { type: String, required: true, index: true },
  test_adset_name: { type: String, default: '' },
  test_ad_id: { type: String, default: null },
  test_creative_id: { type: String, default: null }, // se reusa al graduar

  // Campana de testing
  campaign_id: { type: String, required: true },

  // Config del test
  daily_budget: { type: Number, default: 10 },
  max_days: { type: Number, default: 7 },

  // Fase del test
  phase: {
    type: String,
    enum: ['learning', 'evaluating', 'graduated', 'killed', 'expired'],
    default: 'learning',
    index: true
  },

  // Timestamps
  launched_at: { type: Date, default: Date.now },
  graduated_at: { type: Date, default: null },
  killed_at: { type: Date, default: null },
  expired_at: { type: Date, default: null },

  // Al graduar: ad creado en el ad set original
  graduation_target_ad_id: { type: String, default: null },

  // Metricas actuales (ultima lectura)
  metrics: {
    spend: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    roas: { type: Number, default: 0 },
    cpa: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    updated_at: { type: Date, default: null }
  },

  // Timeline de evaluaciones
  assessments: [{
    date: { type: Date, default: Date.now },
    day_number: { type: Number },
    phase: { type: String },
    assessment: { type: String },
    metrics_snapshot: { type: mongoose.Schema.Types.Mixed },
    _id: false
  }],

  // Razon de kill/expire
  kill_reason: { type: String, default: '' },

  // Si ya se guardo feedback para Creative Agent
  feedback_saved: { type: Boolean, default: false }
});

testRunSchema.index({ phase: 1, launched_at: -1 });

module.exports = mongoose.model('TestRun', testRunSchema);
