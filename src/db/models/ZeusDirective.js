const mongoose = require('mongoose');

/**
 * ZeusDirective — Directivas generadas por Zeus (Brain central) para los agentes.
 * Zeus aprende patrones cross-agent y emite directivas que Apollo/Prometheus/Athena leen.
 */
const zeusDirectiveSchema = new mongoose.Schema({
  // Agente destino
  target_agent: {
    type: String,
    enum: ['apollo', 'prometheus', 'athena', 'ares', 'all'],
    required: true,
    index: true
  },

  // Tipo de directiva
  directive_type: {
    type: String,
    enum: ['prioritize', 'avoid', 'adjust', 'alert', 'insight', 'force_graduate', 'force_duplicate', 'pause_clone'],
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

  // Scope explícito de actions que esta directiva bloquea.
  // Si null/undefined, directive-guard parsea el texto (retrocompat).
  // Si es array, directive-guard SOLO bloquea esos action_types específicos.
  //
  // Usar action_scope es MÁS PRECISO que parseo de texto. El learner debe
  // setear esto cuando emita avoids — ej. 'force_duplicate' (acción propia
  // del learner/creador) NO bloquea 'duplicate_adset' (acción autónoma del
  // portfolio-manager que tiene sus propios safety gates).
  //
  // Añadido 2026-04-24 para resolver: el guardrail del learner
  // "No new duplications" bloqueaba todo duplicado, incluyendo los que
  // Portfolio/Brain ejecutan con thresholds propios distintos.
  action_scope: {
    type: [String],
    default: null
  },

  // Flag que indica si Ares Brain (LLM) puede hacer override con reasoning
  // documentado. Las directivas del learner suelen ser guidance que el brain
  // puede cuestionar si su evidencia lo justifica. Las directivas del creador
  // (source=chat) nunca deben ser override-ables.
  llm_can_override: {
    type: Boolean,
    default: false
  },

  // Origen de la directiva. Permite al learner respetar directivas manuales
  // del creador (source='chat') y no crear contradictorias.
  //   chat      → creada por el creador desde el Zeus chat via handleCreateDirective
  //   learner   → generada por el cron del learner (zeus-learner.js)
  //   proactive → emitida en ciclo proactivo de Zeus
  //   system    → creada por otro subsistema (default para retrocompat)
  source: {
    type: String,
    enum: ['chat', 'learner', 'proactive', 'system'],
    default: 'system',
    index: true
  },

  // Estado
  active: { type: Boolean, default: true, index: true },
  persistent: { type: Boolean, default: false }, // Si true, el cron cleanup NO la desactiva aunque expire

  // Tracking de ejecucion (problema 1: Zeus debe saber que sus directivas ya fueron cumplidas)
  executed: { type: Boolean, default: false, index: true },
  executed_at: { type: Date, default: null },
  executed_by_action_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ActionLog', default: null },
  execution_result: { type: String, default: null }, // ej: "scaled 41.98 → 48.28"

  // Timestamps
  created_at: { type: Date, default: Date.now, index: true },
  expires_at: { type: Date, default: null }, // null = no expira
  last_validated_at: { type: Date, default: null }
});

zeusDirectiveSchema.index({ target_agent: 1, active: 1 });
zeusDirectiveSchema.index({ category: 1, active: 1 });

module.exports = mongoose.model('ZeusDirective', zeusDirectiveSchema);
