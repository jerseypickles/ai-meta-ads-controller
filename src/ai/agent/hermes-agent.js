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
const { pickSceneForOffer } = require('../hermes/scenes');
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
 * Genera un ad completo: offer + scene + brief + imagen.
 */
async function generateProposal(cycleId) {
  // 1. Offer del ciclo (weighted random)
  const offer = offerRotator.pickOffer();
  logger.info(`[HERMES] Ciclo ${cycleId} — offer: ${offer.type} (${offer.title})`);

  // 2. Scene NJ compatible con la oferta
  const scene = pickSceneForOffer(offer.type);
  logger.info(`[HERMES] Scene: ${scene.id} (mood: ${scene.mood})`);

  // 3. Address info para el overlay
  const addressInfo = {
    full: config.hermes.warehouseAddress,
    short: config.hermes.addressShort
  };

  // 4. Claude genera image_prompt + headline + primary_text
  let brief;
  try {
    brief = await generateCreativeBrief(offer, scene, addressInfo);
  } catch (err) {
    logger.error(`[HERMES] Brief generation failed: ${err.message}`);
    return null;
  }

  // 5. gpt-image-2 genera la imagen con el image_prompt.
  // Quality 'medium' (~30-60s) en lugar de 'high' (~180s) por:
  //   - Evita timeout del axios cliente (180s)
  //   - Reduce ventana donde un deploy pueda matar el ciclo mid-flight
  //   - Para foot traffic ads la diferencia visual no justifica la espera
  let imageResult;
  try {
    imageResult = await generateImage(brief.image_prompt, {
      size: '1024x1536',     // portrait para feed Meta
      quality: 'medium'
    });
  } catch (err) {
    logger.error(`[HERMES] Image generation failed: ${err.message}`);
    return null;
  }

  // 6. Save HermesProposal
  const proposal = await HermesProposal.create({
    photo_asset_id: null,  // Ya no usamos photo bank
    composed_image_base64: imageResult.base64,
    overlay_config: {
      offer_text: offer.title,
      brand_text: 'JERSEY PICKLES',
      address_text: addressInfo.short,
      overlay_style: 'gpt-image-2-integrated',  // text overlay generado dentro de la imagen
      generated_image_prompt: brief.image_prompt  // audit del prompt usado
    },
    headline: brief.headline,
    primary_text: brief.primary_text,
    cta_button: 'GET_DIRECTIONS',
    offer_type: offer.type,
    offer_details: {
      title: offer.title,
      description: offer.description,
      valid_until: offer.valid_until
    },
    status: 'pending',
    cycle_id: cycleId
  });

  logger.info(`[HERMES] Proposal ${proposal._id} creado — offer=${offer.type}, scene=${scene.id}, image=${imageResult.size}, brief=${brief.elapsed_s}s, img=${imageResult.elapsed_s}s`);
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
 * Approval flow.
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

  if (config.hermes.mode === 'auto') {
    logger.info(`[HERMES] Mode=auto — auto-upload no implementado todavía (Fase 2)`);
  }

  return proposal;
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
