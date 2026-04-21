const mongoose = require('mongoose');

/**
 * ZeusAuditRun — registro de cada pasada del code-sentinel.
 * Cada sub-lente genera un run; los findings quedan linkeados por audit_run_id.
 * Sirve como track record para calibrar accuracy por sub-lente (L1 extended).
 */
const zeusAuditRunSchema = new mongoose.Schema({
  lens: {
    type: String,
    enum: ['vulnerability', 'plan_readiness', 'architecture'],
    required: true,
    index: true
  },
  sub_lens: {
    type: String,
    enum: ['security', 'silent_failures', 'config_drift', 'calibration', 'prompt_drift', null],
    default: null,
    index: true
  },
  mode: { type: String, enum: ['daily', 'weekly', 'on_demand'], default: 'daily' },

  started_at: { type: Date, default: Date.now, index: true },
  finished_at: { type: Date, default: null },
  duration_ms: { type: Number, default: null },

  findings_count: { type: Number, default: 0 },
  critical_count: { type: Number, default: 0 },
  high_count: { type: Number, default: 0 },

  tool_calls: { type: Number, default: 0 },
  tokens_used: { type: Number, default: 0 },

  summary: { type: String, default: '' },
  error: { type: String, default: null },
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running', index: true }
});

zeusAuditRunSchema.index({ lens: 1, sub_lens: 1, started_at: -1 });

module.exports = mongoose.model('ZeusAuditRun', zeusAuditRunSchema);
