const mongoose = require('mongoose');

const metricsWindowSchema = new mongoose.Schema({
  spend: { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  cpm: { type: Number, default: 0 },
  cpc: { type: Number, default: 0 },
  purchases: { type: Number, default: 0 },
  purchase_value: { type: Number, default: 0 },
  roas: { type: Number, default: 0 },
  cpa: { type: Number, default: 0 },
  reach: { type: Number, default: 0 },
  frequency: { type: Number, default: 0 },
  // Pixel funnel metrics
  add_to_cart: { type: Number, default: 0 },
  add_to_cart_value: { type: Number, default: 0 },
  initiate_checkout: { type: Number, default: 0 }
}, { _id: false });

const metricSnapshotSchema = new mongoose.Schema({
  entity_type: {
    type: String,
    enum: ['campaign', 'adset', 'ad'],
    required: true,
    index: true
  },
  entity_id: { type: String, required: true, index: true },
  entity_name: { type: String, required: true },
  parent_id: { type: String, default: null },
  campaign_id: { type: String, required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'WITH_ISSUES', 'IN_PROCESS', 'PENDING_BILLING_INFO'], default: 'ACTIVE' },

  // Info de presupuesto (nivel ad set)
  daily_budget: { type: Number, default: 0 },
  lifetime_budget: { type: Number, default: 0 },
  budget_remaining: { type: Number, default: 0 },

  // Conteo de ads activos (nivel ad set)
  ads_count: { type: Number, default: 0 },

  // Fecha de creación en Meta (para calcular edad del ad/adset)
  meta_created_time: { type: Date, default: null },

  // Learning stage de Meta (solo ad sets)
  learning_stage: { type: String, enum: ['LEARNING', 'SUCCESS', 'FAIL', null], default: null },
  learning_stage_conversions: { type: Number, default: 0 },
  learning_stage_last_edit: { type: Date, default: null },

  // Métricas por ventana de tiempo (today, last_3d, last_7d, last_14d, last_30d)
  metrics: {
    today: { type: metricsWindowSchema, default: () => ({}) },
    last_3d: { type: metricsWindowSchema, default: () => ({}) },
    last_7d: { type: metricsWindowSchema, default: () => ({}) },
    last_14d: { type: metricsWindowSchema, default: () => ({}) },
    last_30d: { type: metricsWindowSchema, default: () => ({}) }
  },

  // Análisis derivado
  analysis: {
    roas_trend: { type: String, enum: ['improving', 'stable', 'declining'], default: 'stable' },
    roas_3d_vs_7d: { type: Number, default: 0 },
    spend_velocity: { type: Number, default: 0 },
    frequency_alert: { type: Boolean, default: false },
    ctr_vs_average: { type: Number, default: 0 }
  },

  snapshot_at: { type: Date, default: Date.now, index: true },
  created_at: { type: Date, default: Date.now }
});

// Índice compuesto para consultas frecuentes
metricSnapshotSchema.index({ entity_id: 1, snapshot_at: -1 });
metricSnapshotSchema.index({ entity_type: 1, snapshot_at: -1 });
metricSnapshotSchema.index({ campaign_id: 1, entity_type: 1, snapshot_at: -1 });

// Índices para getAdsForAdSet (parent_id) y getLatestSnapshots con entity_type
metricSnapshotSchema.index({ entity_type: 1, parent_id: 1, snapshot_at: -1 });
metricSnapshotSchema.index({ entity_type: 1, entity_id: 1, snapshot_at: -1 });

// Índice 2026-04-24: cover query de briefing "adsets en LEARNING con más conv"
// que antes hacía full scan con regex sobre entity_name (10.7s real).
metricSnapshotSchema.index({ entity_type: 1, learning_stage: 1, snapshot_at: -1 });
// Índice prefix sobre entity_name — ayuda a regex parcialmente anclados
// (ej. [Prometheus], [Ares]) que son naming conventions del sistema.
metricSnapshotSchema.index({ entity_name: 1 });

module.exports = mongoose.model('MetricSnapshot', metricSnapshotSchema);
