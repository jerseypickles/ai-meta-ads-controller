const moment = require('moment-timezone');
const kpiTargets = require('../../../config/kpi-targets');
const deepResearchPriors = require('../../../config/deep-research-priors');

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

KPIs OBJETIVO:
- ROAS target: ${kpiTargets.roas_target}x (minimo: ${kpiTargets.roas_minimum}x, excelente: ${kpiTargets.roas_excellent}x)
- CPA target: $${kpiTargets.cpa_target} (maximo: $${kpiTargets.cpa_maximum})
- CTR minimo: ${kpiTargets.ctr_minimum}%
- Frecuencia warning: ${kpiTargets.frequency_warning}, critica: ${kpiTargets.frequency_critical}
- Spend diario target: $${kpiTargets.pacing?.daily_spend_target || 3000}

REGLAS CRITICAS:
1. COORDINACION: Cada entidad solo puede recibir UNA recomendacion. No recomiendes scale_up y pause para el mismo ad set.
2. ATTRIBUTION LAG: Datos de hoy/3d estan INCOMPLETOS. Usa 7d como referencia principal, 14d para confirmar tendencias.
3. LEARNING PHASE: Nunca toques entidades en learning phase. Estan protegidas.
4. COOLDOWNS: No recomiendes cambios en entidades con cooldown activo o en medicion.
5. FEEDBACK LOOP: Revisa los resultados de tus acciones pasadas ANTES de decidir. Repite lo que funciono, evita lo que fallo.
6. HISTORIAL NEGATIVO: Si una entidad tuvo CUALQUIER caida de ROAS con una accion reciente (ej: scale_up hace 4d resulto en -3% o -15% ROAS), NO repitas la misma accion en esa entidad. Espera al menos 7 dias. Que las metricas actuales se vean bien NO justifica repetir una accion que ya demostro resultado negativo en esa misma entidad.
7. PACING: Antes de las 10am la informacion de pacing es poco confiable. Despues de las 3pm es mas fiable.
8. CREATIVOS: Solo usa creative_asset_id de assets "ad-ready" (NO references). Necesitas 3-5+ ads por ad set. Para create_ad: ad_name, ad_headline, and ad_primary_text MUST ALWAYS be in ENGLISH — they go directly to Meta Ads and are shown to US customers. Write compelling, native-sounding English ad copy. The ad_headline is the bold text under the image (max 40 chars). The ad_primary_text is the body text above the image (max 125 chars, persuasive, with emoji if fits the style).
9. MAX BUDGET CHANGE: Nunca mas de 20-25% por ajuste. Cambios mayores resetean learning phase.
10. CONSERVADOR CUANDO HAY DUDA: Si no tienes suficientes datos, no actues. Es mejor esperar.

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

REGLA PRIORITARIA — CREATIVE REFRESH ANTES DE PAUSAR:
Cuando un ad set muestra metricas en declive (ROAS bajando, CPA subiendo, CTR cayendo), ANTES de recomendar "pause" debes evaluar:
1. ¿Cuantos ads activos tiene el ad set? Mira la seccion "ADS INDIVIDUALES" para contar.
2. Si tiene MENOS de 3 ads activos → NO pausar. En su lugar, recomienda "create_ad" para agregar un creativo nuevo del banco de creativos. La fatiga puede ser del unico creativo, no del ad set.
3. Si tiene 3+ ads activos pero TODOS muestran metricas malas → Ahi si puedes considerar pausar.
4. Si tiene 3+ ads activos pero solo ALGUNOS estan mal → Usa "update_ad_status" para pausar los ads malos individualmente, y "create_ad" para reemplazarlos.

ORDEN DE PRIORIDAD cuando un ad set declina:
1ro: Refrescar creativos (create_ad) — si tiene pocos ads o creativos fatigados
2do: Pausar ads individuales malos (update_ad_status) — si hay ads especificos arrastrando el ad set
3ro: Bajar budget (scale_down) — si todos los ads estan mal pero el ad set tiene historial bueno
4to: Pausar ad set completo (pause) — ULTIMO RECURSO, solo si ya se intento lo anterior o tiene 0 potencial

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
- no_action: Sin accion necesaria

FORMATO DE RESPUESTA (JSON estricto):
{
  "summary": "Resumen en espanol de 2-3 oraciones del estado general de la cuenta",
  "status": "healthy|warning|critical",
  "recommendations": [
    {
      "action": "scale_up|scale_down|pause|reactivate|duplicate_adset|create_ad|update_ad_status|move_budget|update_bid_strategy|no_action",
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

Maximo 10 recomendaciones por ciclo. Prioriza las de mayor impacto esperado.
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
  aiManagerFeedback
}) {
  const now = moment().tz(TIMEZONE);
  const hourET = now.hours();

  let prompt = `FECHA Y HORA: ${now.format('YYYY-MM-DD HH:mm')} ET (hora ${hourET})
${hourET < 10 ? 'NOTA: Es temprano, datos de pacing de hoy son poco confiables.' : ''}
${hourET >= 15 ? 'NOTA: Tarde — datos de pacing de hoy son fiables.' : ''}

`;

  // === RESUMEN DE CUENTA ===
  prompt += `═══ RESUMEN DE CUENTA ═══
Budget diario total: $${(accountOverview.total_daily_budget || 0).toFixed(0)}
Gasto hoy: $${(accountOverview.today_spend || 0).toFixed(0)} (${accountOverview.total_daily_budget > 0 ? ((accountOverview.today_spend / accountOverview.total_daily_budget) * 100).toFixed(0) : 0}% del budget)
ROAS: Hoy ${(accountOverview.today_roas || 0).toFixed(2)}x | 3d ${(accountOverview.roas_3d || 0).toFixed(2)}x | 7d ${(accountOverview.roas_7d || 0).toFixed(2)}x | 14d ${(accountOverview.roas_14d || 0).toFixed(2)}x | 30d ${(accountOverview.roas_30d || 0).toFixed(2)}x
Ad sets activos: ${accountOverview.active_adsets || 0} | Pausados: ${accountOverview.paused_adsets || 0}

`;

  // === AD SETS ===
  const activeAdSets = (adSetSnapshots || []).filter(s => s.status === 'ACTIVE');
  const pausedAdSets = (adSetSnapshots || []).filter(s => s.status === 'PAUSED');

  if (activeAdSets.length > 0) {
    prompt += `═══ AD SETS ACTIVOS (${activeAdSets.length}) ═══\n`;
    for (const s of activeAdSets) {
      const m7 = s.metrics?.last_7d || {};
      const m3 = s.metrics?.last_3d || {};
      const m14 = s.metrics?.last_14d || {};
      const mt = s.metrics?.today || {};
      const pacing = s.daily_budget > 0 && hourET > 0
        ? ((mt.spend || 0) / (s.daily_budget * (hourET / 24)) * 100).toFixed(0)
        : '--';

      prompt += `[${s.entity_id}] ${s.entity_name}
  Budget: $${s.daily_budget || 0}/dia | Gasto hoy: $${(mt.spend || 0).toFixed(0)} | Pacing: ${pacing}%
  ROAS: hoy ${(mt.roas || mt.purchase_value && mt.spend ? (mt.purchase_value / mt.spend).toFixed(2) : '0.00')}x | 3d ${(m3.roas || 0).toFixed(2)}x | 7d ${(m7.roas || 0).toFixed(2)}x | 14d ${(m14.roas || 0).toFixed(2)}x
  CPA: 7d $${(m7.cpa || 0).toFixed(2)} | Compras 7d: ${m7.purchases || 0}
  CTR: 7d ${(m7.ctr || 0).toFixed(2)}% | Frecuencia 7d: ${(m7.frequency || 0).toFixed(2)}
  Impressiones 7d: ${m7.impressions || 0} | Clicks 7d: ${m7.clicks || 0} | Spend 7d: $${(m7.spend || 0).toFixed(0)}
`;
    }
    prompt += '\n';
  }

  if (pausedAdSets.length > 0) {
    prompt += `═══ AD SETS PAUSADOS (${pausedAdSets.length}) — candidatos a reactivar ═══\n`;
    for (const s of pausedAdSets.slice(0, 10)) {
      const m7 = s.metrics?.last_7d || {};
      const m14 = s.metrics?.last_14d || {};
      prompt += `[${s.entity_id}] ${s.entity_name} — ROAS 7d: ${(m7.roas || 0).toFixed(2)}x, 14d: ${(m14.roas || 0).toFixed(2)}x, CPA: $${(m7.cpa || 0).toFixed(2)}, Spend 7d: $${(m7.spend || 0).toFixed(0)}\n`;
    }
    prompt += '\n';
  }

  // === ADS POR AD SET (para analisis de creativos) ===
  if (adSnapshots && adSnapshots.length > 0) {
    prompt += `═══ ADS INDIVIDUALES (para analisis de fatiga/rotacion) ═══\n`;
    // Agrupar por parent_id (ad set)
    const adsByAdSet = {};
    for (const ad of adSnapshots) {
      const pid = ad.parent_id || 'unknown';
      if (!adsByAdSet[pid]) adsByAdSet[pid] = [];
      adsByAdSet[pid].push(ad);
    }

    for (const [adSetId, ads] of Object.entries(adsByAdSet)) {
      const parentName = activeAdSets.find(s => s.entity_id === adSetId)?.entity_name || adSetId;
      prompt += `  ${parentName} (${ads.length} ads):\n`;
      for (const ad of ads) {
        const m7 = ad.metrics?.last_7d || {};
        prompt += `    [${ad.entity_id}] ${ad.entity_name} | Status: ${ad.status} | CTR: ${(m7.ctr || 0).toFixed(2)}% | ROAS: ${(m7.roas || 0).toFixed(2)}x | Spend: $${(m7.spend || 0).toFixed(0)} | Freq: ${(m7.frequency || 0).toFixed(2)}\n`;
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
    const cooldownIds = activeCooldowns.map(c => c.entity_id);
    prompt += `\nENTIDADES CON COOLDOWN (NO recomendar cambios):\n${cooldownIds.join(', ')}\n`;
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

  prompt += `\n═══ GENERA TUS RECOMENDACIONES AHORA ═══
Analiza TODA la informacion anterior de forma holistica. Recuerda:
- Una sola recomendacion por entidad
- Prioriza por impacto esperado
- Aprende de los resultados pasados
- No toques entidades en cooldown, medicion, o learning phase
- Coordina: si subes budget a un ad set, asegurate que sus creativos no estan fatigados
- CRITICO: Si un ad set tiene pocos creativos (< 3 ads activos) y metricas en declive, recomienda create_ad PRIMERO — NO pausar
- Pausar un ad set es ULTIMO RECURSO. Prioriza: create_ad > update_ad_status > scale_down > pause
Responde SOLO con JSON valido.`;

  return prompt;
}

module.exports = { getSystemPrompt, buildUserPrompt };
