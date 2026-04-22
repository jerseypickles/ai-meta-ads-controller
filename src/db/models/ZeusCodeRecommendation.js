const mongoose = require('mongoose');

/**
 * ZeusCodeRecommendation — sugerencias concretas de Zeus sobre cambios al código,
 * grounded en evidencia de datos reales del sistema.
 */
const zeusCodeRecSchema = new mongoose.Schema({
  // Ubicación en el código
  file_path: { type: String, required: true, index: true },
  line_start: { type: Number, default: null },
  line_end: { type: Number, default: null },

  // El cambio propuesto
  current_code: { type: String, default: '' },     // snippet actual
  proposed_code: { type: String, default: '' },    // cómo debería quedar
  rationale: { type: String, required: true },    // por qué cambiar

  // Evidencia de los datos — JSON libre con métricas/hallazgos que soportan el cambio
  evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
  evidence_summary: { type: String, default: '' }, // resumen legible

  // Impacto esperado (opcional)
  expected_impact: { type: String, default: '' },

  // Categorización
  category: {
    type: String,
    enum: [
      'threshold', 'bug', 'optimization', 'dead_code', 'refactor', 'safety', 'naming',
      'phase_followup',  // recordatorio temporal: activar siguiente fase de un feature en X días
      'other'
    ],
    default: 'other',
    index: true
  },
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
    index: true
  },

  // Estado
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'applied'],
    default: 'pending',
    index: true
  },

  // Trazabilidad
  source_conversation_id: { type: String, default: null, index: true },
  source_message_id: { type: String, default: null },
  reviewed_at: { type: Date, default: null },
  review_note: { type: String, default: '' },

  // Sentinel tagging — cuando la rec viene de una pasada del code-sentinel
  lens: {
    type: String,
    enum: ['vulnerability', 'plan_readiness', 'architecture', 'manual', null],
    default: null,
    index: true
  },
  sub_lens: {
    type: String,
    enum: ['security', 'silent_failures', 'config_drift', 'calibration', 'prompt_drift', null],
    default: null,
    index: true
  },
  audit_run_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusAuditRun', default: null, index: true },

  // Verificación automática al marcar 'applied'
  verification: {
    syntactic_status: {
      type: String,
      enum: ['verified', 'not_applied', 'diverged', 'file_not_found', 'skipped', null],
      default: null
    },
    syntactic_notes: { type: String, default: '' },
    syntactic_checked_at: { type: Date, default: null },
    outcome_tracking_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusRecommendationOutcome', default: null }
  },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusCodeRecSchema.index({ status: 1, created_at: -1 });
zeusCodeRecSchema.index({ category: 1, severity: 1, status: 1 });
zeusCodeRecSchema.index({ lens: 1, sub_lens: 1, created_at: -1 });

module.exports = mongoose.model('ZeusCodeRecommendation', zeusCodeRecSchema);
