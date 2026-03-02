const mongoose = require('mongoose');

/**
 * BrainRecommendation — Recomendación accionable del Brain.
 *
 * A diferencia de insights (observaciones cada 10 min), las recomendaciones:
 * - Se generan cada 6h usando datos estables (ventana 7d)
 * - Son accionables: el usuario aprueba o rechaza
 * - El Brain hace follow-up midiendo impacto post-ejecución
 * - Persisten como válidas hasta el próximo ciclo de recomendaciones
 */
const brainRecommendationSchema = new mongoose.Schema({
  // Prioridad: urgencia de la recomendación
  priority: {
    type: String,
    enum: ['urgente', 'evaluar', 'monitorear'],
    required: true,
    index: true
  },

  // Acción concreta recomendada
  action_type: {
    type: String,
    enum: [
      'pause',           // Pausar ad set
      'scale_up',        // Aumentar budget
      'scale_down',      // Reducir budget
      'reactivate',      // Reactivar ad set pausado
      'restructure',     // Reestructurar (cambiar targeting, etc.)
      'creative_refresh', // Rotar/agregar creativos
      'bid_change',      // Cambiar estrategia de puja
      'monitor',         // Solo monitorear (no acción inmediata)
      'other'            // Otra acción
    ],
    required: true
  },

  // Entidad objetivo
  entity: {
    entity_type: { type: String, enum: ['campaign', 'adset', 'ad', 'account'], required: true },
    entity_id: { type: String, required: true },
    entity_name: { type: String, required: true }
  },

  // Contenido de la recomendación
  title: { type: String, required: true },         // "Pausar BROAD 5 — ROAS 0.8x con $120 gastados"
  body: { type: String, required: true },           // Análisis completo con datos de soporte
  action_detail: { type: String, required: true },  // "Pausar ad set BROAD 5 (ID: 123456)"

  // Datos de soporte cuantitativos
  supporting_data: {
    current_roas_7d: Number,
    current_cpa_7d: Number,
    current_spend_7d: Number,
    current_frequency_7d: Number,
    current_ctr_7d: Number,
    current_purchases_7d: Number,
    account_avg_roas_7d: Number,
    trend_direction: String,  // improving/stable/declining
    days_declining: Number
  },

  // Confianza del Brain en esta recomendación
  confidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  confidence_score: { type: Number, min: 0, max: 100, default: 50 }, // 0-100

  // Estado de la recomendación
  status: {
    type: String,
    enum: [
      'pending',      // Esperando decisión del usuario
      'approved',     // Usuario aprobó
      'rejected',     // Usuario rechazó
      'expired',      // Nuevo ciclo de recomendaciones la reemplazó
      'superseded'    // Una recomendación más nueva la reemplazó
    ],
    default: 'pending',
    index: true
  },

  // Decisión del usuario
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },  // Nota opcional del usuario

  // Follow-up: ¿se ejecutó la acción?
  follow_up: {
    checked: { type: Boolean, default: false },
    checked_at: { type: Date, default: null },
    action_executed: { type: Boolean, default: false },   // ¿La acción realmente ocurrió en Meta?
    execution_detected_at: { type: Date, default: null },

    // Métricas al momento de la recomendación (snapshot)
    metrics_at_recommendation: {
      roas_7d: Number,
      cpa_7d: Number,
      spend_7d: Number,
      frequency_7d: Number,
      purchases_7d: Number,
      status: String
    },

    // Métricas después (medidas en follow-up)
    metrics_after: {
      roas_7d: Number,
      cpa_7d: Number,
      spend_7d: Number,
      frequency_7d: Number,
      purchases_7d: Number,
      status: String,
      measured_at: Date
    },

    // Impacto calculado
    impact_summary: { type: String, default: '' },  // "ROAS mejoró de 0.8x a 2.1x tras pausar"
    impact_verdict: {
      type: String,
      enum: ['positive', 'negative', 'neutral', 'pending', null],
      default: null
    }
  },

  // Referencia al ciclo de recomendaciones
  cycle_id: { type: String, index: true },  // Identificador del ciclo (timestamp-based)

  // Si esta recomendación reemplaza/actualiza una anterior
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'BrainRecommendation', default: null },

  // Metadata de generación
  generated_by: {
    type: String,
    enum: ['ai', 'hybrid'],
    default: 'ai'
  },
  ai_model: { type: String, default: null },
  tokens_used: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
});

brainRecommendationSchema.index({ status: 1, created_at: -1 });
brainRecommendationSchema.index({ 'entity.entity_id': 1, status: 1 });
brainRecommendationSchema.index({ cycle_id: 1 });
brainRecommendationSchema.index({ 'follow_up.checked': 1, status: 1 });

brainRecommendationSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('BrainRecommendation', brainRecommendationSchema);
