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

// ═══ Cache for /activity endpoint (60s TTL — active ad counts don't change frequently) ═══
const _activityCache = { data: null, timestamp: 0, ttl: 60000 };

/**
 * GET /api/agent/activity — Main data for the "Agente" tab.
 * Returns all active ad sets with their latest agent assessment, recent actions, and metrics.
 */
router.get('/activity', async (req, res) => {
  try {
    // Cache check — respond from memory if fresh
    const now = Date.now();
    if (_activityCache.data && (now - _activityCache.timestamp) < _activityCache.ttl) {
      return res.json(_activityCache.data);
    }

    // 1. Get all active ad set snapshots
    const allSnapshots = await getLatestSnapshots('adset');
    const excludeNames = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'DONT_TOUCH', 'EXCLUDE', 'MANUAL ONLY'];
    const activeAdSets = allSnapshots.filter(s => s.status === 'ACTIVE' && !excludeNames.some(ex => (s.entity_name || '').toUpperCase().includes(ex.toUpperCase())));

    // 2. Get all BrainMemory with agent assessments
    const entityIds = activeAdSets.map(s => s.entity_id);
    const memories = await BrainMemory.find({
      entity_id: { $in: entityIds }
    }).lean();
    const memoryMap = {};
    for (const m of memories) { memoryMap[m.entity_id] = m; }

    // 3. Get recent actions from unified agent only (adset-level + ad-level via parent_adset_id)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentActions = await ActionLog.find({
      $or: [
        { entity_id: { $in: entityIds } },
        { parent_adset_id: { $in: entityIds } }
      ],
      agent_type: 'unified_agent',
      success: true,
      executed_at: { $gte: thirtyDaysAgo }
    }).sort({ executed_at: -1 }).lean();

    // Group actions by ad set (use parent_adset_id for ad-level actions)
    const actionsByEntity = {};
    for (const a of recentActions) {
      const key = a.parent_adset_id || a.entity_id;
      if (!actionsByEntity[key]) actionsByEntity[key] = [];
      actionsByEntity[key].push(a);
    }

    // 3.5. Count active ads per ad set — limitado a ultimos 2 dias (snapshots viejos no importan)
    // El indice (entity_type, parent_id, snapshot_at) se usa para el match inicial
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    const activeAdCounts = await MetricSnapshot.aggregate([
      { $match: {
        entity_type: 'ad',
        parent_id: { $in: entityIds },
        snapshot_at: { $gte: twoDaysAgo }
      }},
      { $sort: { snapshot_at: -1 } },
      { $group: { _id: '$entity_id', status: { $first: '$status' }, parent_id: { $first: '$parent_id' } } },
      { $match: { status: 'ACTIVE' } },
      { $group: { _id: '$parent_id', count: { $sum: 1 } } }
    ]);
    const activeAdsByAdSet = {};
    for (const r of activeAdCounts) {
      activeAdsByAdSet[r._id] = r.count;
    }

    // 4. Build response per ad set
    const adsets = activeAdSets.map(snap => {
      const memory = memoryMap[snap.entity_id] || {};
      const actions = (actionsByEntity[snap.entity_id] || []).slice(0, 10);
      const mToday = snap.metrics?.today || {};
      const m3d = snap.metrics?.last_3d || {};
      const m7d = snap.metrics?.last_7d || {};
      const daysOld = snap.meta_created_time ? Math.round((Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000) : null;

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
        days_old: daysOld,
        metrics_today: {
          roas: Math.round((mToday.roas || 0) * 100) / 100,
          spend: mToday.spend || 0,
          purchases: mToday.purchases || 0
        },
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
        learning_stage: snap.learning_stage || null,
        learning_conversions: snap.learning_stage_conversions || 0,
        active_ads_count: activeAdsByAdSet[snap.entity_id] || 0,
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

    // 5. Compute global stats (unified_agent only — exclude null reward and bug-excluded)
    const allAgentActions = await ActionLog.find({
      agent_type: 'unified_agent',
      success: true,
      impact_measured: true,
      learned_reward: { $ne: null },
      learned_bucket: { $ne: 'excluded_bug' }
    }).lean();

    const positiveActions = allAgentActions.filter(a => a.learned_reward > 0.1).length;
    const winRate = allAgentActions.length > 0 ? Math.round(positiveActions / allAgentActions.length * 100) : 0;

    // Last cycle info
    const lastAction = await ActionLog.findOne({
      agent_type: 'unified_agent',
      success: true
    }).sort({ executed_at: -1 }).lean();

    const responseData = {
      adsets: adsets.sort((a, b) => (b.metrics_7d.spend || 0) - (a.metrics_7d.spend || 0)),
      global: {
        total_adsets: activeAdSets.length,
        win_rate: winRate,
        total_measured: allAgentActions.length,
        last_cycle: lastAction?.executed_at || null
      }
    };

    // Store in cache
    _activityCache.data = responseData;
    _activityCache.timestamp = Date.now();

    res.json(responseData);
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
      'entities.entity_id': adsetId
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

/**
 * GET /api/agent/thoughts — Stream de consciencia del agente.
 * Mezcla assessments + observaciones + acciones en un feed cronológico.
 * Lo que el agente pensó, observó, y decidió — en orden.
 */
router.get('/thoughts', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);

    // 1. Assessments recientes (de BrainMemory con agent_last_check)
    const memories = await BrainMemory.find({
      agent_last_check: { $ne: null }
    }).sort({ agent_last_check: -1 }).limit(limit).lean();

    const assessmentItems = memories.map(m => ({
      type: 'assessment',
      timestamp: m.agent_last_check,
      entity_id: m.entity_id,
      entity_name: m.entity_name,
      content: m.agent_assessment,
      meta: {
        frequency_status: m.agent_frequency_status,
        performance_trend: m.agent_performance_trend,
        needs_new_creatives: m.agent_needs_new_creatives,
        creative_health: m.agent_creative_health
      }
    }));

    // 2. Observaciones del agente (BrainInsight con generated_by=brain, recientes)
    const insights = await BrainInsight.find({
      generated_by: 'brain'
    }).sort({ created_at: -1 }).limit(limit).lean();

    const insightItems = insights.map(i => {
      const firstEntity = (i.entities || [])[0] || {};
      return {
      type: 'observation',
      timestamp: i.created_at,
      entity_id: firstEntity.entity_id || '',
      entity_name: firstEntity.entity_name || '',
      content: i.title + (i.body ? ': ' + i.body : ''),
      meta: {
        insight_type: i.insight_type,
        severity: i.severity
      }
    };
    });

    // 3. Acciones del agente (ActionLog con unified_agent)
    const actions = await ActionLog.find({
      agent_type: 'unified_agent',
      success: true
    }).sort({ executed_at: -1 }).limit(limit).lean();

    const actionItems = actions.map(a => ({
      type: 'action',
      timestamp: a.executed_at,
      entity_id: a.entity_id,
      entity_name: a.entity_name,
      content: a.reasoning || '',
      meta: {
        action: a.action,
        before_value: a.before_value,
        after_value: a.after_value,
        change_percent: a.change_percent,
        target_entity_name: a.target_entity_name,
        follow_up_verdict: a.follow_up_verdict || 'pending'
      }
    }));

    // 4. Merge y ordenar cronológicamente (más reciente primero)
    const feed = [...assessmentItems, ...insightItems, ...actionItems]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    res.json({ feed, total: feed.length });
  } catch (error) {
    logger.error(`[AGENT-API] Error en /thoughts: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agent/performance — Rendimiento semanal del agente + cuenta.
 * Solo muestra desde que el agente empezó (+ 1 semana pre-agente como baseline).
 */
router.get('/performance', async (req, res) => {
  try {
    const moment = require('moment-timezone');
    const tz = 'America/New_York';
    const now = moment().tz(tz);

    // Find when unified_agent started
    const firstAgentAction = await ActionLog.findOne({
      agent_type: 'unified_agent', success: true
    }).sort({ executed_at: 1 }).lean();

    const firstAssessment = await BrainMemory.findOne({
      agent_last_check: { $ne: null }
    }).sort({ agent_last_check: 1 }).lean();

    const agentStartDate = firstAgentAction?.executed_at || firstAssessment?.agent_last_check || null;

    // Start from 1 week before agent started (baseline), or 1 week ago if no agent yet
    const startFrom = agentStartDate
      ? moment(agentStartDate).tz(tz).subtract(1, 'week').startOf('isoWeek')
      : moment(now).subtract(1, 'week').startOf('isoWeek');

    // Calculate how many weeks from startFrom to now
    const totalWeeks = Math.min(12, Math.ceil(now.diff(startFrom, 'days') / 7) + 1);

    const weeklyData = [];

    for (let w = 0; w < totalWeeks; w++) {
      const weekStart = moment(startFrom).add(w, 'weeks');
      const weekEnd = moment(weekStart).endOf('isoWeek');
      const weekLabel = weekStart.format('MMM D');
      const isCurrent = now.isBetween(weekStart, weekEnd, null, '[]');

      // Account metrics from snapshots in this week
      const weekSnapshots = await MetricSnapshot.find({
        entity_type: 'adset',
        snapshot_at: { $gte: weekStart.toDate(), $lte: (isCurrent ? now : weekEnd).toDate() }
      }).sort({ snapshot_at: -1 }).lean();

      // Deduplicate: keep latest snapshot per entity_id
      const latestByEntity = {};
      for (const s of weekSnapshots) {
        if (!latestByEntity[s.entity_id]) latestByEntity[s.entity_id] = s;
      }
      const weekAdSets = Object.values(latestByEntity).filter(s => s.status === 'ACTIVE');

      let accountSpend = 0, accountPurchases = 0, accountPV = 0;
      for (const s of weekAdSets) {
        const m7 = s.metrics?.last_7d || {};
        accountSpend += m7.spend || 0;
        accountPurchases += m7.purchases || 0;
        accountPV += m7.purchase_value || 0;
      }
      const accountRoas = accountSpend > 0 ? Math.round(accountPV / accountSpend * 100) / 100 : 0;

      // Agent actions this week
      const weekActions = await ActionLog.find({
        agent_type: 'unified_agent',
        success: true,
        executed_at: { $gte: weekStart.toDate(), $lte: weekEnd.toDate() }
      }).lean();

      const measuredActions = weekActions.filter(a => a.impact_measured);
      const positiveActions = measuredActions.filter(a => (a.learned_reward || 0) > 0.1);
      const rewards = measuredActions.filter(a => a.learned_reward != null).map(a => a.learned_reward);
      const avgReward = rewards.length > 0 ? Math.round(rewards.reduce((s, r) => s + r, 0) / rewards.length * 1000) / 1000 : null;

      const isPreAgent = agentStartDate && weekEnd.toDate() < new Date(agentStartDate);

      weeklyData.push({
        week: weekLabel,
        week_start: weekStart.format('YYYY-MM-DD'),
        week_end: weekEnd.format('YYYY-MM-DD'),
        is_current: isCurrent,
        is_baseline: isPreAgent,
        account: {
          roas: accountRoas,
          spend: Math.round(accountSpend),
          purchases: accountPurchases,
          active_adsets: weekAdSets.length
        },
        agent: {
          actions_total: weekActions.length,
          actions_measured: measuredActions.length,
          positive: positiveActions.length,
          negative: measuredActions.filter(a => (a.learned_reward || 0) < -0.1).length,
          win_rate: measuredActions.length > 0 ? Math.round(positiveActions.length / measuredActions.length * 100) : null,
          avg_reward: avgReward,
          scale_ups: weekActions.filter(a => a.action === 'scale_up').length,
          scale_downs: weekActions.filter(a => a.action === 'scale_down').length,
          pauses: weekActions.filter(a => a.action === 'pause').length
        }
      });
    }

    res.json({
      weeks: weeklyData,
      agent_started: agentStartDate,
      total_weeks: weeklyData.length
    });
  } catch (error) {
    logger.error(`[AGENT-API] Error en /performance: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
