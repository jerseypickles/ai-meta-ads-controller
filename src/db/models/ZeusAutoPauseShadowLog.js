const mongoose = require('mongoose');

/**
 * ZeusAutoPauseShadowLog — shadow mode de la palanca auto-pause.
 *
 * Durante shadow (7-21 días), el detector corre el criterio pero NO pausa.
 * Registra candidatos + completa ground_truth_7d vía cron. Si la tasa de
 * false_positive es <15% con ≥20 candidatos clasificados, se gradúa a live.
 *
 * Separado de ZeusAutoPauseLog porque en shadow el adset NO fue afectado —
 * el ground truth es "qué pasó si NADIE lo pausó". En live el ground truth
 * es "qué pasó con la pausa" (reactivated_by Athena/human).
 *
 * Implementado 2026-04-21 (Hilo C — Auto-pause palanca ejecutiva bounded).
 */

const VERDICTS = ['pending', 'correct_pause', 'false_positive', 'ambiguous'];

const shadowLogSchema = new mongoose.Schema({
  // Detección
  adset_id: { type: String, required: true, index: true },
  adset_name: { type: String, required: true },
  campaign_id: { type: String, default: '' },
  detected_at: { type: Date, default: Date.now, index: true },

  // Configuración activa al detectar
  criteria_version: { type: String, default: 'v1', index: true },
  threshold_snapshot: {
    roas_3d: { type: Number },
    spend_3d: { type: Number },
    purchases_3d: { type: Number },
    age_days: { type: Number },
    learning_stage: { type: String },
    _id: false
  },

  // Estado al momento del platform check (para auditoría retrospectiva del gate)
  platform_state_at_detection: {
    degraded: { type: Boolean, default: false },
    signals: { type: mongoose.Schema.Types.Mixed, default: [] },
    _id: false
  },

  // Habría pausado? (siempre true en shadow — si pasó los filtros). Útil para analytics.
  would_pause: { type: Boolean, default: true },

  // Review schedule
  ground_truth_due_at: { type: Date, required: true, index: true },   // detected_at + 7d

  // Ground truth — completado por cron a T+7d
  ground_truth_completed: { type: Boolean, default: false, index: true },
  ground_truth_7d: {
    roas: { type: Number },
    spend: { type: Number },
    purchases: { type: Number },
    measured_at: { type: Date },
    _id: false
  },

  verdict: {
    type: String,
    enum: VERDICTS,
    default: 'pending',
    index: true
  },
  verdict_reason: { type: String, default: '' }
});

shadowLogSchema.index({ adset_id: 1, detected_at: -1 });
shadowLogSchema.index({ ground_truth_completed: 1, ground_truth_due_at: 1 });
shadowLogSchema.index({ verdict: 1, detected_at: -1 });

shadowLogSchema.statics.VERDICTS = VERDICTS;

module.exports = mongoose.model('ZeusAutoPauseShadowLog', shadowLogSchema);
