const mongoose = require('mongoose');

/**
 * SeasonalEvent — eventos del calendario que Zeus debe "saber que vienen".
 * Awareness primero, activación manual después.
 *
 * Dates pueden ser:
 * - fixed: { type: 'fixed', month: 11, day: 14 }  (ej: National Pickle Day)
 * - computed: { type: 'computed', rule: 'last_friday_november' } (ej: Black Friday)
 */
const seasonalEventSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: '' },

  // Definición de fecha
  date_type: { type: String, enum: ['fixed', 'computed'], required: true },
  month: { type: Number, min: 1, max: 12 },           // 1-12, para fixed
  day: { type: Number, min: 1, max: 31 },              // 1-31, para fixed
  rule: { type: String, default: '' },                  // para computed (ej "last_friday_november")

  // Categorización
  category: {
    type: String,
    enum: ['retail_sales', 'niche_holiday', 'national_holiday', 'seasonal_moment', 'brand_event', 'cultural', 'other'],
    default: 'other'
  },
  priority: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium',
    index: true
  },

  // Ventanas temporales
  anticipation_days: { type: Number, default: 14 },    // días antes para empezar a preparar
  peak_days: { type: Number, default: 1 },              // días del evento propiamente
  cool_down_days: { type: Number, default: 3 },         // días post para recovery

  // Hints para Apollo/creative team
  messaging_theme: { type: String, default: '' },
  target_audience_hint: { type: String, default: '' },

  // Activación — si está activated, entra en awareness de Zeus
  activated: { type: Boolean, default: true, index: true },

  // Trazabilidad
  source: { type: String, enum: ['system_seed', 'creator', 'zeus'], default: 'system_seed' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SeasonalEvent', seasonalEventSchema);
