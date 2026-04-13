const express = require('express');
const router = express.Router();
const { getLatestSnapshots, getSnapshotHistory, getAccountOverview, getAdsForAdSet, getOverviewHistory, getSnapshotFreshness } = require('../../db/queries');
const ActionLog = require('../../db/models/ActionLog');
const { getMetaClient } = require('../../meta/client');
const { parseInsightRow, aggregateDailyInsights, parseBudget, getTimeRanges, calculateROASTrend, calculateSpendVelocity } = require('../../meta/helpers');
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
    const [overview, freshness] = await Promise.all([
      getAccountOverview(),
      getSnapshotFreshness('adset')
    ]);
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
      today_roas: overview.today_roas,
      data_age_minutes: freshness.age_minutes,
      last_snapshot_at: freshness.last_snapshot_at,
      data_fresh: freshness.fresh
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
// Meta refreshes insights every ~15 min; structural changes (status, budget) are instant.
// 120s TTL balances freshness vs API calls. Force refresh bypasses cache.
let _liveCache = { adsets: null, ts: 0, refreshing: false };
const LIVE_CACHE_TTL = 120 * 1000; // 120 seconds

// SSE clients list for real-time push
const _sseClients = new Set();

// Broadcast data to all SSE clients
function _broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(payload); } catch (e) { _sseClients.delete(client); }
  }
}

// ── Snapshot fallback — returns data from MongoDB when Meta API is unavailable ──
async function _getSnapshotFallback(reason) {
  logger.info(`[LIVE] Using snapshot fallback: ${reason}`);
  const [snapshots, freshness] = await Promise.all([
    getLatestSnapshots('adset'),
    getSnapshotFreshness('adset')
  ]);
  return {
    adsets: snapshots.map(_mapSnapshot),
    fallback: true,
    fallback_reason: reason,
    data_age_minutes: freshness.age_minutes,
    last_snapshot_at: freshness.last_snapshot_at,
    data_fresh: freshness.fresh
  };
}

// ── Core fetch function (used by both HTTP endpoint and background refresh) ──
// Hard deadline: if the entire fetch takes longer than this, abort and fall back to snapshots
const FETCH_DEADLINE_MS = 25000; // 25 seconds — well under Render's 30s proxy timeout

async function _fetchLiveAdSets() {
  const meta = getMetaClient();

  // Pre-flight: if data-collector is actively running, don't compete for the
  // Bottleneck limiter — our calls would queue behind it and timeout at 25s.
  // Use snapshots (which the collector just wrote) instead.
  const busy = meta.isBusy();
  if (busy) {
    return _getSnapshotFallback(`collector_busy: ${busy.label}`);
  }

  // Pre-flight: skip only if truly rate-limited
  if (meta.isRateLimited()) {
    return _getSnapshotFallback('rate_limited');
  }

  const usage = meta.getRateLimitUsage();
  if (usage && usage.max > 80) {
    return _getSnapshotFallback(`api_usage_critical: ${usage.max}%`);
  }

  // Deadline timer — abort everything if we're running too long
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  const checkDeadline = (label) => {
    if (Date.now() > deadline) {
      throw new Error(`DEADLINE_EXCEEDED at ${label}`);
    }
  };

  // ── 1. Structural: campaigns + ad sets in 1 call (field expansion) ──
  let adSetMap = {};

  try {
    const result = await meta.getCampaignsWithAdSets();
    adSetMap = result.adSetMap;
    checkDeadline('after_structural');
  } catch (err) {
    if (err.message.startsWith('DEADLINE_EXCEEDED')) throw err;
    // Fallback to separate calls
    try {
      const campaigns = await meta.getCampaigns();
      const campaignMap = {};
      for (const c of campaigns) campaignMap[c.id] = c;
      checkDeadline('after_campaigns_fallback');

      const allAdSets = await meta.getAllAdSets();
      for (const as of allAdSets) {
        const campaign = campaignMap[as.campaign_id] || { name: 'Unknown', id: as.campaign_id };
        adSetMap[as.id] = { ...as, campaign_name: campaign.name };
      }
      checkDeadline('after_adsets_fallback');
    } catch (fallbackErr) {
      if (fallbackErr.message.startsWith('DEADLINE_EXCEEDED')) throw fallbackErr;
      const metaError = fallbackErr.response?.data?.error;
      if (metaError?.code === 17 || metaError?.code === 4) {
        return _getSnapshotFallback('rate_limited_on_structural');
      }
      return _getSnapshotFallback(`structural_error: ${fallbackErr.message}`);
    }
  }

  if (Object.keys(adSetMap).length === 0) {
    return _getSnapshotFallback('no_adsets_from_api');
  }

  // ── 2. Insights: 1 call with time_increment=1, maxDays=14 ──
  //    Live only shows today/3d/7d/14d — no need for 30 days.
  //    14 days = ~half the rows vs 30 days → fewer pagination pages.
  //    If the cron already fetched 30d data within 90s, the cache returns it instantly.
  let adSetInsights = {};

  try {
    const dailyRows = await meta.getAccountInsightsDaily('adset', 14);
    checkDeadline('after_insights');
    adSetInsights = aggregateDailyInsights(dailyRows, 'adset_id');
    logger.debug(`[LIVE] ${dailyRows.length} daily rows → ${Object.keys(adSetInsights).length} ad sets`);
  } catch (err) {
    if (err.message.startsWith('DEADLINE_EXCEEDED')) throw err;
    const eCode = err?.response?.data?.error?.code;
    if (eCode === 17 || eCode === 4) {
      logger.warn(`[LIVE] Rate limited on daily insights — using partial data`);
    } else {
      logger.warn(`[LIVE] Daily insight fetch failed: ${err?.message} — continuing with empty metrics`);
    }
  }

  // ── 3. Build response ──
  const emptyMetrics = {
    spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
    purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
  };
  const LIVE_WINDOWS = ['today', 'last_3d', 'last_7d', 'last_14d'];

  const adsets = Object.entries(adSetMap).map(([id, as]) => {
    const metrics = {};
    for (const window of LIVE_WINDOWS) {
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
      learning_stage: as.learning_stage_info?.status || null,
      learning_stage_conversions: as.learning_stage_info?.conversions || 0,
      metrics,
      analysis,
      id: id,
      name: as.name
    };
  });

  // Sort by 7d spend descending
  adsets.sort((a, b) => (b.metrics?.last_7d?.spend || 0) - (a.metrics?.last_7d?.spend || 0));

  return { adsets, fallback: false };
}

// ── Background refresh loop — proactively keeps cache fresh and pushes to SSE clients ──
let _bgRefreshTimer = null;
const BG_REFRESH_INTERVAL = 3 * 60 * 1000; // 3 minutes — Meta insights refresh ~every 15 min
                                              // polling faster wastes API calls without fresher data

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
        fallback: false,
        fetched_at: new Date(_liveCache.ts).toISOString(),
        age_seconds: Math.round(cacheAge / 1000)
      });
    }
    return;
  }

  _liveCache.refreshing = true;

  try {
    // Check if data-collector is running — don't compete for the Bottleneck limiter
    const meta = getMetaClient();
    const busy = meta.isBusy();
    if (busy) {
      logger.info(`[LIVE-BG] Skipping refresh — ${busy.label} is running`);
      _liveCache.refreshing = false;
      return;
    }

    // Check rate limit before refreshing — skip only if critically high
    if (meta.isRateLimited()) {
      logger.info('[LIVE-BG] Skipping refresh — rate limited');
      _liveCache.refreshing = false;
      return;
    }
    const usage = meta.getRateLimitUsage();
    if (usage && usage.max > 80) {
      logger.info(`[LIVE-BG] Skipping refresh — API usage critical at ${usage.max}%`);
      _liveCache.refreshing = false;
      return;
    }

    const result = await _fetchLiveAdSets();
    const adsets = result.adsets;

    // Only update cache timestamp if we got live data (not fallback)
    if (!result.fallback) {
      _liveCache = { adsets, ts: Date.now(), refreshing: false };
    } else {
      _liveCache.refreshing = false;
    }

    // Push to all connected SSE clients
    if (_sseClients.size > 0) {
      _broadcastSSE('adsets', {
        adsets,
        cached: result.fallback,
        fallback: result.fallback || false,
        fallback_reason: result.fallback_reason || null,
        data_age_minutes: result.data_age_minutes || null,
        data_fresh: result.fallback ? (result.data_fresh != null ? result.data_fresh : null) : true,
        fetched_at: new Date().toISOString(),
        age_seconds: 0
      });
      logger.debug(`[LIVE-BG] Pushed ${result.fallback ? 'fallback' : 'fresh'} data to ${_sseClients.size} SSE client(s)`);
    }
  } catch (err) {
    logger.warn(`[LIVE-BG] Background refresh failed: ${err.message}`);
    _liveCache.refreshing = false;
  }
}

function _startBackgroundRefresh() {
  if (_bgRefreshTimer) return;
  logger.info(`[LIVE-BG] Starting background refresh every ${BG_REFRESH_INTERVAL / 1000}s`);
  // Initial fetch after 90s — the boot cron runs immediately on startup and takes ~50s.
  // Waiting 90s ensures the cron finishes first and the daily insights cache is populated,
  // so the BG refresh gets an instant cache hit instead of competing for the Bottleneck limiter.
  setTimeout(() => _backgroundRefresh(), 90000);
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
      fallback: false,
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
// Route-level timeout: ensures we ALWAYS respond within 28s (under Render's 30s proxy limit)
const ROUTE_TIMEOUT_MS = 28000;

router.get('/adsets/live', async (req, res) => {
  let responded = false;
  const safeRespond = (fn) => {
    if (responded) return;
    responded = true;
    fn();
  };

  // Hard timeout: if _fetchLiveAdSets hangs beyond deadline, respond with fallback
  const timeoutHandle = setTimeout(async () => {
    safeRespond(async () => {
      logger.warn(`[LIVE] Route timeout after ${ROUTE_TIMEOUT_MS}ms — falling back to snapshots`);
      try {
        const snapshots = await getLatestSnapshots('adset');
        res.json({
          adsets: snapshots.map(_mapSnapshot),
          cached: false,
          fallback: true,
          fallback_reason: 'route_timeout'
        });
      } catch (fallbackErr) {
        res.status(500).json({ error: 'Timeout fetching live data and snapshot fallback failed' });
      }
    });
  }, ROUTE_TIMEOUT_MS);

  try {
    const now = Date.now();
    const forceRefresh = req.query.force === 'true';

    // Return cached data if fresh enough
    if (!forceRefresh && _liveCache.adsets && (now - _liveCache.ts) < LIVE_CACHE_TTL) {
      clearTimeout(timeoutHandle);
      return safeRespond(() => res.json({
        adsets: _liveCache.adsets,
        cached: true,
        fetched_at: new Date(_liveCache.ts).toISOString(),
        age_seconds: Math.round((now - _liveCache.ts) / 1000)
      }));
    }

    const result = await _fetchLiveAdSets();
    clearTimeout(timeoutHandle);
    const adsets = result.adsets;

    // Only update cache if we got live data (not a fallback)
    if (!result.fallback) {
      _liveCache = { adsets, ts: Date.now(), refreshing: false };
    }

    // Also push to SSE clients
    if (_sseClients.size > 0) {
      _broadcastSSE('adsets', {
        adsets,
        cached: result.fallback,
        fallback: result.fallback || false,
        fallback_reason: result.fallback_reason || null,
        data_age_minutes: result.data_age_minutes || null,
        data_fresh: result.fallback ? (result.data_fresh != null ? result.data_fresh : null) : true,
        fetched_at: new Date().toISOString(),
        age_seconds: 0
      });
    }

    // Include freshness info in all responses
    const freshness = await getSnapshotFreshness('adset');
    safeRespond(() => res.json({
      adsets,
      cached: result.fallback,
      fallback: result.fallback || false,
      fallback_reason: result.fallback_reason || null,
      fetched_at: new Date().toISOString(),
      age_seconds: 0,
      data_age_minutes: result.fallback ? (result.data_age_minutes || freshness.age_minutes) : 0,
      last_snapshot_at: freshness.last_snapshot_at,
      data_fresh: result.fallback ? freshness.fresh : true
    }));
  } catch (error) {
    clearTimeout(timeoutHandle);
    logger.error(`[LIVE] Error fetching live ad sets: ${error.message}`);
    // Fallback to snapshots if live fetch fails (including DEADLINE_EXCEEDED)
    safeRespond(async () => {
      try {
        const snapshots = await getLatestSnapshots('adset');
        res.json({
          adsets: snapshots.map(_mapSnapshot),
          cached: false,
          fallback: true,
          fallback_reason: error.message
        });
      } catch (fallbackErr) {
        res.status(500).json({ error: error.message });
      }
    });
  }
});

// GET /api/metrics/ads/live/:adSetId — Ads for a specific ad set from snapshots (no extra API calls)
router.get('/ads/live/:adSetId', async (req, res) => {
  try {
    const adSetId = req.params.adSetId;
    const snapshots = await getAdsForAdSet(adSetId);
    res.json(snapshots.map(s => ({
      entity_id: s.entity_id,
      entity_name: s.entity_name,
      status: s.status,
      parent_id: s.parent_id,
      metrics: s.metrics || {}
    })));
  } catch (error) {
    logger.error(`[LIVE] Error fetching ads for ad set: ${error.message}`);
    res.status(500).json({ error: error.message });
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

// GET /api/metrics/data-health — Data freshness health check
router.get('/data-health', async (req, res) => {
  try {
    const meta = getMetaClient();
    const [adsetFreshness, campaignFreshness, adFreshness] = await Promise.all([
      getSnapshotFreshness('adset'),
      getSnapshotFreshness('campaign'),
      getSnapshotFreshness('ad')
    ]);

    const busy = meta.isBusy();
    const lastCollect = meta.getLastCollectTime();
    const rateLimitUsage = meta.getRateLimitUsage();

    const isHealthy = adsetFreshness.fresh && campaignFreshness.fresh;
    const status = isHealthy ? 'healthy' : (adsetFreshness.age_minutes > 30 ? 'critical' : 'stale');

    res.json({
      status,
      healthy: isHealthy,
      snapshots: {
        adset: adsetFreshness,
        campaign: campaignFreshness,
        ad: adFreshness
      },
      collector: {
        busy: busy ? { label: busy.label, running_for_seconds: Math.round((Date.now() - busy.since) / 1000) } : null,
        last_completed_at: lastCollect ? new Date(lastCollect).toISOString() : null,
        last_completed_ago_minutes: lastCollect ? Math.round((Date.now() - lastCollect) / 60000) : null
      },
      rate_limit: rateLimitUsage ? { max: rateLimitUsage.max, call_count: rateLimitUsage.call_count } : null,
      thresholds: {
        fresh_max_minutes: 15,
        stale_warning_minutes: 20,
        critical_minutes: 30
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
