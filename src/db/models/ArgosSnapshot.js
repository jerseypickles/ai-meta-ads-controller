const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════════════════════
// ARGOS — snapshot del análisis del pixel (funnel + salud de eventos).
// Argos Panoptes, "el que todo lo ve": vigila TODOS los eventos del pixel,
// mapea el funnel y detecta eventos rotos / caídas bruscas (pixel/CAPI).
// ═══════════════════════════════════════════════════════════════════════════════

const funnelStep = {
  impressions: { type: Number, default: 0 },
  link_clicks: { type: Number, default: 0 },
  landing_page_view: { type: Number, default: 0 },
  view_content: { type: Number, default: 0 },
  add_to_cart: { type: Number, default: 0 },
  initiate_checkout: { type: Number, default: 0 },
  purchase: { type: Number, default: 0 },
  spend: { type: Number, default: 0 },
  purchase_value: { type: Number, default: 0 }
};

const argosSnapshotSchema = new mongoose.Schema({
  // Funnel por ventana (eventos crudos del pixel a nivel cuenta)
  funnel_today: funnelStep,
  funnel_7d: funnelStep,

  // Tasas de conversión entre pasos (0-100). Calculadas sobre la ventana 7d.
  rates: {
    click_to_lpv: { type: Number, default: 0 },     // link_clicks → landing_page_view
    lpv_to_vc: { type: Number, default: 0 },         // landing_page_view → view_content
    vc_to_atc: { type: Number, default: 0 },         // view_content → add_to_cart
    atc_to_ic: { type: Number, default: 0 },         // add_to_cart → initiate_checkout
    ic_to_purchase: { type: Number, default: 0 }     // initiate_checkout → purchase
  },

  // Issues detectados (eventos rotos / caídas / cuellos de botella del funnel)
  issues: [{
    severity: { type: String, enum: ['critical', 'warning', 'info'], default: 'info' },
    kind: { type: String, default: '' },        // broken_event | event_drop | funnel_bottleneck | healthy
    event: { type: String, default: '' },        // qué evento/paso
    message: { type: String, default: '' },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} }
  }],

  health_score: { type: Number, default: 100 }, // 0-100 salud global del pixel
  pixel_id: { type: String, default: '' },
  created_at: { type: Date, default: Date.now, index: true }
});

// TTL 90 días
argosSnapshotSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('ArgosSnapshot', argosSnapshotSchema);
