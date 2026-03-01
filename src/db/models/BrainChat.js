const mongoose = require('mongoose');

/**
 * BrainChat — Historial de conversaciones con el Brain.
 * Cada documento es un mensaje en la conversación.
 * El Brain usa el historial reciente como contexto.
 */
const brainChatSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },

  content: { type: String, required: true },

  // Contexto que se inyectó al Brain para esta respuesta
  context_summary: { type: String, default: null },

  // Tokens usados (solo para respuestas del assistant)
  tokens_used: { type: Number, default: 0 },
  ai_model: { type: String, default: null },

  created_at: { type: Date, default: Date.now, index: true }
});

brainChatSchema.index({ created_at: -1 });

module.exports = mongoose.model('BrainChat', brainChatSchema);
