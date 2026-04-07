const mongoose = require('mongoose');

/**
 * ZeusConversation — Log de comunicacion entre Zeus y los agentes.
 * Zeus envia directivas, agentes reportan como las aplicaron.
 */
const zeusConversationSchema = new mongoose.Schema({
  // Quien habla
  from: { type: String, enum: ['zeus', 'athena', 'apollo', 'prometheus'], required: true, index: true },
  to: { type: String, enum: ['zeus', 'athena', 'apollo', 'prometheus', 'all'], required: true },

  // Mensaje
  message: { type: String, required: true },

  // Contexto (datos que soportan el mensaje)
  context: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Tipo de mensaje
  type: {
    type: String,
    enum: ['directive', 'report', 'acknowledgment', 'alert', 'thought'],
    default: 'report'
  },

  // Ciclo de referencia
  cycle_id: { type: String, default: '' },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusConversationSchema.index({ created_at: -1 });

module.exports = mongoose.model('ZeusConversation', zeusConversationSchema);
