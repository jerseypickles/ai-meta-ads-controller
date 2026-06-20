const mongoose = require('mongoose');

/**
 * CommentModerationLog — registro de la moderación automática de comentarios de ads.
 *
 * Cada comentario que MATCHEA una regla queda acá: en shadow mode con action='would_hide'
 * (no se tocó nada, es lo que el creador revisa), o en live con action='hidden'. Guarda el
 * texto + la regla que matcheó para auditar falsos positivos y para poder REVERTIR (un-hide)
 * usando comment_id. Dedup por comment_id (no re-loguear el mismo comentario cada ciclo).
 */
const commentModerationLogSchema = new mongoose.Schema({
  comment_id: { type: String, required: true, unique: true, index: true },
  ad_id: { type: String, default: '', index: true },
  story_id: { type: String, default: '' },
  author_name: { type: String, default: '' },
  author_id: { type: String, default: '' },
  message: { type: String, default: '' },

  // qué regla lo agarró + el fragmento que matcheó (para auditar)
  matched_rule: { type: String, default: '' },      // ej: "ai_callout" | "blocklist"
  matched_term: { type: String, default: '' },      // el término concreto que pegó

  // shadow: 'would_hide' (no se tocó). live: 'hidden'. 'unhidden' si se revirtió.
  // 'skipped_error' si la API falló al ocultar.
  action: {
    type: String,
    enum: ['would_hide', 'hidden', 'unhidden', 'skipped_error'],
    default: 'would_hide',
    index: true
  },
  shadow: { type: Boolean, default: true },          // si se decidió en shadow mode
  error: { type: String, default: '' },

  comment_created_time: { type: Date, default: null },
  created_at: { type: Date, default: Date.now, index: true }
});

commentModerationLogSchema.index({ action: 1, created_at: -1 });

module.exports = mongoose.model('CommentModerationLog', commentModerationLogSchema);
