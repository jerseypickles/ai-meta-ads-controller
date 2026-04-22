const mongoose = require('mongoose');

/**
 * ZeusJournalEntry — diario personal de Zeus. Self-reflection semanal:
 * errores propios, patrones que nota en sus decisiones, aprendizajes.
 * El creador puede leerlo — transparencia total.
 *
 * Extendido (2026-04-21) con infraestructura de calibración de respuesta:
 * reference_response / anti_reference_response / trap_execution / audit_report.
 * Ver notas obsidian: Hilo B (principios + trampas + auto-audit post-hoc).
 */

// Taxonomía fija de principios — tanto ejemplificados como violados usan el mismo vocabulario
const PRINCIPLES = [
  // Principios positivos (lo que queremos ver)
  'resist_validation',                  // No validó por default; contrastó con data
  'separate_measurable_from_intuition', // Separó evidencia medible de fe calibrada
  'declared_no_counterfactual',         // Dijo explícitamente que no hay baseline contrafactual
  'contradicted_creator_judgment',      // Contradijo un juicio del creador con evidencia
  'asked_before_asserting',             // Pidió verificación antes de aceptar una afirmación
  'committed_to_disconfirmation',       // Pre-compromiso falsable: señal observable + umbral numérico + ventana temporal + acción consecuente. Aspira a atarse al mástil contra drift propio.

  // Principios violados (lo que queremos cazar)
  'validation_bias',                    // Validó por default sin contrastar
  'accepted_unverified_factual',        // Aceptó afirmación fáctica sin verificar con tool
  'uncontested_causal_assumption',      // Dejó pasar causalidad asumida sin señalar
  'suppressed_disagreement',            // Había discrepancia pero no la dijo
  'missing_counterfactual',             // Atribuyó outcome sin baseline contrafactual
  'template_execution_without_thinking',// Aplicó estructura sin diagnosticar el caso
  'trusted_stale_context',              // Trustea contexto base histórico como si fuera fresh; no refresha con tools
  'ignored_explicit_correction',        // El creador corrigió explícitamente y el agente repitió la conducta
  'conversational_scope_drift'          // Elabora sobre temas ya cerrados o no preguntados; sale del scope de la pregunta actual
];

const zeusJournalSchema = new mongoose.Schema({
  entry_type: {
    type: String,
    enum: [
      // Legacy (mantener compatibilidad)
      'weekly_reflection', 'mistake', 'lesson', 'pattern', 'meta', 'observation',
      // Nuevos (Hilo B)
      'reference_response',      // golden response que vale archivar como benchmark
      'anti_reference_response', // falla detectada, usar como contra-ejemplo
      'trap_execution',          // registro de trampa ejecutada (passed/failed)
      'audit_report'             // reporte trimestral
    ],
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

  // ═══ Hilo B — calibración de respuesta ═══

  is_reference_response: { type: Boolean, default: false, index: true },
  is_anti_reference_response: { type: Boolean, default: false, index: true },

  // Principios ejemplificados (para references) o violados (para anti-refs)
  principles_exemplified: [{ type: String, enum: PRINCIPLES }],
  violated_principles: [{ type: String, enum: PRINCIPLES }],

  // Descripción corta del failure mode (para anti-refs)
  failure_mode: { type: String, default: '' },
  // Lección concreta aprendida (no genérica — chequeable en comportamiento futuro)
  correction_learned: { type: String, default: '' },

  // De dónde viene el entry
  source: {
    type: String,
    enum: ['manual', 'post_hoc_self_audit', 'trap_system', 'audit_cron', 'weekly_self_reflection'],
    default: 'manual',
    index: true
  },

  // Resultados de la checklist de 3 preguntas (para post_hoc_self_audit)
  // { Q1: bool (fáctico verificable?), Q1b: bool (lo verifiqué?), Q2, Q2b, Q3 }
  checklist_results: { type: mongoose.Schema.Types.Mixed, default: null },

  // Link al mensaje de chat que originó el entry (para trace)
  linked_message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusChatMessage', default: null },
  linked_conversation_id: { type: String, default: null, index: true },

  // Excerpt del mensaje del creador (hasta 500 chars) + de la respuesta de Zeus
  original_user_message: { type: String, default: '' },
  original_assistant_response: { type: String, default: '' },

  // Para trap_execution
  trap_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusTrap', default: null, index: true },
  trap_outcome: { type: String, enum: ['passed', 'failed', null], default: null },

  // Para audit_report: payload con contadores, grupos, flags
  audit_payload: { type: mongoose.Schema.Types.Mixed, default: null },
  audit_window_start: { type: Date, default: null },
  audit_window_end: { type: Date, default: null },

  created_at: { type: Date, default: Date.now, index: true }
});

zeusJournalSchema.index({ entry_type: 1, created_at: -1 });
zeusJournalSchema.index({ is_reference_response: 1, created_at: -1 });
zeusJournalSchema.index({ is_anti_reference_response: 1, created_at: -1 });
zeusJournalSchema.index({ 'violated_principles': 1, created_at: -1 });
zeusJournalSchema.index({ source: 1, created_at: -1 });

zeusJournalSchema.statics.PRINCIPLES = PRINCIPLES;

module.exports = mongoose.model('ZeusJournalEntry', zeusJournalSchema);
