const mongoose = require('mongoose');

/**
 * BrainKnowledgeSnapshot — Snapshot diario del estado de conocimiento del Brain.
 *
 * Captura una foto del aprendizaje acumulado cada dia:
 * - Total de muestras del policy learner (Thompson Sampling)
 * - Win rate de acciones medidas
 * - Top acciones por rendimiento
 * - Actividad del dia (insights, recomendaciones)
 */
const brainKnowledgeSnapshotSchema = new mongoose.Schema({
  // Fecha del snapshot (YYYY-MM-DD) — una entrada por dia
  date: { type: String, required: true, unique: true, index: true },

  // Estado del Policy Learner
  total_samples: { type: Number, default: 0 },
  total_buckets: { type: Number, default: 0 },

  // Metricas de impacto acumuladas
  total_actions_measured: { type: Number, default: 0 },
  win_rate: { type: Number, default: 0 },           // % de acciones con resultado positivo
  avg_reward: { type: Number, default: 0 },          // Reward promedio del learner

  // Top acciones (resumen del estado actual)
  top_actions: [{
    action: String,
    count: Number,
    avg_reward: Number,
    success_rate: Number
  }],

  // Desglose de veredictos acumulados
  actions_by_verdict: {
    positive: { type: Number, default: 0 },
    negative: { type: Number, default: 0 },
    neutral: { type: Number, default: 0 }
  },

  // Actividad del dia
  insights_generated: { type: Number, default: 0 },
  recommendations_generated: { type: Number, default: 0 },
  recommendations_approved: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BrainKnowledgeSnapshot', brainKnowledgeSnapshotSchema);
