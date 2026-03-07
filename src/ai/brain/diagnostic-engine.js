const kpiTargets = require('../../../config/kpi-targets');
const deepResearchPriors = require('../../../config/deep-research-priors');
const logger = require('../../utils/logger');

/**
 * DiagnosticEngine — Motor de diagnóstico pre-IA.
 *
 * Computa señales de diagnóstico ANTES de enviar a Claude,
 * para que el LLM reciba contexto estructurado en vez de métricas crudas.
 *
 * Diagnósticos por entidad:
 * 1. Funnel Health     — tasas de conversión entre pasos del funnel
 * 2. Creative Fatigue  — velocidad de caída de CTR, score de fatiga
 * 3. Audience Saturation — frecuencia + CTR declining + reach stagnation
 * 4. Overall Diagnosis — etiqueta de diagnóstico principal + recomendación
 */
class DiagnosticEngine {

  constructor() {
    this.benchmarks = deepResearchPriors.benchmarks?.food_ecommerce_2025 || {};
    this.seasonalMultipliers = deepResearchPriors.benchmarks?.seasonal_cpm_multipliers || {};
    this.funnelThresholds = deepResearchPriors.funnel_diagnosis?.stages || {};
    this.creativeLifespan = deepResearchPriors.creative_strategy?.fatigue_detection?.creative_lifespan || {};
    this.kpi = kpiTargets;
  }

  /**
   * Ejecuta diagnóstico completo para todos los ad sets.
   * @param {Array} adsetSnapshots - Snapshots actuales de ad sets
   * @param {Array} adSnapshots - Snapshots actuales de ads individuales
   * @param {Object} memoryMap - BrainMemory map por entity_id
   * @param {Object} accountOverview - Overview de la cuenta
   * @returns {Object} diagnostics keyed by entity_id
   */
  diagnoseAll(adsetSnapshots, adSnapshots = [], memoryMap = {}, accountOverview = {}, featureMap = {}) {
    const diagnostics = {};
    const adsByAdSet = this._groupAdsByAdSet(adSnapshots);

    for (const snap of adsetSnapshots) {
      if (snap.status !== 'ACTIVE') continue;

      const m7d = snap.metrics?.last_7d || {};
      const m3d = snap.metrics?.last_3d || {};
      const m14d = snap.metrics?.last_14d || {};
      const m30d = snap.metrics?.last_30d || {};
      const mToday = snap.metrics?.today || {};
      const memory = memoryMap[snap.entity_id];
      const ads = adsByAdSet[snap.entity_id] || [];

      // Skip entities with minimal spend
      if ((m7d.spend || 0) < 5) continue;

      const funnel = this._diagnoseFunnel(m7d, m14d, m30d);
      const fatigue = this._diagnoseCreativeFatigue(m7d, m14d, m30d, memory, ads);
      const saturation = this._diagnoseAudienceSaturation(m7d, m14d, m30d, memory);
      const efficiency = this._diagnoseEfficiency(m7d, m14d, m30d, mToday, accountOverview);
      const benchmarkComparison = this._diagnoseBenchmarks(m7d);
      const funnelGrades = this._gradeFunnelThresholds(funnel);
      const creativeLifespan = this._diagnoseCreativeLifespan(ads);
      const overall = this._computeOverallDiagnosis(funnel, fatigue, saturation, efficiency, m7d, snap);

      // Attach statistical confidence + attribution if available from feature map
      const featureData = featureMap[snap.entity_id];
      const statConf = featureData?.statistical_confidence || null;
      const attrData = featureData?.attribution || null;

      diagnostics[snap.entity_id] = {
        entity_id: snap.entity_id,
        entity_name: snap.entity_name,
        funnel,
        funnel_grades: funnelGrades,
        fatigue,
        saturation,
        efficiency,
        benchmark_comparison: benchmarkComparison,
        creative_lifespan: creativeLifespan,
        overall,
        active_ads: ads.filter(a => a.status === 'ACTIVE').length,
        total_ads: ads.length,
        statistical_confidence: statConf,
        attribution: attrData,
        attribution_maturity: attrData?.attribution_maturity?.label || null
      };
    }

    return diagnostics;
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. FUNNEL DIAGNOSIS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Analiza tasas de conversión entre pasos del funnel.
   * Clicks → ATC → IC → Purchase
   */
  _diagnoseFunnel(m7d, m14d, m30d) {
    const clicks7d = m7d.clicks || 0;
    const atc7d = m7d.add_to_cart || 0;
    const ic7d = m7d.initiate_checkout || 0;
    const purchases7d = m7d.purchases || 0;

    // Conversion rates between steps
    const clickToAtc = clicks7d > 0 ? (atc7d / clicks7d) * 100 : 0;
    const atcToIc = atc7d > 0 ? (ic7d / atc7d) * 100 : 0;
    const icToPurchase = ic7d > 0 ? (purchases7d / ic7d) * 100 : 0;
    const clickToPurchase = clicks7d > 0 ? (purchases7d / clicks7d) * 100 : 0;

    // Same for 30d (baseline)
    const clicks30d = m30d.clicks || 0;
    const atc30d = m30d.add_to_cart || 0;
    const ic30d = m30d.initiate_checkout || 0;
    const purchases30d = m30d.purchases || 0;
    const clickToAtc30d = clicks30d > 0 ? (atc30d / clicks30d) * 100 : 0;
    const atcToIc30d = atc30d > 0 ? (ic30d / atc30d) * 100 : 0;
    const icToPurchase30d = ic30d > 0 ? (purchases30d / ic30d) * 100 : 0;

    // Identify funnel leaks
    const leaks = [];
    let primaryLeak = null;
    let funnelHealth = 'healthy';

    // High CTR but 0 ATC → landing page issue
    if ((m7d.ctr || 0) > 0.8 && clicks7d > 50 && atc7d === 0) {
      leaks.push({
        stage: 'click_to_atc',
        severity: 'critical',
        label: 'LANDING_PAGE_DISCONNECT',
        detail: `CTR ${(m7d.ctr).toFixed(2)}% con ${clicks7d} clicks pero 0 add-to-cart. La landing page no convierte — posible mismatch entre ad y página, UX móvil pobre, o precio no coincide con expectativa del ad.`
      });
      primaryLeak = 'LANDING_PAGE_DISCONNECT';
      funnelHealth = 'critical';
    }
    // Good clicks, some ATC, but 0 IC → checkout friction
    else if (atc7d > 3 && ic7d === 0) {
      leaks.push({
        stage: 'atc_to_ic',
        severity: 'high',
        label: 'CHECKOUT_FRICTION',
        detail: `${atc7d} add-to-cart pero 0 initiate checkout. Fricción en el checkout: shipping cost surprise, forms largos, falta de trust signals, o problemas de UX.`
      });
      primaryLeak = 'CHECKOUT_FRICTION';
      funnelHealth = 'critical';
    }
    // IC exists but no purchases → payment/final step issue
    else if (ic7d > 3 && purchases7d === 0) {
      leaks.push({
        stage: 'ic_to_purchase',
        severity: 'high',
        label: 'PAYMENT_DROP',
        detail: `${ic7d} initiate checkout pero 0 compras. Problema en paso final: errores de pago, costos sorpresa en último paso, o tracking de pixel roto.`
      });
      primaryLeak = 'PAYMENT_DROP';
      funnelHealth = 'critical';
    }

    // Funnel degradation vs 30d baseline
    if (!primaryLeak && clickToAtc30d > 0 && clickToAtc > 0) {
      const atcDropPct = ((clickToAtc - clickToAtc30d) / clickToAtc30d) * 100;
      if (atcDropPct < -30) {
        leaks.push({
          stage: 'click_to_atc',
          severity: 'medium',
          label: 'ATC_RATE_DECLINING',
          detail: `Click→ATC rate cayó ${Math.abs(atcDropPct).toFixed(0)}% vs 30d (${clickToAtc.toFixed(1)}% vs ${clickToAtc30d.toFixed(1)}%). Posible fatiga de landing page o cambio en calidad de tráfico.`
        });
        if (funnelHealth === 'healthy') funnelHealth = 'declining';
      }
    }

    if (!primaryLeak && atcToIc30d > 0 && atcToIc > 0) {
      const icDropPct = ((atcToIc - atcToIc30d) / atcToIc30d) * 100;
      if (icDropPct < -30) {
        leaks.push({
          stage: 'atc_to_ic',
          severity: 'medium',
          label: 'IC_RATE_DECLINING',
          detail: `ATC→IC rate cayó ${Math.abs(icDropPct).toFixed(0)}% vs 30d (${atcToIc.toFixed(1)}% vs ${atcToIc30d.toFixed(1)}%). Checkout flow puede tener nuevos problemas.`
        });
        if (funnelHealth === 'healthy') funnelHealth = 'declining';
      }
    }

    // Overall funnel is OK but conversion rate is below benchmark
    const benchCvr = this.benchmarks.conversion_rate?.median || 3.0;
    if (funnelHealth === 'healthy' && clickToPurchase > 0 && clickToPurchase < benchCvr * 0.5) {
      funnelHealth = 'below_benchmark';
    }

    return {
      health: funnelHealth,
      rates: {
        click_to_atc_7d: +clickToAtc.toFixed(2),
        atc_to_ic_7d: +atcToIc.toFixed(2),
        ic_to_purchase_7d: +icToPurchase.toFixed(2),
        click_to_purchase_7d: +clickToPurchase.toFixed(2),
        click_to_atc_30d: +clickToAtc30d.toFixed(2),
        atc_to_ic_30d: +atcToIc30d.toFixed(2),
        ic_to_purchase_30d: +icToPurchase30d.toFixed(2)
      },
      leaks,
      primary_leak: primaryLeak,
      has_data: clicks7d > 20 // Minimum data for meaningful funnel analysis
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. CREATIVE FATIGUE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detecta fatiga creativa usando el framework de 5 señales:
   * CTR decline → CPM increase → Frequency acceleration → CPA creep → Negative feedback
   */
  _diagnoseCreativeFatigue(m7d, m14d, m30d, memory, ads) {
    let fatigueScore = 0; // 0-100
    const signals = [];

    const ctr7d = m7d.ctr || 0;
    const ctr14d = m14d.ctr || 0;
    const ctr30d = m30d.ctr || 0;
    const freq7d = m7d.frequency || 0;
    const freq14d = m14d.frequency || 0;
    const cpm7d = m7d.cpm || 0;
    const cpm14d = m14d.cpm || 0;
    const cpm30d = m30d.cpm || 0;
    const cpa7d = m7d.cpa || 0;
    const cpa14d = m14d.cpa || 0;

    // Signal 1: CTR decline (20%+ from peak/30d)
    if (ctr30d > 0 && ctr7d > 0) {
      const ctrDeclinePct = ((ctr7d - ctr30d) / ctr30d) * 100;
      if (ctrDeclinePct < -20) {
        const severity = ctrDeclinePct < -40 ? 'high' : 'medium';
        fatigueScore += ctrDeclinePct < -40 ? 30 : 20;
        signals.push({
          signal: 'CTR_DECLINE',
          severity,
          detail: `CTR cayó ${Math.abs(ctrDeclinePct).toFixed(0)}% vs 30d (${ctr7d.toFixed(2)}% vs ${ctr30d.toFixed(2)}%)`,
          value: +ctrDeclinePct.toFixed(1)
        });
      }
    }

    // Signal 2: CPM increase (30%+ over 2 weeks)
    if (cpm14d > 0 && cpm7d > 0) {
      const cpmIncreasePct = ((cpm7d - cpm14d) / cpm14d) * 100;
      if (cpmIncreasePct > 30) {
        fatigueScore += cpmIncreasePct > 50 ? 20 : 15;
        signals.push({
          signal: 'CPM_SPIKE',
          severity: cpmIncreasePct > 50 ? 'high' : 'medium',
          detail: `CPM subió ${cpmIncreasePct.toFixed(0)}% vs 14d ($${cpm7d.toFixed(2)} vs $${cpm14d.toFixed(2)})`,
          value: +cpmIncreasePct.toFixed(1)
        });
      }
    }

    // Signal 3: Frequency acceleration
    const freqThresholdWarning = this.kpi.frequency_warning || 2.5;
    const freqThresholdCritical = this.kpi.frequency_critical || 4.0;

    if (freq7d >= freqThresholdCritical) {
      fatigueScore += 25;
      signals.push({
        signal: 'FREQUENCY_CRITICAL',
        severity: 'critical',
        detail: `Frequency ${freq7d.toFixed(1)} — audiencia sobre-saturada (crítico: ${freqThresholdCritical})`,
        value: freq7d
      });
    } else if (freq7d >= freqThresholdWarning) {
      fatigueScore += 15;
      signals.push({
        signal: 'FREQUENCY_WARNING',
        severity: 'medium',
        detail: `Frequency ${freq7d.toFixed(1)} — entrando en zona de fatiga (warning: ${freqThresholdWarning})`,
        value: freq7d
      });
    }

    // Frequency accelerating (growing faster than normal)
    if (freq14d > 0 && freq7d > freq14d * 1.2) {
      fatigueScore += 10;
      signals.push({
        signal: 'FREQUENCY_ACCELERATING',
        severity: 'medium',
        detail: `Frequency acelerándose: 7d=${freq7d.toFixed(1)} vs 14d avg=${freq14d.toFixed(1)} (+${(((freq7d / freq14d) - 1) * 100).toFixed(0)}%)`,
        value: +(freq7d / freq14d).toFixed(2)
      });
    }

    // Signal 4: CPA creep
    if (cpa14d > 0 && cpa7d > 0) {
      const cpaCreepPct = ((cpa7d - cpa14d) / cpa14d) * 100;
      if (cpaCreepPct > 25) {
        fatigueScore += cpaCreepPct > 50 ? 20 : 10;
        signals.push({
          signal: 'CPA_CREEP',
          severity: cpaCreepPct > 50 ? 'high' : 'medium',
          detail: `CPA subió ${cpaCreepPct.toFixed(0)}% vs 14d ($${cpa7d.toFixed(2)} vs $${cpa14d.toFixed(2)})`,
          value: +cpaCreepPct.toFixed(1)
        });
      }
    }

    // Signal 5: Low creative diversity
    const activeAds = ads.filter(a => a.status === 'ACTIVE');
    if (activeAds.length < 3) {
      fatigueScore += 10;
      signals.push({
        signal: 'LOW_CREATIVE_DIVERSITY',
        severity: 'medium',
        detail: `Solo ${activeAds.length} ad${activeAds.length === 1 ? '' : 's'} activo${activeAds.length === 1 ? '' : 's'} — necesita mínimo 3-5 para combatir fatiga`,
        value: activeAds.length
      });
    }

    // ── Per-ad fatigue breakdown ──
    // Classify each ad individually: learning / healthy / fatigued / drag
    const now = new Date();
    const adBreakdown = activeAds.map(ad => {
      const adM7 = ad.metrics?.last_7d || {};
      const adM3 = ad.metrics?.last_3d || {};
      const createdTime = ad.meta_created_time || ad.created_time || ad.created_at;
      const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : Infinity;
      const ageDays = Math.floor(ageHours / 24);
      const adFreq = adM7.frequency || 0;
      const adRoas = adM7.roas || 0;
      const adCtr = adM7.ctr || 0;
      const adSpend = adM7.spend || 0;

      // Determine per-ad status
      let adStatus, adAction;
      if (ageHours < 72) {
        adStatus = 'learning';
        adAction = 'protect'; // Never touch learning ads
      } else if (adFreq >= 4.0 || ageDays >= 28) {
        adStatus = 'fatigued';
        adAction = 'pause_candidate';
      } else if (adRoas < (m7d.roas || 0) * 0.4 && adSpend > 5) {
        adStatus = 'drag'; // Dragging ad set performance down
        adAction = 'pause_candidate';
      } else if (ageDays >= 14 || adFreq >= 2.5) {
        adStatus = 'aging';
        adAction = 'monitor';
      } else {
        adStatus = 'healthy';
        adAction = 'keep';
      }

      return {
        ad_id: ad.entity_id || ad.id,
        ad_name: ad.entity_name || ad.name || 'Unknown',
        age_days: ageDays,
        age_hours: Math.round(ageHours),
        status: adStatus,
        action: adAction,
        roas_7d: adRoas,
        ctr_7d: adCtr,
        frequency_7d: adFreq,
        spend_7d: adSpend
      };
    });

    const learningAds = adBreakdown.filter(a => a.status === 'learning');
    const fatiguedAds = adBreakdown.filter(a => a.status === 'fatigued' || a.status === 'drag');
    const healthyAds = adBreakdown.filter(a => a.status === 'healthy' || a.status === 'aging');

    // Cap score
    fatigueScore = Math.min(100, fatigueScore);

    // Determine fatigue level
    let level;
    if (fatigueScore >= 60) level = 'severe';
    else if (fatigueScore >= 40) level = 'moderate';
    else if (fatigueScore >= 20) level = 'early';
    else level = 'healthy';

    return {
      score: fatigueScore,
      level,
      signals,
      needs_creative_refresh: fatigueScore >= 30,
      needs_immediate_action: fatigueScore >= 60,
      active_ads_count: activeAds.length,
      ad_breakdown: adBreakdown,
      learning_count: learningAds.length,
      fatigued_count: fatiguedAds.length,
      healthy_count: healthyAds.length
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. AUDIENCE SATURATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detecta saturación de audiencia combinando:
   * Frequency trend + CTR trend + Reach stagnation + CPM pressure
   */
  _diagnoseAudienceSaturation(m7d, m14d, m30d, memory) {
    let saturationScore = 0;
    const signals = [];

    const freq7d = m7d.frequency || 0;
    const reach7d = m7d.reach || 0;
    const reach14d = m14d.reach || 0;
    const reach30d = m30d.reach || 0;
    const ctr7d = m7d.ctr || 0;
    const ctr14d = m14d.ctr || 0;
    const impressions7d = m7d.impressions || 0;
    const impressions14d = m14d.impressions || 0;

    // High frequency + declining CTR = classic saturation
    if (freq7d > 2.5 && ctr14d > 0 && ctr7d < ctr14d * 0.85) {
      saturationScore += 30;
      signals.push({
        signal: 'FREQ_CTR_DIVERGENCE',
        severity: 'high',
        detail: `Frequency ${freq7d.toFixed(1)} con CTR cayendo (${ctr7d.toFixed(2)}% vs ${ctr14d.toFixed(2)}% 14d). La audiencia está viendo el ad repetidamente sin hacer clic.`
      });
    }

    // Reach stagnation — impressions growing but reach flat
    if (reach14d > 0 && reach7d > 0 && impressions7d > 100) {
      // Normalize: 7d reach should be ~50% of 14d reach if growing
      const reachGrowthRatio = reach7d / (reach14d * 0.5);
      if (reachGrowthRatio < 0.7) {
        saturationScore += 20;
        signals.push({
          signal: 'REACH_STAGNATION',
          severity: 'medium',
          detail: `Reach 7d (${reach7d.toLocaleString()}) creciendo lento vs 14d (${reach14d.toLocaleString()}). Meta está recycling la misma audiencia.`
        });
      }
    }

    // Very high frequency with spend — audience is small for the budget
    if (freq7d > 3.5 && (m7d.spend || 0) > 50) {
      saturationScore += 25;
      signals.push({
        signal: 'AUDIENCE_EXHAUSTION',
        severity: 'critical',
        detail: `Frequency ${freq7d.toFixed(1)} con spend $${(m7d.spend).toFixed(0)} en 7d. La audiencia es demasiado pequeña para este budget — cada persona ve el ad ${freq7d.toFixed(0)}+ veces.`
      });
    }

    // Diminishing returns: spend increasing but conversions flat
    if ((m14d.purchases || 0) > 0 && (m7d.purchases || 0) > 0 && (m14d.spend || 0) > 0 && (m7d.spend || 0) > 0) {
      const efficiencyTrend7d = (m7d.purchases / m7d.spend) * 100;
      const efficiencyTrend14d = (m14d.purchases / m14d.spend) * 100;
      if (efficiencyTrend14d > 0) {
        const efficiencyDropPct = ((efficiencyTrend7d - efficiencyTrend14d) / efficiencyTrend14d) * 100;
        if (efficiencyDropPct < -25) {
          saturationScore += 15;
          signals.push({
            signal: 'DIMINISHING_RETURNS',
            severity: 'medium',
            detail: `Eficiencia (purchases/spend) cayó ${Math.abs(efficiencyDropPct).toFixed(0)}% vs 14d. Más gasto pero proporcionalmente menos conversiones.`
          });
        }
      }
    }

    // Memory trend — consecutive decline
    if (memory?.trends?.consecutive_decline_days >= 3) {
      saturationScore += 10;
      signals.push({
        signal: 'SUSTAINED_DECLINE',
        severity: 'medium',
        detail: `ROAS declinando por ${memory.trends.consecutive_decline_days} ciclos consecutivos.`
      });
    }

    saturationScore = Math.min(100, saturationScore);

    let level;
    if (saturationScore >= 60) level = 'saturated';
    else if (saturationScore >= 35) level = 'approaching';
    else if (saturationScore >= 15) level = 'early_signs';
    else level = 'healthy';

    return {
      score: saturationScore,
      level,
      signals,
      needs_audience_expansion: saturationScore >= 40,
      needs_budget_reduction: saturationScore >= 60
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. EFFICIENCY DIAGNOSIS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Diagnóstico de eficiencia comparando con KPIs y benchmarks.
   */
  _diagnoseEfficiency(m7d, m14d, m30d, mToday, accountOverview) {
    const roas7d = m7d.roas || 0;
    const roas14d = m14d.roas || 0;
    const roas30d = m30d.roas || 0;
    const cpa7d = m7d.cpa || 0;
    const ctr7d = m7d.ctr || 0;
    const acctRoas7d = accountOverview.roas_7d || 0;

    const issues = [];

    // ROAS vs targets
    let roasStatus;
    if (roas7d >= this.kpi.roas_excellent) roasStatus = 'excellent';
    else if (roas7d >= this.kpi.roas_target) roasStatus = 'on_target';
    else if (roas7d >= this.kpi.roas_minimum) roasStatus = 'below_target';
    else if (roas7d > 0) roasStatus = 'critical';
    else roasStatus = 'no_data';

    // ROAS trend
    let roasTrend = 'stable';
    if (roas14d > 0 && roas7d > 0) {
      const trendPct = ((roas7d - roas14d) / roas14d) * 100;
      if (trendPct > 10) roasTrend = 'improving';
      else if (trendPct < -10) roasTrend = 'declining';
    }

    // CPA vs target
    if (cpa7d > this.kpi.cpa_maximum) {
      issues.push({
        type: 'CPA_ABOVE_MAX',
        detail: `CPA $${cpa7d.toFixed(2)} está por encima del máximo ($${this.kpi.cpa_maximum})`
      });
    } else if (cpa7d > this.kpi.cpa_target && cpa7d > 0) {
      issues.push({
        type: 'CPA_ABOVE_TARGET',
        detail: `CPA $${cpa7d.toFixed(2)} está sobre el target ($${this.kpi.cpa_target}) pero bajo el máximo`
      });
    }

    // CTR vs benchmark
    const ctrBenchmark = this.benchmarks.ctr_range?.median || 1.5;
    if (ctr7d > 0 && ctr7d < this.kpi.ctr_minimum) {
      issues.push({
        type: 'CTR_BELOW_MINIMUM',
        detail: `CTR ${ctr7d.toFixed(2)}% por debajo del mínimo (${this.kpi.ctr_minimum}%) — probable problema creativo`
      });
    }

    // ROAS vs account average (relative performance)
    let relativePerformance = 'average';
    if (acctRoas7d > 0 && roas7d > 0) {
      const relRatio = roas7d / acctRoas7d;
      if (relRatio > 1.5) relativePerformance = 'top_performer';
      else if (relRatio > 1.1) relativePerformance = 'above_average';
      else if (relRatio < 0.5) relativePerformance = 'bottom_performer';
      else if (relRatio < 0.75) relativePerformance = 'below_average';
    }

    // AOV analysis
    const aov7d = (m7d.purchases || 0) > 0 ? (m7d.purchase_value || 0) / m7d.purchases : 0;
    const aov30d = (m30d.purchases || 0) > 0 ? (m30d.purchase_value || 0) / m30d.purchases : 0;
    let aovTrend = 'stable';
    if (aov30d > 0 && aov7d > 0) {
      const aovChange = ((aov7d - aov30d) / aov30d) * 100;
      if (aovChange > 15) aovTrend = 'increasing';
      else if (aovChange < -15) aovTrend = 'decreasing';
    }

    return {
      roas_status: roasStatus,
      roas_trend: roasTrend,
      relative_performance: relativePerformance,
      aov_7d: +aov7d.toFixed(2),
      aov_trend: aovTrend,
      issues
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. OVERALL DIAGNOSIS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Computa etiqueta de diagnóstico principal con acción sugerida.
   */
  _computeOverallDiagnosis(funnel, fatigue, saturation, efficiency, m7d, snap) {
    const labels = [];
    let primaryAction = 'monitor';
    let urgency = 'low';

    // --- Critical funnel issues take priority ---
    if (funnel.primary_leak) {
      labels.push(funnel.primary_leak);
      urgency = 'high';
      // Funnel issues are NOT solved by pausing — they need landing page / funnel fixes
      primaryAction = 'investigate_funnel';
    }

    // --- Creative fatigue ---
    if (fatigue.level === 'severe') {
      labels.push('CREATIVE_FATIGUE_SEVERE');
      primaryAction = fatigue.active_ads_count < 3 ? 'add_creatives' : 'refresh_all_creatives';
      urgency = 'high';
    } else if (fatigue.level === 'moderate') {
      labels.push('CREATIVE_FATIGUE_MODERATE');
      if (primaryAction === 'monitor') primaryAction = 'add_creatives';
      if (urgency === 'low') urgency = 'medium';
    }

    // --- Audience saturation ---
    if (saturation.level === 'saturated') {
      labels.push('AUDIENCE_SATURATED');
      if (primaryAction === 'monitor') primaryAction = 'expand_audience_or_reduce_budget';
      urgency = 'high';
    } else if (saturation.level === 'approaching') {
      labels.push('AUDIENCE_APPROACHING_SATURATION');
      if (primaryAction === 'monitor') primaryAction = 'prepare_expansion';
      if (urgency === 'low') urgency = 'medium';
    }

    // --- Efficiency ---
    if (efficiency.roas_status === 'critical') {
      labels.push('ROAS_CRITICAL');
      // But DON'T auto-recommend pause — check why
      if (primaryAction === 'monitor') {
        if (funnel.primary_leak) primaryAction = 'investigate_funnel';
        else if (fatigue.score > 30) primaryAction = 'refresh_creatives_first';
        else if (saturation.score > 30) primaryAction = 'expand_audience_or_reduce_budget';
        else primaryAction = 'scale_down_or_investigate';
      }
      if (urgency === 'low') urgency = 'high';
    } else if (efficiency.roas_status === 'excellent' && efficiency.roas_trend !== 'declining') {
      labels.push('TOP_PERFORMER');
      if (saturation.level === 'healthy' && fatigue.level === 'healthy') {
        primaryAction = 'scale_candidate';
        urgency = 'medium';
      }
    }

    // ROAS declining but not critical — early warning
    if (efficiency.roas_trend === 'declining' && efficiency.roas_status !== 'critical') {
      labels.push('ROAS_DECLINING');
      if (primaryAction === 'monitor') primaryAction = 'watch_closely';
      if (urgency === 'low') urgency = 'medium';
    }

    // If no issues found
    if (labels.length === 0) {
      labels.push('HEALTHY');
      primaryAction = 'maintain';
    }

    return {
      labels,
      primary_label: labels[0],
      primary_action: primaryAction,
      urgency,
      summary: this._buildDiagnosisSummary(labels, funnel, fatigue, saturation, efficiency)
    };
  }

  /**
   * Generates a human-readable summary for the diagnosis.
   */
  _buildDiagnosisSummary(labels, funnel, fatigue, saturation, efficiency) {
    const parts = [];

    if (labels.includes('LANDING_PAGE_DISCONNECT')) {
      parts.push('El ad genera clicks pero la landing page no convierte — el problema NO es el ad, es la página de destino.');
    }
    if (labels.includes('CHECKOUT_FRICTION')) {
      parts.push('Los usuarios agregan al carrito pero abandonan en el checkout — fricción en el proceso de compra.');
    }
    if (labels.includes('PAYMENT_DROP')) {
      parts.push('Los usuarios llegan al checkout pero no completan la compra — posible problema de pago o costos sorpresa.');
    }
    if (labels.includes('CREATIVE_FATIGUE_SEVERE')) {
      parts.push(`Fatiga creativa severa (score: ${fatigue.score}/100). La audiencia ya no responde a los creativos actuales.`);
    }
    if (labels.includes('CREATIVE_FATIGUE_MODERATE')) {
      parts.push(`Fatiga creativa moderada (score: ${fatigue.score}/100). Se acerca el punto de renovar creativos.`);
    }
    if (labels.includes('AUDIENCE_SATURATED')) {
      parts.push(`Audiencia saturada (score: ${saturation.score}/100). Meta está reciclando las mismas personas.`);
    }
    if (labels.includes('AUDIENCE_APPROACHING_SATURATION')) {
      parts.push(`Audiencia acercándose a saturación (score: ${saturation.score}/100). Preparar expansión.`);
    }
    if (labels.includes('ROAS_CRITICAL')) {
      parts.push(`ROAS en nivel crítico (debajo del mínimo ${this.kpi.roas_minimum}x).`);
    }
    if (labels.includes('TOP_PERFORMER')) {
      parts.push(`Top performer — candidato para escalar si las condiciones se mantienen.`);
    }
    if (labels.includes('ROAS_DECLINING')) {
      parts.push(`ROAS en tendencia bajista — monitorear de cerca.`);
    }
    if (labels.includes('HEALTHY')) {
      parts.push('Rendimiento saludable. Sin señales de alerta.');
    }

    return parts.join(' ');
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. BENCHMARK COMPARISON
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compara métricas actuales contra benchmarks de la industria (food_ecommerce_2025).
   * Aplica multiplicador estacional al benchmark de CPM.
   */
  _diagnoseBenchmarks(m7d) {
    const signals = [];
    const seasonalMultiplier = this._getCurrentSeasonalMultiplier();

    // --- CPM vs benchmark (ajustado por temporada) ---
    const cpm7d = m7d.cpm || 0;
    const cpmRange = this.benchmarks.cpm_range;
    if (cpm7d > 0 && cpmRange) {
      const adjustedLow = cpmRange.low * seasonalMultiplier;
      const adjustedMedian = cpmRange.median * seasonalMultiplier;
      const adjustedHigh = cpmRange.high * seasonalMultiplier;

      let cpmStatus;
      if (cpm7d < adjustedLow * 0.8) cpmStatus = 'well_below';
      else if (cpm7d < adjustedLow) cpmStatus = 'below';
      else if (cpm7d <= adjustedHigh) cpmStatus = 'within_range';
      else if (cpm7d <= adjustedHigh * 1.3) cpmStatus = 'above';
      else cpmStatus = 'well_above';

      const deviationPct = adjustedMedian > 0 ? ((cpm7d - adjustedMedian) / adjustedMedian * 100) : 0;

      signals.push({
        metric: 'CPM',
        value: +cpm7d.toFixed(2),
        benchmark_low: +adjustedLow.toFixed(2),
        benchmark_median: +adjustedMedian.toFixed(2),
        benchmark_high: +adjustedHigh.toFixed(2),
        seasonal_multiplier: seasonalMultiplier,
        status: cpmStatus,
        deviation_pct: +deviationPct.toFixed(1),
        severity: (cpmStatus === 'well_above') ? 'high' : (cpmStatus === 'above' ? 'medium' : 'ok')
      });
    }

    // --- CPA vs benchmark ---
    const cpa7d = m7d.cpa || 0;
    const cpaRange = this.benchmarks.cpa_range;
    if (cpa7d > 0 && cpaRange) {
      let cpaStatus;
      if (cpa7d < cpaRange.low) cpaStatus = 'below';
      else if (cpa7d <= cpaRange.median) cpaStatus = 'good';
      else if (cpa7d <= cpaRange.high) cpaStatus = 'above_median';
      else cpaStatus = 'above_range';

      const deviationPct = cpaRange.median > 0 ? ((cpa7d - cpaRange.median) / cpaRange.median * 100) : 0;

      signals.push({
        metric: 'CPA',
        value: +cpa7d.toFixed(2),
        benchmark_low: cpaRange.low,
        benchmark_median: cpaRange.median,
        benchmark_high: cpaRange.high,
        status: cpaStatus,
        deviation_pct: +deviationPct.toFixed(1),
        severity: (cpaStatus === 'above_range') ? 'high' : (cpaStatus === 'above_median' ? 'medium' : 'ok')
      });
    }

    // --- ROAS vs benchmark ---
    const roas7d = m7d.roas || 0;
    const roasRange = this.benchmarks.roas_range;
    if (roas7d > 0 && roasRange) {
      let roasStatus;
      if (roas7d >= roasRange.high) roasStatus = 'excellent';
      else if (roas7d >= roasRange.median) roasStatus = 'good';
      else if (roas7d >= roasRange.low) roasStatus = 'below_median';
      else roasStatus = 'below_range';

      const deviationPct = roasRange.median > 0 ? ((roas7d - roasRange.median) / roasRange.median * 100) : 0;

      signals.push({
        metric: 'ROAS',
        value: +roas7d.toFixed(2),
        benchmark_low: roasRange.low,
        benchmark_median: roasRange.median,
        benchmark_high: roasRange.high,
        status: roasStatus,
        deviation_pct: +deviationPct.toFixed(1),
        severity: (roasStatus === 'below_range') ? 'high' : (roasStatus === 'below_median' ? 'medium' : 'ok')
      });
    }

    // --- CTR vs benchmark ---
    const ctr7d = m7d.ctr || 0;
    const ctrRange = this.benchmarks.ctr_range;
    if (ctr7d > 0 && ctrRange) {
      let ctrStatus;
      if (ctr7d >= ctrRange.high) ctrStatus = 'excellent';
      else if (ctr7d >= ctrRange.median) ctrStatus = 'good';
      else if (ctr7d >= ctrRange.low) ctrStatus = 'below_median';
      else ctrStatus = 'below_range';

      const deviationPct = ctrRange.median > 0 ? ((ctr7d - ctrRange.median) / ctrRange.median * 100) : 0;

      signals.push({
        metric: 'CTR',
        value: +ctr7d.toFixed(2),
        benchmark_low: ctrRange.low,
        benchmark_median: ctrRange.median,
        benchmark_high: ctrRange.high,
        status: ctrStatus,
        deviation_pct: +deviationPct.toFixed(1),
        severity: (ctrStatus === 'below_range') ? 'high' : (ctrStatus === 'below_median' ? 'medium' : 'ok')
      });
    }

    // Count issues
    const issues = signals.filter(s => s.severity !== 'ok');
    return {
      signals,
      issues_count: issues.length,
      seasonal_multiplier: seasonalMultiplier,
      quarter: this._getCurrentQuarter()
    };
  }

  /**
   * Determina el multiplicador estacional de CPM basado en el trimestre actual.
   */
  _getCurrentSeasonalMultiplier() {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const day = now.getDate();

    // Q4 BFCM: Nov 15 - Dec 5 approx
    if ((month === 11 && day >= 15) || (month === 12 && day <= 5)) {
      return this.seasonalMultipliers.q4_bfcm || 2.0;
    }
    // Q4 holiday: Dec 6-31
    if (month === 12 && day > 5) {
      return this.seasonalMultipliers.q4_holiday || 1.5;
    }
    // Q4 early: Oct 1 - Nov 14
    if (month === 10 || (month === 11 && day < 15)) {
      return this.seasonalMultipliers.q4_early || 1.3;
    }
    // Q1: Jan-Mar
    if (month >= 1 && month <= 3) {
      return this.seasonalMultipliers.q1 || 0.85;
    }
    // Q2: Apr-Jun
    if (month >= 4 && month <= 6) {
      return this.seasonalMultipliers.q2 || 1.0;
    }
    // Q3: Jul-Sep
    return this.seasonalMultipliers.q3 || 1.05;
  }

  _getCurrentQuarter() {
    const month = new Date().getMonth() + 1;
    if (month <= 3) return 'Q1';
    if (month <= 6) return 'Q2';
    if (month <= 9) return 'Q3';
    return 'Q4';
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. FUNNEL THRESHOLD GRADING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compara tasas de funnel contra umbrales de la config (healthy/problem).
   * Genera señales de severidad automáticas cuando las tasas caen bajo el umbral.
   */
  _gradeFunnelThresholds(funnelDiagnosis) {
    const grades = [];
    const rates = funnelDiagnosis.rates;

    // Click → ATC: healthy >5%, problem <2%
    const clickToAtcThreshold = this.funnelThresholds.click_to_atc;
    if (rates.click_to_atc_7d > 0 && clickToAtcThreshold) {
      const healthyVal = parseFloat(clickToAtcThreshold.healthy?.replace(/[>%]/g, '')) || 5;
      const problemVal = parseFloat(clickToAtcThreshold.problem?.replace(/[<%]/g, '')) || 2;

      let grade;
      if (rates.click_to_atc_7d >= healthyVal) grade = 'healthy';
      else if (rates.click_to_atc_7d >= problemVal) grade = 'warning';
      else grade = 'problem';

      grades.push({
        stage: 'click_to_atc',
        rate: rates.click_to_atc_7d,
        healthy_threshold: healthyVal,
        problem_threshold: problemVal,
        grade,
        severity: grade === 'problem' ? 'high' : (grade === 'warning' ? 'medium' : 'ok'),
        action: grade !== 'healthy' ? clickToAtcThreshold.action : null
      });
    }

    // ATC → IC: healthy >50%, problem <25%
    const atcToIcThreshold = this.funnelThresholds.atc_to_ic;
    if (rates.atc_to_ic_7d > 0 && atcToIcThreshold) {
      const healthyVal = parseFloat(atcToIcThreshold.healthy?.replace(/[>%]/g, '')) || 50;
      const problemVal = parseFloat(atcToIcThreshold.problem?.replace(/[<%]/g, '')) || 25;

      let grade;
      if (rates.atc_to_ic_7d >= healthyVal) grade = 'healthy';
      else if (rates.atc_to_ic_7d >= problemVal) grade = 'warning';
      else grade = 'problem';

      grades.push({
        stage: 'atc_to_ic',
        rate: rates.atc_to_ic_7d,
        healthy_threshold: healthyVal,
        problem_threshold: problemVal,
        grade,
        severity: grade === 'problem' ? 'high' : (grade === 'warning' ? 'medium' : 'ok'),
        action: grade !== 'healthy' ? atcToIcThreshold.action : null
      });
    }

    // IC → Purchase: healthy >60%, problem <30%
    const icToPurchaseThreshold = this.funnelThresholds.ic_to_purchase;
    if (rates.ic_to_purchase_7d > 0 && icToPurchaseThreshold) {
      const healthyVal = parseFloat(icToPurchaseThreshold.healthy?.replace(/[>%]/g, '')) || 60;
      const problemVal = parseFloat(icToPurchaseThreshold.problem?.replace(/[<%]/g, '')) || 30;

      let grade;
      if (rates.ic_to_purchase_7d >= healthyVal) grade = 'healthy';
      else if (rates.ic_to_purchase_7d >= problemVal) grade = 'warning';
      else grade = 'problem';

      grades.push({
        stage: 'ic_to_purchase',
        rate: rates.ic_to_purchase_7d,
        healthy_threshold: healthyVal,
        problem_threshold: problemVal,
        grade,
        severity: grade === 'problem' ? 'high' : (grade === 'warning' ? 'medium' : 'ok'),
        action: grade !== 'healthy' ? icToPurchaseThreshold.action : null
      });
    }

    const problems = grades.filter(g => g.grade === 'problem');
    const warnings = grades.filter(g => g.grade === 'warning');

    return {
      grades,
      problems_count: problems.length,
      warnings_count: warnings.length,
      worst_stage: problems.length > 0 ? problems[0].stage : (warnings.length > 0 ? warnings[0].stage : null)
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. CREATIVE LIFESPAN TRACKING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Calcula la edad de cada ad activo y genera señales de refresh proactivas.
   * Basado en creative_lifespan: 14d early fatigue, 21d moderate, 28d+ severe.
   */
  _diagnoseCreativeLifespan(ads) {
    const activeAds = ads.filter(a => a.status === 'ACTIVE');
    if (activeAds.length === 0) {
      return { ads: [], needs_refresh: false, oldest_days: 0, avg_age_days: 0 };
    }

    const now = new Date();
    const adAges = [];

    for (const ad of activeAds) {
      // Use created_time or start_time if available
      const createdAt = ad.created_time || ad.start_time || ad.created_at;
      if (!createdAt) continue;

      const createdDate = new Date(createdAt);
      const ageDays = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

      let lifespanStatus;
      let severity;
      if (ageDays >= 28) {
        lifespanStatus = 'severe_fatigue';
        severity = 'critical';
      } else if (ageDays >= 21) {
        lifespanStatus = 'moderate_fatigue';
        severity = 'high';
      } else if (ageDays >= 14) {
        lifespanStatus = 'early_fatigue';
        severity = 'medium';
      } else if (ageDays >= 7) {
        lifespanStatus = 'peak_performance';
        severity = 'ok';
      } else {
        lifespanStatus = 'learning';
        severity = 'ok';
      }

      adAges.push({
        ad_id: ad.entity_id || ad.id,
        ad_name: ad.entity_name || ad.name || 'Unknown',
        age_days: ageDays,
        status: lifespanStatus,
        severity,
        needs_refresh: ageDays >= 14
      });
    }

    // Sort oldest first
    adAges.sort((a, b) => b.age_days - a.age_days);

    const oldestDays = adAges.length > 0 ? adAges[0].age_days : 0;
    const avgAge = adAges.length > 0 ? Math.round(adAges.reduce((s, a) => s + a.age_days, 0) / adAges.length) : 0;
    const needsRefresh = adAges.some(a => a.needs_refresh);
    const urgentCount = adAges.filter(a => a.severity === 'critical' || a.severity === 'high').length;

    return {
      ads: adAges,
      needs_refresh: needsRefresh,
      urgent_refresh_count: urgentCount,
      oldest_days: oldestDays,
      avg_age_days: avgAge,
      summary: this._buildLifespanSummary(adAges, oldestDays, urgentCount)
    };
  }

  _buildLifespanSummary(adAges, oldestDays, urgentCount) {
    if (adAges.length === 0) return 'Sin ads activos para analizar.';
    if (urgentCount > 0) {
      return `${urgentCount} ad${urgentCount > 1 ? 's' : ''} con ${oldestDays}+ días activo${urgentCount > 1 ? 's' : ''} — refresh urgente recomendado.`;
    }
    if (oldestDays >= 14) {
      return `Ad más antiguo tiene ${oldestDays} días — entrando en zona de fatiga temprana.`;
    }
    return `Ads frescos (más antiguo: ${oldestDays} días). Sin urgencia de refresh.`;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  _groupAdsByAdSet(adSnapshots) {
    const map = {};
    for (const ad of adSnapshots) {
      const pid = ad.parent_id || 'unknown';
      if (!map[pid]) map[pid] = [];
      map[pid].push(ad);
    }
    return map;
  }

  /**
   * Genera un resumen compacto de todos los diagnósticos para inyectar en el prompt.
   * Este es el texto que Claude ve antes de cada ad set.
   */
  formatForPrompt(diagnostics) {
    if (!diagnostics || Object.keys(diagnostics).length === 0) return '';

    let text = `\n═══ DIAGNÓSTICO PRE-ANÁLISIS (Motor Matemático) ═══\n`;
    text += `Los siguientes diagnósticos fueron computados ANTES de tu análisis. Úsalos como contexto estructurado:\n\n`;

    const sorted = Object.values(diagnostics).sort((a, b) => {
      const urgencyOrder = { high: 0, medium: 1, low: 2 };
      return (urgencyOrder[a.overall.urgency] || 2) - (urgencyOrder[b.overall.urgency] || 2);
    });

    for (const d of sorted) {
      const urgent = d.overall.urgency === 'high' ? '⚠ ' : '';
      text += `${urgent}[${d.entity_name}] → ${d.overall.labels.join(' + ')} | Acción sugerida: ${d.overall.primary_action}\n`;

      // Funnel
      if (d.funnel.has_data) {
        text += `  Funnel: Click→ATC=${d.funnel.rates.click_to_atc_7d}% | ATC→IC=${d.funnel.rates.atc_to_ic_7d}% | IC→Compra=${d.funnel.rates.ic_to_purchase_7d}%`;
        if (d.funnel.leaks.length > 0) {
          text += ` | LEAK: ${d.funnel.leaks.map(l => l.label).join(', ')}`;
        }
        text += '\n';
      }

      // Funnel Grades (threshold enforcement)
      if (d.funnel_grades && d.funnel_grades.grades.length > 0) {
        const nonHealthy = d.funnel_grades.grades.filter(g => g.grade !== 'healthy');
        if (nonHealthy.length > 0) {
          text += `  Funnel Grades: `;
          text += nonHealthy.map(g => `${g.stage}=${g.rate}% [${g.grade.toUpperCase()} — healthy:>${g.healthy_threshold}%, problem:<${g.problem_threshold}%]`).join(' | ');
          text += '\n';
          for (const g of nonHealthy) {
            if (g.action) text += `    → ${g.stage}: ${g.action}\n`;
          }
        }
      }

      // Fatigue (with per-ad breakdown)
      if (d.fatigue.score > 10) {
        text += `  Fatiga: ${d.fatigue.level} (${d.fatigue.score}/100)`;
        if (d.fatigue.signals.length > 0) {
          text += ` — ${d.fatigue.signals.map(s => s.signal).join(', ')}`;
        }
        text += ` | ${d.active_ads} ads activos`;
        if (d.fatigue.learning_count > 0) text += ` (${d.fatigue.learning_count} LEARNING)`;
        if (d.fatigue.fatigued_count > 0) text += ` (${d.fatigue.fatigued_count} fatigados/drag)`;
        text += '\n';
        // Per-ad breakdown
        if (d.fatigue.ad_breakdown && d.fatigue.ad_breakdown.length > 0) {
          for (const ab of d.fatigue.ad_breakdown) {
            const tag = ab.status.toUpperCase();
            const action = ab.action === 'protect' ? 'NO TOCAR' : ab.action === 'pause_candidate' ? 'PAUSAR' : ab.action;
            text += `    → [${tag}] "${ab.ad_name}" — ${ab.age_days}d | ROAS: ${ab.roas_7d.toFixed(2)}x | Freq: ${ab.frequency_7d.toFixed(1)} | $${ab.spend_7d.toFixed(0)}/sem | Acción: ${action}\n`;
          }
        }
      }

      // Creative Lifespan
      if (d.creative_lifespan && d.creative_lifespan.needs_refresh) {
        text += `  Creative Lifespan: ${d.creative_lifespan.summary}`;
        if (d.creative_lifespan.urgent_refresh_count > 0) {
          text += ` [${d.creative_lifespan.urgent_refresh_count} URGENTE]`;
        }
        text += '\n';
        // Show top 3 oldest ads
        const oldestAds = d.creative_lifespan.ads.filter(a => a.needs_refresh).slice(0, 3);
        for (const ad of oldestAds) {
          text += `    → "${ad.ad_name}" — ${ad.age_days}d activo (${ad.status})\n`;
        }
      }

      // Saturation
      if (d.saturation.score > 10) {
        text += `  Saturación: ${d.saturation.level} (${d.saturation.score}/100)`;
        if (d.saturation.signals.length > 0) {
          text += ` — ${d.saturation.signals.map(s => s.signal).join(', ')}`;
        }
        text += '\n';
      }

      // Statistical Confidence + Attribution
      if (d.statistical_confidence) {
        const sc = d.statistical_confidence;
        const attrLabel = d.attribution_maturity || '';
        text += `  Confianza estadística: ${(sc.confidence_level * 100).toFixed(0)}% [${sc.confidence_label}] — ${sc.details}`;
        if (sc.roas_interval && sc.roas_interval.reliable) {
          text += ` | ROAS 90% CI: [${sc.roas_interval.lower}x, ${sc.roas_interval.upper}x]`;
        }
        text += '\n';
      }
      if (d.attribution) {
        const attr = d.attribution;
        if (attr.corrected_roas.roas_7d_corrected > 0 && attr.corrected_roas.roas_7d_corrected !== (d.efficiency?.roas_7d || 0)) {
          text += `  Atribución: ROAS 7d reportado=${(d.efficiency?.roas_7d || (d._raw_metrics?.roas || 0)).toFixed(2)}x → corregido=${attr.corrected_roas.roas_7d_corrected.toFixed(2)}x (madurez: ${attr.attribution_maturity.label})\n`;
        }
      }

      // Efficiency
      text += `  Eficiencia: ROAS ${d.efficiency.roas_status} (trend: ${d.efficiency.roas_trend}) | vs cuenta: ${d.efficiency.relative_performance}`;
      if (d.efficiency.aov_7d > 0) text += ` | AOV: $${d.efficiency.aov_7d}`;
      text += '\n';

      // Benchmark Comparison
      if (d.benchmark_comparison && d.benchmark_comparison.signals.length > 0) {
        const benchIssues = d.benchmark_comparison.signals.filter(s => s.severity !== 'ok');
        if (benchIssues.length > 0) {
          text += `  Benchmarks (${d.benchmark_comparison.quarter}, seasonal×${d.benchmark_comparison.seasonal_multiplier}): `;
          text += benchIssues.map(s => `${s.metric}=$${s.metric === 'ROAS' ? '' : ''}${s.value}${s.metric === 'CTR' ? '%' : (s.metric === 'ROAS' ? 'x' : '')} [${s.status} — ${s.deviation_pct > 0 ? '+' : ''}${s.deviation_pct}% vs median]`).join(' | ');
          text += '\n';
        }
      }

      // Summary
      if (d.overall.summary) {
        text += `  Resumen: ${d.overall.summary}\n`;
      }

      text += '\n';
    }

    // Add diagnostic framework reference
    text += `INSTRUCCIONES PARA USAR ESTOS DIAGNÓSTICOS:\n`;
    text += `1. Si un ad set tiene FUNNEL_LEAK → NO pausar ni bajar budget. El problema es pre-conversión, no el ad.\n`;
    text += `2. Si un ad set tiene CREATIVE_FATIGUE → Priorizar add_creatives/refresh antes de cualquier cambio de budget.\n`;
    text += `3. Si un ad set tiene AUDIENCE_SATURATED → Considerar: expandir audiencia, bajar budget, o horizontal scaling.\n`;
    text += `4. Si ROAS_CRITICAL + sin funnel leak + sin fatiga → Entonces sí considerar scale_down o pause como último recurso.\n`;
    text += `5. Si TOP_PERFORMER + healthy → Candidato a scale_up (máx 20% por cambio).\n`;
    text += `6. Siempre diagnostica el POR QUÉ antes del QUÉ HACER. El diagnóstico te dice la causa probable.\n`;
    text += `7. BENCHMARKS: Las métricas se comparan contra food_ecommerce_2025 con ajuste estacional. Si CPM está "well_above" con seasonal multiplier ya aplicado, es señal real de problema.\n`;
    text += `8. FUNNEL GRADES: Click→ATC <5% = problema de landing page. ATC→IC <50% = fricción en checkout. IC→Purchase <60% = problema de pago. Seguir la acción recomendada.\n`;
    text += `9. CREATIVE LIFESPAN: Ads con >14d necesitan evaluación, >21d refresh recomendado, >28d refresh urgente. La edad del ad es un predictor de fatiga ANTES de que se vea en métricas.\n`;
    text += `10. CONFIANZA ESTADÍSTICA: Si un ad set tiene confianza "low" o "insufficient" (<55%), NO actúes agresivamente (no pausar, no scale_down fuerte). Usa "observe" o acciones conservadoras. Con <10 compras en 7d, ROAS es ruido estadístico.\n`;
    text += `11. CORRECCIÓN DE ATRIBUCIÓN: El ROAS "corregido" estima el ROAS real ajustando por conversiones que Meta aún no ha atribuido. Si el ROAS reportado es bajo pero el corregido es aceptable, es probable que los datos aún estén madurando — NO actuar precipitadamente.\n`;

    return text;
  }
}

module.exports = DiagnosticEngine;
