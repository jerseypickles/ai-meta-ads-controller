const express = require('express');
const router = express.Router();
const ActionLog = require('../../db/models/ActionLog');
const AgentReport = require('../../db/models/AgentReport');
const AICreation = require('../../db/models/AICreation');
const StrategicDirective = require('../../db/models/StrategicDirective');
const SafetyEvent = require('../../db/models/SafetyEvent');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CreativeAsset = require('../../db/models/CreativeAsset');
const { getMetaClient } = require('../../meta/client');
const { parseInsightRow, getTimeRanges, parseBudget } = require('../../meta/helpers');
const logger = require('../../utils/logger');

/**
 * GET /api/ai-ops/status
 * Complete operational visibility: AI Manager + Brain + Directives + Ads/Creatives + Timeline
 * Optimized: batch queries, parallel execution, limits
 */
router.get('/status', async (req, res) => {
  try {
    const now = new Date();
    const last48h = new Date(now - 48 * 60 * 60 * 1000);
    const last72h = new Date(now - 72 * 60 * 60 * 1000);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // ═══ PHASE 1: All top-level queries in parallel ═══
    const [
      managedCreations,
      recentDead,
      latestBrainReport,
      activeDirectives,
      aiManagerActions,
      safetyEvents
    ] = await Promise.all([
      AICreation.find({
        creation_type: 'create_adset',
        managed_by_ai: true
      }).sort({ created_at: -1 }).lean(),

      AICreation.find({
        creation_type: 'create_adset',
        lifecycle_phase: 'dead',
        updated_at: { $gte: last7d }
      }).sort({ updated_at: -1 }).limit(10).lean(),

      AgentReport.findOne({
        agent_type: 'brain'
      }).sort({ created_at: -1 }).lean(),

      StrategicDirective.find({
        status: 'active',
        expires_at: { $gt: now },
        source_insight_type: 'brain_supervision'
      }).sort({ created_at: -1 }).lean(),

      ActionLog.find({
        agent_type: 'ai_manager',
        created_at: { $gte: last48h }
      }).sort({ created_at: -1 }).limit(50).lean(),

      SafetyEvent.find({
        created_at: { $gte: last48h }
      }).sort({ created_at: -1 }).limit(10).lean()
    ]);

    // Merge managed + recent dead (dedup)
    const allManaged = [...managedCreations, ...recentDead.filter(d =>
      !managedCreations.some(m => m.meta_entity_id === d.meta_entity_id)
    )];

    // Collect all adset IDs and all possible creative asset IDs
    const allAdSetIds = allManaged.map(c => c.meta_entity_id).filter(Boolean);
    const allCreativeAssetIds = [];
    for (const c of allManaged) {
      if (c.selected_creative_ids) {
        allCreativeAssetIds.push(...c.selected_creative_ids.filter(Boolean));
      }
    }

    // ═══ PHASE 2: Batch queries for all ad sets at once ═══
    const [
      allAdSetSnaps,
      allAdSnaps,
      allCreativeAssets,
      allDirectives,
      allActions
    ] = await Promise.all([
      // One query for ALL adset snapshots (latest per adset)
      MetricSnapshot.aggregate([
        { $match: { entity_type: 'adset', entity_id: { $in: allAdSetIds } } },
        { $sort: { snapshot_at: -1 } },
        { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } }
      ]),

      // One query for ALL ad snapshots (latest per ad, across all adsets)
      MetricSnapshot.aggregate([
        { $match: { entity_type: 'ad', parent_id: { $in: allAdSetIds } } },
        { $sort: { snapshot_at: -1 } },
        { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } }
      ]),

      // One query for ALL creative assets
      allCreativeAssetIds.length > 0
        ? CreativeAsset.find({ _id: { $in: allCreativeAssetIds } }).lean()
        : Promise.resolve([]),

      // One query for ALL directives across all adsets
      StrategicDirective.find({
        entity_id: { $in: allAdSetIds },
        source_insight_type: 'brain_supervision',
        created_at: { $gte: last72h }
      }).sort({ created_at: -1 }).lean(),

      // One query for ALL actions across all adsets
      ActionLog.find({
        entity_id: { $in: allAdSetIds },
        agent_type: 'ai_manager',
        created_at: { $gte: last7d }
      }).sort({ created_at: -1 }).lean()
    ]);

    // ═══ Build lookup maps for O(1) access ═══
    const adSetSnapMap = new Map();
    for (const row of allAdSetSnaps) {
      adSetSnapMap.set(row._id, row.doc);
    }

    const adSnapsByParent = new Map();
    for (const row of allAdSnaps) {
      const ad = row.doc;
      if (!adSnapsByParent.has(ad.parent_id)) adSnapsByParent.set(ad.parent_id, []);
      adSnapsByParent.get(ad.parent_id).push(ad);
    }

    const creativeMap = new Map();
    for (const asset of allCreativeAssets) {
      creativeMap.set(asset._id.toString(), asset);
    }

    const directivesByEntity = new Map();
    for (const d of allDirectives) {
      if (!directivesByEntity.has(d.entity_id)) directivesByEntity.set(d.entity_id, []);
      directivesByEntity.get(d.entity_id).push(d);
    }

    const actionsByEntity = new Map();
    for (const a of allActions) {
      if (!actionsByEntity.has(a.entity_id)) actionsByEntity.set(a.entity_id, []);
      actionsByEntity.get(a.entity_id).push(a);
    }

    // ═══ PHASE 3: Build adsets response (no more DB queries) ═══
    const adSets = allManaged.map(creation => {
      const adSetId = creation.meta_entity_id;
      const adSetSnap = adSetSnapMap.get(adSetId);

      const m7 = adSetSnap?.metrics?.last_7d || {};
      const m3 = adSetSnap?.metrics?.last_3d || {};
      const mToday = adSetSnap?.metrics?.today || {};

      // Build ads from pre-fetched snapshots
      const adSnaps = adSnapsByParent.get(adSetId) || [];
      const ads = adSnaps.map(adSnap => {
        const am7 = adSnap.metrics?.last_7d || {};

        // Match creative asset from pre-fetched map
        const adIndex = (creation.child_ad_ids || []).indexOf(adSnap.entity_id);
        const assetId = adIndex >= 0 ? (creation.selected_creative_ids || [])[adIndex] : null;
        let creative = null;
        if (assetId) {
          const asset = creativeMap.get(assetId.toString());
          if (asset) {
            creative = {
              id: asset._id.toString(),
              filename: asset.filename,
              style: asset.style,
              headline: asset.headline || asset.original_name,
              ad_format: asset.ad_format || 'unknown'
            };
          }
        }

        return {
          ad_id: adSnap.entity_id,
          ad_name: adSnap.entity_name,
          status: adSnap.status,
          metrics_7d: {
            spend: am7.spend || 0,
            roas: am7.roas || 0,
            purchases: am7.purchases || 0,
            ctr: am7.ctr || 0,
            frequency: am7.frequency || 0,
            impressions: am7.impressions || 0
          },
          creative
        };
      });

      // Get directives and actions from pre-fetched maps
      const directives = (directivesByEntity.get(adSetId) || []).slice(0, 20);
      const actions = (actionsByEntity.get(adSetId) || []).slice(0, 10);

      return {
        adset_id: adSetId,
        adset_name: creation.meta_entity_name,
        phase: creation.lifecycle_phase,
        status: creation.current_status,
        verdict: creation.verdict,
        budget: creation.current_budget || creation.initial_budget,
        initial_budget: creation.initial_budget,
        days_active: Math.round((now - new Date(creation.created_at)) / (1000 * 60 * 60 * 24) * 10) / 10,
        created_at: creation.created_at,
        last_manager_check: creation.last_manager_check,
        last_assessment: creation.last_manager_assessment || '',
        metrics_7d: {
          spend: m7.spend || 0,
          roas: m7.roas || 0,
          purchases: m7.purchases || 0,
          ctr: m7.ctr || 0,
          frequency: m7.frequency || 0,
          cpa: m7.cpa || 0,
          impressions: m7.impressions || 0
        },
        metrics_3d: {
          spend: m3.spend || 0,
          roas: m3.roas || 0,
          purchases: m3.purchases || 0,
          frequency: m3.frequency || 0
        },
        metrics_today: {
          spend: mToday.spend || 0,
          roas: mToday.roas || 0,
          purchases: mToday.purchases || 0
        },
        snapshot_age_min: adSetSnap ? Math.round((now - new Date(adSetSnap.snapshot_at)) / 60000) : null,
        ads,
        directives: directives.map(d => ({
          type: d.directive_type,
          target_action: d.target_action,
          reason: d.reason,
          reason_category: d.reason_category || 'other',
          urgency: d.urgency_level || 'medium',
          confidence: d.confidence,
          consecutive_count: d.consecutive_count || 1,
          supporting_metrics: d.supporting_metrics || {},
          suggested_actions: d.suggested_actions || [],
          status: d.status,
          created_at: d.created_at,
          hours_ago: Math.round((now - new Date(d.created_at)) / (60 * 60 * 1000))
        })),
        recent_actions: actions.map(a => ({
          action: a.action,
          before: a.before_value,
          after: a.after_value,
          change_pct: a.change_percent,
          reasoning: a.reasoning,
          success: a.success,
          created_at: a.created_at,
          hours_ago: Math.round((now - new Date(a.created_at)) / (60 * 60 * 1000))
        }))
      };
    });

    // ═══ Brain info ═══
    const brainInfo = latestBrainReport ? {
      cycle_id: latestBrainReport.cycle_id,
      ran_at: latestBrainReport.created_at,
      minutes_ago: Math.round((now - new Date(latestBrainReport.created_at)) / 60000),
      status: latestBrainReport.status,
      recommendations_count: (latestBrainReport.recommendations || []).length,
      alerts: latestBrainReport.alerts || [],
      summary: latestBrainReport.summary
    } : null;

    // ═══ Directive summary ═══
    const directiveSummary = {
      total_active: activeDirectives.length,
      by_type: {},
      by_urgency: { critical: 0, high: 0, medium: 0, low: 0 },
      by_category: {}
    };
    for (const d of activeDirectives) {
      directiveSummary.by_type[d.directive_type] = (directiveSummary.by_type[d.directive_type] || 0) + 1;
      directiveSummary.by_urgency[d.urgency_level || 'medium']++;
      const cat = d.reason_category || 'other';
      directiveSummary.by_category[cat] = (directiveSummary.by_category[cat] || 0) + 1;
    }

    // ═══ Decision tree events (filter from already-fetched actions) ═══
    const decisionTreeActions = aiManagerActions.filter(a =>
      /DECISION-TREE/i.test(a.reasoning || '')
    );
    // Also check 7d actions
    const dtFrom7d = allActions ? [...new Map([...allActions].filter(a =>
      /DECISION-TREE/i.test(a.reasoning || '')
    ).map(a => [a._id.toString(), a])).values()] : [];
    const allDTActions = [...decisionTreeActions];
    for (const dt of dtFrom7d) {
      if (!allDTActions.some(a => a._id.toString() === dt._id.toString())) {
        allDTActions.push(dt);
      }
    }
    allDTActions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // ═══ Compliance ═══
    const directiveEntities = new Map();
    for (const d of activeDirectives) {
      if (!directiveEntities.has(d.entity_id)) directiveEntities.set(d.entity_id, []);
      directiveEntities.get(d.entity_id).push(d);
    }

    let actedOn = 0;
    let ignored = 0;
    for (const [entityId, dirs] of directiveEntities) {
      const hasAction = aiManagerActions.some(a => a.entity_id === entityId);
      const hasApplied = dirs.some(d => d.status === 'applied' || d.applied_count > 0);
      if (hasAction || hasApplied) actedOn++;
      else ignored++;
    }
    const complianceRate = directiveEntities.size > 0
      ? Math.round((actedOn / directiveEntities.size) * 100) : 100;

    // ═══ Timeline (built from already-fetched data, no extra queries) ═══
    const timeline = [];

    for (const a of aiManagerActions.slice(0, 30)) {
      const isDecisionTree = /DECISION-TREE/i.test(a.reasoning || '');
      timeline.push({
        type: isDecisionTree ? 'decision_tree' : 'ai_manager_action',
        timestamp: a.created_at,
        entity_name: a.entity_name || a.entity_id,
        entity_id: a.entity_id,
        action: a.action,
        detail: a.reasoning || '',
        change: a.change_percent ? `${a.change_percent > 0 ? '+' : ''}${a.change_percent}%` : null,
        before: a.before_value,
        after: a.after_value,
        success: a.success
      });
    }

    for (const d of activeDirectives.slice(0, 20)) {
      timeline.push({
        type: 'brain_directive',
        timestamp: d.created_at,
        entity_name: d.entity_name || d.entity_id,
        entity_id: d.entity_id,
        action: `${d.directive_type}/${d.target_action}`,
        detail: d.reason,
        urgency: d.urgency_level || 'medium',
        category: d.reason_category || 'other',
        consecutive: d.consecutive_count || 1
      });
    }

    for (const s of safetyEvents) {
      timeline.push({
        type: 'safety_event',
        timestamp: s.created_at,
        entity_name: s.entity_name || s.entity_id || 'System',
        entity_id: s.entity_id || '',
        action: s.event_type || 'unknown',
        detail: s.description || (typeof s.details === 'string' ? s.details : '') || ''
      });
    }

    timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // ═══ AI Manager last run ═══
    const lastManagerRun = managedCreations.length > 0
      ? managedCreations.reduce((latest, c) => {
          const check = c.last_manager_check ? new Date(c.last_manager_check) : new Date(0);
          return check > latest ? check : latest;
        }, new Date(0))
      : null;

    res.json({
      ai_manager: {
        last_run: lastManagerRun && lastManagerRun.getTime() > 0 ? lastManagerRun : null,
        minutes_since_last_run: lastManagerRun && lastManagerRun.getTime() > 0
          ? Math.round((now - lastManagerRun) / 60000) : null,
        managed_count: managedCreations.length,
        actions_48h: aiManagerActions.length,
        decision_tree_events_7d: allDTActions.length
      },
      brain: brainInfo,
      compliance: {
        rate: complianceRate,
        total_entities: directiveEntities.size,
        acted_on: actedOn,
        ignored
      },
      directive_summary: directiveSummary,
      adsets: adSets,
      decision_tree_events: allDTActions.slice(0, 20).map(a => ({
        action: a.action,
        entity_name: a.entity_name || a.entity_id,
        entity_id: a.entity_id,
        reasoning: a.reasoning,
        before: a.before_value,
        after: a.after_value,
        change_pct: a.change_percent,
        created_at: a.created_at,
        hours_ago: Math.round((now - new Date(a.created_at)) / (60 * 60 * 1000))
      })),
      timeline: timeline.slice(0, 60)
    });
  } catch (error) {
    logger.error(`[AI-OPS] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Recolecta métricas de Meta API para todos los ad sets AI-managed,
 * sin importar su status (ACTIVE, PAUSED, DELETED, ARCHIVED).
 * Usada tanto por el endpoint POST /refresh como por el CRON job.
 */
async function refreshAIOpsMetrics() {
  const startTime = Date.now();
  const meta = getMetaClient();
  const timeRanges = getTimeRanges();

  // 1. Obtener todos los ad sets AI-managed (cualquier status)
  const managedCreations = await AICreation.find({
    creation_type: 'create_adset',
    managed_by_ai: true,
    meta_entity_id: { $exists: true, $ne: null }
  }).lean();

  // Incluir dead recientes (7 días)
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentDead = await AICreation.find({
    creation_type: 'create_adset',
    lifecycle_phase: 'dead',
    updated_at: { $gte: last7d },
    meta_entity_id: { $exists: true, $ne: null }
  }).lean();

  // Dedup
  const allCreations = [...managedCreations];
  for (const d of recentDead) {
    if (!allCreations.some(m => m.meta_entity_id === d.meta_entity_id)) {
      allCreations.push(d);
    }
  }

  const adSetIds = allCreations.map(c => c.meta_entity_id).filter(Boolean);

  if (adSetIds.length === 0) {
    return { success: true, message: 'No hay ad sets AI-managed', refreshed_adsets: 0, refreshed_ads: 0 };
  }

  logger.info(`[AI-OPS REFRESH] Refrescando métricas de ${adSetIds.length} ad sets AI-managed...`);

  // 2. Obtener insights directamente desde Meta API
  const adSetInsights = {};
  const adInsights = {};

  for (const [window, range] of Object.entries(timeRanges)) {
    const adSetRows = await meta.getAccountInsights('adset', range);
    for (const row of adSetRows) {
      if (!adSetIds.includes(row.adset_id)) continue;
      if (!adSetInsights[row.adset_id]) adSetInsights[row.adset_id] = {};
      adSetInsights[row.adset_id][window] = parseInsightRow(row);
    }

    const adRows = await meta.getAccountInsights('ad', range);
    for (const row of adRows) {
      if (!row.ad_id || !adSetIds.includes(row.adset_id)) continue;
      if (!adInsights[row.ad_id]) {
        adInsights[row.ad_id] = {
          ad_name: row.ad_name || 'Sin nombre',
          adset_id: row.adset_id,
          campaign_id: row.campaign_id
        };
      }
      adInsights[row.ad_id][window] = parseInsightRow(row);
    }
  }

  // 3. Obtener info actual de ad sets desde Meta (status, budget, campaign_id)
  const adSetInfoMap = {};
  for (const adSetId of adSetIds) {
    try {
      const data = await meta.get(`/${adSetId}`, {
        fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,campaign_id'
      });
      adSetInfoMap[adSetId] = data;
    } catch (err) {
      logger.debug(`[AI-OPS REFRESH] No se pudo obtener info de ad set ${adSetId}: ${err.message}`);
    }
  }

  // 4. Obtener status real de ads (solo ad sets que existen en Meta)
  const adStatusMap = {};
  for (const adSetId of adSetIds) {
    if (!adSetInfoMap[adSetId]) continue;
    try {
      const adsData = await meta.get(`/${adSetId}/ads`, {
        fields: 'id,effective_status',
        limit: 200
      });
      for (const ad of (adsData.data || [])) {
        adStatusMap[ad.id] = ad.effective_status || 'ACTIVE';
      }
    } catch (err) {
      // Ad set podría no tener ads — ignorar
    }
  }

  // Helper: normalizar status al enum de MetricSnapshot
  const VALID_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'];
  const normalizeStatus = (s) => VALID_STATUSES.includes(s) ? s : 'PAUSED';

  const emptyMetrics = {
    spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
    purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
  };

  // 5. Crear snapshots de ad sets
  let adSetSnapshots = 0;
  for (const adSetId of adSetIds) {
    const info = adSetInfoMap[adSetId];
    const creation = allCreations.find(c => c.meta_entity_id === adSetId);

    const campaignId = info?.campaign_id || null;
    if (!campaignId) {
      logger.debug(`[AI-OPS REFRESH] Skipping ad set ${adSetId} — no campaign_id available`);
      continue;
    }

    const metrics = {};
    for (const window of Object.keys(timeRanges)) {
      metrics[window] = adSetInsights[adSetId]?.[window] || { ...emptyMetrics };
    }

    await MetricSnapshot.create({
      entity_type: 'adset',
      entity_id: adSetId,
      entity_name: info?.name || creation?.meta_entity_name || adSetId,
      parent_id: campaignId,
      campaign_id: campaignId,
      status: normalizeStatus(info?.effective_status || creation?.current_status),
      daily_budget: parseBudget(info?.daily_budget) || creation?.current_budget || 0,
      lifetime_budget: parseBudget(info?.lifetime_budget) || 0,
      budget_remaining: parseBudget(info?.budget_remaining) || 0,
      metrics,
      snapshot_at: new Date()
    });
    adSetSnapshots++;
  }

  // 6. Crear snapshots de ads
  let adSnapshots = 0;
  for (const [adId, adData] of Object.entries(adInsights)) {
    if (!adData.campaign_id) continue;

    const metrics = {};
    for (const window of Object.keys(timeRanges)) {
      metrics[window] = adData[window] || { ...emptyMetrics };
    }

    await MetricSnapshot.create({
      entity_type: 'ad',
      entity_id: adId,
      entity_name: adData.ad_name,
      parent_id: adData.adset_id,
      campaign_id: adData.campaign_id,
      status: normalizeStatus(adStatusMap[adId]),
      metrics,
      snapshot_at: new Date()
    });
    adSnapshots++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[AI-OPS REFRESH] Completado en ${elapsed}s — ${adSetSnapshots} ad sets, ${adSnapshots} ads actualizados`);

  return { success: true, refreshed_adsets: adSetSnapshots, refreshed_ads: adSnapshots, elapsed: `${elapsed}s` };
}

/**
 * POST /api/ai-ops/refresh
 * Fuerza la recolección de métricas desde Meta API para ad sets AI-managed.
 */
router.post('/refresh', async (req, res) => {
  try {
    const result = await refreshAIOpsMetrics();
    res.json(result);
  } catch (error) {
    logger.error(`[AI-OPS REFRESH] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.refreshAIOpsMetrics = refreshAIOpsMetrics;
