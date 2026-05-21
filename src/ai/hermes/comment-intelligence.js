/**
 * Comment Intelligence — sistema de comentarios de Hermes (2026-05-21).
 *
 * El foot traffic de Hermes no es medible por atribución directa (el personal
 * de la tienda no usa ningún sistema; solo reporta un número agregado verbal).
 * Los comentarios de los ads son la única señal digital atribuible POR creativo.
 *
 * Tres patas, un solo pipeline:
 *   1. MEDIR    — clasificar cada comentario (intención de visita, pregunta,
 *                 resonancia) → score de intención por creativo/oferta.
 *   2. DETECTAR — flag de creativos que confunden/repelen (ej. el caso real
 *                 "bloody pickles" — un visual rojo con drip que se lee como
 *                 sangre, invisible en métricas de Meta).
 *   3. RESPONDER— híbrido por confianza: auto-publica respuestas determinísticas
 *                 de alta confianza (ej. "Where?" → dirección fija), manda a
 *                 cola de aprobación lo ambiguo o sensible (negative_creative
 *                 NUNCA se auto-responde).
 *
 * Seguridad: el auto-reply arranca OFF (HERMES_COMMENT_AUTOREPLY=false). Con
 * el flag apagado, incluso las respuestas high-confidence van a cola manual,
 * para que el creador valide la calidad antes de soltar la escritura pública.
 * Patrón shadow→live, igual que el resto del sistema.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const HermesComment = require('../../db/models/HermesComment');
const HermesProposal = require('../../db/models/HermesProposal');

const claude = new Anthropic({ apiKey: config.claude.apiKey });
const MODEL_CLASSIFY = 'claude-haiku-4-5-20251001';  // alto volumen, clasificación simple
const MODEL_REPLY = 'claude-sonnet-4-6';             // respuestas públicas — calidad importa

// ≥ este número de comentarios negative_creative en un creativo → flag.
const CREATIVE_ISSUE_THRESHOLD = 2;

/** Extrae el primer bloque JSON de una respuesta de Claude. */
function parseJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FOUNDATION — sync de comentarios desde Meta
// ═══════════════════════════════════════════════════════════════════════

/**
 * Trae comentarios nuevos de todos los ads live de Hermes y los upsertea
 * (dedup por comment_id). No re-procesa los ya guardados.
 */
async function syncComments() {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  const liveProposals = await HermesProposal.find({
    status: 'live',
    meta_ad_id: { $ne: null }
  }).lean();

  if (liveProposals.length === 0) {
    logger.info('[HERMES-COMMENTS] sin proposals live — nada que sincronizar');
    return { ads: 0, new_comments: 0 };
  }

  let newComments = 0;
  let adsOk = 0;

  for (const p of liveProposals) {
    try {
      const { story_id, comments } = await meta.getAdComments(p.meta_ad_id, { limit: 100 });
      adsOk++;

      for (const c of comments) {
        // Upsert: insertar solo si el comment_id es nuevo
        const res = await HermesComment.updateOne(
          { comment_id: c.id },
          {
            $setOnInsert: {
              comment_id: c.id,
              story_id,
              proposal_id: p._id,
              meta_ad_id: p.meta_ad_id,
              offer_type: p.offer_type,
              platform: 'facebook',
              author_name: c.author_name,
              author_id: c.author_id,
              message: c.message,
              created_time: c.created_time,
              like_count: c.like_count,
              reply_count: c.reply_count,
              classification: 'unclassified',
              reply_status: 'none',
              synced_at: new Date()
            }
          },
          { upsert: true }
        );
        if (res.upsertedCount > 0) newComments++;
      }
    } catch (err) {
      logger.warn(`[HERMES-COMMENTS] sync ad ${p.meta_ad_id} falló: ${err.message}`);
    }
  }

  logger.info(`[HERMES-COMMENTS] sync: ${adsOk}/${liveProposals.length} ads, ${newComments} comentarios nuevos`);
  return { ads: adsOk, new_comments: newComments };
}

// ═══════════════════════════════════════════════════════════════════════
// PATA 1 — clasificación con Claude
// ═══════════════════════════════════════════════════════════════════════

const CLASSIFY_SYSTEM = `Clasificás comentarios de Facebook sobre anuncios de Jersey Pickles, una tienda física de pickles en South Hackensack NJ. Los anuncios ofrecen pickles GRATIS en la primera visita para atraer gente a la tienda física.

Tu trabajo: por cada comentario, devolver la señal de FOOT TRAFFIC que contiene.

Categorías (classification):
- "intent_visit": señal de querer ir a la tienda. "Where?", "¿dónde queda?", "paso esta semana", "ya voy para allá", "I'll be there". LA MÁS VALIOSA.
- "visit_reported": dice que ya fue / compró. "fui ayer", "compré el de tajín", "we went last week".
- "question_logistics": pregunta práctica que precede a una visita. Tamaño/tipo de cup, horarios, precio, stock, si la oferta sigue. "any size cup?", "¿hasta qué hora abren?".
- "resonance": le gusta pero no dice que va. "se ve rico", emojis, "yum", "looks amazing".
- "negative_creative": el comentario revela que el VISUAL del ad confunde o repele. Ej: "bloody pickles?", "why are they dripping blood", "looks gross", "is that mold?". CRÍTICO para detectar creativos fallidos.
- "negative_other": queja no relacionada al creativo (servicio, precio caro, etc).
- "spam": spam, bots, links, off-topic total.
- "other": no encaja en lo anterior.

Para cada comentario devolvé:
- classification (una de arriba)
- intent_score: 0-100, qué tan cerca está de una visita REAL (intent_visit alto, resonance bajo, negative 0)
- sentiment: "positive" | "neutral" | "negative"
- creative_issue: true SOLO si revela problema de percepción del visual (alinea con negative_creative)
- summary: razón en ≤10 palabras

Respondé SOLO un array JSON, un objeto por comentario EN EL MISMO ORDEN, con el campo "i" = índice del comentario.`;

/**
 * Clasifica en batch los comentarios unclassified. Procesa hasta `limit`.
 */
async function classifyPending(limit = 60) {
  const pending = await HermesComment.find({ classification: 'unclassified' })
    .sort({ created_time: -1 })
    .limit(limit)
    .lean();

  if (pending.length === 0) return { classified: 0 };

  // Batch a Claude — 1 call para N comentarios
  const list = pending.map((c, i) => ({ i, message: c.message }));
  const userMsg = `Comentarios a clasificar (JSON):\n${JSON.stringify(list, null, 2)}`;

  let parsed;
  try {
    const resp = await claude.messages.create({
      model: MODEL_CLASSIFY,
      max_tokens: 2000,
      system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: userMsg }]
    });
    const text = resp.content.find(b => b.type === 'text')?.text || '';
    parsed = parseJsonBlock(text);
  } catch (err) {
    logger.error(`[HERMES-COMMENTS] clasificación falló: ${err.message}`);
    return { classified: 0, error: err.message };
  }

  if (!Array.isArray(parsed)) {
    logger.warn('[HERMES-COMMENTS] clasificación: respuesta no es array, skip');
    return { classified: 0 };
  }

  const validClasses = new Set([
    'intent_visit', 'visit_reported', 'question_logistics',
    'resonance', 'negative_creative', 'negative_other', 'spam', 'other'
  ]);

  let classified = 0;
  for (const r of parsed) {
    const doc = pending[r.i];
    if (!doc) continue;
    const cls = validClasses.has(r.classification) ? r.classification : 'other';
    await HermesComment.updateOne(
      { _id: doc._id },
      {
        $set: {
          classification: cls,
          intent_score: Math.max(0, Math.min(100, Number(r.intent_score) || 0)),
          sentiment: ['positive', 'neutral', 'negative'].includes(r.sentiment) ? r.sentiment : 'unknown',
          flags_creative_issue: !!r.creative_issue || cls === 'negative_creative',
          classification_summary: (r.summary || '').substring(0, 120),
          classified_at: new Date()
        }
      }
    );
    classified++;
  }

  logger.info(`[HERMES-COMMENTS] clasificados ${classified}/${pending.length} comentarios`);
  return { classified };
}

// ═══════════════════════════════════════════════════════════════════════
// PATA 2 — detección de creativos fallidos
// ═══════════════════════════════════════════════════════════════════════

/**
 * Agrega flags por proposal. Si ≥ CREATIVE_ISSUE_THRESHOLD comentarios marcan
 * problema de visual, devuelve el creativo flaggeado (para panel + señal Zeus).
 */
async function detectCreativeIssues() {
  const rows = await HermesComment.aggregate([
    { $match: { flags_creative_issue: true } },
    { $group: {
      _id: '$proposal_id',
      count: { $sum: 1 },
      meta_ad_id: { $first: '$meta_ad_id' },
      offer_type: { $first: '$offer_type' },
      samples: { $push: '$message' }
    }},
    { $match: { count: { $gte: CREATIVE_ISSUE_THRESHOLD } } },
    { $sort: { count: -1 } }
  ]);

  const flagged = rows.map(r => ({
    proposal_id: r._id,
    meta_ad_id: r.meta_ad_id,
    offer_type: r.offer_type,
    negative_count: r.count,
    samples: (r.samples || []).slice(0, 3)
  }));

  if (flagged.length > 0) {
    logger.warn(`[HERMES-COMMENTS] ${flagged.length} creativo(s) con problema de percepción: ` +
      flagged.map(f => `${f.offer_type}(${f.negative_count})`).join(', '));
  }
  return flagged;
}

// ═══════════════════════════════════════════════════════════════════════
// PATA 3 — respuestas (híbrido por confianza)
// ═══════════════════════════════════════════════════════════════════════

const REPLY_SYSTEM = `Respondés comentarios en los anuncios de Facebook de Jersey Pickles, tienda física de pickles artesanales.

DATOS FIJOS DE LA TIENDA (los únicos que podés afirmar como ciertos):
- Dirección: ${config.hermes.warehouseAddress}
- Mapa: ${config.hermes.googleMapsUrl}
- La oferta del ad: pickles GRATIS en la primera visita.

Voz: cálida, breve, NJ-friendly, en INGLÉS (el mercado es US). Una o dos oraciones máximo. Sin sonar robot.

Por cada comentario decidí:
- should_reply: ¿vale la pena responder? (preguntas e intención sí; resonancia/emojis no necesitan)
- reply_text: la respuesta (en inglés, breve)
- confidence: "high" SOLO si la respuesta usa EXCLUSIVAMENTE los datos fijos de arriba y la pregunta es inequívoca (ej. "Where?" → la dirección). "low" si la respuesta requiere datos que NO tenés (horarios exactos, precios, stock, tamaños de cup específicos, disponibilidad) o si el comentario es ambiguo, sensible, una queja, o critica el creativo.
- reasoning: ≤12 palabras.

REGLA DURA: si el comentario critica el visual/creativo o es negativo, confidence SIEMPRE "low" (lo revisa un humano). Nunca inventes datos que no estén en los datos fijos.

Respondé SOLO un array JSON, un objeto por comentario en el MISMO orden, con campo "i" = índice.`;

/**
 * Para comentarios que requieren respuesta y aún no la tienen, genera el draft
 * con Claude y decide auto-post vs cola según confianza + flag global.
 *
 * Gating híbrido:
 *   - confidence=high + categoría no sensible + HERMES_COMMENT_AUTOREPLY=true
 *       → publica automáticamente (reply_status='auto_posted')
 *   - todo lo demás → reply_status='drafted' (espera aprobación en panel)
 */
async function prepareReplies(limit = 30) {
  const autoReplyEnabled = config.hermes.commentAutoReply === true;

  // Candidatos: clasificados, que típicamente piden respuesta, sin reply aún.
  const candidates = await HermesComment.find({
    classification: { $in: ['intent_visit', 'question_logistics', 'visit_reported', 'negative_creative', 'negative_other'] },
    reply_status: 'none'
  })
    .sort({ intent_score: -1, created_time: -1 })
    .limit(limit)
    .lean();

  if (candidates.length === 0) return { drafted: 0, auto_posted: 0 };

  const list = candidates.map((c, i) => ({ i, classification: c.classification, message: c.message }));

  let parsed;
  try {
    const resp = await claude.messages.create({
      model: MODEL_REPLY,
      max_tokens: 2000,
      system: REPLY_SYSTEM,
      messages: [{ role: 'user', content: `Comentarios (JSON):\n${JSON.stringify(list, null, 2)}` }]
    });
    const text = resp.content.find(b => b.type === 'text')?.text || '';
    parsed = parseJsonBlock(text);
  } catch (err) {
    logger.error(`[HERMES-COMMENTS] generación de respuestas falló: ${err.message}`);
    return { drafted: 0, auto_posted: 0, error: err.message };
  }

  if (!Array.isArray(parsed)) return { drafted: 0, auto_posted: 0 };

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  const SENSITIVE = new Set(['negative_creative', 'negative_other']);

  let drafted = 0;
  let autoPosted = 0;

  for (const r of parsed) {
    const doc = candidates[r.i];
    if (!doc) continue;

    if (!r.should_reply) {
      await HermesComment.updateOne({ _id: doc._id }, { $set: { reply_status: 'skipped', reply_confidence: 'none' } });
      continue;
    }

    const confidence = r.confidence === 'high' ? 'high' : 'low';
    const replyText = (r.reply_text || '').trim();
    const canAuto = autoReplyEnabled
      && confidence === 'high'
      && !SENSITIVE.has(doc.classification)
      && replyText.length > 0;

    if (canAuto) {
      try {
        const posted = await meta.postComment(doc.comment_id, replyText);
        await HermesComment.updateOne({ _id: doc._id }, {
          $set: {
            reply_status: 'auto_posted',
            reply_confidence: confidence,
            reply_text: replyText,
            reply_meta_id: posted?.id || null,
            reply_decided_by: 'auto',
            reply_posted_at: new Date()
          }
        });
        autoPosted++;
      } catch (err) {
        await HermesComment.updateOne({ _id: doc._id }, {
          $set: { reply_status: 'failed', reply_confidence: confidence, reply_text: replyText, reply_error: err.message }
        });
        logger.warn(`[HERMES-COMMENTS] auto-post falló (${doc.comment_id}): ${err.message}`);
      }
    } else {
      // Cola de aprobación manual
      await HermesComment.updateOne({ _id: doc._id }, {
        $set: { reply_status: 'drafted', reply_confidence: confidence, reply_text: replyText }
      });
      drafted++;
    }
  }

  logger.info(`[HERMES-COMMENTS] respuestas: ${autoPosted} auto-publicadas, ${drafted} en cola${autoReplyEnabled ? '' : ' (auto-reply OFF)'}`);
  return { drafted, auto_posted: autoPosted };
}

/**
 * Publica una respuesta aprobada manualmente desde el panel.
 */
async function postApprovedReply(commentDocId, decidedBy = 'user') {
  const doc = await HermesComment.findById(commentDocId);
  if (!doc) throw new Error('comentario no encontrado');
  if (!doc.reply_text?.trim()) throw new Error('sin reply_text para publicar');

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();
  try {
    const posted = await meta.postComment(doc.comment_id, doc.reply_text.trim());
    doc.reply_status = 'posted';
    doc.reply_meta_id = posted?.id || null;
    doc.reply_decided_by = decidedBy;
    doc.reply_posted_at = new Date();
    await doc.save();
    return { posted: true, reply_meta_id: doc.reply_meta_id };
  } catch (err) {
    doc.reply_status = 'failed';
    doc.reply_error = err.message;
    await doc.save();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Orquestador — lo llama el cron
// ═══════════════════════════════════════════════════════════════════════

async function runCommentIntelligenceCycle() {
  const start = Date.now();
  const sync = await syncComments();
  const cls = await classifyPending();
  const flagged = await detectCreativeIssues();
  const replies = await prepareReplies();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  logger.info(`[HERMES-COMMENTS] ciclo completo en ${elapsed}s — ` +
    `${sync.new_comments} nuevos, ${cls.classified} clasificados, ` +
    `${flagged.length} creativos flaggeados, ${replies.auto_posted} auto-respuestas, ${replies.drafted} en cola`);

  return { sync, classified: cls.classified, flagged, replies };
}

module.exports = {
  syncComments,
  classifyPending,
  detectCreativeIssues,
  prepareReplies,
  postApprovedReply,
  runCommentIntelligenceCycle
};
