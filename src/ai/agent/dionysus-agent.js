// ═══════════════════════════════════════════════════════════════════════════════
// DIONISIO 🎭 — Agente de creativos en VIDEO (Seedance 2.0 vía PiAPI)
// Toma imágenes ganadoras de Apollo → judge de video-suitability → genera video
// 5s image-to-video con micro-motion → deja en cola "pending_video_review" para
// aprobación MANUAL del creador (human-in-the-loop). Aprobado → Prometheus testea.
// Ver memoria apollo-video / docs.
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const logger = require('../../utils/logger');
const CreativeProposal = require('../../db/models/CreativeProposal');
const { judgeVideoSuitability } = require('../creative/video/video-judge');
const dna = require('../creative/video/video-dna');
const seedance = require('../creative/video/seedance');

// Tope del mp4 a persistir en Mongo (doc limit 16MB; base64 infla +33%).
const VIDEO_PERSIST_MAX_BYTES = parseInt(process.env.VIDEO_PERSIST_MAX_BYTES || String(10 * 1024 * 1024), 10);

/**
 * PERSISTIR el video en Mongo (2026-06-13): las URLs de Seedance/PiAPI son /ephemeral/
 * y EXPIRAN a las horas → la cola de review mostraba videos negros. Descarga el mp4 y lo
 * guarda en CreativeProposal.video_base64 (servido por /vid/:id.mp4, no expira).
 * @returns {string} la URL pública persistente, o sourceUrl si no se pudo (fail-open).
 */
async function persistVideo(proposalId, sourceUrl) {
  try {
    const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 90000, maxContentLength: VIDEO_PERSIST_MAX_BYTES });
    const buf = Buffer.from(resp.data);
    if (buf.length > VIDEO_PERSIST_MAX_BYTES) {
      logger.warn(`[DIONISIO] video ${proposalId} pesa ${Math.round(buf.length / 1048576)}MB (>${Math.round(VIDEO_PERSIST_MAX_BYTES / 1048576)}MB) — no persisto, queda en ephemeral`);
      return sourceUrl;
    }
    await CreativeProposal.findByIdAndUpdate(proposalId, { $set: { video_base64: buf.toString('base64') } });
    return `${PUBLIC_BASE_URL}/vid/${proposalId}.mp4`;
  } catch (e) {
    logger.warn(`[DIONISIO] persistir video ${proposalId} falló (queda en ephemeral): ${e.message}`);
    return sourceUrl;
  }
}

const ENABLED = process.env.DIONYSUS_ENABLED !== 'false';
const MAX_VIDEOS_PER_CYCLE = parseInt(process.env.DIONYSUS_MAX_PER_CYCLE || '8', 10); // 2026-06-05: 3→6 · 2026-06-10: 6→8 + cron 2x→4x/día (pool de fuentes lleno + tests a $50 rotan en 1-2d; Dionisio era el cuello)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-meta-ads-controller.onrender.com';
// AUTO-APROBAR (2026-06-05, "extremo"): desclava el cuello de la aprobación manual.
// Los videos de ALTA confianza (source judge alto + motion sin historial de rechazo)
// pasan directo a 'ready' (→ Prometheus); los dudosos siguen a review manual. Honesto:
// el judge mira la IMAGEN-fuente, no el video de salida — por eso solo auto-aprueba los
// muy seguros + el loop de rechazo (DNA) sigue penalizando motions que desfiguran.
const AUTO_APPROVE = process.env.DIONYSUS_AUTO_APPROVE !== 'false';
const AUTO_APPROVE_MIN_SCORE = parseInt(process.env.DIONYSUS_AUTO_APPROVE_MIN_SCORE || '80', 10);
const AUTO_APPROVE_MAX_MOTION_REJECT = parseFloat(process.env.DIONYSUS_AUTO_APPROVE_MAX_REJECT || '0.4');
// Motions con FÍSICA difícil (caída/vertido de objetos) — la IA tiende a pegarlos/congelar
// en el aire (se nota artificial). NUNCA auto-aprobar estos: siempre review manual (el humano
// es el mejor juez de física). 2026-06-05, por el reporte de pickles "stuck" al verter.
const HIGH_PHYSICS_MOTIONS = new Set(['pour_bowl']);
// PILOTO first+last frame: APAGADO 2026-06-13 por la data del A/B. El par de frames
// produjo el DOBLE de física rota (reject 36% con par, n=14 vs 19% solo, n=43) — el
// frame final generado no calza perfecto con el inicial y Seedance al interpolar entre
// dos frames inconsistentes mete más artefactos. La capacidad queda en el código;
// reactivar con SEEDANCE_LAST_FRAME_RATE si mejoramos la consistencia del frame final.
const LAST_FRAME_RATE = parseFloat(process.env.SEEDANCE_LAST_FRAME_RATE || '0');
// POST-PRO hook overlay (2026-06-10): % de videos que llevan el texto-gancho quemado
// (estilo UGC nativo, Anton bold). A/B 50/50 — el overlay debería mover el THUMBSTOP.
const OVERLAY_RATE = parseFloat(process.env.VIDEO_OVERLAY_RATE || '0.5');

/** Mapea la sugerencia del judge a un motion del DNA. Fallback raro: la imagen-fuente
 *  casi siempre trae su motion baked, así que esto solo aplica a fuentes legacy. NO
 *  colapsar todo a lift_drip (era la causa de que todos los videos se vieran igual);
 *  ante desconocido, elegir un motion válido al azar. */
function motionVariantFor(suggested) {
  const map = {
    lift_drip: 'lift_drip', dip_drip: 'dip_drip', pull_up: 'pull_up', drip: 'lift_drip',
    pinch: 'pinch_twirl', bite: 'bite_tease'
  };
  if (map[suggested]) return map[suggested];
  const all = dna.keys('motion');
  return all[Math.floor(Math.random() * all.length)];
}

/**
 * Selecciona candidatos a video: imágenes ganadoras/en test que aún no se
 * convirtieron en video. (En cold-start tomamos 'ready'/'testing'; cuando haya
 * graduates reales, priorizar esos.)
 */
async function _getCandidates() {
  // SOLO imágenes de la vía dedicada 'video_source' (interacción mano+chip+salsa,
  // hechas para video). No animamos fotos de producto estáticas. (2026-05-30)
  const candidates = await CreativeProposal.find({
    media_type: { $ne: 'video' },
    tags: 'video_source',
    status: { $nin: ['failed', 'rejected'] },
    image_base64: { $type: 'string', $ne: '' }
  }).sort({ created_at: -1 }).limit(40).lean();

  // FRENO POR PRODUCTO RETIRADO (2026-06-15, pool-wide 2026-06-16): no animar
  // video_sources de productos eliminados del ProductBank (ej. "Pickle Chamoy" retirado).
  // POOL-WIDE: marca rejected TODAS las fuentes de productos retirados, no solo las 40 que
  // trae esta query (las viejas quedan debajo del límite y se acumulaban sin limpiarse).
  // Fail-open si ProductBank no se puede leer / viene vacío.
  let pool = candidates;
  try {
    const ProductBank = require('../../db/models/ProductBank');
    const activeProducts = await ProductBank.find({ active: true }).select('product_name').lean();
    const activeNames = activeProducts.map(p => p.product_name).filter(Boolean);
    if (activeNames.length > 0) {
      const r = await CreativeProposal.updateMany(
        { media_type: { $ne: 'video' }, tags: 'video_source', status: { $nin: ['failed', 'rejected'] }, product_name: { $nin: activeNames } },
        { $set: { status: 'rejected', rejection_reason: 'producto retirado del ProductBank' } }
      );
      if (r.modifiedCount) logger.info(`[DIONISIO] ${r.modifiedCount} video_source(s) de producto(s) retirado(s) → rejected (pool-wide)`);
      const activeSet = new Set(activeNames);
      pool = candidates.filter(c => !c.product_name || activeSet.has(c.product_name));
    }
  } catch (e) { logger.warn(`[DIONISIO] freno por producto retirado falló (fail-open): ${e.message}`); }

  // Filtrar los que YA tienen un video hijo (dedup).
  const ids = pool.map(c => c._id);
  // Excluir cualquier source que ya tenga un video hijo EXCEPTO si falló por error
  // técnico (status 'failed' → reintento válido). Un 'rejected' cuenta como "ya lo
  // probamos y dijiste que no" → NO se vuelve a elegir esa imagen; así cada ciclo
  // avanza a imágenes FRESCAS en vez de regenerar siempre las mismas. (2026-05-30)
  const existingVideos = await CreativeProposal.find({
    media_type: 'video', source_proposal_id: { $in: ids },
    status: { $ne: 'failed' }
  }).select('source_proposal_id').lean();
  const done = new Set(existingVideos.map(v => String(v.source_proposal_id)));
  return pool.filter(c => !done.has(String(c._id)));
}

const STUCK_MIN = parseInt(process.env.DIONYSUS_STUCK_MIN || '30', 10);

/**
 * Reconcilia videos pegados en 'generating_video' (zombies por restart de proceso
 * mid-render). Si el task de PiAPI terminó → lo recupera a review; si no → failed
 * (libera la imagen-fuente para reintentar). Auto-sana sin intervención manual.
 */
async function reconcileStuckVideos() {
  const cutoff = new Date(Date.now() - STUCK_MIN * 60000);
  const stuck = await CreativeProposal.find({
    media_type: 'video', status: 'generating_video', created_at: { $lt: cutoff }
  }).lean();
  if (!stuck.length) return 0;
  const HARD_MAX_MIN = parseInt(process.env.DIONYSUS_STUCK_HARD_MIN || '45', 10); // tope absoluto
  let healed = 0;
  for (const s of stuck) {
    try {
      const ageMin = Math.round((Date.now() - new Date(s.created_at).getTime()) / 60000);
      const nm = (s.headline || '').slice(0, 30);
      if (s.video_task_id && seedance.isAvailable()) {
        const r = await seedance.getTaskResult(s.video_task_id).catch(() => null);
        if (r && (r.status === 'completed' || r.status === 'success') && r.video_url) {
          await CreativeProposal.findByIdAndUpdate(s._id, { $set: { status: 'pending_video_review', video_url: r.video_url } });
          logger.info(`[DIONISIO] reconcile: recuperado "${nm}" (task completó en PiAPI) → review`);
          healed++; continue;
        }
        // PiAPI todavía procesando y no pasó el tope → dejarlo (puede completar).
        if (r && r.status !== 'failed' && ageMin < HARD_MAX_MIN) {
          logger.info(`[DIONISIO] reconcile: "${nm}" sigue en PiAPI (${r.status||'processing'}, ${ageMin}min) — espero`);
          continue;
        }
      }
      // Sin task_id (murió antes de submit) o falló/superó el tope → failed.
      await CreativeProposal.findByIdAndUpdate(s._id, { $set: { status: 'failed', rejection_reason: `stuck generating_video ${ageMin}min — reconciled` } });
      logger.info(`[DIONISIO] reconcile: "${nm}" pegado ${ageMin}min → failed (libera fuente)`);
      healed++;
    } catch (e) { logger.warn(`[DIONISIO] reconcile falló ${s._id}: ${e.message}`); }
  }
  return healed;
}

/**
 * runDionysus() — un ciclo: selecciona, juzga, genera videos pendientes de review.
 */
async function runDionysus() {
  if (!ENABLED) { logger.info('[DIONISIO] deshabilitado'); return { skipped: 'disabled' }; }
  if (!seedance.isAvailable()) { logger.warn('[DIONISIO] PIAPI_KEY no configurada — skip'); return { skipped: 'no_piapi_key' }; }

  // Auto-sanar zombies antes de generar nuevos.
  await reconcileStuckVideos().catch(e => logger.warn(`[DIONISIO] reconcile error: ${e.message}`));

  // Cargar el registro de FORMAS leídas del frasco real (ProductBank.product_form) →
  // el juez (expectedUnit) y el prompt de video usan la forma verdadera, no la
  // heurística de nombre. (2026-06-10)
  try {
    const ProductBank = require('../../db/models/ProductBank');
    const forms = await ProductBank.find({ product_form: { $nin: [null, ''] } }).select('product_name product_form').lean();
    for (const p of forms) dna.setProductForm(p.product_name, p.product_form);
    if (forms.length) logger.info(`[DIONISIO] formas de producto cargadas: ${forms.map(p => `${p.product_name}=${p.product_form}`).join(' · ')}`);
  } catch (e) { logger.warn(`[DIONISIO] carga de formas falló (heurística de nombre): ${e.message}`); }

  const t0 = Date.now();
  const candidates = await _getCandidates();
  logger.info(`[DIONISIO] ${candidates.length} candidatos a evaluar (cap ${MAX_VIDEOS_PER_CYCLE} videos/ciclo)`);

  // DNA de cámara — exploit/explore: qué movimiento de cámara rinde mejor.
  const cameraStats = await dna.getDimensionStats('camera').catch(() => ({}));
  // DNA de motion — para el auto-approve: no auto-aprobar motions con historial de rechazo.
  const motionStats = await dna.getDimensionStats('motion').catch(() => ({}));

  let judged = 0, generated = 0, rejected = 0;
  const results = [];

  for (const c of candidates) {
    if (generated >= MAX_VIDEOS_PER_CYCLE) break;
    judged++;
    // 1. Judge de video-suitability
    let verdict;
    try { verdict = await judgeVideoSuitability(c.image_base64, c.product_name || 'the product', c.source_archetype || 'classic'); }
    catch (e) { logger.warn(`[DIONISIO] judge falló para ${c._id}: ${e.message}`); continue; }

    if (!verdict.suitable) {
      rejected++;
      logger.debug(`[DIONISIO] ✗ "${(c.headline||'').slice(0,30)}" score ${verdict.score} — ${verdict.reason}`);
      continue;
    }

    // 2. Crear el registro YA en estado 'generating_video' (para que el panel
    // lo muestre como card "generando…" mientras Seedance trabaja).
    // motion = BAKED en la imagen-fuente (la interacción ya está en la foto).
    // camera = exploit/explore del DNA. scene = heredada de la fuente.
    const variant = c.motion_variant || motionVariantFor(verdict.suggested_motion);
    const camera = dna.pickWeighted('camera', cameraStats);
    // Directiva APRENDIDA del loop (reconciliador) — '' si aún no hay data
    let learnDirective = '';
    try { learnDirective = await require('../creative/video/video-learning').getPromptLearning(variant); } catch (_) { /* fail-open */ }
    const prompt = dna.buildVideoPrompt(c.product_name || 'the product', variant, camera, undefined, learnDirective);
    const placeholder = await CreativeProposal.create({
      adset_id: c.adset_id, product_id: c.product_id, product_name: c.product_name,
      headline: c.headline, primary_text: c.primary_text, link_url: c.link_url,
      media_type: 'video', status: 'generating_video',
      motion_variant: variant, camera, scene: c.scene || '', hook_variant: c.hook_variant || '', creative_concept: c.creative_concept || null,
      source_archetype: c.source_archetype || 'classic', // hereda del source → medir conversión por arquetipo
      video_judge_score: verdict.score,
      video_judge_breakdown: {
        reason: verdict.reason,
        breakdown: verdict.breakdown,
        que_funciona: verdict.que_funciona,
        que_falla: verdict.que_falla
      },
      source_proposal_id: c._id
    });

    // Señales creativas abstractas (Pilar 4) — desde la imagen-fuente, fire-and-forget
    // (no bloquea la generación del video). Alimenta la calibración del juez.
    require('../creative/video/video-signals').extractCreativeSignals(c.image_base64, c.product_name, variant)
      .then(sig => sig && CreativeProposal.findByIdAndUpdate(placeholder._id, { $set: { creative_signals: sig } }))
      .catch(() => {});

    // 3. Generar el video (image-to-video desde la URL pública del proposal origen).
    // PILOTO first+last (2026-06-09): si la fuente trae frame final, A/B al 50% —
    // mitad con par de frames, mitad como hoy. used_last_frame marca la cohorte
    // para que el reconciliador compare hold/rechazos entre ambas.
    const imageUrl = `${PUBLIC_BASE_URL}/vsrc/${c._id}.png`;
    const hasEndFrame = !!(c.end_frame_base64 && c.end_frame_base64.length > 100);
    const useLastFrame = hasEndFrame && Math.random() < LAST_FRAME_RATE;
    const lastFrameUrl = useLastFrame ? `${PUBLIC_BASE_URL}/vsrc/${c._id}/end.png` : null;
    try {
      const vid = await seedance.generateVideoFromImage({
        imageUrl, lastFrameUrl, prompt, durationSeconds: 5, aspectRatio: '9:16',
        // Persistir el task_id YA (apenas se emite) → si el proceso muere
        // mid-render, reconcileStuckVideos puede recuperarlo desde PiAPI.
        onSubmit: (taskId) => CreativeProposal.findByIdAndUpdate(placeholder._id, { $set: { video_task_id: taskId, used_last_frame: useLastFrame } })
      });
      // POST-PRO: hook text overlay (A/B 50%) — se quema ANTES del juez para que Gemini
      // juzgue el video final tal como lo verá la gente. Fail-open: sin overlay, sale crudo.
      let finalVideoUrl = vid.video_url;
      let usedOverlay = false;
      // Fallback para fuentes pre-hook_text (pool viejo): primeras 5 palabras del headline.
      const hookText = (c.hook_text || (c.headline || '').split(/\s+/).slice(0, 5).join(' ')).trim();
      if (hookText && Math.random() < OVERLAY_RATE) {
        try {
          const { applyHookOverlay } = require('../creative/video/video-postpro');
          const overlaid = await applyHookOverlay({ videoUrl: vid.video_url, hookText, outId: String(placeholder._id) });
          if (overlaid) { finalVideoUrl = overlaid; usedOverlay = true; }
        } catch (e) { logger.warn(`[DIONISIO] overlay falló (sale crudo): ${e.message}`); }
      }

      // JUEZ DE VIDEO REAL (Gemini mira el mp4) — ve movimiento/artefactos/freezing
      // que el juez de imagen no puede. Auto-rechaza videos rotos y gatea el auto-aprobado.
      // Usa finalVideoUrl mientras el ephemeral aún está vivo (recién generado).
      let videoVerdict = null;
      try { videoVerdict = await require('../creative/video/video-result-judge').judgeVideoResult(finalVideoUrl, c.product_name, variant); } catch (_) { /* fail-open */ }

      if (videoVerdict && videoVerdict.verdict === 'reject') {
        // No persistimos los rechazados (se descartan) — quedan con la URL que sea.
        await CreativeProposal.findByIdAndUpdate(placeholder._id, {
          $set: { status: 'rejected', video_url: finalVideoUrl, video_url_raw: vid.video_url, used_text_overlay: usedOverlay, hook_text: usedOverlay ? hookText : '', video_task_id: vid.task_id, video_result_verdict: videoVerdict, rejection_reason: `juez de video: ${videoVerdict.notes || 'roto (artefactos/freezing)'}` }
        });
        rejected++;
        logger.info(`[DIONISIO] 🚫 video roto auto-rechazado: "${(c.headline || '').slice(0, 30)}" — ${videoVerdict.notes}`);
        continue;
      }

      // PERSISTIR el mp4 en Mongo antes de que el ephemeral de PiAPI expire (los que
      // SOBREVIVEN al juez van a cola/testing y deben seguir visibles días después).
      finalVideoUrl = await persistVideo(placeholder._id, finalVideoUrl);

      // AUTO-APROBAR alta confianza → directo a 'ready' (Prometheus); dudosos → review manual.
      const ms = motionStats[variant] || {};
      const motionReject = ((ms.n || 0) + (ms.reject_n || 0)) > 0 ? (ms.reject_n || 0) / ((ms.n || 0) + (ms.reject_n || 0)) : 0;
      const autoOk = AUTO_APPROVE && verdict.score >= AUTO_APPROVE_MIN_SCORE
        && motionReject < AUTO_APPROVE_MAX_MOTION_REJECT
        && !HIGH_PHYSICS_MOTIONS.has(variant) // física de caída → siempre review manual
        && (!videoVerdict || videoVerdict.verdict === 'good'); // el juez de video debe aprobarlo
      const newStatus = autoOk ? 'ready' : 'pending_video_review';
      await CreativeProposal.findByIdAndUpdate(placeholder._id, {
        $set: { status: newStatus, video_url: finalVideoUrl, video_url_raw: vid.video_url, used_text_overlay: usedOverlay, hook_text: usedOverlay ? hookText : '', video_task_id: vid.task_id, video_result_verdict: videoVerdict, ...(autoOk ? { auto_approved_at: new Date() } : {}) }
      });
      generated++;
      results.push({ source: c._id, headline: c.headline, score: verdict.score, video_url: finalVideoUrl, variant, auto_approved: autoOk });
      logger.info(`[DIONISIO] 🎬 ${autoOk ? '⚡ AUTO-APROBADO → ready (Prometheus)' : 'pendiente review'}: "${(c.headline || '').slice(0, 30)}" (score ${verdict.score}, ${variant}${useLastFrame ? ', 🎬 first+last' : ''}${usedOverlay ? `, 📝 "${hookText}"` : ''}${videoVerdict ? `, video ${videoVerdict.verdict} ${videoVerdict.overall}` : ''})`);
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

/**
 * Recupera EXACTAMENTE los videos que fallaron (status 'failed') — re-genera cada uno
 * desde su MISMA fuente, reusando el placeholder (NO crea videos nuevos del pool). Para
 * cuando un cron murió por crédito agotado / 500s transitorios y querés recuperar SOLO
 * esos, sin gastar de más. @param hoursBack ventana de fallidos a recuperar.
 */
async function retryFailedVideos({ hoursBack = 6, limit = 20 } = {}) {
  const since = new Date(Date.now() - hoursBack * 3600000);
  const failed = await CreativeProposal.find({ media_type: 'video', status: 'failed', created_at: { $gte: since } })
    .sort({ created_at: -1 }).limit(limit).lean();
  logger.info(`[DIONISIO-RETRY] recuperando ${failed.length} videos fallidos (últimas ${hoursBack}h)`);
  let recovered = 0, skipped = 0, reFailed = 0;
  for (const f of failed) {
    try {
      const source = f.source_proposal_id ? await CreativeProposal.findById(f.source_proposal_id).lean() : null;
      if (!source || !source.image_base64) { skipped++; logger.warn(`[DIONISIO-RETRY] ${f._id}: fuente no disponible — skip`); continue; }
      const variant = f.motion_variant || 'lift_drip';
      const camera = f.camera || 'static';
      const prompt = dna.buildVideoPrompt(source.product_name || f.product_name || 'the product', variant, camera);
      const imageUrl = `${PUBLIC_BASE_URL}/vsrc/${source._id}.png`;
      await CreativeProposal.findByIdAndUpdate(f._id, { $set: { status: 'generating_video', rejection_reason: '' } });
      const vid = await seedance.generateVideoFromImage({
        imageUrl, prompt, durationSeconds: 5, aspectRatio: '9:16',
        onSubmit: (taskId) => CreativeProposal.findByIdAndUpdate(f._id, { $set: { video_task_id: taskId } })
      });
      await CreativeProposal.findByIdAndUpdate(f._id, { $set: { status: 'pending_video_review', video_url: vid.video_url, video_task_id: vid.task_id } });
      recovered++;
      logger.info(`[DIONISIO-RETRY] ✓ recuperado: "${(f.headline || '').slice(0, 30)}" (${variant})`);
    } catch (e) {
      await CreativeProposal.findByIdAndUpdate(f._id, { $set: { status: 'failed', rejection_reason: `retry falló: ${e.message}` } });
      reFailed++;
      logger.warn(`[DIONISIO-RETRY] ✗ ${f._id} falló de nuevo: ${e.message}`);
    }
  }
  logger.info(`[DIONISIO-RETRY] DONE: ${recovered} recuperados · ${reFailed} re-fallaron · ${skipped} sin fuente`);
  return { recovered, reFailed, skipped, total: failed.length };
}

module.exports = { runDionysus, reconcileStuckVideos, retryFailedVideos };
