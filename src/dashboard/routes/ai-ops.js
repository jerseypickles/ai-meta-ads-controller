const express = require('express');
const router = express.Router();
const ActionLog = require('../../db/models/ActionLog');
const AgentReport = require('../../db/models/AgentReport');
const AICreation = require('../../db/models/AICreation');
const StrategicDirective = require('../../db/models/StrategicDirective');
const SafetyEvent = require('../../db/models/SafetyEvent');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CreativeAsset = require('../../db/models/CreativeAsset');
const logger = require('../../utils/logger');

/**
 * GET /api/ai-ops/status
 * Complete operational visibility: AI Manager + Brain + Directives + Ads/Creatives + Timeline
 */
router.get('/status', async (req, res) => {
  try {
    const now = new Date();
    const last48h = new Date(now - 48 * 60 * 60 * 1000);
    const last72h = new Date(now - 72 * 60 * 60 * 1000);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // ═══ 1. AI Manager: managed ad sets with full detail ═══
    const managedCreations = await AICreation.find({
      creation_type: 'create_adset',
      managed_by_ai: true
    }).sort({ created_at: -1 }).lean();

    // Also get dead ones from last 7 days for history
    const recentDead = await AICreation.find({
      creation_type: 'create_adset',
      lifecycle_phase: 'dead',
      updated_at: { $gte: last7d }
    }).sort({ updated_at: -1 }).limit(10).lean();

    const allManaged = [...managedCreations, ...recentDead.filter(d =>
      !managedCreations.some(m => m.meta_entity_id === d.meta_entity_id)
    )];

    // Enrich each ad set with live metrics + ads + creatives
    const adSets = await Promise.all(allManaged.map(async (creation) => {
      const adSetId = creation.meta_entity_id;

      // Get latest snapshot
      const adSetSnap = await MetricSnapshot.findOne({
        entity_type: 'adset', entity_id: adSetId
      }).sort({ snapshot_at: -1 }).lean();

      const m7 = adSetSnap?.metrics?.last_7d || {};
      const m3 = adSetSnap?.metrics?.last_3d || {};
      const mToday = adSetSnap?.metrics?.today || {};

      // Get ads (creatives) for this ad set
      const adSnapshots = await MetricSnapshot.find({
        entity_type: 'ad',
        parent_id: adSetId
      }).sort({ snapshot_at: -1 }).lean();

      // Deduplicate by entity_id (get latest per ad)
      const seenAds = new Set();
      const uniqueAdSnaps = adSnapshots.filter(s => {
        if (seenAds.has(s.entity_id)) return false;
        seenAds.add(s.entity_id);
        return true;
      });

      // Enrich ads with creative asset info
      const ads = await Promise.all(uniqueAdSnaps.map(async (adSnap) => {
        const am7 = adSnap.metrics?.last_7d || {};

        // Match creative asset
        const adIndex = (creation.child_ad_ids || []).indexOf(adSnap.entity_id);
        const assetId = adIndex >= 0 ? (creation.selected_creative_ids || [])[adIndex] : null;
        let creative = null;
        if (assetId) {
          try {
            const asset = await CreativeAsset.findById(assetId).lean();
            if (asset) {
              creative = {
                id: asset._id.toString(),
                filename: asset.filename,
                style: asset.style,
                headline: asset.headline || asset.original_name,
                ad_format: asset.ad_format || 'unknown'
              };
            }
          } catch (_) { /* ok */ }
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
      }));

      // Get directives for this ad set
      const directives = await StrategicDirective.find({
        entity_id: adSetId,
        source_insight_type: 'brain_supervision',
        created_at: { $gte: last72h }
      }).sort({ created_at: -1 }).lean();

      // Get recent actions for this ad set
      const actions = await ActionLog.find({
        entity_id: adSetId,
        agent_type: 'ai_manager',
        created_at: { $gte: last7d }
      }).sort({ created_at: -1 }).limit(10).lean();

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
    }));

    // ═══ 2. Brain: latest cycle info ═══
    const latestBrainReport = await AgentReport.findOne({
      agent_type: 'brain'
    }).sort({ created_at: -1 }).lean();

    const brainInfo = latestBrainReport ? {
      cycle_id: latestBrainReport.cycle_id,
      ran_at: latestBrainReport.created_at,
      minutes_ago: Math.round((now - new Date(latestBrainReport.created_at)) / 60000),
      status: latestBrainReport.status,
      recommendations_count: (latestBrainReport.recommendations || []).length,
      alerts: latestBrainReport.alerts || [],
      summary: latestBrainReport.summary
    } : null;

    // ═══ 3. Active directives summary ═══
    const activeDirectives = await StrategicDirective.find({
      status: 'active',
      expires_at: { $gt: now },
      source_insight_type: 'brain_supervision'
    }).sort({ created_at: -1 }).lean();

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

    // ═══ 4. AI Manager actions last 48h ═══
    const aiManagerActions = await ActionLog.find({
      agent_type: 'ai_manager',
      created_at: { $gte: last48h }
    }).sort({ created_at: -1 }).limit(50).lean();

    // ═══ 5. Decision tree events (forced kills/scale-downs) ═══
    const decisionTreeActions = await ActionLog.find({
      agent_type: 'ai_manager',
      reasoning: { $regex: /DECISION-TREE/i },
      created_at: { $gte: last7d }
    }).sort({ created_at: -1 }).lean();

    // ═══ 6. Compliance calculation ═══
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

    // ═══ 7. Unified timeline ═══
    const timeline = [];

    // Add AI Manager actions
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

    // Add Brain directives created
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

    // Add recent safety events
    const safetyEvents = await SafetyEvent.find({
      created_at: { $gte: last48h }
    }).sort({ created_at: -1 }).limit(10).lean();

    for (const s of safetyEvents) {
      timeline.push({
        type: 'safety_event',
        timestamp: s.created_at,
        entity_name: s.entity_name || s.entity_id || 'System',
        entity_id: s.entity_id || '',
        action: s.event_type,
        detail: s.reason || s.details || ''
      });
    }

    // Sort timeline by timestamp desc
    timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // ═══ 8. AI Manager last run info ═══
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
        decision_tree_events_7d: decisionTreeActions.length
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
      decision_tree_events: decisionTreeActions.map(a => ({
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

module.exports = router;
