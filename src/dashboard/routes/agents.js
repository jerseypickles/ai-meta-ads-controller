const express = require('express');
const router = express.Router();
const AgentReport = require('../../db/models/AgentReport');
const UnifiedBrain = require('../../ai/brain/unified-brain');
const { getMetaClient } = require('../../meta/client');
const ActionLog = require('../../db/models/ActionLog');
const AICreation = require('../../db/models/AICreation');
const CreativeAsset = require('../../db/models/CreativeAsset');
const SystemConfig = require('../../db/models/SystemConfig');
const { CooldownManager } = require('../../safety/cooldown-manager');
const GuardRail = require('../../safety/guard-rail');
const { getLatestSnapshots, getExecutedActionsWithImpact } = require('../../db/queries');
const logger = require('../../utils/logger');

const DEFAULT_AUTONOMY = {
  mode: 'manual',
  max_auto_change_pct: 20
};

// In-memory store for background agent execution jobs
const agentExecJobs = new Map();
const AGENT_EXEC_JOB_TTL = 10 * 60 * 1000; // 10 minutes

// GET /api/agents/latest — Ultimo reporte del Cerebro IA + historial de impacto por entidad
router.get('/latest', async (req, res) => {
  try {
    const report = await AgentReport.findOne({ agent_type: 'brain' })
      .sort({ created_at: -1 })
      .lean();

    if (!report) {
      return res.json({ brain: null });
    }

    // Collect all entity IDs from recommendations
    const entityIds = [...new Set(
      (report.recommendations || [])
        .filter(r => r.entity_id)
        .map(r => r.entity_id)
    )];

    // Fetch past measured actions for these entities
    const pastActionsByEntity = {};

    if (entityIds.length > 0) {
      const pastActions = await ActionLog.find({
        entity_id: { $in: entityIds },
        success: true,
        impact_measured: true
      }).sort({ executed_at: -1 }).limit(150).lean();

      for (const a of pastActions) {
        if (!pastActionsByEntity[a.entity_id]) pastActionsByEntity[a.entity_id] = [];
        if (pastActionsByEntity[a.entity_id].length < 3) {
          const before = a.metrics_at_execution || {};
          const after = a.metrics_after_3d || a.metrics_after_1d || {};
          const roasBefore = before.roas_7d || 0;
          const roasAfter = after.roas_7d || 0;
          const deltaRoas = roasBefore > 0 ? Math.round((roasAfter - roasBefore) / roasBefore * 10000) / 100 : 0;
          let result = 'neutral';
          if (deltaRoas > 5) result = 'improved';
          else if (deltaRoas < -5) result = 'worsened';

          pastActionsByEntity[a.entity_id].push({
            action: a.action,
            days_ago: Math.round((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24)),
            result,
            delta_roas_pct: deltaRoas
          });
        }
      }
    }

    // Attach past_impact to each recommendation
    if (report.recommendations) {
      for (const rec of report.recommendations) {
        rec.past_impact = pastActionsByEntity[rec.entity_id] || null;
      }
    }

    res.json({ brain: report });
  } catch (error) {
    logger.error('Error obteniendo reporte del Cerebro IA:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/history — Historial por agente
router.get('/history', async (req, res) => {
  try {
    const { agent_type, limit = 20 } = req.query;
    const filter = agent_type ? { agent_type } : {};

    const reports = await AgentReport.find(filter)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json(reports);
  } catch (error) {
    logger.error('Error obteniendo historial de agentes:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/pending — Recomendaciones pendientes del Cerebro IA + historial de impacto
router.get('/pending', async (req, res) => {
  try {
    const report = await AgentReport.findOne({ agent_type: 'brain' })
      .sort({ created_at: -1 })
      .lean();

    const pending = [];
    if (report && report.recommendations) {
      for (const rec of report.recommendations) {
        if ((rec.status === 'pending' || rec.status === 'approved') && rec.action !== 'no_action') {
          pending.push({
            ...rec,
            agent_type: 'brain',
            report_id: report._id,
            report_created_at: report.created_at
          });
        }
      }
    }

    // Enrich with past measured actions on that entity
    const entityIds = [...new Set(pending.map(r => r.entity_id))];
    const pastActionsByEntity = {};

    if (entityIds.length > 0) {
      const pastActions = await ActionLog.find({
        entity_id: { $in: entityIds },
        success: true,
        impact_measured: true
      }).sort({ executed_at: -1 }).limit(100).lean();

      for (const a of pastActions) {
        if (!pastActionsByEntity[a.entity_id]) pastActionsByEntity[a.entity_id] = [];
        if (pastActionsByEntity[a.entity_id].length < 3) {
          const before = a.metrics_at_execution || {};
          const after = a.metrics_after_3d || a.metrics_after_1d || {};
          const roasBefore = before.roas_7d || 0;
          const roasAfter = after.roas_7d || 0;
          const deltaRoas = roasBefore > 0 ? Math.round((roasAfter - roasBefore) / roasBefore * 10000) / 100 : 0;
          const cpaBefore = before.cpa_7d || 0;
          const cpaAfter = after.cpa_7d || 0;
          const deltaCpa = cpaBefore > 0 ? Math.round((cpaAfter - cpaBefore) / cpaBefore * 10000) / 100 : 0;
          let result = 'neutral';
          if (deltaRoas > 5) result = 'improved';
          else if (deltaRoas < -5) result = 'worsened';

          pastActionsByEntity[a.entity_id].push({
            action: a.action,
            days_ago: Math.round((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24)),
            result,
            delta_roas_pct: deltaRoas,
            delta_cpa_pct: deltaCpa,
            roas_before: roasBefore,
            roas_after: roasAfter
          });
        }
      }
    }

    // Attach past impact to each recommendation
    const enriched = pending.map(rec => ({
      ...rec,
      past_impact: pastActionsByEntity[rec.entity_id] || null
    }));

    res.json(enriched);
  } catch (error) {
    logger.error('Error obteniendo recomendaciones pendientes:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/agents/approve/:reportId/:recId — Aprobar recomendacion
router.post('/approve/:reportId/:recId', async (req, res) => {
  try {
    const { reportId, recId } = req.params;

    const report = await AgentReport.findById(reportId);
    if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });

    const rec = report.recommendations.id(recId);
    if (!rec) return res.status(404).json({ error: 'Recomendacion no encontrada' });

    if (rec.status !== 'pending') {
      return res.status(400).json({ error: `Recomendacion ya esta en estado: ${rec.status}` });
    }

    rec.status = 'approved';
    rec.approved_by = req.user?.user || 'admin';
    rec.approved_at = new Date();
    await report.save();

    logger.info(`Recomendacion aprobada: ${rec.action} en ${rec.entity_name} (agente: ${report.agent_type})`);
    res.json({ success: true, recommendation: rec });
  } catch (error) {
    logger.error('Error aprobando recomendacion:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/agents/reject/:reportId/:recId — Rechazar recomendacion
router.post('/reject/:reportId/:recId', async (req, res) => {
  try {
    const { reportId, recId } = req.params;

    const report = await AgentReport.findById(reportId);
    if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });

    const rec = report.recommendations.id(recId);
    if (!rec) return res.status(404).json({ error: 'Recomendacion no encontrada' });

    if (rec.status !== 'pending') {
      return res.status(400).json({ error: `Recomendacion ya esta en estado: ${rec.status}` });
    }

    rec.status = 'rejected';
    rec.approved_by = req.user?.user || 'admin';
    rec.approved_at = new Date();
    await report.save();

    logger.info(`Recomendacion rechazada: ${rec.action} en ${rec.entity_name} (agente: ${report.agent_type})`);
    res.json({ success: true, recommendation: rec });
  } catch (error) {
    logger.error('Error rechazando recomendacion:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/agents/execute/:reportId/:recId — Ejecutar recomendacion aprobada (background)
router.post('/execute/:reportId/:recId', async (req, res) => {
  try {
    const { reportId, recId } = req.params;

    const report = await AgentReport.findById(reportId);
    if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });

    const rec = report.recommendations.id(recId);
    if (!rec) return res.status(404).json({ error: 'Recomendacion no encontrada' });

    if (rec.status !== 'approved') {
      return res.status(400).json({ error: `Recomendacion debe estar aprobada primero (estado actual: ${rec.status})` });
    }

    // Verificar cooldown de 3 días
    const cooldownManager = new CooldownManager();
    const cooldownCheck = await cooldownManager.isOnCooldown(rec.entity_id);
    if (cooldownCheck.onCooldown) {
      return res.status(400).json({
        error: `Ad set en cooldown — ${cooldownCheck.hoursLeft}h restantes. Último cambio: ${cooldownCheck.lastAction} (${cooldownCheck.lastAgent}). Espera a que se complete la medición de impacto.`
      });
    }

    // Guard rail validation
    const guardRail = new GuardRail();
    const guardCheck = await guardRail.validate({
      action: rec.action,
      entity_id: rec.entity_id,
      entity_name: rec.entity_name,
      current_value: rec.current_value,
      new_value: rec.recommended_value,
      creative_asset_id: rec.creative_asset_id,
      bid_strategy: rec.bid_strategy
    });

    if (!guardCheck.approved) {
      return res.status(400).json({ error: `Guard rail: ${guardCheck.reason}` });
    }

    // Launch Meta API execution in background
    const jobId = `agent_exec_${reportId}_${recId}_${Date.now()}`;
    agentExecJobs.set(jobId, { status: 'running', startedAt: Date.now(), result: null, error: null });

    // Respond immediately after validation passes
    res.json({ success: true, async: true, job_id: jobId, message: 'Ejecución iniciada en background' });

    // Background execution
    (async () => {
    const effectiveValue = guardCheck.adjustedValue || rec.recommended_value;

    const meta = getMetaClient();
    let apiResponse;
    let newEntityId = null;

    switch (rec.action) {
      case 'scale_up':
      case 'scale_down':
        apiResponse = await meta.updateBudget(rec.entity_id, effectiveValue);
        break;
      case 'pause':
        apiResponse = await meta.updateStatus(rec.entity_id, 'PAUSED');
        break;
      case 'reactivate':
        apiResponse = await meta.updateStatus(rec.entity_id, 'ACTIVE');
        break;
      case 'update_ad_status':
        apiResponse = await meta.updateAdStatus(rec.entity_id, rec.recommended_value === 0 ? 'PAUSED' : 'ACTIVE');
        break;
      case 'duplicate_adset':
        apiResponse = await meta.duplicateAdSet(rec.entity_id, {
          name: rec.duplicate_name || `[SCALE] ${rec.entity_name} - Copy`,
          daily_budget: effectiveValue,
          status: 'PAUSED'
        });
        newEntityId = apiResponse?.copied_adset_id || apiResponse?.new_adset_id || null;
        break;
      case 'create_ad': {
        // Full flow: get asset -> upload to Meta -> create creative -> create ad -> pause fatigued ads
        // Allow user to override the Brain's creative pick via request body
        const selectedCreativeId = req.body.creative_asset_id || rec.creative_asset_id;
        const asset = await CreativeAsset.findById(selectedCreativeId);
        if (!asset) {
          throw new Error('Creative asset no encontrado');
        }

        // Validate required fields for Meta API
        if (!asset.link_url) {
          throw new Error('El creativo no tiene link de producto. Edita el creativo en el banco y agrega el link_url antes de usarlo en un ad.');
        }

        // Upload to Meta if needed
        if (!asset.uploaded_to_meta) {
          if (asset.media_type === 'image') {
            const uploadResult = await meta.uploadImage(asset.file_path);
            asset.meta_image_hash = uploadResult.image_hash;
          } else {
            const uploadResult = await meta.uploadVideo(asset.file_path);
            asset.meta_video_id = uploadResult.video_id;
          }
          asset.uploaded_to_meta = true;
          asset.uploaded_at = new Date();
          await asset.save();
        }

        // Create ad creative — Brain generates copy (headline, primary_text), asset provides image + link
        const adHeadline = rec.ad_headline || asset.headline || '';
        const adPrimaryText = rec.ad_primary_text || asset.body || '';
        const pageId = await meta.getPageId();
        const creativeResult = await meta.createAdCreative({
          name: `Creative - ${adHeadline || asset.original_name}`,
          page_id: pageId,
          image_hash: asset.meta_image_hash,
          video_id: asset.meta_video_id,
          headline: adHeadline,
          body: adPrimaryText,
          description: asset.description || '',
          link_url: asset.link_url,
          cta: asset.cta || 'SHOP_NOW'
        });
        const metaCreativeId = creativeResult.creative_id;

        // Create ad in the target ad set
        const adName = rec.ad_name || `Ad - ${asset.headline || asset.original_name}`;
        const adResult = await meta.createAd(
          rec.entity_id,
          metaCreativeId,
          adName,
          'ACTIVE'
        );

        // Pausar ads fatigados que la IA identificó
        const pausedAds = [];
        if (Array.isArray(rec.ads_to_pause) && rec.ads_to_pause.length > 0) {
          for (const adId of rec.ads_to_pause) {
            try {
              await meta.updateAdStatus(adId, 'PAUSED');
              pausedAds.push(adId);
              logger.info(`Ad fatigado pausado: ${adId} (recomendado por IA al crear nuevo ad)`);
            } catch (pauseErr) {
              logger.warn(`No se pudo pausar ad fatigado ${adId}: ${pauseErr.message}`);
            }
          }
        }

        // Update asset tracking
        asset.times_used = (asset.times_used || 0) + 1;
        if (adResult.ad_id) {
          asset.used_in_ads.push(adResult.ad_id);
        }
        if (rec.entity_id && !asset.used_in_adsets.includes(rec.entity_id)) {
          asset.used_in_adsets.push(rec.entity_id);
        }
        await asset.save();

        apiResponse = { creative_id: metaCreativeId, ad_id: adResult.ad_id, ad_name: adName, paused_fatigued_ads: pausedAds };
        newEntityId = adResult.ad_id;
        break;
      }
      case 'update_bid_strategy':
        apiResponse = await meta.updateBidStrategy(
          rec.entity_id,
          rec.bid_strategy,
          rec.recommended_value || null
        );
        break;
      case 'move_budget': {
        // Get current budgets from snapshots
        const snapshots = await getLatestSnapshots('adset');
        const sourceSnap = snapshots.find(s => s.entity_id === rec.entity_id);
        const targetSnap = snapshots.find(s => s.entity_id === rec.target_entity_id);

        if (!sourceSnap || !targetSnap) {
          throw new Error('No se encontraron snapshots para source/target');
        }

        const moveAmount = rec.recommended_value;
        const newSourceBudget = Math.round((sourceSnap.daily_budget - moveAmount) * 100) / 100;
        const newTargetBudget = Math.round((targetSnap.daily_budget + moveAmount) * 100) / 100;

        const sourceResult = await meta.updateBudget(rec.entity_id, newSourceBudget);
        const targetResult = await meta.updateBudget(rec.target_entity_id, newTargetBudget);

        apiResponse = {
          source: { id: rec.entity_id, old_budget: sourceSnap.daily_budget, new_budget: newSourceBudget, result: sourceResult },
          target: { id: rec.target_entity_id, old_budget: targetSnap.daily_budget, new_budget: newTargetBudget, result: targetResult }
        };
        break;
      }
      default:
        throw new Error(`Accion no ejecutable: ${rec.action}`);
    }

    rec.status = 'executed';
    rec.executed_at = new Date();
    rec.execution_result = apiResponse;
    await report.save();

    // Capturar métricas al momento de ejecución para tracking de impacto
    // FIX: Para entity_type='ad', buscar métricas del ad set padre
    let metricsAtExecution = {};
    try {
      const entityType = rec.entity_type || 'adset';
      let entitySnapshot = null;

      if (entityType === 'ad') {
        // Para ads: buscar el ad snapshot para obtener parent_id, luego métricas del adset padre
        const adSnapshots = await getLatestSnapshots('ad');
        const adSnap = adSnapshots.find(s => s.entity_id === rec.entity_id);
        if (adSnap && adSnap.parent_id) {
          const adsetSnapshots = await getLatestSnapshots('adset');
          entitySnapshot = adsetSnapshots.find(s => s.entity_id === adSnap.parent_id);
        }
        // Fallback: buscar directamente como adset por si el entity_id es un adset
        if (!entitySnapshot) {
          const adsetSnapshots = await getLatestSnapshots('adset');
          entitySnapshot = adsetSnapshots.find(s => s.entity_id === rec.entity_id);
        }
      } else {
        const snapshots = await getLatestSnapshots('adset');
        entitySnapshot = snapshots.find(s => s.entity_id === rec.entity_id);
      }

      if (entitySnapshot) {
        metricsAtExecution = {
          roas_7d: entitySnapshot.metrics?.last_7d?.roas || 0,
          roas_3d: entitySnapshot.metrics?.last_3d?.roas || 0,
          cpa_7d: entitySnapshot.metrics?.last_7d?.cpa || 0,
          spend_today: entitySnapshot.metrics?.today?.spend || 0,
          spend_7d: entitySnapshot.metrics?.last_7d?.spend || 0,
          daily_budget: entitySnapshot.daily_budget || 0,
          purchases_7d: entitySnapshot.metrics?.last_7d?.purchases || 0,
          purchase_value_7d: entitySnapshot.metrics?.last_7d?.purchase_value || 0,
          frequency: entitySnapshot.metrics?.last_7d?.frequency || 0,
          ctr: entitySnapshot.metrics?.last_7d?.ctr || 0
        };
      }
    } catch (snapErr) {
      logger.warn(`No se pudieron capturar métricas al ejecutar: ${snapErr.message}`);
    }

    const savedActionLog = await ActionLog.create({
      decision_id: report._id,
      cycle_id: report.cycle_id,
      entity_type: rec.entity_type,
      entity_id: rec.entity_id,
      entity_name: rec.entity_name,
      action: rec.action,
      before_value: rec.current_value,
      after_value: effectiveValue,
      change_percent: rec.change_percent,
      reasoning: `[${report.agent_type.toUpperCase()}] ${rec.reasoning}`,
      confidence: rec.confidence,
      agent_type: report.agent_type,
      success: true,
      meta_api_response: apiResponse,
      metrics_at_execution: metricsAtExecution,
      target_entity_id: rec.target_entity_id || null,
      target_entity_name: rec.target_entity_name || null,
      creative_asset_id: rec.creative_asset_id || null,
      new_entity_id: newEntityId
    });

    // Registrar AICreation para seguimiento exclusivo
    if (newEntityId && ['duplicate_adset', 'create_ad'].includes(rec.action)) {
      try {
        await AICreation.create({
          creation_type: rec.action,
          meta_entity_id: newEntityId,
          meta_entity_type: rec.action === 'duplicate_adset' ? 'adset' : 'ad',
          meta_entity_name: rec.action === 'duplicate_adset'
            ? (rec.duplicate_name || `[SCALE] ${rec.entity_name} - Copy`)
            : (rec.ad_name || 'AI Ad'),
          parent_entity_id: rec.entity_id,
          parent_entity_name: rec.entity_name || '',
          agent_type: report.agent_type,
          reasoning: rec.reasoning || '',
          confidence: rec.confidence || 'medium',
          duplicate_strategy: rec.duplicate_strategy || null,
          creative_rationale: rec.creative_rationale || null,
          creative_asset_id: rec.creative_asset_id || null,
          ads_paused: Array.isArray(rec.ads_to_pause) ? rec.ads_to_pause : [],
          initial_budget: effectiveValue || 0,
          report_id: report._id,
          action_log_id: savedActionLog._id,
          parent_metrics_at_creation: {
            roas_7d: metricsAtExecution.roas_7d || 0,
            cpa_7d: metricsAtExecution.cpa_7d || 0,
            ctr: metricsAtExecution.ctr || 0,
            frequency: metricsAtExecution.frequency || 0,
            spend_7d: metricsAtExecution.spend_7d || 0,
            daily_budget: metricsAtExecution.daily_budget || 0
          },
          current_status: 'PAUSED'
        });
        logger.info(`[AI_CREATION] Registrado: ${rec.action} — ${newEntityId}`);
      } catch (creationErr) {
        logger.warn(`Error registrando AICreation: ${creationErr.message}`);
      }
    }

    // Set cooldown
    const cooldownManagerPost = new CooldownManager();
    await cooldownManagerPost.setCooldown(rec.entity_id, rec.entity_type, rec.action);

    logger.info(`Recomendacion ejecutada: ${rec.action} en ${rec.entity_name} (agente: ${report.agent_type})`);
    agentExecJobs.set(jobId, {
      status: 'completed',
      startedAt: agentExecJobs.get(jobId)?.startedAt,
      result: { success: true, recommendation: rec, api_response: apiResponse, guard_rail: guardCheck },
      error: null
    });
    })().catch(error => {
      logger.error('Error ejecutando recomendacion:', error);
      agentExecJobs.set(jobId, {
        status: 'failed',
        startedAt: agentExecJobs.get(jobId)?.startedAt,
        result: null,
        error: error.message
      });
    }).finally(() => {
      setTimeout(() => agentExecJobs.delete(jobId), AGENT_EXEC_JOB_TTL);
    });
  } catch (error) {
    logger.error('Error ejecutando recomendacion:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/execute-status/:jobId — Poll status of background agent execution
router.get('/execute-status/:jobId', async (req, res) => {
  const job = agentExecJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado o expirado' });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  if (job.status === 'running') {
    return res.json({ status: 'running', elapsed_seconds: elapsed });
  }

  if (job.status === 'completed') {
    return res.json({ status: 'completed', elapsed_seconds: elapsed, result: job.result });
  }

  return res.json({ status: 'failed', elapsed_seconds: elapsed, error: job.error });
});

// GET /api/agents/impact — Acciones ejecutadas con métricas before/after (24h + 3d)
router.get('/impact', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const actions = await getExecutedActionsWithImpact(limit);

    // Calcular deltas — prefer 7d metrics over 3d (higher attribution accuracy)
    const withDeltas = actions.map(a => {
      const before = a.metrics_at_execution || {};
      const after7d = a.metrics_after_7d || {};
      const after3d = a.metrics_after_3d || {};
      const after1d = a.metrics_after_1d || {};
      // Use 7d data if available, fallback to 3d
      const afterBest = (a.impact_7d_measured && after7d.roas_7d > 0) ? after7d : after3d;
      const afterWindow = (a.impact_7d_measured && after7d.roas_7d > 0) ? '7d' : '3d';

      const deltaRoas = before.roas_7d > 0
        ? ((afterBest.roas_7d - before.roas_7d) / before.roas_7d) * 100
        : 0;
      const deltaCpa = before.cpa_7d > 0
        ? ((afterBest.cpa_7d - before.cpa_7d) / before.cpa_7d) * 100
        : 0;

      // Deltas 24h
      const deltaRoas1d = before.roas_7d > 0
        ? ((after1d.roas_7d - before.roas_7d) / before.roas_7d) * 100
        : 0;
      const deltaCpa1d = before.cpa_7d > 0
        ? ((after1d.cpa_7d - before.cpa_7d) / before.cpa_7d) * 100
        : 0;

      let result = 'neutral';
      if (deltaRoas > 5) result = 'improved';
      else if (deltaRoas < -5) result = 'worsened';

      const entry = {
        ...a,
        agent_type: resolveAgentType(a),
        delta_roas_pct: deltaRoas,
        delta_cpa_pct: deltaCpa,
        delta_roas_1d_pct: deltaRoas1d,
        delta_cpa_1d_pct: deltaCpa1d,
        has_1d_data: a.impact_1d_measured === true,
        has_7d_data: a.impact_7d_measured === true,
        after_window: afterWindow,
        metrics_after_best: afterBest,
        result
      };

      // For create_ad: include ad-level metrics
      if (a.action === 'create_ad' && a.new_entity_id) {
        entry.is_create_ad = true;
        entry.ad_metrics = a.ad_metrics_after_7d || a.ad_metrics_after_3d || null;
        entry.ad_metrics_1d = a.ad_metrics_after_1d || null;
      }

      return entry;
    });

    // También incluir acciones pendientes de medición (< 3 días)
    const pendingActions = await ActionLog.find({
      success: true,
      impact_measured: false
    })
      .sort({ executed_at: -1 })
      .limit(20)
      .lean();

    const pendingWithCountdown = pendingActions.map(a => {
      const daysElapsed = (Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24);
      const hoursElapsed = (Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60);
      const before = a.metrics_at_execution || {};
      const after1d = a.metrics_after_1d || {};

      // Si ya hay datos de 24h, incluir deltas parciales
      const deltaRoas1d = (a.impact_1d_measured && before.roas_7d > 0)
        ? ((after1d.roas_7d - before.roas_7d) / before.roas_7d) * 100
        : null;
      const deltaCpa1d = (a.impact_1d_measured && before.cpa_7d > 0)
        ? ((after1d.cpa_7d - before.cpa_7d) / before.cpa_7d) * 100
        : null;

      const entry = {
        ...a,
        agent_type: resolveAgentType(a),
        hours_elapsed: Math.floor(hoursElapsed),
        days_elapsed: Math.floor(daysElapsed * 10) / 10,
        days_remaining: Math.max(0, Math.ceil(3 - daysElapsed)),
        delta_roas_1d_pct: deltaRoas1d,
        delta_cpa_1d_pct: deltaCpa1d,
        has_1d_data: a.impact_1d_measured === true,
        result: 'measuring'
      };

      if (a.action === 'create_ad' && a.new_entity_id) {
        entry.is_create_ad = true;
        entry.ad_metrics_1d = a.ad_metrics_after_1d || null;
      }

      return entry;
    });

    res.json({
      measured: withDeltas,
      pending: pendingWithCountdown
    });
  } catch (error) {
    logger.error('Error obteniendo impacto de acciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/agents/run — Forzar ejecucion manual del Cerebro IA
router.post('/run', async (req, res) => {
  try {
    logger.info('[MANUAL] Ejecucion del Cerebro IA solicitada desde dashboard');
    const brain = new UnifiedBrain();
    const result = await brain.runCycle();
    const recommendations = result?.report?.recommendations?.length || result?.recommendations || 0;
    res.json({
      success: true,
      result: {
        cycleId: result?.cycleId,
        elapsed: result?.elapsed,
        recommendations,
        autoExecuted: result?.autoExecuted || 0,
        abortReason: result?.abortReason || null
      }
    });
  } catch (error) {
    logger.error('Error ejecutando Cerebro IA manualmente:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/autonomy — Obtener config de autonomia actual (desde MongoDB)
router.get('/autonomy', async (req, res) => {
  try {
    const autonomy = await SystemConfig.get('autonomy', DEFAULT_AUTONOMY);
    res.json(autonomy);
  } catch (error) {
    logger.error('Error obteniendo config de autonomia:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/agents/autonomy — Actualizar modo de autonomia global del Cerebro IA
router.put('/autonomy', async (req, res) => {
  try {
    const safetyGuards = require('../../../config/safety-guards');
    const validModes = ['manual', 'semi_auto', 'auto'];
    const updates = req.body;

    // Leer autonomía actual desde MongoDB
    const autonomy = await SystemConfig.get('autonomy', DEFAULT_AUTONOMY);
    const oldMode = autonomy.mode || 'manual';

    let triggerBrain = false;

    if (updates.mode && validModes.includes(updates.mode)) {
      autonomy.mode = updates.mode;
      logger.info(`[AUTONOMIA] Modo del Cerebro IA cambiado a: ${updates.mode}`);

      // Si pasamos de manual a semi_auto/auto, disparar cerebro inmediatamente
      if (oldMode === 'manual' && (updates.mode === 'semi_auto' || updates.mode === 'auto')) {
        triggerBrain = true;
      }
    }

    if (updates.max_auto_change_pct !== undefined) {
      const pct = parseInt(updates.max_auto_change_pct);
      if (pct >= 5 && pct <= 50) {
        autonomy.max_auto_change_pct = pct;
      }
    }

    // Persistir en MongoDB
    await SystemConfig.set('autonomy', autonomy, req.user?.user || 'admin');

    // Sincronizar a memoria
    safetyGuards.autonomy = { ...autonomy };

    // Disparar ciclo del cerebro en background si se activó autonomía
    if (triggerBrain) {
      logger.info('[AUTONOMIA] Modo autónomo activado — disparando Cerebro IA inmediatamente');
      setImmediate(async () => {
        try {
          const brain = new UnifiedBrain();
          const result = await brain.runCycle();
          if (result) {
            logger.info(`[AUTONOMIA] Ciclo automático completado — ${result.autoExecuted} acciones ejecutadas`);
          }
        } catch (err) {
          logger.error(`[AUTONOMIA] Error en ciclo automático: ${err.message}`);
        }
      });
    }

    res.json({ success: true, autonomy, brain_triggered: triggerBrain });
  } catch (error) {
    logger.error('Error actualizando autonomia:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/agents/cooldowns — Limpiar todos los cooldowns activos
router.delete('/cooldowns', async (req, res) => {
  try {
    const cooldownManager = new CooldownManager();
    const active = await cooldownManager.getActiveCooldowns();
    for (const cd of active) {
      await cooldownManager.clearCooldown(cd.entity_id);
    }
    logger.info(`[COOLDOWN] ${active.length} cooldowns limpiados manualmente`);
    res.json({ success: true, cleared: active.length });
  } catch (error) {
    logger.error('Error limpiando cooldowns:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/cooldowns — Ver cooldowns activos
router.get('/cooldowns', async (req, res) => {
  try {
    const cooldownManager = new CooldownManager();
    const active = await cooldownManager.getActiveCooldowns();
    res.json(active);
  } catch (error) {
    logger.error('Error obteniendo cooldowns:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/agents/readiness — Brain maturity/readiness indicator (strict criteria)
router.get('/readiness', async (req, res) => {
  try {
    const MetricSnapshot = require('../../db/models/MetricSnapshot');
    const PolicyLearner = require('../../ai/unified/policy-learner');
    const learner = new PolicyLearner();
    const learnerState = await learner.loadState();

    // ═══ 1. DATA HISTORY: How many days of snapshot data exist? ═══
    const oldestSnapshot = await MetricSnapshot.findOne().sort({ snapshot_at: 1 }).lean();
    const newestSnapshot = await MetricSnapshot.findOne().sort({ snapshot_at: -1 }).lean();
    const dataDays = oldestSnapshot && newestSnapshot
      ? Math.floor((new Date(newestSnapshot.snapshot_at) - new Date(oldestSnapshot.snapshot_at)) / (1000 * 60 * 60 * 24))
      : 0;
    // Strict: need 21+ days for solid budget decisions (3 full weekly cycles)
    const dataScore = Math.min(1, dataDays / 21);

    // ═══ 2. EXECUTED ACTIONS with measured impact ═══
    const totalExecuted = await ActionLog.countDocuments({ success: true });
    const totalMeasured = await ActionLog.countDocuments({ success: true, impact_measured: true });
    // Budget-specific actions measured (the ones we care about for autonomy)
    const budgetMeasured = await ActionLog.countDocuments({
      success: true, impact_measured: true,
      action: { $in: ['scale_up', 'scale_down', 'move_budget'] }
    });
    // Strict: need 50+ total measured actions, 20+ budget-specific
    const volumeScore = Math.min(1, (totalMeasured / 50) * 0.6 + (budgetMeasured / 20) * 0.4);

    // ═══ 3. WIN RATE: % of measured actions that improved ROAS ═══
    const measuredActions = await ActionLog.find({
      success: true, impact_measured: true
    }).select('action metrics_at_execution metrics_after_3d metrics_after_7d').lean();

    let wins = 0;
    let losses = 0;
    let budgetWins = 0;
    let budgetTotal = 0;
    const isBudgetAction = a => ['scale_up', 'scale_down', 'move_budget'].includes(a);

    for (const a of measuredActions) {
      const before = a.metrics_at_execution || {};
      const after = (a.metrics_after_7d?.roas_7d > 0 ? a.metrics_after_7d : a.metrics_after_3d) || {};
      const roasBefore = before.roas_7d || 0;
      const roasAfter = after.roas_7d || 0;
      if (roasBefore <= 0) continue;
      const delta = ((roasAfter - roasBefore) / roasBefore) * 100;
      if (delta > 5) {
        wins++;
        if (isBudgetAction(a.action)) budgetWins++;
      } else if (delta < -5) {
        losses++;
      }
      if (isBudgetAction(a.action)) budgetTotal++;
    }
    const totalDecided = wins + losses;
    const winRate = totalDecided > 0 ? wins / totalDecided : 0;
    const budgetWinRate = budgetTotal > 0 ? budgetWins / budgetTotal : 0;
    // Strict: need 60%+ overall win rate AND 55%+ budget-specific
    const winRateScore = totalDecided >= 10
      ? Math.min(1, (winRate / 0.60) * 0.5 + (budgetWinRate / 0.55) * 0.5)
      : Math.min(0.3, winRate); // Cap at 0.3 if < 10 decisions — not enough evidence

    // ═══ 4. LEARNER SIGNAL STRENGTH: buckets with data ═══
    const buckets = learnerState.buckets || {};
    const bucketCount = Object.keys(buckets).length;
    const totalSamples = learnerState.total_samples || 0;
    let avgConfidence = 0;
    let avgReward = 0;
    let bucketsWithSignificantData = 0;

    for (const [, actions] of Object.entries(buckets)) {
      for (const [, stats] of Object.entries(actions)) {
        if (stats.count >= 5) bucketsWithSignificantData++;
        avgConfidence += Math.min(1, stats.count / 25);
        avgReward += stats.count > 0 ? stats.total_reward / stats.count : 0;
      }
    }
    const totalActionSlots = Object.values(buckets).reduce((sum, b) => sum + Object.keys(b).length, 0);
    if (totalActionSlots > 0) {
      avgConfidence /= totalActionSlots;
      avgReward /= totalActionSlots;
    }
    // Strict: need 8+ buckets with some data, 3+ with significant data (5+ samples)
    const learnerScore = Math.min(1,
      (bucketCount / 8) * 0.3 +
      (bucketsWithSignificantData / 3) * 0.3 +
      (avgConfidence) * 0.2 +
      (totalSamples / 100) * 0.2
    );

    // ═══ 5. CONSISTENCY: Recent 7-day performance stability ═══
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentMeasured = await ActionLog.find({
      success: true, impact_measured: true,
      executed_at: { $gte: sevenDaysAgo }
    }).select('metrics_at_execution metrics_after_3d metrics_after_7d').lean();

    let recentWins = 0;
    let recentTotal = 0;
    for (const a of recentMeasured) {
      const before = a.metrics_at_execution || {};
      const after = (a.metrics_after_7d?.roas_7d > 0 ? a.metrics_after_7d : a.metrics_after_3d) || {};
      if (before.roas_7d > 0) {
        recentTotal++;
        if (((after.roas_7d - before.roas_7d) / before.roas_7d) * 100 > 5) recentWins++;
      }
    }
    const recentWinRate = recentTotal > 0 ? recentWins / recentTotal : 0;
    // Must show consistent recent performance, not just historical
    const consistencyScore = recentTotal >= 5
      ? Math.min(1, recentWinRate / 0.55)
      : Math.min(0.2, recentWinRate); // Cap low if not enough recent data

    // ═══ 6. NO HARM CHECK: Recent catastrophic losses ═══
    const recentLosses = await ActionLog.countDocuments({
      success: true, impact_measured: true,
      executed_at: { $gte: sevenDaysAgo },
      action: { $in: ['scale_up', 'scale_down', 'move_budget'] }
    });
    // Check if any caused >20% ROAS drop
    let catastrophicLosses = 0;
    const recentBudgetActions = await ActionLog.find({
      success: true, impact_measured: true,
      executed_at: { $gte: sevenDaysAgo },
      action: { $in: ['scale_up', 'scale_down', 'move_budget'] }
    }).select('metrics_at_execution metrics_after_3d metrics_after_7d').lean();

    for (const a of recentBudgetActions) {
      const before = a.metrics_at_execution || {};
      const after = (a.metrics_after_7d?.roas_7d > 0 ? a.metrics_after_7d : a.metrics_after_3d) || {};
      if (before.roas_7d > 0) {
        const delta = ((after.roas_7d - before.roas_7d) / before.roas_7d) * 100;
        if (delta < -20) catastrophicLosses++;
      }
    }
    // Any catastrophic loss in last 7 days = heavy penalty
    const safetyScore = catastrophicLosses > 0 ? Math.max(0, 1 - (catastrophicLosses * 0.5)) : 1;

    // ═══ FINAL READINESS INDEX (0-100) ═══
    // Weighted with strict thresholds
    const rawIndex = (
      dataScore * 0.15 +          // 15% - Historical data depth
      volumeScore * 0.20 +        // 20% - Volume of measured actions
      winRateScore * 0.25 +       // 25% - Win rate (heaviest — need proof it works)
      learnerScore * 0.10 +       // 10% - Learner model maturity
      consistencyScore * 0.20 +   // 20% - Recent consistency
      safetyScore * 0.10          // 10% - No recent catastrophes
    ) * 100;

    // Hard gates: even if score is high, block if fundamentals missing
    let readinessIndex = Math.round(rawIndex);
    let hardBlock = null;
    if (dataDays < 7) {
      readinessIndex = Math.min(readinessIndex, 15);
      hardBlock = 'Menos de 7 dias de data — necesita minimo 21 dias';
    } else if (totalMeasured < 10) {
      readinessIndex = Math.min(readinessIndex, 25);
      hardBlock = 'Menos de 10 acciones medidas — necesita minimo 50';
    } else if (budgetMeasured < 5) {
      readinessIndex = Math.min(readinessIndex, 30);
      hardBlock = 'Menos de 5 acciones de budget medidas — necesita 20+';
    } else if (winRate < 0.40) {
      readinessIndex = Math.min(readinessIndex, 35);
      hardBlock = 'Win rate menor a 40% — el Brain aun no es confiable';
    } else if (catastrophicLosses > 0) {
      readinessIndex = Math.min(readinessIndex, 40);
      hardBlock = `${catastrophicLosses} perdida(s) catastrofica(s) en ultimos 7 dias`;
    }

    // Maturity level
    let level, levelLabel, levelColor;
    if (readinessIndex < 30) {
      level = 'learning';
      levelLabel = 'Aprendiendo';
      levelColor = '#ef4444';
    } else if (readinessIndex < 50) {
      level = 'developing';
      levelLabel = 'Desarrollando';
      levelColor = '#f59e0b';
    } else if (readinessIndex < 70) {
      level = 'capable';
      levelLabel = 'Capaz';
      levelColor = '#3b82f6';
    } else if (readinessIndex < 85) {
      level = 'ready';
      levelLabel = 'Listo';
      levelColor = '#10b981';
    } else {
      level = 'expert';
      levelLabel = 'Experto';
      levelColor = '#8b5cf6';
    }

    // Recommended autonomy mode based on readiness
    let recommendedMode = 'manual';
    if (readinessIndex >= 85 && !hardBlock) recommendedMode = 'auto';
    else if (readinessIndex >= 70 && !hardBlock) recommendedMode = 'semi_auto';

    res.json({
      readiness_index: readinessIndex,
      level,
      level_label: levelLabel,
      level_color: levelColor,
      recommended_mode: recommendedMode,
      hard_block: hardBlock,
      breakdown: {
        data_history: {
          score: Math.round(dataScore * 100),
          days: dataDays,
          required: 21,
          label: 'Dias de data'
        },
        action_volume: {
          score: Math.round(volumeScore * 100),
          total_executed: totalExecuted,
          total_measured: totalMeasured,
          budget_measured: budgetMeasured,
          required_total: 50,
          required_budget: 20,
          label: 'Acciones medidas'
        },
        win_rate: {
          score: Math.round(winRateScore * 100),
          overall: Math.round(winRate * 100),
          budget: Math.round(budgetWinRate * 100),
          wins,
          losses,
          total_decided: totalDecided,
          required_pct: 60,
          label: 'Win rate'
        },
        learner_maturity: {
          score: Math.round(learnerScore * 100),
          buckets: bucketCount,
          significant_buckets: bucketsWithSignificantData,
          total_samples: totalSamples,
          avg_reward: Math.round(avgReward * 1000) / 1000,
          label: 'Modelo aprendizaje'
        },
        consistency: {
          score: Math.round(consistencyScore * 100),
          recent_win_rate: Math.round(recentWinRate * 100),
          recent_total: recentTotal,
          label: 'Consistencia reciente'
        },
        safety: {
          score: Math.round(safetyScore * 100),
          catastrophic_losses: catastrophicLosses,
          label: 'Seguridad'
        }
      }
    });
  } catch (error) {
    logger.error('Error calculando readiness del Brain:', error);
    res.status(500).json({ error: error.message });
  }
});

function resolveAgentType(actionLog) {
  const normalize = (raw) => {
    const tag = String(raw || '').toLowerCase();
    if (tag === 'brain') return 'brain';
    // Legacy agent types for historical data
    if (['scaling', 'performance', 'creative', 'pacing'].includes(tag)) {
      return tag;
    }
    if (tag === 'budget') return 'scaling';
    if (['unified_policy', 'unified'].includes(tag)) return 'scaling';
    return tag || 'unknown';
  };

  // Prefer stored agent_type field, fallback to parsing reasoning for legacy entries
  if (actionLog.agent_type) return normalize(actionLog.agent_type);
  const match = String(actionLog.reasoning || '').match(/^\[(\w+)\]/);
  return normalize(match?.[1] || '');
}

module.exports = router;
