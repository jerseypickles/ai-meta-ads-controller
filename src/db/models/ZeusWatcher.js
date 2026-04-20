const mongoose = require('mongoose');

/**
 * ZeusWatcher — condición que Zeus monitorea para avisar al creador
 * cuando se cumple (ej: "avisame cuando vuelva a gastar").
 */
const zeusWatcherSchema = new mongoose.Schema({
  // Qué condición chequear
  condition_type: {
    type: String,
    enum: [
      'delivery_resumed',    // spend_today cruza threshold después de no-delivery
      'spend_above',         // total spend_today cruza X
      'roas_above',          // portfolio ROAS cruza por arriba
      'roas_below',          // portfolio ROAS cae por debajo
      'adset_spend_above',   // un adset específico cruza spend
      'adset_roas_above',    // un adset específico cruza ROAS
      'test_graduates',      // cualquier test gradúa
      'test_count',          // cantidad de tests activos cruza X
      'custom'               // LLM evalúa condición libre (experimental)
    ],
    required: true
  },

  // Params específicos del tipo
  condition_params: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Descripción humana de la condición (para el msg cuando dispara)
  description: { type: String, required: true },

  // Conversación donde mandar el ping cuando dispare
  conversation_id: { type: String, default: null },

  // Creada por el creador via chat
  created_via: { type: String, enum: ['chat', 'system'], default: 'chat' },
  source_message: { type: String, default: '' },

  // Estado
  active: { type: Boolean, default: true, index: true },
  triggered_at: { type: Date, default: null },
  trigger_result: { type: mongoose.Schema.Types.Mixed, default: null },

  // Lifecycle
  expires_at: { type: Date, default: null, index: true },
  created_at: { type: Date, default: Date.now, index: true }
});

zeusWatcherSchema.index({ active: 1, triggered_at: 1 });

module.exports = mongoose.model('ZeusWatcher', zeusWatcherSchema);
