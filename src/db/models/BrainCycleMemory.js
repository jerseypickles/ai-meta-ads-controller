const mongoose = require('mongoose');

/**
 * Memoria persistente de análisis del Brain entre ciclos.
 * Al final de cada ciclo, Claude genera un resumen compacto de sus conclusiones clave.
 * En el siguiente ciclo, los últimos N resúmenes se inyectan como contexto,
 * dándole continuidad narrativa y memoria de razonamiento entre ciclos.
 */
const brainCycleMemorySchema = new mongoose.Schema({
  cycle_id: { type: String, required: true, unique: true, index: true },

  // Resumen compacto generado por Claude al final del ciclo
  conclusions: [{
    topic: { type: String, required: true },       // ej: "fatigue_pattern", "scaling_opportunity", "budget_concern"
    conclusion: { type: String, required: true },   // La conclusión en texto
    confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    entities: [{ type: String }],                   // entity_ids relacionados
    _id: false
  }],

  // Estado general de la cuenta según Claude
  account_assessment: { type: String, default: '' },  // "healthy", "declining", "recovering", etc.

  // Hipótesis activas que Claude quiere validar en ciclos futuros
  hypotheses: [{
    hypothesis: { type: String, required: true },
    proposed_action: { type: String, default: '' },   // qué hacer para validar
    status: { type: String, enum: ['active', 'confirmed', 'rejected'], default: 'active' },
    _id: false
  }],

  // Métricas clave del ciclo para comparación rápida
  snapshot: {
    roas_7d: { type: Number, default: 0 },
    roas_30d: { type: Number, default: 0 },
    active_adsets: { type: Number, default: 0 },
    recommendations_count: { type: Number, default: 0 },
    top_action: { type: String, default: '' }
  },

  created_at: { type: Date, default: Date.now, index: true }
});

// Auto-cleanup: only keep last 30 days of memories
brainCycleMemorySchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('BrainCycleMemory', brainCycleMemorySchema);
