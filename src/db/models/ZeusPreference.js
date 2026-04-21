const mongoose = require('mongoose');

/**
 * ZeusPreference — memoria persistente del creador que Zeus aprende y recuerda.
 * Se inyecta en el system prompt de CADA conversación para que Zeus
 * mantenga consistencia de preferencias, prioridades y contexto operacional.
 */
const zeusPreferenceSchema = new mongoose.Schema({
  // Identificador único de la preferencia (ej "priority_metric", "response_style", "freeze_window_apr")
  key: { type: String, required: true, unique: true, index: true },

  // Valor o descripción libre (string para simplicidad y legibilidad en prompt)
  value: { type: String, required: true },

  // Categoría para filtrar/priorizar
  category: {
    type: String,
    enum: ['priority', 'style', 'strategic', 'operational', 'habit', 'constraint', 'other'],
    default: 'other',
    index: true
  },

  // Explicación humana de por qué esta preferencia existe
  context: { type: String, default: '' },

  // Confianza 0-1 (qué tan seguro está Zeus de esta preferencia)
  confidence: { type: Number, default: 0.8, min: 0, max: 1 },

  // Trazabilidad
  source_conversation_id: { type: String, default: null },
  source_message: { type: String, default: '' }, // extracto del mensaje del que se inferió

  // Origen — explícito (creador lo dijo) vs auto-detected (Zeus lo infirió de patrones)
  source: {
    type: String,
    enum: ['explicit', 'auto_detected'],
    default: 'explicit',
    index: true
  },

  // Estado: proposed (Zeus lo sugirió, creador aún no confirma)
  //         active   (confirmado/explícito, se inyecta en context)
  //         rejected (creador dijo que no)
  status: {
    type: String,
    enum: ['proposed', 'active', 'rejected'],
    default: 'active',
    index: true
  },

  // Para propuestas auto-detected — evidencia concreta de por qué Zeus cree esto
  evidence: {
    summary: { type: String, default: '' },
    datapoints: [{ type: String }],      // 2-3 líneas concretas que soportan
    observed_in: { type: Number, default: 0 }, // # conversaciones donde apareció el patrón
    _id: false
  },

  // Gestión
  active: { type: Boolean, default: true, index: true },
  last_referenced_at: { type: Date, default: null },
  reference_count: { type: Number, default: 0 },

  // Decisión del creador sobre propuestas
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },

  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
});

zeusPreferenceSchema.index({ active: 1, category: 1, updated_at: -1 });

module.exports = mongoose.model('ZeusPreference', zeusPreferenceSchema);
