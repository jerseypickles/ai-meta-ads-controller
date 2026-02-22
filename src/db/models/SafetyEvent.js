const mongoose = require('mongoose');

const safetyEventSchema = new mongoose.Schema({
  event_type: {
    type: String,
    enum: [
      'kill_switch_triggered',
      'kill_switch_reset',
      'budget_ceiling_hit',
      'cooldown_rejected',
      'learning_phase_protected',
      'daily_change_limit_hit',
      'budget_capped',
      'operating_hours_deferred',
      'manual_override',
      'anomaly_detected',
      'creative_rotation_forced'
    ],
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ['critical', 'warning', 'info'],
    required: true
  },
  entity_id: { type: String },
  entity_name: { type: String },
  description: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed },
  resolved: { type: Boolean, default: false },
  resolved_at: { type: Date },
  resolved_by: { type: String },
  created_at: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('SafetyEvent', safetyEventSchema);
