const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const AICreation = require('../../db/models/AICreation');
const CreativeAsset = require('../../db/models/CreativeAsset');
const ActionLog = require('../../db/models/ActionLog');
const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots, getAdsForAdSet } = require('../../db/queries');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const StrategicDirective = require('../../db/models/StrategicDirective');

const client = new Anthropic({ apiKey: config.claude.apiKey });

const MANAGER_SYSTEM_PROMPT = `You are Claude, autonomous ad set manager for Meta Ads. You have FULL CONTROL over ad sets you created. You are an expert on the Meta Ads algorithm and know exactly how it works.

You receive COMPLETE performance data: the ad set you manage, each ad inside it, frequency analysis, creative bank status, and the broader account context.

## YOUR POWERS
1. **Scale budget** up or down (you decide the amount)
2. **Pause ads** that aren't performing (low CTR, no conversions, high frequency)
3. **Add new ads** from the creative bank (pick the best unused assets)
4. **Replace fatigued ads** — pause a high-frequency/declining ad, add a fresh one
5. **Kill the entire ad set** if it's hopeless after 7+ days
6. **Flag need for new creatives** if the bank is running low
7. **Do nothing** if it's in learning phase or performing stably

## META ADS ALGORITHM — CRITICAL KNOWLEDGE
You must respect how Meta's algorithm works:

### Learning Phase (first 3 days / ~50 conversions)
- Meta is testing audiences, placements, and delivery — performance will be volatile
- NEVER make changes during learning phase — any edit resets it
- Budget changes, creative changes, audience changes ALL reset learning
- Wait for learning to complete before evaluating
- If learning is "Limited" after 3 days, the budget may be too low or audience too narrow

### Post-Learning Scaling Rules
- Budget increases of more than 20-25% at once can destabilize delivery and re-trigger learning
- ALWAYS scale in increments: 20-25% max per scaling action
- Wait at least 24-48 hours between scaling actions to let the algorithm stabilize
- If ROAS drops after scaling, don't panic — give it 48h to reoptimize
- Aggressive scaling (>30%) should ONLY happen if ROAS > 3x AND frequency < 1.5

### Budget Strategy (no hard caps — use your judgment)
- Testing phase: $15-40/day (conservative, let data accumulate)
- Validated winners (ROAS > 2x for 7+ days): scale 20-25% per cycle
- Strong performers (ROAS > 3x, low frequency): can push harder, up to 30%
- Account context matters: look at total account spend and scale proportionally
- If this ad set is 50%+ of total account spend, be more conservative
- Don't over-concentrate budget — diversification reduces risk

### When to Kill
- ROAS < 0.8 after 7+ days with $50+ spend: strong kill signal
- ROAS < 1.0 after 10+ days: kill unless there's a clear improving trend (3d better than 7d)
- 0 purchases after $40+ spend: kill
- High frequency (>3.5) + declining ROAS + no fresh creatives available: kill

## FREQUENCY & FATIGUE RULES
- Frequency > 2.5 means audience fatigue — they're seeing the same ads too much
- Frequency > 3.5 is CRITICAL — creative refresh is URGENT
- If the ad set frequency is high but ROAS is still OK, REPLACE the weakest ads with fresh creatives
- If frequency is high AND ROAS is declining, this ad set needs aggressive creative rotation
- Individual ads with high frequency + declining CTR should be paused and replaced
- When adding new ads to fight fatigue, pick DIFFERENT styles from what's currently running

## PERFORMANCE RULES
- After learning (3+ days): evaluate and act
- If an ad has 0 purchases after $20+ spend → pause it
- If an ad has CTR < 0.5% after 1000+ impressions → pause it
- If an ad has frequency > 4 → pause it and add fresh creative
- Don't add new ads if there are already 6+ active ads (pause weak ones first)

## AD COPY GENERATION (headline + body)
When adding a new ad (add_ad), you write the headline and body (primary text). This copy is CRITICAL for conversion:
- The headline and body are in ENGLISH (US audience)
- Use the creative's scene_label and product info to write copy that MATCHES the image
  * If scene_label says "Nachos with chamoy chips at a bar" → write copy about snacking, social eating, flavor
  * If scene_label says "Pickle jar on kitchen counter" → write copy about cooking, home recipes, crunch
- Study the BEST PERFORMING ads currently running in this ad set — their headlines and copy WORK. Use similar angles, tone, and hooks but with fresh wording
- Copy styles that work in Meta Ads:
  * Curiosity hooks: "ok but why didn't anyone tell me about this before"
  * Social proof: "the snack everyone's hiding at work"
  * Direct benefit: "your nachos will never be the same"
  * Urgency/FOMO: "we can't keep these in stock"
- Keep it casual, authentic — NOT corporate or salesy
- Headline: 5-12 words max, punchy, makes people stop scrolling
- Body: 1-3 short sentences, conversational, includes a soft CTA or curiosity element
- Match the STYLE of the creative — organic/ugly-ad copy should feel raw and real, polished copy can be more refined

## CREATIVE BANK AWARENESS
- You receive detailed info for each available creative: style, ad_format (feed=1:1, stories=9:16), product_name, product_line, flavor, scene_label (what the image shows), generated_by (manual or AI), and performance metrics.
- When adding ads, pick creatives STRATEGICALLY:
  * Match the PRODUCT to the ad set — if the ad set sells Chamoy Chips, pick creatives showing Chamoy Chips, not pickles
  * Prefer feed (1:1) format for ad sets using feed placements, stories (9:16) for story placements
  * Pick DIFFERENT styles from what's currently running in this ad set for variety
  * Use scene_label to understand what the image shows — varied scenes perform better than similar ones
  * Prefer unused assets (times_used = 0) for fresh testing
  * If a creative has avg_roas > 0 from other ad sets, it's a proven winner — prioritize it
- If bank has < 3 unused assets matching this product, flag needs_new_creatives: true
- Suggest what STYLES of creatives would help (based on what's working/missing)

## OUTPUT FORMAT (strict JSON)
{
  "actions": [
    {
      "type": "scale_budget",
      "new_budget": 30.00,
      "reason": "..."
    },
    {
      "type": "pause_ad",
      "ad_id": "123456",
      "reason": "..."
    },
    {
      "type": "add_ad",
      "asset_id": "mongo_id",
      "headline": "...",
      "body": "...",
      "cta": "SHOP_NOW",
      "reason": "..."
    },
    {
      "type": "kill_adset",
      "reason": "..."
    }
  ],
  "assessment": "In Spanish — overall assessment including frequency/fatigue analysis, algorithm status, and scaling rationale",
  "frequency_status": "ok|moderate|high|critical",
  "frequency_detail": "In Spanish — specific frequency analysis for this ad set and its ads",
  "creative_rotation_needed": true/false,
  "needs_new_creatives": true/false,
  "suggested_creative_styles": ["ugly-ad", "ugc"],
  "performance_trend": "improving|stable|declining|learning",
  "next_check_hours": 24
}

If no actions needed: { "actions": [], "assessment": "...", "frequency_status": "ok", ... "next_check_hours": 24 }

## FEEDBACK LOOP — LEARN FROM YOUR PAST DECISIONS
You will receive an "action_history" array with your previous decisions on this ad set and their MEASURED outcomes.
Each entry has:
- action: what you did (scale_budget, pause_ad, add_ad, kill_adset)
- days_ago: when you did it
- result: "improved" (ROAS went up >5%), "worsened" (ROAS went down >5%), or "neutral"
- delta_roas_pct: exact % change in ROAS after your action
- delta_cpa_pct: exact % change in CPA after your action
- creative_style: for add_ad actions, which creative style was used

USE THIS DATA to inform your current decisions:
- If scaling budget previously improved ROAS → you can scale again with higher confidence
- If scaling budget previously worsened ROAS → be more conservative or pause scaling
- If a specific creative style (e.g. ugly-ad) worsened performance → avoid that style, prefer styles that worked
- If pausing ads improved CPA → continue cleaning underperformers
- If adding creatives had no effect → the problem might not be creative fatigue
- Include a brief "learning" note in your assessment referencing what past data informed your decision

You will also receive "creative_performance" data showing which creative styles and assets are performing best/worst across all your managed ad sets. Use this to pick the best styles when adding new ads.

## BRAIN STRATEGIC DIRECTIVES
You may receive "brain_directives" — these come from the Brain, a strategic AI that analyzes the ENTIRE ad account every 30 minutes. The Brain has global visibility (cross-ad-set performance, account-level ROAS, budget concentration, etc.) that you don't have.

When brain_directives are present:
- "boost" + "scale_up" → Brain sees this ad set has room to grow in the account context. Scale if metrics support it.
- "suppress" + "scale_up" → Brain sees risk (e.g. account is over-concentrated, ROAS dropping globally). Be conservative. Do NOT scale up.
- "suppress" + "pause" → Brain recommends pausing this ad set. This is a STRONG signal — you MUST act on it. But act INTELLIGENTLY:
  * FIRST: Analyze each ad individually. If any ad has purchases and positive ROAS, that ad has value.
  * If ALL ads are dead (0 purchases each, or very low CTR < 0.3%): kill_adset entirely.
  * If SOME ads are performing but others are dead: pause the dead ads, keep the winners. Optionally add fresh creatives to replace the paused ones. Consider reducing budget if overall ROAS is weak.
  * If ONE ad carries all the weight: pause the others, keep that one, add fresh creatives to test alongside it.
  * The Brain sees global metrics but NOT individual ad performance — YOU have that data. Use it to make the right granular decision.
  * NEVER ignore a "suppress + pause" directive. You must take at least one action (pause_ad, kill_adset, or scale_budget down).
- "boost" + "reactivate" → Brain thinks this ad set should come back. Consider reactivating.
- "stabilize" → Ad set just exited learning phase. DO NOT scale or kill for 3-7 days. Let Meta's algorithm stabilize. Only pause individual ads that are clearly dead ($20+ spend, 0 purchases, CTR < 0.3%).
- "optimize_ads" → Clean up underperforming ads in this ad set (even if overall ROAS is good). Pause ads with 0 purchases + $20+ spend, or CTR < 0.5% + 1000+ impressions. Add fresh creatives to replace paused ones. This applies to ALL ad sets — winners benefit from cleaning up bad ads too.
- "rescue" → This ad set has good engagement (CTR > 0.8%) but zero conversions. The audience is interested but not buying. Try different creative styles/angles before killing. Pause the weakest 2-3 ads and replace with fresh creatives from different styles than what's running.
- Other combinations → Use the "reason" field to understand the Brain's intent.

You MUST mention Brain directives in your assessment and explain how they influenced your decision. If a directive says "suppress + pause", you MUST take action — doing nothing is NOT acceptable.

IMPORTANT:
- Return ONLY valid JSON, no markdown fences
- Be decisive but respect the algorithm — no changes during learning
- Scale in 20-25% increments, never more than 30% at once
- ALWAYS analyze frequency even if no actions needed
- Ad copy (headline, body) in English for US audience
- Assessment/analysis in Spanish for the team
- Include algorithm-level reasoning in your assessment (learning status, delivery stability, etc.)
- Reference your past decision outcomes in the assessment when relevant`;

/**
 * Manage all AI-created ad sets that have managed_by_ai: true
 */
async function runManager() {
  const managed = await AICreation.find({
    creation_type: 'create_adset',
    managed_by_ai: true,
    lifecycle_phase: { $nin: ['dead'] }
  });

  if (managed.length === 0) {
    logger.info('[AI-MANAGER] No hay ad sets gestionados por IA');
    return { managed: 0, actions_taken: 0, results: [] };
  }

  logger.info(`[AI-MANAGER] Gestionando ${managed.length} ad sets`);
  let totalActions = 0;
  const results = [];

  for (const creation of managed) {
    try {
      const result = await manageAdSet(creation);
      totalActions += result.actionsExecuted;
      results.push({
        adset_id: creation.meta_entity_id,
        adset_name: creation.meta_entity_name,
        phase: creation.lifecycle_phase,
        actions_executed: result.actionsExecuted,
        assessment: result.assessment,
        frequency_status: result.frequency_status,
        performance_trend: result.performance_trend,
        needs_new_creatives: result.needs_new_creatives
      });
    } catch (err) {
      logger.error(`[AI-MANAGER] Error gestionando ${creation.meta_entity_id}: ${err.message}`);
      results.push({
        adset_id: creation.meta_entity_id,
        adset_name: creation.meta_entity_name,
        error: err.message
      });
    }
  }

  return { managed: managed.length, actions_taken: totalActions, results };
}

/**
 * Manage a single AI-created ad set
 */
async function manageAdSet(creation) {
  const meta = getMetaClient();
  const adSetId = creation.meta_entity_id;

  const now = new Date();
  const daysSinceCreation = (now - new Date(creation.created_at)) / (1000 * 60 * 60 * 24);

  // ═══ READ ALL METRICS FROM MONGODB (no Meta API calls for reads) ═══
  // DataCollector already fetches all metrics every 10 min and stores in MetricSnapshot.
  // This eliminates ~80 API calls per AI Manager cycle.

  // 1. Get ad set snapshot from MongoDB
  const allAdSetSnapshots = await getLatestSnapshots('adset');
  const adSetSnapshot = allAdSetSnapshots.find(s => s.entity_id === adSetId);

  if (!adSetSnapshot) {
    // No snapshot = ad set likely deleted or not yet collected
    logger.warn(`[AI-MANAGER] No snapshot found for ${adSetId} (${creation.meta_entity_name}) — verifying with Meta API`);
    try {
      await meta.get(`/${adSetId}`, { fields: 'id' });
      // Exists but no snapshot yet — skip this cycle
      return { actionsExecuted: 0, assessment: 'Esperando datos del DataCollector', frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
    } catch (verifyErr) {
      const errMsg = String(verifyErr?.response?.data?.error?.message || verifyErr.message || '').toLowerCase();
      if (errMsg.includes('does not exist') || errMsg.includes('unsupported get') || errMsg.includes('nonexisting') || errMsg.includes('unknown path') || verifyErr?.response?.status === 400) {
        logger.warn(`[AI-MANAGER] Ad set ${adSetId} (${creation.meta_entity_name}) no existe en Meta — marcando como dead`);
        creation.lifecycle_phase = 'dead';
        creation.current_status = 'ARCHIVED';
        creation.managed_by_ai = false;
        creation.verdict = 'negative';
        creation.verdict_reason = 'Ad set eliminado de Meta externamente';
        creation.lifecycle_phase_changed_at = new Date();
        await creation.save();
        return { actionsExecuted: 0, assessment: 'Ad set eliminado de Meta — marcado como dead', frequency_status: 'unknown', performance_trend: 'dead', needs_new_creatives: false };
      }
      logger.warn(`[AI-MANAGER] Error verificando ${adSetId}: ${verifyErr.message} — continuando`);
      return { actionsExecuted: 0, assessment: 'Error verificando ad set', frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
    }
  }

  // 2. Get individual ad snapshots from MongoDB
  const adSnapshots = await getAdsForAdSet(adSetId);

  // 3. Parse ad set metrics from snapshot (already processed by DataCollector)
  const m7d = adSetSnapshot.metrics?.last_7d || {};
  const m3d = adSetSnapshot.metrics?.last_3d || {};
  const mToday = adSetSnapshot.metrics?.today || {};

  const adSetSpend = m7d.spend || 0;
  const adSetRoas = m7d.roas || 0;
  const adSetPurchases = m7d.purchases || 0;
  const adSetPurchaseValue = m7d.purchase_value || 0;
  const adSetFrequency = m7d.frequency || 0;

  const spend3d = m3d.spend || 0;
  const roas3d = m3d.roas || 0;
  const purchases3d = m3d.purchases || 0;
  const frequency3d = m3d.frequency || 0;

  // 4. Build ads data from MongoDB snapshots (instead of per-ad API calls)
  let adsData = adSnapshots.map(snap => {
    const am = snap.metrics?.last_7d || {};
    const adFrequency = am.frequency || 0;
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
      frequency: adFrequency,
      is_fatigued: adFrequency > 2.5,
      fatigue_level: adFrequency > 4 ? 'critical' : adFrequency > 3 ? 'high' : adFrequency > 2.5 ? 'moderate' : 'ok'
    };
  });

  // Get available creatives from bank (not yet used in this ad set)
  const usedAssetIds = creation.selected_creative_ids || [];
  const availableCreatives = await CreativeAsset.find({
    status: 'active',
    purpose: 'ad-ready',
    media_type: 'image',
    _id: { $nin: usedAssetIds }
  }).lean();

  // Creative bank health
  const allCreatives = await CreativeAsset.find({
    status: 'active',
    purpose: 'ad-ready',
    media_type: 'image'
  }).lean();
  const unusedCreatives = allCreatives.filter(c => (c.times_used || 0) === 0);
  const styleDistribution = {};
  allCreatives.forEach(c => {
    const s = c.style || 'other';
    styleDistribution[s] = (styleDistribution[s] || 0) + 1;
  });

  // Current ad styles running in this ad set
  const currentStyles = [];
  for (const ad of adsData) {
    if (ad.status === 'ACTIVE') {
      const assetId = usedAssetIds.find((_, idx) => creation.child_ad_ids?.[idx] === ad.ad_id);
      if (assetId) {
        const asset = allCreatives.find(c => c._id.toString() === assetId);
        if (asset) currentStyles.push(asset.style || 'other');
      }
    }
  }

  // Account context (other ad sets performance for comparison)
  let accountContext = {};
  try {
    const allSnapshots = await getLatestSnapshots('adset');
    const activeSnapshots = allSnapshots.filter(s => s.status === 'ACTIVE');
    const totalBudget = activeSnapshots.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
    const totalSpend7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
    const totalPurchaseValue7d = activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);
    accountContext = {
      active_adsets: activeSnapshots.length,
      total_daily_budget: Math.round(totalBudget * 100) / 100,
      account_roas_7d: totalSpend7d > 0 ? Math.round(totalPurchaseValue7d / totalSpend7d * 100) / 100 : 0,
      avg_frequency: activeSnapshots.length > 0 ?
        Math.round(activeSnapshots.reduce((sum, s) => sum + (s.metrics?.last_7d?.frequency || 0), 0) / activeSnapshots.length * 10) / 10 : 0
    };
  } catch (e) {
    logger.warn('[AI-MANAGER] No account context available');
  }

  // ═══ FEEDBACK LOOP: Fetch past measured actions for this ad set ═══
  let actionHistory = [];
  let creativePerformance = {};
  try {
    // Get all measured actions for this specific ad set
    const pastActions = await ActionLog.find({
      entity_id: adSetId,
      agent_type: 'ai_manager',
      success: true,
      impact_measured: true
    }).sort({ executed_at: -1 }).limit(15).lean();

    actionHistory = pastActions.map(a => {
      const deltaRoas = a.metrics_after_3d?.roas_7d && a.metrics_at_execution?.roas_7d
        ? Math.round((a.metrics_after_3d.roas_7d - a.metrics_at_execution.roas_7d) / Math.max(a.metrics_at_execution.roas_7d, 0.01) * 10000) / 100
        : null;
      const deltaCpa = a.metrics_after_3d?.cpa_7d && a.metrics_at_execution?.cpa_7d
        ? Math.round((a.metrics_after_3d.cpa_7d - a.metrics_at_execution.cpa_7d) / Math.max(a.metrics_at_execution.cpa_7d, 0.01) * 10000) / 100
        : null;
      const result = deltaRoas != null ? (deltaRoas > 5 ? 'improved' : deltaRoas < -5 ? 'worsened' : 'neutral') : 'unknown';

      return {
        action: a.action,
        days_ago: Math.round((now - new Date(a.executed_at)) / (1000 * 60 * 60 * 24)),
        result,
        delta_roas_pct: deltaRoas,
        delta_cpa_pct: deltaCpa,
        before_value: a.before_value,
        after_value: a.after_value,
        creative_style: a.creative_asset_id ? null : undefined, // filled below
        reasoning: a.reasoning || ''
      };
    });

    // Enrich add_ad actions with creative style info
    for (const entry of actionHistory) {
      if (entry.action === 'create_ad' && entry.creative_style === null) {
        // Try to find style from the reasoning or the original action
        const matchingAction = pastActions.find(a =>
          a.action === 'create_ad' && a.creative_asset_id
        );
        if (matchingAction?.creative_asset_id) {
          try {
            const asset = await CreativeAsset.findById(matchingAction.creative_asset_id).lean();
            entry.creative_style = asset?.style || 'unknown';
          } catch (e) { /* ok */ }
        }
      }
    }

    // Creative performance across all managed ad sets — which styles work best
    // Pre-load all assets in a single query to avoid N+1
    const allManagerActions = await ActionLog.find({
      agent_type: 'ai_manager',
      action: 'create_ad',
      success: true,
      impact_measured: true
    }).lean();

    const assetIds = [...new Set(allManagerActions.map(a => a.creative_asset_id).filter(Boolean))];
    const allAssets = assetIds.length > 0 ? await CreativeAsset.find({ _id: { $in: assetIds } }).lean() : [];
    const assetMap = {};
    for (const asset of allAssets) { assetMap[asset._id.toString()] = asset; }

    const styleResults = {};
    for (const a of allManagerActions) {
      if (!a.creative_asset_id) continue;
      const asset = assetMap[a.creative_asset_id.toString()];
      if (!asset) continue;
      const style = asset.style || 'other';
      if (!styleResults[style]) styleResults[style] = { total: 0, improved: 0, worsened: 0, avg_delta: 0, deltas: [] };
      styleResults[style].total++;
      const deltaRoas = a.metrics_after_3d?.roas_7d && a.metrics_at_execution?.roas_7d
        ? (a.metrics_after_3d.roas_7d - a.metrics_at_execution.roas_7d) / Math.max(a.metrics_at_execution.roas_7d, 0.01) * 100
        : 0;
      styleResults[style].deltas.push(deltaRoas);
      if (deltaRoas > 5) styleResults[style].improved++;
      else if (deltaRoas < -5) styleResults[style].worsened++;
    }

    // Calculate averages
    for (const [style, data] of Object.entries(styleResults)) {
      data.avg_delta = data.deltas.length > 0
        ? Math.round(data.deltas.reduce((s, d) => s + d, 0) / data.deltas.length * 10) / 10
        : 0;
      delete data.deltas; // don't send raw array to Claude
    }
    creativePerformance = styleResults;

    if (actionHistory.length > 0) {
      logger.info(`[AI-MANAGER] Feedback loop: ${actionHistory.length} acciones pasadas medidas para ${adSetId}`);
    }
  } catch (e) {
    logger.warn(`[AI-MANAGER] No se pudo cargar feedback loop: ${e.message}`);
  }

  // ═══ BRAIN DIRECTIVES: leer directivas del Brain (supervisión jerárquica) ═══
  let brainDirectives = [];
  try {
    const directives = await StrategicDirective.find({
      status: 'active',
      expires_at: { $gt: now },
      source_insight_type: 'brain_supervision',
      $or: [
        { entity_id: adSetId },
        // Also get directives for individual ads within this ad set
        { entity_id: { $in: (creation.child_ad_ids || []) } }
      ]
    }).sort({ created_at: -1 }).lean();

    brainDirectives = directives.map(d => ({
      type: d.directive_type,
      target_action: d.target_action,
      target_entity_id: d.entity_id,
      target_entity_name: d.entity_name,
      reason: d.reason,
      confidence: d.confidence,
      score_modifier: d.score_modifier
    }));

    if (brainDirectives.length > 0) {
      logger.info(`[AI-MANAGER] ${brainDirectives.length} directivas del Brain activas para ${adSetId}`);
    }
  } catch (e) {
    logger.warn(`[AI-MANAGER] Error cargando directivas del Brain: ${e.message}`);
  }

  // Build context for Claude
  const context = {
    adset_id: adSetId,
    adset_name: creation.meta_entity_name,
    days_since_creation: Math.round(daysSinceCreation * 10) / 10,
    lifecycle_phase: creation.lifecycle_phase,
    current_budget: creation.current_budget || creation.initial_budget,
    current_status: creation.current_status,
    learning_ends_at: creation.learning_ends_at,
    is_in_learning: creation.learning_ends_at ? now < new Date(creation.learning_ends_at) : daysSinceCreation < 3,

    // 7d metrics
    adset_metrics_7d: {
      spend: adSetSpend,
      roas: Math.round(adSetRoas * 100) / 100,
      purchases: adSetPurchases,
      impressions: m7d.impressions || 0,
      ctr: m7d.ctr || 0,
      frequency: adSetFrequency,
      fatigue_level: adSetFrequency > 4 ? 'critical' : adSetFrequency > 3 ? 'high' : adSetFrequency > 2.5 ? 'moderate' : 'ok'
    },

    // 3d metrics (for trend)
    adset_metrics_3d: {
      spend: spend3d,
      roas: Math.round(roas3d * 100) / 100,
      purchases: purchases3d,
      ctr: m3d.ctr || 0,
      frequency: frequency3d
    },

    // Today metrics
    adset_metrics_today: {
      spend: mToday.spend || 0,
      roas: mToday.roas || 0,
      purchases: mToday.purchases || 0,
      impressions: mToday.impressions || 0
    },

    // Trend analysis
    trend: {
      roas_improving: roas3d > adSetRoas,
      frequency_rising: frequency3d > adSetFrequency,
      ctr_declining: (m3d.ctr || 0) < (m7d.ctr || 0)
    },

    // Individual ads with fatigue data
    ads: adsData,
    active_ads_count: adsData.filter(a => a.status === 'ACTIVE').length,
    fatigued_ads_count: adsData.filter(a => a.is_fatigued && a.status === 'ACTIVE').length,

    // Creative bank
    creative_bank: {
      total_available: availableCreatives.length,
      total_in_bank: allCreatives.length,
      unused_count: unusedCreatives.length,
      style_distribution: styleDistribution,
      styles_currently_running: currentStyles,
      available_for_this_adset: availableCreatives.slice(0, 15).map(c => ({
        id: c._id.toString(),
        headline: c.headline || c.original_name,
        style: c.style,
        ad_format: c.ad_format || 'unknown',
        product_name: c.product_name || '',
        product_line: c.product_line || '',
        flavor: c.flavor || '',
        scene_label: c.scene_label || '',
        generated_by: c.generated_by || 'manual',
        has_pair: !!c.paired_asset_id,
        tags: c.tags || [],
        avg_ctr: c.avg_ctr || 0,
        avg_roas: c.avg_roas || 0,
        times_used: c.times_used || 0
      }))
    },

    // Account comparison
    account_context: accountContext,

    // History
    previous_actions: (creation.lifecycle_actions || []).slice(-10),
    total_actions_taken: (creation.lifecycle_actions || []).length,

    // ═══ FEEDBACK LOOP DATA ═══
    // Past decisions with measured outcomes — use this to learn from your mistakes and successes
    action_history: actionHistory,
    action_history_summary: actionHistory.length > 0 ? {
      total_measured: actionHistory.length,
      improved: actionHistory.filter(a => a.result === 'improved').length,
      worsened: actionHistory.filter(a => a.result === 'worsened').length,
      neutral: actionHistory.filter(a => a.result === 'neutral').length,
      avg_roas_delta: actionHistory.filter(a => a.delta_roas_pct != null).length > 0
        ? Math.round(actionHistory.filter(a => a.delta_roas_pct != null).reduce((s, a) => s + a.delta_roas_pct, 0) / actionHistory.filter(a => a.delta_roas_pct != null).length * 10) / 10
        : null,
      success_rate_pct: actionHistory.length > 0
        ? Math.round(actionHistory.filter(a => a.result === 'improved').length / actionHistory.length * 100)
        : null
    } : null,

    // Which creative styles work best across all managed ad sets
    creative_performance_by_style: Object.keys(creativePerformance).length > 0 ? creativePerformance : null,

    // ═══ BRAIN STRATEGIC DIRECTIVES ═══
    // The Brain (strategic AI that analyzes the full account every 30 min) has issued these directives.
    // You MUST take them into account — the Brain has global visibility you don't have.
    // "boost" means the Brain wants you to favor that action. "suppress" means the Brain sees a risk.
    brain_directives: brainDirectives.length > 0 ? brainDirectives : null
  };

  // Ask Claude what to do
  let userMessage = `Manage this ad set. Pay special attention to frequency fatigue and whether creatives need refreshing.`;
  if (brainDirectives.length > 0) {
    userMessage += `\n\n⚠️ IMPORTANT: The Brain (global account strategist) has issued ${brainDirectives.length} directive(s) for this ad set. Review the "brain_directives" field and factor them into your decisions. The Brain sees the full account context and cross-ad-set patterns that you cannot see.`;
  }
  userMessage += `\n\n${JSON.stringify(context, null, 2)}`;

  let response;
  try {
    response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 3072,
      system: MANAGER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: userMessage
      }]
    });
  } catch (apiErr) {
    // Retry once on rate limit (same pattern as Brain)
    if (apiErr.status === 429) {
      logger.warn(`[AI-MANAGER] Claude rate limit for ${adSetId}. Waiting 15s...`);
      await new Promise(resolve => setTimeout(resolve, 15000));
      response = await client.messages.create({
        model: config.claude.model,
        max_tokens: 3072,
        system: MANAGER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      });
    } else {
      logger.error(`[AI-MANAGER] Claude API error for ${adSetId}: ${apiErr.message}`);
      return { actionsExecuted: 0, assessment: `Claude API error: ${apiErr.message}`, frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
    }
  }

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let decision;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    decision = JSON.parse(jsonMatch[0]);
  } catch (e) {
    logger.error(`[AI-MANAGER] Failed to parse Claude response for ${adSetId}`);
    logger.debug(`[AI-MANAGER] Raw response (first 500 chars): ${text.substring(0, 500)}`);
    return { actionsExecuted: 0, assessment: 'Error parsing response', frequency_status: 'unknown', performance_trend: 'unknown', needs_new_creatives: false };
  }

  // Metrics snapshot for ActionLog impact tracking
  const metricsAtExecution = {
    roas_7d: Math.round(adSetRoas * 100) / 100,
    roas_3d: Math.round(roas3d * 100) / 100,
    cpa_7d: adSetSpend > 0 && adSetPurchases > 0 ? Math.round(adSetSpend / adSetPurchases * 100) / 100 : 0,
    spend_7d: adSetSpend,
    daily_budget: creation.current_budget || creation.initial_budget,
    purchases_7d: adSetPurchases,
    purchase_value_7d: adSetPurchaseValue,
    frequency: adSetFrequency,
    ctr: m7d.ctr || 0
  };

  // Execute actions
  let actionsExecuted = 0;
  for (const action of (decision.actions || [])) {
    try {
      switch (action.type) {
        case 'scale_budget': {
          const prevBudget = creation.current_budget || creation.initial_budget;
          await meta.updateBudget(adSetId, action.new_budget);
          creation.current_budget = action.new_budget;
          creation.lifecycle_actions.push({
            action: 'scale_budget',
            value: action.new_budget,
            reason: action.reason,
            executed_at: new Date()
          });

          // Save to ActionLog for impact tracking
          await ActionLog.create({
            entity_type: 'adset',
            entity_id: adSetId,
            entity_name: creation.meta_entity_name,
            campaign_id: creation.parent_entity_id || '',
            campaign_name: creation.parent_entity_name || '',
            action: action.new_budget > prevBudget ? 'scale_up' : 'scale_down',
            before_value: prevBudget,
            after_value: action.new_budget,
            change_percent: prevBudget > 0 ? Math.round((action.new_budget - prevBudget) / prevBudget * 100) : 0,
            reasoning: action.reason,
            confidence: 'high',
            agent_type: 'ai_manager',
            success: true,
            executed_at: new Date(),
            metrics_at_execution: metricsAtExecution
          });

          logger.info(`[AI-MANAGER] ${adSetId}: Budget → $${action.new_budget} — ${action.reason}`);
          actionsExecuted++;
          break;
        }

        case 'pause_ad': {
          await meta.updateAdStatus(action.ad_id, 'PAUSED');
          creation.lifecycle_actions.push({
            action: 'pause_ad',
            value: action.ad_id,
            reason: action.reason,
            executed_at: new Date()
          });

          // Save to ActionLog
          const pausedAd = adsData.find(a => a.ad_id === action.ad_id);
          await ActionLog.create({
            entity_type: 'adset',
            entity_id: adSetId,
            entity_name: creation.meta_entity_name,
            campaign_id: creation.parent_entity_id || '',
            campaign_name: creation.parent_entity_name || '',
            action: 'pause',
            before_value: 'ACTIVE',
            after_value: 'PAUSED',
            reasoning: action.reason,
            target_entity_id: action.ad_id,
            target_entity_name: pausedAd?.ad_name || action.ad_id,
            confidence: 'high',
            agent_type: 'ai_manager',
            success: true,
            executed_at: new Date(),
            metrics_at_execution: metricsAtExecution
          });

          logger.info(`[AI-MANAGER] ${adSetId}: Paused ad ${action.ad_id} — ${action.reason}`);
          actionsExecuted++;
          break;
        }

        case 'add_ad': {
          const asset = await CreativeAsset.findById(action.asset_id);
          if (!asset) {
            logger.warn(`[AI-MANAGER] Asset ${action.asset_id} not found`);
            continue;
          }

          // Upload to Meta if needed
          if (!asset.uploaded_to_meta) {
            const upload = await meta.uploadImage(asset.file_path);
            asset.meta_image_hash = upload.image_hash;
            asset.uploaded_to_meta = true;
            asset.uploaded_at = new Date();
            await asset.save();
          }

          const pageId = await meta.getPageId();
          if (!pageId) continue;

          // Get website URL fallback from existing ads
          const websiteUrl = await meta.getWebsiteUrl();

          const creative = await meta.createAdCreative({
            page_id: pageId,
            image_hash: asset.meta_image_hash,
            headline: action.headline || asset.headline,
            body: action.body || asset.body || '',
            cta: action.cta || 'SHOP_NOW',
            link_url: asset.link_url || websiteUrl || ''
          });

          const adName = `${action.headline || asset.headline} - ${asset.style || 'mix'}`;
          const ad = await meta.createAd(adSetId, creative.creative_id, adName, 'ACTIVE');

          creation.child_ad_ids.push(ad.ad_id);
          creation.selected_creative_ids.push(asset._id.toString());
          creation.lifecycle_actions.push({
            action: 'add_ad',
            value: { ad_id: ad.ad_id, asset_id: action.asset_id, style: asset.style },
            reason: action.reason,
            executed_at: new Date()
          });

          // Save to ActionLog
          await ActionLog.create({
            entity_type: 'adset',
            entity_id: adSetId,
            entity_name: creation.meta_entity_name,
            campaign_id: creation.parent_entity_id || '',
            campaign_name: creation.parent_entity_name || '',
            action: 'create_ad',
            reasoning: action.reason,
            creative_asset_id: action.asset_id,
            new_entity_id: ad.ad_id,
            confidence: 'high',
            agent_type: 'ai_manager',
            success: true,
            executed_at: new Date(),
            metrics_at_execution: metricsAtExecution
          });

          asset.times_used = (asset.times_used || 0) + 1;
          asset.used_in_ads.push(ad.ad_id);
          await asset.save();

          logger.info(`[AI-MANAGER] ${adSetId}: Added new ad ${ad.ad_id} (${asset.style}) — ${action.reason}`);
          actionsExecuted++;
          break;
        }

        case 'kill_adset': {
          await meta.updateStatus(adSetId, 'PAUSED');
          creation.current_status = 'PAUSED';
          creation.lifecycle_phase = 'dead';
          creation.lifecycle_actions.push({
            action: 'kill',
            value: null,
            reason: action.reason,
            executed_at: new Date()
          });

          // Save to ActionLog
          await ActionLog.create({
            entity_type: 'adset',
            entity_id: adSetId,
            entity_name: creation.meta_entity_name,
            campaign_id: creation.parent_entity_id || '',
            campaign_name: creation.parent_entity_name || '',
            action: 'pause',
            before_value: 'ACTIVE',
            after_value: 'KILLED',
            reasoning: action.reason,
            confidence: 'high',
            agent_type: 'ai_manager',
            success: true,
            executed_at: new Date(),
            metrics_at_execution: metricsAtExecution
          });

          logger.info(`[AI-MANAGER] ${adSetId}: KILLED — ${action.reason}`);
          actionsExecuted++;
          break;
        }
      }
    } catch (actionErr) {
      logger.error(`[AI-MANAGER] Error executing ${action.type} on ${adSetId}: ${actionErr.message}`);
    }
  }

  // ═══ DIRECTIVE ENFORCEMENT: si Claude ignoró suppress+pause, forzar acción ═══
  // El Brain puede enviar múltiples directivas suppress+pause. Si Claude no tomó acción
  // (0 acciones ejecutadas o no hay kill/pause/scale_down), forzamos la decisión.
  const suppressPauseDirectives = brainDirectives.filter(d =>
    d.type === 'suppress' && d.target_action === 'pause'
  );

  if (suppressPauseDirectives.length >= 3 && actionsExecuted === 0) {
    // Claude ignoró directivas SUPPRESS+pause repetidas — forzar acción
    logger.warn(`[AI-MANAGER][ENFORCE] Claude ignoró ${suppressPauseDirectives.length} directivas suppress+pause para ${creation.meta_entity_name}. Forzando acción.`);

    const activeAds = adsData.filter(a => a.status === 'ACTIVE');
    const deadAdsCount = activeAds.filter(a => a.purchases === 0 || a.roas < 0.5).length;
    const allAdsDead = activeAds.length > 0 && deadAdsCount === activeAds.length;
    const mostAdsDead = activeAds.length > 0 && deadAdsCount >= activeAds.length * 0.6;
    const daysActive = daysSinceCreation;

    if ((allAdsDead || (mostAdsDead && suppressPauseDirectives.length >= 10)) && daysActive >= 5 && adSetSpend >= 40) {
      // Todos los ads muertos + suficiente tiempo/gasto → kill
      try {
        await meta.updateStatus(adSetId, 'PAUSED');
        creation.current_status = 'PAUSED';
        creation.lifecycle_phase = 'dead';
        creation.lifecycle_actions.push({
          action: 'kill',
          value: null,
          reason: `[ENFORCED] ${suppressPauseDirectives.length} directivas suppress+pause del Brain ignoradas por Claude. Todos los ads sin rendimiento. Kill forzado.`,
          executed_at: new Date()
        });

        await ActionLog.create({
          entity_type: 'adset',
          entity_id: adSetId,
          entity_name: creation.meta_entity_name,
          campaign_id: creation.parent_entity_id || '',
          campaign_name: creation.parent_entity_name || '',
          action: 'pause',
          before_value: 'ACTIVE',
          after_value: 'KILLED',
          reasoning: `[ENFORCED] ${suppressPauseDirectives.length} directivas suppress+pause ignoradas. ROAS ${adSetRoas.toFixed(2)}x, ${adSetPurchases} compras en ${daysActive.toFixed(0)}d, $${adSetSpend.toFixed(0)} gastado.`,
          confidence: 'high',
          agent_type: 'ai_manager',
          success: true,
          executed_at: new Date(),
          metrics_at_execution: metricsAtExecution
        });

        actionsExecuted++;
        logger.error(`[AI-MANAGER][ENFORCE] KILL FORZADO: ${creation.meta_entity_name} — ${suppressPauseDirectives.length} directivas ignoradas, todos los ads muertos`);
      } catch (killErr) {
        logger.error(`[AI-MANAGER][ENFORCE] Error en kill forzado de ${adSetId}: ${killErr.message}`);
      }
    } else if ((adSetRoas < 2.0 || suppressPauseDirectives.length >= 10) && daysActive >= 4) {
      // ROAS bajo o directivas masivas → scale down agresivo (50%)
      const currentBudget = creation.current_budget || creation.initial_budget;
      const newBudget = Math.max(10, Math.round(currentBudget * 0.5));
      try {
        await meta.updateBudget(adSetId, newBudget);
        creation.current_budget = newBudget;
        creation.lifecycle_actions.push({
          action: 'scale_budget',
          value: newBudget,
          reason: `[ENFORCED] ${suppressPauseDirectives.length} directivas suppress+pause del Brain ignoradas. Scale down forzado $${currentBudget}→$${newBudget}.`,
          executed_at: new Date()
        });

        await ActionLog.create({
          entity_type: 'adset',
          entity_id: adSetId,
          entity_name: creation.meta_entity_name,
          campaign_id: creation.parent_entity_id || '',
          campaign_name: creation.parent_entity_name || '',
          action: 'scale_down',
          before_value: currentBudget,
          after_value: newBudget,
          change_percent: Math.round((newBudget - currentBudget) / currentBudget * 100),
          reasoning: `[ENFORCED] ${suppressPauseDirectives.length} directivas suppress+pause ignoradas. ROAS ${adSetRoas.toFixed(2)}x bajo. Scale down forzado.`,
          confidence: 'high',
          agent_type: 'ai_manager',
          success: true,
          executed_at: new Date(),
          metrics_at_execution: metricsAtExecution
        });

        actionsExecuted++;
        logger.warn(`[AI-MANAGER][ENFORCE] SCALE DOWN FORZADO: ${creation.meta_entity_name} $${currentBudget}→$${newBudget} — ${suppressPauseDirectives.length} directivas ignoradas`);
      } catch (scaleErr) {
        logger.error(`[AI-MANAGER][ENFORCE] Error en scale down forzado de ${adSetId}: ${scaleErr.message}`);
      }
    }
  }

  // ═══ REMOVED: duplicate lifecycle phase update ═══
  // Phase transitions are now handled ONLY by the Lifecycle Manager to avoid conflicts.
  // The AI Manager focuses on tactical actions (pause ads, scale budget, add creatives).

  // Update metrics at checkpoints
  if (daysSinceCreation >= 1 && !creation.measured_1d) {
    creation.metrics_1d = {
      roas_7d: adSetRoas, spend: adSetSpend,
      impressions: m7d.impressions || 0,
      purchases: adSetPurchases,
      ctr: m7d.ctr || 0,
      frequency: adSetFrequency
    };
    creation.measured_1d = true;
    creation.measured_1d_at = new Date();
  }
  if (daysSinceCreation >= 3 && !creation.measured_3d) {
    creation.metrics_3d = {
      roas_7d: adSetRoas, spend: adSetSpend,
      impressions: m7d.impressions || 0,
      purchases: adSetPurchases,
      ctr: m7d.ctr || 0,
      frequency: adSetFrequency
    };
    creation.measured_3d = true;
    creation.measured_3d_at = new Date();
  }
  if (daysSinceCreation >= 7 && !creation.measured_7d) {
    creation.metrics_7d = {
      roas_7d: adSetRoas, spend: adSetSpend,
      impressions: m7d.impressions || 0,
      purchases: adSetPurchases,
      ctr: m7d.ctr || 0,
      frequency: adSetFrequency
    };
    creation.measured_7d = true;
    creation.measured_7d_at = new Date();

    // Auto-verdict at 7d
    if (adSetRoas >= 2) creation.verdict = 'positive';
    else if (adSetRoas >= 1) creation.verdict = 'neutral';
    else creation.verdict = 'negative';
    creation.verdict_reason = decision.assessment || '';
  }

  // Store last manager assessment
  creation.last_manager_assessment = decision.assessment || '';
  creation.last_manager_frequency_status = decision.frequency_status || 'unknown';
  creation.last_manager_check = new Date();

  creation.updated_at = new Date();
  // Only update lifecycle_phase_changed_at if phase actually changed (via Lifecycle Manager)
  // NOT on every AI Manager cycle — this was corrupting phase duration tracking
  await creation.save();

  if (actionsExecuted > 0) {
    logger.info(`[AI-MANAGER] ${creation.meta_entity_name}: ${actionsExecuted} acciones ejecutadas — ${decision.assessment}`);
  }

  return {
    actionsExecuted,
    assessment: decision.assessment || '',
    frequency_status: decision.frequency_status || 'unknown',
    performance_trend: decision.performance_trend || 'unknown',
    needs_new_creatives: decision.needs_new_creatives || false
  };
}

/**
 * Get status of all managed ad sets without running actions
 */
async function getManagerStatus() {
  const managed = await AICreation.find({
    creation_type: 'create_adset',
    managed_by_ai: true
  }).sort({ created_at: -1 }).lean();

  return managed.map(m => ({
    _id: m._id,
    adset_id: m.meta_entity_id,
    adset_name: m.meta_entity_name,
    phase: m.lifecycle_phase,
    status: m.current_status,
    verdict: m.verdict,
    budget: m.current_budget || m.initial_budget,
    initial_budget: m.initial_budget,
    days_active: Math.round((Date.now() - new Date(m.created_at)) / (1000 * 60 * 60 * 24) * 10) / 10,
    ads_count: m.child_ad_ids?.length || 0,
    actions_count: m.lifecycle_actions?.length || 0,
    last_assessment: m.last_manager_assessment || '',
    last_frequency_status: m.last_manager_frequency_status || 'unknown',
    last_check: m.last_manager_check || null,
    metrics_1d: m.metrics_1d || null,
    metrics_3d: m.metrics_3d || null,
    metrics_7d: m.metrics_7d || null,
    lifecycle_actions: m.lifecycle_actions || [],
    strategy_summary: m.strategy_summary || '',
    learning_ends_at: m.learning_ends_at,
    parent_entity_id: m.parent_entity_id,
    parent_entity_name: m.parent_entity_name,
    selected_creative_ids: m.selected_creative_ids || [],
    child_ad_ids: m.child_ad_ids || [],
    created_at: m.created_at,
    updated_at: m.updated_at
  }));
}

/**
 * Get enriched status with metrics from MongoDB snapshots (zero Meta API calls).
 * Data is refreshed every 10 min by the DataCollector cron job.
 */
async function getManagerStatusLive() {
  logger.info('[AI-MANAGER-LIVE] Fetching manager status from MongoDB snapshots...');
  const managed = await getManagerStatus();
  if (managed.length === 0) {
    logger.info('[AI-MANAGER-LIVE] No managed ad sets found');
    return { managed: [], campaign: null };
  }

  logger.info(`[AI-MANAGER-LIVE] Found ${managed.length} managed ad sets, reading from DB...`);

  // Fetch campaign metrics from latest snapshot
  let campaignMetrics = null;
  const campaignId = managed[0]?.parent_entity_id;
  if (campaignId) {
    const campSnap = await MetricSnapshot.findOne({ entity_type: 'campaign', entity_id: campaignId })
      .sort({ snapshot_at: -1 }).lean();
    if (campSnap) {
      const m7 = campSnap.metrics?.last_7d || {};
      campaignMetrics = {
        campaign_id: campaignId,
        campaign_name: campSnap.entity_name || managed[0]?.parent_entity_name || '',
        spend: m7.spend || 0,
        impressions: m7.impressions || 0,
        clicks: m7.clicks || 0,
        ctr: m7.ctr || 0,
        reach: m7.reach || 0,
        frequency: m7.frequency || 0,
        purchases: m7.purchases || 0,
        purchase_value: m7.purchase_value || 0,
        roas: m7.roas || 0,
        snapshot_age_min: Math.round((Date.now() - new Date(campSnap.snapshot_at).getTime()) / 60000)
      };
      logger.info(`[AI-MANAGER-LIVE] Campaign ${campaignId}: spend=$${campaignMetrics.spend}, ROAS=${campaignMetrics.roas}`);
    }
  }

  // Enrich ad sets from MongoDB snapshots — zero API calls
  const enriched = await Promise.all(managed.map(async (item) => {
    const adSetId = item.adset_id;

    // Get latest adset snapshot
    const adSetSnap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: adSetId })
      .sort({ snapshot_at: -1 }).lean();

    const m7 = adSetSnap?.metrics?.last_7d || {};
    const m3 = adSetSnap?.metrics?.last_3d || {};

    const liveMetrics = adSetSnap ? {
      spend: m7.spend || 0,
      impressions: m7.impressions || 0,
      clicks: m7.clicks || 0,
      ctr: m7.ctr || 0,
      cpm: m7.cpm || 0,
      cpc: m7.cpc || 0,
      reach: m7.reach || 0,
      frequency: m7.frequency || 0,
      purchases: m7.purchases || 0,
      purchase_value: m7.purchase_value || 0,
      roas: m7.roas || 0,
      cpa: m7.cpa || 0
    } : null;

    const liveMetrics3d = adSetSnap ? {
      spend: m3.spend || 0,
      impressions: m3.impressions || 0,
      clicks: m3.clicks || 0,
      ctr: m3.ctr || 0,
      frequency: m3.frequency || 0,
      purchases: m3.purchases || 0,
      purchase_value: m3.purchase_value || 0,
      roas: m3.roas || 0
    } : null;

    // Get ads from MongoDB snapshots
    const adSnapshots = await getAdsForAdSet(adSetId);
    let adsPerformance = [];

    if (adSnapshots.length > 0) {
      adsPerformance = await Promise.all(adSnapshots.map(async (adSnap) => {
        const am7 = adSnap.metrics?.last_7d || {};

        // Try to find matching creative asset
        const adIndex = item.child_ad_ids?.indexOf(adSnap.entity_id);
        const matchedAssetId = adIndex >= 0 ? item.selected_creative_ids?.[adIndex] : null;
        let assetInfo = null;
        if (matchedAssetId) {
          try {
            const asset = await CreativeAsset.findById(matchedAssetId).lean();
            if (asset) {
              assetInfo = {
                asset_id: asset._id.toString(),
                filename: asset.filename,
                style: asset.style,
                headline: asset.headline || asset.original_name
              };
            }
          } catch (e) { /* ok */ }
        }

        return {
          ad_id: adSnap.entity_id,
          ad_name: adSnap.entity_name,
          status: adSnap.status,
          metrics: {
            spend: am7.spend || 0,
            impressions: am7.impressions || 0,
            clicks: am7.clicks || 0,
            ctr: am7.ctr || 0,
            frequency: am7.frequency || 0,
            purchases: am7.purchases || 0,
            purchase_value: am7.purchase_value || 0,
            roas: am7.roas || 0
          },
          asset: assetInfo
        };
      }));
    }

    return {
      ...item,
      live_metrics_7d: liveMetrics,
      live_metrics_3d: liveMetrics3d,
      ads_performance: adsPerformance,
      snapshot_age_min: adSetSnap ? Math.round((Date.now() - new Date(adSetSnap.snapshot_at).getTime()) / 60000) : null
    };
  }));

  const withData = enriched.filter(e => e.live_metrics_7d);
  logger.info(`[AI-MANAGER-LIVE] Done. ${withData.length} ad sets with data (0 API calls). Campaign: ${campaignMetrics ? 'OK' : 'N/A'}`);
  return { managed: enriched, campaign: campaignMetrics };
}

module.exports = { runManager, manageAdSet, getManagerStatus, getManagerStatusLive };
