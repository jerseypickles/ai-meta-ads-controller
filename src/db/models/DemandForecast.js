const mongoose = require('mongoose');

/**
 * DemandForecast — snapshot del forecast de demanda (Pilar 2 "Zeus con esteroides").
 * Predice próximos 7/30/90d desde la serie diaria de Shopify (DemeterSnapshot.total_sales),
 * con estacionalidad por día-de-semana + tendencia + eventos estacionales. Para que Zeus
 * ANTICIPE (pre-posicionar budget/creativos) en vez de reaccionar a ayer. (2026-06-05)
 */
const demandForecastSchema = new mongoose.Schema({
  computed_at: { type: Date, default: Date.now },
  data: { type: mongoose.Schema.Types.Mixed }
});
demandForecastSchema.index({ computed_at: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model('DemandForecast', demandForecastSchema);
