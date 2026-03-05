const mongoose = require('mongoose');

/**
 * BrainTemporalPattern — Patrones de rendimiento por día/hora.
 * El Brain acumula running averages para distinguir variación normal
 * (ej. martes siempre baja CTR) de anomalías reales.
 */
const brainTemporalPatternSchema = new mongoose.Schema({
  pattern_type: {
    type: String,
    enum: ['day_of_week', 'hour_of_day'],
    required: true
  },
  pattern_key: {
    type: String,
    required: true  // "monday"..."sunday" o "0"..."23"
  },
  level: {
    type: String,
    enum: ['account'],
    default: 'account'
  },

  // Running averages — se estabilizan con más muestras
  metrics: {
    avg_roas: { type: Number, default: 0 },
    avg_cpa: { type: Number, default: 0 },
    avg_ctr: { type: Number, default: 0 },
    avg_spend: { type: Number, default: 0 },
    avg_frequency: { type: Number, default: 0 },
    sample_count: { type: Number, default: 0 }
  },

  last_updated_at: { type: Date, default: Date.now }
});

brainTemporalPatternSchema.index({ pattern_type: 1, pattern_key: 1, level: 1 }, { unique: true });

module.exports = mongoose.model('BrainTemporalPattern', brainTemporalPatternSchema);
