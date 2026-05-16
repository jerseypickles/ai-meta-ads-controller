/**
 * Hermes Agent — agente autónomo de foot traffic para la tienda física NJ.
 *
 * Redesign 14-may-2026 (post creative repetition feedback):
 *   - gpt-image-2 ahora genera SOLO food porn limpio, sin texto en imagen
 *     (forzado con negative prompts explícitos). Negative space upper 25%
 *     + lower 15% reservado para overlay programático.
 *   - 10 visual_concepts (THE DRIP, THE STICK, THE BITE, etc) rotando con
 *     anti-repeat → garantiza variedad visual real entre creativos.
 *   - overlay-composer.js (refactored) aplica typography editorial encima
 *     de la imagen con fonts custom (Anton/DM Serif/Bebas Neue/Abril
 *     Fatface/Oswald/Inter/Special Elite) embedded via @fontsource.
 *
 * Flujo del ciclo:
 *   1. Pre-checks (enabled, capacity, directive)
 *   2. Pick offer + variant (anti-repeat)
 *   3. Pick visual_concept (10 money shots, filtered por offer compatibility)
 *   4. Pick typography combo (4 combos, anti-repeat)
 *   5. Claude genera SOLO copy (headline + primary_text + tagline)
 *   6. gpt-image-2 genera imagen LIMPIA con composition garantizada
 *   7. overlay-composer aplica typography sobre la imagen
 *   8. Save HermesProposal status=pending
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const HermesProposal = require('../../db/models/HermesProposal');
const offerRotator = require('../hermes/offer-rotator');
const visualConcepts = require('../hermes/visual-concepts');
const { generateCopy } = require('../hermes/copy-generator');
const { generateImage } = require('../hermes/gpt-image');
const { composeAd } = require('../hermes/overlay-composer');

/**
 * Housekeeping — expira proposals stale (pending +N horas sin aprobación).
 */
async function runHermesHousekeeping() {
  const expiryMs = (config.hermes.proposalExpiryHours || 72) * 3600 * 1000;
  const cutoff = new Date(Date.now() - expiryMs);

  const result = await HermesProposal.updateMany(
    { status: 'pending', generated_at: { $lt: cutoff } },
    {
      $set: {
        status: 'expired',
        rejection_reason: `auto: no aprobado en ${config.hermes.proposalExpiryHours}h`,
        decided_at: new Date()
      }
    }
  );
  if (result.modifiedCount > 0) {
    logger.info(`[HERMES-HOUSEKEEPING] Expiradas ${result.modifiedCount} proposals pending +${config.hermes.proposalExpiryHours}h`);
  }
  return { expired: result.modifiedCount };
}

/**
 * Pre-checks antes de generar.
 */
async function preChecks() {
  if (!config.hermes.enabled) {
    return { allowed: false, reason: 'HERMES_ENABLED=false' };
  }

  const pendingCount = await HermesProposal.countDocuments({ status: 'pending' });
  if (pendingCount >= config.hermes.maxActiveAds) {
    return { allowed: false, reason: `${pendingCount} proposals pending (max ${config.hermes.maxActiveAds})` };
  }

  // OpenAI API key requerida para gpt-image-2
  const openaiKey = config.imageGen?.openai?.apiKey || process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return { allowed: false, reason: 'OPENAI_API_KEY no configurada — gpt-image-2 requiere OpenAI' };
  }

  // Directive guard (Zeus puede bloquear)
  try {
    const { isAgentBlocked } = require('../zeus/directive-guard');
    const block = await isAgentBlocked('hermes');
    if (block.blocked) {
      return { allowed: false, reason: `directive: ${block.reason}` };
    }
  } catch (_) { /* fail-open */ }

  return { allowed: true };
}

/**
 * Genera un ad completo: offer + variant + visual_concept + typography
 * → Claude copy → gpt-image-2 food porn limpio → overlay typography.
 * Cada eje rota con anti-repeat.
 */
async function generateProposal(cycleId) {
  // 1. Offer + variant (anti-repeat 2-niveles)
  const { offer, variant } = await offerRotator.pickOfferAvoidingRepeat();
  logger.info(`[HERMES] Ciclo ${cycleId} — offer: ${offer.type}/${variant.id} ("${variant.title}")`);

  // 2. Visual concept (uno de los 10 money shots, filtrado por offer compatibility)
  const visualConcept = await visualConcepts.pickVisualConcept(offer.type);

  // 3. Typography combo (anti-repeat sobre la última)
  const typography = await offerRotator.pickTypography();
  logger.info(`[HERMES] Rotations — Concept:${visualConcept.label} · Typo:${typography.id}`);

  // 4. Address info
  const addressInfo = {
    full: config.hermes.warehouseAddress,
    short: config.hermes.addressShort
  };

  // 5. Build image_prompt deterministic desde visual_concept (no Claude — para que
  //    cada concept produzca shots consistentes con su DNA)
  let imagePrompt = visualConcepts.buildImagePrompt(visualConcept, variant);

  // 5b. Cargar imágenes de referencia activas que matcheen el offer del ciclo.
  //     Si las hay, gpt-image-2 las usa como ancla visual (images.edit) → el
  //     creativo muestra el producto REAL de Jersey Pickles, no uno inventado.
  let referenceImages = [];
  try {
    const HermesReference = require('../../db/models/HermesReference');
    const refs = await HermesReference.find({
      active: true,
      offer_match: { $in: [offer.type, 'any'] }
    }).sort({ uploaded_at: -1 }).limit(4).lean();

    referenceImages = refs.map(r => ({
      buffer: Buffer.from(r.image_base64, 'base64'),
      filename: r.filename || 'ref.png',
      mime_type: r.mime_type || 'image/png'
    }));

    if (referenceImages.length > 0) {
      logger.info(`[HERMES] ${referenceImages.length} referencia(s) activas para ${offer.type}`);
      // Prefijo: instruye a gpt-image-2 a anclar a las referencias manteniendo
      // el producto real, mientras compone el shot del visual concept.
      imagePrompt = `Using the provided reference image(s) as the visual anchor for the real Jersey Pickles product — match its exact look, color, texture and packaging-free presentation — generate a NEW photograph:

${imagePrompt}`;
    }
  } catch (err) {
    logger.warn(`[HERMES] No se pudieron cargar referencias: ${err.message} — sigue sin referencias`);
  }

  // 6. Claude genera SOLO el copy (headline + primary_text + tagline)
  let copy;
  try {
    copy = await generateCopy({ offer, variant, visualConcept, addressInfo });
  } catch (err) {
    logger.error(`[HERMES] Copy generation failed: ${err.message}`);
    return null;
  }

  // 7. gpt-image-2 genera imagen LIMPIA (sin texto rendered). Con referencias
  //    activas usa images.edit; sin ellas, images.generate.
  let imageResult;
  try {
    imageResult = await generateImage(imagePrompt, {
      size: '1024x1536',
      quality: 'medium',
      referenceImages
    });
  } catch (err) {
    logger.error(`[HERMES] Image generation failed: ${err.message}`);
    return null;
  }

  // 8. Overlay typography editorial — DOS composiciones desde 1 sola imagen:
  //    Feed (2:3) + Story/Reel (9:16 con blurred-bg fill + safe zones IG).
  //    gpt-image-2 no tiene 9:16 nativo, así que 1 generación → 2 composiciones
  //    (mismo shot consistente entre placements, sin doble costo de generación).
  const overlayCfg = {
    headline: copy.headline,
    subhead: variant.hook,
    tagline_with_arrow: copy.tagline_with_arrow,
    brand_line: `JERSEY PICKLES · ${addressInfo.short.split('·')[0]?.trim() || 'NJ SHOP'}`,
    typography_id: typography.id,
    accent_color: variant.accent_color
  };
  const baseBuffer = Buffer.from(imageResult.base64, 'base64');

  let composedBase64;
  try {
    const feedBuffer = await composeAd(baseBuffer, { ...overlayCfg, placement: 'feed' });
    composedBase64 = feedBuffer.toString('base64');
  } catch (err) {
    logger.error(`[HERMES] Feed compose failed: ${err.message} — fallback a imagen sin overlay`);
    composedBase64 = imageResult.base64;
  }

  let composedStoryBase64 = '';
  try {
    const storyBuffer = await composeAd(baseBuffer, { ...overlayCfg, placement: 'story' });
    composedStoryBase64 = storyBuffer.toString('base64');
  } catch (err) {
    logger.error(`[HERMES] Story compose failed: ${err.message} — proposal queda sin versión story`);
  }

  // 9. Save HermesProposal
  const proposal = await HermesProposal.create({
    photo_asset_id: null,
    composed_image_base64: composedBase64,
    composed_image_story_base64: composedStoryBase64,
    overlay_config: {
      offer_text: variant.title,
      brand_text: 'JERSEY PICKLES',
      address_text: addressInfo.short,
      overlay_style: 'gpt-image-clean-plus-svg-overlay',
      generated_image_prompt: imagePrompt,
      used_references: imageResult.used_references || 0,
      variant_id: variant.id,
      visual_concept_id: visualConcept.id,
      typography_id: typography.id,
      tagline_with_arrow: copy.tagline_with_arrow,
      accent_color: variant.accent_color
    },
    headline: copy.headline,
    primary_text: copy.primary_text,
    cta_button: 'GET_DIRECTIONS',
    offer_type: offer.type,
    offer_details: {
      title: variant.title,
      description: variant.hook,
      valid_until: null
    },
    status: 'pending',
    cycle_id: cycleId
  });

  logger.info(`[HERMES] Proposal ${proposal._id} creado — ${offer.type}/${variant.id} · ${visualConcept.label} · Typo:${typography.id} · copy=${copy.elapsed_s}s · img=${imageResult.elapsed_s}s`);
  return proposal;
}

/**
 * Run main del agente.
 */
async function runHermesAgent() {
  const startTime = Date.now();
  const cycleId = `hermes_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Hermes Agent [${cycleId}] ═══`);

  await runHermesHousekeeping();

  const check = await preChecks();
  if (!check.allowed) {
    logger.info(`[HERMES] Ciclo skipped: ${check.reason}`);
    return { skipped: true, reason: check.reason, cycle_id: cycleId };
  }

  const proposal = await generateProposal(cycleId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!proposal) {
    logger.warn(`[HERMES] Ciclo ${cycleId} sin proposal generado (${elapsed}s)`);
    return { generated: 0, cycle_id: cycleId, elapsed: `${elapsed}s` };
  }

  logger.info(`═══ Hermes Agent [${cycleId}] completado en ${elapsed}s — 1 proposal pending approval ═══`);
  return {
    generated: 1,
    proposal_id: proposal._id,
    offer_type: proposal.offer_type,
    cycle_id: cycleId,
    elapsed: `${elapsed}s`
  };
}

/**
 * Approval flow — Fase 2 (13-may-2026): auto-publica a Meta al aprobar.
 *
 * Flow:
 *   1. status='pending' → 'approved' (transición visible)
 *   2. Si HERMES_AUTO_PUBLISH=true (default true desde Fase 2): publica a Meta
 *      - Upload image → create creative → create ad
 *      - status='approved' → 'live' (success) o queda 'approved' con error en
 *        rejection_reason si falló (audit + reintento manual posible)
 *
 * Para mantener Fase 1 manual: setear HERMES_AUTO_PUBLISH=false en env.
 */
async function approveProposal(proposalId, approvedBy = 'user') {
  const proposal = await HermesProposal.findById(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== 'pending') throw new Error(`Proposal status is ${proposal.status}, not pending`);

  proposal.status = 'approved';
  proposal.decided_at = new Date();
  proposal.decided_by = approvedBy;
  await proposal.save();

  logger.info(`[HERMES] Proposal ${proposalId} aprobado por ${approvedBy}`);

  // Auto-publish a Meta (default true). Para skip explícito: HERMES_AUTO_PUBLISH=false
  const autoPublish = process.env.HERMES_AUTO_PUBLISH !== 'false';
  if (!autoPublish) {
    logger.info(`[HERMES] HERMES_AUTO_PUBLISH=false — proposal queda en 'approved' (subir manual)`);
    return proposal;
  }

  try {
    const { publishProposalToMeta } = require('../hermes/meta-publisher');
    const result = await publishProposalToMeta(proposalId);
    logger.info(`[HERMES] Proposal ${proposalId} publicado a Meta — ad_id=${result.meta_ad_id} status=${result.ad_status}`);

    // Re-leer del DB porque publish actualiza el doc
    return await HermesProposal.findById(proposalId);
  } catch (err) {
    logger.error(`[HERMES] Publish to Meta failed for ${proposalId}: ${err.message}`);
    // Guardar el error en el proposal para visibilidad en dashboard
    proposal.rejection_reason = `publish_failed: ${err.message}`;
    await proposal.save();
    // No tirar el error — el approve sí fue exitoso, solo el publish falló.
    // El user puede reintentar publish manualmente o investigar.
    return proposal;
  }
}

/**
 * Reject flow.
 */
async function rejectProposal(proposalId, reason = '', rejectedBy = 'user') {
  const proposal = await HermesProposal.findById(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== 'pending') throw new Error(`Proposal status is ${proposal.status}, not pending`);

  proposal.status = 'rejected';
  proposal.decided_at = new Date();
  proposal.decided_by = rejectedBy;
  proposal.rejection_reason = reason;
  await proposal.save();

  logger.info(`[HERMES] Proposal ${proposalId} rechazado por ${rejectedBy}: ${reason}`);
  return proposal;
}

module.exports = {
  runHermesAgent,
  runHermesHousekeeping,
  generateProposal,
  approveProposal,
  rejectProposal
};
