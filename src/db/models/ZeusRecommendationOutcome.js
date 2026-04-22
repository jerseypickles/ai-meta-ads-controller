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

  // Measurement method — Phase 3 Hilo D (2026-04-22).
  // Zeus señaló que T+7d con KPIs (ROAS/CPA) es instrumento equivocado para
  // recs de plumbing/security. Este field selecciona el método correcto.
  //   - kpi_delta: medición tradicional por ROAS/CPA/spend delta (default, apta
  //     para recs de optimization, threshold, refactor que tocan decisiones de
  //     negocio).
  //   - log_firings: cuenta warns del pattern introducido por el fix. Apto para
  //     silent-failure fixes (catch vacio → logger.warn). Requiere log-indexing
  //     futuro — hoy se marca inconclusive_no_auto_instrument.
  //   - regression_check: chequea ausencia de 400s sobre inputs legítimos. Apto
  //     para security fixes (path traversal guards). Requiere instrumentación
  //     de request monitoring — hoy se marca inconclusive_no_auto_instrument.
  //   - manual: requerirá review humano. dead_code / naming / refactors grandes.
  //   - inconclusive_no_auto_instrument: no podemos medir automáticamente todavía.
  measurement_method: {
    type: String,
    enum: ['kpi_delta', 'log_firings', 'regression_check', 'manual', 'inconclusive_no_auto_instrument'],
    default: 'kpi_delta',
    index: true
  },
  // Params específicos del método seleccionado
  // Para log_firings: { pattern: string, file_glob: string, expected_direction: 'positive'|'zero' }
  // Para regression_check: { endpoint: string, test_cases: [...] }
  measurement_params: { type: mongoose.Schema.Types.Mixed, default: null },

  // Mediciones
  measurement_7d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    actual_direction: { type: String, enum: ['up', 'down', 'neutral', 'unknown'], default: 'unknown' },
    actual_magnitude: { type: String, default: '' },
    accuracy_score: { type: Number, default: null }, // 0-1, comparación predicho vs real
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse', 'inconclusive'], default: null }
  },
  measurement_30d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    actual_direction: { type: String, enum: ['up', 'down', 'neutral', 'unknown'], default: 'unknown' },
    accuracy_score: { type: Number, default: null },
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse', 'inconclusive'], default: null }
  },
  measurement_90d: {
    measured_at: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    accuracy_score: { type: Number, default: null },
    verdict: { type: String, enum: ['confirmed', 'partial', 'missed', 'inverse', 'inconclusive'], default: null }
  },

  // Notas post-hoc (Zeus puede agregar cuando reflexiona)
  lessons: [{ type: String }],

  created_at: { type: Date, default: Date.now }
});

zeusRecOutcomeSchema.index({ rec_type: 1, 'measurement_7d.verdict': 1 });

module.exports = mongoose.model('ZeusRecommendationOutcome', zeusRecOutcomeSchema);
