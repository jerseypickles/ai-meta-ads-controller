const { getMetaClient } = require('./client');
const { parseInsightRow, aggregateDailyInsights, calculateROASTrend, calculateSpendVelocity, parseBudget } = require('./helpers');
const { withRetry, shouldRetryMetaError } = require('../utils/retry');
const MetricSnapshot = require('../db/models/MetricSnapshot');
const AICreation = require('../db/models/AICreation');
const logger = require('../utils/logger');
const kpiTargets = require('../../config/kpi-targets');

class DataCollector {
  constructor() {
    this.meta = getMetaClient();
  }

  /**
   * Ciclo principal de recolección de datos — OPTIMIZADO.
   *
   * Antes: ~18 API calls seriales (5 ventanas × 3 niveles + structural queries)
   * Ahora:  ~5 API calls (1 field-expansion + 3 daily-insights + 1 ads-status)
   *
   * Optimizaciones aplicadas:
   * 1. getCampaignsWithAdSets() — field expansion: 2 calls → 1
   * 2. getAccountInsightsDaily() — time_increment=1: 5 calls/level → 1 call/level
   * 3. getMultipleObjects() — multi-object read for AI creations: N calls → 1
   * 4. Promise.allSettled — 3 insight levels fetched in parallel
   * 5. Pagination with retry + rate limit header monitoring
   */
  async collect() {
    const startTime = Date.now();
    const COLLECT_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutos máximo — abortar si excede
    logger.info('═══ Iniciando ciclo de recolección de datos ═══');

    this.meta.setBusy('data-collector');

    // Global timeout: si el collect toma más de 4 min, abortar y limpiar busy flag
    const timeoutPromise = new Promise((_, reject) => {
      this._collectTimeout = setTimeout(() => {
        reject(new Error('COLLECT_TIMEOUT: Recolección excedió 4 minutos — abortando'));
      }, COLLECT_TIMEOUT_MS);
    });

    try {
      // Race entre la recolección real y el timeout global
      const result = await Promise.race([
        this._doCollect(),
        timeoutPromise
      ]);
      clearTimeout(this._collectTimeout);
      this.meta.clearBusy();
      return result;
    } catch (error) {
      clearTimeout(this._collectTimeout);
      this.meta.clearBusy();
      const errMsg = error.response?.data?.error?.message || error.message || 'Error desconocido';
      logger.error(`Error en ciclo de recolección: ${errMsg}`);
      throw error;
    }
  }

  /**
   * Lógica interna de recolección — separada para poder aplicar timeout global.
   */
  async _doCollect() {
    const startTime = Date.now();

    try {
      const WINDOWS = ['today', 'last_3d', 'last_7d', 'last_14d', 'last_30d'];
      let totalSnapshots = 0;

      // ── 1. Structural data: campaigns + ad sets in 1 call (field expansion) ──
      let campaigns, campaignMap, adSetMap;
      try {
        const result = await this.meta.getCampaignsWithAdSets();
        campaigns = result.campaigns;
        campaignMap = result.campaignMap;
        adSetMap = result.adSetMap;
        logger.info(`  ${campaigns.length} campañas + ${Object.keys(adSetMap).length} ad sets (1 API call, field expansion)`);
      } catch (err) {
        // Fallback: separate calls if field expansion fails (some account types)
        logger.warn(`  getCampaignsWithAdSets() failed (${err.message}), falling back to separate calls`);
        campaigns = await this.meta.getCampaigns();
        campaignMap = {};
        adSetMap = {};
        for (const c of campaigns) campaignMap[c.id] = c;
        try {
          const allAdSets = await this.meta.getAllAdSets();
          for (const as of allAdSets) {
            adSetMap[as.id] = { ...as, campaign_name: campaignMap[as.campaign_id]?.name || 'Unknown', campaign_id: as.campaign_id };
          }
        } catch (e) {
          logger.warn(`  getAllAdSets() also failed: ${e.message}`);
        }
        logger.info(`  ${campaigns.length} campañas + ${Object.keys(adSetMap).length} ad sets (fallback, 2 API calls)`);
      }

      // ── 1.5. Inject AI-managed ad sets using multi-object read (N calls → 1) ──
      try {
        const aiCreations = await AICreation.find({
          creation_type: 'create_adset',
          managed_by_ai: true,
          meta_entity_id: { $exists: true, $ne: null }
        }).lean();

        const missingIds = aiCreations
          .map(c => c.meta_entity_id)
          .filter(id => !adSetMap[id]);

        if (missingIds.length > 0) {
          const fields = 'id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,campaign_id';
          const fetched = await this.meta.getMultipleObjects(missingIds, fields);

          let injected = 0;
          for (const [asId, info] of Object.entries(fetched)) {
            if (info.error) continue; // Object not accessible
            const campaignId = info.campaign_id;
            const creation = aiCreations.find(c => c.meta_entity_id === asId);
            adSetMap[asId] = {
              ...info,
              campaign_name: campaignMap[campaignId]?.name || creation?.campaign_name || 'Unknown',
              campaign_id: campaignId
            };
            injected++;
          }
          if (injected > 0) {
            logger.info(`  ${injected} ad sets AI-managed inyectados (multi-object read, 1 API call)`);
          }
        }
      } catch (err) {
        logger.warn(`  Error inyectando ad sets AI-managed: ${err.message}`);
      }

      const totalAdSets = Object.keys(adSetMap).length;

      // ── 2. Fetch daily insights for all 3 levels IN PARALLEL (3 calls total) ──
      //    Each call returns 1 row per entity per day for 30 days.
      //    aggregateDailyInsights() computes today/3d/7d/14d/30d locally.
      logger.info('Recolectando insights diarios (3 calls paralelas: campaign + adset + ad)...');

      const [campaignResult, adsetResult, adResult] = await Promise.allSettled([
        this.meta.getAccountInsightsDaily('campaign'),
        this.meta.getAccountInsightsDaily('adset'),
        this.meta.getAccountInsightsDaily('ad')
      ]);

      // Process campaign insights
      const campaignInsights = campaignResult.status === 'fulfilled'
        ? aggregateDailyInsights(campaignResult.value, 'campaign_id')
        : {};
      if (campaignResult.status === 'rejected') {
        logger.warn(`  Campaign insights failed: ${campaignResult.reason?.message}`);
      } else {
        logger.info(`  Campaign insights: ${campaignResult.value.length} daily rows → ${Object.keys(campaignInsights).length} entidades`);
      }

      // Process adset insights
      const adSetInsights = adsetResult.status === 'fulfilled'
        ? aggregateDailyInsights(adsetResult.value, 'adset_id')
        : {};
      if (adsetResult.status === 'rejected') {
        logger.warn(`  Ad set insights failed: ${adsetResult.reason?.message}`);
      } else {
        logger.info(`  Ad set insights: ${adsetResult.value.length} daily rows → ${Object.keys(adSetInsights).length} entidades`);
      }

      // Process ad insights (also extract ad metadata from the rows)
      const adMetadata = {}; // { adId: { ad_name, adset_id, campaign_id } }
      let adDailyInsights = {};
      if (adResult.status === 'fulfilled') {
        // Extract ad names/parents from the raw rows before aggregation
        for (const row of adResult.value) {
          const adId = row.ad_id;
          if (!adId) continue;
          if (!adMetadata[adId]) {
            adMetadata[adId] = {
              ad_name: row.ad_name || 'Sin nombre',
              adset_id: row.adset_id,
              campaign_id: row.campaign_id
            };
          }
        }
        adDailyInsights = aggregateDailyInsights(adResult.value, 'ad_id');
        logger.info(`  Ad insights: ${adResult.value.length} daily rows → ${Object.keys(adDailyInsights).length} entidades`);
      } else {
        logger.warn(`  Ad insights failed: ${adResult.reason?.message}`);
      }

      // ── 3. Save campaign snapshots (bulkWrite — 1 round-trip instead of N) ──
      const now = new Date();
      const campaignOps = campaigns.map(campaign => {
        const metrics = {};
        for (const w of WINDOWS) {
          metrics[w] = campaignInsights[campaign.id]?.[w] || this._emptyMetrics();
        }
        return {
          insertOne: {
            document: {
              entity_type: 'campaign',
              entity_id: campaign.id,
              entity_name: campaign.name,
              parent_id: null,
              campaign_id: campaign.id,
              status: campaign.effective_status,
              daily_budget: parseBudget(campaign.daily_budget),
              lifetime_budget: parseBudget(campaign.lifetime_budget),
              budget_remaining: parseBudget(campaign.budget_remaining),
              metrics,
              analysis: this._buildAnalysis(metrics),
              snapshot_at: now
            }
          }
        };
      });
      if (campaignOps.length > 0) {
        await MetricSnapshot.bulkWrite(campaignOps, { ordered: false });
        totalSnapshots += campaignOps.length;
      }
      logger.info(`  ${campaigns.length} snapshots de campañas guardados`);

      // ── 4. Get ad status (account-level, 1 call) ──
      logger.info('Recolectando status de ads (account-level)...');
      const adStatusMap = {};
      const adsPerAdSet = {};
      let adsFetchSuccess = false;
      try {
        const allAdsData = await this.meta.get(`/${this.meta.adAccountId}/ads`, {
          fields: 'id,name,effective_status,adset_id,campaign_id,created_time',
          filtering: JSON.stringify([
            { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'WITH_ISSUES'] }
          ]),
          limit: 500
        });

        let allAds = allAdsData.data || [];

        // Paginate with retry and auth header
        let paging = allAdsData.paging;
        while (paging?.next) {
          const nextRes = await this.meta.limiter.schedule(() =>
            withRetry(
              () => require('axios').get(paging.next, { headers: { 'Authorization': `Bearer ${this.meta.accessToken}` } }),
              { maxRetries: 2, baseDelay: 2000, shouldRetry: shouldRetryMetaError, label: 'META PAGINATION ads' }
            )
          );
          allAds = allAds.concat(nextRes.data?.data || []);
          paging = nextRes.data?.paging;
        }

        adsFetchSuccess = true;
        let newAdsInjected = 0;
        for (const ad of allAds) {
          adStatusMap[ad.id] = ad.effective_status || 'ACTIVE';
          if (ad.adset_id && ad.effective_status === 'ACTIVE') {
            adsPerAdSet[ad.adset_id] = (adsPerAdSet[ad.adset_id] || 0) + 1;
          }
          // Inject new ads that have no insights yet into adMetadata
          // so they get a snapshot created (with empty metrics).
          // Without this, recently created ads are invisible until Meta
          // processes their first insight row (can take hours).
          // Store created_time for all ads (existing or new)
          if (adMetadata[ad.id] && ad.created_time) {
            adMetadata[ad.id].created_time = ad.created_time;
          }
          if (!adMetadata[ad.id] && ad.name) {
            adMetadata[ad.id] = {
              ad_name: ad.name,
              adset_id: ad.adset_id || null,
              campaign_id: ad.campaign_id || null,
              created_time: ad.created_time || null
            };
            newAdsInjected++;
          }
        }
        if (newAdsInjected > 0) {
          logger.info(`  ${newAdsInjected} new ads (no insights yet) injected for snapshot tracking`);
        }
        logger.info(`  ${allAds.length} ads con status real obtenido`);
      } catch (err) {
        logger.warn(`  Error obteniendo ads a nivel de cuenta: ${err.message} — preservando status existente`);
      }

      // ── 5. Save ad set snapshots (bulkWrite — 1 round-trip instead of N) ──
      const adSetEntries = Object.entries(adSetMap);
      const adSetOps = adSetEntries.map(([adSetId, info]) => {
        const metrics = {};
        for (const w of WINDOWS) {
          metrics[w] = adSetInsights[adSetId]?.[w] || this._emptyMetrics();
        }
        return {
          insertOne: {
            document: {
              entity_type: 'adset',
              entity_id: info.id,
              entity_name: info.name,
              parent_id: info.campaign_id,
              campaign_id: info.campaign_id,
              status: info.effective_status,
              daily_budget: parseBudget(info.daily_budget),
              lifetime_budget: parseBudget(info.lifetime_budget),
              budget_remaining: parseBudget(info.budget_remaining),
              metrics,
              analysis: this._buildAnalysis(metrics),
              ads_count: adsPerAdSet[adSetId] || 0,
              snapshot_at: now
            }
          }
        };
      });
      if (adSetOps.length > 0) {
        await MetricSnapshot.bulkWrite(adSetOps, { ordered: false });
        totalSnapshots += adSetOps.length;
      }
      const adSetSnapshots = adSetOps.length;
      logger.info(`  ${adSetSnapshots} snapshots de ad sets guardados`);

      // ── 6. Save ad snapshots (bulkWrite — 1 round-trip instead of N) ──
      // Pre-fetch existing statuses in bulk for ads that need fallback (1 query vs N)
      const adEntries = Object.entries(adMetadata);
      let fallbackStatusMap = {};
      if (!adsFetchSuccess) {
        const idsNeedingStatus = adEntries
          .filter(([adId]) => !adStatusMap[adId])
          .map(([adId]) => adId);
        if (idsNeedingStatus.length > 0) {
          const existing = await MetricSnapshot.aggregate([
            { $match: { entity_type: 'ad', entity_id: { $in: idsNeedingStatus } } },
            { $sort: { snapshot_at: -1 } },
            { $group: { _id: '$entity_id', status: { $first: '$status' } } }
          ]);
          for (const doc of existing) {
            fallbackStatusMap[doc._id] = doc.status;
          }
        }
      }

      const adOps = adEntries.map(([adId, adData]) => {
        let adStatus = adStatusMap[adId];
        if (!adStatus && !adsFetchSuccess) {
          adStatus = fallbackStatusMap[adId] || 'ACTIVE';
        } else if (!adStatus) {
          adStatus = 'DELETED';
        }

        const metrics = {};
        for (const w of WINDOWS) {
          metrics[w] = adDailyInsights[adId]?.[w] || this._emptyMetrics();
        }
        return {
          insertOne: {
            document: {
              entity_type: 'ad',
              entity_id: adId,
              entity_name: adData.ad_name,
              parent_id: adData.adset_id,
              campaign_id: adData.campaign_id,
              status: adStatus,
              meta_created_time: adData.created_time ? new Date(adData.created_time) : null,
              metrics,
              analysis: this._buildAnalysis(metrics),
              snapshot_at: now
            }
          }
        };
      });
      if (adOps.length > 0) {
        await MetricSnapshot.bulkWrite(adOps, { ordered: false });
        totalSnapshots += adOps.length;
      }
      const adSnapshots = adOps.length;
      logger.info(`  ${adSnapshots} snapshots de ads/creativos guardados`);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`${totalSnapshots} snapshots guardados en MongoDB`);
      logger.info(`═══ Recolección completada en ${elapsed}s (${totalAdSets} ad sets, ${adSnapshots} ads, ~5 API calls) ═══`);

      return {
        success: true,
        campaigns: campaigns.length,
        adsets: totalAdSets,
        ads: adSnapshots,
        snapshots: totalSnapshots,
        elapsed: `${elapsed}s`
      };
    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message || 'Error desconocido';
      logger.error(`Error en _doCollect: ${errMsg}`);
      throw error;
    }
  }

  /**
   * Construye el análisis derivado a partir de las métricas.
   */
  _buildAnalysis(metrics) {
    const roas3d = metrics.last_3d?.roas || 0;
    const roas7d = metrics.last_7d?.roas || 0;
    const todaySpend = metrics.today?.spend || 0;

    // CTR promedio de 7 días como referencia
    const avgCTR = metrics.last_7d?.ctr || 0;
    const todayCTR = metrics.today?.ctr || 0;
    const ctrVsAvg = avgCTR > 0 ? ((todayCTR - avgCTR) / avgCTR) * 100 : 0;

    return {
      roas_trend: calculateROASTrend(roas3d, roas7d),
      roas_3d_vs_7d: roas7d > 0 ? roas3d / roas7d : 0,
      spend_velocity: calculateSpendVelocity(todaySpend, kpiTargets.daily_spend_target),
      frequency_alert: (metrics.last_7d?.frequency || 0) > kpiTargets.frequency_warning,
      ctr_vs_average: ctrVsAvg
    };
  }

  /**
   * Retorna métricas vacías para cuando Meta no tiene datos.
   */
  _emptyMetrics() {
    return {
      spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, cpc: 0,
      purchases: 0, purchase_value: 0, roas: 0, cpa: 0, reach: 0, frequency: 0
    };
  }
}

module.exports = DataCollector;
