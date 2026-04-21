/**
 * Episodic Memory — razonamiento por analogía para Zeus.
 *
 * Guarda episodios como vectores embedding + metadata. Cuando Zeus enfrenta
 * una situación nueva, hace retrieval de los top-K episodios más similares
 * del pasado para usar como contexto en su razonamiento.
 *
 * Diferencia clave con playbooks (reglas): no son reglas generalizadas, son
 * casos específicos con outcomes medidos. "La vez que pasó X, duró Y, salió así."
 */

const OpenAI = require('openai');
const config = require('../../../config');
const logger = require('../../utils/logger');

const ZeusEpisode = require('../../db/models/ZeusEpisode');
const ZeusRecommendationOutcome = require('../../db/models/ZeusRecommendationOutcome');
const ActionLog = require('../../db/models/ActionLog');

const openai = new OpenAI({ apiKey: config.openai.apiKey });
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims, barato ($0.02 per 1M tokens)

/**
 * Embed de texto — wrapper defensivo.
 */
async function embedText(text) {
  if (!text || text.trim().length === 0) return [];
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000) // hard cap para evitar payloads gigantes
    });
    return response.data[0]?.embedding || [];
  } catch (err) {
    logger.error(`[EPISODIC] embedText failed: ${err.message}`);
    return [];
  }
}

/**
 * Cosine similarity entre dos vectores.
 */
function cosineSim(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Genera el texto que se va a embeber para un episodio.
 * Concatena los campos semánticamente relevantes.
 */
function buildEmbeddingText(ep) {
  const parts = [];
  if (ep.title) parts.push(ep.title);
  if (ep.narrative) parts.push(ep.narrative);
  if (ep.category) parts.push(`categoría: ${ep.category}`);
  if (ep.context?.entity_name) parts.push(`sobre: ${ep.context.entity_name}`);
  if (ep.decision?.action) parts.push(`acción: ${ep.decision.action}`);
  if (ep.decision?.rationale) parts.push(`razón: ${ep.decision.rationale}`);
  if (ep.outcome?.short_term) parts.push(`resultado 7d: ${ep.outcome.short_term}`);
  if (ep.outcome?.mid_term) parts.push(`resultado 30d: ${ep.outcome.mid_term}`);
  if (ep.outcome?.verdict) parts.push(`veredicto: ${ep.outcome.verdict}`);
  return parts.join(' | ');
}

/**
 * Crea un episodio con embedding automático.
 */
async function createEpisode(data) {
  const embedded_text = buildEmbeddingText(data);
  const embedding = await embedText(embedded_text);

  const episode = await ZeusEpisode.create({
    ...data,
    embedding,
    embedded_text,
    embedding_model: EMBEDDING_MODEL,
    occurred_at: data.occurred_at || new Date()
  });
  return episode;
}

/**
 * Busca los top-K episodios más similares a un texto dado.
 * Filtros opcionales: category, tags, min_importance.
 */
async function findSimilarEpisodes(queryText, options = {}) {
  const { topK = 3, category, minImportance = 0, tags } = options;

  const queryEmbedding = await embedText(queryText);
  if (queryEmbedding.length === 0) return [];

  const filter = { embedding: { $exists: true, $ne: [] } };
  if (category) filter.category = category;
  if (minImportance > 0) filter.importance = { $gte: minImportance };
  if (tags?.length) filter.tags = { $in: tags };

  // Traemos un pool y re-rankeamos por similitud (Mongo no tiene vector search sin Atlas Search)
  const pool = await ZeusEpisode.find(filter)
    .sort({ importance: -1, occurred_at: -1 })
    .limit(200)
    .lean();

  const scored = pool.map(ep => ({
    ...ep,
    similarity: cosineSim(queryEmbedding, ep.embedding)
  })).filter(x => x.similarity > 0.5); // threshold mínimo de relevancia

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK).map(ep => ({
    _id: ep._id,
    title: ep.title,
    narrative: ep.narrative,
    category: ep.category,
    context: ep.context,
    decision: ep.decision,
    outcome: ep.outcome,
    importance: ep.importance,
    occurred_at: ep.occurred_at,
    similarity: +ep.similarity.toFixed(3),
    days_ago: Math.round((Date.now() - new Date(ep.occurred_at).getTime()) / 86400000)
  }));
}

/**
 * Auto-crea un episodio desde un ZeusRecommendationOutcome cuando tiene
 * measurement_30d completo. Idempotente — no duplica.
 */
async function createEpisodeFromOutcome(outcomeId) {
  const out = await ZeusRecommendationOutcome.findById(outcomeId).lean();
  if (!out) return null;
  if (!out.measurement_30d?.measured_at) {
    return null; // aún no hay medición de 30d
  }
  // Dedupe
  const existing = await ZeusEpisode.findOne({ source_outcome_id: outcomeId });
  if (existing) return existing;

  const verdict = (() => {
    const v7 = out.measurement_7d?.verdict;
    const v30 = out.measurement_30d?.verdict;
    if (v30 === 'confirmed' || v7 === 'confirmed') return 'success';
    if (v30 === 'missed' || v30 === 'inverse') return 'failure';
    if (v30 === 'partial') return 'mixed';
    return 'inconclusive';
  })();

  return await createEpisode({
    title: `${out.rec_type}/${out.category} · ${out.entity_name || out.entity_id}`,
    narrative: `Tomamos una rec tipo "${out.rec_type}" en categoría "${out.category}" sobre ${out.entity_name || 'entidad'}. Predicción: ${out.predicted_impact || 'n/a'}. A los 7 días: ${out.measurement_7d?.actual_magnitude || 'sin medir'}. A los 30 días: ${out.measurement_30d?.actual_magnitude || 'sin medir'}.`,
    category: out.rec_type === 'scale' ? 'scale' :
              out.rec_type === 'pause' ? 'pause' :
              out.rec_type === 'test' ? 'test_graduation' :
              out.rec_type === 'code_change' ? 'other' : 'other',
    context: {
      entity_type: out.entity_type,
      entity_id: out.entity_id,
      entity_name: out.entity_name,
      metrics_at_time: out.baseline || {}
    },
    decision: {
      action: out.rec_type,
      actor: 'zeus',
      rationale: out.predicted_impact || ''
    },
    outcome: {
      short_term: out.measurement_7d?.actual_magnitude || '',
      mid_term: out.measurement_30d?.actual_magnitude || '',
      verdict,
      measured_at: out.measurement_30d?.measured_at
    },
    importance: verdict === 'failure' ? 0.8 : (verdict === 'success' ? 0.7 : 0.5),
    tags: [out.rec_type, out.category],
    source: 'auto_from_outcome',
    source_rec_id: out.rec_id,
    source_outcome_id: out._id,
    occurred_at: out.applied_at
  });
}

/**
 * Barrido periódico: busca outcomes con measurement_30d completo que aún
 * no tienen episodio asociado y los convierte.
 * Invocar desde cron (ej. junto al learner cron).
 */
async function backfillPendingEpisodes(limit = 20) {
  const since90d = new Date(Date.now() - 90 * 86400000);
  const candidates = await ZeusRecommendationOutcome.find({
    applied_at: { $gte: since90d },
    'measurement_30d.measured_at': { $ne: null }
  }).sort({ 'measurement_30d.measured_at': -1 }).limit(limit).lean();

  let created = 0;
  for (const c of candidates) {
    try {
      const ep = await createEpisodeFromOutcome(c._id);
      if (ep && ep.created_at && (Date.now() - new Date(ep.created_at).getTime()) < 60000) {
        created++;
      }
    } catch (err) {
      logger.warn(`[EPISODIC] backfill for outcome ${c._id} failed: ${err.message}`);
    }
  }
  logger.info(`[EPISODIC] backfill: ${created} new episodes from ${candidates.length} candidates`);
  return { evaluated: candidates.length, created };
}

module.exports = {
  createEpisode,
  findSimilarEpisodes,
  createEpisodeFromOutcome,
  backfillPendingEpisodes,
  embedText,
  cosineSim
};
