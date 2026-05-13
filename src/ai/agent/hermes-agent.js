/**
 * Hermes Agent — agente autónomo de foot traffic para la tienda física NJ.
 *
 * Redesign 12-may-2026: pasó de hybrid (photo bank + overlay sharp) a
 * 100% generativo con gpt-image-2 (OpenAI, lanzado 21-abr-2026). El text
 * overlay lo genera el mismo modelo dentro de la imagen — gpt-image-2 fue
 * el primer modelo en hacer text accurately, lo que elimina la dependencia
 * del overlay-composer.
 *
 * Flujo del ciclo:
 *   1. Pre-checks (enabled, capacity, directive)
 *   2. Pick offer (free_pickle / big_dill_chamoy / mystery_pickle)
 *   3. Pick NJ scene del scene-bank (deli, diner, BBQ NJ, etc.)
 *   4. Claude genera image_prompt + headline + primary_text en 1 call
 *   5. gpt-image-2 genera la imagen completa con text overlay integrado
 *   6. Save HermesProposal status=pending
 *
 * Modos (config.hermes.mode):
 *   - manual_approval (default) — usuario aprueba en dashboard
 *   - auto — Hermes publica solo (Fase 2)
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const HermesProposal = require('../../db/models/HermesProposal');
const offerRotator = require('../hermes/offer-rotator');
const { generateCreativeBrief } = require('../hermes/copy-generator');
const { generateImage } = require('../hermes/gpt-image');

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
 * Genera un ad completo: offer + variant + POV + background + typography
 * + brief + imagen. Cada eje rota con anti-repeat sobre la última usada.
 */
async function generateProposal(cycleId) {
  // 1. Offer + variant (anti-repeat 2-niveles)
  const { offer, variant } = await offerRotator.pickOfferAvoidingRepeat();
  logger.info(`[HERMES] Ciclo ${cycleId} — offer: ${offer.type}/${variant.id} ("${variant.title}")`);

  // 2. POV + background + typography rotativos
  const pov = await offerRotator.pickPOV();
  const background = await offerRotator.pickBackground();
  const typography = await offerRotator.pickTypography();
  logger.info(`[HERMES] Rotations — POV:${pov.id} · BG:"${background.slice(0, 40)}..." · Typo:${typography.id}`);

  // 3. Address info
  const addressInfo = {
    full: config.hermes.warehouseAddress,
    short: config.hermes.addressShort
  };

  // 4. Claude genera el creative brief (image_prompt 12-bloques + copy + tagline)
  let brief;
  try {
    brief = await generateCreativeBrief({ offer, variant, pov, background, typography, addressInfo });
  } catch (err) {
    logger.error(`[HERMES] Brief generation failed: ${err.message}`);
    return null;
  }

  // 5. gpt-image-2 genera la imagen (medium quality ~30-60s)
  let imageResult;
  try {
    imageResult = await generateImage(brief.image_prompt, {
      size: '1024x1536',
      quality: 'medium'
    });
  } catch (err) {
    logger.error(`[HERMES] Image generation failed: ${err.message}`);
    return null;
  }

  // 6. Save HermesProposal con todos los rotations metadata para anti-repeat futuros
  const proposal = await HermesProposal.create({
    photo_asset_id: null,
    composed_image_base64: imageResult.base64,
    overlay_config: {
      offer_text: variant.title,
      brand_text: 'JERSEY PICKLES',
      address_text: addressInfo.short,
      overlay_style: 'gpt-image-2-12-block-editorial',
      generated_image_prompt: brief.image_prompt,
      // Metadata de rotations para anti-repeat de próximos ciclos
      variant_id: variant.id,
      pov_id: pov.id,
      background_color: background,
      typography_id: typography.id,
      tagline_with_arrow: brief.tagline_with_arrow
    },
    headline: brief.headline,
    primary_text: brief.primary_text,
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

  logger.info(`[HERMES] Proposal ${proposal._id} creado — ${offer.type}/${variant.id} · POV:${pov.id} · Typo:${typography.id} · brief=${brief.elapsed_s}s · img=${imageResult.elapsed_s}s`);
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
