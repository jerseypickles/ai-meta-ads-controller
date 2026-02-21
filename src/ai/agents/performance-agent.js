const BaseAgent = require('./base-agent');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');

class PerformanceAgent extends BaseAgent {
  constructor() {
    super('performance');
  }

  getSystemPrompt() {
    return `Eres el Agente de Rendimiento para Jersey Pickles (ecommerce de pickles y productos gourmet).

TU UNICO ENFOQUE: Analizar ROAS, CPA y tendencias de rendimiento por ad set. Identificar los que pierden dinero y los que son oportunidad. Tambien puedes recomendar cambios de bid strategy a nivel campana.

CONTEXTO META ADS — CONFIGURACION DE CUENTA:
- Campanas ABO (Ad Set Budget Optimization): cada ad set tiene su propio presupuesto. NO hay CBO.
- Objetivo de conversion: PURCHASE (compras reales, no leads ni clicks).
- Atribucion: 7-day click / 1-day view. IMPORTANTE: los datos recientes (hoy, 3d) estan INCOMPLETOS por la ventana de atribucion. Compras atribuidas via 7-day click pueden reportarse hasta 7 dias despues del click. Siempre prioriza datos de 7d y 14d para decisiones.
- Advantage+ Audience: Meta optimiza el targeting automaticamente. No nos preocupa el reach, solo las conversiones y ROAS.
- Learning Phase: ~50 conversiones en 7 dias. Un ad set en learning phase muestra rendimiento volatil — es NORMAL. NO lo pauses por ROAS bajo si esta en learning phase y tiene menos de 7 dias.
- Las compras se atribuyen al dia del CLICK, no al dia de la compra. Esto significa que el ROAS de "hoy" casi siempre parece bajo y mejora con el tiempo.
- Un ROAS de 3d que parece bajo comparado con 7d puede ser simplemente atribucion incompleta, NO necesariamente una tendencia a la baja.

ACCIONES QUE PUEDES RECOMENDAR:
1. "scale_up" — Subir budget del ad set. Para performers con ROAS alto sostenido.
2. "scale_down" — Bajar budget. Para ad sets con rendimiento decayendo.
3. "pause" — Pausar ad set que pierde dinero consistentemente.
4. "reactivate" — Reactivar ad set pausado si hay razon para intentar de nuevo.
5. "update_bid_strategy" — Cambiar estrategia de puja a nivel CAMPANA. entity_type debe ser "campaign", entity_id = campaign ID. Opciones de bid_strategy: "LOWEST_COST_WITHOUT_CAP" (default, Meta optimiza), "LOWEST_COST_WITH_BID_CAP" (poner tope), "COST_CAP" (CPA objetivo). recommended_value = bid amount (0 para LOWEST_COST_WITHOUT_CAP).

REGLAS:
- ROAS objetivo: ${kpiTargets.roas_target}x | ROAS minimo aceptable: ${kpiTargets.roas_minimum}x | ROAS excelente: ${kpiTargets.roas_excellent}x
- CPA objetivo: $${kpiTargets.cpa_target} | CPA maximo: $${kpiTargets.cpa_maximum}
- Necesitas minimo ${safetyGuards.trend_analysis.min_data_days} dias de datos para recomendar
- Gasto minimo para decidir: $${safetyGuards.trend_analysis.min_spend_for_decision}
- Se conservador: la tendencia importa mas que un dia bueno/malo
- PRIORIZA datos de 7d y 14d sobre hoy/3d para decisiones de rendimiento

LOGICA DE RENDIMIENTO:
- ROAS 7d < 1.0x Y ROAS 14d < 1.0x = perdiendo dinero consistentemente, considerar pausar
- ROAS 7d entre 1.0x y ${kpiTargets.roas_minimum}x = bajo rendimiento, reducir budget
- ROAS 7d > ${kpiTargets.roas_target}x Y estable en 14d = buen performer, puede escalar
- ROAS 7d > ${kpiTargets.roas_excellent}x = excelente, recomendar escalar
- CPA 7d > $${kpiTargets.cpa_maximum} sostenido en 14d = problema, reducir o pausar
- Compara ROAS 7d vs 14d (NO 3d vs 7d) para tendencias reales. Si 7d < 14d significativamente = tendencia bajista real
- Si 7d > 14d = mejorando (buena senal)
- NO reacciones a caidas de ROAS hoy/3d — la atribucion es incompleta

LOGICA DE BID STRATEGY:
- Si CPA 7d consistentemente > $${kpiTargets.cpa_maximum} en TODA la campana = considerar COST_CAP con target $${kpiTargets.cpa_target}
- Si CPA esta bien con LOWEST_COST = NO cambiar (es el default mas eficiente)
- update_bid_strategy es una accion de nivel campana — afecta TODOS los ad sets de esa campana
- Solo recomendar cambio de bid strategy con confidence HIGH y datos de 14d+

RESPONDE SOLO con JSON valido, sin markdown:
{
  "summary": "Resumen de 1 linea sobre rendimiento general",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "scale_up | scale_down | pause | reactivate | update_bid_strategy",
      "entity_type": "adset | campaign",
      "entity_id": "ID",
      "entity_name": "Nombre",
      "current_value": 50,
      "recommended_value": 60,
      "bid_strategy": "LOWEST_COST_WITHOUT_CAP | LOWEST_COST_WITH_BID_CAP | COST_CAP (solo para update_bid_strategy)",
      "reasoning": "Explicacion clara en espanol",
      "expected_impact": "Que esperamos que pase",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics": { "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0, "spend_today": 0, "frequency": 0, "ctr": 0 }
    }
  ],
  "alerts": [
    { "type": "roas_critical | roas_declining | opportunity | bid_strategy_change", "message": "Descripcion", "severity": "critical | warning | info" }
  ]
}

FEEDBACK LOOP — APRENDE DE TUS ERRORES Y EXITOS:
Recibiras un bloque "FEEDBACK LOOP" con el historial de TUS acciones pasadas y sus resultados MEDIDOS (ROAS/CPA antes vs despues).
- Si pausaste un ad set y despues la cuenta EMPEORO, fuiste muy agresivo — se mas paciente.
- Si un scale_down mejo las metricas, ese patron funciona — repítelo en ad sets similares.
- Si reactivaste un ad set y funciono, toma nota de que tipo de ad set era (ROAS, gasto, etc).
- Tu promedio de delta ROAS te dice si estas MEJORANDO o EMPEORANDO la cuenta. Si es negativo, se MAS conservador.
- Mira patrones: si "pause" tiene alta tasa de exito pero "scale_down" no, prefiere pausar sobre reducir.

MAXIMO 8 recomendaciones — prioriza las mas impactantes.
Si no hay recomendaciones, retorna array vacio. Para pause/reactivate, current_value y recommended_value son 0. SIEMPRE incluye summary.`;
  }

  buildUserPrompt(sharedData) {
    const { accountOverview, adSetSnapshots, campaignSnapshots } = sharedData;

    // Metricas de rendimiento completas
    const adSetData = adSetSnapshots.map(s => ({
      id: s.entity_id,
      name: s.entity_name,
      status: s.status,
      daily_budget: s.daily_budget,
      campaign_id: s.parent_id || null,
      roas_7d: s.metrics?.last_7d?.roas || 0,
      roas_3d: s.metrics?.last_3d?.roas || 0,
      roas_14d: s.metrics?.last_14d?.roas || 0,
      roas_30d: s.metrics?.last_30d?.roas || 0,
      roas_today: s.metrics?.today?.roas || 0,
      cpa_7d: s.metrics?.last_7d?.cpa || 0,
      spend_7d: s.metrics?.last_7d?.spend || 0,
      spend_3d: s.metrics?.last_3d?.spend || 0,
      spend_today: s.metrics?.today?.spend || 0,
      spend_14d: s.metrics?.last_14d?.spend || 0,
      spend_30d: s.metrics?.last_30d?.spend || 0,
      purchases_7d: s.metrics?.last_7d?.purchases || 0,
      revenue_7d: s.metrics?.last_7d?.purchase_value || 0,
      trend: s.analysis?.roas_trend || 'stable'
    }));

    // Datos de campanas para bid strategy
    const campaignData = (campaignSnapshots || []).map(c => ({
      id: c.entity_id,
      name: c.entity_name,
      status: c.status,
      bid_strategy: c.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
      roas_7d: c.metrics?.last_7d?.roas || 0,
      roas_14d: c.metrics?.last_14d?.roas || 0,
      cpa_7d: c.metrics?.last_7d?.cpa || 0,
      spend_7d: c.metrics?.last_7d?.spend || 0
    }));

    let prompt = `ROAS CUENTA 7d: ${accountOverview.roas_7d.toFixed(2)}x | 3d: ${accountOverview.roas_3d.toFixed(2)}x | 14d: ${(accountOverview.roas_14d || 0).toFixed(2)}x | 30d: ${(accountOverview.roas_30d || 0).toFixed(2)}x
GASTO HOY: $${accountOverview.today_spend.toFixed(2)}
REVENUE HOY: $${accountOverview.today_revenue.toFixed(2)}
AD SETS ACTIVOS: ${accountOverview.active_adsets} | PAUSADOS: ${accountOverview.paused_adsets}

AD SETS (rendimiento detallado):
${JSON.stringify(adSetData, null, 2)}`;

    if (campaignData.length > 0) {
      prompt += `\n\nCAMPANAS (para bid strategy):
${JSON.stringify(campaignData, null, 2)}`;
    }

    prompt += `\n\nAnaliza el rendimiento de cada ad set. Identifica los que pierden dinero, los que tienen oportunidad de escalar, y tendencias preocupantes. Compara ROAS en ventanas cortas (3d) vs largas (14d, 30d) para identificar tendencias. Si el CPA de una campana completa es consistentemente alto, considera recomendar update_bid_strategy.`;

    prompt += this._buildLearningPhaseProtection(sharedData);
    prompt += this._buildRecentActionsContext(sharedData);
    prompt += this._buildImpactFeedbackContext(sharedData);

    return prompt;
  }

  getResearchContext(sharedData) {
    const { accountOverview, adSetSnapshots } = sharedData;
    const activeAdSets = (adSetSnapshots || []).filter(s => s.status === 'ACTIVE');
    const lowPerformers = activeAdSets.filter(s => (s.metrics?.last_7d?.roas || 0) < kpiTargets.roas_minimum);

    return {
      low_roas: accountOverview?.roas_7d < kpiTargets.roas_minimum,
      high_cpa: activeAdSets.some(s => (s.metrics?.last_7d?.cpa || 0) > kpiTargets.cpa_maximum),
      many_low_performers: lowPerformers.length > activeAdSets.length * 0.5
    };
  }
}

module.exports = PerformanceAgent;
