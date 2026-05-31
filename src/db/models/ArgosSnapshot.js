const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════════════════════
// ARGOS — snapshot del análisis del pixel (funnel + salud de eventos).
// Argos Panoptes, "el que todo lo ve": vigila TODOS los eventos del pixel,
// mapea el funnel y detecta eventos rotos / caídas bruscas (pixel/CAPI).
// ═══════════════════════════════════════════════════════════════════════════════

const argosSnapshotSchema = new mongoose.Schema({
  // Funnel del PIXEL (eventos reales: page_view/view_content/add_to_cart/
  // initiate_checkout/purchase) + tasas. Mixed = flexible para evolucionar.
  funnel_7d: { type: mongoose.Schema.Types.Mixed, default: {} },
  funnel_today: { type: mongoose.Schema.Types.Mixed, default: {} },
  rates: { type: mongoose.Schema.Types.Mixed, default: {} },
  window_days: { type: Number, default: 30 },
  pixel_meta: { type: mongoose.Schema.Types.Mixed, default: {} }, // last_fired_time, is_unavailable

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
