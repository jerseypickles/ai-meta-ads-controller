const mongoose = require('mongoose');

/**
 * CustomerIntelligence — snapshot diario de inteligencia de cliente/demanda derivada de
 * Shopify (cohortes, LTV, recompra, RFM, producto). Pilar 1 de "Zeus con esteroides":
 * que Zeus vea al CLIENTE, no solo las métricas de ads. (2026-06-05)
 */
const customerIntelligenceSchema = new mongoose.Schema({
  computed_at: { type: Date, default: Date.now },
  window_days: { type: Number },
  data: { type: mongoose.Schema.Types.Mixed } // el objeto completo de inteligencia
});

// TTL: 90 días de historia de snapshots
customerIntelligenceSchema.index({ computed_at: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model('CustomerIntelligence', customerIntelligenceSchema);
