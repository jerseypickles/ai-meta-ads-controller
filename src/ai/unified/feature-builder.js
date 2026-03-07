const { computeStatisticalConfidence } = require('./statistical-confidence');
const { applyAttributionCorrection } = require('./attribution-model');

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function buildFeatureSet({ adSetSnapshots, adSnapshots, accountOverview, recentActions, activeCooldowns }) {
  const cooldownMap = new Map((activeCooldowns || []).map(cd => [cd.entity_id, cd]));
  const recentActionMap = buildRecentActionMap(recentActions || []);
  const adsetById = new Map((adSetSnapshots || []).map(s => [s.entity_id, s]));

  const creativeStatsByAdSet = buildCreativeStatsByAdSet(adSnapshots || []);
  const siblingSignalsByAd = buildSiblingSignalsByAd(adSnapshots || [], creativeStatsByAdSet);

  const adSetFeatures = (adSetSnapshots || []).map((adset) => {
    const metrics = mapMetrics(adset.metrics || {});
    const analysis = adset.analysis || {};
    const creativeStats = creativeStatsByAdSet.get(adset.entity_id) || emptyCreativeStats();
    const dataQualityScore = computeDataQuality(metrics);
    const roasVolatility = computeRoasVolatility(metrics.roas_3d, metrics.roas_7d);
    const creativeFatigueScore = computeCreativeFatigueScore({
      frequency_7d: metrics.frequency_7d,
      ctr_vs_average: toNumber(analysis.ctr_vs_average),
      roas_3d_vs_7d: toNumber(analysis.roas_3d_vs_7d),
      top_creative_share_7d: creativeStats.top_creative_share_7d
    });

    // Statistical confidence + attribution correction
    const statConfidence = computeStatisticalConfidence(metrics);
    const attribution = applyAttributionCorrection(metrics);

    return {
      entity_type: 'adset',
      entity_id: adset.entity_id,
      entity_name: adset.entity_name,
      campaign_id: adset.campaign_id,
      parent_id: adset.parent_id || null,
      status: adset.status,
      current_budget: toNumber(adset.daily_budget),
      account: {
        roas_7d: toNumber(accountOverview?.roas_7d),
        roas_14d: toNumber(accountOverview?.roas_14d),
        spend_today: toNumber(accountOverview?.today_spend),
        total_daily_budget: toNumber(accountOverview?.total_daily_budget)
      },
      metrics,
      derived: {
        roas_trend: analysis.roas_trend || 'stable',
        roas_3d_vs_7d: toNumber(analysis.roas_3d_vs_7d),
        frequency_alert: Boolean(analysis.frequency_alert),
        ctr_vs_average: toNumber(analysis.ctr_vs_average),
        spend_velocity: toNumber(analysis.spend_velocity),
        roas_volatility: roasVolatility,
        data_quality_score: dataQualityScore,
        cpa_pressure: metrics.cpa_7d > 0 ? round(metrics.cpa_7d / Math.max(metrics.cpa_14d || metrics.cpa_7d, 1), 4) : 0,
        creative_count_7d: creativeStats.creative_count_7d,
        top_creative_share_7d: creativeStats.top_creative_share_7d,
        creative_roas_spread_7d: creativeStats.creative_roas_spread_7d,
        creative_ctr_avg_7d: creativeStats.creative_ctr_avg_7d,
        creative_fatigue_score: creativeFatigueScore,
        statistical_confidence: statConfidence.confidence_level,
        confidence_label: statConfidence.confidence_label,
        roas_interval: statConfidence.roas_interval,
        attribution_maturity: attribution.attribution_maturity.score,
        roas_7d_corrected: attribution.corrected_roas.roas_7d_corrected,
        roas_3d_corrected: attribution.corrected_roas.roas_3d_corrected
      },
      statistical_confidence: statConfidence,
      attribution: attribution,
      cooldown: cooldownMap.get(adset.entity_id) || null,
      recent_action: recentActionMap.get(adset.entity_id) || null
    };
  });

  const adFeatures = (adSnapshots || []).map((ad) => {
    const metrics = mapMetrics(ad.metrics || {});
    const analysis = ad.analysis || {};
    const parentAdSet = adsetById.get(ad.parent_id);
    const siblingSignals = siblingSignalsByAd.get(ad.entity_id) || emptySiblingSignals();
    const dataQualityScore = computeDataQuality(metrics);
    const roasVolatility = computeRoasVolatility(metrics.roas_3d, metrics.roas_7d);

    return {
      entity_type: 'ad',
      entity_id: ad.entity_id,
      entity_name: ad.entity_name,
      campaign_id: ad.campaign_id,
      parent_id: ad.parent_id || null,
      status: ad.status || 'ACTIVE',
      current_budget: toNumber(parentAdSet?.daily_budget),
      account: {
        roas_7d: toNumber(accountOverview?.roas_7d),
        roas_14d: toNumber(accountOverview?.roas_14d),
        spend_today: toNumber(accountOverview?.today_spend),
        total_daily_budget: toNumber(accountOverview?.total_daily_budget)
      },
      metrics,
      derived: {
        roas_trend: analysis.roas_trend || 'stable',
        roas_3d_vs_7d: toNumber(analysis.roas_3d_vs_7d),
        frequency_alert: Boolean(analysis.frequency_alert),
        ctr_vs_average: toNumber(analysis.ctr_vs_average),
        spend_velocity: toNumber(analysis.spend_velocity),
        roas_volatility: roasVolatility,
        data_quality_score: dataQualityScore,
        sibling_roas_gap: siblingSignals.sibling_roas_gap,
        sibling_ctr_gap: siblingSignals.sibling_ctr_gap,
        sibling_spend_share_7d: siblingSignals.sibling_spend_share_7d,
        sibling_count_7d: siblingSignals.sibling_count_7d,
        top_creative_share_7d: siblingSignals.top_creative_share_7d,
        creative_fatigue_score: computeCreativeFatigueScore({
          frequency_7d: metrics.frequency_7d,
          ctr_vs_average: toNumber(analysis.ctr_vs_average),
          roas_3d_vs_7d: toNumber(analysis.roas_3d_vs_7d),
          top_creative_share_7d: siblingSignals.top_creative_share_7d
        })
      },
      cooldown: cooldownMap.get(ad.entity_id) || null,
      recent_action: recentActionMap.get(ad.entity_id) || null
    };
  });

  return [...adSetFeatures, ...adFeatures];
}

function mapMetrics(metrics) {
  const today = metrics.today || {};
  const last3d = metrics.last_3d || {};
  const last7d = metrics.last_7d || {};
  const last14d = metrics.last_14d || {};
  const last30d = metrics.last_30d || {};

  return {
    spend_today: toNumber(today.spend),
    spend_3d: toNumber(last3d.spend),
    spend_7d: toNumber(last7d.spend),
    spend_14d: toNumber(last14d.spend),
    spend_30d: toNumber(last30d.spend),
    impressions_7d: toNumber(last7d.impressions),
    clicks_7d: toNumber(last7d.clicks),
    roas_today: toNumber(today.roas),
    roas_3d: toNumber(last3d.roas),
    roas_7d: toNumber(last7d.roas),
    roas_14d: toNumber(last14d.roas),
    roas_30d: toNumber(last30d.roas),
    cpa_3d: toNumber(last3d.cpa),
    cpa_7d: toNumber(last7d.cpa),
    cpa_14d: toNumber(last14d.cpa),
    ctr_7d: toNumber(last7d.ctr),
    frequency_7d: toNumber(last7d.frequency),
    purchases_7d: toNumber(last7d.purchases),
    purchase_value_7d: toNumber(last7d.purchase_value)
  };
}

function computeDataQuality(metrics) {
  const spendSignal = clamp(metrics.spend_7d / 80, 0, 1);
  const impressionsSignal = clamp(metrics.impressions_7d / 10000, 0, 1);
  const purchasesSignal = clamp(metrics.purchases_7d / 8, 0, 1);
  const clicksSignal = clamp(metrics.clicks_7d / 250, 0, 1);
  return round((spendSignal * 0.35) + (impressionsSignal * 0.25) + (purchasesSignal * 0.25) + (clicksSignal * 0.15), 4);
}

function computeRoasVolatility(roas3d, roas7d) {
  return round(Math.abs(toNumber(roas3d) - toNumber(roas7d)) / Math.max(Math.abs(toNumber(roas7d)), 0.5), 4);
}

function computeCreativeFatigueScore({ frequency_7d, ctr_vs_average, roas_3d_vs_7d, top_creative_share_7d }) {
  const frequencyPressure = clamp((toNumber(frequency_7d) - 2.5) / 2.0, 0, 1.5);
  const ctrDecline = clamp((-toNumber(ctr_vs_average)) / 100, 0, 1.2);
  const roasDecline = clamp(1 - toNumber(roas_3d_vs_7d, 1), 0, 1.2);
  const concentrationPressure = clamp((toNumber(top_creative_share_7d) - 0.55) / 0.45, 0, 1);
  return round(clamp(
    (frequencyPressure * 0.40) +
      (ctrDecline * 0.25) +
      (roasDecline * 0.20) +
      (concentrationPressure * 0.15),
    0,
    1.5
  ), 4);
}

function buildCreativeStatsByAdSet(adSnapshots) {
  const grouped = new Map();
  for (const ad of adSnapshots || []) {
    const adSetId = ad.parent_id;
    if (!adSetId) continue;

    if (!grouped.has(adSetId)) {
      grouped.set(adSetId, {
        total_spend_7d: 0,
        max_spend_7d: 0,
        roas_values: [],
        ctr_values: [],
        creative_count_7d: 0
      });
    }

    const stats = grouped.get(adSetId);
    const spend7d = toNumber(ad.metrics?.last_7d?.spend);
    const roas7d = toNumber(ad.metrics?.last_7d?.roas);
    const ctr7d = toNumber(ad.metrics?.last_7d?.ctr);

    stats.total_spend_7d += spend7d;
    stats.max_spend_7d = Math.max(stats.max_spend_7d, spend7d);
    stats.roas_values.push(roas7d);
    stats.ctr_values.push(ctr7d);
    if (spend7d > 0) stats.creative_count_7d += 1;
  }

  const resolved = new Map();
  for (const [adSetId, stats] of grouped.entries()) {
    const maxRoas = stats.roas_values.length ? Math.max(...stats.roas_values) : 0;
    const minRoas = stats.roas_values.length ? Math.min(...stats.roas_values) : 0;
    const avgCtr = stats.ctr_values.length
      ? stats.ctr_values.reduce((sum, value) => sum + value, 0) / stats.ctr_values.length
      : 0;

    resolved.set(adSetId, {
      creative_count_7d: stats.creative_count_7d,
      top_creative_share_7d: round(
        stats.total_spend_7d > 0 ? stats.max_spend_7d / stats.total_spend_7d : 0,
        4
      ),
      creative_roas_spread_7d: round(maxRoas - minRoas, 4),
      creative_ctr_avg_7d: round(avgCtr, 4),
      total_spend_7d: round(stats.total_spend_7d, 4)
    });
  }

  return resolved;
}

function buildSiblingSignalsByAd(adSnapshots, creativeStatsByAdSet) {
  const grouped = new Map();
  for (const ad of adSnapshots || []) {
    const adSetId = ad.parent_id;
    if (!adSetId) continue;
    if (!grouped.has(adSetId)) grouped.set(adSetId, []);
    grouped.get(adSetId).push(ad);
  }

  const signals = new Map();
  for (const [adSetId, siblings] of grouped.entries()) {
    const siblingCount = siblings.length;
    const avgRoas = siblings.length
      ? siblings.reduce((sum, ad) => sum + toNumber(ad.metrics?.last_7d?.roas), 0) / siblings.length
      : 0;
    const avgCtr = siblings.length
      ? siblings.reduce((sum, ad) => sum + toNumber(ad.metrics?.last_7d?.ctr), 0) / siblings.length
      : 0;
    const totalSpend = siblings.reduce((sum, ad) => sum + toNumber(ad.metrics?.last_7d?.spend), 0);
    const adSetStats = creativeStatsByAdSet.get(adSetId) || emptyCreativeStats();

    for (const ad of siblings) {
      const adRoas = toNumber(ad.metrics?.last_7d?.roas);
      const adCtr = toNumber(ad.metrics?.last_7d?.ctr);
      const adSpend = toNumber(ad.metrics?.last_7d?.spend);
      signals.set(ad.entity_id, {
        sibling_roas_gap: round(adRoas - avgRoas, 4),
        sibling_ctr_gap: round(adCtr - avgCtr, 4),
        sibling_spend_share_7d: round(totalSpend > 0 ? adSpend / totalSpend : 0, 4),
        sibling_count_7d: siblingCount,
        top_creative_share_7d: adSetStats.top_creative_share_7d
      });
    }
  }

  return signals;
}

function emptyCreativeStats() {
  return {
    creative_count_7d: 0,
    top_creative_share_7d: 0,
    creative_roas_spread_7d: 0,
    creative_ctr_avg_7d: 0,
    total_spend_7d: 0
  };
}

function emptySiblingSignals() {
  return {
    sibling_roas_gap: 0,
    sibling_ctr_gap: 0,
    sibling_spend_share_7d: 0,
    sibling_count_7d: 0,
    top_creative_share_7d: 0
  };
}

function buildRecentActionMap(recentActions) {
  const map = new Map();
  for (const action of recentActions) {
    if (!map.has(action.entity_id)) {
      map.set(action.entity_id, action);
    }
  }
  return map;
}

module.exports = {
  buildFeatureSet
};
