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

// In-memory store for background refresh jobs
const refreshJobs = new Map();
const REFRESH_JOB_TTL = 10 * 60 * 1000; // 10 minutes

// Tracking del último refresh exitoso (in-memory, se pierde al reiniciar)
let _lastRefreshInfo = { at: null, adsets: 0, ads: 0, elapsed: null, source: null };
// Mutex para evitar refresh concurrentes
let _refreshInProgress = false;
const STALE_THRESHOLD_MIN = 20; // Datos se consideran stale después de 20 minutos

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

      // One query for ALL ad snapshots (latest per ad, only ACTIVE/PAUSED — exclude DELETED/ARCHIVED)
      MetricSnapshot.aggregate([
        { $match: { entity_type: 'ad', parent_id: { $in: allAdSetIds } } },
        { $sort: { snapshot_at: -1 } },
        { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
        { $match: { 'doc.status': { $in: ['ACTIVE', 'PAUSED'] } } }
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

      // Build ads from pre-fetched snapshots (only operational — exclude DELETED/ARCHIVED)
      const adSnaps = (adSnapsByParent.get(adSetId) || []).filter(adSnap =>
        adSnap.status === 'ACTIVE' || adSnap.status === 'PAUSED'
      );
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
        status: adSetSnap?.status || creation.current_status,
        verdict: creation.verdict,
        budget: adSetSnap?.daily_budget || creation.current_budget || creation.initial_budget,
        initial_budget: creation.initial_budget,
        days_active: Math.round((now - new Date(creation.created_at)) / (1000 * 60 * 60 * 24) * 10) / 10,
        created_at: creation.created_at,
        last_manager_check: creation.last_manager_check,
        last_assessment: creation.last_manager_assessment || '',
        creative_health: creation.last_manager_creative_health || '',
        needs_new_creatives: creation.last_manager_needs_new_creatives || false,
        creative_rotation_needed: creation.last_manager_creative_rotation_needed || false,
        suggested_styles: creation.last_manager_suggested_styles || [],
        frequency_detail: creation.last_manager_frequency_detail || '',
        frequency_status: creation.last_manager_frequency_status || 'unknown',
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

    // Calcular edad del snapshot más viejo entre todos los ad sets
    const oldestSnapshotAge = adSets.reduce((max, as) => {
      return as.snapshot_age_min !== null && as.snapshot_age_min > max ? as.snapshot_age_min : max;
    }, 0);

    res.json({
      ai_manager: {
        last_run: lastManagerRun && lastManagerRun.getTime() > 0 ? lastManagerRun : null,
        minutes_since_last_run: lastManagerRun && lastManagerRun.getTime() > 0
          ? Math.round((now - lastManagerRun) / 60000) : null,
        managed_count: managedCreations.length,
        actions_48h: aiManagerActions.length,
        decision_tree_events_7d: allDTActions.length
      },
      data_freshness: {
        last_refresh: _lastRefreshInfo.at,
        minutes_since_refresh: _lastRefreshInfo.at
          ? Math.round((now - new Date(_lastRefreshInfo.at)) / 60000) : null,
        oldest_snapshot_age_min: oldestSnapshotAge,
        is_stale: oldestSnapshotAge > STALE_THRESHOLD_MIN,
        refresh_in_progress: _refreshInProgress,
        source: _lastRefreshInfo.source
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
  const adSetsFetchedOk = new Set(); // Track which ad sets had successful API calls
  for (const adSetId of adSetIds) {
    if (!adSetInfoMap[adSetId]) continue;
    try {
      const adsData = await meta.get(`/${adSetId}/ads`, {
        fields: 'id,effective_status',
        limit: 200
      });
      adSetsFetchedOk.add(adSetId); // Mark this ad set as successfully fetched
      for (const ad of (adsData.data || [])) {
        adStatusMap[ad.id] = ad.effective_status || 'ACTIVE';
      }
    } catch (err) {
      // API call failed — do NOT mark ads as DELETED, keep existing status
      logger.warn(`[AI-OPS REFRESH] GET /${adSetId}/ads failed: ${err.message} — preserving existing status`);
    }
  }

  // Helper: normalizar status al enum de MetricSnapshot
  const VALID_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'];
  const normalizeStatus = (s) => VALID_STATUSES.includes(s) ? s : 'DELETED';

  const emptyMetrics = {
    spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
    purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
  };

  // 5. Sincronizar AICreation.current_status con el status real de Meta
  for (const adSetId of adSetIds) {
    const info = adSetInfoMap[adSetId];
    if (!info?.effective_status) continue;

    const creation = allCreations.find(c => c.meta_entity_id === adSetId);
    if (creation && creation.current_status !== info.effective_status) {
      await AICreation.updateOne(
        { _id: creation._id },
        { current_status: info.effective_status, updated_at: new Date() }
      );
      logger.debug(`[AI-OPS REFRESH] Status sync: ${adSetId} ${creation.current_status} → ${info.effective_status}`);
    }
  }

  // 7. Crear snapshots de ad sets
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

  // 8. Crear snapshots de ads
  // Only mark ads as DELETED when we SUCCESSFULLY fetched ads for their ad set
  // and the ad was missing from the response. If the API call failed, keep existing status.
  let adSnapshots = 0;
  for (const [adId, adData] of Object.entries(adInsights)) {
    if (!adData.campaign_id) continue;

    let adStatus;
    if (adStatusMap[adId]) {
      // Ad found in Meta — use real status
      adStatus = adStatusMap[adId];
    } else if (adSetsFetchedOk.has(adData.adset_id)) {
      // API call succeeded for this ad set but ad was NOT in the response — it's deleted
      adStatus = 'DELETED';
    } else {
      // API call failed for this ad set — we don't know the real status, skip snapshot
      // (let the existing snapshot remain as-is)
      continue;
    }

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
      status: normalizeStatus(adStatus),
      metrics,
      snapshot_at: new Date()
    });
    if (adStatus !== 'DELETED' && adStatus !== 'ARCHIVED') adSnapshots++;
  }

  // También crear snapshots DELETED para ads conocidos que no tienen insights
  // (ads que fueron borrados y ya no generan insights)
  // ONLY for ad sets where we successfully fetched ads from Meta
  for (const adSetId of adSetIds) {
    // Skip if we couldn't fetch ads for this ad set — we don't know what's deleted
    if (!adSetsFetchedOk.has(adSetId)) continue;
    const creation = allCreations.find(c => c.meta_entity_id === adSetId);
    if (!creation?.child_ad_ids) continue;
    for (const childAdId of creation.child_ad_ids) {
      // Si ya tiene insights, ya se procesó arriba
      if (adInsights[childAdId]) continue;
      // Si existe en Meta (tiene status), no está borrado
      if (adStatusMap[childAdId]) continue;
      // API call succeeded AND ad is missing — it's genuinely deleted
      const existingSnap = await MetricSnapshot.findOne({
        entity_type: 'ad', entity_id: childAdId
      }).sort({ snapshot_at: -1 }).lean();
      if (existingSnap && existingSnap.status !== 'DELETED') {
        await MetricSnapshot.create({
          entity_type: 'ad',
          entity_id: childAdId,
          entity_name: existingSnap.entity_name || childAdId,
          parent_id: adSetId,
          campaign_id: existingSnap.campaign_id || '',
          status: 'DELETED',
          metrics: { today: { ...emptyMetrics }, last_3d: { ...emptyMetrics }, last_7d: { ...emptyMetrics } },
          snapshot_at: new Date()
        });
        logger.debug(`[AI-OPS REFRESH] Marked ad ${childAdId} as DELETED (no longer in Meta)`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[AI-OPS REFRESH] Completado en ${elapsed}s — ${adSetSnapshots} ad sets, ${adSnapshots} ads actualizados`);

  // Actualizar tracking del último refresh exitoso
  _lastRefreshInfo = {
    at: new Date(),
    adsets: adSetSnapshots,
    ads: adSnapshots,
    elapsed: `${elapsed}s`,
    source: 'cron'
  };

  return { success: true, refreshed_adsets: adSetSnapshots, refreshed_ads: adSnapshots, elapsed: `${elapsed}s` };
}

/**
 * GET /api/ai-ops/refresh-info
 * Devuelve info del último refresh exitoso y si los datos están stale.
 */
router.get('/refresh-info', async (req, res) => {
  try {
    // Buscar el snapshot más reciente de ad sets AI-managed
    const latestSnap = await MetricSnapshot.findOne({ entity_type: 'adset' })
      .sort({ snapshot_at: -1 })
      .select('snapshot_at')
      .lean();

    const now = new Date();
    const snapAge = latestSnap ? Math.round((now - new Date(latestSnap.snapshot_at)) / 60000) : null;

    res.json({
      last_refresh: _lastRefreshInfo.at,
      minutes_since_refresh: _lastRefreshInfo.at
        ? Math.round((now - new Date(_lastRefreshInfo.at)) / 60000) : null,
      last_adsets: _lastRefreshInfo.adsets,
      last_ads: _lastRefreshInfo.ads,
      last_elapsed: _lastRefreshInfo.elapsed,
      last_source: _lastRefreshInfo.source,
      latest_snapshot_age_min: snapAge,
      is_stale: snapAge === null || snapAge > STALE_THRESHOLD_MIN,
      refresh_in_progress: _refreshInProgress
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai-ops/auto-refresh
 * Refresh inteligente: solo ejecuta si los datos tienen más de STALE_THRESHOLD_MIN.
 * Evita refresh concurrentes con mutex.
 * Diseñado para ser llamado por el frontend al cargar la página.
 */
router.post('/auto-refresh', async (req, res) => {
  try {
    // Si ya hay un refresh en progreso, retornar sin duplicar
    if (_refreshInProgress) {
      return res.json({
        success: true,
        action: 'skipped',
        reason: 'Refresh ya en progreso'
      });
    }

    // Verificar si los datos están stale
    const latestSnap = await MetricSnapshot.findOne({ entity_type: 'adset' })
      .sort({ snapshot_at: -1 })
      .select('snapshot_at')
      .lean();

    const now = new Date();
    const snapAge = latestSnap ? Math.round((now - new Date(latestSnap.snapshot_at)) / 60000) : Infinity;

    if (snapAge <= STALE_THRESHOLD_MIN) {
      return res.json({
        success: true,
        action: 'skipped',
        reason: `Datos frescos (${snapAge} min)`,
        snapshot_age_min: snapAge
      });
    }

    // Datos stale — ejecutar refresh en background
    _refreshInProgress = true;
    const jobId = `aiops_auto_${Date.now()}`;
    refreshJobs.set(jobId, { status: 'running', startedAt: Date.now(), result: null, error: null });

    res.json({
      success: true,
      action: 'refreshing',
      async: true,
      job_id: jobId,
      reason: `Datos stale (${snapAge === Infinity ? '∞' : snapAge} min)`,
      snapshot_age_min: snapAge
    });

    // Ejecutar en background
    (async () => {
      const result = await refreshAIOpsMetrics();
      _lastRefreshInfo.source = 'auto-refresh';
      refreshJobs.set(jobId, {
        status: 'completed',
        startedAt: refreshJobs.get(jobId)?.startedAt,
        result,
        error: null
      });
      logger.info(`[AI-OPS AUTO-REFRESH] Completado — ${result.refreshed_adsets} ad sets, ${result.refreshed_ads} ads`);
    })().catch(error => {
      logger.error(`[AI-OPS AUTO-REFRESH] Error: ${error.message}`);
      refreshJobs.set(jobId, {
        status: 'failed',
        startedAt: refreshJobs.get(jobId)?.startedAt,
        result: null,
        error: error.message
      });
    }).finally(() => {
      _refreshInProgress = false;
      setTimeout(() => refreshJobs.delete(jobId), REFRESH_JOB_TTL);
    });
  } catch (error) {
    _refreshInProgress = false;
    logger.error(`[AI-OPS AUTO-REFRESH] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai-ops/refresh
 * Fuerza la recolección de métricas desde Meta API (background + polling).
 */
router.post('/refresh', async (req, res) => {
  try {
    if (_refreshInProgress) {
      return res.json({ success: true, async: false, message: 'Refresh ya en progreso, espera a que termine' });
    }

    _refreshInProgress = true;
    const jobId = `aiops_refresh_${Date.now()}`;
    refreshJobs.set(jobId, { status: 'running', startedAt: Date.now(), result: null, error: null });

    // Respond immediately
    res.json({ success: true, async: true, job_id: jobId, message: 'Refresh de métricas iniciado en background' });

    // Execute in background
    (async () => {
      const result = await refreshAIOpsMetrics();
      _lastRefreshInfo.source = 'manual';
      refreshJobs.set(jobId, {
        status: 'completed',
        startedAt: refreshJobs.get(jobId)?.startedAt,
        result,
        error: null
      });
      logger.info(`[AI-OPS REFRESH] Completado — job ${jobId}`);
    })().catch(error => {
      logger.error(`[AI-OPS REFRESH] Error: ${error.message}`);
      refreshJobs.set(jobId, {
        status: 'failed',
        startedAt: refreshJobs.get(jobId)?.startedAt,
        result: null,
        error: error.message
      });
    }).finally(() => {
      _refreshInProgress = false;
      setTimeout(() => refreshJobs.delete(jobId), REFRESH_JOB_TTL);
    });
  } catch (error) {
    logger.error(`[AI-OPS REFRESH] Error iniciando refresh: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-ops/refresh-status/:jobId
 * Poll status of background refresh job.
 */
router.get('/refresh-status/:jobId', async (req, res) => {
  const job = refreshJobs.get(req.params.jobId);
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

// ═══ ADD AD TO EXISTING AD SET ═══

/**
 * GET /api/ai-ops/available-creatives/:adsetId
 * Returns creative assets available to add to this ad set (same product, unused preferred)
 */
router.get('/available-creatives/:adsetId', async (req, res) => {
  try {
    const creation = await AICreation.findOne({ meta_entity_id: req.params.adsetId }).lean();
    if (!creation) return res.status(404).json({ error: 'Ad set no encontrado' });

    // Get all active ad-ready images
    const allAssets = await CreativeAsset.find({
      status: 'active',
      purpose: 'ad-ready',
      media_type: 'image',
      ad_format: { $ne: 'stories' }
    }).sort({ times_used: 1, created_at: -1 }).lean();

    // Find assets already used in this ad set
    const usedInThisAdSet = new Set(
      (creation.selected_creative_ids || []).map(id => id.toString())
    );

    // Enrich assets with availability info
    const enriched = allAssets.map(a => ({
      _id: a._id,
      filename: a.filename,
      original_name: a.original_name,
      file_path: a.file_path,
      style: a.style,
      product_name: a.product_name || '',
      product_line: a.product_line || '',
      flavor: a.flavor || '',
      times_used: a.times_used || 0,
      headline: a.headline || '',
      body: a.body || '',
      cta: a.cta || 'SHOP_NOW',
      link_url: a.link_url || '',
      meta_image_hash: a.meta_image_hash || null,
      uploaded_to_meta: a.uploaded_to_meta || false,
      paired_asset_id: a.paired_asset_id || null,
      avg_roas: a.avg_roas || 0,
      avg_ctr: a.avg_ctr || 0,
      already_in_adset: usedInThisAdSet.has(a._id.toString()),
      scene_label: a.scene_label || '',
      tags: a.tags || []
    }));

    // Sort: not-in-adset first, then by times_used ascending
    enriched.sort((a, b) => {
      if (a.already_in_adset !== b.already_in_adset) return a.already_in_adset ? 1 : -1;
      return (a.times_used || 0) - (b.times_used || 0);
    });

    res.json({
      adset_id: req.params.adsetId,
      adset_name: creation.meta_entity_name,
      product_name: creation.product_name || '',
      assets: enriched
    });
  } catch (err) {
    logger.error(`[AI-OPS] Error fetching creatives for ${req.params.adsetId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai-ops/add-ad
 * Creates an ad in an existing ad set:
 *   1. If asset not uploaded to Meta, uploads it
 *   2. Claude generates headline + primary_text
 *   3. Creates ad creative + ad in Meta (ACTIVE)
 *   4. Updates asset tracking + AICreation
 */
const addAdJobs = new Map();

router.post('/add-ad', async (req, res) => {
  const { adset_id, asset_id, custom_headline, custom_body } = req.body;
  if (!adset_id || !asset_id) {
    return res.status(400).json({ error: 'adset_id y asset_id requeridos' });
  }

  const jobId = `addad_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  addAdJobs.set(jobId, { status: 'running', startedAt: Date.now() });

  // Clean old jobs
  for (const [id, job] of addAdJobs) {
    if (Date.now() - job.startedAt > REFRESH_JOB_TTL) addAdJobs.delete(id);
  }

  res.json({ job_id: jobId, status: 'running' });

  // Background execution
  (async () => {
    try {
      const meta = getMetaClient();
      const creation = await AICreation.findOne({ meta_entity_id: adset_id });
      if (!creation) throw new Error('Ad set no encontrado en AICreation');

      const asset = await CreativeAsset.findById(asset_id);
      if (!asset) throw new Error('Creative asset no encontrado');

      // Step 1: Upload to Meta if needed
      if (!asset.uploaded_to_meta || !asset.meta_image_hash) {
        logger.info(`[AI-OPS] Uploading asset ${asset.original_name} to Meta...`);
        const upload = await meta.uploadImage(asset.file_path);
        asset.meta_image_hash = upload.image_hash;
        asset.uploaded_to_meta = true;
        asset.uploaded_at = new Date();
        await asset.save();
      }

      // Step 2: Generate copy with Claude (or use custom)
      let headlines, bodies;
      if (custom_headline && custom_body) {
        headlines = [custom_headline];
        bodies = [custom_body];
      } else {
        const generated = await _generateAdCopy(asset, creation);
        headlines = generated.headlines;
        bodies = generated.bodies;
      }

      // Step 3: Get page_id and website URL
      const pageId = await meta.getPageId();
      const websiteUrl = await meta.getWebsiteUrl();

      // Step 4: Create ads (one per headline/body variant)
      const createdAds = [];
      const variantCount = Math.max(headlines.length, 1);
      for (let v = 0; v < variantCount; v++) {
        const headline = headlines[v] || headlines[0];
        const body = bodies[v] || bodies[0] || '';
        const variantLabel = variantCount > 1 ? ` v${v + 1}` : '';

        try {
          const creative = await meta.createAdCreative({
            page_id: pageId,
            image_hash: asset.meta_image_hash,
            headline,
            body,
            description: '',
            cta: asset.cta || 'SHOP_NOW',
            link_url: asset.link_url || websiteUrl
          });

          const adName = `${headline} - ${asset.style || 'mix'}${variantLabel} [Feed]`;
          const ad = await meta.createAd(adset_id, creative.creative_id, adName, 'ACTIVE');

          createdAds.push({ ad_id: ad.ad_id, creative_id: creative.creative_id, name: adName, headline, body });
          logger.info(`[AI-OPS] Created ad: ${adName} in ${adset_id}`);
        } catch (adErr) {
          logger.error(`[AI-OPS] Error creating ad variant ${v + 1}: ${adErr.message}`);
        }

        // Also create stories ad if paired asset exists
        if (asset.paired_asset_id) {
          try {
            const pairedAsset = await CreativeAsset.findById(asset.paired_asset_id);
            if (pairedAsset) {
              if (!pairedAsset.uploaded_to_meta || !pairedAsset.meta_image_hash) {
                const pairUpload = await meta.uploadImage(pairedAsset.file_path);
                pairedAsset.meta_image_hash = pairUpload.image_hash;
                pairedAsset.uploaded_to_meta = true;
                pairedAsset.uploaded_at = new Date();
                await pairedAsset.save();
              }

              const storiesCreative = await meta.createAdCreative({
                page_id: pageId,
                image_hash: pairedAsset.meta_image_hash,
                headline,
                body,
                description: '',
                cta: asset.cta || 'SHOP_NOW',
                link_url: asset.link_url || pairedAsset.link_url || websiteUrl
              });

              const storiesAdName = `${headline} - ${asset.style || 'mix'}${variantLabel} [Stories]`;
              const storiesAd = await meta.createAd(adset_id, storiesCreative.creative_id, storiesAdName, 'ACTIVE');
              createdAds.push({ ad_id: storiesAd.ad_id, creative_id: storiesCreative.creative_id, name: storiesAdName, headline, body, placement: 'stories' });
            }
          } catch (pairErr) {
            logger.error(`[AI-OPS] Error creating stories variant: ${pairErr.message}`);
          }
        }
      }

      if (createdAds.length === 0) throw new Error('No se pudo crear ningun ad');

      // Step 5: Update asset tracking
      asset.times_used = (asset.times_used || 0) + 1;
      for (const ad of createdAds) {
        if (!asset.used_in_ads.includes(ad.ad_id)) asset.used_in_ads.push(ad.ad_id);
      }
      if (!asset.used_in_adsets) asset.used_in_adsets = [];
      if (!asset.used_in_adsets.includes(adset_id)) asset.used_in_adsets.push(adset_id);
      await asset.save();

      // Step 6: Update AICreation
      if (!creation.selected_creative_ids) creation.selected_creative_ids = [];
      if (!creation.selected_creative_ids.map(id => id.toString()).includes(asset._id.toString())) {
        creation.selected_creative_ids.push(asset._id);
      }
      for (const ad of createdAds) {
        if (!creation.child_ad_ids) creation.child_ad_ids = [];
        if (!creation.child_ad_ids.includes(ad.ad_id)) creation.child_ad_ids.push(ad.ad_id);
      }
      creation.updated_at = new Date();
      await creation.save();

      // Log action
      await ActionLog.create({
        entity_type: 'adset',
        entity_id: adset_id,
        entity_name: creation.meta_entity_name,
        action: 'add_ad',
        after_value: JSON.stringify(createdAds.map(a => a.ad_id)),
        reasoning: `Manual: added ${createdAds.length} ad(s) from asset "${asset.original_name}" (${asset.style})`,
        agent_type: 'manual',
        confidence: 'high',
        success: true
      });

      addAdJobs.set(jobId, {
        status: 'completed',
        startedAt: addAdJobs.get(jobId).startedAt,
        result: {
          ads_created: createdAds.length,
          ads: createdAds,
          headlines,
          bodies,
          asset_name: asset.original_name
        }
      });
    } catch (err) {
      logger.error(`[AI-OPS] add-ad error: ${err.message}`);
      addAdJobs.set(jobId, {
        status: 'failed',
        startedAt: addAdJobs.get(jobId).startedAt,
        error: err.message
      });
    }
  })();
});

/**
 * POST /api/ai-ops/generate-copy
 * Generates ad copy with Claude for preview (does NOT create the ad).
 * Returns headlines + bodies for user review before committing.
 */
router.post('/generate-copy', async (req, res) => {
  const { adset_id, asset_id } = req.body;
  if (!adset_id || !asset_id) {
    return res.status(400).json({ error: 'adset_id and asset_id required' });
  }

  try {
    const creation = await AICreation.findOne({ meta_entity_id: adset_id }).lean();
    if (!creation) return res.status(404).json({ error: 'Ad set not found' });

    const asset = await CreativeAsset.findById(asset_id).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const generated = await _generateAdCopy(asset, creation);
    res.json({
      success: true,
      headlines: generated.headlines,
      bodies: generated.bodies,
      asset_name: asset.original_name,
      product_name: asset.product_name || creation.product_name || ''
    });
  } catch (err) {
    logger.error(`[AI-OPS] generate-copy error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/add-ad-status/:jobId', (req, res) => {
  const job = addAdJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  if (job.status === 'running') return res.json({ status: 'running', elapsed_seconds: elapsed });
  if (job.status === 'completed') return res.json({ status: 'completed', elapsed_seconds: elapsed, result: job.result });
  return res.json({ status: 'failed', elapsed_seconds: elapsed, error: job.error });
});

/**
 * Generate ad copy (headline + primary text) using Claude
 */
async function _generateAdCopy(asset, creation) {
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('../../../config');
  const client = new Anthropic({ apiKey: config.claude.apiKey });

  const prompt = `You are writing ad copy for a Meta (Facebook/Instagram) ad for the product "${asset.product_name || creation.product_name || 'food product'}".

Creative style: ${asset.style || 'unknown'}
Product: ${asset.product_name || creation.product_name || 'N/A'}
Scene: ${asset.scene_label || 'N/A'}
Tags: ${(asset.tags || []).join(', ') || 'none'}

Generate 3 headline + body (primary text) variants for A/B testing.

Rules:
- Headlines: short, punchy, scroll-stopping. MAX 40 characters. In English for US audience.
- Each headline must be a DIFFERENT angle: benefit, urgency, curiosity, social proof, humor, etc.
- Bodies (primary_text): 2-3 sentences. Hook + benefit + CTA. In English. Different tones per variant.
- This is a food/ecommerce brand — be casual, fun, crave-inducing.
- Match the creative style: ${asset.style === 'ugly-ad' ? 'raw, unpolished, authentic tone' : asset.style === 'ugc' ? 'conversational, first-person, relatable' : asset.style === 'organic' ? 'natural, warm, friendly' : 'clear and direct'}

Return ONLY valid JSON, no markdown:
{
  "headlines": ["Headline 1", "Headline 2", "Headline 3"],
  "bodies": ["Body text 1", "Body text 2", "Body text 3"]
}`;

  try {
    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      headlines: parsed.headlines || ['Fresh & Delicious'],
      bodies: parsed.bodies || ['Try our handcrafted products today!']
    };
  } catch (err) {
    logger.error(`[AI-OPS] Claude copy generation error: ${err.message}`);
    // Fallback — always English, never use bank copy (may be in Spanish)
    const productName = asset.product_name || 'Our Products';
    return {
      headlines: [
        `Try ${productName} Today`,
        `You Need ${productName}`,
        `Discover ${productName}`
      ],
      bodies: [
        `Handcrafted with love and the freshest ingredients. Order now and taste the difference!`,
        `Once you try it, you won't go back. Shop our ${productName.toLowerCase()} today!`,
        `Your new favorite snack is waiting. Get ${productName.toLowerCase()} delivered to your door.`
      ]
    };
  }
}

module.exports = router;
module.exports.refreshAIOpsMetrics = refreshAIOpsMetrics;
