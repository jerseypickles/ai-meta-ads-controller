const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const AICreation = require('../../db/models/AICreation');
const ActionLog = require('../../db/models/ActionLog');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const StrategicDirective = require('../../db/models/StrategicDirective');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots, getAdsForAdSet } = require('../../db/queries');
const { CooldownManager } = require('../../safety/cooldown-manager');
const PolicyLearner = require('../unified/policy-learner');

const client = new Anthropic({ apiKey: config.claude.apiKey });

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — personalidad y reglas, sin datos
// ═══════════════════════════════════════════════════════════════════════════════
const AGENT_SYSTEM_PROMPT = `You are Claude, an autonomous Meta Ads ad set manager. You manage ad sets that YOU created — you have full control.

## HOW YOU WORK
You have tools to fetch data and take actions. Use them step by step:
1. First, gather metrics (ad set + individual ads)
2. Check Brain directives and bandit signals
3. Decide: act or hold
4. Always save your assessment

## META ADS ALGORITHM — CRITICAL RULES
- **Learning phase (first 7 days):** ANY change resets Meta's algorithm. Do NOT scale or pause during learning. Only observe and assess.
- **Post-learning scaling:** Max 20-25% budget increase per action. Wait 7+ days between scale-ups.
- **Scale-up requires Brain directive:** You cannot scale up without a "boost" directive from the Brain.
- **Scale-down is autonomous:** You can scale down anytime after learning phase.
- **Pause ads freely** after learning: ads with $20+ spend and 0 purchases, CTR < 0.5% after 1000+ impressions, or frequency > 4.
- **Never pause the ad set itself** — only manage individual ads and budget.
- **Budget floor:** $10 minimum.

## FREQUENCY & FATIGUE
- Frequency > 2.5 = audience fatigue warning
- Frequency > 3.5 = CRITICAL — flag needs_new_creatives urgently
- High frequency + declining ROAS = pause fatigued ads

## BRAIN DIRECTIVES
The Brain is a strategic AI that analyzes the ENTIRE account every 30 min. It has global visibility you don't.
- "boost" + "scale_up" → scale if your metrics support it
- "suppress" + "pause" → you MUST act. Analyze ads individually, pause dead ones, minimize budget if all dead
- "stabilize" → don't scale for 3-7 days, only pause clearly dead ads
- "optimize_ads" → clean underperformers even if overall ROAS is good

## BANDIT SIGNALS
The Thompson Sampling system tracks success/failure of past actions across similar contexts.
- mean > 0.6 = historically successful action in this context
- mean < 0.4 = historically poor action — be cautious
- confidence near 0 = not enough data, proceed with caution
- Use the bandit signal to calibrate aggression, not as a veto

## ASSESSMENT FORMAT
Your assessment (in save_assessment) should be in Spanish and include:
- Performance summary with key metrics
- Frequency/fatigue analysis
- Brain directive response (if any)
- What you did and why (or why you held)
- Creative health: which styles work, what's needed next

IMPORTANT: Always call save_assessment before finishing — even if you take no actions.`;

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
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
    description: 'Get individual ad performance within this ad set (spend, ROAS, CTR, frequency, status).',
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
    description: 'Get last 15 measured actions (with rewards) for this ad set.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'get_bandit_signal',
    description: 'Get Thompson Sampling mean/bias for a specific action in the current context.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scale_up', 'scale_down', 'pause'], description: 'Action to query' },
        adset_id: { type: 'string', description: 'The Meta ad set ID (for context metrics)' }
      },
      required: ['action', 'adset_id']
    }
  },
  {
    name: 'get_brain_directives',
    description: 'Get active Brain directives (boost/suppress/stabilize) for this ad set.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'The Meta ad set ID' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'scale_budget',
    description: 'Change the ad set daily budget. Gated: blocked during learning (7d), scale-up requires Brain directive, 7d cooldown between scale-ups.',
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
    description: 'Pause a specific ad within the ad set. Gated: blocked during learning phase (7d).',
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
    name: 'save_assessment',
    description: 'Save your assessment and creative flags to the AICreation record. ALWAYS call this before finishing.',
    input_schema: {
      type: 'object',
      properties: {
        assessment: { type: 'string', description: 'Overall assessment in Spanish' },
        frequency_status: { type: 'string', enum: ['ok', 'moderate', 'high', 'critical'] },
        frequency_detail: { type: 'string', description: 'Frequency analysis in Spanish' },
        creative_health: { type: 'string', description: 'Creative health analysis in Spanish' },
        creative_rotation_needed: { type: 'boolean' },
        needs_new_creatives: { type: 'boolean' },
        suggested_creative_styles: { type: 'array', items: { type: 'string' } },
        performance_trend: { type: 'string', enum: ['improving', 'stable', 'declining', 'learning'] }
      },
      required: ['assessment', 'frequency_status', 'performance_trend']
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetAdsetMetrics(input, _ctx) {
  const { adset_id } = input;
  const allSnapshots = await getLatestSnapshots('adset');
  const snap = allSnapshots.find(s => s.entity_id === adset_id);
  if (!snap) return { error: 'No snapshot found for this ad set' };

  const m7d = snap.metrics?.last_7d || {};
  const m3d = snap.metrics?.last_3d || {};
  const mToday = snap.metrics?.today || {};

  // Account context
  const activeSnapshots = allSnapshots.filter(s => s.status === 'ACTIVE');
  const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
  const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
  const totalPV7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);

  return {
    adset_id,
    status: snap.status,
    daily_budget: snap.daily_budget || 0,
    metrics_7d: {
      spend: m7d.spend || 0,
      roas: Math.round((m7d.roas || 0) * 100) / 100,
      purchases: m7d.purchases || 0,
      purchase_value: m7d.purchase_value || 0,
      impressions: m7d.impressions || 0,
      clicks: m7d.clicks || 0,
      ctr: m7d.ctr || 0,
      cpm: m7d.cpm || 0,
      frequency: m7d.frequency || 0,
      cpa: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0
    },
    metrics_3d: {
      spend: m3d.spend || 0,
      roas: Math.round((m3d.roas || 0) * 100) / 100,
      purchases: m3d.purchases || 0,
      ctr: m3d.ctr || 0,
      frequency: m3d.frequency || 0
    },
    metrics_today: {
      spend: mToday.spend || 0,
      roas: mToday.roas || 0,
      purchases: mToday.purchases || 0,
      impressions: mToday.impressions || 0
    },
    trend: {
      roas_improving: (m3d.roas || 0) > (m7d.roas || 0),
      frequency_rising: (m3d.frequency || 0) > (m7d.frequency || 0),
      ctr_declining: (m3d.ctr || 0) < (m7d.ctr || 0)
    },
    account_context: {
      active_adsets: activeSnapshots.length,
      total_daily_budget: Math.round(totalBudget * 100) / 100,
      account_roas_7d: totalSpend7d > 0 ? Math.round(totalPV7d / totalSpend7d * 100) / 100 : 0
    }
  };
}

async function handleGetAdPerformance(input, _ctx) {
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

async function handleGetScalingHistory(input, _ctx) {
  const { adset_id } = input;
  const now = Date.now();

  const pastActions = await ActionLog.find({
    entity_id: adset_id,
    agent_type: 'ai_manager',
    success: true,
    impact_measured: true
  }).sort({ executed_at: -1 }).limit(15).lean();

  return {
    adset_id,
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
        days_ago: Math.round((now - new Date(a.executed_at).getTime()) / 86400000),
        before_value: a.before_value,
        after_value: a.after_value,
        result,
        delta_roas_pct: deltaRoas,
        delta_cpa_pct: deltaCpa,
        reasoning: a.reasoning || ''
      };
    })
  };
}

async function handleGetBanditSignal(input, _ctx) {
  const { action, adset_id } = input;

  const learner = new PolicyLearner();
  const state = await learner.loadState();

  // Build bucket from latest snapshot metrics
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

async function handleGetBrainDirectives(input, ctx) {
  const { adset_id } = input;
  const now = new Date();

  const directives = await StrategicDirective.find({
    status: 'active',
    expires_at: { $gt: now },
    source_insight_type: 'brain_supervision',
    $or: [
      { entity_id: adset_id },
      { entity_id: { $in: (ctx.creation.child_ad_ids || []) } }
    ]
  }).sort({ created_at: -1 }).lean();

  // Cache for directive enforcement later
  ctx.brainDirectives = directives.map(d => ({
    _id: d._id,
    type: d.directive_type,
    target_action: d.target_action,
    target_entity_id: d.entity_id,
    target_entity_name: d.entity_name,
    reason: d.reason,
    confidence: d.confidence,
    urgency: d.urgency_level || 'medium',
    consecutive_count: d.consecutive_count || 1,
    hours_since_created: Math.round((now.getTime() - new Date(d.created_at).getTime()) / 3600000)
  }));

  return {
    adset_id,
    count: ctx.brainDirectives.length,
    directives: ctx.brainDirectives
  };
}

async function handleScaleBudget(input, ctx) {
  const { adset_id, new_budget, reason } = input;
  const creation = ctx.creation;
  const meta = getMetaClient();
  const minBudget = require('../../../config/safety-guards').min_adset_budget || 10;

  const prevBudget = creation.current_budget || creation.initial_budget;
  const isScaleUp = new_budget > prevBudget;
  const daysSinceCreation = (Date.now() - new Date(creation.created_at).getTime()) / 86400000;

  // ── GATE: Learning phase (7 days)
  if (daysSinceCreation < 7) {
    return { blocked: true, reason: `Learning phase (${daysSinceCreation.toFixed(1)}d < 7d). No budget changes allowed.` };
  }

  // ── GATE: Budget floor
  if (new_budget < minBudget) {
    return { blocked: true, reason: `Budget cannot go below $${minBudget}. Requested: $${new_budget}.` };
  }

  if (isScaleUp) {
    // ── GATE: Scale-up requires Brain directive
    const brainDirectives = ctx.brainDirectives || [];
    const hasBoost = brainDirectives.some(d =>
      (d.type === 'boost' && d.target_action === 'scale_up') ||
      (d.type === 'boost' && !d.target_action)
    );
    if (!hasBoost) {
      return { blocked: true, reason: 'Scale-up requires a Brain "boost" directive. No active boost found.' };
    }

    // ── GATE: 7-day cooldown between scale-ups
    const lastScaleUp = (creation.lifecycle_actions || [])
      .filter(a => a.action === 'scale_budget' && a.value > prevBudget)
      .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))[0];
    const daysSinceLastScaleUp = lastScaleUp
      ? (Date.now() - new Date(lastScaleUp.executed_at).getTime()) / 86400000
      : 999;
    if (daysSinceLastScaleUp < 7) {
      return { blocked: true, reason: `Scale-up cooldown: last scale-up was ${daysSinceLastScaleUp.toFixed(1)}d ago (min 7d).` };
    }

    // ── GATE: Max 30% increase
    const changePct = ((new_budget - prevBudget) / prevBudget) * 100;
    if (changePct > 30) {
      return { blocked: true, reason: `Budget increase of ${changePct.toFixed(0)}% exceeds 30% max. Reduce to $${Math.round(prevBudget * 1.3)}.` };
    }
  }

  // Execute
  await meta.updateBudget(adset_id, new_budget);

  // Update AICreation
  creation.current_budget = new_budget;
  creation.lifecycle_actions.push({
    action: 'scale_budget',
    value: new_budget,
    reason,
    executed_at: new Date()
  });
  creation.updated_at = new Date();
  await creation.save();

  // Build metrics snapshot
  const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: prevBudget,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  await ActionLog.create({
    entity_type: 'adset',
    entity_id: adset_id,
    entity_name: creation.meta_entity_name,
    campaign_id: creation.parent_entity_id || '',
    campaign_name: creation.parent_entity_name || '',
    action: isScaleUp ? 'scale_up' : 'scale_down',
    before_value: prevBudget,
    after_value: new_budget,
    change_percent: prevBudget > 0 ? Math.round((new_budget - prevBudget) / prevBudget * 100) : 0,
    reasoning: reason,
    confidence: 'high',
    agent_type: 'ai_manager',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  logger.info(`[AGENT-MANAGER] ${adset_id}: Budget $${prevBudget} → $${new_budget} — ${reason}`);

  return { success: true, previous_budget: prevBudget, new_budget, change_pct: Math.round((new_budget - prevBudget) / prevBudget * 100) };
}

async function handlePauseAd(input, ctx) {
  const { ad_id, adset_id, reason } = input;
  const creation = ctx.creation;
  const meta = getMetaClient();
  const daysSinceCreation = (Date.now() - new Date(creation.created_at).getTime()) / 86400000;

  // ── GATE: Learning phase (7 days)
  if (daysSinceCreation < 7) {
    return { blocked: true, reason: `Learning phase (${daysSinceCreation.toFixed(1)}d < 7d). Cannot pause ads.` };
  }

  // Execute
  await meta.updateAdStatus(ad_id, 'PAUSED');

  creation.lifecycle_actions.push({
    action: 'pause_ad',
    value: ad_id,
    reason,
    executed_at: new Date()
  });
  creation.updated_at = new Date();
  await creation.save();

  // Metrics for impact tracking
  const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adset_id);
  const m7d = snap?.metrics?.last_7d || {};
  const metricsAtExecution = {
    roas_7d: Math.round((m7d.roas || 0) * 100) / 100,
    cpa_7d: m7d.spend > 0 && m7d.purchases > 0 ? Math.round(m7d.spend / m7d.purchases * 100) / 100 : 0,
    spend_7d: m7d.spend || 0,
    daily_budget: creation.current_budget || creation.initial_budget,
    purchases_7d: m7d.purchases || 0,
    frequency: m7d.frequency || 0,
    ctr: m7d.ctr || 0
  };

  // Find ad name from snapshots
  const adSnaps = await getAdsForAdSet(adset_id);
  const adSnap = adSnaps.find(a => a.entity_id === ad_id);

  await ActionLog.create({
    entity_type: 'adset',
    entity_id: adset_id,
    entity_name: creation.meta_entity_name,
    campaign_id: creation.parent_entity_id || '',
    campaign_name: creation.parent_entity_name || '',
    action: 'pause',
    before_value: 'ACTIVE',
    after_value: 'PAUSED',
    reasoning: reason,
    target_entity_id: ad_id,
    target_entity_name: adSnap?.entity_name || ad_id,
    confidence: 'high',
    agent_type: 'ai_manager',
    success: true,
    executed_at: new Date(),
    metrics_at_execution: metricsAtExecution
  });

  ctx.actionsExecuted++;
  logger.info(`[AGENT-MANAGER] ${adset_id}: Paused ad ${ad_id} — ${reason}`);

  return { success: true, ad_id, status: 'PAUSED' };
}

async function handleSaveAssessment(input, ctx) {
  const creation = ctx.creation;

  creation.last_manager_assessment = input.assessment || '';
  creation.last_manager_frequency_status = input.frequency_status || 'unknown';
  creation.last_manager_creative_health = input.creative_health || '';
  creation.last_manager_needs_new_creatives = input.needs_new_creatives || false;
  creation.last_manager_creative_rotation_needed = input.creative_rotation_needed || false;
  creation.last_manager_suggested_styles = input.suggested_creative_styles || [];
  creation.last_manager_frequency_detail = input.frequency_detail || '';
  creation.last_manager_check = new Date();
  creation.updated_at = new Date();
  await creation.save();

  ctx.assessmentSaved = true;
  logger.info(`[AGENT-MANAGER] ${creation.meta_entity_id}: Assessment saved — trend: ${input.performance_trend}, freq: ${input.frequency_status}`);

  return { saved: true };
}

// Tool dispatch map
const TOOL_HANDLERS = {
  get_adset_metrics: handleGetAdsetMetrics,
  get_ad_performance: handleGetAdPerformance,
  get_scaling_history: handleGetScalingHistory,
  get_bandit_signal: handleGetBanditSignal,
  get_brain_directives: handleGetBrainDirectives,
  scale_budget: handleScaleBudget,
  pause_ad: handlePauseAd,
  save_assessment: handleSaveAssessment
};

// ═══════════════════════════════════════════════════════════════════════════════
// AGENTIC LOOP
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_TURNS = 15;

/**
 * Manage a single AI-created ad set using agentic tool-use flow.
 * Called from manager.js for creation.agent_version === 'v2'.
 */
async function manageAdSetWithAgent(creation) {
  const adSetId = creation.meta_entity_id;
  const now = new Date();
  const daysSinceCreation = (now - new Date(creation.created_at)) / 86400000;

  logger.info(`[AGENT-MANAGER] Starting agentic management for ${creation.meta_entity_name} (${adSetId}) — ${daysSinceCreation.toFixed(1)}d old`);

  // ═══ PRE-CHECK: Snapshot existence ═══
  const allSnapshots = await getLatestSnapshots('adset');
  const adSetSnapshot = allSnapshots.find(s => s.entity_id === adSetId);

  if (!adSetSnapshot) {
    const meta = getMetaClient();
    try {
      await meta.get(`/${adSetId}`, { fields: 'id' });
      return { actionsExecuted: 0, assessment: 'Esperando datos del DataCollector', frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
    } catch (verifyErr) {
      const errMsg = String(verifyErr?.response?.data?.error?.message || verifyErr.message || '').toLowerCase();
      if (errMsg.includes('does not exist') || errMsg.includes('unsupported get') || errMsg.includes('nonexisting') || errMsg.includes('unknown path') || verifyErr?.response?.status === 400) {
        logger.warn(`[AGENT-MANAGER] Ad set ${adSetId} no existe en Meta — marcando como dead`);
        creation.lifecycle_phase = 'dead';
        creation.current_status = 'ARCHIVED';
        creation.managed_by_ai = false;
        creation.verdict = 'negative';
        creation.verdict_reason = 'Ad set eliminado de Meta externamente';
        creation.lifecycle_phase_changed_at = new Date();
        await creation.save();
        return { actionsExecuted: 0, assessment: 'Ad set eliminado de Meta — marcado como dead', frequency_status: 'unknown', performance_trend: 'dead', needs_new_creatives: false };
      }
      return { actionsExecuted: 0, assessment: 'Error verificando ad set', frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
    }
  }

  // ═══ PRE-CHECK: Hardcoded decision tree (reuse from manager.js) ═══
  const { _hardcodedDecisionTree } = require('./manager');
  const meta = getMetaClient();
  const m7d = adSetSnapshot.metrics?.last_7d || {};
  const m3d = adSetSnapshot.metrics?.last_3d || {};
  const adSetRoas = m7d.roas || 0;
  const adSetSpend = m7d.spend || 0;
  const adSetPurchases = m7d.purchases || 0;
  const adSetFrequency = m7d.frequency || 0;
  const roas3d = m3d.roas || 0;
  const currentBudget = creation.current_budget || creation.initial_budget;

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

  // Fetch brain directives for decision tree
  const brainDirectivesRaw = await StrategicDirective.find({
    status: 'active',
    expires_at: { $gt: now },
    source_insight_type: 'brain_supervision',
    $or: [
      { entity_id: adSetId },
      { entity_id: { $in: (creation.child_ad_ids || []) } }
    ]
  }).sort({ created_at: -1 }).lean();

  const brainDirectives = brainDirectivesRaw.map(d => ({
    _id: d._id,
    type: d.directive_type,
    target_action: d.target_action,
    target_entity_id: d.entity_id,
    reason: d.reason,
    confidence: d.confidence,
    urgency: d.urgency_level || 'medium',
    consecutive_count: d.consecutive_count || 1
  }));

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

  const preDecision = await _hardcodedDecisionTree({
    creation, adSetId, adSetRoas, adSetSpend, adSetPurchases, adSetFrequency,
    daysSinceCreation, adsData, brainDirectives, roas3d,
    currentBudget, meta, metricsAtExecution
  });

  if (preDecision && preDecision.forced) {
    logger.info(`[AGENT-MANAGER][DECISION-TREE] Forced action on ${creation.meta_entity_name}: ${preDecision.action} — ${preDecision.reason}`);
    return {
      actionsExecuted: preDecision.actionsExecuted || 1,
      assessment: `[HARDCODED] ${preDecision.reason}`,
      frequency_status: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : 'ok',
      performance_trend: preDecision.action === 'kill' ? 'declining' : 'mixed',
      needs_new_creatives: false
    };
  }

  // ═══ PRE-CHECK: Breathing check (12h) ═══
  const cooldownMgr = new CooldownManager();
  const AI_MANAGER_BREATHING_HOURS = 12;
  const recentAction = await cooldownMgr.hasRecentAction(adSetId, AI_MANAGER_BREATHING_HOURS);
  if (recentAction.hasRecent) {
    logger.info(`[AGENT-MANAGER] ${creation.meta_entity_name}: breathing — última acción hace ${recentAction.hoursAgo}h`);
    return {
      actionsExecuted: 0,
      assessment: `Breathing: acción "${recentAction.lastAction}" hace ${recentAction.hoursAgo}h. Esperando ${AI_MANAGER_BREATHING_HOURS - recentAction.hoursAgo}h más.`,
      frequency_status: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : 'ok',
      performance_trend: 'unknown',
      needs_new_creatives: false
    };
  }

  // ═══ PRE-CHECK: Pending impact check (24h) ═══
  const PENDING_IMPACT_HOURS = 24;
  const pendingActions = await ActionLog.find({
    entity_id: adSetId,
    success: true,
    impact_measured: false,
    executed_at: { $gte: new Date(Date.now() - PENDING_IMPACT_HOURS * 3600000) }
  }).sort({ executed_at: -1 }).limit(1).lean();

  if (pendingActions.length > 0) {
    const hoursAgo = Math.round((Date.now() - new Date(pendingActions[0].executed_at).getTime()) / 3600000);
    logger.info(`[AGENT-MANAGER] ${creation.meta_entity_name}: pending impact — "${pendingActions[0].action}" hace ${hoursAgo}h`);
    return {
      actionsExecuted: 0,
      assessment: `Pending impact: "${pendingActions[0].action}" hace ${hoursAgo}h pendiente de medición.`,
      frequency_status: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : 'ok',
      performance_trend: 'unknown',
      needs_new_creatives: false
    };
  }

  // ═══ AGENTIC LOOP ═══
  const ctx = {
    creation,
    actionsExecuted: 0,
    assessmentSaved: false,
    brainDirectives: [] // populated by get_brain_directives tool
  };

  const isLearning = daysSinceCreation < 7;
  const userMessage = isLearning
    ? `Manage ad set ${adSetId} ("${creation.meta_entity_name}"). It is ${daysSinceCreation.toFixed(1)} days old — still in LEARNING PHASE. Only observe, gather metrics, and save your assessment. Do NOT take any actions.`
    : `Manage ad set ${adSetId} ("${creation.meta_entity_name}"). It is ${daysSinceCreation.toFixed(1)} days old (post-learning). Gather data, analyze, take actions if needed, and save your assessment.`;

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
        logger.warn(`[AGENT-MANAGER] Rate limit on turn ${turn}. Waiting 15s...`);
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
          logger.error(`[AGENT-MANAGER] Claude API retry failed: ${retryErr.message}`);
          break;
        }
      } else {
        logger.error(`[AGENT-MANAGER] Claude API error on turn ${turn}: ${apiErr.message}`);
        break;
      }
    }

    // Log text blocks
    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    for (const tb of textBlocks) {
      logger.debug(`[AGENT-MANAGER] Turn ${turn} text: ${tb.text.substring(0, 200)}`);
    }

    // Check for end_turn
    if (response.stop_reason === 'end_turn') {
      logger.info(`[AGENT-MANAGER] ${adSetId}: Agent finished at turn ${turn}`);
      break;
    }

    // Process tool calls
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      logger.info(`[AGENT-MANAGER] ${adSetId}: No tool calls at turn ${turn}, finishing`);
      break;
    }

    // Add assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Process each tool call
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const handler = TOOL_HANDLERS[toolUse.name];
      if (!handler) {
        logger.warn(`[AGENT-MANAGER] Unknown tool: ${toolUse.name}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` })
        });
        continue;
      }

      logger.info(`[AGENT-MANAGER] ${adSetId} turn ${turn}: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)})`);

      try {
        const result = await handler(toolUse.input, ctx);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (toolErr) {
        logger.error(`[AGENT-MANAGER] Tool ${toolUse.name} error: ${toolErr.message}`);
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
  if (!ctx.assessmentSaved) {
    logger.warn(`[AGENT-MANAGER] ${adSetId}: Agent didn't save assessment — saving default`);
    creation.last_manager_assessment = `[AGENT] Sin assessment explícito. Acciones: ${ctx.actionsExecuted}.`;
    creation.last_manager_check = new Date();
    creation.updated_at = new Date();
    await creation.save();
  }

  // ═══ DIRECTIVE ENFORCEMENT (same logic as current manager) ═══
  const suppressPauseDirectives = (ctx.brainDirectives || []).filter(d =>
    d.type === 'suppress' && d.target_action === 'pause'
  );

  if (daysSinceCreation >= 7 && suppressPauseDirectives.length >= 3 && ctx.actionsExecuted === 0) {
    logger.warn(`[AGENT-MANAGER][ENFORCE] Agent ignoró ${suppressPauseDirectives.length} directivas suppress+pause para ${creation.meta_entity_name}. Forzando acción.`);

    const activeAds = adsData.filter(a => a.status === 'ACTIVE');
    const deadAdsCount = activeAds.filter(a => a.purchases === 0 || a.roas < 0.5).length;
    const allAdsDead = activeAds.length > 0 && deadAdsCount === activeAds.length;
    const mostAdsDead = activeAds.length > 0 && deadAdsCount >= activeAds.length * 0.6;

    if ((allAdsDead || (mostAdsDead && suppressPauseDirectives.length >= 10)) && daysSinceCreation >= 5 && adSetSpend >= 40) {
      const { _forceKill } = require('./manager');
      const killResult = await _forceKill(creation, adSetId, meta, metricsAtExecution,
        `[AGENT-ENFORCE] ${suppressPauseDirectives.length} directivas suppress+pause ignoradas por agente`);
      if (killResult) ctx.actionsExecuted += killResult.actionsExecuted || 1;
    } else if ((adSetRoas < 2.0 || suppressPauseDirectives.length >= 10) && daysSinceCreation >= 4) {
      const { _forceScaleDown } = require('./manager');
      const newBudget = Math.max(10, Math.round(currentBudget * 0.5));
      const sdResult = await _forceScaleDown(creation, adSetId, meta, metricsAtExecution, currentBudget, newBudget,
        `[AGENT-ENFORCE] ${suppressPauseDirectives.length} directivas suppress+pause ignoradas. ROAS ${adSetRoas.toFixed(2)}x.`);
      if (sdResult) ctx.actionsExecuted += sdResult.actionsExecuted || 1;
    }
  }

  // ═══ MARK BRAIN DIRECTIVES AS APPLIED ═══
  if (ctx.actionsExecuted > 0 && ctx.brainDirectives.length > 0) {
    try {
      const directiveIds = ctx.brainDirectives.map(d => d._id).filter(Boolean);
      if (directiveIds.length > 0) {
        await StrategicDirective.updateMany(
          { _id: { $in: directiveIds }, status: 'active' },
          { $set: { status: 'applied', applied_at: new Date() }, $inc: { applied_count: 1 } }
        );
        logger.info(`[AGENT-MANAGER] ${directiveIds.length} directivas del Brain marcadas como applied`);
      }
    } catch (dirErr) {
      logger.warn(`[AGENT-MANAGER] Error marcando directivas como applied: ${dirErr.message}`);
    }
  }

  // ═══ METRIC CHECKPOINTS (same as current manager) ═══
  if (daysSinceCreation >= 1 && !creation.measured_1d) {
    creation.metrics_1d = { roas_7d: adSetRoas, spend: adSetSpend, impressions: m7d.impressions || 0, purchases: adSetPurchases, ctr: m7d.ctr || 0, frequency: adSetFrequency };
    creation.measured_1d = true;
    creation.measured_1d_at = new Date();
  }
  if (daysSinceCreation >= 3 && !creation.measured_3d) {
    creation.metrics_3d = { roas_7d: adSetRoas, spend: adSetSpend, impressions: m7d.impressions || 0, purchases: adSetPurchases, ctr: m7d.ctr || 0, frequency: adSetFrequency };
    creation.measured_3d = true;
    creation.measured_3d_at = new Date();
  }
  if (daysSinceCreation >= 7 && !creation.measured_7d) {
    creation.metrics_7d = { roas_7d: adSetRoas, spend: adSetSpend, impressions: m7d.impressions || 0, purchases: adSetPurchases, ctr: m7d.ctr || 0, frequency: adSetFrequency };
    creation.measured_7d = true;
    creation.measured_7d_at = new Date();
    if (adSetRoas >= 2) creation.verdict = 'positive';
    else if (adSetRoas >= 1) creation.verdict = 'neutral';
    else creation.verdict = 'negative';
    creation.verdict_reason = creation.last_manager_assessment || '';
  }
  await creation.save();

  logger.info(`[AGENT-MANAGER] ${creation.meta_entity_name}: Done — ${ctx.actionsExecuted} actions, assessment saved: ${ctx.assessmentSaved}`);

  return {
    actionsExecuted: ctx.actionsExecuted,
    assessment: creation.last_manager_assessment || '',
    frequency_status: creation.last_manager_frequency_status || 'unknown',
    performance_trend: 'unknown',
    needs_new_creatives: creation.last_manager_needs_new_creatives || false
  };
}

module.exports = { manageAdSetWithAgent };
