const mongoose = require('mongoose');

/**
 * ZeusDirective — Directivas generadas por Zeus (Brain central) para los agentes.
 * Zeus aprende patrones cross-agent y emite directivas que Apollo/Prometheus/Athena leen.
 */
const zeusDirectiveSchema = new mongoose.Schema({
  // Agente destino
  target_agent: {
    type: String,
    enum: ['apollo', 'prometheus', 'athena', 'all'],
    required: true,
    index: true
  },

  // Tipo de directiva
  directive_type: {
    type: String,
    enum: ['prioritize', 'avoid', 'adjust', 'alert', 'insight'],
    required: true
  },

  // Texto legible de la directiva
  directive: { type: String, required: true },

  // Datos estructurados para que el agente consuma programaticamente
  data: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Confianza basada en cantidad de datos
  confidence: { type: Number, default: 0.5, min: 0, max: 1 },

  // Cuantas muestras/datos soportan esta directiva
  based_on_samples: { type: Number, default: 0 },

  // Categoria del aprendizaje
  category: {
    type: String,
    enum: ['creative_pattern', 'test_signal', 'account_pattern', 'cross_agent', 'general'],
    default: 'general'
  },

  // Estado
  active: { type: Boolean, default: true, index: true },

  // Timestamps
  created_at: { type: Date, default: Date.now, index: true },
  expires_at: { type: Date, default: null }, // null = no expira
  last_validated_at: { type: Date, default: null }
});

zeusDirectiveSchema.index({ target_agent: 1, active: 1 });
zeusDirectiveSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model('ZeusDirective', zeusDirectiveSchema);
