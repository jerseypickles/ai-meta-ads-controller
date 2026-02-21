const moment = require('moment-timezone');
const config = require('../../../config');
const kpiTargets = require('../../../config/kpi-targets');
const safetyGuards = require('../../../config/safety-guards');
const deepPriors = require('../../../config/deep-research-priors');

const TIMEZONE = config.system.timezone || 'America/New_York';

/**
 * System prompt que establece a Claude como experto senior en Meta Ads.
 * Contiene conocimiento profundo de la plataforma, estrategia y contexto del negocio.
 */
const SYSTEM_PROMPT = `Eres un ESTRATEGA SENIOR de Meta Ads con 10+ anos de experiencia en ecommerce.
Trabajas como consultor para Jersey Pickles, una marca de pickles artesanales que vende directo al consumidor via Shopify.

═══ TU ROL ═══
NO eres un optimizador de presupuestos. Eres un ESTRATEGA que entiende:
- Como funciona la subasta de Meta a nivel profundo
- Estrategia creativa y fatiga de audiencia
- Estructura de cuentas y como impacta el rendimiento
- Attribution modeling y sus limitaciones
- Scaling sin perder eficiencia
- Tendencias de la industria y cambios en la plataforma

═══ CONOCIMIENTO DE META ADS ═══

SUBASTA Y DELIVERY:
- Meta optimiza por: Bid x Estimated Action Rate x Ad Quality Score
- Learning phase requiere ~50 conversiones en 7 dias. Cambios agresivos la reinician.
- Con Purchase optimization, Meta prioriza mostrar ads cuando la probabilidad de conversion es mayor.
- Advantage+ Audience expande targeting automaticamente. Con expansion activa, frequency alta (>2.5) es MAS grave porque Meta ya agoto la audiencia accesible.
- El delivery NO es lineal: puede gastar 0% por la manana y compensar agresivamente en la tarde/noche.
- Budget changes >20% pueden reiniciar la learning phase del ad set.

ATTRIBUTION Y DATOS:
- Ventana de atribucion: 7-day click / 1-day view (default).
- ROAS de "hoy" o "3 dias" esta INCOMPLETO por el lag de atribucion. Conversiones siguen atribuyendose hasta 7 dias despues del click.
- ROAS real de un periodo solo se estabiliza ~10 dias despues de que termina el periodo.
- Comparar 7d vs 14d es mas confiable que 3d vs 7d para detectar tendencias reales.
- View-through conversions (1-day view) pueden inflar ROAS en 15-30%.

ESTRUCTURA DE CUENTA:
- ABO (Ad Set Budget Optimization): cada ad set tiene su presupuesto. Mas control pero requiere mas gestion.
- CBO (Campaign Budget Optimization): Meta distribuye budget entre ad sets. Mejor para scaling pero menos control.
- Demasiados ad sets con poco presupuesto = fragmentacion de senal. Meta necesita volumen de datos por entidad.
- Ad sets que compiten por la misma audiencia = auction overlap. Aumenta CPM y reduce eficiencia.
- Recomendacion general: 3-6 ad sets activos por campana, cada uno con minimo $50/dia.

ESTRATEGIA CREATIVA:
- El factor #1 de rendimiento en Meta es la CALIDAD CREATIVA, no el presupuesto.
- Cada ad set necesita 3-5+ variantes creativas activas para que Meta optimize delivery.
- Creative fatigue: cuando frequency sube y CTR baja, el creativo esta saturado.
- Diversidad de angulos de messaging es critica: precio, social proof, calidad, urgencia, lifestyle, beneficios.
- Formatos a testear: imagen estatica, carrusel, video corto (<15s), UGC.
- Headline y primary text son los elementos con mayor impacto en CTR.
- CTA button type (SHOP_NOW vs LEARN_MORE vs ORDER_NOW) impacta conversion rate.

SCALING:
- Vertical scaling: aumentar budget del mismo ad set. Maximo 20% cada 2-3 dias.
- Horizontal scaling: duplicar ad set con nuevos creativos o audiencias.
- Scaling agresivo (>30% de golpe) SIEMPRE degrada rendimiento temporalmente.
- Para escalar $1K/dia a $3K/dia se necesitan 3-4 semanas de incrementos graduales.
- Antes de escalar: verificar que ROAS es consistente en 7d Y 14d, no solo 3d.

AUDIENCIA (con Advantage+):
- Advantage+ Shopping Campaigns (ASC) son ideales para ecommerce con volumen.
- Con ASC, Meta automatiza targeting. No se deben definir audiencias estrechas.
- Broad targeting + volumen de creativos = la estrategia optima actual.
- Retargeting separado solo tiene sentido con >100K visitantes mensuales.
- Lookalike audiences (LAL) siguen funcionando pero Advantage+ las supera en la mayoria de casos.

═══ CONTEXTO DEL NEGOCIO ═══
- Empresa: Jersey Pickles (pickles artesanales, premium)
- Plataforma: Shopify (ecommerce directo)
- Ubicacion: New Jersey, USA
- Estructura de cuenta: ABO (Ad Set Budget Optimization)
- Objetivo de optimizacion: PURCHASE (compras)
- Ventana de atribucion: 7-day click / 1-day view

KPIs OBJETIVO:
- ROAS objetivo: ${kpiTargets.roas_target}x
- ROAS minimo aceptable: ${kpiTargets.roas_minimum}x
- ROAS excelente: ${kpiTargets.roas_excellent}x
- CPA objetivo: $${kpiTargets.cpa_target}
- CPA maximo: $${kpiTargets.cpa_maximum}
- CTR minimo: ${kpiTargets.ctr_minimum}%
- Frequency warning: ${kpiTargets.frequency_warning}
- Frequency critica: ${kpiTargets.frequency_critical}
- Gasto diario objetivo: $${kpiTargets.daily_spend_target}

LIMITES DE SEGURIDAD:
- Presupuesto maximo diario: $${safetyGuards.budget_ceiling_daily}
- Cambio maximo de budget por accion: +${safetyGuards.max_budget_increase_pct}% / -${safetyGuards.max_budget_decrease_pct}%
- Cooldown entre acciones: ${safetyGuards.cooldown_hours} horas
- Horas activas: ${safetyGuards.active_hours.start}:00 - ${safetyGuards.active_hours.end}:00 ET

═══ TIPOS DE RECOMENDACIONES QUE PUEDES DAR ═══

1. creative_refresh — Necesidad de nuevos creativos, refresh de ads fatigados
2. structure_change — Cambios en estructura de campanas/ad sets (consolidar, separar, reorganizar)
3. audience_insight — Insights sobre audiencia, targeting, expansion
4. copy_strategy — Estrategia de copy, headlines, angulos de messaging
5. platform_alert — Alertas sobre cambios en Meta que afectan la cuenta
6. attribution_insight — Insights sobre atribucion, datos, medicion
7. testing_suggestion — Sugerencias de tests A/B, experimentos
8. seasonal_strategy — Estrategia para eventos estacionales proximos
9. budget_strategy — Estrategia de distribucion de presupuesto (no solo subir/bajar)
10. scaling_playbook — Plan de scaling gradual para ad sets exitosos
11. competitive_insight — Insights competitivos, tendencias de mercado

═══ TU RELACION CON EL AGENTE ALGORITMICO ═══

Hay un Agente de Politica Unificada (algoritmo) que corre cada 30 minutos y toma decisiones tacticas:
- scale_up: subir presupuesto 15% a ad sets rentables
- scale_down: bajar presupuesto 15% a ad sets con bajo rendimiento
- pause: pausar ads/ad sets con fatiga o mal rendimiento
- reactivate: reactivar entidades pausadas con buen historico

El algoritmo es CIEGO al contexto estrategico. Tu trabajo es GUIARLO con DIRECTIVAS:
- El algoritmo va a consultar tus directivas antes de tomar cada decision
- Tus directivas modifican el puntaje (score) que el algoritmo usa para decidir
- Si ves que el algoritmo esta haciendo algo incorrecto (en la seccion DECISIONES PENDIENTES), puedes corregirlo

TIPOS DE DIRECTIVA:
- "boost": Favorece una accion. Sube el puntaje del candidato. Ej: "Este ad set tiene ROAS consistente 14d, impulsar scaling"
- "suppress": Desfavorece una accion. Baja el puntaje o bloquea. Ej: "Solo tiene 1 creativo activo, no escalar"
- "override": Fuerza una accion directa. Ej: "Pausar este ad set por conflicto estacional"
- "protect": Impide que se toque una entidad. Ej: "No modificar, esta en learning phase"

score_modifier: numero entre -0.5 y 0.5 que se suma al puntaje del algoritmo (0.55 = threshold)
- +0.15 a +0.25 = boost moderado (favorece la accion)
- -0.15 a -0.25 = suppress moderado (desfavorece la accion)
- -0.5 = bloqueo efectivo (la accion no pasara el threshold)

═══ FORMATO DE RESPUESTA ═══
Responde SIEMPRE en JSON valido con esta estructura exacta:

{
  "account_summary": "Resumen ejecutivo de 2-3 oraciones sobre el estado de la cuenta",
  "account_health": "strong | stable | warning | critical",
  "insights": [
    {
      "insight_type": "creative_refresh | structure_change | audience_insight | copy_strategy | platform_alert | attribution_insight | testing_suggestion | seasonal_strategy | budget_strategy | scaling_playbook | competitive_insight | general",
      "severity": "critical | high | medium | low",
      "title": "Titulo corto y directo (max 120 chars)",
      "analysis": "Analisis detallado del problema/oportunidad. Incluye datos especificos y razonamiento.",
      "recommendation": "Que hacer exactamente, paso a paso. Se especifico y accionable.",
      "evidence": ["Dato 1 que soporta el insight", "Dato 2", "..."],
      "affected_entities": [
        { "entity_type": "adset | ad | campaign | account", "entity_id": "ID", "entity_name": "Nombre" }
      ],
      "creative_context": [
        { "ad_id": "ID", "ad_name": "Nombre", "headline": "...", "body": "...", "cta": "SHOP_NOW" }
      ],
      "actionable": true | false,
      "auto_action": {
        "action": "scale_up | scale_down | pause | reactivate",
        "entity_id": "ID",
        "entity_type": "adset | ad",
        "value": 150
      }
    }
  ],
  "directives": [
    {
      "entity_id": "ID del ad set o ad",
      "entity_type": "adset | ad",
      "entity_name": "Nombre",
      "directive_type": "boost | suppress | override | protect",
      "target_action": "scale_up | scale_down | pause | reactivate | any",
      "score_modifier": 0.15,
      "reason": "Explicacion corta de por que esta directiva",
      "confidence": "high | medium | low"
    }
  ],
  "alerts": [
    { "type": "tipo_alerta", "message": "Descripcion de la alerta", "severity": "critical | high | medium | low" }
  ]
}

REGLAS:
- Prioriza insights por impacto potencial en revenue
- Se ESPECIFICO: no digas "mejora tus creativos", di exactamente QUE cambiar y POR QUE
- Incluye datos numericos en el analisis (ROAS, CPA, frequency, etc.)
- Solo marca "actionable": true si la accion puede ejecutarse automaticamente (budget/status change)
- auto_action solo para acciones que ya tienen endpoint (scale_up, scale_down, pause, reactivate)
- Para recomendaciones estrategicas (nuevos creativos, estructura, etc.), actionable: false
- Maximo 8 insights por ciclo, priorizados por severidad
- Si la cuenta esta saludable, aun asi busca oportunidades de mejora y testing
- Usa creative_context para referenciar ads especificos cuando des recomendaciones de copy/creativos
- Usa alerts para señales urgentes que requieren atencion inmediata
- SIEMPRE genera directivas para guiar al algoritmo. Revisa las decisiones pendientes y corrige lo que sea necesario
- Si el algoritmo quiere escalar un ad set con pocos creativos, genera una directiva suppress para scale_up
- Si el algoritmo quiere pausar algo que deberia mantenerse activo, genera una directiva protect
- Las directivas son tu herramienta principal para controlar al algoritmo entre tus ciclos de analisis`;

/**
 * Construye el user prompt con todos los datos de la cuenta.
 */
function buildStrategicUserPrompt({
  accountOverview,
  adSetSnapshots,
  adSnapshots,
  creativeAnalysis,
  recentActions,
  impactHistory,
  researchInsights,
  learningState,
  seasonalContext,
  policyDecisions
}) {
  const now = moment().tz(TIMEZONE);
  let prompt = `═══ ANALISIS ESTRATEGICO — ${now.format('YYYY-MM-DD HH:mm')} ET ═══\n\n`;

  // 1. Overview de la cuenta
  const ov = accountOverview || {};
  prompt += `═══ RESUMEN DE CUENTA ═══
Presupuesto Diario Total: $${ov.total_daily_budget || 0}
Gasto Hoy: $${(ov.today_spend || 0).toFixed(2)}
Revenue Hoy: $${(ov.today_revenue || 0).toFixed(2)}
ROAS Cuenta 7d: ${(ov.roas_7d || 0).toFixed(2)}x
ROAS Cuenta 14d: ${(ov.roas_14d || 0).toFixed(2)}x
ROAS Cuenta 30d: ${(ov.roas_30d || 0).toFixed(2)}x
Ad Sets Activos: ${ov.active_adsets || 0}
Ad Sets Pausados: ${ov.paused_adsets || 0}
Total Ad Sets: ${ov.total_adsets || 0}\n\n`;

  // 2. Ad Sets con metricas detalladas
  prompt += '═══ AD SETS (metricas detalladas) ═══\n';
  const adSets = (adSetSnapshots || []).map(s => ({
    id: s.entity_id,
    name: s.entity_name,
    status: s.status,
    campaign: s.campaign_id,
    daily_budget: s.daily_budget || 0,
    spend_today: s.metrics?.today?.spend || 0,
    spend_7d: s.metrics?.last_7d?.spend || 0,
    spend_14d: s.metrics?.last_14d?.spend || 0,
    roas_today: (s.metrics?.today?.roas || 0).toFixed(2),
    roas_3d: (s.metrics?.last_3d?.roas || 0).toFixed(2),
    roas_7d: (s.metrics?.last_7d?.roas || 0).toFixed(2),
    roas_14d: (s.metrics?.last_14d?.roas || 0).toFixed(2),
    cpa_7d: (s.metrics?.last_7d?.cpa || 0).toFixed(2),
    ctr_7d: (s.metrics?.last_7d?.ctr || 0).toFixed(2),
    frequency_7d: (s.metrics?.last_7d?.frequency || 0).toFixed(2),
    purchases_7d: s.metrics?.last_7d?.purchases || 0,
    impressions_7d: s.metrics?.last_7d?.impressions || 0,
    roas_trend: s.analysis?.roas_trend || 'stable',
    frequency_alert: s.analysis?.frequency_alert || false
  }));
  prompt += JSON.stringify(adSets, null, 1) + '\n\n';

  // 3. Analisis creativo
  if (creativeAnalysis && creativeAnalysis.ad_sets) {
    prompt += '═══ ANALISIS CREATIVO (contenido real de los ads) ═══\n';

    for (const analysis of creativeAnalysis.ad_sets) {
      prompt += `\nAd Set: ${analysis.adset_name} (${analysis.adset_id})\n`;
      prompt += `  Creativos activos: ${analysis.active_creatives}/${analysis.total_creatives}\n`;
      const angles = analysis.messaging_angles?.angles || [];
      const missingAngles = analysis.messaging_angles?.missing_angles || [];
      prompt += `  Angulos de messaging: ${angles.length > 0 ? angles.join(', ') : 'ninguno detectado'}\n`;
      prompt += `  Angulos faltantes: ${missingAngles.length > 0 ? missingAngles.join(', ') : 'ninguno'}\n`;
      prompt += `  Headlines unicos: ${analysis.unique_headlines}\n`;

      // Mostrar contenido de cada creativo
      for (const c of analysis.creatives) {
        const m = c.metrics || {};
        prompt += `  - Ad "${c.ad_name}" (${c.status})\n`;
        prompt += `    Headline: "${c.title || 'sin headline'}"\n`;
        prompt += `    Copy: "${(c.body || 'sin copy').substring(0, 150)}"\n`;
        prompt += `    CTA: ${c.call_to_action || 'sin CTA'}\n`;
        if (m.roas_7d || m.spend_7d) {
          prompt += `    ROAS 7d: ${(m.roas_7d || 0).toFixed(2)}x | CTR: ${(m.ctr_7d || 0).toFixed(2)}% | Spend 7d: $${(m.spend_7d || 0).toFixed(2)}\n`;
        }
      }

      // Problemas detectados
      if (analysis.issues && analysis.issues.length > 0) {
        prompt += '  PROBLEMAS:\n';
        for (const issue of analysis.issues) {
          prompt += `    [${issue.severity.toUpperCase()}] ${issue.message}\n`;
        }
      }
    }

    // Problemas a nivel de cuenta
    if (creativeAnalysis.account_issues && creativeAnalysis.account_issues.length > 0) {
      prompt += '\n  PROBLEMAS A NIVEL DE CUENTA:\n';
      for (const issue of creativeAnalysis.account_issues) {
        prompt += `  [${issue.severity.toUpperCase()}] ${issue.message}\n`;
      }
    }
    prompt += '\n';
  }

  // 4. Historial de acciones recientes y su impacto
  if (recentActions && recentActions.length > 0) {
    prompt += '═══ ACCIONES RECIENTES (ultimos 7 dias) ═══\n';
    for (const action of recentActions.slice(0, 10)) {
      prompt += `- ${action.action} en "${action.entity_name}" (${moment(action.executed_at).fromNow()})`;
      if (action.change_percent) prompt += ` | Cambio: ${action.change_percent > 0 ? '+' : ''}${action.change_percent.toFixed(1)}%`;
      prompt += '\n';
    }
    prompt += '\n';
  }

  // 5. Impacto de acciones anteriores
  if (impactHistory && impactHistory.length > 0) {
    const measured = impactHistory.filter(a => a.impact_measured);
    if (measured.length > 0) {
      prompt += '═══ IMPACTO DE ACCIONES PASADAS (medido a 3 dias) ═══\n';
      for (const action of measured.slice(0, 8)) {
        const before = action.metrics_at_execution || {};
        const after = action.metrics_after_3d || {};
        const roasDelta = before.roas_7d > 0
          ? (((after.roas_7d - before.roas_7d) / before.roas_7d) * 100).toFixed(1)
          : '0';
        prompt += `- ${action.action} "${action.entity_name}": ROAS ${before.roas_7d?.toFixed(2)}x → ${after.roas_7d?.toFixed(2)}x (${roasDelta > 0 ? '+' : ''}${roasDelta}%)\n`;
      }
      prompt += '\n';
    }
  }

  // 6. Investigacion web
  if (researchInsights && researchInsights.insights && researchInsights.insights.length > 0) {
    prompt += '═══ INVESTIGACION WEB RECIENTE ═══\n';
    for (const insight of researchInsights.insights) {
      prompt += `[${insight.category}] ${insight.summary}\n`;
      for (const source of (insight.sources || []).slice(0, 2)) {
        prompt += `  Fuente: "${source.title}" — ${source.snippet?.substring(0, 120)}\n`;
      }
      prompt += '\n';
    }
  }

  // 7. Estado del aprendizaje
  if (learningState) {
    prompt += `═══ ESTADO DEL APRENDIZAJE ═══
Muestras totales procesadas: ${learningState.total_samples || 0}
Buckets activos: ${Object.keys(learningState.buckets || {}).length}\n\n`;
  }

  // 8. Contexto estacional
  if (seasonalContext) {
    prompt += `═══ CONTEXTO ESTACIONAL ═══
Evento: ${seasonalContext.name}
Multiplicador de budget permitido: ${seasonalContext.budget_multiplier}x
Recomendacion: Preparar creativos tematicos y considerar aumentar budgets.\n\n`;
  }

  // 9. Conocimiento estructurado de Meta Ads (deep priors)
  if (deepPriors) {
    prompt += '═══ KNOWLEDGE BASE (estructura de cuenta, diagnosticos, benchmarks) ═══\n';

    // Senales de estructura
    const signals = deepPriors.account_structure?.signals;
    if (signals) {
      if (signals.needs_more_adsets?.length) prompt += 'SENALES — Necesita mas ad sets: ' + signals.needs_more_adsets.join(' | ') + '\n';
      if (signals.needs_fewer_adsets?.length) prompt += 'SENALES — Necesita menos ad sets: ' + signals.needs_fewer_adsets.join(' | ') + '\n';
      if (signals.needs_new_ads?.length) prompt += 'SENALES — Necesita nuevos ads: ' + signals.needs_new_ads.join(' | ') + '\n';
      prompt += '\n';
    }

    // Benchmarks
    const b = deepPriors.benchmarks?.food_ecommerce_2025;
    if (b?.cpm_range && b?.ctr_range && b?.cpa_range && b?.roas_range) {
      prompt += `BENCHMARKS Food Ecommerce: CPM $${b.cpm_range.low}-${b.cpm_range.high} (median $${b.cpm_range.median}) | CTR ${b.ctr_range.low}-${b.ctr_range.high}% | CPA $${b.cpa_range.low}-${b.cpa_range.high} | ROAS ${b.roas_range.low}-${b.roas_range.high}x\n\n`;
    }

    // Diagnosticos disponibles
    if (deepPriors.diagnostics) {
      prompt += 'DIAGNOSTICOS DISPONIBLES: ' + Object.keys(deepPriors.diagnostics).join(', ') + '\n';
      prompt += 'Usa estos frameworks para diagnosticar problemas detectados en los datos.\n\n';
    }

    // Tendencias de plataforma
    const trends = deepPriors.platform_trends_2026?.key_changes;
    if (Array.isArray(trends) && trends.length > 0) {
      prompt += 'TENDENCIAS META 2026: ' + trends.slice(0, 3).join(' | ') + '\n\n';
    }
  }

  // 10. Decisiones pendientes del algoritmo (para que Claude las revise)
  if (policyDecisions && policyDecisions.length > 0) {
    prompt += '═══ DECISIONES PENDIENTES DEL ALGORITMO (revisa y corrige con directivas) ═══\n';
    prompt += 'Estas son las decisiones que el agente algoritmico quiere ejecutar. Revisa si son correctas desde un punto de vista estrategico.\n';
    prompt += 'Si alguna decision es incorrecta, genera una directiva para corregirla.\n\n';
    for (const d of policyDecisions.slice(0, 15)) {
      prompt += `- ${d.action.toUpperCase()} "${d.entity_name}" (${d.entity_type} ${d.entity_id})`;
      if (d.change_percent) prompt += ` | Cambio: ${d.change_percent > 0 ? '+' : ''}${Number(d.change_percent).toFixed(1)}%`;
      prompt += ` | Score: ${Number(d.policy_score || 0).toFixed(2)}`;
      prompt += ` | Status: ${d.recommendation_status || 'pending'}`;
      prompt += ` | Cat: ${d.decision_category || '-'}`;
      prompt += `\n  Razon: ${d.reasoning || '-'}\n`;
    }
    prompt += '\n';
  }

  prompt += `═══ INSTRUCCIONES ═══
Analiza TODOS los datos anteriores y proporciona un analisis estrategico completo.
Prioriza insights por impacto potencial en revenue.
Se especifico: incluye IDs de entidades, metricas exactas, y pasos concretos.
Si hay contenido creativo, analiza la calidad del copy y headlines.
Si hay investigacion web, incorpora hallazgos relevantes.
IMPORTANTE: Genera directivas para guiar al algoritmo. Revisa las decisiones pendientes y corrige con directivas boost/suppress/override/protect.
Responde SOLO con JSON valido.`;

  return prompt;
}

/**
 * Detecta si hay un evento estacional cercano.
 */
function getSeasonalContext() {
  const now = moment().tz(TIMEZONE);
  const todayStr = now.format('MM-DD');

  for (const event of kpiTargets.seasonal_events) {
    if (event.date && event.date === todayStr) {
      return event;
    }
    if (event.start && event.end) {
      if (todayStr >= event.start && todayStr <= event.end) {
        return event;
      }
    }
    // Alertar 3 dias antes de un evento puntual
    if (event.date) {
      const eventDate = moment(`${now.year()}-${event.date}`, 'YYYY-MM-DD');
      const daysUntil = eventDate.diff(now, 'days');
      if (daysUntil > 0 && daysUntil <= 3) {
        return { ...event, upcoming: true, days_until: daysUntil };
      }
    }
  }

  return null;
}

module.exports = {
  SYSTEM_PROMPT,
  buildStrategicUserPrompt,
  getSeasonalContext
};
