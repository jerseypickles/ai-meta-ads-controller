const mongoose = require('mongoose');

/**
 * BrainInsight — Insight generado por el Brain.
 * Cada insight es un análisis proactivo con contexto,
 * seguimiento de insights anteriores, y severidad.
 */
const brainInsightSchema = new mongoose.Schema({
  // Tipo de insight
  insight_type: {
    type: String,
    enum: [
      'anomaly',           // Cambio anormal detectado (caída/subida brusca)
      'trend',             // Tendencia sostenida (3+ ciclos en misma dirección)
      'opportunity',       // Oportunidad de mejora detectada
      'warning',           // Algo necesita atención pronto
      'milestone',         // Logro notable (ROAS récord, etc.)
      'status_change',     // Cambio de estado (pausado, reactivado, etc.)
      'summary',           // Resumen periódico del estado general
      'follow_up',         // Seguimiento de un insight anterior
      'brain_thinking',    // Razonamiento del Brain — por qué decidió NO actuar
      'brain_activity',    // Actividad del Brain — resumen de ciclo, qué analizó/hizo
      'hypothesis'         // Hipotesis generada por Zeus — testeable, con prediccion
    ],
    required: true,
    index: true
  },

  // Severidad / importancia
  severity: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low', 'info'],
    default: 'medium',
    index: true
  },

  // Entidad(es) involucrada(s)
  entities: [{
    entity_type: { type: String, enum: ['campaign', 'adset', 'ad', 'account'] },
    entity_id: String,
    entity_name: String
  }],

  // Contenido del insight
  title: { type: String, required: true },         // Título corto (1 línea)
  body: { type: String, required: true },           // Análisis completo por IA
  data_points: { type: mongoose.Schema.Types.Mixed, default: {} },  // Datos numéricos de soporte

  // Diagnóstico computado (CREATIVE_FATIGUE, FUNNEL_LEAK, AUDIENCE_SATURATED, etc.)
  diagnosis: { type: String, default: null },

  // Recomendación pendiente relacionada (link insight ↔ rec)
  related_recommendation: { type: mongoose.Schema.Types.ObjectId, ref: 'BrainRecommendation', default: null },

  // Seguimiento / continuidad
  follows_up: { type: mongoose.Schema.Types.ObjectId, ref: 'BrainInsight', default: null },  // Insight anterior al que da seguimiento
  follow_up_count: { type: Number, default: 0 },   // Cuántos follow-ups tiene este insight
  is_resolved: { type: Boolean, default: false },   // ¿El tema fue resuelto?
  resolved_at: { type: Date, default: null },

  // Metadata de generación
  generated_by: {
    type: String,
    enum: ['math', 'ai', 'hybrid', 'brain', 'zeus'],  // Quién generó: math, IA, hybrid, Brain, o Zeus learner
    default: 'hybrid'
  },
  ai_model: { type: String, default: null },        // Modelo usado si fue IA
  tokens_used: { type: Number, default: 0 },

  // Estado de lectura
  read: { type: Boolean, default: false },
  read_at: { type: Date, default: null },

  created_at: { type: Date, default: Date.now, index: true }
});

brainInsightSchema.index({ created_at: -1 });
brainInsightSchema.index({ insight_type: 1, created_at: -1 });
brainInsightSchema.index({ 'entities.entity_id': 1, created_at: -1 });
brainInsightSchema.index({ follows_up: 1 });

module.exports = mongoose.model('BrainInsight', brainInsightSchema);
