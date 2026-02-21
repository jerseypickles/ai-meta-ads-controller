const BaseAgent = require('./base-agent');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');
const moment = require('moment-timezone');
const config = require('../../../config');

class PacingAgent extends BaseAgent {
  constructor() {
    super('pacing');
  }

  getSystemPrompt() {
    return `Eres el Agente de Pacing (Ritmo de Gasto) para Jersey Pickles (ecommerce de pickles y productos gourmet).

TU UNICO ENFOQUE: Analizar si la cuenta y cada ad set estan gastando al ritmo correcto para el dia. Detectar underpacing (muy lento) y overpacing (muy rapido). Tambien puedes redistribuir presupuesto entre ad sets.

CONTEXTO META ADS — COMO FUNCIONA EL DELIVERY:
- Campanas ABO: cada ad set tiene su propio presupuesto diario. Meta intenta gastar el 100% del budget diario de cada ad set para el final del dia.
- IMPORTANTE: Meta NO gasta de forma uniforme durante el dia. El algoritmo de Meta puede gastar muy poco en las primeras horas y compensar fuertemente en las ultimas horas. Esto es NORMAL con Advantage+ Audience.
- Meta usa un sistema de "accelerated" vs "standard" delivery. Con standard (default), Meta distribuye el gasto para maximizar conversiones durante todo el dia, lo que puede significar pacing bajo temprano.
- Advantage+ Audience amplifica este efecto: Meta espera a encontrar los mejores momentos para mostrar ads basado en cuando sus usuarios Purchase-optimized son mas activos.
- Conversion Purchase: Meta prioriza mostrar ads cuando hay mas probabilidad de compra, NO uniformemente. Las tardes/noches pueden tener mucho mas gasto que las mananas.
- Un ad set con pacing de 30% a las 12pm puede terminar el dia al 95% — Meta compensa. NO entres en panico temprano.
- Un ad set con pacing de 0% (sin gasto) SI es un problema de delivery — puede ser creative rechazado, audiencia agotada, o budget muy bajo.

ACCIONES QUE PUEDES RECOMENDAR:
1. "scale_up" — Subir budget si underpacing con buen ROAS (Meta encontrara audiencia).
2. "scale_down" — Bajar budget si overpacing con mal ROAS.
3. "move_budget" — Redistribuir dinero de un ad set con underpacing/mal ROAS a uno con buen pacing y ROAS. Requiere target_entity_id y target_entity_name. recommended_value = monto a MOVER.

REGLAS:
- Objetivo de gasto diario: $${kpiTargets.daily_spend_target}
- Rango aceptable de pacing: ${kpiTargets.underpacing_threshold * 100}% - ${kpiTargets.overpacing_threshold * 100}%
- El pacing se calcula: (gasto actual / gasto esperado a esta hora) * 100
- Gasto esperado LINEAL = (budget diario * horas transcurridas / 24). PERO Meta NO gasta linealmente — usa esto como referencia, no como verdad absoluta.
- NO recomendes cambios antes de las 10am — los datos de la manana son muy parciales con el delivery de Meta
- Despues de las 3pm, el pacing es MAS confiable como indicador
- Para move_budget: el ad set source no puede quedar debajo de $${safetyGuards.min_adset_budget}

LOGICA DE PACING:
1. Pacing < 50% a las 3pm+ = underpacing real, la cuenta probablemente no va a gastar el budget
2. Pacing > 130% a las 3pm+ = overpacing real, puede agotar budget
3. Ad sets con pacing 0% (sin gasto) a cualquier hora = problema de delivery real
4. Ad sets con pacing > 150% despues de mediadia = gastando demasiado rapido
5. Si underpacing + buen ROAS 7d = oportunidad de subir budget (Meta encontrara audiencia)
6. Si overpacing + mal ROAS 7d = urgente reducir
7. Antes de las 2pm, se MUY conservador — Meta compensa naturalmente
8. Si un ad set con underpacing tiene mal ROAS Y otro con overpacing tiene buen ROAS = move_budget del malo al bueno

RESPONDE SOLO con JSON valido, sin markdown:
{
  "summary": "Resumen de 1 linea sobre pacing de la cuenta",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "scale_up | scale_down | move_budget",
      "entity_type": "adset",
      "entity_id": "ID",
      "entity_name": "Nombre",
      "current_value": 100,
      "recommended_value": 120,
      "target_entity_id": "ID destino (solo para move_budget)",
      "target_entity_name": "Nombre destino (solo para move_budget)",
      "reasoning": "Explicacion clara en espanol",
      "expected_impact": "Que esperamos que pase",
      "confidence": "high | medium | low",
      "priority": "critical | high | medium | low",
      "metrics": { "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0, "spend_today": 0, "frequency": 0, "ctr": 0 }
    }
  ],
  "alerts": [
    { "type": "underpacing | overpacing | delivery_issue | redistribution", "message": "Descripcion", "severity": "critical | warning | info" }
  ]
}

FEEDBACK LOOP — APRENDE DE TUS ERRORES Y EXITOS:
Recibiras un bloque "FEEDBACK LOOP" con el historial de TUS acciones pasadas y sus resultados MEDIDOS.
- Si moviste budget de un ad set a otro y MEJORO la cuenta, repite ese patron.
- Si subiste budget por underpacing y el ROAS EMPEORO, quizas el pacing bajo era por falta de audiencia — se mas cauto.
- Si bajaste budget por overpacing y MEJORO el CPA, esa es una senal buena.
- Tu promedio de delta ROAS te dice si tus ajustes de pacing ayudan o perjudican. Si es negativo, se MAS conservador.

Para move_budget: recommended_value = monto a MOVER (no el budget final).
Si el pacing esta saludable, retorna array vacio en recommendations. SIEMPRE incluye summary.`;
  }

  buildUserPrompt(sharedData) {
    const { accountOverview, adSetSnapshots } = sharedData;
    const now = moment().tz(config.system.timezone);
    const hoursElapsed = now.hours() + (now.minutes() / 60);
    const expectedAccountSpend = kpiTargets.daily_spend_target * (hoursElapsed / 24);
    const accountPacing = expectedAccountSpend > 0
      ? ((accountOverview.today_spend / expectedAccountSpend) * 100).toFixed(1)
      : 0;

    const totalBudget = adSetSnapshots
      .filter(s => s.status === 'ACTIVE')
      .reduce((sum, s) => sum + (s.daily_budget || 0), 0);

    // Pacing por ad set
    const adSetData = adSetSnapshots
      .filter(s => s.status === 'ACTIVE')
      .map(s => {
        const budget = s.daily_budget || 0;
        const spendToday = s.metrics?.today?.spend || 0;
        const expectedSpend = budget * (hoursElapsed / 24);
        const pacing = expectedSpend > 0 ? ((spendToday / expectedSpend) * 100).toFixed(1) : 0;

        return {
          id: s.entity_id,
          name: s.entity_name,
          daily_budget: budget,
          spend_today: spendToday,
          pacing_pct: parseFloat(pacing),
          expected_spend: parseFloat(expectedSpend.toFixed(2)),
          roas_7d: s.metrics?.last_7d?.roas || 0,
          roas_3d: s.metrics?.last_3d?.roas || 0,
          cpa_7d: s.metrics?.last_7d?.cpa || 0
        };
      });

    // Ordenar por pacing para que Claude vea los extremos
    adSetData.sort((a, b) => a.pacing_pct - b.pacing_pct);

    return `HORA ACTUAL: ${now.format('HH:mm')} ET (${hoursElapsed.toFixed(1)} horas transcurridas)
OBJETIVO GASTO DIARIO: $${kpiTargets.daily_spend_target}
GASTO HOY: $${accountOverview.today_spend.toFixed(2)}
GASTO ESPERADO A ESTA HORA: $${expectedAccountSpend.toFixed(2)}
PACING CUENTA: ${accountPacing}%
BUDGET TOTAL ACTIVO: $${totalBudget.toFixed(2)}
BUDGET MINIMO POR AD SET: $${safetyGuards.min_adset_budget}

AD SETS ACTIVOS (ordenados por pacing, menor primero):
${JSON.stringify(adSetData, null, 2)}

Analiza el ritmo de gasto de la cuenta y cada ad set. Identifica problemas de delivery, ad sets que gastan demasiado rapido/lento, y oportunidades de redistribuir presupuesto entre ad sets.${this._buildLearningPhaseProtection(sharedData)}${this._buildRecentActionsContext(sharedData)}${this._buildImpactFeedbackContext(sharedData)}`;
  }

  getResearchContext(sharedData) {
    const { accountOverview } = sharedData;
    const expectedSpend = kpiTargets.daily_spend_target;
    const currentPacing = expectedSpend > 0
      ? (accountOverview?.today_spend || 0) / expectedSpend
      : 0;

    return {
      severe_underpacing: currentPacing < 0.3,
      severe_overpacing: currentPacing > 1.5
    };
  }
}

module.exports = PacingAgent;
