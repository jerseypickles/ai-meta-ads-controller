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
  const MIN_COOLDOWN_HOURS = 120; // 5 days minimum between actions on same entity
  const COOLDOWN_DAYS = 6; // lookback window
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000);

  // Check both entity_id and parent_adset_id (ad-level actions affect the ad set)
  const lastAction = await ActionLog.findOne({
    $or: [{ entity_id: entityId }, { parent_adset_id: entityId }],
    agent_type: 'unified_agent',
    success: true,
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).lean();

  if (!lastAction) return { onCooldown: false };

  const tieredHours = Math.max(MIN_COOLDOWN_HOURS, TIERED_COOLDOWN_HOURS[lastAction.action] || 120);
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
const AGENT_SYSTEM_PROMPT = `You are Claude, the autonomous account agent for Jersey Pickles Meta Ads. You manage ALL active ad sets.

## CORE PHILOSOPHY — BE CONSERVATIVE
Your DEFAULT action is HOLD. Do nothing. 90% of your cycles should be observation only.
Every change you make resets Meta's learning algorithm. Constant changes DESTROY performance.
Only act when there is STRONG, SUSTAINED evidence over 7+ days. Never react to 3-day fluctuations.

## WHEN TO ACT (only these situations)

### SCALE UP (rare — max 1 per week across entire account)
ALL of these must be true:
- ROAS 7d > account average AND 7d vs 14d shows improvement >25%
- Frequency < 2.0 (audience not saturated)
- No scale action in last 7 days on this ad set
- Bandit signal not negative for scale_up
Then: scale +15-20% max. Set next_review_hours: 168 (7 days).

### ZEUS OVERRIDE — when Zeus orders a scale
Zeus is the CEO brain. He analyzes the FULL account twice daily with all data you don't see.
When Zeus sends a PRIORITIZE directive for scaling a specific ad set, the standard scale_up criteria above are RELAXED:
- You only need: ad set > 5 days old, frequency < 3.0, max +15% increase
- You do NOT need 7d vs 14d improvement >25%, or ROAS > account average, or bandit signal
- Execute the scale THIS CYCLE. Do not HOLD, do not delay, do not set next_review for later
- Zeus already validated the data. Trust his judgment and act.
If Zeus says HOLD or ALERT for an ad set, respect that too — do not scale what Zeus says to hold.

### SCALE DOWN (only emergencies)
- ROAS 7d < 1.5x (below minimum KPI) with $100+ spend 7d
- 7d vs 14d confirms decline (not just 3d noise)
Then: scale -20-25%. Set next_review_hours: 168 (7 days).

### PAUSE AD (only clear failures with enough data)
- Ad has $30+ spend with 0 purchases AND 7+ days old
- OR ad health is "dying" (ROAS AND CTR declining across ALL windows: 14d > 7d > 3d)
- OR ad frequency > 4.0 (saturated)
- Max 1 pause per ad set per cycle
Then: set next_review_hours: 120 (5 days).

### CREATIVE FLAGGING (critical — always check)
After calling get_ad_performance, count ACTIVE ads:
- 0 or 1 active ads -> ALWAYS set needs_new_creatives: true in save_assessment
- 2 active ads with any fatigued/dying -> set needs_new_creatives: true
This triggers the Creative Agent to generate new ads automatically.

### CREATIVE ROTATION (when new ad is ignored)
- New ad has <$5 spend after 5+ days (ignored_by_meta)
- Old ad is 14+ days AND health is fatigued/dying/saturated OR freq > 2.5
- Old ad healthy with freq < 2.0 -> DO NOT rotate
Then: pause old ad, set next_review_hours: 120.

## WHEN NOT TO ACT (critical — unless Zeus overrides)
- 3d dip without 7d confirmation -> HOLD. It is noise.
- ROAS dropped 10-20% -> HOLD. Normal volatility.
- Ad with <$30 spend and 0 purchases -> HOLD. Not enough data.
- Any ad set touched in last 5 days -> HOLD. Let Meta stabilize.
- Ad set in learning (<5 days old) -> HOLD. Gates will block you anyway.
- Budget changed externally -> HOLD 5 days. Learning reset.
NOTE: If Zeus has a PRIORITIZE directive for an ad set, these HOLD rules do NOT apply to that ad set (except learning phase <5 days).

## KILLING FATIGUED ADS (critical safety)
- Before pausing the LAST active ad in an ad set, check: does the account have 10+ other active ad sets with ROAS > 2x?
- If YES: pause the ad, then pause the entire ad set. Zeus will plan budget redistribution to [Prometheus] graduated ad sets.
- If NO: HOLD. Do not kill — the account needs every ad set running. Wait for more [Prometheus] graduations.
- NEVER leave an ad set with 0 active ads and budget still running. If you pause last ad, pause the ad set too.

## METRICS
You get 4 windows: today, 3d, 7d, 14d. Decision windows:
- **7d vs 14d** = your PRIMARY decision signal. Sustained trends only.
- **3d** = early warning, NOT action trigger. Only confirms what 7d shows.
- **today** = noise. Ignore for decisions unless >$30 spend.

## ASSESSMENT FORMAT
Short, max 3-4 sentences in Spanish. Always include:
- **pending_plan**: Specific conditions. "Si ROAS 7d < 1.5x con $100+ spend, scale down 20%."
- **next_review_hours**: 48=stable (default), 120=after action, 168=after scale.

If you received YOUR PREVIOUS PLAN, check conditions and act only if met.

IMPORTANT: Always call save_assessment. Return ONLY tool calls, minimize text.`;

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
    description: 'Save your assessment to BrainMemory. ALWAYS call this before finishing. Include your plan for next review.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Ad set ID' },
        entity_name: { type: 'string', description: 'Ad set name' },
        assessment: { type: 'string', description: 'Overall assessment in Spanish (max 3-4 sentences)' },
        frequency_status: { type: 'string', enum: ['ok', 'moderate', 'high', 'critical'] },
        creative_health: { type: 'string', description: 'Creative health analysis in Spanish' },
        needs_new_creatives: { type: 'boolean' },
        suggested_creative_styles: { type: 'array', items: { type: 'string' } },
        performance_trend: { type: 'string', enum: ['improving', 'stable', 'declining', 'learning'] },
        next_review_hours: { type: 'number', description: 'Hours until next review needed. 4=urgent, 12=normal, 48=stable. Default 12.' },
        pending_plan: { type: 'string', description: 'What to check/do next cycle. E.g. "If 3d ROAS still < 2.5x, scale down 20%. If new ad has > $15 spend with 0 purchases, pause it."' }
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

/**
 * Record an action in BrainMemory.action_history so the Brain learns per-entity.
 */
async function _recordActionInMemory(entityId, entityName, actionType, context) {
  try {
    await BrainMemory.findOneAndUpdate(
      { entity_id: entityId },
      {
        $set: { entity_name: entityName, entity_type: 'adset', last_updated_at: new Date() },
        $push: {
          action_history: {
            $each: [{
              action_type: actionType,
              executed_at: new Date(),
              result: 'pending', // will be updated by impact measurement
              roas_delta_pct: 0,
              cpa_delta_pct: 0,
              context: context || '',
              concurrent_actions: [],
              attribution: 'sole'
            }],
            $slice: -20 // keep last 20
          }
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn(`[ACCOUNT-AGENT] Error recording action in BrainMemory: ${err.message}`);
  }
}

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
      const m3 = snap.metrics?.last_3d || {};
      const m7 = snap.metrics?.last_7d || {};
      const m14 = snap.metrics?.last_14d || {};
      const m30 = snap.metrics?.last_30d || {};
      const freq7 = m7.frequency || 0;
      const freq3 = m3.frequency || 0;
      const daysOld = snap.meta_created_time ? Math.round((Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000) : null;

      // Fatigue detection: compare windows to detect decay curve
      const roas7 = m7.roas || 0;
      const roas3 = m3.roas || 0;
      const roas14 = m14.roas || 0;
      const ctr7 = m7.ctr || 0;
      const ctr3 = m3.ctr || 0;
      const ctr14 = m14.ctr || 0;

      // Dying: 3d < 7d < 14d (consistent downtrend)
      const roasDying = roas14 > 0 && roas7 < roas14 * 0.85 && roas3 < roas7 * 0.85;
      const ctrDying = ctr14 > 0 && ctr7 < ctr14 * 0.85 && ctr3 < ctr7 * 0.85;
      // Ignored by Meta: very low spend relative to ad set
      const isIgnored = (m7.spend || 0) < 2 && daysOld != null && daysOld >= 5;

      let health = 'healthy';
      if (isIgnored) health = 'ignored_by_meta';
      else if (roasDying && ctrDying) health = 'dying';
      else if (roasDying || (freq7 > 3 && ctrDying)) health = 'fatigued';
      else if (freq7 > 4) health = 'saturated';

      return {
        ad_id: snap.entity_id,
        ad_name: snap.entity_name,
        status: snap.status || 'ACTIVE',
        days_old: daysOld,
        metrics_3d: { spend: m3.spend || 0, roas: Math.round((m3.roas || 0) * 100) / 100, ctr: m3.ctr || 0, frequency: freq3, purchases: m3.purchases || 0 },
        metrics_7d: { spend: m7.spend || 0, roas: Math.round(roas7 * 100) / 100, ctr: ctr7, frequency: freq7, purchases: m7.purchases || 0, impressions: m7.impressions || 0 },
        metrics_14d: { spend: m14.spend || 0, roas: Math.round(roas14 * 100) / 100, ctr: ctr14, frequency: m14.frequency || 0, purchases: m14.purchases || 0 },
        health,
        health_detail: health === 'ignored_by_meta' ? `Only $${(m7.spend || 0).toFixed(2)} spend in ${daysOld}d — Meta not exploring this ad`
          : health === 'dying' ? `ROAS declining: 14d ${roas14.toFixed(2)}x → 7d ${roas7.toFixed(2)}x → 3d ${roas3.toFixed(2)}x. CTR also falling. Kill candidate.`
          : health === 'fatigued' ? `Performance dropping: ROAS 7d ${roas7.toFixed(2)}x vs 14d ${roas14.toFixed(2)}x. Frequency ${freq7.toFixed(1)}. Watch closely.`
          : health === 'saturated' ? `Frequency ${freq7.toFixed(1)} — audience exhausted`
          : 'Performance stable or improving'
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
    'entities.entity_id': entity_id
  }).sort({ created_at: -1 }).limit(5).lean();

  return {
    entity_id,
    count: insights.length,
    insights: insights.map(i => ({
      type: i.insight_type,
      severity: i.severity,
      title: i.title,
      description: (i.body || '').substring(0, 300),
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

  // ── GATE: Learning phase (ad set < 3 days old)
  if (snap.meta_created_time) {
    const daysOld = (Date.now() - new Date(snap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot change budget.` };
    }
  }

  // ── GATE: Budget floor
  if (new_budget < minBudget) {
    return { blocked: true, reason: `Budget cannot go below $${minBudget}. Requested: $${new_budget}.` };
  }

  // ── GATE: Cooldown (unified_agent only — bypassed if Zeus PRIORITIZE active)
  const cooldown = await _isOnAgentCooldown(adset_id);
  if (cooldown.onCooldown && !ctx.hasZeusScaleDirective) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining (last: ${cooldown.lastAction}).` };
  }
  if (cooldown.onCooldown && ctx.hasZeusScaleDirective) {
    logger.info(`[ACCOUNT-AGENT] scale_budget: cooldown bypassed for ${adset_id} — Zeus PRIORITIZE directive`);
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
  if (ctx.actionTypes) ctx.actionTypes.push(isScaleUp ? 'scale_up' : 'scale_down');
  await _recordActionInMemory(adset_id, snap.entity_name, isScaleUp ? 'scale_up' : 'scale_down', reason.substring(0, 100));
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

  // ── GATE: Prevent pausing ad set itself (ad_id must not be an ad set)
  const allAdSetSnaps = await getLatestSnapshots('adset');
  if (allAdSetSnaps.some(s => s.entity_id === ad_id)) {
    return { blocked: true, reason: `BLOCKED: ${ad_id} is an AD SET, not an ad. Never pause ad sets — only individual ads.` };
  }

  // ── GATE: Learning phase (ad set < 3 days old)
  const parentSnap = allAdSetSnaps.find(s => s.entity_id === adset_id);
  if (parentSnap?.meta_created_time) {
    const daysOld = (Date.now() - new Date(parentSnap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot pause ads.` };
    }
  }

  // ── GATE: Don't pause the last active ad in an ad set
  // Track pauses within this cycle to catch same-cycle double pauses
  if (!ctx._pausedAdsThisCycle) ctx._pausedAdsThisCycle = new Set();
  const adsInSet = await getAdsForAdSet(adset_id);

  // ── GATE: Don't pause new ads with insufficient data (<$15 spend AND <7 days old)
  const adToCheck = adsInSet.find(a => a.entity_id === ad_id);
  if (adToCheck) {
    const adSpend = adToCheck.metrics?.last_7d?.spend || 0;
    const adDaysOld = adToCheck.meta_created_time ? (Date.now() - new Date(adToCheck.meta_created_time).getTime()) / 86400000 : 999;
    if (adSpend < 30 && adDaysOld < 7) {
      return { blocked: true, reason: `BLOCKED: Ad has only $${adSpend.toFixed(2)} spend in ${adDaysOld.toFixed(0)} days. Need $30+ spend to evaluate. Let it run.` };
    }
  }
  const activeAds = adsInSet.filter(a => a.status === 'ACTIVE' && !ctx._pausedAdsThisCycle.has(a.entity_id));
  if (activeAds.length <= 1 && activeAds.some(a => a.entity_id === ad_id)) {
    return { blocked: true, reason: `BLOCKED: Cannot pause the last active ad in this ad set. It would effectively kill the ad set. Keep at least 1 ad running.` };
  }

  // ── GATE: Cooldown (unified_agent only)
  const cooldown = await _isOnAgentCooldown(ad_id);
  if (cooldown.onCooldown) {
    return { blocked: true, reason: `Cooldown: ${cooldown.minutesLeft} minutes remaining.` };
  }

  // Execute
  await meta.updateAdStatus(ad_id, 'PAUSED');

  // Metrics for impact tracking
  const snap = parentSnap || (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
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
  if (ctx.actionTypes) ctx.actionTypes.push('pause');
  if (!ctx._pausedAdsThisCycle) ctx._pausedAdsThisCycle = new Set();
  ctx._pausedAdsThisCycle.add(ad_id);
  await _recordActionInMemory(adset_id, adSnap?.entity_name || adset_id, 'pause', `ad:${ad_id} ${reason.substring(0, 80)}`);
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Paused ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'PAUSED' };
}

async function handleReactivateAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const meta = getMetaClient();

  // ── GATE: Learning phase (ad set < 3 days old)
  const adsetSnap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  if (adsetSnap?.meta_created_time) {
    const daysOld = (Date.now() - new Date(adsetSnap.meta_created_time).getTime()) / 86400000;
    if (daysOld < 5) {
      return { blocked: true, reason: `Learning phase: ad set is ${daysOld.toFixed(1)} days old (min 5d). Cannot reactivate ads.` };
    }
  }

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
  if (ctx.actionTypes) ctx.actionTypes.push('reactivate');
  await _recordActionInMemory(adset_id, adset_id, 'reactivate', `ad:${ad_id} ${reason.substring(0, 80)}`);
  logger.info(`[ACCOUNT-AGENT] ${adset_id}: Reactivated ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'ACTIVE' };
}

async function handleSaveObservation(input) {
  await BrainInsight.create({
    insight_type: input.type,
    severity: input.severity || 'medium',
    entities: [{
      entity_type: input.entity_type || 'adset',
      entity_id: input.entity_id,
      entity_name: input.entity_name
    }],
    title: input.title,
    body: input.description || input.title,
    generated_by: 'brain'
  });

  return { saved: true };
}

async function handleSaveAssessment(input, ctx) {
  const { entity_id, entity_name } = input;

  const nextReviewHours = input.next_review_hours || 12;
  const nextReviewAt = new Date(Date.now() + nextReviewHours * 3600000);

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
        agent_next_review_at: nextReviewAt,
        agent_pending_plan: input.pending_plan || '',
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
const OBSERVER_TOOLS = TOOLS.filter(t => !['scale_budget', 'pause_ad', 'reactivate_ad'].includes(t.name));

/**
 * Detect if we're in active hours (6am-10pm ET) or observer mode.
 */
function _getAgentMode() {
  const moment = require('moment-timezone');
  const hour = moment().tz('America/New_York').hours();
  return (hour >= 6 && hour < 22) ? 'full' : 'observer';
}

/**
 * Run the unified Account Agent.
 * Iterates ALL active ad sets and runs an agentic loop on each.
 * Mode: 'full' (6am-10pm) = examine + act, 'observer' (10pm-6am) = examine only.
 *
 * @returns {Object} { managed, actions_taken, results, elapsed, cycle_id, mode }
 */
async function runAccountAgent() {
  const startTime = Date.now();
  const cycleId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const mode = _getAgentMode();
  logger.info(`═══ Iniciando Account Agent [${cycleId}] modo=${mode} ═══`);

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
  const activeAdSets = allSnapshots.filter(s => s.status === 'ACTIVE' && !(s.entity_name || '').startsWith('[TEST]'));

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
      const result = await _manageAdSet(adSetSnap, cycleId, mode);
      totalActions += result.actionsExecuted;
      results.push({
        adset_id: adSetId,
        adset_name: adSetSnap.entity_name,
        actions_executed: result.actionsExecuted,
        action_types: result.actionTypes || [],
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

  // Reportar a Zeus
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const activeDirectives = await ZeusDirective.find({ target_agent: { $in: ['athena', 'all'] }, active: true }).lean();
    // Contar por tipo de accion (un ad set puede tener multiples acciones)
    const scaleUps = results.reduce((n, r) => n + (r.action_types || []).filter(t => t === 'scale_up').length, 0);
    const scaleDowns = results.reduce((n, r) => n + (r.action_types || []).filter(t => t === 'scale_down').length, 0);
    const scales = { length: scaleUps + scaleDowns };
    const pauses = { length: results.reduce((n, r) => n + (r.action_types || []).filter(t => t === 'pause').length, 0) };
    const holds = { length: results.filter(r => !r.action_types || r.action_types.length === 0).length };

    let msg = `Ciclo completado (${mode}): ${activeAdSets.length} ad sets evaluados, ${totalActions} acciones en ${elapsed}.`;
    msg += ` Escalé ${scales.length}, pausé ${pauses.length}, holdé ${holds.length}.`;
    if (activeDirectives.length > 0) {
      msg += ` Recibí ${activeDirectives.length} directivas tuyas: ${activeDirectives.map(d => `"${d.directive.substring(0, 50)}"`).join(', ')}.`;
    }
    await ZeusConversation.create({
      from: 'athena', to: 'zeus', type: 'report', message: msg, cycle_id: cycleId,
      context: { managed: activeAdSets.length, actions: totalActions, scales: scales.length, pauses: pauses.length, holds: holds.length, directives_received: activeDirectives.length }
    });
  } catch (_) {}

  return { managed: activeAdSets.length, actions_taken: totalActions, results, elapsed, cycle_id: cycleId, mode };
}

/**
 * Process a single ad set through the agentic loop.
 * @param {Object} adSetSnap - MetricSnapshot for this ad set
 * @param {string} cycleId
 * @param {string} mode - 'full' (can act) or 'observer' (read-only)
 */
async function _manageAdSet(adSetSnap, cycleId, mode = 'full') {
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

  // ═══ PRE-CHECK: Cooldown + Pending (only in full mode — observer always examines) ═══
  // Zeus PRIORITIZE directives bypass cooldown/pending — let Claude evaluate and decide
  let hasZeusScaleDirective = false;
  try {
    const ZeusDirectiveModel = require('../../db/models/ZeusDirective');
    const zeusScaleDirs = await ZeusDirectiveModel.find({
      target_agent: { $in: ['athena', 'all'] },
      active: true,
      directive_type: 'prioritize'
    }).lean();
    // Matchear por nombre del ad set en el texto de la directiva
    const nameWords = adSetName.toLowerCase().split(/\s+/);
    hasZeusScaleDirective = zeusScaleDirs.some(d => {
      const dirText = (d.directive || '').toLowerCase();
      // Tambien checar data.action === 'scale_up' si tiene entity reference
      return nameWords.some(w => w.length > 3 && dirText.includes(w)) ||
        (d.data?.action === 'scale_up' && dirText.includes('scale'));
    });
  } catch (_) {}

  if (mode === 'full') {
    const cooldown = await _isOnAgentCooldown(adSetId);
    if (cooldown.onCooldown && !hasZeusScaleDirective) {
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: cooldown (${cooldown.minutesLeft} min remaining)`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Cooldown: ${cooldown.minutesLeft} min` };
    }
    if (cooldown.onCooldown && hasZeusScaleDirective) {
      logger.info(`[ACCOUNT-AGENT] ${adSetName}: cooldown bypassed — Zeus PRIORITIZE directive active`);
    }

    const pendingActions = await ActionLog.find({
      entity_id: adSetId,
      agent_type: 'unified_agent',
      success: true,
      impact_1d_measured: false,
      executed_at: { $gte: new Date(Date.now() - 24 * 3600000) }
    }).sort({ executed_at: -1 }).limit(1).lean();

    if (pendingActions.length > 0 && !hasZeusScaleDirective) {
      const hoursAgo = Math.round((Date.now() - new Date(pendingActions[0].executed_at).getTime()) / 3600000);
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: pending impact ("${pendingActions[0].action}" ${hoursAgo}h ago)`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Pending impact: ${hoursAgo}h` };
    }
  }

  // ═══ PRE-CHECK: Excluded ad sets (traffic campaigns, manual-only) ═══
  const excludePatterns = ['DONT TOUCH', 'DONT_TOUCH', 'NO TOCAR', 'EXCLUDE', 'MANUAL ONLY', '[TEST]'];
  if (excludePatterns.some(p => (adSetName || '').toUpperCase().includes(p))) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: excluded by name pattern — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Excluded by name' };
  }

  // ═══ PRE-CHECK: Low spend filter (< $5/week) ═══
  if (adSetSpend < 5) {
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: low spend ($${adSetSpend.toFixed(2)} < $5/7d) — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: 'Low spend < $5/7d' };
  }

  // ═══ PRE-CHECK: Smart skip — ad sets estables no necesitan evaluacion cada 2h ═══
  const memory = await BrainMemory.findOne({ entity_id: adSetId }).lean();
  const pendingPlan = memory?.agent_pending_plan || '';
  const nextReview = memory?.agent_next_review_at;
  const lastCheck = memory?.agent_last_check;
  const trend = memory?.agent_performance_trend;

  // Si Zeus tiene directivas activas, no skipear
  let zeusHasDirectives = false;
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const zeusCount = await ZeusDirective.countDocuments({ target_agent: { $in: ['athena', 'all'] }, active: true });
    zeusHasDirectives = zeusCount > 0;
  } catch (_) {}

  // Smart skip: si ad set esta estable/improving Y fue checkeado hace < 12h Y no hay plan pendiente urgente
  if (mode === 'full' && !zeusHasDirectives && lastCheck) {
    const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / 3600000;
    const isHealthy = (trend === 'stable' || trend === 'improving') && adSetRoas >= 2.0 && adSetFrequency < 2.5;

    if (isHealthy && hoursSinceCheck < 12 && !pendingPlan) {
      logger.debug(`[ACCOUNT-AGENT] ${adSetName}: healthy (${trend}, ROAS ${adSetRoas.toFixed(1)}x), checked ${hoursSinceCheck.toFixed(0)}h ago — smart skip`);
      return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Smart skip: healthy, ${hoursSinceCheck.toFixed(0)}h ago` };
    }
  }

  // Next review schedule skip (respeta el programa de Athena)
  if (mode === 'full' && nextReview && new Date(nextReview) > new Date() && !pendingPlan && !zeusHasDirectives) {
    const hoursLeft = Math.round((new Date(nextReview) - new Date()) / 3600000);
    logger.debug(`[ACCOUNT-AGENT] ${adSetName}: next review in ${hoursLeft}h — skip`);
    return { actionsExecuted: 0, assessmentSaved: false, skipped: true, skipReason: `Next review in ${hoursLeft}h` };
  }

  // ═══ AGENTIC LOOP ═══
  const ctx = {
    actionsExecuted: 0,
    assessmentsSaved: 0,
    actionTypes: [],
    hasZeusScaleDirective
  };

  const isObserver = mode === 'observer';
  const activeTools = isObserver ? OBSERVER_TOOLS : TOOLS;

  // Leer directivas de Zeus para Athena
  let zeusContext = '';
  try {
    const ZeusDirective = require('../../db/models/ZeusDirective');
    const directives = await ZeusDirective.find({
      target_agent: { $in: ['athena', 'all'] },
      active: true
    }).lean();
    if (directives.length > 0) {
      zeusContext = '\n\n## ZEUS DIRECTIVES (from the CEO brain — ACT ON THESE NOW)\n' +
        directives.map(d => `- [${d.directive_type.toUpperCase()}] (confidence: ${d.confidence}) ${d.directive}`).join('\n') +
        '\nThese directives are ORDERS from Zeus, not suggestions. Zeus analyzed the full account with all data and is telling you to act.' +
        '\nFor PRIORITIZE scale directives: execute scale_budget NOW using the ZEUS OVERRIDE rules (ad set >5 days, freq <3.0, max +15%). ' +
        'Do NOT apply the standard conservative scale_up criteria. Do NOT HOLD what Zeus says to scale. Act this cycle.';
    }
  } catch (_) {}

  const systemPromptWithZeus = AGENT_SYSTEM_PROMPT + zeusContext;

  const baseContext = `Ad set ${adSetId} ("${adSetName}"). Budget: $${currentBudget}/day. 7d ROAS: ${adSetRoas.toFixed(2)}x, Spend: $${adSetSpend.toFixed(0)}, Purchases: ${adSetPurchases}, Frequency: ${adSetFrequency.toFixed(1)}.`;
  const planContext = pendingPlan ? `\n\nYOUR PREVIOUS PLAN for this ad set: "${pendingPlan}"\nCheck if conditions are met and execute accordingly. If conditions changed, make a new plan.` : '';

  const userMessage = isObserver
    ? `[OBSERVER MODE — nighttime, read-only] Analyze ${baseContext} Gather data, analyze trends, and save your assessment. You CANNOT take actions right now — only observe and document what you see.${planContext}`
    : `Analyze and manage ${baseContext} Gather detailed data, decide actions, and save your assessment.${planContext}`;

  let messages = [{ role: 'user', content: userMessage }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.messages.create({
        model: config.claude.model,
        max_tokens: 2048,
        system: systemPromptWithZeus,
        tools: activeTools,
        messages
      });
    } catch (apiErr) {
      if (apiErr.status === 429 && turn < 3) {
        logger.warn(`[ACCOUNT-AGENT] Rate limit on turn ${turn} for ${adSetId}. Waiting 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        try {
          response = await client.messages.create({
            model: config.claude.model,
            max_tokens: 2048,
            system: systemPromptWithZeus,
            tools: activeTools,
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

  return { actionsExecuted: ctx.actionsExecuted, assessmentSaved: ctx.assessmentsSaved > 0, actionTypes: ctx.actionTypes || [] };
}

module.exports = { runAccountAgent };
