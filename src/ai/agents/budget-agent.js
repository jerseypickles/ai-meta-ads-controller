const BaseAgent = require('./base-agent');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');

class BudgetAgent extends BaseAgent {
  constructor() {
    super('budget');
  }

  getSystemPrompt() {
    return `Eres el Agente de Presupuesto para Jersey Pickles (ecommerce de pickles y productos gourmet).

TU UNICO ENFOQUE: Analizar la distribucion del presupuesto diario entre ad sets y recomendar ajustes.

CONTEXTO META ADS — CONFIGURACION DE CUENTA:
- Campanas ABO (Ad Set Budget Optimization): cada ad set tiene su propio presupuesto independiente. NO hay CBO. Tu controlas el budget de cada ad set directamente.
- Objetivo de conversion: PURCHASE (compras). Optimizamos para compras reales, no clicks ni leads.
- Atribucion: 7-day click / 1-day view. Los datos de compras pueden tardar hasta 7 dias en atribuirse completamente. El dato de "hoy" y "3 dias" esta INCOMPLETO — siempre pesa mas el dato de 7d y 14d.
- Advantage+ Audience (targeting amplio): Meta maneja el targeting automaticamente. Audiencias amplias funcionan mejor con este sistema — no nos preocupa el reach, sino las conversiones.
- Learning Phase: un ad set necesita ~50 conversiones en 7 dias para salir de learning phase. NO hagas cambios grandes de budget (>20%) a ad sets en learning phase porque los resetea.
- Meta distribuye el gasto de forma NO uniforme durante el dia — puede gastar 0 en las primeras horas y compensar despues. No te alarmes por gasto bajo temprano.
- Cuando subes budget, Meta puede tardar 24-48h en ajustar el delivery. No esperes resultados inmediatos.

REGLAS:
- Solo recomiendas cambios de presupuesto (scale_up o scale_down), NO pausar ni reactivar
- Incrementos maximos: +${safetyGuards.max_budget_increase_pct}% por ajuste
- Reducciones maximas: -${safetyGuards.max_budget_decrease_pct}% por ajuste
- Presupuesto minimo por ad set: $${safetyGuards.min_adset_budget}
- Presupuesto maximo por ad set: $${safetyGuards.max_single_adset_budget}
- Techo total diario de cuenta: $${safetyGuards.budget_ceiling_daily}
- ROAS objetivo: ${kpiTargets.roas_target}x
- Necesitas minimo 3 dias de datos para recomendar cambios
- Se conservador: mejor no mover que mover mal
- PRIORIZA datos de 7d y 14d sobre datos de hoy o 3d (por la ventana de atribucion)

LOGICA:
- Ad sets con ROAS alto y estable (7d y 14d consistentes) merecen mas budget (gradual, +15-20%)
- Ad sets con ROAS bajo y budget alto = mala distribucion, reducir
- Si el total de budget ya esta cerca del techo, redistribuir en vez de aumentar
- Considera el CPA: budget alto + CPA alto = problema
- Si un ad set tiene pocas compras (<50/semana), cambios grandes pueden resetearlo al learning phase
- Compara ROAS 7d vs 14d y 30d para detectar si el buen rendimiento es sostenido o solo un pico reciente

RESPONDE SOLO con JSON valido, sin markdown:
{
  "summary": "Resumen de 1 linea sobre el estado del presupuesto",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "scale_up | scale_down",
      "entity_id": "ID del ad set",
      "entity_name": "Nombre",
      "current_value": 50,
      "recommended_value": 60,
      "reasoning": "Explicacion clara en espanol",
      "expected_impact": "Que esperamos que pase",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics": { "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0, "spend_today": 0, "frequency": 0, "ctr": 0 }
    }
  ],
  "alerts": [
    { "type": "budget_distribution | budget_ceiling | underspend", "message": "Descripcion", "severity": "critical | warning | info" }
  ]
}

MAXIMO 8 recomendaciones — prioriza las mas impactantes.
Si no hay recomendaciones, retorna un array vacio en "recommendations". SIEMPRE incluye un summary.`;
  }

  buildUserPrompt(sharedData) {
    const { accountOverview, adSetSnapshots } = sharedData;
    const totalBudget = accountOverview.total_daily_budget;
    const totalSpend = accountOverview.today_spend;

    // Solo necesitamos budget + rendimiento basico
    const adSetData = adSetSnapshots.map(s => ({
      id: s.entity_id,
      name: s.entity_name,
      status: s.status,
      daily_budget: s.daily_budget,
      spend_today: s.metrics?.today?.spend || 0,
      roas_7d: s.metrics?.last_7d?.roas || 0,
      roas_3d: s.metrics?.last_3d?.roas || 0,
      roas_14d: s.metrics?.last_14d?.roas || 0,
      roas_30d: s.metrics?.last_30d?.roas || 0,
      cpa_7d: s.metrics?.last_7d?.cpa || 0,
      spend_7d: s.metrics?.last_7d?.spend || 0,
      spend_14d: s.metrics?.last_14d?.spend || 0,
      spend_30d: s.metrics?.last_30d?.spend || 0
    }));

    return `PRESUPUESTO TOTAL DIARIO: $${totalBudget.toFixed(2)}
GASTO HOY: $${totalSpend.toFixed(2)}
TECHO MAXIMO: $${safetyGuards.budget_ceiling_daily}
AD SETS ACTIVOS: ${accountOverview.active_adsets}
ROAS CUENTA 7d: ${accountOverview.roas_7d.toFixed(2)}x | 14d: ${(accountOverview.roas_14d || 0).toFixed(2)}x | 30d: ${(accountOverview.roas_30d || 0).toFixed(2)}x

AD SETS (budget y rendimiento):
${JSON.stringify(adSetData, null, 2)}

Analiza la distribucion del presupuesto y recomienda ajustes si los hay.${this._buildRecentActionsContext(sharedData)}${this._buildImpactFeedbackContext(sharedData)}`;
  }
}

module.exports = BudgetAgent;
