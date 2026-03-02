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
  diagnoseAll(adsetSnapshots, adSnapshots = [], memoryMap = {}, accountOverview = {}) {
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
      const overall = this._computeOverallDiagnosis(funnel, fatigue, saturation, efficiency, m7d, snap);

      diagnostics[snap.entity_id] = {
        entity_id: snap.entity_id,
        entity_name: snap.entity_name,
        funnel,
        fatigue,
        saturation,
        efficiency,
        overall,
        active_ads: ads.filter(a => a.status === 'ACTIVE').length,
        total_ads: ads.length
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
      active_ads_count: activeAds.length
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

      // Fatigue
      if (d.fatigue.score > 10) {
        text += `  Fatiga: ${d.fatigue.level} (${d.fatigue.score}/100)`;
        if (d.fatigue.signals.length > 0) {
          text += ` — ${d.fatigue.signals.map(s => s.signal).join(', ')}`;
        }
        text += ` | ${d.active_ads} ads activos\n`;
      }

      // Saturation
      if (d.saturation.score > 10) {
        text += `  Saturación: ${d.saturation.level} (${d.saturation.score}/100)`;
        if (d.saturation.signals.length > 0) {
          text += ` — ${d.saturation.signals.map(s => s.signal).join(', ')}`;
        }
        text += '\n';
      }

      // Efficiency
      text += `  Eficiencia: ROAS ${d.efficiency.roas_status} (trend: ${d.efficiency.roas_trend}) | vs cuenta: ${d.efficiency.relative_performance}`;
      if (d.efficiency.aov_7d > 0) text += ` | AOV: $${d.efficiency.aov_7d}`;
      text += '\n';

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

    return text;
  }
}

module.exports = DiagnosticEngine;
