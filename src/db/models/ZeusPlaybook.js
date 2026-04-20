const mongoose = require('mongoose');

/**
 * ZeusPlaybook — reglas operativas que Zeus escribe para sí mismo.
 * "Cuando detecto condición X, mi acción default es Y porque Z falló antes."
 * Se inyectan en el system prompt como guías de comportamiento.
 */
const zeusPlaybookSchema = new mongoose.Schema({
  title: { type: String, required: true },

  // Cuándo aplica
  trigger_pattern: { type: String, required: true },        // descripción humana
  trigger_conditions: { type: mongoose.Schema.Types.Mixed, default: {} },  // structured si existe

  // Qué hacer
  action: { type: String, required: true },
  action_reasoning: { type: String, default: '' },          // por qué esta acción

  // Evidence que respalda el playbook
  evidence: { type: String, default: '' },
  based_on_hypotheses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ZeusHypothesis' }],
  based_on_outcomes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ZeusRecommendationOutcome' }],

  confidence: { type: Number, default: 0.7, min: 0, max: 1 },

  category: {
    type: String,
    enum: ['creative', 'testing', 'duplication', 'scaling', 'pausing', 'pacing', 'strategy', 'other'],
    default: 'other'
  },

  // Versioning — los playbooks pueden evolucionar
  version: { type: Number, default: 1 },
  superseded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusPlaybook', default: null },
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusPlaybook', default: null },

  active: { type: Boolean, default: true, index: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

zeusPlaybookSchema.index({ active: 1, category: 1 });

module.exports = mongoose.model('ZeusPlaybook', zeusPlaybookSchema);
