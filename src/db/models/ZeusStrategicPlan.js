const mongoose = require('mongoose');

/**
 * ZeusStrategicPlan — plan multi-horizonte que Zeus mantiene.
 * Horizons: weekly | monthly | quarterly. Zeus lo regenera con
 * cron y el creador aprueba/ajusta.
 */
const zeusStrategicPlanSchema = new mongoose.Schema({
  horizon: {
    type: String,
    enum: ['weekly', 'monthly', 'quarterly'],
    required: true,
    index: true
  },

  // Ventana temporal
  period_start: { type: Date, required: true },
  period_end: { type: Date, required: true },

  // North star — métrica que guía todo
  north_star: {
    metric: { type: String, default: '' },       // ej "monthly_revenue", "cpa", "roas_14d"
    target: { type: Number, default: null },
    current: { type: Number, default: null },
    direction: { type: String, enum: ['maximize', 'minimize', 'above', 'below'], default: 'maximize' }
  },

  // Goals específicos
  goals: [{
    metric: String,
    target: Number,
    current: Number,
    baseline: Number,
    by_date: Date,
    priority: { type: String, enum: ['critical', 'high', 'medium', 'low'], default: 'medium' },
    progress_pct: Number,                         // 0-100, del baseline al target
    trajectory_pct: Number,                       // 0-100, % de tiempo transcurrido
    status: { type: String, enum: ['achieved', 'on_track', 'behind', 'off_track', 'missed', 'unknown'], default: 'unknown' },
    _id: false
  }],

  // Milestones esperados
  milestones: [{
    description: String,
    by_date: Date,
    status: { type: String, enum: ['pending', 'achieved', 'missed', 'cancelled'], default: 'pending' },
    achieved_at: Date,
    _id: false
  }],

  // Riesgos identificados
  risks: [{
    description: String,
    likelihood: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    impact: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    mitigation: String,
    _id: false
  }],

  // Texto narrativo del plan (markdown, generado por Opus)
  narrative: { type: String, default: '' },
  summary: { type: String, default: '' },

  // Estado
  status: {
    type: String,
    enum: ['draft', 'active', 'superseded', 'archived'],
    default: 'draft',
    index: true
  },

  // Aprobación
  approved_by_creator: { type: Boolean, default: false },
  approved_at: { type: Date, default: null },
  creator_adjustments: { type: String, default: '' },

  // Trazabilidad
  generated_at: { type: Date, default: Date.now },
  superseded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusStrategicPlan', default: null },

  // Última evaluación (populado por plan-evaluator cron diario)
  last_evaluation: {
    at: Date,
    health_score: Number,              // 0-100
    health_status: { type: String, enum: ['on_track', 'behind', 'off_track', 'at_risk'] },
    summary: mongoose.Schema.Types.Mixed
  }
});

zeusStrategicPlanSchema.index({ horizon: 1, status: 1, period_start: -1 });

module.exports = mongoose.model('ZeusStrategicPlan', zeusStrategicPlanSchema);
