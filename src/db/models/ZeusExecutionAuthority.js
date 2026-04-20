const mongoose = require('mongoose');

/**
 * ZeusExecutionAuthority — bounds de autonomía que el creador le da a Zeus
 * por categoría. Disabled por default. Solo se enablea cuando hay
 * track record (L1 calibración) que justifique la confianza.
 */
const zeusExecutionAuthoritySchema = new mongoose.Schema({
  category: {
    type: String,
    enum: [
      'budget_adjust_small',    // ±10% budget changes
      'budget_adjust_medium',   // ±20% budget changes
      'pause_low_performer',    // pause adsets con ROAS <0.5x
      'duplicate_winner',       // duplicate adsets con ROAS > target
      'apply_code_rec',         // aplicar code recommendations threshold
      'create_test',            // comisionar tests adicionales
      'update_directive'        // cancelar/crear directivas
    ],
    required: true,
    unique: true,
    index: true
  },

  // Es autonomía habilitada? Default false — el creador debe prender explícito
  enabled: { type: Boolean, default: false, index: true },

  // Umbrales de seguridad
  min_confidence: { type: Number, default: 0.85 },     // calibration mínima para auto
  min_calibration_samples: { type: Number, default: 20 }, // cuántos outcomes needed
  max_impact_per_exec: { type: Number, default: 100 },  // $ o % según category
  max_per_day: { type: Number, default: 3 },            // cuántos auto-execs por día
  daily_executions: { type: Number, default: 0 },       // counter (reset diario)
  last_reset_at: { type: Date, default: null },

  // Audit
  total_executions: { type: Number, default: 0 },
  last_executed_at: { type: Date, default: null },

  // Por quién/cuándo se enabled
  enabled_by: { type: String, default: '' },
  enabled_at: { type: Date, default: null },
  enable_reason: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ZeusExecutionAuthority', zeusExecutionAuthoritySchema);
