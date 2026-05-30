// ═══════════════════════════════════════════════════════════════════════════════
// DIONISIO 🎭 — Agente de creativos en VIDEO (Seedance 2.0 vía PiAPI)
// Toma imágenes ganadoras de Apollo → judge de video-suitability → genera video
// 5s image-to-video con micro-motion → deja en cola "pending_video_review" para
// aprobación MANUAL del creador (human-in-the-loop). Aprobado → Prometheus testea.
// Ver memoria apollo-video / docs.
// ═══════════════════════════════════════════════════════════════════════════════

const logger = require('../../utils/logger');
const CreativeProposal = require('../../db/models/CreativeProposal');
const { judgeVideoSuitability } = require('../creative/video/video-judge');
const { buildMotionPrompt } = require('../creative/video/motion-prompts');
const seedance = require('../creative/video/seedance');

const ENABLED = process.env.DIONYSUS_ENABLED !== 'false';
const MAX_VIDEOS_PER_CYCLE = parseInt(process.env.DIONYSUS_MAX_PER_CYCLE || '3', 10); // control de costo
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-meta-ads-controller.onrender.com';

/** Mapea la sugerencia del judge a una variante del banco de motion-prompts. */
function motionVariantFor(suggested) {
  const map = { drip: 'micro_drip', breeze: 'breeze_napkin', shimmer: 'wet_shimmer', hand_hold: 'hand_hold' };
  return map[suggested] || 'micro_drip';
}

/**
 * Selecciona candidatos a video: imágenes ganadoras/en test que aún no se
 * convirtieron en video. (En cold-start tomamos 'ready'/'testing'; cuando haya
 * graduates reales, priorizar esos.)
 */
async function _getCandidates() {
  // Source proposals de imagen, no video, en estado prometedor.
  const candidates = await CreativeProposal.find({
    media_type: { $ne: 'video' },
    status: { $in: ['testing', 'graduated', 'ready'] },
    image_base64: { $type: 'string', $ne: '' }
  }).sort({ status: 1, created_at: -1 }).limit(40).lean();

  // Filtrar los que YA tienen un video hijo (dedup).
  const ids = candidates.map(c => c._id);
  // Excluir cualquier source que ya tenga un video hijo EXCEPTO si falló por error
  // técnico (status 'failed' → reintento válido). Un 'rejected' cuenta como "ya lo
  // probamos y dijiste que no" → NO se vuelve a elegir esa imagen; así cada ciclo
  // avanza a imágenes FRESCAS en vez de regenerar siempre las mismas. (2026-05-30)
  const existingVideos = await CreativeProposal.find({
    media_type: 'video', source_proposal_id: { $in: ids },
    status: { $ne: 'failed' }
  }).select('source_proposal_id').lean();
  const done = new Set(existingVideos.map(v => String(v.source_proposal_id)));
  return candidates.filter(c => !done.has(String(c._id)));
}

/**
 * runDionysus() — un ciclo: selecciona, juzga, genera videos pendientes de review.
 */
async function runDionysus() {
  if (!ENABLED) { logger.info('[DIONISIO] deshabilitado'); return { skipped: 'disabled' }; }
  if (!seedance.isAvailable()) { logger.warn('[DIONISIO] PIAPI_KEY no configurada — skip'); return { skipped: 'no_piapi_key' }; }

  const t0 = Date.now();
  const candidates = await _getCandidates();
  logger.info(`[DIONISIO] ${candidates.length} candidatos a evaluar (cap ${MAX_VIDEOS_PER_CYCLE} videos/ciclo)`);

  let judged = 0, generated = 0, rejected = 0;
  const results = [];

  for (const c of candidates) {
    if (generated >= MAX_VIDEOS_PER_CYCLE) break;
    judged++;
    // 1. Judge de video-suitability
    let verdict;
    try { verdict = await judgeVideoSuitability(c.image_base64, c.product_name || 'the product'); }
    catch (e) { logger.warn(`[DIONISIO] judge falló para ${c._id}: ${e.message}`); continue; }

    if (!verdict.suitable) {
      rejected++;
      logger.debug(`[DIONISIO] ✗ "${(c.headline||'').slice(0,30)}" score ${verdict.score} — ${verdict.reason}`);
      continue;
    }

    // 2. Crear el registro YA en estado 'generating_video' (para que el panel
    // lo muestre como card "generando…" mientras Seedance trabaja).
    const variant = motionVariantFor(verdict.suggested_motion);
    const { prompt } = buildMotionPrompt(c.product_name || 'the product', variant);
    const placeholder = await CreativeProposal.create({
      adset_id: c.adset_id, product_id: c.product_id, product_name: c.product_name,
      headline: c.headline, primary_text: c.primary_text, link_url: c.link_url,
      media_type: 'video', status: 'generating_video', motion_variant: variant,
      video_judge_score: verdict.score, source_proposal_id: c._id
    });

    // 3. Generar el video (image-to-video desde la URL pública del proposal origen).
    const imageUrl = `${PUBLIC_BASE_URL}/vsrc/${c._id}.png`;
    try {
      const vid = await seedance.generateVideoFromImage({ imageUrl, prompt, durationSeconds: 5, aspectRatio: '9:16' });
      await CreativeProposal.findByIdAndUpdate(placeholder._id, {
        $set: { status: 'pending_video_review', video_url: vid.video_url, video_task_id: vid.task_id }
      });
      generated++;
      results.push({ source: c._id, headline: c.headline, score: verdict.score, video_url: vid.video_url, variant });
      logger.info(`[DIONISIO] 🎬 video listo "${(c.headline||'').slice(0,30)}" (score ${verdict.score}, ${variant}) → pendiente de review`);
    } catch (e) {
      await CreativeProposal.findByIdAndUpdate(placeholder._id, {
        $set: { status: 'failed', rejection_reason: `video gen failed: ${e.message}` }
      });
      logger.error(`[DIONISIO] generación falló para ${c._id}: ${e.message}`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  logger.info(`[DIONISIO] ciclo: ${judged} juzgados · ${generated} videos generados · ${rejected} no aptos · ${elapsed}s`);
  return { judged, generated, rejected, elapsed_s: elapsed, results };
}

module.exports = { runDionysus };
