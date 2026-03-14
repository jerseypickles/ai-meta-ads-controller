const SystemConfig = require('../../db/models/SystemConfig');
const ActionLog = require('../../db/models/ActionLog');
const { getPendingLearningActions } = require('../../db/queries');
const unifiedPolicyConfig = require('../../../config/unified-policy');
const kpiTargets = require('../../../config/kpi-targets');
const logger = require('../../utils/logger');

class PolicyLearner {
  constructor() {
    this.config = unifiedPolicyConfig.learning || {};
    this.stateKey = `unified_policy_learning_${this.config.version || 'v1'}`;
  }

  async consumeImpactFeedback(limit = 200) {
    if (!this.config.enabled) {
      return { processed: 0, averageReward: 0, state: await this.loadState() };
    }

    const state = await this.loadState();
    const pending = await getPendingLearningActions(limit);

    if (!pending.length) {
      return { processed: 0, averageReward: 0, state };
    }

    const now = new Date();
    const updates = [];
    let rewardTotal = 0;
    let processed = 0;

    for (const action of pending) {
      let reward = this._calculateReward(action);
      if (reward == null) {
        continue;
      }

      // Fix 4 — Learning Loop: detect concurrent actions and discount reward
      let overlapCount = 0;
      if (action.entity_id && action.executed_at) {
        try {
          const execTime = new Date(action.executed_at).getTime();
          overlapCount = await ActionLog.countDocuments({
            entity_id: action.entity_id,
            _id: { $ne: action._id },
            success: true,
            executed_at: {
              $gte: new Date(execTime - 7 * 86400000),
              $lte: new Date(execTime + 7 * 86400000)
            }
          });
        } catch { /* non-fatal — no discount applied */ }
      }
      if (overlapCount > 0) {
        const overlapDiscount = 1 / (1 + overlapCount);
        reward *= overlapDiscount;
      }

      const execDate = action.executed_at ? new Date(action.executed_at) : new Date();
      const context = {
        hour: execDate.getHours(),
        seasonal_event: this._isSeasonalDate(execDate),
        account_roas_7d: toNumber((action.metrics_at_execution || {}).roas_7d)
      };
      const bucket = this.bucketFromMetrics(action.metrics_at_execution || {}, context);

      if (action._is_7d_relearn) {
        // Re-learning: undo old 3d reward, apply new 7d reward (correction signal)
        const oldReward = toNumber(action.learned_reward, 0);
        this._updateBucketStats(state, bucket, action.action, reward - oldReward);
        updates.push({
          updateOne: {
            filter: { _id: action._id },
            update: {
              $set: {
                learned_7d_at: now,
                learned_7d_reward: reward,
                learned_reward: reward, // Update to 7d-based reward
                learned_bucket: bucket,
                learned_overlap_count: overlapCount
              }
            }
          }
        });
      } else {
        // First-time learning with 3d data
        this._updateBucketStats(state, bucket, action.action, reward);
        updates.push({
          updateOne: {
            filter: { _id: action._id },
            update: {
              $set: {
                learned_at: now,
                learned_reward: reward,
                learned_bucket: bucket,
                learned_overlap_count: overlapCount
              }
            }
          }
        });
      }

      rewardTotal += reward;
      processed += 1;
    }

    if (updates.length > 0) {
      await ActionLog.bulkWrite(updates, { ordered: false });
    }

    state.updated_at = now.toISOString();
    state.total_samples = toNumber(state.total_samples) + processed;
    await this.saveState(state);

    const averageReward = processed > 0 ? rewardTotal / processed : 0;
    logger.info(`[UNIFIED][LEARN] Feedback procesado: ${processed} acciones, reward medio ${averageReward.toFixed(4)}`);
    return { processed, averageReward, state };
  }

  async loadState() {
    const defaultState = {
      version: this.config.version || 'v1',
      buckets: {},
      total_samples: 0,
      updated_at: null
    };

    const loaded = await SystemConfig.get(this.stateKey, defaultState);
    if (!loaded || typeof loaded !== 'object') {
      return defaultState;
    }

    if (!loaded.buckets || typeof loaded.buckets !== 'object') {
      loaded.buckets = {};
    }
    return loaded;
  }

  async saveState(state) {
    await SystemConfig.set(this.stateKey, state, 'unified_policy');
  }

  bucketFromMetrics(metrics, context = {}) {
    const roas = toNumber(metrics.roas_7d);
    const cpa = toNumber(metrics.cpa_7d);
    const frequency = toNumber(metrics.frequency);
    const spend7d = toNumber(metrics.spend_7d);
    const purchases7d = toNumber(metrics.purchases_7d);

    // FIX 3: Reducir de 8 a 5 dimensiones para concentrar muestras.
    // Antes: 12,960 buckets posibles con 4,803 muestras = 0.4 muestras/bucket.
    // Ahora: 405 buckets posibles = ~12 muestras/bucket → aprendizaje real.
    // Se eliminan hour, seasonal, account_stress — baja señal, alta fragmentación.
    const roasBand = roas >= 4 ? 'roas_high' : roas >= 2 ? 'roas_mid' : 'roas_low';
    const cpaBand = cpa > 0 && cpa <= 25 ? 'cpa_good' : cpa > 50 ? 'cpa_bad' : 'cpa_mid';
    const frequencyBand = frequency >= 4 ? 'freq_critical' : frequency >= 2.5 ? 'freq_warning' : 'freq_ok';
    const spendBand = spend7d >= 300 ? 'spend_high' : spend7d >= 80 ? 'spend_mid' : 'spend_low';
    const conversionBand = purchases7d >= 15 ? 'conv_high' : purchases7d >= 5 ? 'conv_mid' : 'conv_low';

    return `${roasBand}|${cpaBand}|${frequencyBand}|${spendBand}|${conversionBand}`;
  }

  getActionBias(state, bucket, action) {
    const bucketState = state?.buckets?.[bucket];
    if (!bucketState || !bucketState[action]) {
      return { bias: 0, mean: 0.5, confidence: 0 };
    }

    const stats = bucketState[action];
    const alpha = toNumber(stats.alpha, 1);
    const beta = toNumber(stats.beta, 1);
    const mean = alpha / (alpha + beta);
    const count = toNumber(stats.count);

    const confidence = clamp(count / 25, 0, 1);

    const totalBucketSamples = Object.values(bucketState)
      .reduce((sum, item) => sum + toNumber(item.count), 0);
    const exploration = Math.sqrt((2 * Math.log(totalBucketSamples + 2)) / (count + 1));

    // mean is [0..1]. Convert to a score delta centered at 0.
    // Scale exploit by confidence so mature buckets have stronger voice.
    const exploit = (mean - 0.5) * (0.3 + confidence * 0.25);
    const explore = Math.min(0.08, exploration * 0.02);
    const bias = clamp(exploit + explore, -0.35, 0.35);

    return { bias, mean, confidence };
  }

  _updateBucketStats(state, bucket, action, reward) {
    if (!state.buckets[bucket]) {
      state.buckets[bucket] = {};
    }
    if (!state.buckets[bucket][action]) {
      state.buckets[bucket][action] = {
        alpha: toNumber(this.config.prior_alpha, 1),
        beta: toNumber(this.config.prior_beta, 1),
        count: 0,
        total_reward: 0,
        last_reward: 0
      };
    }

    const stats = state.buckets[bucket][action];
    const normalized = clamp((reward + 1) / 2, 0, 1);
    stats.alpha = toNumber(stats.alpha, 1) + normalized;
    stats.beta = toNumber(stats.beta, 1) + (1 - normalized);
    stats.count = toNumber(stats.count) + 1;
    stats.total_reward = toNumber(stats.total_reward) + reward;
    stats.last_reward = reward;
  }

  _calculateReward(action) {
    // Select correct before/after based on action type for accurate attribution
    let before, after;

    if (action.action === 'create_ad') {
      // create_ad: metrics_at_execution = parent adset BEFORE adding ad
      // metrics_after_Xd = parent adset AFTER — did diversification help?
      before = action.metrics_at_execution || {};
      after = (action.impact_7d_measured && action.metrics_after_7d?.roas_7d > 0)
        ? action.metrics_after_7d
        : (action.metrics_after_3d || {});
    } else if (['pause', 'update_ad_status'].includes(action.action) && action.parent_adset_id) {
      // Ad-level pause: measure impact on PARENT adset (the ad itself is paused, irrelevant)
      before = action.parent_metrics_at_execution || {};
      after = (action.impact_7d_measured && action.parent_metrics_after_7d?.roas_7d > 0)
        ? action.parent_metrics_after_7d
        : (action.parent_metrics_after_3d || {});
    } else {
      // Default: adset-level actions (scale_up, scale_down, etc.)
      before = action.metrics_at_execution || {};
      after = (action.impact_7d_measured && action.metrics_after_7d?.roas_7d > 0)
        ? action.metrics_after_7d
        : (action.metrics_after_3d || {});
    }

    const roasBefore = toNumber(before.roas_7d);
    const roasAfter = toNumber(after.roas_7d);
    const cpaBefore = toNumber(before.cpa_7d);
    const cpaAfter = toNumber(after.cpa_7d);
    const spendBefore = toNumber(before.spend_7d);
    const spendAfter = toNumber(after.spend_7d);
    const purchasesBefore = toNumber(before.purchases_7d);
    const purchasesAfter = toNumber(after.purchases_7d);

    // Need at least one useful delta signal.
    if (roasBefore <= 0 && cpaBefore <= 0 && spendBefore <= 0) {
      return null;
    }

    const roasDelta = roasBefore > 0 ? (roasAfter - roasBefore) / roasBefore : 0;
    const cpaDelta = cpaBefore > 0 ? (cpaBefore - cpaAfter) / cpaBefore : 0;
    const spendDelta = spendBefore > 0 ? (spendAfter - spendBefore) / spendBefore : 0;
    const purchaseDelta = purchasesBefore > 0 ? (purchasesAfter - purchasesBefore) / purchasesBefore : 0;

    const weights = this.config.reward_weights || { roas: 0.7, cpa: 0.3 };
    let rawReward = (toNumber(weights.roas, 0.7) * roasDelta) + (toNumber(weights.cpa, 0.3) * cpaDelta);

    // Action-aware reinforcement: growth actions should increase profitable volume,
    // efficiency actions should reduce waste while preserving ROAS.
    if (['scale_up', 'reactivate', 'duplicate_adset'].includes(action.action)) {
      rawReward += (0.15 * spendDelta) + (0.10 * purchaseDelta);
    } else if (['scale_down'].includes(action.action)) {
      rawReward += (0.15 * (-spendDelta)) + (0.10 * cpaDelta);
    } else if (['pause', 'update_ad_status'].includes(action.action)) {
      // Pause actions: reward parent adset improvement (already using parent metrics above)
      rawReward += (0.15 * (-spendDelta)) + (0.10 * cpaDelta);
    } else if (['create_ad', 'update_ad_creative'].includes(action.action)) {
      // Creative actions: CTR improvement + parent adset purchase growth
      const ctrBefore = toNumber(before.ctr);
      const ctrAfter = toNumber(after.ctr);
      const ctrDelta = ctrBefore > 0 ? (ctrAfter - ctrBefore) / ctrBefore : 0;
      rawReward += (0.15 * ctrDelta) + (0.10 * purchaseDelta);
    } else if (action.action === 'move_budget') {
      // Budget redistribution: combine source + target deltas
      const targetBefore = action.target_metrics_at_execution || {};
      const targetAfter = (action.impact_7d_measured && action.target_metrics_after_7d?.roas_7d > 0)
        ? action.target_metrics_after_7d
        : (action.target_metrics_after_3d || {});
      const targetRoasBefore = toNumber(targetBefore.roas_7d);
      const targetRoasAfter = toNumber(targetAfter.roas_7d);
      const targetRoasDelta = targetRoasBefore > 0 ? (targetRoasAfter - targetRoasBefore) / targetRoasBefore : 0;
      // Weighted combination: 50% source + 50% target
      rawReward += (0.10 * roasDelta) + (0.10 * targetRoasDelta);
    } else if (action.action === 'update_bid_strategy') {
      // Bid strategy: reward CPA improvement + spend efficiency
      rawReward += (0.15 * cpaDelta) + (0.10 * (-spendDelta));
    }

    // Penalize uncertain decisions so the learner converges to robust policies.
    rawReward -= toNumber(action.uncertainty_score, 0) * 0.08;

    // Magnitude-aware reward: scale the signal by how large the change was.
    const absMagnitude = Math.abs(toNumber(action.change_percent, 0));
    if (absMagnitude > 0 && ['scale_up', 'scale_down', 'move_budget'].includes(action.action)) {
      const magnitudeMultiplier = 1 + clamp((absMagnitude - 10) / 80, 0, 0.5);
      rawReward *= magnitudeMultiplier;
    }

    return clamp(
      rawReward,
      toNumber(this.config.reward_clip_min, -1),
      toNumber(this.config.reward_clip_max, 1)
    );
  }

  /**
   * Detecta si una fecha cae dentro de un evento estacional definido en kpi-targets.
   * Retorna el nombre del evento o null.
   */
  _isSeasonalDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const mmdd = `${mm}-${dd}`;

    for (const event of (kpiTargets.seasonal_events || [])) {
      if (event.date && event.date === mmdd) {
        return event.name;
      }
      if (event.start && event.end && mmdd >= event.start && mmdd <= event.end) {
        return event.name;
      }
    }
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = PolicyLearner;
