const mongoose = require('mongoose');

/**
 * ZeusChatMessage — Conversación del creador con Zeus (Oracle mode).
 * Cada documento es un mensaje; conversation_id agrupa el hilo.
 */
const zeusChatMessageSchema = new mongoose.Schema({
  conversation_id: { type: String, required: true, index: true },

  role: {
    type: String,
    enum: ['user', 'assistant', 'system_greeting'],
    required: true
  },

  content: { type: String, default: '' },

  // Tool calls que hizo Zeus para responder (solo para role=assistant)
  tool_calls: [{
    tool: { type: String },
    input: { type: mongoose.Schema.Types.Mixed, default: {} },
    result_summary: { type: String, default: '' },
    _id: false
  }],

  // Contexto base usado (solo primer mensaje de la conversación)
  context_snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

  tokens_used: { type: Number, default: 0 },
  ai_model: { type: String, default: null },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusChatMessageSchema.index({ conversation_id: 1, created_at: 1 });

module.exports = mongoose.model('ZeusChatMessage', zeusChatMessageSchema);
