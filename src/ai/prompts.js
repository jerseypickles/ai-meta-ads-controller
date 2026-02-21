const kpiTargets = require('../../config/kpi-targets');
const safetyGuards = require('../../config/safety-guards');
const moment = require('moment-timezone');

/**
 * Verifica si hoy es un evento estacional y retorna info.
 */
function getSeasonalContext() {
  const today = moment().tz('America/New_York');
  const mmdd = today.format('MM-DD');

  for (const event of kpiTargets.seasonal_events) {
    if (event.date && event.date === mmdd) {
      return event;
    }
    if (event.start && event.end) {
      if (mmdd >= event.start && mmdd <= event.end) {
        return event;
      }
    }
  }
  return null;
}

const SYSTEM_PROMPT = `Eres un experto en optimización de Meta Ads manejando campañas para Jersey Pickles, una empresa artesanal de New Jersey que vende pickles, aceitunas y productos gourmet online (jerseypickles.com).

TU OBJETIVO PRINCIPAL: Maximizar el ROAS (Return on Ad Spend) mientras se mantiene una escala rentable.

TUS CAPACIDADES:
1. OPTIMIZACIÓN DE PRESUPUESTO: Aumentar o disminuir presupuestos diarios de ad sets
2. CONTROL DE STATUS: Pausar ads/ad sets con bajo rendimiento, reactivar los prometedores

ESTRUCTURA DE LA CUENTA:
- Una sola cuenta publicitaria
- Campañas con estructura ABO (presupuesto por ad set, NO CBO)
- Aproximadamente 30-40 ad sets activos en una campaña principal
- Solo ecommerce directo (jerseypickles.com)

ENFOQUE CAUTELOSO — ANALIZAR ANTES DE ACTUAR:
- SIEMPRE analiza la tendencia de al menos 3 días antes de hacer cambios
- NO reacciones a fluctuaciones de un solo día
- Prioriza la estabilidad sobre la velocidad de optimización
- Si los datos son insuficientes o ambiguos, la decisión correcta es NO_ACTION
- Peso de datos: ayer (completo) > hoy (parcial, ~3h de retraso en Meta)

FRAMEWORK DE DECISIONES:

ESCALAR (aumentar presupuesto) cuando:
- ROAS está por encima del objetivo (>${kpiTargets.roas_target}x) de forma consistente por 3+ días
- CPA está por debajo del objetivo y la tendencia es estable o mejorando
- El ad set NO está en fase de aprendizaje (tiene 50+ conversiones en los últimos 7 días)
- La frecuencia está por debajo de 2.5 (audiencia no fatigada)
- Escalar gradualmente: +15-20% por ajuste, NUNCA más de +${safetyGuards.max_budget_increase_pct}%

REDUCIR (disminuir presupuesto) cuando:
- ROAS está por debajo del objetivo y en declive por 3+ días
- CPA está subiendo por encima del objetivo sin señales de recuperación
- Reducir 15-20%, dar 24-48h para estabilizar antes de más recortes

PAUSAR cuando:
- ROAS por debajo de 1.0x por 3+ días consecutivos (perdiendo dinero)
- CPA está 2x+ por encima del objetivo con 7+ días de datos
- Frecuencia por encima de 4.0 (fatiga severa de audiencia)
- CTR por debajo de 0.5% con gasto significativo (fatiga creativa)
- Ad ha gastado 3x el CPA objetivo sin ninguna conversión

REACTIVAR cuando:
- Previamente pausado por frecuencia, lleva 7+ días apagado (audiencia refrescada)
- La cuenta necesita más inventario activo para mantener objetivos de gasto

NO TOCAR cuando:
- Ad set está en fase de aprendizaje (< 50 conversiones en 7 días, lanzado recientemente)
- La entidad fue ajustada en las últimas ${safetyGuards.cooldown_hours} horas (cooldown)
- Las métricas son inconcluyentes (bajo gasto, pocos datos)
- Solo hay datos de 1-2 días (insuficiente para decidir)

FORMATO DE RESPUESTA — DEBES responder con JSON válido solamente, sin markdown ni texto adicional:
{
  "analysis_summary": "Resumen breve del estado de la cuenta",
  "total_daily_spend": 0.00,
  "account_roas": 0.00,
  "decisions": [
    {
      "action": "scale_up | scale_down | pause | reactivate | no_action",
      "entity_type": "adset | ad",
      "entity_id": "ID",
      "entity_name": "Nombre",
      "campaign_name": "Nombre de Campaña",
      "current_value": 0,
      "new_value": 0,
      "change_percent": 0,
      "reasoning": "Explicación de 1-2 oraciones",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics_snapshot": {
        "roas_3d": 0,
        "roas_7d": 0,
        "cpa_3d": 0,
        "spend_today": 0,
        "frequency": 0,
        "ctr": 0
      }
    }
  ],
  "alerts": [
    {
      "type": "budget_pacing | frequency_warning | roas_critical | opportunity",
      "message": "Descripción",
      "severity": "critical | warning | info"
    }
  ]
}`;

/**
 * Genera el prompt de usuario con datos en vivo.
 */
function buildUserPrompt(data) {
  const {
    snapshots,
    recentDecisions,
    accountOverview
  } = data;

  const now = moment().tz('America/New_York');
  const seasonalEvent = getSeasonalContext();

  // Separar snapshots por tipo
  const campaignSnapshots = snapshots.filter(s => s.entity_type === 'campaign');
  const adSetSnapshots = snapshots.filter(s => s.entity_type === 'adset');
  const adSnapshots = snapshots.filter(s => s.entity_type === 'ad');

  // Pacing
  const hoursElapsed = now.hours() + (now.minutes() / 60);
  const expectedSpend = kpiTargets.daily_spend_target * (hoursElapsed / 24);
  const pacing = expectedSpend > 0
    ? ((accountOverview.today_spend / expectedSpend) * 100).toFixed(0)
    : 0;

  // Formato de decisiones recientes
  const recentDecisionsText = recentDecisions.length > 0
    ? recentDecisions.map(d => {
      const actions = d.decisions
        .filter(dec => dec.action !== 'no_action')
        .map(dec => `  - ${dec.action.toUpperCase()}: ${dec.entity_name} (${dec.reasoning})`)
        .join('\n');
      return `[${moment(d.created_at).tz('America/New_York').format('MM/DD HH:mm')}] ${d.analysis_summary}\n${actions || '  Sin acciones'}`;
    }).join('\n\n')
    : 'Sin decisiones previas en las últimas 24 horas.';

  // Formato de datos de campaña
  const campaignData = campaignSnapshots.map(s => ({
    id: s.entity_id,
    name: s.entity_name,
    status: s.status,
    daily_budget: s.daily_budget,
    metrics_7d: s.metrics.last_7d,
    metrics_3d: s.metrics.last_3d,
    metrics_today: s.metrics.today,
    trend: s.analysis.roas_trend
  }));

  // Formato de datos de ad sets
  const adSetData = adSetSnapshots.map(s => ({
    id: s.entity_id,
    name: s.entity_name,
    campaign_id: s.campaign_id,
    status: s.status,
    daily_budget: s.daily_budget,
    metrics_7d: s.metrics.last_7d,
    metrics_3d: s.metrics.last_3d,
    metrics_today: s.metrics.today,
    analysis: s.analysis
  }));

  // Formato de datos de ads
  const adData = adSnapshots.map(s => ({
    id: s.entity_id,
    name: s.entity_name,
    adset_id: s.parent_id,
    campaign_id: s.campaign_id,
    status: s.status,
    metrics_7d: s.metrics.last_7d,
    metrics_3d: s.metrics.last_3d,
    metrics_today: s.metrics.today,
    analysis: s.analysis
  }));

  let prompt = `Hora Actual: ${now.format('YYYY-MM-DD HH:mm')} (ET)
Período de Análisis: Datos actualizados

═══ RESUMEN DE LA CUENTA ═══
Presupuesto Diario Total: $${accountOverview.total_daily_budget.toFixed(2)}
Gasto de Hoy: $${accountOverview.today_spend.toFixed(2)} (${pacing}% del pacing)
ROAS Cuenta (7d): ${accountOverview.roas_7d.toFixed(2)}x
ROAS Cuenta (3d): ${accountOverview.roas_3d.toFixed(2)}x
Ad Sets Activos: ${accountOverview.active_adsets}
Ad Sets Pausados: ${accountOverview.paused_adsets}

═══ KPI OBJETIVOS ═══
ROAS Objetivo: ${kpiTargets.roas_target}x
CPA Máximo: $${kpiTargets.cpa_maximum}
Frecuencia Máxima: ${kpiTargets.frequency_critical}

═══ SAFETY GUARDS ═══
Max incremento de presupuesto por acción: ${safetyGuards.max_budget_increase_pct}%
Max reducción de presupuesto por acción: ${safetyGuards.max_budget_decrease_pct}%
Techo de presupuesto (total diario): $${safetyGuards.budget_ceiling_daily}
Presupuesto mínimo por ad set: $${safetyGuards.min_adset_budget}
Período de cooldown: ${safetyGuards.cooldown_hours} horas
Días mínimos de datos para decidir: ${safetyGuards.trend_analysis.min_data_days}

═══ DECISIONES RECIENTES DE IA (últimas 24h) ═══
${recentDecisionsText}

═══ DATOS DE CAMPAÑAS ═══
${JSON.stringify(campaignData, null, 2)}

═══ DATOS DE AD SETS ═══
${JSON.stringify(adSetData, null, 2)}

═══ DATOS DE ADS ═══
${JSON.stringify(adData, null, 2)}

Analiza todos los datos y proporciona tus decisiones de optimización como JSON.`;

  // Agregar contexto estacional si aplica
  if (seasonalEvent) {
    prompt += `\n\n═══ CONTEXTO ESTACIONAL ═══
EVENTO ACTIVO: ${seasonalEvent.name}
Multiplicador de presupuesto permitido: ${seasonalEvent.budget_multiplier}x
Puedes ser más agresivo escalando ad sets con buen rendimiento durante este evento.`;
  }

  return prompt;
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  getSeasonalContext
};
