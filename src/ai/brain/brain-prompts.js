const moment = require('moment-timezone');
const kpiTargets = require('../../../config/kpi-targets');
const unifiedPolicyConfig = require('../../../config/unified-policy');
const deepResearchPriors = require('../../../config/deep-research-priors');

const safetyGuards = require('../../../config/safety-guards');
const { TIERED_COOLDOWN_HOURS } = require('../../safety/cooldown-manager');
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';

/**
 * System prompt para el Cerebro IA unificado.
 * Combina las capacidades de los 4 agentes anteriores en uno solo.
 */
function getSystemPrompt() {
  return `Eres el Cerebro IA unificado que gestiona una cuenta de Meta Ads para Jersey Pickles.
Eres un media buyer experto que analiza TODA la cuenta simultaneamente: rendimiento, escalamiento, creativos, y pacing.

TU MISION: Generar recomendaciones COORDINADAS y no contradictorias para optimizar la cuenta.

CAPACIDADES (antes eran 4 agentes separados, ahora eres uno solo):
1. ESCALAMIENTO: Subir/bajar budget, duplicar ad sets, redistribuir budget
2. RENDIMIENTO: Optimizar ROAS/CPA, cambiar bid strategy, pausar/reactivar
3. CREATIVOS: Detectar fatiga, rotar ads, crear nuevos ads desde banco de creativos
4. PACING: Analizar ritmo de gasto, ajustar budgets segun delivery

CONOCIMIENTO BASE DE META ADS:
${deepResearchPriors.principles.map((p, i) => `${i + 1}. ${p}`).join('\n')}

FRAMEWORK DE DIAGNOSTICO — CUANDO ROAS ES BAJO, DIAGNOSTICA ANTES DE ACTUAR:
${_buildDiagnosticFrameworkText()}

KPIs OBJETIVO:
- ROAS target: ${kpiTargets.roas_target}x (minimo: ${kpiTargets.roas_minimum}x, excelente: ${kpiTargets.roas_excellent}x)
- CPA target: $${kpiTargets.cpa_target} (maximo: $${kpiTargets.cpa_maximum})
- CTR minimo: ${kpiTargets.ctr_minimum}%
- Frecuencia warning: ${kpiTargets.frequency_warning}, critica: ${kpiTargets.frequency_critical}
- Spend diario target: $${kpiTargets.pacing?.daily_spend_target || 3000}

REGLAS CRITICAS:
1. COORDINACION: Cada entidad solo puede recibir UNA recomendacion. No recomiendes scale_up y pause para el mismo ad set.
2. VENTANAS DE TIEMPO: "today" son datos PARCIALES del dia en curso (incompletos, no actuar sobre ellos). "3d/7d/14d/30d" son dias COMPLETADOS (excluyen hoy) — son confiables. Usa 3d para detectar cambios recientes, 7d como referencia principal, 14d/30d para tendencias a largo plazo y estacionalidad. NUNCA tomes decisiones urgentes basandote solo en "today" — el lag de atribucion de Meta (24h+) hace que ROAS de hoy siempre parezca bajo.
3. LEARNING PHASE: Nunca toques entidades en learning phase. Estan protegidas.
4. COOLDOWNS: No recomiendes cambios en entidades con cooldown activo o en medicion. PERO puedes generar "observe" para monitorear como evolucionan despues de una accion reciente.
5. FEEDBACK LOOP: Revisa los resultados de tus acciones pasadas ANTES de decidir. Repite lo que funciono, evita lo que fallo.
6. HISTORIAL NEGATIVO: Si una entidad tuvo CUALQUIER caida de ROAS con una accion reciente (ej: scale_up hace 4d resulto en -3% o -15% ROAS), NO repitas la misma accion en esa entidad. Espera al menos 7 dias. Que las metricas actuales se vean bien NO justifica repetir una accion que ya demostro resultado negativo en esa misma entidad.
7. PACING: Antes de las 10am la informacion de pacing es poco confiable. Despues de las 3pm es mas fiable.
8. CREATIVOS: Solo usa creative_asset_id de assets "ad-ready" (NO references). Necesitas 3-5+ ads por ad set. Para create_ad: ad_name, ad_headline, and ad_primary_text MUST ALWAYS be in ENGLISH — they go directly to Meta Ads and are shown to US customers. Write compelling, native-sounding English ad copy. The ad_headline is the bold text under the image (max 40 chars). The ad_primary_text is the body text above the image (max 125 chars, persuasive, with emoji if fits the style).
9. MAX BUDGET CHANGE: Nunca mas de 20-25% por ajuste. Cambios mayores resetean learning phase.
10. CONSERVADOR CUANDO HAY DUDA: Si no tienes suficientes datos, no actues. Es mejor esperar.
11. AD SETS PAUSADOS — CONTEXTO OBLIGATORIO:
   - En la seccion "AD SETS PAUSADOS" se muestra QUIEN pauso cada ad set y POR QUE.
   - Si fue pausado por Brain/AI Manager → fue una decision deliberada. NO lo trates como "error operativo".
   - Si fue pausado por el operador humano → respetar la decision, no sugerir reactivar salvo que lo pidan.
   - Solo sugerir "reactivate" si la RAZON ORIGINAL de la pausa ya no aplica (ej: se agregaron creativos frescos, audiencia descansó).
   - Un ad set pausado con ROAS historico alto NO es automaticamente un candidato a reactivar si fue pausado intencionalmente.

REGLA — AD SETS GESTIONADOS POR AI MANAGER (managed_by_ai):
Los ad sets marcados con "[AI-MANAGED]" son gestionados autonomamente por el AI Manager.
Tu rol para estos es ESTRATEGICO — no ejecutas directamente, generas DIRECTIVAS que el AI Manager consume.

Post-learning flow para ad sets AI-managed:
1. STABILIZE: Cuando un ad set acaba de salir del learning phase (3-7 dias activo), NO escalar ni matar.
   Esperar 3-7 dias para que el algoritmo de Meta estabilice. Genera directiva "stabilize".
2. OPTIMIZE_ADS: Para TODOS los ad sets (ganadores y perdedores), si hay ads individuales con 0 compras
   y spend > 2x CPA target ($${kpiTargets.cpa_target}), o CTR < 0.5% con 1000+ impressions, genera
   directiva "optimize_ads" para que el AI Manager limpie los ads malos y agregue creativos frescos.
   Esto aplica INCLUSO para ad sets con ROAS excelente — limpiar ads malos sube aun mas el ROAS.
3. RESCUE: Si un ad set tiene CTR bueno (> 0.8%) pero 0 conversiones y spend > 2x CPA target,
   el problema puede ser copy/landing page, no audiencia. Genera directiva "rescue" para que el
   AI Manager intente con creativos de estilos diferentes antes de matar.
4. KILL: Solo despues de que se intento rescue/optimize y no mejoro en 48h+.
   El gasto minimo para kill es 3x CPA target ($${kpiTargets.cpa_target * 3}).

REGLA PRIORITARIA — NO PAUSAR AD SETS COMPLETOS POR FATIGA:
Cuando un ad set muestra metricas en declive (ROAS bajando, CPA subiendo, CTR cayendo), evalua:
1. ¿Cuantos ads activos tiene el ad set? Mira la seccion "ADS INDIVIDUALES" para contar.
2. NO pausar el AD SET completo si la causa raiz es fatiga creativa — recomendar creative_refresh para el ad set.
3. Si tiene ads individuales marcados como PAUSAR (fatigados/drag), recomienda pausar ESOS ADS especificos, no el ad set.
4. Si pausar los ads malos dejaria al ad set con <3 ads activos, recomienda crear ads nuevos ANTES o AL MISMO TIEMPO que pausar los malos.

REGLA CRITICA — PROTECCION DE ADS EN LEARNING (<72h):
Los ads marcados como [LEARNING] tienen MENOS de 72 horas activos. REGLAS ABSOLUTAS:
1. NUNCA recomiendas pausar un ad [LEARNING] — no tiene datos suficientes para juzgar.
2. NUNCA uses metricas de un ad [LEARNING] para diagnosticar fatiga del ad set — sus numeros aun no son representativos.
3. Si un ad set tiene fatiga pero contiene ads [LEARNING], la fatiga viene de los ads VIEJOS, no de los nuevos.
4. Cuando recomiendas "update_ad_status" para pausar ads malos, EXCLUYE siempre los [LEARNING].
5. Si TODOS los ads de un ad set son [LEARNING], el ad set esta en fase de aprendizaje — no actuar.

DIAGNOSTICO POR AD INDIVIDUAL:
Los ads en la seccion "ADS INDIVIDUALES" incluyen etiquetas basicas:
- [LEARNING]: <72h activo. Protegido. No tocar.
- [FATIGUED]: Frequency >= 4.0 o edad >= 28 dias Y ROAS bajo. Candidato a pausar. (Si ROAS es bueno, se protege aunque tenga freq alta)
- [DRAG]: ROAS muy por debajo del promedio del ad set (< 40%). Arrastra el rendimiento. Candidato a pausar.
- [HEALTHY]: Rendimiento normal. Mantener.

ADEMAS, la seccion "SALUD DE ADS INDIVIDUALES" en el diagnostico pre-analisis detecta anomalias especificas:
- ZERO_CONVERSIONS: Gastando budget con 0 compras — pausar inmediatamente.
- BUDGET_HOG: Consume >30% del spend del ad set con ROAS bajo — acapara budget y rinde mal, pausar.
- CTR_DEAD: CTR <0.3% con 1000+ impressions — audiencia ignora este ad completamente, pausar.
- DECLINING_FAST: ROAS cayendo >40% (3d vs 7d) — deterioro acelerado, monitorear y pausar si continua.
- TOP_PERFORMER_FATIGUING: ROAS excelente pero frequency alta — NO pausar, pero preparar reemplazo proactivamente.
- UNDERPERFORMER: Post-learning con datos suficientes y ROAS persistentemente bajo — pausar.

ORDEN DE PRIORIDAD cuando un ad set declina:
1ro: Revisar "SALUD DE ADS INDIVIDUALES" — pausar los ads con anomalias criticas (ZERO_CONVERSIONS, BUDGET_HOG, CTR_DEAD)
2do: Crear ads de reemplazo (create_ad) — ESPECIALMENTE si al pausar quedarian <3 ads activos
3ro: Las dos acciones anteriores van JUNTAS — pausar + crear es un paquete coordinado, no uno u otro
4to: Bajar budget (scale_down) — si todos los ads (no-learning) estan mal pero el ad set tiene historial bueno
5to: Pausar ad set completo (pause) — ULTIMO RECURSO, solo si ya se intento lo anterior o tiene 0 potencial

REGLA CLAVE: Nunca recomiendes scale_up en un ad set que tiene ads con anomalias sin resolver. Primero limpia, luego escala.
Pausar un ad set es la accion MAS destructiva. Pierdes toda la data de aprendizaje de Meta. Siempre intenta salvar el ad set primero con creativos frescos.

ACCIONES DISPONIBLES:
- scale_up: Subir budget (entity_type: adset)
- scale_down: Bajar budget (entity_type: adset)
- pause: Pausar ad set completo (entity_type: adset)
- reactivate: Reactivar ad set pausado con buen historico (entity_type: adset)
- duplicate_adset: Crear copia de ad set (entity_type: adset) — requiere duplicate_name y duplicate_strategy
- create_ad: Crear nuevo ad desde banco (entity_type: ad) — requiere creative_asset_id, ad_name, ad_headline, ad_primary_text, creative_rationale. ALL COPY FIELDS (ad_name, ad_headline, ad_primary_text) MUST be in ENGLISH.
- update_ad_status: Pausar/activar un ad individual (entity_type: ad) — recommended_value: 0=pausar, 1=activar
- move_budget: Redistribuir budget entre ad sets — requiere target_entity_id, target_entity_name
- update_bid_strategy: Cambiar bid strategy de campana (entity_type: campaign) — requiere bid_strategy
- observe: Seguimiento de una entidad en cooldown — NO ejecuta cambios, solo registra tu analisis de como evoluciona despues de una accion reciente. Usa esto para entidades con cooldown que quieras monitorear.
- no_action: Sin accion necesaria

COOLDOWNS TIERED — cada tipo de accion tiene su propio tiempo de cooldown:
${Object.entries(TIERED_COOLDOWN_HOURS).map(([action, hours]) => `- ${action}: ${hours}h`).join('\n')}
Las entidades en cooldown NO pueden recibir acciones de modificacion. Pero SI puedes generar "observe" para ellas — esto te permite monitorear como responden a la ultima accion sin tocarlas.

FORMATO DE RESPUESTA (JSON estricto):
{
  "summary": "Resumen en espanol de 2-3 oraciones del estado general de la cuenta",
  "status": "healthy|warning|critical",
  "recommendations": [
    {
      "action": "scale_up|scale_down|pause|reactivate|duplicate_adset|create_ad|update_ad_status|move_budget|update_bid_strategy|observe|no_action",
      "entity_type": "adset|ad|campaign",
      "entity_id": "ID de la entidad",
      "entity_name": "Nombre legible",
      "current_value": 50.00,
      "recommended_value": 60.00,
      "reasoning": "Explicacion breve en espanol de por que esta accion",
      "expected_impact": "Impacto esperado en espanol",
      "confidence": "high|medium|low",
      "priority": "critical|high|medium|low",
      "metrics": {
        "roas_7d": 0, "roas_3d": 0, "cpa_7d": 0,
        "spend_today": 0, "frequency": 0, "ctr": 0
      },
      "target_entity_id": null,
      "target_entity_name": null,
      "creative_asset_id": null,
      "bid_strategy": null,
      "duplicate_name": null,
      "duplicate_strategy": null,
      "ad_name": null,           // ENGLISH - internal name in Meta Ads Manager
      "ad_headline": null,       // ENGLISH - the headline shown to users in the ad (short, punchy, max 40 chars)
      "ad_primary_text": null,   // ENGLISH - the primary text / body shown above the image (compelling copy, max 125 chars)
      "creative_rationale": null,
      "ads_to_pause": []
    }
  ],
  "alerts": [
    {
      "type": "fatigue|low_roas|high_cpa|pacing|data_quality",
      "message": "Descripcion de la alerta en espanol",
      "severity": "critical|warning|info"
    }
  ]
}

Maximo ${unifiedPolicyConfig.max_recommendations_per_cycle} recomendaciones por ciclo (acciones de modificacion). Las "observe" no cuentan contra este limite. Prioriza las de mayor impacto esperado.
SIEMPRE responde SOLO con JSON valido. Sin texto adicional fuera del JSON.`;
}

/**
 * Construye el user prompt con todo el contexto para un ciclo.
 */
function buildUserPrompt({
  accountOverview,
  adSetSnapshots,
  adSnapshots,
  campaignSnapshots,
  recentActions,
  activeCooldowns,
  impactContext,
  creativeAssets,
  aiCreations,
  strategicDirectives,
  learnerSummary,
  aiManagerFeedback,
  recommendationHistory,
  cycleMemories,
  diagnosticContext,
  validatedHypotheses,
  memories,
  temporalPatterns,
  pauseContextMap
}) {
  const now = moment().tz(TIMEZONE);
  const hourET = now.hours();

  // === SEASONALITY CHECK ===
  const todayStr = now.format('MM-DD');
  const seasonalEvents = kpiTargets.seasonal_events || [];
  const activeSeasonalEvents = seasonalEvents.filter(ev => {
    if (ev.date) return ev.date === todayStr;
    if (ev.start && ev.end) return todayStr >= ev.start && todayStr <= ev.end;
    return false;
  });
  const upcomingEvents = seasonalEvents.filter(ev => {
    const evDate = ev.date || ev.start;
    if (!evDate) return false;
    const daysUntil = ((new Date(`${now.format('YYYY')}-${evDate}`) - new Date(now.format('YYYY-MM-DD'))) / 86400000);
    return daysUntil > 0 && daysUntil <= 14;
  });

  let prompt = `FECHA Y HORA: ${now.format('YYYY-MM-DD HH:mm')} ET (hora ${hourET})
${hourET < 10 ? 'NOTA: Es temprano, datos de pacing de hoy son poco confiables.' : ''}
${hourET >= 15 ? 'NOTA: Tarde — datos de pacing de hoy son fiables.' : ''}
`;

  // Seasonality context
  if (activeSeasonalEvents.length > 0) {
    prompt += `\nEVENTO ESTACIONAL ACTIVO: ${activeSeasonalEvents.map(e => `${e.name} (budget multiplier: ${e.budget_multiplier}x)`).join(', ')}
NOTA: Durante eventos estacionales es normal y esperado gastar mas. Se puede ser mas agresivo con budgets.\n`;
  }
  if (upcomingEvents.length > 0) {
    prompt += `\nEVENTOS ESTACIONALES PROXIMOS (14 dias): ${upcomingEvents.map(e => `${e.name} (${e.date || e.start})`).join(', ')}
NOTA: Prepara la cuenta para el aumento de demanda. Considera escalar ad sets ganadores proactivamente.\n`;
  }

  prompt += '\n';

  // === MEMORIA DE CICLOS ANTERIORES ===
  if (cycleMemories && cycleMemories.length > 0) {
    prompt += `═══ TU MEMORIA — CONCLUSIONES DE CICLOS ANTERIORES ═══\n`;
    prompt += `(Estas son TUS propias conclusiones de análisis previos. Úsalas para mantener continuidad.)\n\n`;

    for (const mem of cycleMemories.slice(0, 5)) {
      const hoursAgo = Math.round((Date.now() - new Date(mem.created_at).getTime()) / (1000 * 60 * 60));
      prompt += `--- Ciclo hace ${hoursAgo}h [${mem.account_assessment || '?'}] ---\n`;

      if (mem.conclusions && mem.conclusions.length > 0) {
        for (const c of mem.conclusions) {
          prompt += `  [${c.topic}] (${c.confidence}): ${c.conclusion}${c.entities?.length > 0 ? ` — entidades: ${c.entities.join(', ')}` : ''}\n`;
        }
      }

      if (mem.hypotheses && mem.hypotheses.length > 0) {
        const activeHyp = mem.hypotheses.filter(h => h.status === 'active');
        if (activeHyp.length > 0) {
          prompt += `  HIPOTESIS PENDIENTES: ${activeHyp.map(h => `"${h.hypothesis}" → ${h.proposed_action}`).join(' | ')}\n`;
        }
      }

      if (mem.snapshot) {
        prompt += `  Snapshot: ROAS 7d=${(mem.snapshot.roas_7d || 0).toFixed(2)}x, 30d=${(mem.snapshot.roas_30d || 0).toFixed(2)}x, ${mem.snapshot.recommendations_count} recs, top: ${mem.snapshot.top_action}\n`;
      }
    }

    prompt += `\nINSTRUCCION DE MEMORIA: Revisa tus conclusiones anteriores. Si una hipótesis sigue sin validar, intenta verificarla con datos actuales. Si una conclusión ya no aplica (datos cambiaron), descártala. Mantén coherencia con tu análisis previo a menos que los datos indiquen lo contrario.\n\n`;
  }

  // === VALIDATED HYPOTHESES ===
  if (validatedHypotheses && (validatedHypotheses.confirmed?.length > 0 || validatedHypotheses.rejected?.length > 0)) {
    prompt += `═══ HIPÓTESIS VALIDADAS (loop científico) ═══\n`;
    if (validatedHypotheses.confirmed.length > 0) {
      prompt += `CONFIRMADAS (usar como conocimiento confiable):\n`;
      for (const h of validatedHypotheses.confirmed) {
        prompt += `  ✓ "${h.hypothesis}" — ${h.reason}\n`;
      }
    }
    if (validatedHypotheses.rejected.length > 0) {
      prompt += `RECHAZADAS (NO repetir estas ideas):\n`;
      for (const h of validatedHypotheses.rejected) {
        prompt += `  ✗ "${h.hypothesis}" — ${h.reason}\n`;
      }
    }
    if (validatedHypotheses.still_active?.length > 0) {
      prompt += `PENDIENTES (necesitan más datos):\n`;
      for (const h of validatedHypotheses.still_active) {
        prompt += `  ⟳ "${h.hypothesis}" — ${h.reason}\n`;
      }
    }
    prompt += `INSTRUCCION: Las hipótesis confirmadas son conocimiento validado — úsalas con confianza. Las rechazadas son errores anteriores — NO las repitas. Genera nuevas hipótesis solo si tienes evidencia.\n\n`;
  }

  // === RESUMEN DE CUENTA ===
  const acctSpend30d = accountOverview.spend_30d || 0;
  const acctAov = acctSpend30d > 0 && accountOverview.roas_30d > 0
    ? (acctSpend30d * accountOverview.roas_30d) // revenue30d approximation
    : 0;

  prompt += `═══ RESUMEN DE CUENTA ═══
Budget diario total: $${(accountOverview.total_daily_budget || 0).toFixed(0)}
Gasto hoy: $${(accountOverview.today_spend || 0).toFixed(0)} (${accountOverview.total_daily_budget > 0 ? ((accountOverview.today_spend / accountOverview.total_daily_budget) * 100).toFixed(0) : 0}% del budget)
ROAS: Hoy ${(accountOverview.today_roas || 0).toFixed(2)}x | 3d ${(accountOverview.roas_3d || 0).toFixed(2)}x | 7d ${(accountOverview.roas_7d || 0).toFixed(2)}x | 14d ${(accountOverview.roas_14d || 0).toFixed(2)}x | 30d ${(accountOverview.roas_30d || 0).toFixed(2)}x
Spend: 14d $${(accountOverview.spend_14d || 0).toFixed(0)} | 30d $${acctSpend30d.toFixed(0)}
Ad sets activos: ${accountOverview.active_adsets || 0} | Pausados: ${accountOverview.paused_adsets || 0}
`;

  // === BUDGET / PACING MENSUAL ===
  const dayOfMonth = now.date();
  const daysInMonth = now.daysInMonth();
  const dailyTarget = kpiTargets.pacing?.daily_spend_target || kpiTargets.daily_spend_target || 3000;
  const monthlyTarget = dailyTarget * daysInMonth;
  const monthlyExpectedSoFar = dailyTarget * dayOfMonth;
  const budgetCeiling = safetyGuards.budget_ceiling_daily || 5000;
  // Estimate month-to-date spend from 30d (rough)
  const mtdSpendEst = acctSpend30d > 0 ? (acctSpend30d / 30 * dayOfMonth) : 0;
  const monthlyPacingPct = monthlyExpectedSoFar > 0 ? (mtdSpendEst / monthlyExpectedSoFar * 100).toFixed(0) : '--';

  prompt += `Budget mensual: ~$${monthlyTarget.toLocaleString()} target ($${dailyTarget}/dia x ${daysInMonth}d) | Dia ${dayOfMonth}/${daysInMonth}
Budget ceiling diario: $${budgetCeiling} | Pacing mensual estimado: ${monthlyPacingPct}%

`;


  // Build memory map for action history per entity
  const memMap = {};
  if (memories && memories.length > 0) {
    for (const m of memories) memMap[m.entity_id] = m;
  }

  // === AD SETS ===
  const activeAdSets = (adSetSnapshots || []).filter(s => s.status === 'ACTIVE');
  const pausedAdSets = (adSetSnapshots || []).filter(s => s.status === 'PAUSED');

  if (activeAdSets.length > 0) {
    prompt += `═══ AD SETS ACTIVOS (${activeAdSets.length}) ═══\n`;
    for (const s of activeAdSets) {
      const m7 = s.metrics?.last_7d || {};
      const m3 = s.metrics?.last_3d || {};
      const m14 = s.metrics?.last_14d || {};
      const m30 = s.metrics?.last_30d || {};
      const mt = s.metrics?.today || {};
      const pacing = s.daily_budget > 0 && hourET > 0
        ? ((mt.spend || 0) / (s.daily_budget * (hourET / 24)) * 100).toFixed(0)
        : '--';

      // AOV = Average Order Value (purchase_value / purchases)
      const aov7d = (m7.purchases || 0) > 0 ? (m7.purchase_value || 0) / m7.purchases : 0;
      const aov30d = (m30.purchases || 0) > 0 ? (m30.purchase_value || 0) / m30.purchases : 0;

      prompt += `[${s.entity_id}] ${s.entity_name}
  Budget: $${s.daily_budget || 0}/dia | Gasto hoy: $${(mt.spend || 0).toFixed(0)} | Pacing: ${pacing}%
  ROAS: hoy ${(mt.roas || mt.purchase_value && mt.spend ? (mt.purchase_value / mt.spend).toFixed(2) : '0.00')}x | 3d ${(m3.roas || 0).toFixed(2)}x | 7d ${(m7.roas || 0).toFixed(2)}x | 14d ${(m14.roas || 0).toFixed(2)}x | 30d ${(m30.roas || 0).toFixed(2)}x
  CPA: 7d $${(m7.cpa || 0).toFixed(2)} | 14d $${(m14.cpa || 0).toFixed(2)} | 30d $${(m30.cpa || 0).toFixed(2)}
  Compras: 7d ${m7.purchases || 0} | 14d ${m14.purchases || 0} | 30d ${m30.purchases || 0}
  AOV: 7d $${aov7d.toFixed(2)} | 30d $${aov30d.toFixed(2)}
  CTR: 7d ${(m7.ctr || 0).toFixed(2)}% | Frecuencia 7d: ${(m7.frequency || 0).toFixed(2)} | 14d: ${(m14.frequency || 0).toFixed(2)}
  Funnel 7d: ATC=${m7.add_to_cart || 0} → IC=${m7.initiate_checkout || 0} → Compras=${m7.purchases || 0}${(m7.add_to_cart || 0) > 0 ? ` (ATC→Purchase: ${((m7.purchases || 0) / m7.add_to_cart * 100).toFixed(0)}%)` : ''}
  Impressiones 7d: ${m7.impressions || 0} | Clicks 7d: ${m7.clicks || 0} | Spend 7d: $${(m7.spend || 0).toFixed(0)} | Spend 30d: $${(m30.spend || 0).toFixed(0)}
`;
      // Action history for this entity
      const entityMem = memMap[s.entity_id];
      if (entityMem?.action_history && entityMem.action_history.length > 0) {
        const histStr = entityMem.action_history.slice(-5).map(h => {
          const daysAgo = Math.round((Date.now() - new Date(h.executed_at).getTime()) / 86400000);
          const sign = h.roas_delta_pct > 0 ? '+' : '';
          const emoji = h.result === 'improved' ? '✓' : h.result === 'worsened' ? '✗' : '—';
          return `${emoji}${h.action_type}(${sign}${h.roas_delta_pct.toFixed(0)}% ROAS, ${daysAgo}d ago)`;
        }).join(' | ');
        prompt += `  Historial: ${histStr}\n`;
      }
    }
    prompt += '\n';
  }

  if (pausedAdSets.length > 0) {
    const pcMap = pauseContextMap || {};
    prompt += `═══ AD SETS PAUSADOS (${pausedAdSets.length}) ═══\n`;
    prompt += `  NOTA: Antes de sugerir reactivar, verifica QUIÉN lo pausó y POR QUÉ.\n`;
    prompt += `  Si fue pausado por Brain/AI Manager/operador con razón válida → NO es error operativo.\n\n`;
    for (const s of pausedAdSets.slice(0, 10)) {
      const m7 = s.metrics?.last_7d || {};
      const m14 = s.metrics?.last_14d || {};
      const m30 = s.metrics?.last_30d || {};
      const pc = pcMap[s.entity_id];
      prompt += `[${s.entity_id}] ${s.entity_name}\n`;
      prompt += `  ROAS: 7d ${(m7.roas || 0).toFixed(2)}x | 14d ${(m14.roas || 0).toFixed(2)}x | 30d ${(m30.roas || 0).toFixed(2)}x\n`;
      prompt += `  CPA 7d: $${(m7.cpa || 0).toFixed(2)} | Compras 30d: ${m30.purchases || 0} | Spend 30d: $${(m30.spend || 0).toFixed(0)}\n`;
      if (pc) {
        const agentLabels = { brain: 'Brain (IA)', ai_manager: 'AI Manager', manual: 'Operador humano', scaling: 'Agente escalamiento', performance: 'Agente performance' };
        const who = agentLabels[pc.paused_by] || pc.paused_by || 'desconocido';
        prompt += `  PAUSADO POR: ${who} | Hace ${pc.days_ago} día(s)\n`;
        if (pc.reasoning) prompt += `  RAZÓN: ${pc.reasoning}\n`;
        if (pc.metrics_at_pause) {
          prompt += `  Métricas al pausar: ROAS ${(pc.metrics_at_pause.roas_7d || 0).toFixed(2)}x, Freq ${(pc.metrics_at_pause.frequency || 0).toFixed(1)}\n`;
        }
      } else {
        prompt += `  PAUSADO POR: desconocido (sin registro en ActionLog — posible pausa manual antigua o desde Meta Ads Manager)\n`;
      }
    }
    prompt += '\n';
  }

  // === ADS POR AD SET (para analisis de creativos con edad y fatiga) ===
  if (adSnapshots && adSnapshots.length > 0) {
    prompt += `═══ ADS INDIVIDUALES (con edad y estado de fatiga) ═══\n`;
    prompt += `  LEYENDA: [LEARNING] = <72h activo, NO TOCAR | [FATIGUED] = freq alta o >28d | [DRAG] = ROAS muy bajo vs ad set | [HEALTHY] = OK\n\n`;
    // Agrupar por parent_id (ad set)
    const adsByAdSet = {};
    for (const ad of adSnapshots) {
      const pid = ad.parent_id || 'unknown';
      if (!adsByAdSet[pid]) adsByAdSet[pid] = [];
      adsByAdSet[pid].push(ad);
    }

    const now = new Date();
    for (const [adSetId, ads] of Object.entries(adsByAdSet)) {
      const parentName = activeAdSets.find(s => s.entity_id === adSetId)?.entity_name || adSetId;
      // Compute ad set avg ROAS for drag detection
      const activeAds = ads.filter(a => a.status === 'ACTIVE');
      const adsetAvgRoas = activeAds.length > 0
        ? activeAds.reduce((s, a) => s + (a.metrics?.last_7d?.roas || 0), 0) / activeAds.length
        : 0;

      prompt += `  ${parentName} (${ads.length} ads, avg ROAS: ${adsetAvgRoas.toFixed(2)}x):\n`;
      for (const ad of ads) {
        const m7 = ad.metrics?.last_7d || {};
        const createdTime = ad.meta_created_time || ad.created_time || ad.created_at;
        const ageHours = createdTime ? (now - new Date(createdTime)) / (1000 * 60 * 60) : -1;
        const ageDays = ageHours >= 0 ? Math.floor(ageHours / 24) : '?';
        const freq = m7.frequency || 0;
        const roas = m7.roas || 0;

        // Determine per-ad tag
        // Improved: protects top performers from being tagged FATIGUED
        const roasTarget = kpiTargets.roas_target || 3;
        let tag;
        if (ageHours >= 0 && ageHours < 72) {
          tag = 'LEARNING';
        } else if ((freq >= 4.0 || (typeof ageDays === 'number' && ageDays >= 28)) && roas < roasTarget * 0.8) {
          tag = 'FATIGUED';
        } else if (roas < adsetAvgRoas * 0.4 && (m7.spend || 0) > 5) {
          tag = 'DRAG';
        } else {
          tag = 'HEALTHY';
        }

        const ageStr = typeof ageDays === 'number' ? `${ageDays}d` : '?d';
        prompt += `    [${ad.entity_id}] ${ad.entity_name} | [${tag}] Age: ${ageStr} | Status: ${ad.status} | CTR: ${(m7.ctr || 0).toFixed(2)}% | ROAS: ${roas.toFixed(2)}x | Spend: $${(m7.spend || 0).toFixed(0)} | Freq: ${freq.toFixed(2)}\n`;
      }
    }
    prompt += '\n';
  }

  // === CAMPANAS (para bid strategy) ===
  if (campaignSnapshots && campaignSnapshots.length > 0) {
    prompt += `═══ CAMPANAS ═══\n`;
    for (const c of campaignSnapshots) {
      prompt += `[${c.entity_id}] ${c.entity_name} | Status: ${c.status} | Bid: ${c.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'}\n`;
    }
    prompt += '\n';
  }

  // === FEEDBACK DE IMPACTO ===
  if (impactContext.feedbackText) {
    prompt += `${impactContext.feedbackText}\n`;
  }

  // === ACCIONES EN MEDICION ===
  if (impactContext.pendingText) {
    prompt += `${impactContext.pendingText}\n`;
  }

  // === ACCIONES RECIENTES + COOLDOWNS ===
  if (recentActions && recentActions.length > 0) {
    prompt += `\n═══ ACCIONES RECIENTES (3 dias) ═══\n`;
    for (const a of recentActions.slice(0, 15)) {
      const daysAgo = ((Date.now() - new Date(a.executed_at).getTime()) / (1000 * 60 * 60 * 24)).toFixed(1);
      const budgetStr = ['scale_up', 'scale_down'].includes(a.action) ? ` $${a.before_value} -> $${a.after_value}` : '';
      prompt += `- ${a.entity_name}: ${a.action}${budgetStr} | hace ${daysAgo}d\n`;
    }
  }

  if (activeCooldowns && activeCooldowns.length > 0) {
    prompt += `\nENTIDADES CON COOLDOWN (NO recomendar cambios, pero puedes usar "observe" para seguimiento):\n`;
    for (const c of activeCooldowns) {
      prompt += `- ${c.entity_id} (${c.entity_name || 'N/A'}): ${c.last_action} hace ${Math.round((Date.now() - new Date(c.executed_at).getTime()) / 3600000)}h — cooldown ${c.cooldown_hours || 48}h, ${c.hours_left}h restantes\n`;
    }
  }

  // === LEARNING PHASE PROTECTION ===
  if (aiCreations && aiCreations.length > 0) {
    const protected_ = aiCreations.filter(c =>
      ['created', 'activating', 'learning'].includes(c.lifecycle_phase)
    );
    if (protected_.length > 0) {
      prompt += `\n═══ ENTIDADES EN LEARNING PHASE (NO TOCAR) ═══\n`;
      for (const c of protected_) {
        const phaseLabel = { created: 'ESPERANDO', activating: 'ACTIVANDOSE', learning: 'LEARNING' }[c.lifecycle_phase] || c.lifecycle_phase;
        let endsInfo = '';
        if (c.learning_ends_at) {
          const daysLeft = Math.max(0, Math.ceil((new Date(c.learning_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
          endsInfo = ` (${daysLeft}d restantes)`;
        }
        prompt += `- ${c.meta_entity_id} "${c.meta_entity_name}" — ${phaseLabel}${endsInfo}\n`;
      }
      const protectedIds = protected_.map(c => c.meta_entity_id);
      prompt += `IDs PROTEGIDOS: ${protectedIds.join(', ')}\n`;
    }
  }

  // === BANCO DE CREATIVOS ===
  if (creativeAssets && creativeAssets.length > 0) {
    const adReady = creativeAssets.filter(a => a.purpose !== 'reference' && a.link_url);
    const references = creativeAssets.filter(a => a.purpose === 'reference');

    if (adReady.length > 0) {
      prompt += `\n═══ BANCO DE CREATIVOS DISPONIBLES (${adReady.length} ad-ready) ═══\n`;
      for (const a of adReady) {
        const usage = a.times_used > 0 ? `(usado ${a.times_used}x, CTR: ${(a.avg_ctr || 0).toFixed(2)}%, ROAS: ${(a.avg_roas || 0).toFixed(1)}x)` : '(sin usar)';
        const style = a.style && a.style !== 'other' ? ` | estilo: ${a.style}` : '';
        const scene = a.scene_label ? ` | escena: "${a.scene_label}"` : '';
        prompt += `- ID: ${a._id} | "${a.headline || a.original_name}"${style}${scene} ${usage}\n`;
      }
    }

    // === SCENE PERFORMANCE INSIGHTS ===
    const withSceneData = adReady.filter(a => a.scene_label && a.times_used >= 1 && a.avg_roas > 0);
    if (withSceneData.length > 0) {
      // Aggregate performance by scene_label
      const sceneMap = {};
      for (const a of withSceneData) {
        const label = a.scene_label;
        if (!sceneMap[label]) {
          sceneMap[label] = { count: 0, totalRoas: 0, totalCtr: 0, totalUsed: 0 };
        }
        sceneMap[label].count++;
        sceneMap[label].totalRoas += a.avg_roas;
        sceneMap[label].totalCtr += a.avg_ctr || 0;
        sceneMap[label].totalUsed += a.times_used;
      }

      const sceneRanking = Object.entries(sceneMap)
        .map(([label, data]) => ({
          label,
          avgRoas: data.totalRoas / data.count,
          avgCtr: data.totalCtr / data.count,
          count: data.count,
          totalUsed: data.totalUsed
        }))
        .sort((a, b) => b.avgRoas - a.avgRoas);

      if (sceneRanking.length > 0) {
        prompt += `\n═══ RENDIMIENTO POR TIPO DE ESCENA CREATIVA ═══\n`;
        prompt += `Estas escenas son las que mejor funcionan en ads — usa esta info para elegir creativos al hacer create_ad:\n`;
        for (const s of sceneRanking.slice(0, 8)) {
          const roasLabel = s.avgRoas >= 3 ? '🟢' : s.avgRoas >= 1.5 ? '🟡' : '🔴';
          prompt += `${roasLabel} "${s.label}": ROAS ${s.avgRoas.toFixed(1)}x, CTR ${s.avgCtr.toFixed(2)}%, ${s.count} creativos, ${s.totalUsed} usos\n`;
        }
        prompt += `NOTA: Cuando hagas create_ad, prefiere creativos con escenas de alto ROAS. Si hay creativos sin usar de escenas ganadoras, prioriza esos.\n`;
      }
    }

    if (references.length > 0) {
      prompt += `\nREFERENCIAS DE ESTILO (NO usar como ads, solo contexto):\n`;
      for (const a of references) {
        prompt += `- "${a.headline || a.original_name}" | estilo: ${a.style || 'other'}\n`;
      }
    }
  }

  // === DIRECTIVAS ESTRATEGICAS ===
  if (strategicDirectives && strategicDirectives.length > 0) {
    prompt += `\n═══ DIRECTIVAS ESTRATEGICAS ACTIVAS ═══\n`;
    for (const d of strategicDirectives) {
      prompt += `- ${d.directive_type.toUpperCase()}: ${d.entity_name || d.entity_id} — ${d.target_action} | ${d.reason}\n`;
    }
  }

  // === AI MANAGER FEEDBACK (bidireccional) ===
  if (aiManagerFeedback && aiManagerFeedback.summary) {
    prompt += `\n═══ AI MANAGER FEEDBACK (ultimas 24h) ═══\n`;
    prompt += `${aiManagerFeedback.summary}\n`;
    const compliance = aiManagerFeedback.compliance || {};
    if (compliance.compliance_rate < 50 && compliance.total_directive_entities >= 2) {
      prompt += `\n⚠ ALERTA: AI Manager esta IGNORANDO tus directivas (${compliance.compliance_rate}% compliance). Considera:\n`;
      prompt += `  - Emitir directivas con urgency=critical para entidades ignoradas\n`;
      prompt += `  - Si un ad set tiene directivas ignoradas por >48h, emitir directive_type=override\n`;
    }
    if (aiManagerFeedback.ignored_entities && aiManagerFeedback.ignored_entities.length > 0) {
      prompt += `\nEntidades con directivas IGNORADAS por AI Manager:\n`;
      for (const e of aiManagerFeedback.ignored_entities) {
        prompt += `  - ${e.entity_name}: ${e.directive_count} directivas (${e.directive_types.join(', ')}) ignoradas por ${e.oldest_hours}h\n`;
      }
      prompt += `ACCION: Re-emitir directivas para estas entidades con urgencia elevada.\n`;
    }
  }

  // === POLICY LEARNER BIAS ===
  if (learnerSummary) {
    prompt += `\n═══ SENALES DE APRENDIZAJE AUTOMATICO ═══\n`;
    prompt += `${learnerSummary}\n`;
  }

  // === TEMPORAL PATTERNS ===
  const validTemporalPatterns = (temporalPatterns || []).filter(p => (p.metrics?.sample_count || 0) >= 4);
  if (validTemporalPatterns.length > 0) {
    const todayKey = moment().tz(TIMEZONE).format('dddd').toLowerCase();
    const dayNames = { monday: 'Lunes', tuesday: 'Martes', wednesday: 'Miércoles', thursday: 'Jueves', friday: 'Viernes', saturday: 'Sábado', sunday: 'Domingo' };
    const dayOrder = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

    prompt += `\n═══ PATRONES TEMPORALES APRENDIDOS ═══\n`;
    prompt += `Rendimiento típico por día de semana (${validTemporalPatterns[0].metrics.sample_count}+ semanas):\n`;
    const sorted = validTemporalPatterns.sort((a, b) => dayOrder.indexOf(a.pattern_key) - dayOrder.indexOf(b.pattern_key));
    for (const p of sorted) {
      const m = p.metrics;
      const isToday = p.pattern_key === todayKey;
      prompt += `${isToday ? '→ ' : '  '}${dayNames[p.pattern_key] || p.pattern_key}: ROAS ${m.avg_roas.toFixed(2)}x, CPA $${m.avg_cpa.toFixed(0)}, CTR ${m.avg_ctr.toFixed(2)}%${isToday ? ' ← HOY' : ''}\n`;
    }
    prompt += `INSTRUCCION TEMPORAL: Si las métricas actuales están dentro del rango normal para hoy (${dayNames[todayKey]}), NO es anomalía. Solo actúa si la desviación es >20% vs el patrón del día.\n`;
  }

  // === INDICADORES DE DIVERSIDAD CREATIVA POR AD SET ===
  if (adSnapshots && adSnapshots.length > 0) {
    const adsByAdSet = {};
    for (const ad of adSnapshots) {
      const pid = ad.parent_id || 'unknown';
      if (!adsByAdSet[pid]) adsByAdSet[pid] = [];
      if (ad.status === 'ACTIVE') adsByAdSet[pid].push(ad);
    }

    const lowCreativeAdSets = [];
    for (const s of activeAdSets) {
      const activeAds = adsByAdSet[s.entity_id] || [];
      if (activeAds.length < 3) {
        lowCreativeAdSets.push(`- ${s.entity_name} [${s.entity_id}]: ${activeAds.length} ads activos — NECESITA CREATIVOS FRESCOS antes de considerar pausar`);
      }
    }

    if (lowCreativeAdSets.length > 0) {
      prompt += `\n═══ ⚠ AD SETS CON POCOS CREATIVOS (< 3 ads activos) ═══\n`;
      prompt += `IMPORTANTE: Estos ad sets NO deben pausarse. Si sus metricas declinan, primero agrega creativos nuevos del banco.\n`;
      prompt += lowCreativeAdSets.join('\n') + '\n';
    }
  }

  // === HISTORIAL DE DECISIONES DEL USUARIO ===
  if (recommendationHistory && recommendationHistory.length > 0) {
    const approved = recommendationHistory.filter(r => r.status === 'approved');
    const rejected = recommendationHistory.filter(r => r.status === 'rejected');

    prompt += `\n═══ HISTORIAL DE DECISIONES DEL USUARIO (aprobaciones/rechazos) ═══\n`;
    prompt += `Total: ${approved.length} aprobadas, ${rejected.length} rechazadas (ultimas 30)\n`;

    if (approved.length > 0) {
      prompt += `\nAPROBADAS (el usuario confio en estas):\n`;
      for (const r of approved.slice(0, 15)) {
        const daysAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 86400000) : '?';
        const impact = r.follow_up?.impact_verdict || 'sin medir';
        const roasDelta = (r.follow_up?.metrics_after?.roas_7d && r.follow_up?.metrics_at_recommendation?.roas_7d)
          ? `ROAS: ${r.follow_up.metrics_at_recommendation.roas_7d.toFixed(2)}x -> ${r.follow_up.metrics_after.roas_7d.toFixed(2)}x`
          : '';
        prompt += `- [${daysAgo}d ago] ${r.action_type} en ${r.entity?.entity_name || 'N/A'}: "${r.title}" | impacto: ${impact} ${roasDelta}\n`;
      }
    }

    if (rejected.length > 0) {
      prompt += `\nRECHAZADAS (el usuario NO quiso estas — evita patrones similares):\n`;
      for (const r of rejected.slice(0, 10)) {
        const daysAgo = r.decided_at ? Math.round((Date.now() - new Date(r.decided_at).getTime()) / 86400000) : '?';
        prompt += `- [${daysAgo}d ago] ${r.action_type} en ${r.entity?.entity_name || 'N/A'}: "${r.title}" | nota: ${r.decision_note || 'sin nota'}\n`;
      }
    }

    prompt += `INSTRUCCION: Aprende de las preferencias del usuario. Repite patrones de acciones aprobadas. Evita recomendar acciones que el usuario ha rechazado consistentemente.\n`;
  }

  // === DIAGNOSTIC CONTEXT (pre-computed by math engine) ===
  if (diagnosticContext) {
    prompt += `\n${diagnosticContext}\n`;
  }

  prompt += `\n═══ GENERA TUS RECOMENDACIONES AHORA ═══
Analiza TODA la informacion anterior de forma holistica. Recuerda:
- Una sola recomendacion por entidad (pero un ad y su ad set padre son entidades diferentes — puedes pausar un ad Y crear otro ad en el mismo ad set)
- Prioriza por impacto esperado
- Aprende de los resultados pasados
- No toques entidades en cooldown, medicion, o learning phase (pero usa "observe" para monitorear entidades en cooldown)
- Coordina: si subes budget a un ad set, asegurate que sus creativos no estan fatigados
- LIMPIEZA PRIMERO: Si el diagnostico "SALUD DE ADS" muestra ads con anomalias (ZERO_CONVERSIONS, BUDGET_HOG, CTR_DEAD, UNDERPERFORMER), genera update_ad_status para pausarlos ANTES de cualquier scale_up. No subas budget a un ad set sucio.
- PAQUETE COORDINADO: Cuando pauses un ad, evalua si necesitas crear un ad de reemplazo (create_ad). Pausar + crear van juntos. Si al pausar quedarian <3 ads activos, SIEMPRE genera create_ad junto.
- CRITICO: Si un ad set tiene pocos creativos (< 3 ads activos) y metricas en declive, recomienda create_ad PRIMERO — NO pausar el ad set
- Pausar un ad set completo es ULTIMO RECURSO. Prioriza: update_ad_status (pausar ads malos) > create_ad > scale_down > pause
- USA EL DIAGNOSTICO PRE-ANALISIS: Cada ad set tiene un diagnostico computado matematicamente. Si dice FUNNEL_LEAK, no pausar — investigar funnel. Si dice CREATIVE_FATIGUE, refrescar creativos primero. Si dice AUDIENCE_SATURATED, expandir o reducir budget.
- DIAGNOSTICA EL "POR QUE" en tu reasoning: En cada recomendacion, explica la CAUSA RAIZ del problema (fatiga creativa? saturacion? funnel? estacionalidad?) y por que tu accion ataca esa causa.
- HISTORIAL POR ENTIDAD: Revisa el "Historial" de cada ad set. Si una acción FALLÓ antes (✗), NO la repitas en esa entidad. Si una acción FUNCIONÓ (✓), priorízala. Esto es conocimiento validado.
- PATRONES TEMPORALES: Si hoy es un día donde históricamente el rendimiento es más bajo, NO lo confundas con un problema. Compara vs el patrón del día, no vs ayer.
Responde SOLO con JSON valido.`;

  return prompt;
}

/**
 * Builds condensed diagnostic framework text for the system prompt.
 * This teaches Claude HOW to diagnose, not just what to do.
 */
function _buildDiagnosticFrameworkText() {
  const diag = deepResearchPriors.diagnostics || {};
  let text = '';

  text += `A. HIGH CTR + LOW CONVERSIONS → Probable problema de LANDING PAGE, no del ad:
   Causas: ${(diag.good_ctr_low_conversion?.likely_causes || []).slice(0, 3).join('; ')}
   Acción: NO pausar el ad. Investigar landing page, checkout, y tracking.\n`;

  text += `B. HIGH CPM + LOW CTR → Problema CREATIVO:
   Causas: ${(diag.high_cpm_low_ctr?.likely_causes || []).slice(0, 3).join('; ')}
   Acción: Refrescar creativos con hook más fuerte, nuevos ángulos.\n`;

  text += `C. ROAS DECLINING (no es solo "pausar"):
   Causas: ${(diag.roas_declining?.likely_causes || []).slice(0, 4).join('; ')}
   Acción: Primero diagnosticar la causa (fatiga? saturación? estacionalidad?) antes de actuar.\n`;

  text += `D. HIGH FREQUENCY + LOW ROAS → AUDIENCIA SATURADA:
   Causas: ${(diag.high_frequency_low_roas?.likely_causes || []).slice(0, 3).join('; ')}
   Acción: Refrescar creativos urgente, expandir audiencia, o horizontal scaling.\n`;

  text += `E. UNDERSPENDING → META NO PUEDE GASTAR:
   Causas: ${(diag.underspending?.likely_causes || []).slice(0, 3).join('; ')}
   Acción: Ampliar audiencia, mejorar calidad creativa, o ajustar bid strategy.\n`;

  text += `\nREGLA DE ORO: Nunca recomiendes "pause" como primera reacción a ROAS bajo.
Secuencia de diagnóstico: ¿Es funnel? → ¿Es fatiga creativa? → ¿Es saturación de audiencia? → ¿Es estacionalidad/CPM? → Solo entonces, considerar pause.`;

  return text;
}

module.exports = { getSystemPrompt, buildUserPrompt };
