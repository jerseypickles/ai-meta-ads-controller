const mongoose = require('mongoose');

/**
 * HermesComment — un comentario de Facebook sobre un ad de Hermes, clasificado
 * por Claude para extraer señal de foot traffic.
 *
 * Contexto (2026-05-21): el foot traffic de Hermes no es medible por atribución
 * directa (el personal de la tienda no usa ningún sistema; solo reporta un
 * número agregado verbal). Los comentarios de los ads son la única señal digital
 * atribuible POR creativo. Este modelo soporta las 3 patas del sistema:
 *   1. MEDIR — classification + intent_score por creativo/oferta
 *   2. DETECTAR — flag de creativos que confunden/repelen (ej. "bloody pickles")
 *   3. RESPONDER — cola híbrida: auto-publica lo determinístico, lo ambiguo
 *      va a aprobación manual
 */
const hermesCommentSchema = new mongoose.Schema({
  // Identidad Meta — comment_id único (dedup en sync)
  comment_id: { type: String, required: true, unique: true, index: true },
  story_id: { type: String, default: null },          // effective_object_story_id del ad

  // Vínculo a la proposal/creativo que generó el comentario
  proposal_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HermesProposal', default: null, index: true },
  meta_ad_id: { type: String, default: null, index: true },
  offer_type: { type: String, default: null, index: true },
  platform: { type: String, enum: ['facebook', 'instagram'], default: 'facebook' },

  // Contenido del comentario
  author_name: { type: String, default: '' },
  author_id: { type: String, default: null },
  message: { type: String, default: '' },
  created_time: { type: Date, default: null, index: true },
  like_count: { type: Number, default: 0 },
  reply_count: { type: Number, default: 0 },

  // ─── Pata 1: Clasificación (Claude) ───
  classification: {
    type: String,
    enum: [
      'intent_visit',        // "Where?", "paso esta semana" — intención de ir (la más valiosa)
      'visit_reported',      // "fui ayer y estaba buenísimo" — visita ya hecha
      'question_logistics',  // "any size cup?", horarios, precio — intención + fricción a resolver
      'resonance',           // "se ve rico 😍" — le gusta, sin intención explícita
      'negative_creative',   // "bloody pickles?", "looks gross" — problema de percepción del visual
      'negative_other',      // queja no relacionada al creativo
      'spam',
      'other',
      'unclassified'         // aún no procesado
    ],
    default: 'unclassified',
    index: true
  },
  intent_score: { type: Number, default: 0 },          // 0-100, qué tan cerca de una visita real
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative', 'unknown'], default: 'unknown' },
  classification_summary: { type: String, default: '' },  // razón corta de Claude
  classified_at: { type: Date, default: null },

  // ─── Pata 2: Flag de creativo ───
  // true si el comentario revela un problema de percepción del visual.
  // La agregación (≥N por proposal) dispara el flag a nivel creativo.
  flags_creative_issue: { type: Boolean, default: false, index: true },

  // ─── Pata 3: Respuesta (híbrido por confianza) ───
  reply_status: {
    type: String,
    enum: [
      'none',          // no requiere respuesta (resonance, spam, etc)
      'drafted',       // Claude generó respuesta, espera aprobación (caso ambiguo/sensible)
      'approved',      // usuario aprobó, listo para publicar
      'posted',        // publicado en Meta
      'auto_posted',   // auto-publicado (caso determinístico de alta confianza)
      'skipped',       // usuario decidió no responder
      'failed'         // intento de publicación falló
    ],
    default: 'none',
    index: true
  },
  reply_confidence: { type: String, enum: ['high', 'low', 'none'], default: 'none' },
  reply_text: { type: String, default: '' },
  reply_meta_id: { type: String, default: null },      // comment_id de la respuesta publicada
  reply_decided_by: { type: String, default: '' },
  reply_posted_at: { type: Date, default: null },
  reply_error: { type: String, default: '' },

  synced_at: { type: Date, default: Date.now }
});

// Feed del panel: por proposal, más recientes primero
hermesCommentSchema.index({ proposal_id: 1, created_time: -1 });
// Cola de respuestas pendientes de aprobación
hermesCommentSchema.index({ reply_status: 1, created_time: -1 });
// Pendientes de clasificar
hermesCommentSchema.index({ classification: 1, synced_at: -1 });

module.exports = mongoose.model('HermesComment', hermesCommentSchema);
