const { getMetaClient } = require('../../meta/client');
const { getLatestSnapshots } = require('../../db/queries');
const logger = require('../../utils/logger');

/**
 * Creative Analyzer — obtiene y analiza el contenido real de los ads.
 * Detecta: diversidad de copy, saturacion de angulos, gaps creativos,
 * cantidad de ads por ad set, y correlaciona contenido con metricas.
 */
class CreativeAnalyzer {
  constructor() {
    this.meta = getMetaClient();
  }

  /**
   * Analisis completo: obtiene creativos + metricas y genera un reporte.
   */
  async analyze() {
    logger.info('[CREATIVE_ANALYZER] Iniciando analisis de creativos...');

    try {
      // Obtener creativos y snapshots en paralelo
      const [creativesByAdSet, snapshots] = await Promise.all([
        this.meta.getAllCreativeDetails(),
        getLatestSnapshots()
      ]);

      const adSetSnapshots = snapshots.filter(s => s.entity_type === 'adset');
      const adSnapshots = snapshots.filter(s => s.entity_type === 'ad');

      // Construir mapa de metricas por ad
      const adMetricsMap = new Map();
      for (const snap of adSnapshots) {
        adMetricsMap.set(snap.entity_id, {
          roas_7d: snap.metrics?.last_7d?.roas || 0,
          ctr_7d: snap.metrics?.last_7d?.ctr || 0,
          spend_7d: snap.metrics?.last_7d?.spend || 0,
          frequency_7d: snap.metrics?.last_7d?.frequency || 0,
          impressions_7d: snap.metrics?.last_7d?.impressions || 0
        });
      }

      // Construir mapa de metricas por ad set
      const adSetMetricsMap = new Map();
      for (const snap of adSetSnapshots) {
        adSetMetricsMap.set(snap.entity_id, {
          name: snap.entity_name,
          status: snap.status,
          roas_7d: snap.metrics?.last_7d?.roas || 0,
          cpa_7d: snap.metrics?.last_7d?.cpa || 0,
          ctr_7d: snap.metrics?.last_7d?.ctr || 0,
          spend_7d: snap.metrics?.last_7d?.spend || 0,
          frequency_7d: snap.metrics?.last_7d?.frequency || 0,
          daily_budget: snap.daily_budget || 0
        });
      }

      // Analizar cada ad set
      const adSetAnalyses = [];

      for (const [adSetId, adSetData] of Object.entries(creativesByAdSet)) {
        const adSetMetrics = adSetMetricsMap.get(adSetId) || {};
        const creatives = adSetData.creatives || [];
        const activeCreatives = creatives.filter(c => c.status === 'ACTIVE');

        // Enriquecer creativos con metricas
        const enrichedCreatives = creatives.map(c => {
          const metrics = adMetricsMap.get(c.ad_id) || {};
          return { ...c, metrics };
        });

        // Analisis de diversidad de copy
        const headlines = activeCreatives.map(c => c.title).filter(Boolean);
        const bodies = activeCreatives.map(c => c.body).filter(Boolean);
        const ctas = activeCreatives.map(c => c.call_to_action).filter(Boolean);

        // Detectar angulos de messaging
        const messagingAngles = this._detectMessagingAngles(bodies);

        // Detectar problemas
        const issues = [];

        // Pocos ads activos
        if (activeCreatives.length < 3 && adSetMetrics.status === 'ACTIVE') {
          issues.push({
            type: 'low_creative_count',
            severity: activeCreatives.length <= 1 ? 'critical' : 'high',
            message: `Solo ${activeCreatives.length} ad(s) activo(s). Meta necesita 3-5+ variantes para optimizar delivery.`
          });
        }

        // Headlines repetitivos
        const uniqueHeadlines = new Set(headlines.map(h => h.toLowerCase().trim()));
        if (headlines.length > 1 && uniqueHeadlines.size === 1) {
          issues.push({
            type: 'duplicate_headlines',
            severity: 'medium',
            message: 'Todos los ads usan el mismo headline. Falta variedad de titulares.'
          });
        }

        // Pocos angulos de messaging
        if (messagingAngles.unique_angles <= 1 && activeCreatives.length >= 2) {
          issues.push({
            type: 'low_angle_diversity',
            severity: 'high',
            message: `Solo ${messagingAngles.unique_angles} angulo de messaging detectado. Se necesitan multiples angulos (beneficios, social proof, urgencia, etc.)`
          });
        }

        // CTAs identicos
        const uniqueCtas = new Set(ctas);
        if (ctas.length > 1 && uniqueCtas.size === 1) {
          issues.push({
            type: 'same_cta',
            severity: 'low',
            message: `Todos los ads usan el mismo CTA (${ctas[0]}). Considerar probar SHOP_NOW vs LEARN_MORE vs ORDER_NOW.`
          });
        }

        // Mejor y peor creativo
        const sortedByRoas = enrichedCreatives
          .filter(c => c.metrics.spend_7d > 5)
          .sort((a, b) => (b.metrics.roas_7d || 0) - (a.metrics.roas_7d || 0));

        const bestCreative = sortedByRoas[0] || null;
        const worstCreative = sortedByRoas[sortedByRoas.length - 1] || null;

        adSetAnalyses.push({
          adset_id: adSetId,
          adset_name: adSetData.adset_name,
          campaign_name: adSetData.campaign_name,
          campaign_id: adSetData.campaign_id,
          status: adSetData.status,
          adset_metrics: adSetMetrics,
          total_creatives: creatives.length,
          active_creatives: activeCreatives.length,
          creatives: enrichedCreatives,
          messaging_angles: messagingAngles,
          unique_headlines: uniqueHeadlines.size,
          unique_ctas: uniqueCtas.size,
          best_creative: bestCreative,
          worst_creative: worstCreative,
          issues
        });
      }

      // Analisis a nivel de cuenta
      const accountIssues = this._detectAccountLevelIssues(adSetAnalyses);

      const result = {
        ad_sets: adSetAnalyses,
        account_issues: accountIssues,
        total_ad_sets_analyzed: adSetAnalyses.length,
        total_creatives: adSetAnalyses.reduce((sum, a) => sum + a.total_creatives, 0),
        total_active_creatives: adSetAnalyses.reduce((sum, a) => sum + a.active_creatives, 0),
        total_issues: adSetAnalyses.reduce((sum, a) => sum + a.issues.length, 0) + accountIssues.length,
        analyzed_at: new Date().toISOString()
      };

      logger.info(`[CREATIVE_ANALYZER] Completado: ${result.total_ad_sets_analyzed} ad sets, ${result.total_creatives} creativos, ${result.total_issues} problemas detectados`);
      return result;

    } catch (error) {
      logger.error(`[CREATIVE_ANALYZER] Error: ${error.message}`);
      return { ad_sets: [], account_issues: [], total_issues: 0, error: error.message };
    }
  }

  /**
   * Detecta angulos de messaging en los copies de ads.
   */
  _detectMessagingAngles(bodies) {
    if (!bodies.length) return { angles: [], unique_angles: 0, missing_angles: [] };

    const anglePatterns = [
      { name: 'pricing_value', patterns: ['price', 'discount', 'sale', 'off', 'deal', 'save', 'cheap', 'affordable', '$', 'free shipping', 'descuento', 'precio', 'oferta'] },
      { name: 'social_proof', patterns: ['review', 'rated', 'star', 'customer', 'loved', 'favorite', 'best seller', 'popular', '#1', 'people love', 'thousands'] },
      { name: 'quality_craft', patterns: ['handmade', 'artisan', 'craft', 'premium', 'quality', 'fresh', 'natural', 'organic', 'small batch', 'homemade'] },
      { name: 'urgency_scarcity', patterns: ['limited', 'hurry', 'last chance', 'selling fast', 'while supplies', 'don\'t miss', 'ends', 'today only', 'now'] },
      { name: 'benefit_focused', patterns: ['perfect for', 'great for', 'enjoy', 'taste', 'flavor', 'delicious', 'crunch', 'experience'] },
      { name: 'story_brand', patterns: ['family', 'tradition', 'recipe', 'story', 'journey', 'passion', 'love', 'since', 'years'] },
      { name: 'gift_occasion', patterns: ['gift', 'holiday', 'birthday', 'party', 'occasion', 'celebration', 'present', 'surprise'] }
    ];

    const detectedAngles = new Set();
    const bodyLower = bodies.map(b => b.toLowerCase());

    for (const angle of anglePatterns) {
      for (const body of bodyLower) {
        if (angle.patterns.some(p => body.includes(p))) {
          detectedAngles.add(angle.name);
          break;
        }
      }
    }

    return {
      angles: Array.from(detectedAngles),
      unique_angles: detectedAngles.size,
      missing_angles: anglePatterns
        .filter(a => !detectedAngles.has(a.name))
        .map(a => a.name)
    };
  }

  /**
   * Detecta problemas a nivel de toda la cuenta.
   */
  _detectAccountLevelIssues(adSetAnalyses) {
    const issues = [];
    const activeAdSets = adSetAnalyses.filter(a => a.status === 'ACTIVE');

    // Ad sets sin suficientes creativos
    const lowCreativeAdSets = activeAdSets.filter(a => a.active_creatives < 3);
    if (lowCreativeAdSets.length > 0) {
      issues.push({
        type: 'account_low_creative_diversity',
        severity: lowCreativeAdSets.length >= 3 ? 'critical' : 'high',
        message: `${lowCreativeAdSets.length} ad set(s) activo(s) tienen menos de 3 creativos. Meta necesita variedad para optimizar.`,
        affected: lowCreativeAdSets.map(a => ({ adset_id: a.adset_id, adset_name: a.adset_name, count: a.active_creatives }))
      });
    }

    // Angulos de messaging limitados a nivel de cuenta
    const allAngles = new Set();
    for (const analysis of activeAdSets) {
      for (const angle of (analysis.messaging_angles.angles || [])) {
        allAngles.add(angle);
      }
    }
    if (allAngles.size <= 2 && activeAdSets.length >= 3) {
      issues.push({
        type: 'account_angle_saturation',
        severity: 'high',
        message: `Toda la cuenta usa solo ${allAngles.size} angulo(s) de messaging (${Array.from(allAngles).join(', ')}). Falta diversidad de mensajes.`
      });
    }

    // Headlines repetidos entre ad sets
    const allHeadlines = [];
    for (const analysis of activeAdSets) {
      for (const c of analysis.creatives.filter(c => c.status === 'ACTIVE')) {
        if (c.title) allHeadlines.push({ headline: c.title.toLowerCase().trim(), adset: analysis.adset_name });
      }
    }
    const headlineCounts = {};
    for (const h of allHeadlines) {
      headlineCounts[h.headline] = (headlineCounts[h.headline] || 0) + 1;
    }
    const duplicatedHeadlines = Object.entries(headlineCounts).filter(([, count]) => count >= 3);
    if (duplicatedHeadlines.length > 0) {
      issues.push({
        type: 'cross_adset_duplicate_headlines',
        severity: 'medium',
        message: `${duplicatedHeadlines.length} headline(s) repetido(s) en 3+ ad sets. Esto reduce la diversidad del algoritmo de Meta.`
      });
    }

    return issues;
  }
}

module.exports = CreativeAnalyzer;
