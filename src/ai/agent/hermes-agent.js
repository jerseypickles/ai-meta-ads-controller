/**
 * Hermes Agent — agente autónomo de foot traffic para la tienda física NJ.
 *
 * Construido el 12-may-2026. Decisiones de diseño en docs/sesión:
 *   - Foot traffic (no online sales) — CTA Get Directions a Google Maps
 *   - 3 ofertas rotando: free pickle (50%), big dill chamoy (30%), mystery (20%)
 *   - Banco de fotos pro reales (no AI generation como Apollo) + text overlay automático
 *   - Voz brand Jersey Pickles: NJ attitude, punny, irreverent
 *   - Tracking: estimated_visits de Meta + reportes manuales en tienda
 *
 * Modos de operación (config.hermes.mode):
 *   - manual_approval (default): genera HermesProposal status=pending,
 *                                usuario aprueba en dashboard, después se sube manual a Meta
 *   - auto:                      genera + auto-publica en Meta (Fase 2, requiere page_id)
 *
 * Cron: 2x/día (9am, 3pm ET).
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const HermesPhotoAsset = require('../../db/models/HermesPhotoAsset');
const HermesProposal = require('../../db/models/HermesProposal');
const photoBank = require('../hermes/photo-bank');
const offerRotator = require('../hermes/offer-rotator');
const { generateCopy } = require('../hermes/copy-generator');
const { composeAd } = require('../hermes/overlay-composer');

/**
 * Housekeeping — expira proposals stale (pending > N horas sin aprobación).
 * Corre como Fase 0 de cada ciclo + standalone via cron.
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
 * Pre-checks antes de generar un ad nuevo.
 * Retorna { allowed: bool, reason: string }.
 */
async function preChecks() {
  if (!config.hermes.enabled) {
    return { allowed: false, reason: 'HERMES_ENABLED=false' };
  }

  // Cap de proposals pendientes — no acumular pool si nadie aprueba
  const pendingCount = await HermesProposal.countDocuments({ status: 'pending' });
  if (pendingCount >= config.hermes.maxActiveAds) {
    return { allowed: false, reason: `${pendingCount} proposals pending (max ${config.hermes.maxActiveAds})` };
  }

  // ¿Hay fotos en el banco?
  const photoCount = await HermesPhotoAsset.countDocuments({ active: true, archived: false });
  if (photoCount === 0) {
    return { allowed: false, reason: 'photo bank empty — sube fotos al banco antes de ejecutar' };
  }

  // Directive guard (Zeus puede bloquear el agente)
  try {
    const { isAgentBlocked } = require('../zeus/directive-guard');
    const block = await isAgentBlocked('hermes');
    if (block.blocked) {
      return { allowed: false, reason: `directive: ${block.reason}` };
    }
  } catch (_) { /* fail-open si directive-guard module falla */ }

  return { allowed: true };
}

/**
 * Genera un ad: pickea oferta + foto, compone overlay, llama Claude para copy.
 * No publica todavía — guarda como HermesProposal status='pending'.
 */
async function generateProposal(cycleId) {
  // 1. Oferta del ciclo (weighted random)
  const offer = offerRotator.pickOffer();
  logger.info(`[HERMES] Ciclo ${cycleId} — offer: ${offer.type} (${offer.title})`);

  // 2. Foto del banco compatible con la oferta
  const photo = await photoBank.pickPhotoForOffer(offer.type);
  if (!photo) {
    logger.warn(`[HERMES] Sin fotos para offer=${offer.type} — skip`);
    return null;
  }

  // 3. Decodificar la foto base
  if (!photo.image_base64) {
    logger.error(`[HERMES] Photo ${photo._id} sin image_base64 — skip`);
    return null;
  }
  const baseBuffer = Buffer.from(photo.image_base64, 'base64');

  // 4. Compose overlay
  const overlayConfig = {
    offer_text: offer.title,
    brand_text: 'JERSEY PICKLES NJ',
    address_text: `${config.hermes.addressShort} · Open daily`
  };

  let composedBuffer;
  try {
    composedBuffer = await composeAd(baseBuffer, overlayConfig);
  } catch (err) {
    logger.error(`[HERMES] composeAd failed: ${err.message}`);
    return null;
  }

  // 5. Generar copy con Claude
  let copy;
  try {
    copy = await generateCopy(offer);
  } catch (err) {
    logger.error(`[HERMES] copy generation failed: ${err.message}`);
    return null;
  }

  // 6. Save HermesProposal
  const proposal = await HermesProposal.create({
    photo_asset_id: photo._id,
    composed_image_base64: composedBuffer.toString('base64'),
    overlay_config: overlayConfig,
    headline: copy.headline,
    primary_text: copy.primary_text,
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

  // 7. Marcar foto como usada
  await photoBank.markPhotoUsed(photo._id);

  logger.info(`[HERMES] Proposal ${proposal._id} creado — offer=${offer.type}, photo=${photo.filename}, status=pending`);
  return proposal;
}

/**
 * Run main del agente — orquesta housekeeping + pre-checks + generación.
 */
async function runHermesAgent() {
  const startTime = Date.now();
  const cycleId = `hermes_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Hermes Agent [${cycleId}] ═══`);

  // Fase 0 — housekeeping (corre SIEMPRE, igual que Apollo)
  await runHermesHousekeeping();

  // Fase 1 — pre-checks
  const check = await preChecks();
  if (!check.allowed) {
    logger.info(`[HERMES] Ciclo skipped: ${check.reason}`);
    return { skipped: true, reason: check.reason, cycle_id: cycleId };
  }

  // Fase 2 — generar proposal
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
 * Approval flow — usuario aprueba via dashboard.
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

  // En modo manual_approval, el usuario sube manualmente a Meta después
  // En modo auto (Fase 2), acá disparamos la subida automática
  if (config.hermes.mode === 'auto') {
    // TODO Fase 2: uploadProposalToMeta(proposal)
    logger.info(`[HERMES] Mode=auto detected — auto-upload no implementado todavía (Fase 2)`);
  }

  return proposal;
}

/**
 * Reject flow — usuario rechaza desde dashboard con razón.
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
