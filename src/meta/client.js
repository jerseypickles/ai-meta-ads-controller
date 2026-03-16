const axios = require('axios');
const Bottleneck = require('bottleneck');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const { withRetry, shouldRetryMetaError } = require('../utils/retry');

class MetaClient {
  constructor() {
    // Valores iniciales desde .env (fallback)
    this.accessToken = config.meta.accessToken;
    this.adAccountId = config.meta.adAccountId;
    this.apiVersion = config.meta.apiVersion;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this._tokenLoaded = false;

    // In-memory cache for insights — must expire BEFORE live cache TTL (120s)
    // so a live refresh always gets fresh data from Meta, not stale cache.
    // Meta refreshes insights ~every 15 min; structural changes (budget, status) are instant.
    this._insightsCache = new Map();
    this._insightsCacheTTL = 55 * 1000; // 55 seconds — expires before live cache (120s)

    // Cache for daily insight rows (getAccountInsightsDaily).
    // Keyed by `${level}:${maxDays}`. The live endpoint and data-collector often
    // fetch the same level within seconds of each other — this avoids duplicate API calls
    // and the associated Bottleneck queuing that caused the 28s timeout.
    this._dailyInsightsCache = new Map();
    this._dailyInsightsCacheTTL = 90 * 1000; // 90s — long enough to survive cron→live overlap

    // Rate limiter: Standard tier allows 190,000 + 400*active_ads per hour.
    // With ~60 active ads = ~214,000 pts/hour. We cap at 5,000/hour locally
    // (still very conservative at ~2.3% of quota). Adaptive throttling via
    // _checkRateLimitHeaders adjusts minTime dynamically when Meta reports high usage.
    this.limiter = new Bottleneck({
      reservoir: 5000,
      reservoirRefreshAmount: 5000,
      reservoirRefreshInterval: 60 * 60 * 1000, // 1 hour
      maxConcurrent: 8, // 3 parallel insight levels + pagination + structural + buffer
      minTime: 300 // 300ms between calls — adaptive throttling adjusts dynamically
    });

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000 // 30s per-request timeout — prevents single calls from hanging indefinitely
    });

    // Log rate limit warnings
    this.limiter.on('depleted', () => {
      logger.warn('Meta API rate limit alcanzado, esperando...');
    });
  }

  /**
   * Carga el token y cuenta desde MongoDB (si existe).
   * Fallback a .env si no hay token en la DB.
   */
  async _ensureToken() {
    if (this._tokenLoaded) return;

    try {
      const MetaToken = require('../db/models/MetaToken');
      const dbToken = await MetaToken.findOne({ is_active: true }).lean();

      if (dbToken && dbToken.access_token) {
        this.accessToken = dbToken.access_token;
        this.adAccountId = dbToken.ad_account_id || this.adAccountId;
        this._tokenLoaded = true;
        logger.debug('Token de Meta cargado desde MongoDB');

        // Verificar si está por expirar
        if (dbToken.expires_at) {
          const daysLeft = Math.floor((new Date(dbToken.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
          if (daysLeft < 7) {
            logger.warn(`Token de Meta expira en ${daysLeft} días — renovar pronto`);
          }
        }
      } else {
        this._tokenLoaded = true;
        logger.debug('Usando token de Meta desde .env (no hay token en MongoDB)');
      }
    } catch (error) {
      // Si MongoDB no está conectado, usar .env
      this._tokenLoaded = true;
      logger.debug('Usando token de Meta desde .env (MongoDB no disponible)');
    }

    // Set token in Authorization header (best practice: avoids token in URL/logs/proxies)
    this.client.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`;
  }

  /**
   * Fuerza recarga del token desde MongoDB (usado después de OAuth).
   */
  async reloadToken() {
    this._tokenLoaded = false;
    await this._ensureToken();
  }

  /**
   * Parse rate limit headers from Meta API responses.
   * Monitors all 3 fields: call_count, total_cputime, total_time (each 0-100%).
   * Any field hitting 100 triggers throttling. We back off starting at 75%.
   */
  _checkRateLimitHeaders(response) {
    try {
      // 1. BUC header — general API usage
      const bucHeader = response.headers?.['x-business-use-case-usage'];
      // 2. Insights throttle header — specific to ads_insights endpoint
      const insightsHeader = response.headers?.['x-fb-ads-insights-throttle'];

      let maxUsage = 0;

      if (bucHeader) {
        const usage = JSON.parse(bucHeader);
        for (const [, entries] of Object.entries(usage)) {
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            const entryMax = Math.max(
              entry.call_count || 0,
              entry.total_cputime || 0,
              entry.total_time || 0
            );
            if (entryMax > maxUsage) maxUsage = entryMax;

            // Store latest usage for external monitoring
            this._lastUsage = { ...entry, max: entryMax, ts: Date.now() };

            if (entry.estimated_time_to_regain_access > 0) {
              logger.warn(`[META-RATE] Rate limited. Regain access in ${entry.estimated_time_to_regain_access}s`);
            }
          }
        }
      }

      if (insightsHeader) {
        const insights = JSON.parse(insightsHeader);
        const insightsMax = Math.max(
          insights.app_id_util_pct || 0,
          insights.acc_id_util_pct || 0
        );
        if (insightsMax > maxUsage) maxUsage = insightsMax;
        if (!this._lastUsage || insightsMax > (this._lastUsage.max || 0)) {
          this._lastUsage = { app_id_util_pct: insights.app_id_util_pct, acc_id_util_pct: insights.acc_id_util_pct, max: insightsMax, ts: Date.now() };
        }
      }

      // Adaptive throttling based on highest usage across all headers
      if (maxUsage > 90) {
        logger.warn(`[META-RATE] Usage critical at ${maxUsage}% — heavy throttle`);
        this.limiter.updateSettings({ minTime: 5000 });
      } else if (maxUsage > 75) {
        logger.warn(`[META-RATE] Usage high at ${maxUsage}% — throttling`);
        this.limiter.updateSettings({ minTime: 3000 });
      } else if (maxUsage > 50) {
        this.limiter.updateSettings({ minTime: 1500 });
      } else if (maxUsage > 0) {
        this.limiter.updateSettings({ minTime: 300 }); // Faster when headroom available
      }
    } catch (e) {
      // Non-critical — don't break the call if header parsing fails
    }
  }

  /**
   * Returns current rate limit usage (0-100) or null if not yet known.
   * Critical readings (>90%) expire faster because Meta resets its counters
   * quickly (often 10-30s). Keeping a 120% reading for 5 min would block
   * the live endpoint from fetching fresh data long after Meta has recovered.
   */
  getRateLimitUsage() {
    if (!this._lastUsage) return null;
    const age = Date.now() - this._lastUsage.ts;
    // Critical readings expire in 60s (Meta typically recovers in 10-30s)
    const maxAge = this._lastUsage.max > 90 ? 60 * 1000 : 5 * 60 * 1000;
    if (age > maxAge) return null;
    return this._lastUsage;
  }

  /**
   * Shared busy flag — set when a long-running operation (like data-collector)
   * is actively making many API calls. Other callers (like live endpoints)
   * can check this to decide whether to use a fallback instead.
   */
  setBusy(label) {
    this._busy = { label, since: Date.now() };
    logger.debug(`[META-CLIENT] Busy: ${label}`);
  }

  clearBusy() {
    if (this._busy) {
      logger.debug(`[META-CLIENT] No longer busy (was: ${this._busy.label})`);
    }
    this._busy = null;
    this._lastCollectCompletedAt = Date.now();
  }

  /**
   * Returns { label, since } if another process is busy, or null.
   * Auto-clears stale busy flags older than 6 minutes (matches collect timeout).
   */
  isBusy() {
    if (!this._busy) return null;
    if (Date.now() - this._busy.since > 6 * 60 * 1000) {
      logger.warn(`[META-CLIENT] Clearing stale busy flag: ${this._busy.label}`);
      this._busy = null;
      return null;
    }
    return this._busy;
  }

  /**
   * Returns timestamp of the last successful collect completion, or null.
   * Used by the live endpoint to decide if recent snapshots are trustworthy.
   */
  getLastCollectTime() {
    return this._lastCollectCompletedAt || null;
  }

  /**
   * Returns true if we know we're rate limited (code 17 error recently or usage > 90%).
   * When the cooldown expires, resets minTime so the next request isn't stuck in heavy throttle.
   */
  isRateLimited() {
    const usage = this.getRateLimitUsage();
    if (usage && usage.max > 90) return true;
    if (this._rateLimitedUntil) {
      if (Date.now() < this._rateLimitedUntil) return true;
      // Cooldown just expired — reset throttle so live requests aren't stuck at 5000ms
      this._rateLimitedUntil = null;
      this.limiter.updateSettings({ minTime: 1000 }); // Conservative restart, not full speed
      logger.info('[META-RATE] Cooldown expired — resetting throttle to 1000ms');
    }
    return false;
  }

  /**
   * Mark that we hit a rate limit. Sets a cooldown period.
   */
  setRateLimited(seconds = 60) {
    this._rateLimitedUntil = Date.now() + (seconds * 1000);
    logger.warn(`[META-CLIENT] Rate limited — cooldown for ${seconds}s`);
  }

  /**
   * GET request con rate limiting y retry
   */
  async get(endpoint, params = {}, options = {}) {
    await this._ensureToken();
    return this.limiter.schedule(() =>
      withRetry(
        () => this.client.get(endpoint, { params, ...(options.signal ? { signal: options.signal } : {}) }),
        {
          maxRetries: 3,
          baseDelay: 2000,
          shouldRetry: shouldRetryMetaError,
          label: `META GET ${endpoint}`
        }
      )
    ).then(res => {
      this._checkRateLimitHeaders(res);
      return res.data;
    }).catch(err => {
      // Detect Meta rate limit errors (code 17) and set cooldown
      const metaError = err.response?.data?.error;
      if (metaError?.code === 17 || metaError?.code === 4) {
        const regainIn = metaError.estimated_time_to_regain_access || 60;
        // Use Meta's suggested wait time + small buffer, not a blanket 60s minimum.
        // When Meta says 10s, waiting 60s wastes 50s of live data availability.
        this.setRateLimited(Math.max(regainIn + 5, 15));
      }
      throw err;
    });
  }

  /**
   * POST request con rate limiting y retry
   */
  async post(endpoint, data = {}) {
    await this._ensureToken();
    return this.limiter.schedule(() =>
      withRetry(
        () => this.client.post(endpoint, null, { params: data }),
        {
          maxRetries: 3,
          baseDelay: 2000,
          shouldRetry: shouldRetryMetaError,
          label: `META POST ${endpoint}`
        }
      )
    ).then(res => {
      this._checkRateLimitHeaders(res);
      return res.data;
    });
  }

  /**
   * Batch API — combina hasta 50 requests en una sola llamada
   */
  async batch(requests) {
    const batches = [];
    for (let i = 0; i < requests.length; i += 50) {
      batches.push(requests.slice(i, i + 50));
    }

    const results = [];
    for (const batch of batches) {
      const batchPayload = batch.map((req, idx) => ({
        method: req.method || 'GET',
        relative_url: `${req.endpoint}?${new URLSearchParams(req.params || {}).toString()}`,
        name: req.name || `req_${idx}`
      }));

      const response = await this.limiter.schedule(() =>
        withRetry(
          () => this.client.post('/', null, {
            params: {
              batch: JSON.stringify(batchPayload)
            }
          }),
          {
            maxRetries: 2,
            baseDelay: 3000,
            shouldRetry: shouldRetryMetaError,
            label: 'META BATCH'
          }
        )
      );

      const batchResults = response.data.map((item, idx) => {
        try {
          return {
            name: batch[idx].name || `req_${idx}`,
            status: item.code,
            data: JSON.parse(item.body)
          };
        } catch (e) {
          return {
            name: batch[idx].name || `req_${idx}`,
            status: item.code,
            data: null,
            error: 'Error parseando respuesta'
          };
        }
      });

      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Obtener todas las campañas de la cuenta
   */
  async getCampaigns(fields = null, filters = null) {
    const defaultFields = [
      'id', 'name', 'status', 'effective_status', 'objective',
      'daily_budget', 'lifetime_budget', 'budget_remaining',
      'created_time', 'updated_time'
    ].join(',');

    const defaultFilters = JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
    ]);

    const params = {
      fields: fields || defaultFields,
      filtering: filters || defaultFilters,
      limit: 100
    };

    const data = await this.get(`/${this.adAccountId}/campaigns`, params);
    return data.data || [];
  }

  /**
   * Obtener ad sets de una campaña
   */
  async getAdSets(campaignId, fields = null) {
    const defaultFields = [
      'id', 'name', 'status', 'effective_status',
      'daily_budget', 'lifetime_budget', 'budget_remaining',
      'bid_strategy', 'optimization_goal',
      'created_time', 'updated_time'
    ].join(',');

    const params = {
      fields: fields || defaultFields,
      filtering: JSON.stringify([
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
      ]),
      limit: 200
    };

    const data = await this.get(`/${campaignId}/adsets`, params);
    return data.data || [];
  }

  /**
   * Obtener TODOS los ad sets de la cuenta directamente (avoids N+1 campaign queries).
   * Uses /{ad_account_id}/adsets endpoint. Much faster than campaign→adsets loop.
   */
  async getAllAdSets(fields = null, filters = null) {
    const defaultFields = [
      'id', 'name', 'status', 'effective_status',
      'daily_budget', 'lifetime_budget', 'budget_remaining',
      'bid_strategy', 'optimization_goal',
      'campaign_id', 'created_time', 'updated_time'
    ].join(',');

    const defaultFilters = JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
    ]);

    const params = {
      fields: fields || defaultFields,
      filtering: filters || defaultFilters,
      limit: 200
    };

    try {
      const data = await this.get(`/${this.adAccountId}/adsets`, params);
      let results = data.data || [];

      // Handle pagination (with auth header and rate limit monitoring)
      let paging = data.paging;
      while (paging?.next) {
        const nextData = await this.limiter.schedule(() =>
          withRetry(
            () => axios.get(paging.next, { headers: { 'Authorization': `Bearer ${this.accessToken}` } }),
            { maxRetries: 2, baseDelay: 2000, shouldRetry: shouldRetryMetaError, label: 'META PAGINATION adsets' }
          )
        ).then(res => {
          this._checkRateLimitHeaders(res);
          return res.data;
        });
        results = results.concat(nextData.data || []);
        paging = nextData.paging;
      }

      return results;
    } catch (error) {
      const metaError = error.response?.data?.error;
      if (metaError) {
        logger.error(`[getAllAdSets] Meta API error: code=${metaError.code} type=${metaError.type} msg=${metaError.message}`);
      }
      throw error;
    }
  }

  /**
   * Obtener ads de un ad set
   */
  async getAds(adSetId, fields = null) {
    const defaultFields = [
      'id', 'name', 'status', 'effective_status',
      'creative', 'created_time', 'updated_time'
    ].join(',');

    const params = {
      fields: fields || defaultFields,
      filtering: JSON.stringify([
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
      ]),
      limit: 200
    };

    const data = await this.get(`/${adSetId}/ads`, params);
    return data.data || [];
  }

  /**
   * Obtener insights (métricas) de un objeto
   */
  async getInsights(objectId, params = {}) {
    const defaultFields = [
      'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc',
      'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
      'actions', 'action_values', 'cost_per_action_type',
      'reach', 'frequency'
    ].join(',');

    const insightParams = {
      fields: params.fields || defaultFields,
      ...params
    };

    // Si no se especifica time_range, usar hoy
    if (!insightParams.time_range) {
      const today = new Date().toISOString().split('T')[0];
      insightParams.time_range = JSON.stringify({ since: today, until: today });
    }

    // Check cache first
    const cacheKey = `${objectId}:${JSON.stringify(insightParams)}`;
    const cached = this._insightsCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._insightsCacheTTL) {
      return cached.data;
    }

    try {
      const data = await this.get(`/${objectId}/insights`, insightParams);
      const result = data.data || [];
      this._insightsCache.set(cacheKey, { data: result, ts: Date.now() });
      // Prune old cache entries periodically
      if (this._insightsCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of this._insightsCache) {
          if (now - v.ts > this._insightsCacheTTL) this._insightsCache.delete(k);
        }
      }
      return result;
    } catch (error) {
      // Si no hay datos para el período, Meta devuelve un error o array vacío
      if (error.response?.status === 400) {
        logger.debug(`Sin insights para ${objectId} en el período especificado`);
        return [];
      }
      throw error;
    }
  }

  /**
   * Obtener insights a nivel de cuenta con desglose por level (campaign/adset/ad).
   * UNA sola llamada retorna métricas de TODAS las entidades del nivel especificado.
   * Maneja paginación automáticamente.
   */
  async getAccountInsights(level, timeRange, extraParams = {}) {
    const fieldList = [
      'campaign_id', 'campaign_name',
      'adset_id', 'adset_name',
      'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc',
      'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
      'actions', 'action_values', 'cost_per_action_type',
      'reach', 'frequency'
    ];

    // Agregar ad_id y ad_name cuando pedimos nivel de ad
    if (level === 'ad') {
      fieldList.push('ad_id', 'ad_name');
    }

    const fields = fieldList.join(',');

    const params = {
      level,
      fields,
      time_range: JSON.stringify(timeRange),
      limit: 500,
      ...extraParams
    };

    try {
      const data = await this.get(`/${this.adAccountId}/insights`, params);
      let results = data.data || [];

      // Manejar paginación si hay más resultados (with auth header and rate limit monitoring)
      let paging = data.paging;
      while (paging?.next) {
        const nextData = await this.limiter.schedule(() =>
          withRetry(
            () => axios.get(paging.next, { headers: { 'Authorization': `Bearer ${this.accessToken}` } }),
            { maxRetries: 2, baseDelay: 2000, shouldRetry: shouldRetryMetaError, label: 'META PAGINATION' }
          )
        ).then(res => {
          this._checkRateLimitHeaders(res);
          return res.data;
        });
        results = results.concat(nextData.data || []);
        paging = nextData.paging;
      }

      return results;
    } catch (error) {
      if (error.response?.status === 400) {
        logger.debug(`Sin insights de cuenta para level=${level}`);
        return [];
      }
      throw error;
    }
  }

  /**
   * Obtener insights diarios (time_increment=1) a nivel de cuenta.
   * UNA sola llamada devuelve 1 row por entidad por día → el caller agrega localmente
   * en ventanas (today, 3d, 7d, 14d, 30d), eliminando la necesidad de 5 calls separadas.
   *
   * @param {string} level - 'campaign', 'adset', or 'ad'
   * @param {number} maxDays - How many days to fetch (default 30). Live endpoint uses 14
   *   to cut row count in half and avoid pagination timeouts.
   *
   * Results are cached for 90s so the live endpoint can reuse data the cron just fetched,
   * avoiding duplicate API calls through the shared Bottleneck limiter.
   * A request for 14 days will also match a cached 30-day response (superset).
   */
  async getAccountInsightsDaily(level, maxDays = 30, options = {}) {
    const moment = require('moment-timezone');
    const TIMEZONE = require('../../config').system.timezone || 'America/New_York';
    const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const sinceDays = Math.min(maxDays, 30);
    const sinceDate = moment().tz(TIMEZONE).subtract(sinceDays - 1, 'days').format('YYYY-MM-DD');

    // Check cache — a cached superset (30d) satisfies a smaller request (14d)
    const cacheKey = `${level}:${sinceDays}`;
    const now = Date.now();
    for (const [key, entry] of this._dailyInsightsCache) {
      if (now - entry.ts > this._dailyInsightsCacheTTL) {
        this._dailyInsightsCache.delete(key);
        continue;
      }
      // Match if same level and cached range covers requested range
      if (key.startsWith(`${level}:`) && entry.sinceDate <= sinceDate) {
        logger.debug(`[DAILY-CACHE] Hit for ${cacheKey} (from ${key}, ${entry.data.length} rows, age ${Math.round((now - entry.ts) / 1000)}s)`);
        // If cached has more days than needed, filter rows to requested range
        if (entry.sinceDate < sinceDate) {
          return entry.data.filter(r => r.date_start >= sinceDate);
        }
        return entry.data;
      }
    }

    const fieldList = [
      'campaign_id', 'campaign_name',
      'adset_id', 'adset_name',
      'spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc',
      'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
      'actions', 'action_values', 'cost_per_action_type',
      'reach', 'frequency'
    ];

    if (level === 'ad') {
      fieldList.push('ad_id', 'ad_name');
    }

    const params = {
      level,
      fields: fieldList.join(','),
      time_range: JSON.stringify({ since: sinceDate, until: today }),
      time_increment: 1, // 1 row per entity per day
      limit: 500
    };

    try {
      const data = await this.get(`/${this.adAccountId}/insights`, params, options);
      let results = data.data || [];

      // Paginate (daily breakdown × many entities can exceed 500 rows)
      let paging = data.paging;
      while (paging?.next) {
        const nextData = await this.limiter.schedule(() =>
          withRetry(
            () => axios.get(paging.next, { headers: { 'Authorization': `Bearer ${this.accessToken}` }, ...(options.signal ? { signal: options.signal } : {}) }),
            { maxRetries: 2, baseDelay: 2000, shouldRetry: shouldRetryMetaError, label: `META PAGINATION daily ${level}` }
          )
        ).then(res => {
          this._checkRateLimitHeaders(res);
          return res.data;
        });
        results = results.concat(nextData.data || []);
        paging = nextData.paging;
      }

      // Cache the results
      this._dailyInsightsCache.set(cacheKey, { data: results, ts: Date.now(), sinceDate });

      return results;
    } catch (error) {
      if (error.response?.status === 400) {
        logger.debug(`Sin insights diarios de cuenta para level=${level}`);
        return [];
      }
      throw error;
    }
  }

  /**
   * Obtener campañas con sus ad sets en 1 sola call usando field expansion.
   * Reemplaza getCampaigns() + getAllAdSets() (2 calls → 1).
   */
  async getCampaignsWithAdSets() {
    const campaignFields = 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time';
    const adsetFields = 'id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,optimization_goal,campaign_id,created_time,updated_time';

    const params = {
      fields: `${campaignFields},adsets.limit(200){${adsetFields}}`,
      filtering: JSON.stringify([
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
      ]),
      limit: 100
    };

    const data = await this.get(`/${this.adAccountId}/campaigns`, params);
    const campaigns = data.data || [];

    const campaignMap = {};
    const adSetMap = {};

    for (const c of campaigns) {
      const { adsets, ...campaignData } = c;
      campaignMap[c.id] = campaignData;

      if (adsets?.data) {
        for (const as of adsets.data) {
          adSetMap[as.id] = { ...as, campaign_name: c.name, campaign_id: c.id };
        }
      }
    }

    return { campaigns: Object.values(campaignMap), campaignMap, adSetMap };
  }

  /**
   * Multi-object read: obtener datos de múltiples objetos en 1 sola call usando ?ids=.
   * Acepta un array de IDs y devuelve un map { id: data }.
   */
  async getMultipleObjects(ids, fields) {
    if (!ids || ids.length === 0) return {};

    // Meta permite ~50 IDs por call (similar a batch limit)
    const results = {};
    const CHUNK_SIZE = 50;

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      try {
        const data = await this.get('/', {
          ids: chunk.join(','),
          fields
        });
        Object.assign(results, data);
      } catch (err) {
        logger.warn(`[getMultipleObjects] Error fetching chunk ${i}-${i + chunk.length}: ${err.message}`);
        // Continue with next chunk — partial results are better than none
      }
    }

    return results;
  }

  /**
   * Actualizar presupuesto diario de un ad set (en dólares)
   */
  async updateBudget(adSetId, newBudgetDollars) {
    const budgetCents = Math.round(newBudgetDollars * 100);
    logger.info(`Actualizando presupuesto de ${adSetId} a $${newBudgetDollars} (${budgetCents} centavos)`);

    return this.post(`/${adSetId}`, {
      daily_budget: budgetCents
    });
  }

  /**
   * Actualizar status de un objeto (ACTIVE o PAUSED)
   */
  async updateStatus(objectId, status) {
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      throw new Error(`Status inválido: ${status}. Debe ser ACTIVE o PAUSED`);
    }

    logger.info(`Actualizando status de ${objectId} a ${status}`);
    return this.post(`/${objectId}`, { status });
  }

  /**
   * Eliminar un objeto de Meta (ad, adset, campaign).
   * Intenta HTTP DELETE primero, si falla intenta POST con status=DELETED.
   */
  async deleteObject(objectId) {
    await this._ensureToken();
    logger.info(`Eliminando objeto ${objectId} de Meta`);

    // Approach 1: HTTP DELETE /{object_id}
    try {
      const res = await this.limiter.schedule(() =>
        withRetry(
          () => this.client.delete(`/${objectId}`),
          {
            maxRetries: 1,
            baseDelay: 2000,
            shouldRetry: shouldRetryMetaError,
            label: `META DELETE ${objectId}`
          }
        )
      );
      this._checkRateLimitHeaders(res);
      logger.info(`Objeto ${objectId} eliminado via HTTP DELETE`);
      return res.data;
    } catch (deleteErr) {
      logger.warn(`HTTP DELETE falló para ${objectId}: ${deleteErr.response?.data?.error?.message || deleteErr.message}. Intentando POST con status=DELETED...`);
    }

    // Approach 2: POST /{object_id} with status=DELETED
    const res = await this.limiter.schedule(() =>
      withRetry(
        () => this.client.post(`/${objectId}`, null, { params: { status: 'DELETED' } }),
        {
          maxRetries: 2,
          baseDelay: 2000,
          shouldRetry: shouldRetryMetaError,
          label: `META POST-DELETE ${objectId}`
        }
      )
    );
    this._checkRateLimitHeaders(res);
    logger.info(`Objeto ${objectId} eliminado via POST status=DELETED`);
    return res.data;
  }

  /**
   * Obtener detalles creativos de los ads de un ad set.
   * Retorna headline, body, CTA, image URL para cada ad.
   */
  async getAdCreativeDetails(adSetId) {
    const fields = [
      'id', 'name', 'status', 'effective_status',
      'creative{id,title,body,image_url,thumbnail_url,call_to_action_type,object_story_spec}'
    ].join(',');

    const params = {
      fields,
      filtering: JSON.stringify([
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }
      ]),
      limit: 100
    };

    try {
      const data = await this.get(`/${adSetId}/ads`, params);
      const ads = data.data || [];

      return ads.map(ad => {
        const creative = ad.creative || {};
        const storySpec = creative.object_story_spec || {};
        const linkData = storySpec.link_data || {};

        return {
          ad_id: ad.id,
          ad_name: ad.name,
          status: ad.effective_status,
          creative_id: creative.id || null,
          title: creative.title || linkData.name || '',
          body: creative.body || linkData.message || '',
          description: linkData.description || '',
          image_url: creative.image_url || creative.thumbnail_url || '',
          call_to_action: creative.call_to_action_type || linkData.call_to_action?.type || '',
          link_url: linkData.link || ''
        };
      });
    } catch (error) {
      logger.warn(`Error obteniendo creativos de ad set ${adSetId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtener detalles creativos de TODOS los ad sets de la cuenta.
   * Agrupa los creativos por ad set ID.
   */
  async getAllCreativeDetails() {
    const campaigns = await this.getCampaigns();
    const creativesByAdSet = {};

    for (const campaign of campaigns) {
      try {
        const adSets = await this.getAdSets(campaign.id);
        for (const adSet of adSets) {
          const creatives = await this.getAdCreativeDetails(adSet.id);
          if (creatives.length > 0) {
            creativesByAdSet[adSet.id] = {
              adset_name: adSet.name,
              campaign_name: campaign.name,
              campaign_id: campaign.id,
              status: adSet.effective_status,
              creatives
            };
          }
        }
      } catch (err) {
        logger.warn(`Error obteniendo creativos de campaña ${campaign.id}: ${err.message}`);
      }
    }

    return creativesByAdSet;
  }

  /**
   * Extraer la URL del website/tienda de un ad creative existente.
   * Busca en los ad sets activos hasta encontrar un link_url válido.
   * Se usa como fallback cuando los assets no tienen link_url.
   */
  async getWebsiteUrl() {
    // Config fallback first — fastest path
    if (config.meta.defaultLinkUrl) {
      return config.meta.defaultLinkUrl;
    }

    // Cache from previous lookup
    if (this._cachedWebsiteUrl) {
      return this._cachedWebsiteUrl;
    }

    try {
      // Fast path: query ads directly from the ad account with creative info
      const adsData = await this.get(`/${this.adAccountId}/ads`, {
        fields: 'creative{object_story_spec}',
        limit: 20,
        status: ['ACTIVE', 'PAUSED']
      });

      for (const ad of (adsData.data || [])) {
        const spec = ad.creative?.object_story_spec;
        const linkUrl = spec?.link_data?.link || spec?.video_data?.call_to_action?.value?.link;
        if (linkUrl && linkUrl.startsWith('http')) {
          logger.info(`Website URL encontrada (fast path): ${linkUrl}`);
          this._cachedWebsiteUrl = linkUrl;
          return linkUrl;
        }
      }
    } catch (e) {
      logger.warn(`Error buscando website URL (fast path): ${e.message}`);
    }

    // Slow fallback: walk campaigns → adsets → creatives
    try {
      const campaigns = await this.getCampaigns();
      for (const campaign of campaigns) {
        const adSets = await this.getAdSets(campaign.id);
        for (const adSet of adSets) {
          if (adSet.effective_status !== 'ACTIVE') continue;
          const creatives = await this.getAdCreativeDetails(adSet.id);
          for (const creative of creatives) {
            if (creative.link_url && creative.link_url.startsWith('http')) {
              logger.info(`Website URL encontrada (fallback): ${creative.link_url}`);
              this._cachedWebsiteUrl = creative.link_url;
              return creative.link_url;
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`Error buscando website URL: ${e.message}`);
    }
    return null;
  }

  // ========================================================================
  // AD SET CREATION
  // ========================================================================

  /**
   * Crear un ad set nuevo desde cero.
   * Meta API: POST /act_{ad_account_id}/adsets
   * Siempre se crea PAUSED para revisión.
   */
  async createAdSet(params) {
    const {
      campaign_id, name, daily_budget, optimization_goal = 'OFFSITE_CONVERSIONS',
      billing_event = 'IMPRESSIONS', bid_strategy = 'LOWEST_COST_WITHOUT_CAP',
      targeting = null, promoted_object = null, status = 'PAUSED'
    } = params;

    if (!campaign_id) throw new Error('campaign_id es requerido para crear ad set');
    if (!daily_budget) throw new Error('daily_budget es requerido para crear ad set');

    // Targeting por defecto: USA, 18-65+, broad audience
    const defaultTargeting = {
      geo_locations: { countries: ['US'] },
      age_min: 18,
      age_max: 65
    };

    const adSetParams = {
      campaign_id,
      name: name || `AI Ad Set - ${new Date().toISOString().split('T')[0]}`,
      daily_budget: Math.round(daily_budget * 100), // Meta usa centavos
      optimization_goal,
      billing_event,
      targeting: JSON.stringify(targeting || defaultTargeting),
      pacing_type: JSON.stringify(['standard']), // Distribución uniforme durante el día — evita gastar el budget de golpe
      status
    };

    // Only send bid_strategy if explicitly provided and not the default
    // (sending LOWEST_COST_WITHOUT_CAP explicitly can cause 400 errors on some campaign types)
    if (bid_strategy && bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') {
      adSetParams.bid_strategy = bid_strategy;
    }

    // promoted_object es requerido para OFFSITE_CONVERSIONS
    if (promoted_object) {
      adSetParams.promoted_object = JSON.stringify(promoted_object);
    }

    logger.info(`Creando ad set: "${adSetParams.name}" — budget $${daily_budget}`, {
      campaign_id, optimization_goal, billing_event, bid_strategy,
      promoted_object: adSetParams.promoted_object || 'none'
    });
    const result = await this.post(`/${this.adAccountId}/adsets`, adSetParams);

    return {
      success: true,
      adset_id: result.id,
      name: adSetParams.name
    };
  }

  /**
   * Obtener el pixel ID y promoted_object de un ad set existente.
   * Se usa para copiar la configuración de conversión al crear nuevos ad sets.
   */
  async getPromotedObject(adSetId) {
    try {
      const data = await this.get(`/${adSetId}`, {
        fields: 'promoted_object,optimization_goal,billing_event,bid_strategy'
      });
      return {
        promoted_object: data.promoted_object || null,
        optimization_goal: data.optimization_goal || 'OFFSITE_CONVERSIONS',
        billing_event: data.billing_event || 'IMPRESSIONS',
        bid_strategy: data.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'
      };
    } catch (error) {
      logger.warn(`No se pudo obtener promoted_object de ${adSetId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Obtener pixel ID y promoted_object para crear ad sets.
   * 3 tiers: config env → /adspixels API → ad sets scan
   */
  async getPixelId() {
    // Cache from previous lookup
    if (this._cachedPixelInfo) {
      return this._cachedPixelInfo;
    }

    // Tier 1: Config env variable (fastest — no API call)
    if (config.meta.pixelId) {
      const result = {
        pixel_id: config.meta.pixelId,
        promoted_object: { pixel_id: config.meta.pixelId, custom_event_type: 'PURCHASE' },
        source: 'config',
        optimization_goal: 'OFFSITE_CONVERSIONS',
        billing_event: 'IMPRESSIONS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP'
      };
      logger.info(`Pixel ID from config: ${result.pixel_id}`);
      this._cachedPixelInfo = result;
      return result;
    }

    // Tier 2: Scan existing ad sets for promoted_object (copies exact working settings)
    // Try ACTIVE/PAUSED first, then broader search if no match
    for (const statusFilter of [
      ['ACTIVE', 'PAUSED'],
      ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED']
    ]) {
      try {
        const adSetsData = await this.get(`/${this.adAccountId}/adsets`, {
          fields: 'promoted_object,optimization_goal,billing_event,bid_strategy',
          filtering: JSON.stringify([
            { field: 'effective_status', operator: 'IN', value: statusFilter }
          ]),
          limit: 25
        });

        for (const adSet of (adSetsData.data || [])) {
          if (adSet.promoted_object?.pixel_id) {
            const result = {
              pixel_id: adSet.promoted_object.pixel_id,
              promoted_object: adSet.promoted_object,
              source: 'adset_scan',
              source_adset_id: adSet.id,
              optimization_goal: adSet.optimization_goal || 'OFFSITE_CONVERSIONS',
              billing_event: adSet.billing_event || 'IMPRESSIONS',
              bid_strategy: adSet.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'
            };
            logger.info(`Pixel ID from ad set scan: ${result.pixel_id} (promoted_object: ${JSON.stringify(adSet.promoted_object)})`);
            this._cachedPixelInfo = result;
            return result;
          }
        }
      } catch (error) {
        logger.warn(`No se pudo obtener pixel_id via ad sets (${statusFilter.join(',')}): ${error.message}`);
      }
    }

    // Tier 3: Query /adspixels directly (fallback when no ad sets exist)
    try {
      const pixelsData = await this.get(`/${this.adAccountId}/adspixels`, {
        fields: 'id,name',
        limit: 5
      });

      if (pixelsData.data && pixelsData.data.length > 0) {
        const pixel = pixelsData.data[0];
        const result = {
          pixel_id: pixel.id,
          promoted_object: { pixel_id: pixel.id, custom_event_type: 'PURCHASE' },
          source: 'adspixels_api',
          optimization_goal: 'OFFSITE_CONVERSIONS',
          billing_event: 'IMPRESSIONS',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP'
        };
        logger.info(`Pixel ID from /adspixels API: ${result.pixel_id} (${pixel.name})`);
        this._cachedPixelInfo = result;
        return result;
      }
    } catch (error) {
      logger.warn(`No se pudo obtener pixel via /adspixels: ${error.message}`);
    }

    return null;
  }

  // ========================================================================
  // NUEVAS ACCIONES DE ESCALABILIDAD
  // ========================================================================

  /**
   * Duplicar un ad set existente.
   * Meta API: POST /{adset_id}/copies
   * El ad set duplicado se crea PAUSADO por seguridad.
   */
  async duplicateAdSet(adSetId, options = {}) {
    const params = {
      status_option: 'PAUSED', // Siempre crear pausado para revisión
      rename_options: options.name ? JSON.stringify({ rename_suffix: '' }) : undefined,
      ...(options.daily_budget ? { daily_budget: Math.round(options.daily_budget * 100) } : {})
    };

    logger.info(`Duplicando ad set ${adSetId} con opciones: ${JSON.stringify(options)}`);

    const result = await this.post(`/${adSetId}/copies`, params);

    // Si se especificó nombre, renombrar el nuevo ad set
    if (options.name && result.copied_adset_id) {
      await this.post(`/${result.copied_adset_id}`, { name: options.name });
    }

    return {
      success: true,
      new_adset_id: result.copied_adset_id || result.id,
      original_adset_id: adSetId
    };
  }

  /**
   * Subir una imagen a Meta Ads.
   * Meta API: POST /act_{ad_account_id}/adimages
   * Retorna image_hash para usar en creativos.
   */
  async uploadImage(filePath) {
    await this._ensureToken();

    const form = new FormData();
    form.append('filename', fs.createReadStream(filePath));
    form.append('access_token', this.accessToken);

    logger.info(`Subiendo imagen a Meta: ${path.basename(filePath)}`);

    const response = await this.limiter.schedule(() =>
      withRetry(
        () => axios.post(
          `${this.baseUrl}/${this.adAccountId}/adimages`,
          form,
          { headers: form.getHeaders(), timeout: 60000 }
        ),
        { maxRetries: 2, baseDelay: 3000, shouldRetry: shouldRetryMetaError, label: 'META UPLOAD IMAGE' }
      )
    );

    const images = response.data.images || {};
    const imageData = Object.values(images)[0];

    if (!imageData || !imageData.hash) {
      throw new Error('Meta no retornó image_hash después del upload');
    }

    return {
      image_hash: imageData.hash,
      url: imageData.url || '',
      width: imageData.width,
      height: imageData.height
    };
  }

  /**
   * Subir un video a Meta Ads.
   * Meta API: POST /act_{ad_account_id}/advideos
   * Retorna video_id para usar en creativos.
   */
  async uploadVideo(filePath) {
    await this._ensureToken();

    const form = new FormData();
    form.append('source', fs.createReadStream(filePath));
    form.append('access_token', this.accessToken);

    logger.info(`Subiendo video a Meta: ${path.basename(filePath)}`);

    const response = await this.limiter.schedule(() =>
      withRetry(
        () => axios.post(
          `${this.baseUrl}/${this.adAccountId}/advideos`,
          form,
          { headers: form.getHeaders(), timeout: 120000 }
        ),
        { maxRetries: 2, baseDelay: 5000, shouldRetry: shouldRetryMetaError, label: 'META UPLOAD VIDEO' }
      )
    );

    if (!response.data || !response.data.id) {
      throw new Error('Meta no retornó video_id después del upload');
    }

    return {
      video_id: response.data.id
    };
  }

  /**
   * Crear un ad creative.
   * Meta API: POST /act_{ad_account_id}/adcreatives
   * Requiere: page_id, image_hash o video_id, copy, headline, CTA, link.
   */
  async createAdCreative(params) {
    const { page_id, image_hash, video_id, headline, body, description, cta, link_url } = params;

    if (!page_id) throw new Error('page_id es requerido para crear creative');
    if (!image_hash && !video_id) throw new Error('Se requiere image_hash o video_id');

    if (!link_url) {
      throw new Error('link_url es requerido para crear ad creative. Agrega el link de producto al creativo en el banco.');
    }

    const linkData = {
      message: body || '',
      link: link_url,
      name: headline || '',
      description: description || '',
      call_to_action: {
        type: cta || 'SHOP_NOW',
        value: { link: link_url }
      }
    };

    if (image_hash) {
      linkData.image_hash = image_hash;
    }

    if (video_id) {
      linkData.video_id = video_id;
    }

    const creativeParams = {
      name: `Creative - ${headline || 'Sin título'} - ${new Date().toISOString().split('T')[0]}`,
      object_story_spec: JSON.stringify({
        page_id,
        link_data: linkData
      })
    };

    logger.info(`Creando ad creative: "${headline}"`);
    const result = await this.post(`/${this.adAccountId}/adcreatives`, creativeParams);

    return {
      creative_id: result.id,
      name: creativeParams.name
    };
  }

  /**
   * Crear un ad creative con múltiples textos (asset_feed_spec).
   * Meta rota headlines/bodies automáticamente — 1 ad, múltiples copy variants.
   * Max: 5 bodies, 5 titles, 5 descriptions.
   */
  async createAdCreativeMultiText(params) {
    const { page_id, image_hash, video_id, headlines, bodies, descriptions, cta, link_url } = params;

    if (!page_id) throw new Error('page_id es requerido');
    if (!image_hash && !video_id) throw new Error('Se requiere image_hash o video_id');
    if (!link_url) throw new Error('link_url es requerido');

    const assetFeedSpec = {
      images: image_hash ? [{ hash: image_hash }] : [],
      videos: video_id ? [{ video_id }] : [],
      bodies: (bodies || ['']).slice(0, 5).map(t => ({ text: t || '' })),
      titles: (headlines || ['']).slice(0, 5).map(t => ({ text: t || '' })),
      descriptions: (descriptions || ['']).slice(0, 5).map(t => ({ text: t || '' })),
      ad_formats: [image_hash ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO'],
      link_urls: [{ website_url: link_url }],
      call_to_action_types: [cta || 'SHOP_NOW']
    };

    // Remove empty arrays
    if (assetFeedSpec.images.length === 0) delete assetFeedSpec.images;
    if (assetFeedSpec.videos.length === 0) delete assetFeedSpec.videos;

    const creativeParams = {
      name: `Creative - ${(headlines || [''])[0] || 'Multi-text'} - ${new Date().toISOString().split('T')[0]}`,
      object_story_spec: JSON.stringify({ page_id }),
      asset_feed_spec: JSON.stringify(assetFeedSpec)
    };

    const titlePreview = (headlines || []).slice(0, 2).join(' / ');
    logger.info(`Creando ad creative multi-text: "${titlePreview}" (${(headlines || []).length}h × ${(bodies || []).length}b)`);
    const result = await this.post(`/${this.adAccountId}/adcreatives`, creativeParams);

    return {
      creative_id: result.id,
      name: creativeParams.name
    };
  }

  /**
   * Crear un nuevo ad dentro de un ad set existente.
   * Meta API: POST /act_{ad_account_id}/ads
   * El ad se crea PAUSADO por seguridad.
   */
  async createAd(adSetId, creativeId, name, status = 'PAUSED') {
    if (!adSetId || !creativeId) {
      throw new Error('adSetId y creativeId son requeridos para crear ad');
    }

    const adParams = {
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      name: name || `Ad - ${new Date().toISOString().split('T')[0]}`,
      status
    };

    logger.info(`Creando ad en ad set ${adSetId}: "${name}"`);
    const result = await this.post(`/${this.adAccountId}/ads`, adParams);

    return {
      ad_id: result.id,
      adset_id: adSetId,
      creative_id: creativeId,
      name: adParams.name
    };
  }

  /**
   * Actualizar bid strategy de una campaña.
   * Meta API: POST /{campaign_id}
   * Opciones: LOWEST_COST_WITHOUT_CAP, COST_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITH_MIN_ROAS
   */
  async updateBidStrategy(campaignId, bidStrategy, bidAmount = null) {
    const validStrategies = [
      'LOWEST_COST_WITHOUT_CAP',
      'COST_CAP',
      'LOWEST_COST_WITH_BID_CAP',
      'LOWEST_COST_WITH_MIN_ROAS'
    ];

    if (!validStrategies.includes(bidStrategy)) {
      throw new Error(`Bid strategy inválida: ${bidStrategy}. Opciones: ${validStrategies.join(', ')}`);
    }

    const params = { bid_strategy: bidStrategy };
    if (bidAmount != null && bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') {
      params.bid_amount = Math.round(bidAmount * 100); // Meta usa centavos
    }

    logger.info(`Actualizando bid strategy de campaña ${campaignId} a ${bidStrategy}`);
    return this.post(`/${campaignId}`, params);
  }

  /**
   * Actualizar status de un ad individual.
   * Meta API: POST /{ad_id}
   */
  async updateAdStatus(adId, status) {
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      throw new Error(`Status inválido: ${status}. Debe ser ACTIVE o PAUSED`);
    }

    logger.info(`Actualizando status de ad ${adId} a ${status}`);
    return this.post(`/${adId}`, { status });
  }

  /**
   * Duplicar un ad con cambios de creative (via Ad Copies API).
   * Meta API: POST /{ad_id}/copies
   */
  async duplicateAd(adId, options = {}) {
    const params = {
      status_option: 'PAUSED'
    };

    logger.info(`Duplicando ad ${adId} con cambios de creative`);
    const result = await this.post(`/${adId}/copies`, params);

    // Si hay cambios de nombre, aplicarlos al nuevo ad
    if (options.name && result.copied_ad_id) {
      await this.post(`/${result.copied_ad_id}`, { name: options.name });
    }

    return {
      success: true,
      new_ad_id: result.copied_ad_id || result.id,
      original_ad_id: adId
    };
  }

  /**
   * Obtener información de la página de Facebook asociada a la cuenta.
   * Necesario para crear ad creatives.
   * Busca en TODAS las campañas/ad sets y usa config como fallback.
   */
  async getPageId() {
    // Config fallback first — fastest path
    if (config.meta.pageId) {
      return config.meta.pageId;
    }

    // Cache from previous lookup
    if (this._cachedPageId) {
      return this._cachedPageId;
    }

    try {
      // Fast path: query ads directly from the ad account (avoids deep nesting)
      const adsData = await this.get(`/${this.adAccountId}/ads`, {
        fields: 'creative{object_story_spec}',
        limit: 10,
        status: ['ACTIVE', 'PAUSED']
      });

      for (const ad of (adsData.data || [])) {
        const pageId = ad.creative?.object_story_spec?.page_id;
        if (pageId) {
          logger.info(`Page ID encontrado: ${pageId}`);
          this._cachedPageId = pageId;
          return pageId;
        }
      }
    } catch (error) {
      logger.warn(`No se pudo obtener page_id (fast path): ${error.message}`);
    }

    // Slow fallback: walk campaigns → adsets → ads
    try {
      const campaigns = await this.getCampaigns();
      for (const campaign of campaigns) {
        const adSets = await this.getAdSets(campaign.id);
        for (const adSet of adSets) {
          const ads = await this.getAdCreativeDetails(adSet.id);
          for (const ad of ads) {
            if (!ad.creative_id) continue;
            try {
              const creativeData = await this.get(`/${ad.creative_id}`, {
                fields: 'object_story_spec'
              });
              const pageId = creativeData.object_story_spec?.page_id;
              if (pageId) {
                logger.info(`Page ID encontrado (fallback): ${pageId}`);
                this._cachedPageId = pageId;
                return pageId;
              }
            } catch (e) {
              // Continue searching
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`No se pudo obtener page_id: ${error.message}`);
    }
    return null;
  }

  /**
   * Verificar que el token y la cuenta son válidos
   */
  async verifyAccess() {
    try {
      const me = await this.get('/me', { fields: 'id,name' });
      const account = await this.get(`/${this.adAccountId}`, {
        fields: 'id,name,account_status,currency,timezone_name'
      });

      return {
        success: true,
        user: me,
        account: account
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verificar salud del token (días restantes)
   */
  async checkTokenHealth() {
    try {
      const debug = await this.get('/debug_token', {
        input_token: this.accessToken
      });

      const data = debug.data;
      const expiresAt = data.expires_at;

      if (expiresAt === 0) {
        return { valid: true, expires: 'never', daysLeft: Infinity };
      }

      const expiresDate = new Date(expiresAt * 1000);
      const daysLeft = Math.floor((expiresDate - new Date()) / (1000 * 60 * 60 * 24));

      return {
        valid: data.is_valid,
        expires: expiresDate.toISOString(),
        daysLeft,
        scopes: data.scopes
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

// Singleton
let instance;
function getMetaClient() {
  if (!instance) {
    instance = new MetaClient();
  }
  return instance;
}

module.exports = { MetaClient, getMetaClient };
