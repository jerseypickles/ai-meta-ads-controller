const express = require('express');
const router = express.Router();
const { getLatestSnapshots, getSnapshotHistory, getAccountOverview, getAdsForAdSet, getOverviewHistory } = require('../../db/queries');
const ActionLog = require('../../db/models/ActionLog');
const { getMetaClient } = require('../../meta/client');
const { parseInsightRow, parseBudget, getTimeRanges, calculateROASTrend, calculateSpendVelocity } = require('../../meta/helpers');
const kpiTargets = require('../../../config/kpi-targets');
const logger = require('../../utils/logger');

// GET /api/metrics/overview/history — Historial diario para gráficos de tendencia
router.get('/overview/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = await getOverviewHistory(days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/overview — Resumen general de la cuenta
router.get('/overview', async (req, res) => {
  try {
    const overview = await getAccountOverview();
    // Mapear a nombres que el frontend espera
    res.json({
      spend_today: overview.today_spend,
      daily_budget: overview.total_daily_budget,
      roas_7d: overview.roas_7d,
      roas_3d: overview.roas_3d,
      roas_14d: overview.roas_14d,
      roas_30d: overview.roas_30d,
      spend_14d: overview.spend_14d,
      spend_30d: overview.spend_30d,
      active_adsets: overview.active_adsets,
      paused_adsets: overview.paused_adsets,
      total_adsets: overview.total_adsets,
      today_revenue: overview.today_revenue,
      today_roas: overview.today_roas
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/campaigns — Todas las campañas con últimas métricas
router.get('/campaigns', async (req, res) => {
  try {
    const snapshots = await getLatestSnapshots('campaign');
    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══ LIVE ENDPOINTS (fetch directly from Meta API) ═══

// In-memory cache for live data (avoids hammering Meta API on every page refresh)
let _liveCache = { adsets: null, ts: 0 };
const LIVE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// GET /api/metrics/adsets/live — All ad sets with metrics fetched LIVE from Meta API
router.get('/adsets/live', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.force === 'true';

    // Return cached data if fresh enough
    if (!forceRefresh && _liveCache.adsets && (now - _liveCache.ts) < LIVE_CACHE_TTL) {
      return res.json({
        adsets: _liveCache.adsets,
        cached: true,
        fetched_at: new Date(_liveCache.ts).toISOString(),
        age_seconds: Math.round((now - _liveCache.ts) / 1000)
      });
    }

    const meta = getMetaClient();
    const timeRanges = getTimeRanges();

    // 1. Get all campaigns and their ad sets
    const campaigns = await meta.getCampaigns();
    const adSetMap = {};
    const campaignMap = {};

    for (const c of campaigns) {
      campaignMap[c.id] = c;
      try {
        const adSets = await meta.getAdSets(c.id);
        for (const as of adSets) {
          adSetMap[as.id] = { ...as, campaign_name: c.name, campaign_id: c.id };
        }
      } catch (err) {
        logger.warn(`[LIVE] Error fetching ad sets for campaign ${c.id}: ${err.message}`);
      }
    }

    // 2. Get insights for ALL ad sets in bulk (5 API calls total, one per time window)
    const adSetInsights = {};
    for (const [window, range] of Object.entries(timeRanges)) {
      try {
        const rows = await meta.getAccountInsights('adset', range);
        for (const row of rows) {
          const asid = row.adset_id;
          if (!adSetInsights[asid]) adSetInsights[asid] = {};
          adSetInsights[asid][window] = parseInsightRow(row);
        }
      } catch (err) {
        logger.warn(`[LIVE] Error fetching adset insights for ${window}: ${err.message}`);
      }
    }

    // 3. Build response array
    const emptyMetrics = {
      spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
      purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
    };

    const adsets = Object.entries(adSetMap).map(([id, as]) => {
      const metrics = {};
      for (const window of Object.keys(timeRanges)) {
        metrics[window] = adSetInsights[id]?.[window] || { ...emptyMetrics };
      }

      const roas3d = metrics.last_3d?.roas || 0;
      const roas7d = metrics.last_7d?.roas || 0;
      const todaySpend = metrics.today?.spend || 0;
      const avgCTR = metrics.last_7d?.ctr || 0;
      const todayCTR = metrics.today?.ctr || 0;

      const analysis = {
        roas_trend: calculateROASTrend(roas3d, roas7d),
        roas_3d_vs_7d: roas7d > 0 ? roas3d / roas7d : 0,
        spend_velocity: calculateSpendVelocity(todaySpend, kpiTargets.daily_spend_target),
        frequency_alert: (metrics.last_7d?.frequency || 0) > kpiTargets.frequency_warning,
        ctr_vs_average: avgCTR > 0 ? ((todayCTR - avgCTR) / avgCTR) * 100 : 0
      };

      return {
        entity_id: id,
        entity_name: as.name,
        status: as.effective_status,
        campaign_id: as.campaign_id,
        campaign_name: as.campaign_name,
        daily_budget: parseBudget(as.daily_budget),
        lifetime_budget: parseBudget(as.lifetime_budget),
        budget_remaining: parseBudget(as.budget_remaining),
        bid_strategy: as.bid_strategy || null,
        optimization_goal: as.optimization_goal || null,
        metrics,
        analysis,
        id: id,
        name: as.name
      };
    });

    // Sort by 7d spend descending
    adsets.sort((a, b) => (b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));

    // Cache result
    _liveCache = { adsets, ts: Date.now() };

    res.json({
      adsets,
      cached: false,
      fetched_at: new Date().toISOString(),
      age_seconds: 0
    });
  } catch (error) {
    logger.error(`[LIVE] Error fetching live ad sets: ${error.message}`);
    // Fallback to snapshots if live fetch fails
    try {
      const snapshots = await getLatestSnapshots('adset');
      res.json({
        adsets: snapshots.map(_mapSnapshot),
        cached: false,
        fallback: true,
        error: error.message
      });
    } catch (fallbackErr) {
      res.status(500).json({ error: error.message });
    }
  }
});

// GET /api/metrics/ads/live/:adSetId — Ads for a specific ad set, fetched LIVE from Meta API
router.get('/ads/live/:adSetId', async (req, res) => {
  try {
    const meta = getMetaClient();
    const timeRanges = getTimeRanges();
    const adSetId = req.params.adSetId;

    // 1. Get ads list with status
    let adsList;
    try {
      adsList = await meta.getAds(adSetId);
    } catch (err) {
      logger.warn(`[LIVE] Error fetching ads for ${adSetId}: ${err.message}`);
      adsList = [];
    }

    if (adsList.length === 0) {
      return res.json([]);
    }

    // 2. Get insights at ad level for this ad set's campaign
    // We use account-level insights with ad level which is efficient
    const adInsights = {};
    for (const [window, range] of Object.entries(timeRanges)) {
      try {
        const rows = await meta.getAccountInsights('ad', range);
        for (const row of rows) {
          if (!row.ad_id) continue;
          // Only keep ads that belong to this ad set
          if (row.adset_id !== adSetId) continue;
          if (!adInsights[row.ad_id]) adInsights[row.ad_id] = { ad_name: row.ad_name };
          adInsights[row.ad_id][window] = parseInsightRow(row);
        }
      } catch (err) {
        logger.warn(`[LIVE] Error fetching ad insights for ${window}: ${err.message}`);
      }
    }

    const emptyMetrics = {
      spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
      purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
    };

    // 3. Build response
    const ads = adsList.map(ad => {
      const insights = adInsights[ad.id] || {};
      const metrics = {};
      for (const window of Object.keys(timeRanges)) {
        metrics[window] = insights[window] || { ...emptyMetrics };
      }

      return {
        entity_id: ad.id,
        entity_name: ad.name || insights.ad_name || ad.id,
        status: ad.effective_status,
        parent_id: adSetId,
        metrics
      };
    });

    res.json(ads);
  } catch (error) {
    logger.error(`[LIVE] Error fetching live ads: ${error.message}`);
    // Fallback to snapshot ads
    try {
      const ads = await getAdsForAdSet(req.params.adSetId);
      res.json(ads);
    } catch (fallbackErr) {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST /api/metrics/refresh-cache — Force clear the live cache
router.post('/refresh-cache', (req, res) => {
  _liveCache = { adsets: null, ts: 0 };
  res.json({ success: true, message: 'Live cache cleared' });
});

// GET /api/metrics/adsets/actions — Acciones recientes de agentes por ad set (con cooldown)
// NOTA: debe estar ANTES de /adsets para que Express lo matchee correctamente
router.get('/adsets/actions', async (req, res) => {
  try {
    const COOLDOWN_DAYS = 3;
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const actions = await ActionLog.find({
      entity_type: 'adset',
      success: true,
      executed_at: { $gte: since }
    })
      .sort({ executed_at: -1 })
      .lean();

    // Agrupar por entity_id con info de cooldown
    const byAdSet = {};
    const now = new Date();

    for (const action of actions) {
      if (!byAdSet[action.entity_id]) {
        // Calcular cooldown basado en la acción más reciente (primera por el sort)
        const cooldownUntil = new Date(action.executed_at);
        cooldownUntil.setDate(cooldownUntil.getDate() + COOLDOWN_DAYS);
        const onCooldown = cooldownUntil > now;
        const hoursLeft = onCooldown ? Math.round((cooldownUntil - now) / (1000 * 60 * 60)) : 0;

        byAdSet[action.entity_id] = {
          actions: [],
          cooldown: onCooldown ? {
            active: true,
            until: cooldownUntil,
            hours_left: hoursLeft,
            last_agent: _extractAgent(action.reasoning),
            last_action: action.action
          } : { active: false }
        };
      }
      byAdSet[action.entity_id].actions.push({
        action: action.action,
        before_value: action.before_value,
        after_value: action.after_value,
        change_percent: action.change_percent,
        reasoning: action.reasoning,
        confidence: action.confidence,
        executed_at: action.executed_at,
        agent: _extractAgent(action.reasoning)
      });
    }

    res.json(byAdSet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/adsets — Todos los ad sets (con filtro opcional por campaña)
router.get('/adsets', async (req, res) => {
  try {
    let snapshots = await getLatestSnapshots('adset');

    // Filtro por campaña si se especifica
    if (req.query.campaign_id) {
      snapshots = snapshots.filter(s => s.campaign_id === req.query.campaign_id);
    }

    // Ordenar por ROAS 7d descendente por defecto
    const sortBy = req.query.sort || 'roas_7d';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    snapshots.sort((a, b) => {
      const aVal = _getNestedValue(a, sortBy);
      const bVal = _getNestedValue(b, sortBy);
      return (bVal - aVal) * sortOrder;
    });

    res.json(snapshots.map(_mapSnapshot));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/ads — Todos los ads (con filtro opcional por ad set)
router.get('/ads', async (req, res) => {
  try {
    let snapshots = await getLatestSnapshots('ad');

    if (req.query.adset_id) {
      snapshots = snapshots.filter(s => s.parent_id === req.query.adset_id);
    }

    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/ads/:adSetId — Ads/creativos de un ad set específico
router.get('/ads/:adSetId', async (req, res) => {
  try {
    const ads = await getAdsForAdSet(req.params.adSetId);
    res.json(ads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/history/:entityId — Historial de una entidad (para gráficos)
router.get('/history/:entityId', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = await getSnapshotHistory(req.params.entityId, days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/top-performers — Top y bottom ad sets
// Dashboard.jsx espera un array plano con { name, metrics: { roas_7d, spend_7d, cpa, trend } }
router.get('/top-performers', async (req, res) => {
  try {
    const snapshots = await getLatestSnapshots('adset');
    const active = snapshots.filter(s => s.status === 'ACTIVE');

    // Filtrar por gasto mínimo y ordenar por ROAS 7d
    const byRoas = [...active]
      .filter(s => (s.metrics?.last_7d?.spend || 0) > 20)
      .sort((a, b) => (b.metrics?.last_7d?.roas || 0) - (a.metrics?.last_7d?.roas || 0));

    // Mapear a formato que Dashboard.jsx espera
    const mapped = byRoas.map(s => ({
      name: s.entity_name,
      metrics: {
        roas_7d: s.metrics?.last_7d?.roas || 0,
        spend_7d: s.metrics?.last_7d?.spend || 0,
        cpa: s.metrics?.last_7d?.cpa || 0,
        trend: s.analysis?.roas_trend || 'stable'
      }
    }));

    const limit = parseInt(req.query.limit) || 10;
    res.json(mapped.slice(0, limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Extrae el tipo de agente del reasoning (formato: [BUDGET] ...)
 */
function _extractAgent(reasoning) {
  if (!reasoning) return 'unknown';
  const match = reasoning.match(/^\[(\w+)\]/);
  const tag = match ? match[1].toLowerCase() : 'unknown';
  if (['budget', 'performance', 'creative', 'pacing', 'unified_policy', 'unified'].includes(tag)) {
    return 'unified';
  }
  return tag;
}

/**
 * Mapea campos de snapshot (entity_id/entity_name) a id/name para el frontend
 */
function _mapSnapshot(s) {
  return {
    ...s,
    id: s.entity_id,
    name: s.entity_name
  };
}

function _getNestedValue(obj, path) {
  if (path === 'roas_7d') return obj.metrics?.last_7d?.roas || 0;
  if (path === 'roas_3d') return obj.metrics?.last_3d?.roas || 0;
  if (path === 'spend_7d') return obj.metrics?.last_7d?.spend || 0;
  if (path === 'cpa_7d') return obj.metrics?.last_7d?.cpa || 0;
  if (path === 'daily_budget') return obj.daily_budget || 0;
  return 0;
}

module.exports = router;
