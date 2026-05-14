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
const HERMES_REGION_KEYS = 'hermes_tristate_region_keys';

/**
 * Resuelve los region keys de Meta para NJ, NY, PA via targeting search API.
 * Cachea en SystemConfig para no re-resolver cada ciclo.
 *
 * Decisión 13-may-2026: el warehouse está en NJ pero el reach natural cubre
 * Tri-state (NJ+NY+PA). Anterior radius 10mi era demasiado chico y no llegaba
 * a PA. Ahora targeting por states completos (NJ+NY+PA) para que cubra todo
 * el área donde un cliente potencial podría manejar a la store de NJ.
 */
async function resolveTriStateRegionKeys(meta) {
  const cached = await SystemConfig.get(HERMES_REGION_KEYS);
  if (cached?.regions && cached.regions.length === 3) {
    return cached.regions;
  }

  const stateNames = ['New Jersey', 'New York', 'Pennsylvania'];
  const regions = [];
  for (const name of stateNames) {
    try {
      const result = await meta.get('/search', {
        type: 'adgeolocation',
        q: name,
        country_code: 'US',
        location_types: JSON.stringify(['region'])
      });
      const match = (result.data || []).find(r => r.name === name);
      if (match?.key) {
        regions.push({ key: match.key, name: match.name });
        logger.info(`[HERMES-PUBLISHER] Region resuelto: ${name} → key=${match.key}`);
      } else {
        logger.warn(`[HERMES-PUBLISHER] No se encontró region key para "${name}" en Meta search`);
      }
    } catch (err) {
      logger.error(`[HERMES-PUBLISHER] Error resolviendo region "${name}": ${err.message}`);
    }
  }

  if (regions.length > 0) {
    await SystemConfig.set(HERMES_REGION_KEYS, { regions, resolved_at: new Date() });
  }
  return regions;
}

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

  // Targeting Tri-state — NJ + NY + PA regions completas (los 3 states donde
  // un cliente potencial podría manejar a la store NJ).
  const triStateRegions = await resolveTriStateRegionKeys(meta);
  if (triStateRegions.length === 0) {
    throw new Error('No se pudieron resolver region keys NJ/NY/PA en Meta — verificar permisos de targeting search');
  }

  // Params para OUTCOME_TRAFFIC + LINK_CLICKS + CBO.
  //
  // SIN daily_budget en el adset porque la campaign ya lo tiene (CBO mode).
  // SIN destination_type porque con LINK_CLICKS optimization Meta lo infiere.
  //
  // PLACEMENT FEED-ONLY (decisión 13-may-2026 post crop issue en Stories):
  // gpt-image-2 genera 1024×1536 (2:3 ratio). Instagram Stories es 9:16,
  // Meta hace zoom-fill que corta el contenido importante. Para evitarlo
  // SIN tener que generar 2 imágenes por ciclo (costo $ doblado), limitamos
  // el adset a Feed placements donde 2:3 funciona bien sin crop:
  //   - Facebook Feed (display vertical fits ~4:5)
  //   - Instagram Feed/Stream (display fits ~4:5)
  //
  // Stories + Reels quedan EXCLUIDOS hasta que implementemos
  // Placement Asset Customization (Fase 3) con imagen 9:16 dedicada.
  // promoted_object con page_id — recomendado por Meta para local awareness
  // ads (ayuda al algoritmo a entender el contexto de business local).
  const pageId = process.env.HERMES_FACEBOOK_PAGE_ID || config.hermes.facebookPageId || await meta.getPageId();

  const adsetParams = {
    campaign_id: campaignId,
    name: '[HERMES] Local NJ Foot Traffic',
    optimization_goal: 'LINK_CLICKS',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    status: 'PAUSED',
    promoted_object: JSON.stringify({ page_id: pageId }),
    targeting: JSON.stringify({
      geo_locations: {
        regions: triStateRegions.map(r => ({ key: r.key })),
        // location_types: 'home' = gente que vive en NJ/NY/PA (no solo turistas de paso).
        // Foot traffic real viene de residentes que pueden manejar a la store.
        location_types: ['home', 'recent']
      },
      age_min: 21,
      age_max: 65,
      // Mobile-first: foot traffic ads son para gente que puede manejar AHORA.
      // Desktop users rara vez convierten para visitas físicas.
      device_platforms: ['mobile'],
      // Feed-only placements
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream']
    })
  };

  logger.info(`[HERMES-PUBLISHER] Creando adset directo (OUTCOME_TRAFFIC + LINK_CLICKS)`);
  let adsetResult;
  try {
    adsetResult = await meta.post(`/${meta.adAccountId}/adsets`, adsetParams);
  } catch (err) {
    const metaError = err.response?.data?.error;
    // Extraer TODOS los campos del error de Meta para diagnóstico real
    const fullError = metaError ? {
      message: metaError.message,
      code: metaError.code,
      type: metaError.type,
      error_subcode: metaError.error_subcode,
      error_user_title: metaError.error_user_title,
      error_user_msg: metaError.error_user_msg,
      error_data: metaError.error_data,
      fbtrace_id: metaError.fbtrace_id
    } : { raw: err.message };
    logger.error(`[HERMES-PUBLISHER] AdSet creation failed — full error: ${JSON.stringify(fullError)}`);
    logger.error(`[HERMES-PUBLISHER] Params enviados: ${JSON.stringify({ ...adsetParams, targeting: '<...>' })}`);

    const detail = metaError?.error_user_msg ||
                  (metaError?.message + (metaError?.error_subcode ? ` (subcode ${metaError.error_subcode})` : '')) ||
                  err.message;
    throw new Error(`Meta API error al crear adset: ${detail}`);
  }

  const adsetId = adsetResult.id;
  const regionNames = triStateRegions.map(r => r.name).join(' + ');
  logger.info(`[HERMES-PUBLISHER] AdSet creado: ${adsetId} (PAUSED, regions: ${regionNames})`);

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

  // 4. Crear ad creative MANUAL (sin helper genérico) para control total.
  const linkUrl = config.hermes.googleMapsUrl || `https://maps.google.com/?q=${encodeURIComponent(config.hermes.warehouseAddress)}`;

  // CTA: GET_DIRECTIONS de Meta requiere formato fbgeo://lat,long,"addr"
  // Y que la Page tenga Business Location verificada en Meta Business Suite.
  // Sin esa setup, GET_DIRECTIONS con URL normal devuelve 400.
  //
  // Fallback automático a LEARN_MORE — acepta cualquier URL externa,
  // mismo destino (Google Maps con la dirección), botón dice "Learn More"
  // en lugar de "Get Directions". UX casi idéntica.
  //
  // Para usar GET_DIRECTIONS nativo Meta, setear HERMES_NATIVE_GET_DIRECTIONS=true
  // en env vars Y tener Business Location verificada en Meta.
  let ctaType = proposal.cta_button || 'LEARN_MORE';
  if (ctaType === 'GET_DIRECTIONS' && process.env.HERMES_NATIVE_GET_DIRECTIONS !== 'true') {
    logger.info(`[HERMES-PUBLISHER] CTA GET_DIRECTIONS → fallback a LEARN_MORE (sin Business Location verificada)`);
    ctaType = 'LEARN_MORE';
  }

  const linkData = {
    message: proposal.primary_text || '',
    link: linkUrl,
    name: proposal.headline || '',
    image_hash: imageHash,
    call_to_action: {
      type: ctaType,
      value: { link: linkUrl }
    }
  };

  const objectStorySpec = { page_id: pageId, link_data: linkData };
  if (instagramId) objectStorySpec.instagram_user_id = instagramId;

  const creativeParams = {
    name: `[Hermes] Creative · ${proposal.offer_details?.title || proposal.offer_type} · ${new Date().toISOString().split('T')[0]}`,
    object_story_spec: JSON.stringify(objectStorySpec)
  };

  logger.info(`[HERMES-PUBLISHER] Creando creative directo (page=${pageId}, ig=${instagramId || 'none'}, cta=${proposal.cta_button || 'GET_DIRECTIONS'})`);
  let creativeResult;
  try {
    creativeResult = await meta.post(`/${meta.adAccountId}/adcreatives`, creativeParams);
  } catch (err) {
    const metaError = err.response?.data?.error;
    const fullError = metaError ? {
      message: metaError.message,
      code: metaError.code,
      type: metaError.type,
      error_subcode: metaError.error_subcode,
      error_user_title: metaError.error_user_title,
      error_user_msg: metaError.error_user_msg,
      error_data: metaError.error_data,
      fbtrace_id: metaError.fbtrace_id
    } : { raw: err.message };
    logger.error(`[HERMES-PUBLISHER] Creative creation failed — full error: ${JSON.stringify(fullError)}`);
    const detail = metaError?.error_user_msg ||
                  (metaError?.message + (metaError?.error_subcode ? ` (subcode ${metaError.error_subcode})` : '')) ||
                  err.message;
    throw new Error(`Meta API error al crear creative: ${detail}`);
  }

  const creative = { creative_id: creativeResult.id };
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

/**
 * Pull metrics actuales del ad de Meta y los persiste en HermesProposal.performance.
 * Usado para sync manual (endpoint /sync-metrics) y eventualmente en cron T+3d/T+7d.
 *
 * @param {String|ObjectId} proposalId
 * @returns {Promise<{performance, raw_meta_data}>}
 */
async function syncProposalMetricsFromMeta(proposalId) {
  const proposal = await HermesProposal.findById(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (!proposal.meta_ad_id) {
    throw new Error(`Proposal ${proposalId} no tiene meta_ad_id (status: ${proposal.status})`);
  }

  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // Pull insights desde Meta — lifetime metrics del ad
  const insightsResult = await meta.get(`/${proposal.meta_ad_id}/insights`, {
    fields: 'spend,reach,impressions,clicks,inline_link_clicks,ctr,inline_link_click_ctr,cpm,cpc,frequency,date_start,date_stop',
    date_preset: 'maximum'  // lifetime
  });

  const rows = insightsResult.data || [];
  if (rows.length === 0) {
    logger.warn(`[HERMES-METRICS] Ad ${proposal.meta_ad_id} sin data de insights aún (puede tardar 1-24h)`);
    return {
      performance: proposal.performance || {},
      raw_meta_data: null,
      note: 'Meta no tiene insights aún para este ad (típicamente toma 1-24h de servir)'
    };
  }

  const row = rows[0];
  const spend = parseFloat(row.spend || 0);
  const reach = parseInt(row.reach || 0);
  const impressions = parseInt(row.impressions || 0);
  const link_clicks = parseInt(row.inline_link_clicks || 0);
  const ctr = parseFloat(row.inline_link_click_ctr || row.ctr || 0);
  const cpm = parseFloat(row.cpm || 0);
  const cpc = parseFloat(row.cpc || 0);
  const frequency = parseFloat(row.frequency || 0);

  // Update HermesProposal.performance
  proposal.performance = {
    ...(proposal.performance || {}),
    spend,
    reach,
    impressions,
    link_clicks,
    ctr,
    cpm,
    cost_per_click: cpc,
    frequency,
    measured_at: new Date(),
    estimated_store_visits: proposal.performance?.estimated_store_visits || 0,
    manual_visits_reported: proposal.performance?.manual_visits_reported || 0
  };
  await proposal.save();

  logger.info(`[HERMES-METRICS] Synced ${proposal.meta_ad_id} — spend $${spend}, reach ${reach}, link_clicks ${link_clicks}, ctr ${(ctr).toFixed(2)}%`);

  return {
    performance: proposal.performance,
    raw_meta_data: row,
    period: { date_start: row.date_start, date_stop: row.date_stop }
  };
}

/**
 * Actualiza el targeting del adset existente de Hermes a Tri-state regions
 * (NJ+NY+PA) + Feed-only placements. Útil para migrar adsets viejos sin
 * tener que recrearlos.
 */
async function updateExistingAdsetTargeting() {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  const stored = await SystemConfig.get(HERMES_ADSET_KEY);
  const adsetId = process.env.HERMES_ADSET_ID || stored?.adset_id;
  if (!adsetId) {
    throw new Error('No hay HERMES_ADSET_ID configurado ni en SystemConfig');
  }

  const triStateRegions = await resolveTriStateRegionKeys(meta);
  if (triStateRegions.length === 0) {
    throw new Error('No se pudieron resolver region keys NJ/NY/PA');
  }

  const pageId = process.env.HERMES_FACEBOOK_PAGE_ID || config.hermes.facebookPageId || await meta.getPageId();

  const targeting = {
    geo_locations: {
      regions: triStateRegions.map(r => ({ key: r.key })),
      location_types: ['home', 'recent']     // residentes (+ recent visitors)
    },
    age_min: 21,
    age_max: 65,
    device_platforms: ['mobile'],            // foot traffic = mobile-first
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed'],
    instagram_positions: ['stream']
  };

  logger.info(`[HERMES-PUBLISHER] Actualizando adset ${adsetId} → Tri-state + Feed-only + mobile + home+recent + promoted_object`);
  try {
    await meta.post(`/${adsetId}`, {
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify({ page_id: pageId })   // local awareness boost
    });
    return {
      success: true,
      adset_id: adsetId,
      new_regions: triStateRegions.map(r => r.name),
      new_placements: ['Facebook Feed', 'Instagram Feed'],
      promoted_page_id: pageId,
      device_platforms: ['mobile'],
      location_types: ['home', 'recent']
    };
  } catch (err) {
    const metaError = err.response?.data?.error;
    const detail = metaError?.error_user_msg || metaError?.message || err.message;
    logger.error(`[HERMES-PUBLISHER] Update adset targeting failed: ${detail}`);
    throw new Error(`Meta API error actualizando adset: ${detail}`);
  }
}

module.exports = {
  publishProposalToMeta,
  getOrCreateCampaignAndAdset,
  resolveTriStateRegionKeys,
  updateExistingAdsetTargeting,
  syncProposalMetricsFromMeta
};
