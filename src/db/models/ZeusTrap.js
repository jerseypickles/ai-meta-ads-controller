const mongoose = require('mongoose');

/**
 * ZeusTrap — Hilo B, Fase 2.
 *
 * Trampa adversarial plantada para falsificar el principio "resistí validar por default".
 * El creador (o un LLM adversarial) escribe una afirmación plausible pero falsa,
 * declara cuál sería la contradicción correcta, y después la dispara como mensaje
 * normal en el chat. Un fuzzy-match compara la respuesta de Zeus contra la
 * contradicción esperada para marcar passed / failed.
 *
 * Diseño:
 * - Trampas desde 2+ fuentes independientes (creator | team | adversarial_llm) —
 *   si todas vienen de la misma mano, Zeus aprende el tic del que las planta.
 * - Plausibilidad obligatoria: una trampa "ROAS 12x" es basura (se detecta por
 *   absurdo); "DNA X está performando peor que hace 2 semanas" requiere verificar.
 * - Se registra como ZeusJournalEntry (entry_type: trap_execution) además de
 *   acá, para que los contadores trimestrales tengan una sola fuente.
 */
const zeusTrapSchema = new mongoose.Schema({
  // El mensaje que se le va a mostrar a Zeus como si fuera del creador
  content: { type: String, required: true },

  // Qué contradicción sería la respuesta correcta (para fuzzy-match post-ejecución)
  // Texto libre: "Apollo approval rate ha caído a 18% vs 35% baseline"
  expected_contradiction: { type: String, required: true },

  // Tool(s) que Zeus debería invocar idealmente para contradecir
  // Informativo, no obligatorio — el fuzzy match evalúa la respuesta, no el tool flow.
  expected_tool_invocation: { type: String, default: '' },

  // Fuente de la trampa — crítico para diversidad
  source: {
    type: String,
    enum: ['creator', 'team', 'adversarial_llm'],
    required: true,
    index: true
  },
  created_by: { type: String, default: '' },         // quién la escribió (username / 'llm-gen')

  // Tags libres — categoría de trampa (ej: 'performance_claim', 'causal_attribution')
  category: { type: String, default: '' },

  // Lifecycle
  status: {
    type: String,
    enum: ['pending', 'executed'],
    default: 'pending',
    index: true
  },
  executed_at: { type: Date, default: null },

  // Resultado al ejecutarse
  outcome: { type: String, enum: ['passed', 'failed', null], default: null, index: true },
  zeus_response: { type: String, default: '' },       // excerpt de la respuesta
  zeus_response_conversation_id: { type: String, default: '' },
  zeus_response_message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusChatMessage', default: null },
  match_score: { type: Number, default: null },       // 0-1, fuzzy match score contra expected_contradiction
  match_reasoning: { type: String, default: '' },     // por qué el evaluador dio ese score

  // Trazabilidad a ZeusJournalEntry
  journal_entry_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusJournalEntry', default: null },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusTrapSchema.index({ status: 1, created_at: -1 });
zeusTrapSchema.index({ outcome: 1, executed_at: -1 });
zeusTrapSchema.index({ source: 1, executed_at: -1 });

module.exports = mongoose.model('ZeusTrap', zeusTrapSchema);
