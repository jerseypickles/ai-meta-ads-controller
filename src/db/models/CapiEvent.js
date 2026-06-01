const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════════════════════
// CAPI EVENT — registro de un evento server-side enviado a Meta Conversions API.
// Idempotente por order_id (Shopify reenvía webhooks). Guarda el payload YA
// hasheado (sin PII en claro) + estado de retry. TTL 30d.
// ═══════════════════════════════════════════════════════════════════════════════

const capiEventSchema = new mongoose.Schema({
  order_id: { type: String, required: true, unique: true, index: true }, // numérico de Shopify
  event_id: { type: String, required: true },   // purchase_<orderId> (dedup con navegador)
  event_name: { type: String, default: 'Purchase' },

  // Payload ya construido (user_data hasheado). NO contiene email/teléfono en claro.
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },

  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  next_retry_at: { type: Date, default: Date.now },
  last_error: { type: String, default: '' },

  // Respuesta de Meta (para debug — sin PII)
  events_received: { type: Number, default: null },
  fbtrace_id: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  sent_at: { type: Date, default: null }
});

// TTL 30 días
capiEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
// Para el sweeper de reintentos
capiEventSchema.index({ status: 1, next_retry_at: 1 });

module.exports = mongoose.model('CapiEvent', capiEventSchema);
