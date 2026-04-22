const mongoose = require('mongoose');

/**
 * ZeusAutoPauseLog — cada pausa efectiva ejecutada en live mode.
 *
 * En live mode, detectar → ejecutar pausa en Meta → row acá. Ground truth
 * se define distinto que en shadow: acá el adset FUE pausado, entonces el
 * verdict se mide via reactivación (si alguien reactiva + luego performa,
 * es FP confirmado). Si nadie lo reactiva en 14d asumimos correct_pause.
 *
 * Reactivación por Zeus está prohibida (constraint del PRD, sección 6) —
 * solo humano o Athena pueden reactivar. Cada reactivación de Athena
 * sobre un auto_pause de Zeus se trackea como FP candidate.
 */

const VERDICTS = ['pending', 'correct_pause', 'false_positive', 'ambiguous'];
const REACTIVATORS = ['creator', 'athena', 'zeus', 'system'];

const autoPauseLogSchema = new mongoose.Schema({
  // Identidad
  adset_id: { type: String, required: true, index: true },
  adset_name: { type: String, required: true },
  campaign_id: { type: String, default: '' },

  // Trigger / ejecución
  paused_at: { type: Date, default: Date.now, index: true },
  paused_reason: { type: String, default: 'auto_anomaly_zeus' },

  criteria_version: { type: String, default: 'v1', index: true },
  threshold_snapshot: {
    roas_3d: { type: Number },
    spend_3d: { type: Number },
    purchases_3d: { type: Number },
    age_days: { type: Number },
    learning_stage: { type: String },
    _id: false
  },

  // Estado del platform al momento (audit del gate)
  platform_state_at_pause: {
    degraded: { type: Boolean, default: false },
    signals: { type: mongoose.Schema.Types.Mixed, default: [] },
    _id: false
  },

  // Trazabilidad al shadow log (si existió — podría ser null si se activó directo a live sin shadow)
  shadow_log_ref: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusAutoPauseShadowLog', default: null },

  // Meta API response (para debugging si falló)
  meta_api_response: { type: mongoose.Schema.Types.Mixed, default: null },
  meta_api_success: { type: Boolean, default: true },

  // Reactivation — el único path a FP
  reactivated_at: { type: Date, default: null, index: true },
  reactivated_by: {
    type: String,
    enum: [...REACTIVATORS, null],
    default: null
  },
  reactivation_reason: { type: String, default: '' },

  // Review schedule
  review_due_at: { type: Date, required: true, index: true },   // paused_at + 14d

  // Ground truth post-reactivación (si hubo)
  ground_truth_post_reactivation: {
    roas_7d: { type: Number },
    spend_7d: { type: Number },
    purchases_7d: { type: Number },
    measured_at: { type: Date },
    _id: false
  },

  verdict: {
    type: String,
    enum: VERDICTS,
    default: 'pending',
    index: true
  },
  verdict_reason: { type: String, default: '' },
  verdict_measured_at: { type: Date, default: null }
});

autoPauseLogSchema.index({ adset_id: 1, paused_at: -1 });
autoPauseLogSchema.index({ verdict: 1, paused_at: -1 });
autoPauseLogSchema.index({ reactivated_at: 1, verdict: 1 });
autoPauseLogSchema.index({ review_due_at: 1, verdict: 1 });
autoPauseLogSchema.index({ paused_at: -1 });

autoPauseLogSchema.statics.VERDICTS = VERDICTS;
autoPauseLogSchema.statics.REACTIVATORS = REACTIVATORS;

module.exports = mongoose.model('ZeusAutoPauseLog', autoPauseLogSchema);
