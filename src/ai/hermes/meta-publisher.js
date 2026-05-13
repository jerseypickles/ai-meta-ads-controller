/**
 * Hermes Meta Publisher — Fase 2 (13-may-2026).
 *
 * Toma un HermesProposal aprobado y lo publica a Meta como ad real:
 *   1. Decode composed_image_base64 → temp file
 *   2. meta.uploadImage(tempFile) → image_hash
 *   3. meta.createAdCreative({...}) con CTA GET_DIRECTIONS a Google Maps
 *   4. meta.createAd(adset_id, creative_id, name, status='ACTIVE')
 *   5. Update proposal: status='live', meta_ad_id, meta_creative_id, etc.
 *
 * Setup inicial (lazy): si no existen HERMES_CAMPAIGN_ID y HERMES_ADSET_ID
 * en env vars NI en SystemConfig, los crea (PAUSED) la primera vez y
 * persiste en SystemConfig. El user debe ACTIVAR la campaign manualmente
 * en Meta Ads Manager antes de que los ads sirvan.
 *
 * Reusa helpers existentes de meta/client.js:
 *   - getPageId() — auto-detect del page_id si no está en env
 *   - uploadImage(filePath) — POST /act_X/adimages
 *   - createAdCreative({...}) — POST /act_X/adcreatives
 *   - createAd(adset_id, creative_id, name, status) — POST /act_X/ads
 *   - createCampaign({...}) — para setup inicial
 *   - createAdSet({...}) — para setup inicial
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../../config');
const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const HermesProposal = require('../../db/models/HermesProposal');

const HERMES_CAMPAIGN_KEY = 'hermes_meta_campaign';
const HERMES_ADSET_KEY = 'hermes_meta_adset';

/**
 * Lazy resolver — devuelve { campaign_id, adset_id } o los crea.
 * Orden de prioridad:
 *   1. Env vars HERMES_CAMPAIGN_ID + HERMES_ADSET_ID (lo que el user configuró)
 *   2. SystemConfig (lo que Hermes creó automáticamente antes)
 *   3. Crear nuevos (primera vez)
 */
async function getOrCreateCampaignAndAdset(meta) {
  // Prioridad 1: env vars completos
  const envCampaign = process.env.HERMES_CAMPAIGN_ID;
  const envAdset = process.env.HERMES_ADSET_ID;
  if (envCampaign && envAdset) {
    return { campaign_id: envCampaign, adset_id: envAdset, source: 'env' };
  }

  // Prioridad 2: SystemConfig completo (campaign + adset)
  const stored = await SystemConfig.get(HERMES_CAMPAIGN_KEY);
  const storedAdset = await SystemConfig.get(HERMES_ADSET_KEY);
  if (stored?.campaign_id && storedAdset?.adset_id) {
    return { campaign_id: stored.campaign_id, adset_id: storedAdset.adset_id, source: 'systemconfig' };
  }

  // Prioridad 3: persistencia incremental — reusar lo que ya exista
  // (caso típico: la campaign se creó antes pero el adset falló)
  let campaignId = envCampaign || stored?.campaign_id;
  let campaignName = stored?.name || '[HERMES] NJ Foot Traffic';
  let justCreatedCampaign = false;

  if (!campaignId) {
    logger.info('[HERMES-PUBLISHER] No campaign — creando nueva en Meta (PAUSED)');
    const campaign = await meta.createCampaign({
      name: '[HERMES] NJ Foot Traffic',
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: config.hermes.initialDailyBudget || 45
    });
    campaignId = campaign.campaign_id;
    campaignName = campaign.name;
    justCreatedCampaign = true;

    // PERSISTIR INMEDIATAMENTE — si el adset falla, no se crea campaign duplicada en retry
    await SystemConfig.set(HERMES_CAMPAIGN_KEY, {
      campaign_id: campaignId,
      name: campaignName,
      created_at: new Date()
    });
    logger.info(`[HERMES-PUBLISHER] Campaign creada y persistida: ${campaignId} (PAUSED)`);
  } else {
    logger.info(`[HERMES-PUBLISHER] Reusando campaign existente: ${campaignId}`);
  }

  // Compatibility con código viejo: la variable `campaign` ya no existe, usar campaignId
  const campaign = { campaign_id: campaignId, name: campaignName };

  // Targeting NJ — radio configurable desde warehouse
  const NJ_LAT = 40.8742;
  const NJ_LON = -74.0473;
  const radius = config.hermes.targetingRadiusMi || 10;

  // Crear ad set manualmente (no via createAdSet helper) porque ese helper
  // hace asunciones para OUTCOME_SALES (attribution_spec VIEW_THROUGH, etc)
  // que NO aplican a OUTCOME_TRAFFIC. Params explícitos para foot traffic.
  const adsetParams = {
    campaign_id: campaign.campaign_id,
    name: '[HERMES] Local NJ Foot Traffic',
    daily_budget: Math.round((config.hermes.initialDailyBudget || 45) * 100),
    optimization_goal: 'LINK_CLICKS',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    destination_type: 'WEBSITE',           // REQUERIDO para OUTCOME_TRAFFIC
    status: 'PAUSED',
    targeting: JSON.stringify({
      geo_locations: {
        custom_locations: [{
          latitude: NJ_LAT,
          longitude: NJ_LON,
          radius,
          distance_unit: 'mile'
        }]
      },
      age_min: 21,
      age_max: 65
    })
  };

  logger.info(`[HERMES-PUBLISHER] Creando adset directo (OUTCOME_TRAFFIC + LINK_CLICKS + WEBSITE)`);
  let adsetResult;
  try {
    adsetResult = await meta.post(`/${meta.adAccountId}/adsets`, adsetParams);
  } catch (err) {
    const metaError = err.response?.data?.error;
    const detail = metaError ? `${metaError.message} (code=${metaError.code}, type=${metaError.type})` : err.message;
    logger.error(`[HERMES-PUBLISHER] AdSet creation failed: ${detail}`);
    throw new Error(`Meta API error al crear adset: ${detail}`);
  }

  const adsetId = adsetResult.id;
  logger.info(`[HERMES-PUBLISHER] AdSet creado: ${adsetId} (PAUSED, radius ${radius}mi)`);

  // Persistir adset (la campaign ya se persistió arriba si fue creada nueva)
  await SystemConfig.set(HERMES_ADSET_KEY, {
    adset_id: adsetId,
    campaign_id: campaignId,
    name: adsetParams.name,
    created_at: new Date()
  });

  return { campaign_id: campaignId, adset_id: adsetId, source: 'newly_created', _just_created: justCreatedCampaign };
}

/**
 * Publica una HermesProposal aprobada a Meta.
 *
 * @param {String|ObjectId} proposalId
 * @returns {Promise<{success, meta_ad_id, meta_creative_id, meta_campaign_id, meta_adset_id, just_created_campaign}>}
 */
async function publishProposalToMeta(proposalId) {
  const proposal = await HermesProposal.findById(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== 'approved') {
    throw new Error(`Proposal ${proposalId} status is "${proposal.status}", expected "approved"`);
  }
  if (!proposal.composed_image_base64) {
    throw new Error(`Proposal ${proposalId} sin composed_image_base64`);
  }

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 0. Page ID — env var o auto-detect
  const pageId = process.env.HERMES_FACEBOOK_PAGE_ID || config.hermes.facebookPageId || await meta.getPageId();
  if (!pageId) {
    throw new Error('No se pudo resolver Facebook Page ID. Setear HERMES_FACEBOOK_PAGE_ID en env vars.');
  }
  const instagramId = process.env.HERMES_INSTAGRAM_ID || config.hermes.instagramId || null;

  // 1. Resolver campaign + adset (lazy create si no existen)
  const { campaign_id, adset_id, source, _just_created } = await getOrCreateCampaignAndAdset(meta);
  logger.info(`[HERMES-PUBLISHER] Using campaign=${campaign_id} adset=${adset_id} (source: ${source})`);

  // 2. Decode base64 → temp file
  const tmpDir = path.join(os.tmpdir(), 'hermes-publish');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `hermes_${proposal._id}.png`);
  fs.writeFileSync(tmpPath, Buffer.from(proposal.composed_image_base64, 'base64'));

  let imageHash;
  try {
    // 3. Upload image a Meta
    const imgResult = await meta.uploadImage(tmpPath);
    imageHash = imgResult.image_hash;
    logger.info(`[HERMES-PUBLISHER] Image uploaded: hash=${imageHash}`);
  } finally {
    // Limpiar temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  // 4. Crear ad creative con CTA GET_DIRECTIONS al Google Maps
  const linkUrl = config.hermes.googleMapsUrl || `https://maps.google.com/?q=${encodeURIComponent(config.hermes.warehouseAddress)}`;

  const creativeParams = {
    page_id: pageId,
    image_hash: imageHash,
    headline: proposal.headline,
    body: proposal.primary_text,
    description: proposal.offer_details?.description || '',
    cta: proposal.cta_button || 'GET_DIRECTIONS',
    link_url: linkUrl
  };
  if (instagramId) creativeParams.instagram_user_id = instagramId;

  const creative = await meta.createAdCreative(creativeParams);
  logger.info(`[HERMES-PUBLISHER] Creative creado: ${creative.creative_id}`);

  // 5. Crear ad — PAUSED por seguridad si la campaign acaba de ser creada,
  // ACTIVE si la campaign ya estaba en uso (asumimos que el user la activó)
  const initialAdStatus = _just_created ? 'PAUSED' : 'ACTIVE';
  const adName = `[Hermes] ${proposal.offer_details?.title || proposal.offer_type} · ${new Date().toISOString().split('T')[0]}`;
  const ad = await meta.createAd(adset_id, creative.creative_id, adName, initialAdStatus);
  logger.info(`[HERMES-PUBLISHER] Ad creado: ${ad.ad_id} status=${initialAdStatus}`);

  // 6. Actualizar proposal
  proposal.status = 'live';
  proposal.meta_campaign_id = campaign_id;
  proposal.meta_adset_id = adset_id;
  proposal.meta_creative_id = creative.creative_id;
  proposal.meta_ad_id = ad.ad_id;
  proposal.meta_published_at = new Date();
  await proposal.save();

  return {
    success: true,
    meta_ad_id: ad.ad_id,
    meta_creative_id: creative.creative_id,
    meta_campaign_id: campaign_id,
    meta_adset_id: adset_id,
    just_created_campaign: !!_just_created,
    ad_status: initialAdStatus
  };
}

module.exports = { publishProposalToMeta, getOrCreateCampaignAndAdset };
