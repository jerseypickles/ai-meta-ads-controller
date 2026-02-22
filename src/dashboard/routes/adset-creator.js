const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const { strategize } = require('../../ai/adset-creator/strategist');
const { runManager, getManagerStatus, getManagerStatusLive } = require('../../ai/adset-creator/manager');
const { getMetaClient } = require('../../meta/client');
const CreativeAsset = require('../../db/models/CreativeAsset');
const AICreation = require('../../db/models/AICreation');
const StrategicDirective = require('../../db/models/StrategicDirective');
const Decision = require('../../db/models/Decision');
const ActionLog = require('../../db/models/ActionLog');

// In-memory store for background approval jobs
const approvalJobs = new Map();
const APPROVAL_JOB_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * POST /api/adset-creator/strategize
 * Claude analiza banco creativo + performance y propone 2-3 ad sets.
 */
router.post('/strategize', async (req, res) => {
  try {
    logger.info('[ADSET-CREATOR] Iniciando análisis estratégico con Claude...');
    const result = await strategize();
    logger.info(`[ADSET-CREATOR] ${result.proposals.length} propuestas generadas en ${result.analysis_time_s}s`);
    res.json({ success: true, result });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error en strategize: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Ejecuta la creación completa de un ad set en background.
 * Retorna el resultado final o un error.
 */
async function executeAdSetApproval(proposal) {
  const meta = getMetaClient();
  const steps = [];
  const errors = [];

  // Step 1: Get pixel, page_id, and website URL in parallel
  steps.push({ step: 'account_info', status: 'running' });
  const [pixelInfo, pageId, websiteUrl] = await Promise.all([
    meta.getPixelId(),
    meta.getPageId(),
    meta.getWebsiteUrl()
  ]);
  if (!pixelInfo) throw new Error('No se encontró pixel_id en la cuenta. Se necesita al menos un ad set existente.');
  if (!pageId) throw new Error('No se encontró page_id de Facebook.');
  if (!websiteUrl) throw new Error('No se encontró link_url en ningún ad existente. Se necesita al menos un ad con URL de destino.');
  steps[steps.length - 1].status = 'done';

  // Step 2: Upload images to Meta (parallel uploads — feed + stories pairs)
  steps.push({ step: 'upload_images', status: 'running', total: proposal.selected_creatives.length });
  const uploadResults = await Promise.allSettled(
    proposal.selected_creatives.map(async (sel) => {
      const asset = await CreativeAsset.findById(sel.asset_id);
      if (!asset) throw new Error(`Asset ${sel.asset_id} no encontrado`);

      // Upload feed (1:1) image
      if (!asset.uploaded_to_meta) {
        const upload = await meta.uploadImage(asset.file_path);
        asset.meta_image_hash = upload.image_hash;
        asset.uploaded_to_meta = true;
        asset.uploaded_at = new Date();
        await asset.save();
      }

      // Check for stories (9:16) pair and upload it too
      let pairedAsset = null;
      if (asset.paired_asset_id) {
        pairedAsset = await CreativeAsset.findById(asset.paired_asset_id);
      }
      if (!pairedAsset && asset.product_name) {
        pairedAsset = await CreativeAsset.findOne({
          status: 'active',
          purpose: 'ad-ready',
          ad_format: 'stories',
          product_name: asset.product_name,
          _id: { $ne: asset._id }
        }).sort({ created_at: -1 });
      }
      if (pairedAsset && !pairedAsset.uploaded_to_meta) {
        const pairUpload = await meta.uploadImage(pairedAsset.file_path);
        pairedAsset.meta_image_hash = pairUpload.image_hash;
        pairedAsset.uploaded_to_meta = true;
        pairedAsset.uploaded_at = new Date();
        await pairedAsset.save();
      }

      return { asset, pairedAsset, creative_config: sel };
    })
  );
  const uploadedAssets = [];
  for (const result of uploadResults) {
    if (result.status === 'fulfilled') {
      uploadedAssets.push(result.value);
    } else {
      errors.push(result.reason.message);
    }
  }
  steps[steps.length - 1].status = 'done';
  const pairedCount = uploadedAssets.filter(u => u.pairedAsset).length;
  steps[steps.length - 1].uploaded = uploadedAssets.length;
  steps[steps.length - 1].paired = pairedCount;

  if (uploadedAssets.length < 2) {
    throw new Error(`Solo se pudieron subir ${uploadedAssets.length} imágenes. Se necesitan mínimo 2. ${errors.join('; ')}`);
  }

  // Step 3: Create ad set (PAUSED)
  steps.push({ step: 'create_adset', status: 'running' });
  let adSetResult;
  try {
    adSetResult = await meta.createAdSet({
      campaign_id: proposal.campaign_id,
      name: proposal.adset_name,
      daily_budget: proposal.daily_budget,
      optimization_goal: pixelInfo.optimization_goal,
      billing_event: pixelInfo.billing_event,
      bid_strategy: pixelInfo.bid_strategy,
      promoted_object: pixelInfo.promoted_object,
      status: 'PAUSED'
    });
  } catch (adsetErr) {
    const metaDetail = adsetErr.response?.data?.error?.message || adsetErr.message;
    throw new Error(`Error creando ad set en Meta: ${metaDetail}`);
  }
  steps[steps.length - 1].status = 'done';
  steps[steps.length - 1].adset_id = adSetResult.adset_id;

  // Step 4: Create ad creatives + ads (feed 1:1 + stories 9:16 per variant)
  const totalVariants = uploadedAssets.reduce((sum, { creative_config, pairedAsset }) => {
    const headlines = Array.isArray(creative_config.headlines) ? creative_config.headlines : [creative_config.headline || ''];
    const multiplier = pairedAsset ? 2 : 1;
    return sum + (headlines.length * multiplier);
  }, 0);
  steps.push({ step: 'create_ads', status: 'running', total: totalVariants });
  const createdAds = [];
  for (const { asset, pairedAsset, creative_config } of uploadedAssets) {
    const headlines = Array.isArray(creative_config.headlines) ? creative_config.headlines :
      [creative_config.headline || asset.headline];
    const bodies = Array.isArray(creative_config.bodies) ? creative_config.bodies :
      [creative_config.body || asset.body || ''];

    const variantCount = Math.max(headlines.length, 1);
    for (let v = 0; v < variantCount; v++) {
      const headline = headlines[v] || headlines[0] || asset.headline;
      const body = bodies[v] || bodies[0] || asset.body || '';
      const variantLabel = variantCount > 1 ? ` v${v + 1}` : '';

      // --- FEED ad (1:1) ---
      try {
        const creative = await meta.createAdCreative({
          page_id: pageId,
          image_hash: asset.meta_image_hash,
          headline,
          body,
          description: '',
          cta: creative_config.cta || asset.cta || 'SHOP_NOW',
          link_url: asset.link_url || websiteUrl
        });

        const adName = `${headline} - ${asset.style || 'mix'}${variantLabel} [Feed]`;
        const ad = await meta.createAd(
          adSetResult.adset_id,
          creative.creative_id,
          adName,
          'PAUSED'
        );

        createdAds.push({
          ad_id: ad.ad_id,
          creative_id: creative.creative_id,
          asset_id: asset._id.toString(),
          name: adName,
          variant: v + 1,
          placement: 'feed'
        });
      } catch (adErr) {
        errors.push(`Error creando feed ad para "${headline}${variantLabel}": ${adErr.message}`);
      }

      // --- STORIES ad (9:16) — only if paired asset exists ---
      if (pairedAsset && pairedAsset.meta_image_hash) {
        try {
          const storiesCreative = await meta.createAdCreative({
            page_id: pageId,
            image_hash: pairedAsset.meta_image_hash,
            headline,
            body,
            description: '',
            cta: creative_config.cta || asset.cta || 'SHOP_NOW',
            link_url: asset.link_url || pairedAsset.link_url || websiteUrl
          });

          const storiesAdName = `${headline} - ${asset.style || 'mix'}${variantLabel} [Stories]`;
          const storiesAd = await meta.createAd(
            adSetResult.adset_id,
            storiesCreative.creative_id,
            storiesAdName,
            'PAUSED'
          );

          createdAds.push({
            ad_id: storiesAd.ad_id,
            creative_id: storiesCreative.creative_id,
            asset_id: pairedAsset._id.toString(),
            name: storiesAdName,
            variant: v + 1,
            placement: 'stories'
          });
        } catch (adErr) {
          errors.push(`Error creando stories ad para "${headline}${variantLabel}": ${adErr.message}`);
        }
      }
    }

    // Update asset tracking — feed asset
    try {
      const adIdsForAsset = createdAds.filter(a => a.asset_id === asset._id.toString()).map(a => a.ad_id);
      asset.times_used = (asset.times_used || 0) + 1;
      for (const adId of adIdsForAsset) {
        if (!asset.used_in_ads.includes(adId)) asset.used_in_ads.push(adId);
      }
      if (!asset.used_in_adsets) asset.used_in_adsets = [];
      if (!asset.used_in_adsets.includes(adSetResult.adset_id)) {
        asset.used_in_adsets.push(adSetResult.adset_id);
      }
      await asset.save();
    } catch (saveErr) {
      errors.push(`Error actualizando tracking de feed asset: ${saveErr.message}`);
    }

    // Update asset tracking — stories paired asset
    if (pairedAsset) {
      try {
        const adIdsForPaired = createdAds.filter(a => a.asset_id === pairedAsset._id.toString()).map(a => a.ad_id);
        pairedAsset.times_used = (pairedAsset.times_used || 0) + 1;
        for (const adId of adIdsForPaired) {
          if (!pairedAsset.used_in_ads.includes(adId)) pairedAsset.used_in_ads.push(adId);
        }
        if (!pairedAsset.used_in_adsets) pairedAsset.used_in_adsets = [];
        if (!pairedAsset.used_in_adsets.includes(adSetResult.adset_id)) {
          pairedAsset.used_in_adsets.push(adSetResult.adset_id);
        }
        await pairedAsset.save();
      } catch (saveErr) {
        errors.push(`Error actualizando tracking de stories asset: ${saveErr.message}`);
      }
    }
  }
  steps[steps.length - 1].status = 'done';
  steps[steps.length - 1].created = createdAds.length;
  steps[steps.length - 1].feed_ads = createdAds.filter(a => a.placement === 'feed').length;
  steps[steps.length - 1].stories_ads = createdAds.filter(a => a.placement === 'stories').length;

  if (createdAds.length === 0) {
    throw new Error(`No se pudo crear ningún ad. ${errors.join('; ')}`);
  }

  // Step 5: Activate ad set + all ads (parallel activation)
  steps.push({ step: 'activate', status: 'running' });
  try {
    const activationResults = await Promise.allSettled(
      createdAds.map(ad => meta.updateAdStatus(ad.ad_id, 'ACTIVE'))
    );
    for (const result of activationResults) {
      if (result.status === 'rejected') {
        errors.push(`Error activando ad: ${result.reason.message}`);
      }
    }
    await meta.updateStatus(adSetResult.adset_id, 'ACTIVE');
  } catch (activateErr) {
    errors.push(`Error activando ad set: ${activateErr.message}`);
  }
  steps[steps.length - 1].status = 'done';

  // Step 6: Register AICreation for lifecycle tracking
  steps.push({ step: 'register', status: 'running' });
  let aiCreation;
  try {
    aiCreation = await AICreation.create({
      creation_type: 'create_adset',
      meta_entity_id: adSetResult.adset_id,
      meta_entity_type: 'adset',
      meta_entity_name: proposal.adset_name,
      parent_entity_id: proposal.campaign_id,
      parent_entity_name: proposal.campaign_name || '',
      agent_type: 'creative',
      reasoning: proposal.strategy_summary,
      confidence: proposal.risk_assessment === 'low' ? 'high' : proposal.risk_assessment === 'high' ? 'low' : 'medium',
      creative_rationale: proposal.budget_rationale,
      initial_budget: proposal.daily_budget,
      managed_by_ai: true,
      child_ad_ids: createdAds.map(a => a.ad_id),
      selected_creative_ids: [
        ...uploadedAssets.map(u => u.asset._id.toString()),
        ...uploadedAssets.filter(u => u.pairedAsset).map(u => u.pairedAsset._id.toString())
      ],
      strategy_summary: proposal.strategy_summary,
      current_status: 'ACTIVE',
      current_budget: proposal.daily_budget,
      lifecycle_phase: 'learning',
      activated_at: new Date(),
      learning_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      lifecycle_actions: [{
        action: 'create_and_activate',
        value: { budget: proposal.daily_budget, ads: createdAds.length },
        reason: proposal.strategy_summary,
        executed_at: new Date()
      }]
    });
  } catch (regErr) {
    errors.push(`Error registrando AICreation: ${regErr.message}`);
  }
  steps[steps.length - 1].status = 'done';

  logger.info(`[ADSET-CREATOR] Ad set creado y activado: ${adSetResult.adset_id} — ${createdAds.length} ads`);

  return {
    success: true,
    adset_id: adSetResult.adset_id,
    adset_name: proposal.adset_name,
    ads_created: createdAds.length,
    daily_budget: proposal.daily_budget,
    created_ads: createdAds,
    ai_creation_id: aiCreation?._id || null,
    steps,
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * POST /api/adset-creator/approve
 * Usuario aprueba la propuesta. Lanza creación completa en background:
 * 1. Upload images to Meta
 * 2. Create ad set (PAUSED)
 * 3. Create ad creatives
 * 4. Create ads in ad set
 * 5. Register AICreation
 * 6. Activate ad set
 */
router.post('/approve', async (req, res) => {
  try {
    const { proposal, campaign_id, campaign_name } = req.body;
    if (!proposal) {
      return res.status(400).json({ error: 'Se requiere proposal' });
    }
    proposal.campaign_id = proposal.campaign_id || campaign_id;
    proposal.campaign_name = proposal.campaign_name || campaign_name;

    // Generate job ID and launch in background
    const jobId = `adset_approve_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    approvalJobs.set(jobId, { status: 'running', startedAt: Date.now(), step: 'starting', result: null, error: null });

    // Respond immediately
    res.json({ success: true, async: true, job_id: jobId, message: 'Creación de ad set iniciada en background' });

    // Execute in background
    executeAdSetApproval(proposal)
      .then(result => {
        approvalJobs.set(jobId, {
          status: 'completed',
          startedAt: approvalJobs.get(jobId)?.startedAt,
          step: 'done',
          result,
          error: null
        });
        logger.info(`[ADSET-CREATOR-BG] Job ${jobId} completado: ${result.ads_created} ads creados`);
      })
      .catch(error => {
        approvalJobs.set(jobId, {
          status: 'failed',
          startedAt: approvalJobs.get(jobId)?.startedAt,
          step: 'error',
          result: null,
          error: error.message
        });
        logger.error(`[ADSET-CREATOR-BG] Job ${jobId} error: ${error.message}`);
      })
      .finally(() => {
        setTimeout(() => approvalJobs.delete(jobId), APPROVAL_JOB_TTL);
      });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error en approve: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/adset-creator/approve-status/:jobId
 * Poll status of background ad set approval job.
 */
router.get('/approve-status/:jobId', async (req, res) => {
  const job = approvalJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado o expirado' });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  if (job.status === 'running') {
    return res.json({ status: 'running', elapsed_seconds: elapsed, step: job.step });
  }

  if (job.status === 'completed') {
    return res.json({ status: 'completed', elapsed_seconds: elapsed, result: job.result });
  }

  return res.json({ status: 'failed', elapsed_seconds: elapsed, error: job.error });
});

/**
 * POST /api/adset-creator/reject
 * Usuario rechaza la propuesta. Solo log.
 */
router.post('/reject', async (req, res) => {
  logger.info('[ADSET-CREATOR] Propuesta rechazada por usuario');
  res.json({ success: true });
});

/**
 * GET /api/adset-creator/history
 * Historial de ad sets creados por IA.
 */
router.get('/history', async (req, res) => {
  try {
    const history = await AICreation.find({ creation_type: 'create_adset' })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/adset-creator/manager/status
 * Estado de todos los ad sets gestionados por IA (datos de DB).
 */
router.get('/manager/status', async (req, res) => {
  try {
    const status = await getManagerStatus();
    res.json({ success: true, managed: status });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error obteniendo status del manager: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/adset-creator/manager/status/live
 * Estado enriquecido con métricas LIVE de Meta API:
 * - Métricas del ad set (7d y 3d): spend, clicks, CTR, ROAS, frequency, etc.
 * - Performance individual de cada ad/creativo
 * - Métricas a nivel de campaña
 */
router.get('/manager/status/live', async (req, res) => {
  try {
    const result = await getManagerStatusLive();
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error obteniendo live status: ${error.message}`);
    // Fallback: try to return DB-only data instead of a 500
    try {
      const dbStatus = await getManagerStatus();
      logger.info(`[ADSET-CREATOR] Fallback to DB status: ${dbStatus.length} ad sets`);
      res.json({ success: true, managed: dbStatus, campaign: null });
    } catch (dbError) {
      logger.error(`[ADSET-CREATOR] DB fallback also failed: ${dbError.message}`);
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * POST /api/adset-creator/manager/run
 * Ejecuta el manager manualmente (analiza y toma acciones sobre todos los ad sets IA).
 */
router.post('/manager/run', async (req, res) => {
  try {
    logger.info('[AI-MANAGER] Ejecución manual del manager solicitada');
    const result = await runManager();
    logger.info(`[AI-MANAGER] Manager completado: ${result.managed} gestionados, ${result.actions_taken} acciones`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error ejecutando manager: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/adset-creator/manager/control-panel
 * Returns cycle timing info, Brain directives, and recent action logs
 * for the AI Manager control panel.
 */
router.get('/manager/control-panel', async (req, res) => {
  try {
    const now = new Date();

    // --- Cycle timing ---
    // Brain: runs at :15 and :45 every hour
    // AI Manager: runs at 0 */4 (0:00, 4:00, 8:00, 12:00, 16:00, 20:00)
    const lastBrainDecision = await Decision.findOne()
      .sort({ created_at: -1 })
      .select('created_at cycle_id analysis_summary total_actions approved_actions executed_actions')
      .lean();

    // Find last AI Manager run from AICreation lifecycle_actions or from the most recent run log
    const lastManagerRun = await AICreation.findOne({ managed_by_ai: true })
      .sort({ updated_at: -1 })
      .select('updated_at last_check')
      .lean();

    // Calculate next Brain cycle (:15 or :45)
    const currentMinute = now.getMinutes();
    let nextBrainMinute;
    if (currentMinute < 15) nextBrainMinute = 15;
    else if (currentMinute < 45) nextBrainMinute = 45;
    else nextBrainMinute = 75; // next hour :15
    const nextBrain = new Date(now);
    if (nextBrainMinute >= 60) {
      nextBrain.setHours(nextBrain.getHours() + 1);
      nextBrain.setMinutes(nextBrainMinute - 60, 0, 0);
    } else {
      nextBrain.setMinutes(nextBrainMinute, 0, 0);
    }

    // Calculate next AI Manager cycle (0, 4, 8, 12, 16, 20)
    const currentHour = now.getHours();
    const managerHours = [0, 4, 8, 12, 16, 20];
    let nextManagerHour = managerHours.find(h => h > currentHour);
    const nextManager = new Date(now);
    if (nextManagerHour === undefined) {
      // Next day at 0:00
      nextManager.setDate(nextManager.getDate() + 1);
      nextManager.setHours(0, 0, 0, 0);
    } else {
      nextManager.setHours(nextManagerHour, 0, 0, 0);
    }

    // --- Active Brain Directives for AI-managed ad sets ---
    const managedAdSets = await AICreation.find({
      managed_by_ai: true,
      lifecycle_phase: { $nin: ['dead'] }
    }).select('meta_entity_id meta_entity_name').lean();

    const managedIds = managedAdSets.map(m => m.meta_entity_id);
    const directives = await StrategicDirective.find({
      entity_id: { $in: managedIds },
      status: 'active',
      expires_at: { $gt: now }
    }).sort({ created_at: -1 }).lean();

    // Group directives by entity_id
    const directivesByAdSet = {};
    for (const d of directives) {
      if (!directivesByAdSet[d.entity_id]) directivesByAdSet[d.entity_id] = [];
      directivesByAdSet[d.entity_id].push({
        type: d.directive_type,
        target_action: d.target_action,
        reason: d.reason,
        confidence: d.confidence,
        score_modifier: d.score_modifier,
        source: d.source_insight_type,
        expires_at: d.expires_at,
        created_at: d.created_at
      });
    }

    // --- Recent action logs for AI-managed ad sets ---
    const recentActions = await ActionLog.find({
      entity_id: { $in: managedIds },
      success: true
    })
      .sort({ executed_at: -1 })
      .limit(50)
      .select('entity_id entity_name action executed_at reasoning current_value new_value change_percent')
      .lean();

    // Group actions by entity_id
    const actionsByAdSet = {};
    for (const a of recentActions) {
      if (!actionsByAdSet[a.entity_id]) actionsByAdSet[a.entity_id] = [];
      actionsByAdSet[a.entity_id].push({
        action: a.action,
        executed_at: a.executed_at,
        reasoning: a.reasoning,
        current_value: a.current_value,
        new_value: a.new_value,
        change_percent: a.change_percent
      });
    }

    res.json({
      success: true,
      cycles: {
        brain: {
          last_run: lastBrainDecision?.created_at || null,
          last_cycle_id: lastBrainDecision?.cycle_id || null,
          last_summary: lastBrainDecision?.analysis_summary || null,
          last_actions: lastBrainDecision ? {
            total: lastBrainDecision.total_actions,
            approved: lastBrainDecision.approved_actions,
            executed: lastBrainDecision.executed_actions
          } : null,
          next_run: nextBrain.toISOString(),
          schedule: 'Cada 30 min (:15 y :45)'
        },
        manager: {
          last_run: lastManagerRun?.last_check || lastManagerRun?.updated_at || null,
          next_run: nextManager.toISOString(),
          schedule: 'Cada 4 horas (0:00, 4:00, 8:00, 12:00, 16:00, 20:00)'
        }
      },
      directives: directivesByAdSet,
      directives_total: directives.length,
      brain_actions: actionsByAdSet,
      managed_ids: managedIds
    });
  } catch (error) {
    logger.error(`[ADSET-CREATOR] Error obteniendo control panel: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
