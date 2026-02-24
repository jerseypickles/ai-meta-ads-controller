const { getMetaClient } = require('./client');
const { parseInsightRow, calculateROASTrend, calculateSpendVelocity, parseBudget, getTimeRanges } = require('./helpers');
const MetricSnapshot = require('../db/models/MetricSnapshot');
const AICreation = require('../db/models/AICreation');
const logger = require('../utils/logger');
const kpiTargets = require('../../config/kpi-targets');

class DataCollector {
  constructor() {
    this.meta = getMetaClient();
  }

  /**
   * Ciclo principal de recolección de datos.
   * Usa llamadas a nivel de cuenta (level=campaign/adset) para obtener
   * TODAS las métricas en pocas llamadas API (~8 total).
   */
  async collect() {
    const startTime = Date.now();
    logger.info('═══ Iniciando ciclo de recolección de datos ═══');

    try {
      const timeRanges = getTimeRanges(); // today, last_3d, last_7d
      let totalSnapshots = 0;

      // 1. Obtener listado de campañas y ad sets (para status, budget, etc.)
      const campaigns = await this.meta.getCampaigns();
      logger.info(`Campañas encontradas: ${campaigns.length}`);

      const campaignMap = {};
      const adSetMap = {};

      for (const c of campaigns) {
        campaignMap[c.id] = c;
      }

      // Obtener ad sets de todas las campañas
      let totalAdSets = 0;
      for (const campaign of campaigns) {
        try {
          const adSets = await this.meta.getAdSets(campaign.id);
          for (const as of adSets) {
            adSetMap[as.id] = { ...as, campaign };
          }
          totalAdSets += adSets.length;
          logger.info(`  Campaña "${campaign.name}": ${adSets.length} ad sets`);
        } catch (err) {
          const errMsg = err.response?.data?.error?.message || err.message || 'Error desconocido';
          logger.warn(`  Error obteniendo ad sets de campaña ${campaign.id}: ${errMsg}`);
        }
      }

      // 1.5. Inyectar ad sets AI-managed que no aparecieron en el listado
      //       (pueden tener status DELETED, ARCHIVED, o campaña padre pausada)
      try {
        const aiCreations = await AICreation.find({
          creation_type: 'create_adset',
          managed_by_ai: true,
          meta_entity_id: { $exists: true, $ne: null }
        }).lean();

        let injected = 0;
        for (const creation of aiCreations) {
          const asId = creation.meta_entity_id;
          if (adSetMap[asId]) continue; // Ya capturado normalmente

          try {
            const info = await this.meta.get(`/${asId}`, {
              fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,campaign_id'
            });
            const campaignId = info.campaign_id;
            const campaign = campaignMap[campaignId] || { id: campaignId, name: creation.campaign_name || 'Unknown' };
            adSetMap[asId] = { ...info, campaign };
            injected++;
          } catch (err) {
            // Ad set puede estar eliminado permanentemente — ignorar
            logger.debug(`  Ad set AI ${asId} no accesible: ${err.message}`);
          }
        }
        if (injected > 0) {
          logger.info(`  ${injected} ad sets AI-managed inyectados (no estaban en listado ACTIVE/PAUSED)`);
          totalAdSets += injected;
        }
      } catch (err) {
        logger.warn(`  Error inyectando ad sets AI-managed: ${err.message}`);
      }

      // 2. Obtener insights a nivel de cuenta con level=campaign (5 llamadas)
      logger.info('Recolectando insights de campañas (level=campaign)...');
      const campaignInsights = {};

      for (const [window, range] of Object.entries(timeRanges)) {
        const rows = await this.meta.getAccountInsights('campaign', range);
        for (const row of rows) {
          const cid = row.campaign_id;
          if (!campaignInsights[cid]) campaignInsights[cid] = {};
          campaignInsights[cid][window] = parseInsightRow(row);
        }
      }

      // 3. Guardar snapshots de campañas
      for (const campaign of campaigns) {
        const metrics = {};
        for (const window of Object.keys(timeRanges)) {
          metrics[window] = campaignInsights[campaign.id]?.[window] || this._emptyMetrics();
        }
        const analysis = this._buildAnalysis(metrics);

        await MetricSnapshot.create({
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
          analysis,
          snapshot_at: new Date()
        });
        totalSnapshots++;
      }
      logger.info(`  ${campaigns.length} snapshots de campañas guardados`);

      // 4. Obtener insights a nivel de cuenta con level=adset (5 llamadas)
      logger.info('Recolectando insights de ad sets (level=adset)...');
      const adSetInsights = {};

      for (const [window, range] of Object.entries(timeRanges)) {
        const rows = await this.meta.getAccountInsights('adset', range);
        for (const row of rows) {
          const asid = row.adset_id;
          if (!adSetInsights[asid]) adSetInsights[asid] = {};
          adSetInsights[asid][window] = parseInsightRow(row);
        }
      }

      // 5. Guardar snapshots de ad sets
      let adSetSnapshots = 0;
      for (const [adSetId, info] of Object.entries(adSetMap)) {
        const adSet = info;
        const campaign = info.campaign;

        const metrics = {};
        for (const window of Object.keys(timeRanges)) {
          metrics[window] = adSetInsights[adSetId]?.[window] || this._emptyMetrics();
        }
        const analysis = this._buildAnalysis(metrics);

        await MetricSnapshot.create({
          entity_type: 'adset',
          entity_id: adSet.id,
          entity_name: adSet.name,
          parent_id: campaign.id,
          campaign_id: campaign.id,
          status: adSet.effective_status,
          daily_budget: parseBudget(adSet.daily_budget),
          lifetime_budget: parseBudget(adSet.lifetime_budget),
          budget_remaining: parseBudget(adSet.budget_remaining),
          metrics,
          analysis,
          snapshot_at: new Date()
        });
        totalSnapshots++;
        adSetSnapshots++;
      }
      logger.info(`  ${adSetSnapshots} snapshots de ad sets guardados`);

      // 6. Obtener status real de todos los ads (1 sola llamada API)
      logger.info('Recolectando status de ads...');
      const adStatusMap = {}; // { adId: 'ACTIVE' | 'PAUSED' | ... }
      try {
        for (const [adSetId] of Object.entries(adSetMap)) {
          const ads = await this.meta.getAds(adSetId, 'id,effective_status');
          for (const ad of ads) {
            adStatusMap[ad.id] = ad.effective_status || 'ACTIVE';
          }
        }
        logger.info(`  ${Object.keys(adStatusMap).length} ads con status real obtenido`);
      } catch (err) {
        logger.warn(`  Error obteniendo status de ads: ${err.message} — usando fallback`);
      }

      // 7. Obtener insights a nivel de cuenta con level=ad (5 llamadas)
      logger.info('Recolectando insights de ads/creativos (level=ad)...');
      const adInsights = {}; // { adId: { today: {...}, last_3d: {...}, ... } }

      for (const [window, range] of Object.entries(timeRanges)) {
        const rows = await this.meta.getAccountInsights('ad', range);
        for (const row of rows) {
          const adId = row.ad_id;
          if (!adId) continue;
          if (!adInsights[adId]) {
            adInsights[adId] = {
              ad_name: row.ad_name || 'Sin nombre',
              adset_id: row.adset_id,
              campaign_id: row.campaign_id
            };
          }
          adInsights[adId][window] = parseInsightRow(row);
        }
      }

      // 8. Guardar snapshots de ads
      let adSnapshots = 0;
      for (const [adId, adData] of Object.entries(adInsights)) {
        const metrics = {};
        for (const window of Object.keys(timeRanges)) {
          metrics[window] = adData[window] || this._emptyMetrics();
        }
        const analysis = this._buildAnalysis(metrics);

        await MetricSnapshot.create({
          entity_type: 'ad',
          entity_id: adId,
          entity_name: adData.ad_name,
          parent_id: adData.adset_id,
          campaign_id: adData.campaign_id,
          status: adStatusMap[adId] || 'ACTIVE',
          metrics,
          analysis,
          snapshot_at: new Date()
        });
        totalSnapshots++;
        adSnapshots++;
      }
      logger.info(`  ${adSnapshots} snapshots de ads/creativos guardados`);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`${totalSnapshots} snapshots guardados en MongoDB`);
      const apiCalls = Object.keys(timeRanges).length * 3; // campaign + adset + ad per window
      logger.info(`═══ Recolección completada en ${elapsed}s (${totalAdSets} ad sets, ${adSnapshots} ads, ~${apiCalls} API calls) ═══`);

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
      logger.error(`Error en ciclo de recolección: ${errMsg}`);
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
