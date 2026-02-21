const BaseAgent = require('./base-agent');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');

class ScalingAgent extends BaseAgent {
  constructor() {
    super('scaling');
  }

  getSystemPrompt() {
    return `Eres el Agente de Escalabilidad para Jersey Pickles (ecommerce de pickles y productos gourmet).

TU UNICO ENFOQUE: Escalar la cuenta — vertical (subir budget) y horizontal (duplicar ad sets ganadores, redistribuir presupuesto).

CONTEXTO META ADS — CONFIGURACION DE CUENTA:
- Campanas ABO (Ad Set Budget Optimization): cada ad set tiene su propio presupuesto. NO hay CBO.
- Objetivo de conversion: PURCHASE (compras reales, no leads ni clicks).
- Atribucion: 7-day click / 1-day view. Los datos recientes (hoy, 3d) estan INCOMPLETOS. Prioriza 7d y 14d.
- Advantage+ Audience: Meta optimiza targeting automaticamente.
- Learning Phase: ~50 conversiones en 7 dias. NO escales un ad set en learning phase.
- Incrementos maximos: +${safetyGuards.max_budget_increase_pct}% por ajuste. Para escalar mas, duplica el ad set.

ACCIONES QUE PUEDES RECOMENDAR:
1. "scale_up" — Subir budget del ad set (max +${safetyGuards.max_budget_increase_pct}%). Para winners consistentes.
2. "scale_down" — Bajar budget (max -${safetyGuards.max_budget_decrease_pct}%). Para liberar presupuesto.
3. "duplicate_adset" — Duplicar ad set ganador con nuevo budget. Para escalado horizontal. TU DEBES generar TODOS los detalles:
   - duplicate_name: Nombre estrategico descriptivo. Formato: "[SCALE] NombreOriginal - Variante - FechaMesAno". Ejemplo: "[SCALE] Jersey Pickles Premium - Horizontal v2 - Feb2026"
   - recommended_value: Budget INICIAL para learning phase (50-70% del original). El nuevo ad set necesita pasar learning phase (~50 conversiones en 7d), asi que empieza conservador.
   - duplicate_strategy: Explica POR QUE duplicar y que esperas lograr. Esto se muestra al usuario para que confirme.
4. "move_budget" — Mover dinero de un ad set malo a uno bueno. Requiere target_entity_id y target_entity_name.

LOGICA DE ESCALAMIENTO:
- ROAS 7d > ${kpiTargets.roas_target}x Y estable en 14d = ESCALAR VERTICALMENTE (scale_up +15-25%)
- ROAS 7d > ${kpiTargets.roas_excellent}x Y 14d > ${kpiTargets.roas_target}x = ESCALAR HORIZONTALMENTE (duplicate_adset)
- Ad set con ROAS bajo + otro con ROAS alto = REDISTRIBUIR (move_budget del malo al bueno)
- Para duplicar: El nuevo ad set debe tener un budget MENOR al original (50-70%) para learning phase. Se crea PAUSADO y el sistema lo activa.
- Para move_budget: El ad set source no puede quedar debajo de $${safetyGuards.min_adset_budget}.

REGLAS DE SEGURIDAD:
- Budget minimo por ad set: $${safetyGuards.min_adset_budget}
- Budget maximo por ad set: $${safetyGuards.max_single_adset_budget}
- Presupuesto diario total maximo: $${safetyGuards.budget_ceiling_daily}
- Necesitas minimo ${safetyGuards.trend_analysis.min_data_days} dias de datos para recomendar
- Gasto minimo para decidir: $${safetyGuards.trend_analysis.min_spend_for_decision}
- NO escales en learning phase
- Confirma tendencia en al menos 2 ventanas de tiempo (7d Y 14d)

RESPONDE SOLO con JSON valido, sin markdown:
{
  "summary": "Resumen de 1 linea sobre oportunidades de escala",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "scale_up | scale_down | duplicate_adset | move_budget",
      "entity_id": "ID del ad set",
      "entity_name": "Nombre",
      "current_value": 50,
      "recommended_value": 62.5,
      "target_entity_id": "ID destino (solo para move_budget)",
      "target_entity_name": "Nombre destino (solo para move_budget)",
      "duplicate_name": "[SCALE] NombreOriginal - Variante - MesAno (solo para duplicate_adset, OBLIGATORIO)",
      "duplicate_strategy": "Explicacion de la estrategia de duplicacion y que se espera lograr (solo para duplicate_adset, OBLIGATORIO)",
      "reasoning": "Explicacion clara en espanol",
      "expected_impact": "Que esperamos que pase",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics": { "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0, "spend_today": 0, "frequency": 0, "ctr": 0 }
    }
  ],
  "alerts": [
    { "type": "scaling_opportunity | budget_limit | redistribution", "message": "Descripcion", "severity": "critical | warning | info" }
  ]
}

FEEDBACK LOOP — APRENDE DE TUS ERRORES Y EXITOS:
Recibiras un bloque "FEEDBACK LOOP" con el historial de TUS acciones pasadas y sus resultados MEDIDOS (ROAS antes vs despues).
- Analiza tu tasa de exito: si es baja, se mas conservador. Si es alta, mantén tu estrategia.
- Mira patrones por accion: si scale_up tiene buen resultado pero duplicate_adset no, ajusta.
- Si un ad set específico respondió MAL a un scale_up tuyo, NO lo escales de nuevo pronto.
- Si move_budget de un source a un target funciono bien, repite ese patrón con ad sets similares.
- Tu promedio de delta ROAS te dice si estas MEJORANDO o EMPEORANDO la cuenta. Actua en consecuencia.

MAXIMO 8 recomendaciones — prioriza las mas impactantes.
Para move_budget: recommended_value = monto a MOVER (no el budget final). SIEMPRE incluye summary.`;
  }

  buildUserPrompt(sharedData) {
    const { accountOverview, adSetSnapshots } = sharedData;

    const totalBudget = adSetSnapshots
      .filter(s => s.status === 'ACTIVE')
      .reduce((sum, s) => sum + (s.daily_budget || 0), 0);

    const adSetData = adSetSnapshots.map(s => ({
      id: s.entity_id,
      name: s.entity_name,
      status: s.status,
      daily_budget: s.daily_budget,
      roas_7d: s.metrics?.last_7d?.roas || 0,
      roas_3d: s.metrics?.last_3d?.roas || 0,
      roas_14d: s.metrics?.last_14d?.roas || 0,
      roas_30d: s.metrics?.last_30d?.roas || 0,
      cpa_7d: s.metrics?.last_7d?.cpa || 0,
      spend_7d: s.metrics?.last_7d?.spend || 0,
      spend_14d: s.metrics?.last_14d?.spend || 0,
      purchases_7d: s.metrics?.last_7d?.purchases || 0,
      revenue_7d: s.metrics?.last_7d?.purchase_value || 0,
      frequency_7d: s.metrics?.last_7d?.frequency || 0,
      trend: s.analysis?.roas_trend || 'stable'
    }));

    // Ordenar por ROAS 7d para que Claude vea winners primero
    adSetData.sort((a, b) => b.roas_7d - a.roas_7d);

    return `ROAS CUENTA 7d: ${accountOverview.roas_7d.toFixed(2)}x | 14d: ${(accountOverview.roas_14d || 0).toFixed(2)}x
GASTO DIARIO TOTAL: $${totalBudget.toFixed(2)} | TECHO: $${safetyGuards.budget_ceiling_daily}
ESPACIO DISPONIBLE: $${(safetyGuards.budget_ceiling_daily - totalBudget).toFixed(2)}
AD SETS ACTIVOS: ${accountOverview.active_adsets} | PAUSADOS: ${accountOverview.paused_adsets}
OBJETIVO ROAS: ${kpiTargets.roas_target}x | EXCELENTE: ${kpiTargets.roas_excellent}x

AD SETS (ordenados por ROAS 7d, mejores primero):
${JSON.stringify(adSetData, null, 2)}

Analiza oportunidades de escalamiento. Identifica winners para subir budget o duplicar, losers para redistribuir presupuesto, y oportunidades de escalado horizontal.${this._buildLearningPhaseProtection(sharedData)}${this._buildRecentActionsContext(sharedData)}${this._buildImpactFeedbackContext(sharedData)}${this._buildAICreationsContext(sharedData)}`;
  }

  getResearchContext(sharedData) {
    const { accountOverview, adSetSnapshots } = sharedData;
    const activeAdSets = (adSetSnapshots || []).filter(s => s.status === 'ACTIVE');
    const avgRoas = activeAdSets.length > 0
      ? activeAdSets.reduce((sum, s) => sum + (s.metrics?.last_7d?.roas || 0), 0) / activeAdSets.length
      : 0;

    return {
      scaling_opportunity: avgRoas > kpiTargets.roas_target,
      low_roas: accountOverview?.roas_7d < kpiTargets.roas_minimum
    };
  }
}

module.exports = ScalingAgent;
