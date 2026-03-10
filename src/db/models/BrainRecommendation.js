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
    enum: ['urgente', 'evaluar'],
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

  // Para recomendaciones a nivel de ad individual: referencia al ad set padre
  parent_adset_id: { type: String, default: null, index: true },
  parent_adset_name: { type: String, default: null },

  // Contenido de la recomendación
  title: { type: String, required: true },         // "Pausar BROAD 5 — ROAS 0.8x con $120 gastados"
  diagnosis: { type: String, default: '' },        // Causa raíz en 1 frase: "Fatiga creativa — CTR cayó 35% en 7d"
  expected_outcome: { type: String, default: '' }, // Qué esperas si se ejecuta: "ROAS debería recuperar a ~2.5x"
  risk: { type: String, default: '' },             // Riesgo de no actuar: "Seguirá quemando $17/día sin retorno"
  body: { type: String, default: '' },             // Contexto adicional breve (puede estar vacío)
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

  // Follow-up: ¿se ejecutó la acción? (legacy single-check fields kept for backward compat)
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
      ctr_7d: Number,
      purchases_7d: Number,
      purchase_value_7d: Number,
      add_to_cart_7d: Number,
      initiate_checkout_7d: Number,
      daily_budget: Number,
      status: String
    },

    // Métricas después (medidas en follow-up) — populated by last completed phase
    metrics_after: {
      roas_7d: Number,
      cpa_7d: Number,
      spend_7d: Number,
      frequency_7d: Number,
      ctr_7d: Number,
      purchases_7d: Number,
      purchase_value_7d: Number,
      add_to_cart_7d: Number,
      initiate_checkout_7d: Number,
      daily_budget: Number,
      status: String,
      measured_at: Date
    },

    // ═══ MULTI-PHASE MEASUREMENT ═══
    // Each phase captures a snapshot at increasing intervals post-approval
    phases: {
      // Phase 1: Early signal — 3 days after approval
      day_3: {
        measured: { type: Boolean, default: false },
        measured_at: Date,
        metrics: {
          roas_7d: Number, cpa_7d: Number, spend_7d: Number,
          frequency_7d: Number, ctr_7d: Number, purchases_7d: Number,
          purchase_value_7d: Number, add_to_cart_7d: Number,
          initiate_checkout_7d: Number, daily_budget: Number, status: String
        },
        deltas: {
          roas_pct: Number, cpa_pct: Number, spend_pct: Number,
          ctr_pct: Number, frequency_pct: Number, purchases_delta: Number
        },
        verdict: { type: String, enum: ['positive', 'negative', 'neutral', 'too_early', null], default: null }
      },
      // Phase 2: Stabilized — 7 days after approval
      day_7: {
        measured: { type: Boolean, default: false },
        measured_at: Date,
        metrics: {
          roas_7d: Number, cpa_7d: Number, spend_7d: Number,
          frequency_7d: Number, ctr_7d: Number, purchases_7d: Number,
          purchase_value_7d: Number, add_to_cart_7d: Number,
          initiate_checkout_7d: Number, daily_budget: Number, status: String
        },
        deltas: {
          roas_pct: Number, cpa_pct: Number, spend_pct: Number,
          ctr_pct: Number, frequency_pct: Number, purchases_delta: Number
        },
        verdict: { type: String, enum: ['positive', 'negative', 'neutral', null], default: null }
      },
      // Phase 3: Full impact — 14 days after approval
      day_14: {
        measured: { type: Boolean, default: false },
        measured_at: Date,
        metrics: {
          roas_7d: Number, cpa_7d: Number, spend_7d: Number,
          frequency_7d: Number, ctr_7d: Number, purchases_7d: Number,
          purchase_value_7d: Number, add_to_cart_7d: Number,
          initiate_checkout_7d: Number, daily_budget: Number, status: String
        },
        deltas: {
          roas_pct: Number, cpa_pct: Number, spend_pct: Number,
          ctr_pct: Number, frequency_pct: Number, purchases_delta: Number
        },
        verdict: { type: String, enum: ['positive', 'negative', 'neutral', null], default: null }
      }
    },

    // Current phase: which measurement we're waiting for next
    current_phase: {
      type: String,
      enum: ['awaiting_day_3', 'awaiting_day_7', 'awaiting_day_14', 'complete'],
      default: 'awaiting_day_3'
    },

    // ═══ AI-POWERED IMPACT ANALYSIS ═══
    // Claude analyzes the before/after data to explain WHY the action worked or not
    ai_analysis: {
      generated: { type: Boolean, default: false },
      generated_at: Date,
      root_cause: String,        // "La fatiga creativa era la causa principal — CTR recuperó 35% con los nuevos ads"
      what_worked: String,       // "El refresh de creativos redujo frequency de 4.2 a 2.1 y recuperó CTR"
      what_didnt: String,        // "CPA no mejoró pese al mejor CTR — posible problema de landing page persistente"
      lesson_learned: String,    // "Para este tipo de ad set (retarget), refresh cada 14 días es necesario"
      confidence_adjustment: Number,  // +10 or -15 — how much to adjust Brain confidence for this action_type
      tokens_used: Number
    },

    // Impacto calculado (final — set from last completed phase or legacy single-check)
    impact_summary: { type: String, default: '' },
    impact_verdict: {
      type: String,
      enum: ['positive', 'negative', 'neutral', 'pending', null],
      default: null
    },

    // Trend across phases: is the impact improving, stable, or declining over time?
    impact_trend: {
      type: String,
      enum: ['improving', 'stable', 'declining', null],
      default: null
    }
  },

  // Referencia al ciclo de recomendaciones
  cycle_id: { type: String, index: true },  // Identificador del ciclo (timestamp-based)

  // Si esta recomendación reemplaza/actualiza una anterior
  supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'BrainRecommendation', default: null },

  // Referencia al follow-up activo del mismo ad set (si existe)
  related_follow_up: {
    rec_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BrainRecommendation', default: null },
    title: { type: String, default: null },
    action_type: { type: String, default: null },
    current_phase: { type: String, default: null },
    day_3_verdict: { type: String, default: null },
    decided_at: { type: Date, default: null }
  },

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
