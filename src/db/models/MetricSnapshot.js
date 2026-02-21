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
  frequency: { type: Number, default: 0 }
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
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'], default: 'ACTIVE' },

  // Info de presupuesto (nivel ad set)
  daily_budget: { type: Number, default: 0 },
  lifetime_budget: { type: Number, default: 0 },
  budget_remaining: { type: Number, default: 0 },

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

module.exports = mongoose.model('MetricSnapshot', metricSnapshotSchema);
