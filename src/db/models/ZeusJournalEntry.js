const mongoose = require('mongoose');

/**
 * ZeusJournalEntry — diario personal de Zeus. Self-reflection semanal:
 * errores propios, patrones que nota en sus decisiones, aprendizajes.
 * El creador puede leerlo — transparencia total.
 */
const zeusJournalSchema = new mongoose.Schema({
  entry_type: {
    type: String,
    enum: ['weekly_reflection', 'mistake', 'lesson', 'pattern', 'meta', 'observation'],
    required: true,
    index: true
  },
  title: { type: String, required: true },
  content: { type: String, required: true },

  // References a cosas específicas que inspiraron el entry
  references: [{
    type_: { type: String, enum: ['recommendation_outcome', 'hypothesis', 'action_log', 'conversation', 'directive'] },
    ref_id: String,
    _id: false
  }],

  // Severidad del aprendizaje — cuánto debería influir futuras decisiones
  importance: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },

  // Tags libres para categorizar
  tags: [{ type: String }],

  created_at: { type: Date, default: Date.now, index: true }
});

zeusJournalSchema.index({ entry_type: 1, created_at: -1 });

module.exports = mongoose.model('ZeusJournalEntry', zeusJournalSchema);
