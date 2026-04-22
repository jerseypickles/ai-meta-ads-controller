const mongoose = require('mongoose');

/**
 * CBOHealthSnapshot — Estado de salud de una CBO capturado cada 2 horas.
 *
 * Diseñado para resolver el ángulo ciego de Ares: hoy razona sobre adsets
 * individuales pero nunca sobre la CBO como unidad. Este snapshot agrega por
 * parent_campaign_id y expone: concentración de spend, favorito actual,
 * adsets starved, trend de ROAS de la CBO, y señales compuestas de colapso.
 *
 * El monitor corre cada 2h vía cron propio (desacoplado de ares-agent), así
 * mantenemos 12 data points/día → detección de colapso en ~4-6h en vez de
 * 12-24h si estuviera atado al ciclo de Ares.
 *
 * Fase 1: observabilidad pura. Ares lo lee pero no decide basado en esto
 * todavía. Fase 2 activa el gate compuesto.
 */
const cboHealthSnapshotSchema = new mongoose.Schema({
  // Identidad CBO
  campaign_id: { type: String, required: true, index: true },
  campaign_name: { type: String, default: '' },
  snapshot_at: { type: Date, default: Date.now },   // indexed below via TTL + compound

  // Clasificación: zombie = CBO ACTIVE con 0 adsets activos (budget asignado
  // pero no genera spend porque Meta no tiene dónde distribuir).
  is_zombie: { type: Boolean, default: false, index: true },

  // Agregado CBO
  daily_budget: { type: Number, default: 0 },
  active_adsets_count: { type: Number, default: 0 },
  // Métrica propuesta por el creador — $ diarios por adset activo.
  // <$15 con >=6 adsets = starvation estructural (subir +$30 es inútil).
  budget_pulse: { type: Number, default: 0 },

  // ROAS por ventana (agregado de adsets hijos)
  cbo_roas_1d: { type: Number, default: 0 },
  cbo_roas_3d: { type: Number, default: 0 },
  cbo_roas_7d: { type: Number, default: 0 },
  cbo_spend_1d: { type: Number, default: 0 },
  cbo_spend_3d: { type: Number, default: 0 },
  cbo_spend_7d: { type: Number, default: 0 },
  cbo_revenue_1d: { type: Number, default: 0 },
  cbo_revenue_3d: { type: Number, default: 0 },
  cbo_revenue_7d: { type: Number, default: 0 },

  // Concentración: % del spend capturado por el top adset
  concentration_index_1d: { type: Number, default: 0 },  // 0-1
  concentration_index_3d: { type: Number, default: 0 },
  // Flag compuesto — sostenido >80% durante los 3 días
  concentration_sustained_3d: { type: Boolean, default: false },

  // Favorito (top adset por spend 3d)
  favorite_adset_id: { type: String, default: null },
  favorite_adset_name: { type: String, default: '' },
  // Tenure = días que el mismo adset viene siendo el favorito
  // En backfill: calculado mirando snapshots históricos de MetricSnapshot
  favorite_since: { type: Date, default: null },
  favorite_tenure_days: { type: Number, default: 0 },
  favorite_roas_3d: { type: Number, default: 0 },
  favorite_roas_7d: { type: Number, default: 0 },
  favorite_freq: { type: Number, default: 0 },
  favorite_spend_share_3d: { type: Number, default: 0 },  // 0-1
  // Flag compuesto — ROAS 3d del favorito < ROAS 7d (saturando)
  favorite_declining: { type: Boolean, default: false },

  // Starvation: adsets activos sin su parte proporcional del spend.
  // is_true_starved = edad>3d AND fuera de LEARNING AND spend_share < proporcional * 0.3
  starved_adsets: [{
    adset_id: { type: String },
    adset_name: { type: String },
    entity_age_days: { type: Number },
    learning_stage: { type: String },
    spend_share_3d: { type: Number },        // 0-1
    proportional_expected: { type: Number }, // 1 / active_adsets_count
    is_true_starved: { type: Boolean },
    roas_7d: { type: Number },
    _id: false
  }],
  starved_count: { type: Number, default: 0 },  // cuántos con is_true_starved=true

  // Colapso detectado: ROAS cae 30%+ en 3d Y spend se mantiene o sube
  // (si spend bajó es ramp-down natural, no colapso)
  collapse_detected: { type: Boolean, default: false, index: true },

  // Metadata del monitor
  monitor_version: { type: String, default: '1.0' },
  compute_ms: { type: Number, default: 0 },
  monitor_errors: [{ type: String }]   // renombrado desde 'errors' (reserved en Mongoose)
});

// TTL 45 días sobre snapshot_at (middle ground entre 30 y 60)
cboHealthSnapshotSchema.index({ snapshot_at: 1 }, { expireAfterSeconds: 45 * 24 * 3600 });
cboHealthSnapshotSchema.index({ campaign_id: 1, snapshot_at: -1 });
cboHealthSnapshotSchema.index({ collapse_detected: 1, snapshot_at: -1 });

module.exports = mongoose.model('CBOHealthSnapshot', cboHealthSnapshotSchema);
