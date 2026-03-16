const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const safetyGuards = require('../../../config/safety-guards');
const kpiTargets = require('../../../config/kpi-targets');
const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const BrainInsight = require('../../db/models/BrainInsight');
const BrainMemory = require('../../db/models/BrainMemory');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const StrategicDirective = require('../../db/models/StrategicDirective');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots, getAdsForAdSet, getSnapshotFreshness } = require('../../db/queries');
const { CooldownManager } = require('../../safety/cooldown-manager');
const GuardRail = require('../../safety/guard-rail');
const PolicyLearner = require('../unified/policy-learner');
const { hardcodedDecisionTree, forceKill, forceScaleDown } = require('./safety-decisions');

const client = new Anthropic({ apiKey: config.claude.apiKey });

const { TIERED_COOLDOWN_HOURS } = require('../../safety/cooldown-manager');

/**
 * Check cooldown for unified_agent only — ignores legacy ai_manager/brain actions.
 * This lets the Account Agent start fresh without inheriting cooldowns from the old system.
 */
async function _isOnAgentCooldown(entityId) {
  const COOLDOWN_DAYS = 3; // max lookback window
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000);

  const lastAction = await ActionLog.findOne({
    entity_id: entityId,
    agent_type: 'unified_agent',
    success: true,
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).lean();

  if (!lastAction) return { onCooldown: false };

  const tieredHours = TIERED_COOLDOWN_HOURS[lastAction.action] || 48;
  const cooldownUntil = new Date(new Date(lastAction.executed_at).getTime() + tieredHours * 3600000);
  const now = new Date();

  if (cooldownUntil > now) {
    return {
      onCooldown: true,
      minutesLeft: Math.round((cooldownUntil - now) / 60000),
      hoursLeft: Math.round((cooldownUntil - now) / 3600000),
      lastAction: lastAction.action
    };
  }
  return { onCooldown: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — personalidad y reglas del agente unificado
// ═══════════════════════════════════════════════════════════════════════════════
const AGENT_SYSTEM_PROMPT = `You are Claude, the unified autonomous account agent for a Meta Ads account (Jersey Pickles — food/ecommerce). You analyze and manage ALL active ad sets in the account, not just AI-created ones.

## HOW YOU WORK
You have tools to fetch data and take actions. For each ad set:
1. Gather metrics (ad set + individual ads)
2. Check entity memory and scaling history
3. Check bandit signals for candidate actions
4. Decide: act or hold
5. ALWAYS save your assessment and observations

## HOW TO READ METRICS
You get 4 time windows: today, 3d, 7d, 14d. Use them together:
- **7d** = baseline performance. Most reliable for decisions.
- **3d vs 7d** = recent trend. If 3d ROAS < 7d ROAS by >20%, performance is deteriorating FAST.
- **7d vs 14d** = longer trend. Confirms if decline is new or ongoing.
- **today** = intraday signal. Only meaningful with $10+ spend. Don't overreact to low-volume today data.
- **trend.summary** = pre-computed signal. Trust it as a starting point.
- **trend.recent_deterioration** = true means 3d ROAS dropped >20% vs 7d with meaningful spend. Investigate.

## META ADS ALGORITHM — CRITICAL RULES
- **Learning phase (first 72h / ~50 conversions):** ANY change resets Meta's algorithm. Do NOT scale or pause during learning.
- **Post-learning scaling:** Max 25% budget increase per action. Wait 48h+ between budget changes.
- **Pause ads freely** after learning: ads with $20+ spend and 0 purchases, CTR < 0.5% after 1000+ impressions, or frequency > 4.
- **Never pause the ad set itself** — only manage individual ads and budget.
- **Budget floor:** $10 minimum.

## FREQUENCY & FATIGUE
- Frequency > 2.5 = audience fatigue warning
- Frequency > 3.5 = CRITICAL — flag needs_new_creatives urgently
- High frequency + declining ROAS = pause fatigued ads

## BANDIT SIGNALS (Thompson Sampling)
The bandit system tracks success/failure of past actions across similar contexts.
- mean > 0.6 = historically successful action in this context
- mean < 0.4 = historically poor action — be cautious
- Use the signal to calibrate aggression, not as a veto

## ASSESSMENT FORMAT
Your assessment (in save_assessment) must be in Spanish and include:
- Performance summary with key metrics (ROAS, CPA, frequency, spend)
- Frequency/fatigue analysis per ad
- What you did and why (or why you held)
- Creative health: which styles work, what's needed
- Performance trend: improving/stable/declining/learning

IMPORTANT: Always call save_assessment before finishing — even if you take no actions.
IMPORTANT: Return ONLY tool calls, minimize text output to save tokens.`;

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS — 12 tools
// ═══════════════════════════════════════════════════════════════════════════════
const TOOLS = [
  {
    name: 'get_adset_metrics',
    description: 'Get 7d/3d/today metrics for the ad set plus account context. Call this first.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'get_ad_performance',
    description: 'Get individual ad performance within this ad set (spend, ROAS, CTR, frequency, fatigue level).',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'get_scaling_history',
    description: 'Get last 15 measured actions (with rewards) for this entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID (ad set or ad)' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'get_bandit_signal',
    description: 'Get Thompson Sampling mean/bias for a specific action in the current context.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scale_up', 'scale_down', 'pause', 'reactivate'], description: 'Action to query' },
        adset_id: { type: 'string', description: 'The ad set ID (for context metrics)' }
      },
      required: ['action', 'adset_id']
    }
  },
  {
    name: 'get_entity_memory',
    description: 'Get BrainMemory for this entity: trends, action_history, remembered metrics.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'get_recent_insights',
    description: 'Get recent BrainInsights for this entity (anomalies, trends, milestones).',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity ID' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'scale_budget',
    description: 'Change the ad set daily budget. Gated: cooldown 48h, max 25% increase, budget floor $10, guard-rail validation.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' },
        new_budget: { type: 'number', description: 'New daily budget in USD' },
        reason: { type: 'string', description: 'Why you are scaling' }
      },
      required: ['adset_id', 'new_budget', 'reason']
    }
  },
  {
    name: 'pause_ad',
    description: 'Pause a specific ad within an ad set. Gated: cooldown check.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'The Meta ad ID to pause' },
        adset_id: { type: 'string', description: 'Parent ad set ID' },
        reason: { type: 'string', description: 'Why you are pausing this ad' }
      },
      required: ['ad_id', 'adset_id', 'reason']
    }
  },
  {
    name: 'reactivate_ad',
    description: 'Reactivate a paused ad. Gated: cooldown check.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'The Meta ad ID to reactivate' },
        adset_id: { type: 'string', description: 'Parent ad set ID' },
        reason: { type: 'string', description: 'Why you are reactivating this ad' }
      },
      required: ['ad_id', 'adset_id', 'reason']
    }
  },
  {
    name: 'save_observation',
    description: 'Create a BrainInsight observation for an entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
        entity_name: { type: 'string', description: 'Entity name' },
        entity_type: { type: 'string', enum: ['adset', 'ad'], default: 'adset' },
        type: { type: 'string', enum: ['anomaly', 'trend', 'opportunity', 'warning', 'milestone', 'status_change'], description: 'Insight type' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        title: { type: 'string', description: 'Short title in Spanish' },
        description: { type: 'string', description: 'Detail in Spanish' }
      },
      required: ['entity_id', 'entity_name', 'type', 'severity', 'title', 'description']
    }
  },
  {
    name: 'save_assessment',
    description: 'Save your assessment to BrainMemory. ALWAYS call this before finishing.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Ad set ID' },
        entity_name: { type: 'string', description: 'Ad set name' },
        assessment: { type: 'string', description: 'Overall assessment in Spanish' },
        frequency_status: { type: 'string', enum: ['ok', 'moderate', 'high', 'critical'] },
        creative_health: { type: 'string', description: 'Creative health analysis in Spanish' },
        needs_new_creatives: { type: 'boolean' },
        suggested_creative_styles: { type: 'array', items: { type: 'string' } },
        performance_trend: { type: 'string', enum: ['improving', 'stable', 'declining', 'learning'] }
      },
      required: ['entity_id', 'entity_name', 'assessment', 'frequency_status', 'performance_trend']
    }
  },
  {
    name: 'log_reasoning',
    description: 'Log a reasoning trace to help with debugging (stored in ActionLog as no_action).',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
        entity_name: { type: 'string', description: 'Entity name' },
        reasoning: { type: 'string', description: 'Your reasoning trace' }
      },
      required: ['entity_id', 'reasoning']
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetAdsetMetrics(input) {
  const { adset_id } = input;
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { error: 'No snapshot found for this ad set' };

  const mToday = snap.metrics?.today || {};
  const m3d = snap.metrics?.last_3d || {};
  const m7d = snap.metrics?.last_7d || {};
  const m14d = snap.metrics?.last_14d || {};

  // Helper: compact metrics for a window
  const compact = (m) => ({
    spend: m.spend || 0,
    roas: Math.round((m.roas || 0) * 100) / 100,
    purchases: m.purchases || 0,
    purchase_value: m.purchase_value || 0,
    impressions: m.impressions || 0,
    clicks: m.clicks || 0,
    ctr: m.ctr || 0,
    cpm: m.cpm || 0,
    frequency: m.frequency || 0,
    cpa: m.spend > 0 && m.purchases > 0 ? Math.round(m.spend / m.purchases * 100) / 100 : 0
  });

  // Trend analysis: compare windows to detect deterioration
  const roas7 = m7d.roas || 0;
  const roas3 = m3d.roas || 0;
  const roas14 = m14d.roas || 0;
  const freq7 = m7d.frequency || 0;
  const freq3 = m3d.frequency || 0;

  // Account context
  const activeSnapshots = allSnapshots.filter(s => s.status === 'ACTIVE');
  const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
  const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
  const totalPV7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);

  return {
    adset_id,
    adset_name: snap.entity_name,
    status: snap.status,
    daily_budget: snap.daily_budget || 0,
    days_old: snap.meta_created_time ? Math.round((Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000) : null,
    metrics_today: compact(mToday),
    metrics_3d: compact(m3d),
    metrics_7d: compact(m7d),
    metrics_14d: compact(m14d),
    trend: {
      roas_direction: roas3 > roas7 * 1.05 ? 'improving' : roas3 < roas7 * 0.95 ? 'declining' : 'stable',
      roas_3d_vs_7d_pct: roas7 > 0 ? Math.round((roas3 - roas7) / roas7 * 100) : 0,
      roas_7d_vs_14d_pct: roas14 > 0 ? Math.round((roas7 - roas14) / roas14 * 100) : 0,
      frequency_direction: freq3 > freq7 * 1.1 ? 'rising' : freq3 < freq7 * 0.9 ? 'falling' : 'stable',
      ctr_declining: (m3d.ctr || 0) < (m7d.ctr || 0) * 0.9,
      recent_deterioration: roas3 < roas7 * 0.8 && (m3d.spend || 0) > 10,
      summary: roas3 < roas7 * 0.8 ? 'ROAS dropping fast (3d vs 7d)'
        : freq3 > 3.5 ? 'Frequency critical'
        : roas3 > roas7 * 1.15 ? 'Performance improving'
        : 'Stable'
    },
    account_context: {
      active_adsets: activeSnapshots.length,
      total_daily_budget: Math.round(totalBudget * 100) / 100,
      account_roas_7d: totalSpend7d > 0 ? Math.round(totalPV7d / totalSpend7d * 100) / 100 : 0
    }
  };
}

async function handleGetAdPerformance(input) {
  const { adset_id } = input;
  const adSnapshots = await getAdsForAdSet(adset_id);

  return {
    adset_id,
    ads: adSnapshots.map(snap => {
      const am = snap.metrics?.last_7d || {};
      const freq = am.frequency || 0;
      return {
        ad_id: snap.entity_id,
        ad_name: snap.entity_name,
        status: snap.status || 'ACTIVE',
        spend: am.spend || 0,
        impressions: am.impressions || 0,
        clicks: am.clicks || 0,
        ctr: am.ctr || 0,
        purchases: am.purchases || 0,
        purchase_value: am.purchase_value || 0,
        roas: am.roas || 0,
        frequency: freq,
        fatigue_level: freq > 4 ? 'critical' : freq > 3 ? 'high' : freq > 2.5 ? 'moderate' : 'ok'
      };
    })
  };
}

async function handleGetScalingHistory(input) {
  const { entity_id } = input;
  const now = Date.now();

  const pastActions = await ActionLog.find({
    entity_id,
    success: true,
    impact_measured: true
  }).sort({ executed_at: -1 }).limit(15).lean();

  return {
    entity_id,
    total_measured: pastActions.length,
    actions: pastActions.map(a => {
      const deltaRoas = a.metrics_after_3d?.roas_7d && a.metrics_at_execution?.roas_7d
        ? Math.round((a.metrics_after_3d.roas_7d - a.metrics_at_execution.roas_7d) / Math.max(a.metrics_at_execution.roas_7d, 0.01) * 10000) / 100
        : null;
      const deltaCpa = a.metrics_after_3d?.cpa_7d && a.metrics_at_execution?.cpa_7d
        ? Math.round((a.metrics_after_3d.cpa_7d - a.metrics_at_execution.cpa_7d) / Math.max(a.metrics_at_execution.cpa_7d, 0.01) * 10000) / 100
        : null;
      const result = deltaRoas != null ? (deltaRoas > 5 ? 'improved' : deltaRoas < -5 ? 'worsened' : 'neutral') : 'unknown';

      return {
        action: a.action,
        agent_type: a.agent_type,
        days_ago: Math.round((now - new Date(a.executed_at).getTime()) / 86400000),
        before_value: a.before_value,
        after_value: a.after_value,
        result,
        delta_roas_pct: deltaRoas,
        delta_cpa_pct: deltaCpa,
        reasoning: (a.reasoning || '').substring(0, 200)
      };
    })
  };
}

async function handleGetBanditSignal(input) {
  const { action, adset_id } = input;

  const learner = new PolicyLearner();
  const state = await learner.loadState();

  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { error: 'No snapshot found', action, mean: 0.5, bias: 0, confidence: 0 };

  const m7d = snap.metrics?.last_7d || {};
  const metrics = {
    roas_7d: m7d.roas || 0,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? m7d.spend / m7d.purchases : 0,
    frequency: m7d.frequency || 0,
    spend_7d: m7d.spend || 0,
    purchases_7d: m7d.purchases || 0
  };

  const bucket = learner.bucketFromMetrics(metrics);
  const signal = learner.getActionBias(state, bucket, action);

  return {
    action,
    bucket,
    mean: Math.round(signal.mean * 1000) / 1000,
    bias: Math.round(signal.bias * 1000) / 1000,
    confidence: Math.round(signal.confidence * 1000) / 1000,
    interpretation: signal.mean > 0.6 ? 'historically_successful' :
      signal.mean < 0.4 ? 'historically_poor' : 'neutral',
    total_samples: state.total_samples || 0
  };
}

async function handleGetEntityMemory(input) {
  const { entity_id } = input;
  const memory = await BrainMemory.findOne({ entity_id }).lean();
  if (!memory) return { entity_id, found: false };

  return {
    entity_id,
    found: true,
    entity_name: memory.entity_name,
    last_status: memory.last_status,
    last_daily_budget: memory.last_daily_budget,
    remembered_metrics: memory.remembered_metrics,
    trends: memory.trends,
    action_history: (memory.action_history || []).slice(-10).map(a => ({
      action_type: a.action_type,
      executed_at: a.executed_at,
      result: a.result,
      roas_delta_pct: a.roas_delta_pct,
      cpa_delta_pct: a.cpa_delta_pct,
      context: a.context
    })),
    agent_assessment: memory.agent_assessment || null,
    agent_performance_trend: memory.agent_performance_trend || null,
    agent_last_check: memory.agent_last_check || null,
    last_updated_at: memory.last_updated_at
  };
}

async function handleGetRecentInsights(input) {
  const { entity_id } = input;
  const insights = await BrainInsight.find({
    entity_id
  }).sort({ created_at: -1 }).limit(5).lean();

  return {
    entity_id,
    count: insights.length,
    insights: insights.map(i => ({
      type: i.type,
      severity: i.severity,
      title: i.title,
      description: (i.description || '').substring(0, 300),
      created_at: i.created_at
    }))
  };
}

async function handleScaleBudget(input, ctx) {
  const { adset_id, new_budget, reason } = input;
  const meta = getMetaClient();
  const guardRail = new GuardRail();
  const cooldownMgr = new CooldownManager();
  const minBudget = safetyGuards.min_adset_budget || 10;

  // Get current budget from snapshot
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { blocked: true, reason: 'No snapshot found for this ad set' };

  const prevBudget = snap.daily_budget || 0;
  const isScaleUp = new_budget > prevBudget;

  // ── GATE: Budget floor
  if (new_budget < minBudget) {
    return { blocked: true, reason: `Budget cannot go below $${minBudget}. Requested: $${new_budget}.` };
  }

  // ── GATE: Cooldown (unified_agent only — ignores legacy cooldowns)
  const cooldown = await _isOnAgentCooldown(adset_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining (last: ${cooldown.lastAction}).` };
  }

  // ── GATE: Max 25% increase
  if (isScaleUp && prevBudget > 0) {
    const changePct = ((new_budget - prevBudget) / prevBudget) * 100;
    if (changePct > 25) {
      return { blocked: true, reason: `Budget increase of ${changePct.toFixed(0)}% exceeds 25% max. Max: $${Math.round(prevBudget * 1.25)}.` };
    }
  }

  // ── GATE: GuardRail validation (ceiling, daily change limit)
  const validation = await guardRail.validate({
    action: isScaleUp ? 'scale_up' : 'scale_down',
    entity_id: adset_id,
    entity_name: snap.entity_name || adset_id,
    entity_type: 'adset',
    current_value: prevBudget,
    new_value: new_budget
  });

  if (!validation.approved) {
    return { blocked: true, reason: validation.reason };
  }

  const finalBudget = validation.modified ? validation.adjustedValue : new_budget;

  // Execute
  await meta.updateBudget(adset_id, finalBudget);

  // Build metrics snapshot
  const m7d = snap.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    roas_3d: Math.round((snap.metrics?.last_3d?.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_today: snap.metrics?.today?.spend || 0,
    spend_7d: m7d.spend || 0,
    daily_budget: prevBudget,
    purchases_7d: m7d.purchases || 0,
    purchase_value_7d: m7d.purchase_value || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  await ActionLog.create({
    entity_type: 'adset',
    entity_id: adset_id,
    entity_name: snap.entity_name || adset_id,
    action: isScaleUp ? 'scale_up' : 'scale_down',
    before_value: prevBudget,
    after_value: finalBudget,
    change_percent: prevBudget > 0 ? Math.round((finalBudget - prevBudget) / prevBudget * 100) : 0,
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Budget $${prevBudget} → $${finalBudget} — ${reason}`);

  return {
    success: true,
    previous_budget: prevBudget,
    new_budget: finalBudget,
    change_pct: Math.round((finalBudget - prevBudget) / prevBudget * 100),
    modified_by_guardrail: validation.modified || false
  };
}

async function handlePauseAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Cooldown (unified_agent only)
  const cooldown = await _isOnAgentCooldown(ad_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  // Execute
  await meta.updateAdStatus(ad_id, 'PAUSED');

  // Metrics for impact tracking
  const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: snap?.daily_budget || 0,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  const adSnaps = await getAdsForAdSet(adset_id);
  const adSnap = adSnaps.find(a => a.entity_id === ad_id);

  await ActionLog.create({
    entity_type: 'ad',
    entity_id: ad_id,
    entity_name: adSnap?.entity_name || ad_id,
    parent_adset_id: adset_id,
    action: 'pause',
    before_value: 'ACTIVE',
    after_value: 'PAUSED',
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution,
    parent_metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Paused ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'PAUSED' };
}

async function handleReactivateAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Cooldown (unified_agent only)
  const cooldown = await _isOnAgentCooldown(ad_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  await meta.updateAdStatus(ad_id, 'ACTIVE');

  const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: snap?.daily_budget || 0,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  await ActionLog.create({
    entity_type: 'ad',
    entity_id: ad_id,
    entity_name: ad_id,
    parent_adset_id: adset_id,
    action: 'reactivate',
    before_value: 'PAUSED',
    after_value: 'ACTIVE',
    reasoning: reason,
    confidence: 'high',
    agent_type: 'unified_agent',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Reactivated ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'ACTIVE' };
}

async function handleSaveObservation(input) {
  await BrainInsight.create({
    entity_type: input.entity_type || 'adset',
    entity_id: input.entity_id,
    entity_name: input.entity_name,
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    source: 'unified_agent'
  });

  return { saved: true };
}

async function handleSaveAssessment(input, ctx) {
  const { entity_id, entity_name } = input;

  await BrainMemory.findOneAndUpdate(
    { entity_id },
    {
      $set: {
        entity_name: entity_name || entity_id,
        entity_type: 'adset',
        agent_assessment: input.assessment || '',
        agent_frequency_status: input.frequency_status || 'unknown',
        agent_creative_health: input.creative_health || '',
        agent_needs_new_creatives: input.needs_new_creatives || false,
        agent_performance_trend: input.performance_trend || 'unknown',
        agent_last_check: new Date(),
        last_updated_at: new Date()
      }
    },
    { upsert: true, new: true }
  );

  ctx.assessmentsSaved++;
  logger.info(`[ACCOUNT-AGENT] ${entity_id}: Assessment saved — trend: ${input.performance_trend}, freq: ${input.frequency_status}`);

  return { saved: true };
}

async function handleLogReasoning(input) {
  // Lightweight trace — just log, don't create full ActionLog
  logger.debug(`[ACCOUNT-AGENT][REASONING] ${input.entity_id}: ${input.reasoning}`);
  return { logged: true };
}

// Tool dispatch map
const TOOL_HANDLERS = {
  get_adset_metrics: (input, _ctx) => handleGetAdsetMetrics(input),
  get_ad_performance: (input, _ctx) => handleGetAdPerformance(input),
  get_scaling_history: (input, _ctx) => handleGetScalingHistory(input),
  get_bandit_signal: (input, _ctx) => handleGetBanditSignal(input),
  get_entity_memory: (input, _ctx) => handleGetEntityMemory(input),
  get_recent_insights: (input, _ctx) => handleGetRecentInsights(input),
  scale_budget: handleScaleBudget,
  pause_ad: handlePauseAd,
  reactivate_ad: handleReactivateAd,
  save_observation: (input, _ctx) => handleSaveObservation(input),
  save_assessment: handleSaveAssessment,
  log_reasoning: (input, _ctx) => handleLogReasoning(input)
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_TURNS = 10;

/**
 * Run the unified Account Agent.
 * Iterates ALL active ad sets and runs an agentic loop on each.
 *
 * @returns {Object} { managed, actions_taken, results, elapsed, cycle_id }
 */
async function runAccountAgent() {
  const startTime = Date.now();
  const cycleId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Account Agent [${cycleId}] ═══`);

  // Freshness guard
  const freshness = await getSnapshotFreshness('adset');
  if (!freshness.fresh) {
    logger.warn(`[ACCOUNT-AGENT] Datos stale (${freshness.age_minutes} min) — abortando.`);
    return { managed: 0, actions_taken: 0, results: [], elapsed: '0s', cycle_id: cycleId, abortReason: `Datos stale: ${freshness.age_minutes} min` };
  }

  // Consume learning feedback first
  const learner = new PolicyLearner();
  await learner.consumeImpactFeedback();

  // Get ALL active ad set snapshots
  const allSnapshots = await getLatestSnapshots('adset');
  const activeAdSets = allSnapshots.filter(s => s.status === 'ACTIVE');

  if (activeAdSets.length === 0) {
    logger.info('[ACCOUNT-AGENT] No active ad sets found');
    return { managed: 0, actions_taken: 0, results: [], elapsed: '0s', cycle_id: cycleId };
  }

  logger.info(`[ACCOUNT-AGENT] Procesando ${activeAdSets.length} ad sets activos (datos: ${freshness.age_minutes} min)`);

  let totalActions = 0;
  const results = [];

  for (const adSetSnap of activeAdSets) {
    const adSetId = adSetSnap.entity_id;
    try {
      const result = await _manageAdSet(adSetSnap, cycleId);
      totalActions += result.actionsExecuted;
      results.push({
        adset_id: adSetId,
        adset_name: adSetSnap.entity_name,
        actions_executed: result.actionsExecuted,
        assessment_saved: result.assessmentSaved,
        skipped: result.skipped || false,
        skip_reason: result.skipReason || null
      });
    } catch (err) {
      logger.error(`[ACCOUNT-AGENT] Error procesando ${adSetId}: ${err.message}`);
      results.push({
        adset_id: adSetId,
        adset_name: adSetSnap.entity_name,
        error: err.message
      });
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Account Agent completado [${cycleId}]: ${activeAdSets.length} ad sets, ${totalActions} acciones en ${elapsed} ═══`);

  return { managed: activeAdSets.length, actions_taken: totalActions, results, elapsed, cycle_id: cycleId };
}

/**
 * Process a single ad set through the agentic loop.
 */
async function _manageAdSet(adSetSnap, cycleId) {
  const adSetId = adSetSnap.entity_id;
  const adSetName = adSetSnap.entity_name || adSetId;
  const meta = getMetaClient();

  const m7d = adSetSnap.metrics?.last_7d || {};
  const m3d = adSetSnap.metrics?.last_3d || {};
  const adSetRoas = m7d.roas || 0;
  const adSetSpend = m7d.spend || 0;
  const adSetPurchases = m7d.purchases || 0;
  const adSetFrequency = m7d.frequency || 0;
  const roas3d = m3d.roas || 0;
  const currentBudget = adSetSnap.daily_budget || 0;

  // Check if this is an AI-created ad set
  const AICreation = require('../../db/models/AICreation');
  const aiCreation = await AICreation.findOne({
    meta_entity_id: adSetId,
    creation_type: 'create_adset'
  }).lean();

  const daysSinceCreation = aiCreation
    ? (Date.now() - new Date(aiCreation.created_at).getTime()) / 86400000
    : 999; // Non-AI ad sets are considered mature

  // ═══ PRE-CHECK: Hardcoded decision tree (emergencies) — only for AI-created ═══
  if (aiCreation) {
    const adsData = (await getAdsForAdSet(adSetId)).map(snap => {
      const am = snap.metrics?.last_7d || {};
      return {
        ad_id: snap.entity_id,
        ad_name: snap.entity_name,
        status: snap.status || 'ACTIVE',
        spend: am.spend || 0,
        purchases: am.purchases || 0,
        roas: am.roas || 0,
        ctr: am.ctr || 0,
        frequency: am.frequency || 0
      };
    });

    const brainDirectives = await StrategicDirective.find({
      status: 'active',
      expires_at: { $gt: new Date() },
      source_insight_type: 'brain_supervision',
      entity_id: adSetId
    }).sort({ created_at: -1 }).lean().then(dirs => dirs.map(d => ({
      type: d.directive_type,
      target_action: d.target_action,
      reason: d.reason,
      urgency: d.urgency_level || 'medium',
      consecutive_count: d.consecutive_count || 1
    })));

    const metricsAtExecution = {
      roas_7d: Math.round(adSetRoas * 100) / 100,
      roas_3d: Math.round(roas3d * 100) / 100,
      cpa_7d: adSetSpend > 0 && adSetPurchases > 0 ? Math.round(adSetSpend / adSetPurchases * 100) / 100 : 0,
      spend_7d: adSetSpend,
      daily_budget: currentBudget,
      purchases_7d: adSetPurchases,
      frequency: adSetFrequency,
      ctr: m7d.ctr || 0
    };

    // Need the creation document (not lean) for forceKill/forceScaleDown
    const creationDoc = await AICreation.findById(aiCreation._id);
    if (creationDoc) {
      const preDecision = await hardcodedDecisionTree({
        creation: creationDoc, adSetId, adSetRoas, adSetSpend, adSetPurchases, adSetFrequency,
        daysSinceCreation, adsData, brainDirectives, roas3d,
        currentBudget, meta, metricsAtExecution
      });

      if (preDecision && preDecision.forced) {
        logger.info(`[ACCOUNT-AGENT][DECISION-TREE] Forced action on ${adSetName}: ${preDecision.action} — ${preDecision.reason}`);
        // Save assessment for forced actions
        await BrainMemory.findOneAndUpdate(
          { entity_id: adSetId },
          {
            $set: {
              entity_name: adSetName, entity_type: 'adset',
              agent_assessment: `[HARDCODED] ${preDecision.reason}`,
              agent_frequency_status: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : 'ok',
              agent_performance_trend: 'declining',
              agent_last_check: new Date(),
              last_updated_at: new Date()
            }
          },
          { upsert: true }
        );
        return { actionsExecuted: preDecision.actionsExecuted || 1, assessmentSaved: true };
      }
    }
  }

  // ═══ PRE-CHECK: Cooldown (unified_agent actions only — ignores legacy) ═══
  const cooldown = await _isOnAgentCooldown(adSetId);
  if (cooldown.onCooldown) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: cooldown (${cooldown.minutesLeft} min remaining)`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Cooldown: ${cooldown.minutesLeft} min` };
  }

  // ═══ PRE-CHECK: Pending impact (unified_agent action < 24h not measured) ═══
  const pendingActions = await ActionLog.find({
    entity_id: adSetId,
    agent_type: 'unified_agent',
    success: true,
    impact_1d_measured: false,
    executed_at: { $gte: new Date(Date.now() - 24 * 3600000) }
  }).sort({ executed_at: -1 }).limit(1).lean();

  if (pendingActions.length > 0) {
    const hoursAgo = Math.round((Date.now() - new Date(pendingActions[0].executed_at).getTime()) / 3600000);
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: pending impact ("${pendingActions[0].action}" ${hoursAgo}h ago)`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Pending impact: ${hoursAgo}h` };
  }

  // ═══ PRE-CHECK: Low spend filter (< $5/week) ═══
  if (adSetSpend < 5) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: low spend ($${adSetSpend.toFixed(2)} < $5/7d) — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Low spend < $5/7d' };
  }

  // ═══ AGENTIC LOOP ═══
  const ctx = {
    actionsExecuted: 0,
    assessmentsSaved: 0
  };

  const userMessage = `Analyze and manage ad set ${adSetId} ("${adSetName}"). Budget: $${currentBudget}/day. 7d ROAS: ${adSetRoas.toFixed(2)}x, Spend: $${adSetSpend.toFixed(0)}, Purchases: ${adSetPurchases}, Frequency: ${adSetFrequency.toFixed(1)}. Gather detailed data, decide actions, and save your assessment.`;

  let messages = [{ role: 'user', content: userMessage }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 2048,
        system: AGENT_SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });
    } catch (apiErr) {
      if (apiErr.status === 429 && turn < 3) {
        logger.warn(`[ACCOUNT-AGENT] Rate limit on turn ${turn} for ${adSetId}. Waiting 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        try {
          response = await client.messages.create({
            model: 'claude-sonnet-4-6-20250514',
            max_tokens: 2048,
            system: AGENT_SYSTEM_PROMPT,
            tools: TOOLS,
            messages
          });
        } catch (retryErr) {
          logger.error(`[ACCOUNT-AGENT] Claude API retry failed for ${adSetId}: ${retryErr.message}`);
          break;
        }
      } else {
        logger.error(`[ACCOUNT-AGENT] Claude API error on turn ${turn} for ${adSetId}: ${apiErr.message}`);
        break;
      }
    }

    // Check for end_turn
    if (response.stop_reason === 'end_turn') {
      break;
    }

    // Process tool calls
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      break;
    }

    // Add assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Process each tool call
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const handler = TOOL_HANDLERS[toolUse.name];
      if (!handler) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` })
        });
        continue;
      }

      logger.debug(`[ACCOUNT-AGENT] ${adSetId} turn ${turn}: ${toolUse.name}`);

      try {
        const result = await handler(toolUse.input, ctx);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (toolErr) {
        logger.error(`[ACCOUNT-AGENT] Tool ${toolUse.name} error: ${toolErr.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: toolErr.message }),
          is_error: true
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // ═══ SAFETY NET: Save assessment if agent didn't ═══
  if (ctx.assessmentsSaved === 0) {
    logger.warn(`[ACCOUNT-AGENT] ${adSetId}: Agent didn't save assessment — saving default`);
    await BrainMemory.findOneAndUpdate(
      { entity_id: adSetId },
      {
        $set: {
          entity_name: adSetName, entity_type: 'adset',
          agent_assessment: `[AUTO] Sin assessment explícito. Acciones: ${ctx.actionsExecuted}.`,
          agent_last_check: new Date(),
          last_updated_at: new Date()
        }
      },
      { upsert: true }
    );
  }

  return { actionsExecuted: ctx.actionsExecuted, assessmentSaved: ctx.assessmentsSaved > 0 };
}

module.exports = { runAccountAgent };
