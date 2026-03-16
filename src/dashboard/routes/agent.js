const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const { getLatestSnapshots, getAdsForAdSet } = require('../../db/queries');

// ═══ In-memory job tracking for async agent runs ═══
const _agentJobs = {};

/**
 * GET /api/agent/activity — Main data for the "Agente" tab.
 * Returns all active ad sets with their latest agent assessment, recent actions, and metrics.
 */
router.get('/activity', async (req, res) => {
  try {
    // 1. Get all active ad set snapshots
    const allSnapshots = await getLatestSnapshots('adset');
    const activeAdSets = allSnapshots.filter(s => s.status === 'ACTIVE');

    // 2. Get all BrainMemory with agent assessments
    const entityIds = activeAdSets.map(s => s.entity_id);
    const memories = await BrainMemory.find({
      entity_id: { $in: entityIds }
    }).lean();
    const memoryMap = {};
    for (const m of memories) { memoryMap[m.entity_id] = m; }

    // 3. Get recent actions from unified agent only
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentActions = await ActionLog.find({
      entity_id: { $in: entityIds },
      agent_type: 'unified_agent',
      success: true,
      executed_at: { $gte: thirtyDaysAgo }
    }).sort({ executed_at: -1 }).lean();

    // Group actions by entity
    const actionsByEntity = {};
    for (const a of recentActions) {
      if (!actionsByEntity[a.entity_id]) actionsByEntity[a.entity_id] = [];
      actionsByEntity[a.entity_id].push(a);
    }

    // 4. Build response per ad set
    const adsets = activeAdSets.map(snap => {
      const memory = memoryMap[snap.entity_id] || {};
      const actions = (actionsByEntity[snap.entity_id] || []).slice(0, 10);
      const m7d = snap.metrics?.last_7d || {};
      const m3d = snap.metrics?.last_3d || {};

      // Determine status badge
      let statusBadge = 'activo';
      if (memory.agent_performance_trend === 'learning') statusBadge = 'learning';
      else if (memory.agent_frequency_status === 'critical') statusBadge = 'fatiga_critica';
      else if (memory.agent_performance_trend === 'declining') statusBadge = 'en_riesgo';

      return {
        adset_id: snap.entity_id,
        adset_name: snap.entity_name,
        daily_budget: snap.daily_budget || 0,
        status: snap.status,
        status_badge: statusBadge,
        metrics_7d: {
          roas: Math.round((m7d.roas || 0) * 100) / 100,
          spend: m7d.spend || 0,
          purchases: m7d.purchases || 0,
          purchase_value: m7d.purchase_value || 0,
          cpa: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
          frequency: m7d.frequency || 0,
          ctr: m7d.ctr || 0
        },
        metrics_3d: {
          roas: Math.round((m3d.roas || 0) * 100) / 100,
          spend: m3d.spend || 0,
          frequency: m3d.frequency || 0,
          ctr: m3d.ctr || 0
        },
        agent: memory.agent_last_check ? {
          assessment: memory.agent_assessment || null,
          frequency_status: memory.agent_frequency_status || 'unknown',
          creative_health: memory.agent_creative_health || null,
          needs_new_creatives: memory.agent_needs_new_creatives || false,
          performance_trend: memory.agent_performance_trend || 'unknown',
          last_check: memory.agent_last_check
        } : null,
        recent_actions: actions.map(a => ({
          _id: a._id,
          action: a.action,
          before_value: a.before_value,
          after_value: a.after_value,
          change_percent: a.change_percent,
          reasoning: a.reasoning,
          agent_type: a.agent_type,
          executed_at: a.executed_at,
          target_entity_name: a.target_entity_name,
          follow_up_verdict: a.follow_up_verdict || 'pending',
          impact_1d: a.impact_1d_measured ? {
            roas_7d: a.metrics_after_1d?.roas_7d,
            delta_roas: a.metrics_at_execution?.roas_7d > 0
              ? Math.round((a.metrics_after_1d?.roas_7d - a.metrics_at_execution.roas_7d) / a.metrics_at_execution.roas_7d * 10000) / 100
              : null
          } : null,
          impact_3d: a.impact_measured ? {
            roas_7d: a.metrics_after_3d?.roas_7d,
            delta_roas: a.metrics_at_execution?.roas_7d > 0
              ? Math.round((a.metrics_after_3d?.roas_7d - a.metrics_at_execution.roas_7d) / a.metrics_at_execution.roas_7d * 10000) / 100
              : null
          } : null,
          impact_7d: a.impact_7d_measured ? {
            roas_7d: a.metrics_after_7d?.roas_7d,
            delta_roas: a.metrics_at_execution?.roas_7d > 0
              ? Math.round((a.metrics_after_7d?.roas_7d - a.metrics_at_execution.roas_7d) / a.metrics_at_execution.roas_7d * 10000) / 100
              : null
          } : null
        }))
      };
    });

    // 5. Compute global stats (unified_agent only)
    const allAgentActions = await ActionLog.find({
      agent_type: 'unified_agent',
      success: true,
      impact_measured: true
    }).lean();

    const positiveActions = allAgentActions.filter(a => (a.learned_reward || 0) > 0.1).length;
    const winRate = allAgentActions.length > 0 ? Math.round(positiveActions / allAgentActions.length * 100) : 0;

    // Last cycle info
    const lastAction = await ActionLog.findOne({
      agent_type: 'unified_agent',
      success: true
    }).sort({ executed_at: -1 }).lean();

    res.json({
      adsets: adsets.sort((a, b) => (b.metrics_7d.spend || 0) - (a.metrics_7d.spend || 0)),
      global: {
        total_adsets: activeAdSets.length,
        win_rate: winRate,
        total_measured: allAgentActions.length,
        last_cycle: lastAction?.executed_at || null
      }
    });
  } catch (error) {
    logger.error(`[AGENT-API] Error en /activity: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agent/run — Trigger manual del Account Agent.
 * Runs async and returns a job_id for polling.
 */
router.post('/run', async (req, res) => {
  try {
    const jobId = `agent_job_${Date.now()}`;
    _agentJobs[jobId] = { status: 'running', started_at: new Date() };

    res.json({ async: true, job_id: jobId, message: 'Account Agent iniciado' });

    // Run async
    const { runAccountAgent } = require('../../ai/agent/account-agent');
    runAccountAgent().then(result => {
      _agentJobs[jobId] = { status: 'completed', ...result };
    }).catch(err => {
      logger.error(`[AGENT-API] Error en ejecución async: ${err.message}`);
      _agentJobs[jobId] = { status: 'failed', error: err.message };
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agent/run-status/:jobId — Poll for agent run completion.
 */
router.get('/run-status/:jobId', (req, res) => {
  const job = _agentJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
  // Clean up completed jobs after 5 minutes
  if (job.status !== 'running') {
    setTimeout(() => delete _agentJobs[req.params.jobId], 5 * 60 * 1000);
  }
});

/**
 * GET /api/agent/adset/:adsetId — Detailed view for a single ad set.
 */
router.get('/adset/:adsetId', async (req, res) => {
  try {
    const { adsetId } = req.params;

    // Get snapshot
    const allSnapshots = await getLatestSnapshots('adset');
    const snap = allSnapshots.find(s => s.entity_id === adsetId);
    if (!snap) return res.status(404).json({ error: 'Ad set no encontrado' });

    // Get memory
    const memory = await BrainMemory.findOne({ entity_id: adsetId }).lean();

    // Get all actions
    const actions = await ActionLog.find({
      entity_id: adsetId,
      success: true
    }).sort({ executed_at: -1 }).limit(30).lean();

    // Get ads
    const adSnapshots = await getAdsForAdSet(adsetId);
    const ads = adSnapshots.map(ad => {
      const am = ad.metrics?.last_7d || {};
      const freq = am.frequency || 0;
      return {
        ad_id: ad.entity_id,
        ad_name: ad.entity_name,
        status: ad.status,
        spend: am.spend || 0,
        roas: am.roas || 0,
        ctr: am.ctr || 0,
        frequency: freq,
        purchases: am.purchases || 0,
        fatigue_level: freq > 4 ? 'critical' : freq > 3 ? 'high' : freq > 2.5 ? 'moderate' : 'ok'
      };
    });

    // Get insights
    const insights = await BrainInsight.find({
      entity_id: adsetId
    }).sort({ created_at: -1 }).limit(10).lean();

    const m7d = snap.metrics?.last_7d || {};
    const m3d = snap.metrics?.last_3d || {};

    res.json({
      adset_id: adsetId,
      adset_name: snap.entity_name,
      daily_budget: snap.daily_budget,
      status: snap.status,
      metrics_7d: {
        roas: Math.round((m7d.roas || 0) * 100) / 100,
        spend: m7d.spend || 0,
        purchases: m7d.purchases || 0,
        purchase_value: m7d.purchase_value || 0,
        cpa: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
        frequency: m7d.frequency || 0,
        ctr: m7d.ctr || 0,
        impressions: m7d.impressions || 0,
        clicks: m7d.clicks || 0
      },
      metrics_3d: {
        roas: Math.round((m3d.roas || 0) * 100) / 100,
        spend: m3d.spend || 0,
        frequency: m3d.frequency || 0,
        ctr: m3d.ctr || 0
      },
      agent: memory ? {
        assessment: memory.agent_assessment,
        frequency_status: memory.agent_frequency_status,
        creative_health: memory.agent_creative_health,
        needs_new_creatives: memory.agent_needs_new_creatives,
        performance_trend: memory.agent_performance_trend,
        last_check: memory.agent_last_check
      } : null,
      memory: memory ? {
        trends: memory.trends,
        action_history: memory.action_history,
        remembered_metrics: memory.remembered_metrics
      } : null,
      ads,
      actions: actions.map(a => ({
        _id: a._id,
        action: a.action,
        before_value: a.before_value,
        after_value: a.after_value,
        change_percent: a.change_percent,
        reasoning: a.reasoning,
        agent_type: a.agent_type,
        executed_at: a.executed_at,
        target_entity_name: a.target_entity_name,
        follow_up_verdict: a.follow_up_verdict || 'pending',
        impact_1d: a.impact_1d_measured ? a.metrics_after_1d : null,
        impact_3d: a.impact_measured ? a.metrics_after_3d : null,
        impact_7d: a.impact_7d_measured ? a.metrics_after_7d : null,
        metrics_at_execution: a.metrics_at_execution
      })),
      insights: insights.map(i => ({
        type: i.type,
        severity: i.severity,
        title: i.title,
        description: i.description,
        created_at: i.created_at
      }))
    });
  } catch (error) {
    logger.error(`[AGENT-API] Error en /adset/:id: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
