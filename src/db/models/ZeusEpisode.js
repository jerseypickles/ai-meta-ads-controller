const mongoose = require('mongoose');

/**
 * ZeusEpisode — memoria episódica del sistema.
 *
 * Cada episodio = una situación concreta que pasó + decisión tomada + outcome medido.
 * Diferencia con ZeusPlaybook (regla) o ZeusRecommendationOutcome (tracking):
 *   - Playbook: regla general "si X → hacer Y"
 *   - Outcome: métricas numéricas de UNA rec específica
 *   - Episode: narrativa + contexto + outcome, indexable por similitud semántica
 *
 * Uso: cuando Zeus enfrenta una situación nueva, busca los 3 episodios más
 * parecidos del pasado para razonar por analogía. "Esto me recuerda a cuando..."
 */
const zeusEpisodeSchema = new mongoose.Schema({
  title: { type: String, required: true },         // "Pausa de 5 zero-ROAS el 14/03"
  narrative: { type: String, required: true },     // texto libre que describe la situación

  category: {
    type: String,
    enum: ['scale', 'pause', 'duplicate', 'kill', 'directive_change',
           'freeze_response', 'test_graduation', 'strategic_pivot',
           'anomaly_resolution', 'other'],
    default: 'other',
    index: true
  },

  // Contexto al momento
  context: {
    entity_type: String,
    entity_id: String,
    entity_name: String,
    metrics_at_time: mongoose.Schema.Types.Mixed,  // ROAS, CPA, spend, etc
    surrounding_state: mongoose.Schema.Types.Mixed, // portfolio snapshot relevante
    _id: false
  },

  // Decisión tomada
  decision: {
    action: String,                                // "pause", "scale_up", etc
    actor: { type: String, enum: ['zeus', 'athena', 'apollo', 'prometheus', 'ares', 'creator', 'system'] },
    rationale: String,
    _id: false
  },

  // Qué pasó después
  outcome: {
    short_term: String,   // resumen 7d
    mid_term: String,     // resumen 30d
    verdict: { type: String, enum: ['success', 'failure', 'mixed', 'inconclusive'], default: 'inconclusive' },
    measured_at: Date,
    _id: false
  },

  // Embedding para búsqueda por similitud semántica
  embedding: { type: [Number], default: [] },
  embedded_text: { type: String, default: '' },     // el texto que se embebió (debug)
  embedding_model: { type: String, default: 'text-embedding-3-small' },

  // Importancia subjetiva del episodio (0-1). Los high-importance
  // se retrievean con más peso.
  importance: { type: Number, default: 0.5, min: 0, max: 1 },

  tags: [{ type: String }],

  // Trazabilidad
  source_rec_id: { type: String, default: null },              // si vino de una rec
  source_outcome_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ZeusRecommendationOutcome', default: null },
  source_action_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ActionLog', default: null },
  source: { type: String, enum: ['auto_from_outcome', 'auto_from_action', 'manual', 'backfill'], default: 'auto_from_outcome' },

  occurred_at: { type: Date, required: true, index: true },  // cuándo pasó
  created_at: { type: Date, default: Date.now, index: true } // cuándo se registró
});

zeusEpisodeSchema.index({ category: 1, occurred_at: -1 });

module.exports = mongoose.model('ZeusEpisode', zeusEpisodeSchema);
