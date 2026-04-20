const mongoose = require('mongoose');

/**
 * ZeusRecommendationOutcome — trackea el IMPACTO REAL de cada recomendación
 * que Zeus hizo y el creador aplicó. Base del Nivel 1 (Learner).
 *
 * Ciclo: creada → applied_at seteado → 7d/30d/90d measurements →
 *        accuracy calculada vs predicción → agregada al calibration stats.
 */
const zeusRecOutcomeSchema = new mongoose.Schema({
  // Referencia a la recomendación source (puede ser ZeusCodeRecommendation
  // o BrainRecommendation u otra — genérico)
  rec_id: { type: String, required: true, index: true },
  rec_type: {
    type: String,
    enum: ['code_change', 'directive', 'strategic', 'tactical', 'creative', 'budget', 'test', 'pause', 'scale', 'other'],
    default: 'other',
    index: true
  },
  category: { type: String, default: 'general', index: true },

  // Predicción original de Zeus (free-form)
  predicted_impact: { type: String, default: '' },
  predicted_direction: { type: String, enum: ['up', 'down', 'neutral', 'unknown'], default: 'unknown' },
  predicted_magnitude: { type: String, default: '' }, // ej: "+15% ROAS 7d"

  // Entity afectada (si aplica)
  entity_type: { type: String, default: '' },
  entity_id: { type: String, default: '' },
  entity_name: { type: String, default: '' },

  // Baseline al momento de aplicar
  baseline: { type: mongoose.Schema.Types.Mixed, default: {} },
  applied_at: { type: Date, required: true, index: true },

  // Mediciones
  measurement_7d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    actual_direction: { type: String, enum: ['up', 'down', 'neutral', 'unknown'], default: 'unknown' },
    actual_magnitude: { type: String, default: '' },
    accuracy_score: { type: Number, default: null }, // 0-1, comparación predicho vs real
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse'], default: null }
  },
  measurement_30d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    actual_direction: { type: String, enum: ['up', 'down', 'neutral', 'unknown'], default: 'unknown' },
    accuracy_score: { type: Number, default: null },
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse'], default: null }
  },
  measurement_90d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    accuracy_score: { type: Number, default: null },
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse'], default: null }
  },

  // Notas post-hoc (Zeus puede agregar cuando reflexiona)
  lessons: [{ type: String }],

  created_at: { type: Date, default: Date.now }
});

zeusRecOutcomeSchema.index({ rec_type: 1, 'measurement_7d.verdict': 1 });

module.exports = mongoose.model('ZeusRecommendationOutcome', zeusRecOutcomeSchema);
