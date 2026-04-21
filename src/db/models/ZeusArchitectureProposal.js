const mongoose = require('mongoose');

/**
 * ZeusArchitectureProposal — Lens 3 del Code Sentinel.
 *
 * Zeus identifica bottlenecks en la arquitectura del sistema y propone
 * opciones con tradeoffs. Incluye la posibilidad de proponer crear un
 * NUEVO agente. El creador decide entre opciones A/B/C o no-op.
 *
 * NO se auto-ejecuta — requiere aprobación humana explícita.
 */
const zeusArchitectureProposalSchema = new mongoose.Schema({
  bottleneck: {
    title: { type: String, required: true },       // ej: "Apollo low approval rate"
    description: { type: String, default: '' },    // 2-3 oraciones
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },  // métricas que lo soportan
    evidence_summary: { type: String, default: '' }
  },

  options: [{
    label: String,                                 // "A", "B", "C"
    approach: String,                              // ej: "critic-agent pre-filtro"
    description: String,                           // detalle de la propuesta
    cost: { type: String, enum: ['bajo', 'medio', 'alto'], default: 'medio' },
    risk: { type: String, enum: ['bajo', 'medio', 'alto'], default: 'medio' },
    expected_value: { type: String, enum: ['bajo', 'medio', 'alto'], default: 'medio' },
    effort_days: Number,                           // días-dev estimados
    notes: String,
    _id: false
  }],

  recommended: { type: String, default: '' },     // label de la opción recomendada (ej "A")
  reasoning: { type: String, default: '' },        // por qué recomendada

  triggered_by: {
    type: String,
    enum: ['weekly_reflection', 'pattern_repeat', 'manual', 'plan_generation'],
    default: 'weekly_reflection',
    index: true
  },
  triggered_context: { type: mongoose.Schema.Types.Mixed, default: {} },

  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
    index: true
  },

  status: {
    type: String,
    enum: ['draft', 'reviewing', 'accepted', 'rejected', 'built', 'superseded'],
    default: 'draft',
    index: true
  },

  // Decisión del creador
  creator_decision: { type: String, default: '' },  // label elegido ('A', 'B', 'no-op')
  creator_note: { type: String, default: '' },
  decided_at: { type: Date, default: null },

  // Tracking post-build (L1 loop)
  built_at: { type: Date, default: null },
  outcome_tracking: {
    measured_at_7d: Date,
    measured_at_30d: Date,
    actual_impact: String,                          // narrative
    validated: Boolean                              // ¿la apuesta pagó?
  },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusArchitectureProposalSchema.index({ status: 1, created_at: -1 });
zeusArchitectureProposalSchema.index({ severity: 1, status: 1 });

module.exports = mongoose.model('ZeusArchitectureProposal', zeusArchitectureProposalSchema);
