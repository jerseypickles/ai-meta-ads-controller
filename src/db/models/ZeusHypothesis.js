const mongoose = require('mongoose');

/**
 * ZeusHypothesis — lifecycle completo de una hipótesis:
 * proposed → testing → confirmed/rejected/inconclusive.
 * Zeus forma hipótesis observando data, comisiona tests a Prometheus
 * para validarlas, lee resultados y actualiza priors bayesianos.
 */
const zeusHypothesisSchema = new mongoose.Schema({
  statement: { type: String, required: true },           // "scenes con gente outperforman las que no tienen"
  prediction: { type: String, default: '' },              // "ROAS +20% promedio"

  // Priors bayesianos
  prior_before: { type: Number, default: 0.5, min: 0, max: 1 },   // creencia inicial
  prior_after: { type: Number, default: null, min: 0, max: 1 },   // post-validación

  // Diseño experimental
  test_strategy: { type: String, default: '' },           // cómo se va a validar
  variable_tested: { type: String, default: '' },         // ej: "presence_of_people"
  control_value: { type: String, default: '' },           // ej: "sin gente"
  treatment_value: { type: String, default: '' },         // ej: "con gente"
  min_samples_needed: { type: Number, default: 6 },

  // Tests comisionados (TestRun o CreativeProposal IDs que validan)
  commissioned_tests: [{
    ref_id: String,
    ref_type: { type: String, enum: ['test_run', 'creative_proposal', 'adset'] },
    group: { type: String, enum: ['control', 'treatment'] },
    assigned_at: Date
  }],

  // Log de evidencia que se acumula
  evidence_log: [{
    at: { type: Date, default: Date.now },
    source: String,                                       // "TestRun completion"
    data: mongoose.Schema.Types.Mixed,
    points_toward: { type: String, enum: ['confirm', 'reject', 'inconclusive'] }
  }],

  // Estado
  status: {
    type: String,
    enum: ['proposed', 'designed', 'testing', 'analyzing', 'confirmed', 'rejected', 'inconclusive', 'abandoned'],
    default: 'proposed',
    index: true
  },

  // Categorización
  category: {
    type: String,
    enum: ['creative', 'targeting', 'budget', 'timing', 'copy', 'scene', 'product', 'meta_pattern', 'other'],
    default: 'other',
    index: true
  },

  // Vida
  created_at: { type: Date, default: Date.now, index: true },
  test_started_at: { type: Date, default: null },
  concluded_at: { type: Date, default: null },
  target_conclusion_date: { type: Date, default: null },

  // Fuente
  source_conversation_id: { type: String, default: null },
  generated_by: { type: String, enum: ['zeus', 'learner_cron', 'creator'], default: 'zeus' }
});

zeusHypothesisSchema.index({ status: 1, category: 1 });

module.exports = mongoose.model('ZeusHypothesis', zeusHypothesisSchema);
