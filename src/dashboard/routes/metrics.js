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

// ═══ LIVE ENDPOINTS — fetch directly from Meta API with smart caching ═══

// Shared live cache with configurable TTL
let _liveCache = { adsets: null, ts: 0, refreshing: false };
const LIVE_CACHE_TTL = 60 * 1000; // 60 seconds — Meta refreshes insights every ~15 min
                                    // but structural changes (status, budget) are instant

// SSE clients list for real-time push
const _sseClients = new Set();

// Broadcast data to all SSE clients
function _broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(payload); } catch (e) { _sseClients.delete(client); }
  }
}

// ── Core fetch function (used by both HTTP endpoint and background refresh) ──
async function _fetchLiveAdSets() {
  const meta = getMetaClient();
  const timeRanges = getTimeRanges();

  // 1. Get all ad sets — try account-level first (1 call), fall back to campaign→adsets (N+1)
  const campaigns = await meta.getCampaigns();
  const campaignMap = {};
  for (const c of campaigns) campaignMap[c.id] = c;

  const adSetMap = {};

  try {
    // Fast path: single account-level query
    const allAdSets = await meta.getAllAdSets();
    for (const as of allAdSets) {
      const campaign = campaignMap[as.campaign_id] || { name: 'Unknown', id: as.campaign_id };
      adSetMap[as.id] = { ...as, campaign_name: campaign.name };
    }
  } catch (err) {
    // Fallback: campaign-by-campaign (works on all account types)
    logger.warn(`[LIVE] getAllAdSets() failed (${err.message}), falling back to campaign-based fetch`);
    for (const c of campaigns) {
      try {
        const adSets = await meta.getAdSets(c.id);
        for (const as of adSets) {
          adSetMap[as.id] = { ...as, campaign_name: c.name, campaign_id: c.id };
        }
      } catch (e) {
        logger.warn(`[LIVE] Error fetching ad sets for campaign ${c.id}: ${e.message}`);
      }
    }
  }

  // 2. Get insights for ALL ad sets in bulk (5 API calls, one per time window)
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

  return adsets;
}

// ── Background refresh loop — proactively keeps cache fresh and pushes to SSE clients ──
let _bgRefreshTimer = null;
const BG_REFRESH_INTERVAL = 60 * 1000; // 60 seconds

async function _backgroundRefresh() {
  if (_liveCache.refreshing) return; // Skip if already refreshing

  // Skip if cache is still fresh (avoid double-fetching after an HTTP request)
  const cacheAge = Date.now() - _liveCache.ts;
  if (_liveCache.adsets && cacheAge < LIVE_CACHE_TTL) {
    // Cache is fresh — just re-broadcast to SSE clients (they may have connected after last fetch)
    if (_sseClients.size > 0) {
      _broadcastSSE('adsets', {
        adsets: _liveCache.adsets,
        cached: true,
        fetched_at: new Date(_liveCache.ts).toISOString(),
        age_seconds: Math.round(cacheAge / 1000)
      });
    }
    return;
  }

  _liveCache.refreshing = true;

  try {
    // Check rate limit before refreshing — skip if > 75% usage
    const meta = getMetaClient();
    const usage = meta.getRateLimitUsage();
    if (usage && usage.max > 75) {
      logger.info(`[LIVE-BG] Skipping refresh — API usage at ${usage.max}%`);
      _liveCache.refreshing = false;
      return;
    }

    const adsets = await _fetchLiveAdSets();
    _liveCache = { adsets, ts: Date.now(), refreshing: false };

    // Push to all connected SSE clients
    if (_sseClients.size > 0) {
      _broadcastSSE('adsets', {
        adsets,
        cached: false,
        fetched_at: new Date().toISOString(),
        age_seconds: 0
      });
      logger.debug(`[LIVE-BG] Pushed fresh data to ${_sseClients.size} SSE client(s)`);
    }
  } catch (err) {
    logger.warn(`[LIVE-BG] Background refresh failed: ${err.message}`);
    _liveCache.refreshing = false;
  }
}

function _startBackgroundRefresh() {
  if (_bgRefreshTimer) return;
  logger.info(`[LIVE-BG] Starting background refresh every ${BG_REFRESH_INTERVAL / 1000}s`);
  // Initial fetch after 2s (let server boot first)
  setTimeout(() => _backgroundRefresh(), 2000);
  _bgRefreshTimer = setInterval(_backgroundRefresh, BG_REFRESH_INTERVAL);
}

function _stopBackgroundRefresh() {
  if (_bgRefreshTimer) {
    clearInterval(_bgRefreshTimer);
    _bgRefreshTimer = null;
  }
}

// Start background refresh when first client connects (lazy)
let _bgStarted = false;

// GET /api/metrics/stream — Server-Sent Events for real-time push updates
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });

  // Send initial data if available
  if (_liveCache.adsets) {
    const payload = `event: adsets\ndata: ${JSON.stringify({
      adsets: _liveCache.adsets,
      cached: true,
      fetched_at: new Date(_liveCache.ts).toISOString(),
      age_seconds: Math.round((Date.now() - _liveCache.ts) / 1000)
    })}\n\n`;
    res.write(payload);
  }

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { /* client gone */ }
  }, 30000);

  _sseClients.add(res);

  // Start background refresh if not started
  if (!_bgStarted) {
    _bgStarted = true;
    _startBackgroundRefresh();
  }

  req.on('close', () => {
    _sseClients.delete(res);
    clearInterval(heartbeat);
    // Stop background refresh if no clients connected
    if (_sseClients.size === 0) {
      _stopBackgroundRefresh();
      _bgStarted = false;
      logger.info('[LIVE-BG] No SSE clients — pausing background refresh');
    }
  });
});

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

    const adsets = await _fetchLiveAdSets();

    // Cache result
    _liveCache = { adsets, ts: Date.now(), refreshing: false };

    // Also push to SSE clients
    if (_sseClients.size > 0) {
      _broadcastSSE('adsets', {
        adsets,
        cached: false,
        fetched_at: new Date().toISOString(),
        age_seconds: 0
      });
    }

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

    // 2. Get insights at ad level — uses MetaClient's 90s cache so this is cheap
    const adInsights = {};
    for (const [window, range] of Object.entries(timeRanges)) {
      try {
        const rows = await meta.getAccountInsights('ad', range);
        for (const row of rows) {
          if (!row.ad_id) continue;
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
    try {
      const ads = await getAdsForAdSet(req.params.adSetId);
      res.json(ads);
    } catch (fallbackErr) {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST /api/metrics/refresh-cache — Force clear the live cache and trigger immediate refresh
router.post('/refresh-cache', async (req, res) => {
  _liveCache = { adsets: null, ts: 0, refreshing: false };
  // Clear MetaClient insights cache too
  const meta = getMetaClient();
  meta._insightsCache.clear();
  res.json({ success: true, message: 'All caches cleared' });
});

// GET /api/metrics/rate-limit — Current Meta API rate limit usage
router.get('/rate-limit', (req, res) => {
  const meta = getMetaClient();
  const usage = meta.getRateLimitUsage();
  res.json({
    usage: usage || { call_count: 0, total_cputime: 0, total_time: 0, max: 0 },
    sse_clients: _sseClients.size,
    cache_age_seconds: _liveCache.ts ? Math.round((Date.now() - _liveCache.ts) / 1000) : null,
    bg_refresh_active: !!_bgRefreshTimer
  });
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
