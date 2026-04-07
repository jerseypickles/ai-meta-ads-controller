const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const BrainMemory = require('../../db/models/BrainMemory');
const ZeusDirective = require('../../db/models/ZeusDirective');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const BrainInsight = require('../../db/models/BrainInsight');
const SystemConfig = require('../../db/models/SystemConfig');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 1: APRENDER PATRONES CREATIVOS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analiza TestRuns finalizados para descubrir que combinaciones de
 * scene × style × copy_angle producen mejores resultados.
 */
async function learnCreativePatterns() {
  const finishedTests = await TestRun.find({
    phase: { $in: ['graduated', 'killed', 'expired'] },
    feedback_saved: { $ne: true }
  }).populate('proposal_id').lean();

  if (finishedTests.length === 0) return { patterns: 0, tests_processed: 0 };

  // Agregar datos por escena
  const sceneStats = {};
  const styleStats = {};
  const angleStats = {};

  for (const test of finishedTests) {
    const proposal = test.proposal_id;
    if (!proposal) continue;

    const scene = proposal.scene_short || 'unknown';
    const isWin = test.phase === 'graduated';
    const roas = test.metrics?.roas || 0;

    // Escenas
    if (!sceneStats[scene]) sceneStats[scene] = { wins: 0, losses: 0, total_roas: 0, count: 0 };
    sceneStats[scene].count++;
    sceneStats[scene].total_roas += roas;
    if (isWin) sceneStats[scene].wins++;
    else sceneStats[scene].losses++;

    // Marcar como procesado
    await TestRun.findByIdAndUpdate(test._id, { $set: { feedback_saved: true } });
  }

  // Calcular win rates
  const scenePatterns = Object.entries(sceneStats)
    .map(([scene, stats]) => ({
      scene,
      win_rate: stats.count > 0 ? Math.round((stats.wins / stats.count) * 100) : 0,
      avg_roas: stats.count > 0 ? Math.round((stats.total_roas / stats.count) * 100) / 100 : 0,
      samples: stats.count,
      wins: stats.wins,
      losses: stats.losses
    }))
    .sort((a, b) => b.win_rate - a.win_rate);

  return { patterns: scenePatterns, tests_processed: finishedTests.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2: APRENDER SENALES DE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analiza que metricas tempranas predicen graduacion vs kill.
 */
async function learnTestSignals() {
  const allTests = await TestRun.find({
    phase: { $in: ['graduated', 'killed', 'expired'] }
  }).lean();

  if (allTests.length < 5) return { signals: [], total_tests: allTests.length };

  // Analizar metricas del dia 2 (primera ventana util)
  const earlySignals = { purchase_48h: { graduated: 0, killed: 0, total: 0 } };

  for (const test of allTests) {
    const day2Assessment = test.assessments?.find(a => a.day_number <= 2 && a.metrics_snapshot);
    if (!day2Assessment) continue;

    const hasPurchase = (day2Assessment.metrics_snapshot.purchases || 0) > 0;
    earlySignals.purchase_48h.total++;
    if (hasPurchase) {
      if (test.phase === 'graduated') earlySignals.purchase_48h.graduated++;
      else earlySignals.purchase_48h.killed++;
    }
  }

  // Calcular predictividad
  const signals = [];
  const p48 = earlySignals.purchase_48h;
  if (p48.total > 0) {
    const gradRate = p48.graduated > 0 ? Math.round((p48.graduated / (p48.graduated + p48.killed)) * 100) : 0;
    signals.push({
      signal: 'purchase_in_48h',
      description: `Tests con compra en 48h graduan ${gradRate}% de las veces`,
      graduation_rate: gradRate,
      samples: p48.total
    });
  }

  // ROAS promedio de graduados vs killed
  const graduatedRoas = allTests.filter(t => t.phase === 'graduated').map(t => t.metrics?.roas || 0);
  const killedRoas = allTests.filter(t => t.phase === 'killed').map(t => t.metrics?.roas || 0);

  if (graduatedRoas.length > 0) {
    const avgGradRoas = graduatedRoas.reduce((a, b) => a + b, 0) / graduatedRoas.length;
    const avgKillRoas = killedRoas.length > 0 ? killedRoas.reduce((a, b) => a + b, 0) / killedRoas.length : 0;
    signals.push({
      signal: 'roas_threshold',
      description: `ROAS promedio graduados: ${avgGradRoas.toFixed(2)}x vs killed: ${avgKillRoas.toFixed(2)}x`,
      graduated_avg: Math.round(avgGradRoas * 100) / 100,
      killed_avg: Math.round(avgKillRoas * 100) / 100,
      samples: allTests.length
    });
  }

  return { signals, total_tests: allTests.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2.5: APRENDER DE CREATIVOS UPLOADED (legacy, con metricas reales)
// ═══════════════════════════════════════════════════════════════════════════════

async function learnFromUploadedCreatives() {
  // Creativos subidos directamente (antes del Testing Agent) que tienen performance
  const uploaded = await CreativeProposal.find({
    status: 'uploaded',
    'performance.measured_at': { $ne: null },
    'performance.spend_7d': { $gt: 0 }
  }).lean();

  if (uploaded.length === 0) return { total: 0, performers: [] };

  const scenePerf = {};
  for (const p of uploaded) {
    const scene = p.scene_short || 'unknown';
    if (!scenePerf[scene]) scenePerf[scene] = { total_roas: 0, total_spend: 0, purchases: 0, count: 0 };
    scenePerf[scene].total_roas += (p.performance.roas_7d || 0);
    scenePerf[scene].total_spend += (p.performance.spend_7d || 0);
    scenePerf[scene].purchases += (p.performance.purchases_7d || 0);
    scenePerf[scene].count++;
  }

  const performers = Object.entries(scenePerf)
    .map(([scene, s]) => ({
      scene,
      avg_roas: s.count > 0 ? Math.round((s.total_roas / s.count) * 100) / 100 : 0,
      total_spend: Math.round(s.total_spend),
      purchases: s.purchases,
      count: s.count
    }))
    .sort((a, b) => b.avg_roas - a.avg_roas);

  return { total: uploaded.length, performers };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2.6: DATOS DE ATHENA (acciones con impacto medido)
// ═══════════════════════════════════════════════════════════════════════════════

async function learnFromAthenaActions() {
  const measuredActions = await ActionLog.find({
    success: true,
    impact_measured: true,
    follow_up_deltas: { $exists: true, $ne: null }
  }).sort({ executed_at: -1 }).limit(100).lean();

  if (measuredActions.length === 0) return { total: 0, action_outcomes: {} };

  const actionOutcomes = {};
  for (const a of measuredActions) {
    if (!actionOutcomes[a.action]) actionOutcomes[a.action] = { positive: 0, negative: 0, neutral: 0, count: 0 };
    actionOutcomes[a.action].count++;
    const verdict = a.follow_up_verdict || 'neutral';
    if (verdict === 'positive' || verdict === 'improved') actionOutcomes[a.action].positive++;
    else if (verdict === 'negative' || verdict === 'worsened') actionOutcomes[a.action].negative++;
    else actionOutcomes[a.action].neutral++;
  }

  return { total: measuredActions.length, action_outcomes: actionOutcomes };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 3: AGREGAR DATOS DE CUENTA
// ═══════════════════════════════════════════════════════════════════════════════

async function gatherAccountIntelligence() {
  const { getLatestSnapshots } = require('../../db/queries');

  // ═══ DATOS GLOBALES DE LA CUENTA ═══
  const allAdsets = await getLatestSnapshots('adset');
  const activeAdsets = allAdsets.filter(s => s.status === 'ACTIVE' && !(s.entity_name || '').startsWith('[TEST]'));

  // Metricas globales
  let totalSpend7d = 0, totalRevenue7d = 0, totalPurchases7d = 0;
  const adsetPerformance = [];

  for (const as of activeAdsets) {
    const m = as.metrics?.last_7d || {};
    totalSpend7d += m.spend || 0;
    totalRevenue7d += m.purchase_value || 0;
    totalPurchases7d += m.purchases || 0;
    if ((m.spend || 0) > 5) {
      adsetPerformance.push({
        name: as.entity_name,
        roas: m.roas || 0,
        spend: Math.round(m.spend || 0),
        purchases: m.purchases || 0,
        cpa: m.cpa || 0,
        frequency: m.frequency || 0,
        daily_budget: as.daily_budget || 0
      });
    }
  }
  adsetPerformance.sort((a, b) => b.roas - a.roas);

  const globalRoas = totalSpend7d > 0 ? Math.round((totalRevenue7d / totalSpend7d) * 100) / 100 : 0;
  const globalCpa = totalPurchases7d > 0 ? Math.round((totalSpend7d / totalPurchases7d) * 100) / 100 : 0;

  // Top 5 y bottom 5 ad sets
  const top5 = adsetPerformance.slice(0, 5);
  const bottom5 = adsetPerformance.filter(a => a.roas < 1.5 && a.spend > 20).slice(-5);

  // Resumen de acciones de Athena
  const recentActions = await ActionLog.find({
    success: true,
    executed_at: { $gte: new Date(Date.now() - 7 * 24 * 3600000) }
  }).sort({ executed_at: -1 }).limit(50).lean();

  const actionSummary = {};
  for (const a of recentActions) {
    if (!actionSummary[a.action]) actionSummary[a.action] = { count: 0, successes: 0 };
    actionSummary[a.action].count++;
  }

  // Resumen de tests de Prometheus
  const testStats = await TestRun.aggregate([
    { $group: { _id: '$phase', count: { $sum: 1 } } }
  ]);
  const testMap = {};
  for (const t of testStats) testMap[t._id] = t.count;

  // Pool de Apollo
  const readyCount = await CreativeProposal.countDocuments({ status: 'ready' });

  return {
    account: {
      active_adsets: activeAdsets.length,
      total_spend_7d: Math.round(totalSpend7d),
      total_revenue_7d: Math.round(totalRevenue7d),
      global_roas: globalRoas,
      global_cpa: globalCpa,
      total_purchases_7d: totalPurchases7d,
      top_performers: top5,
      underperformers: bottom5
    },
    athena: { actions_7d: recentActions.length, action_types: actionSummary },
    prometheus: { graduated: testMap.graduated || 0, killed: testMap.killed || 0, expired: testMap.expired || 0, active: (testMap.learning || 0) + (testMap.evaluating || 0) },
    apollo: { ready_pool: readyCount }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 4: GENERAR DIRECTIVAS CON CLAUDE
// ═══════════════════════════════════════════════════════════════════════════════

async function generateDirectives(patterns, signals, accountData, uploadedData, athenaData) {
  // Desactivar directivas viejas (se reemplazan cada ciclo)
  await ZeusDirective.updateMany(
    { active: true, created_at: { $lt: new Date(Date.now() - 48 * 3600000) } },
    { $set: { active: false } }
  );

  // Verificar si hay ALGUN dato para aprender (no solo tests)
  const totalTests = (accountData.prometheus.graduated || 0) + (accountData.prometheus.killed || 0) + (accountData.prometheus.expired || 0);
  const totalDataPoints = totalTests + (uploadedData?.total || 0) + (athenaData?.total || 0) + accountData.athena.actions_7d;
  if (totalDataPoints === 0) {
    logger.info('[ZEUS] Sin datos para aprender — saltando generacion de directivas');
    return 0;
  }

  // Datos de uploaded creativos (legacy con metricas reales)
  const uploadedSection = uploadedData.performers?.length > 0
    ? uploadedData.performers.map(p => `- ${p.scene}: ROAS ${p.avg_roas}x, $${p.total_spend} spend, ${p.purchases} compras, ${p.count} ads`).join('\n')
    : 'Sin datos de uploaded';

  // Datos de acciones de Athena con impacto medido
  const athenaSection = Object.entries(athenaData.action_outcomes || {})
    .map(([action, o]) => `- ${action}: ${o.positive} positivas, ${o.negative} negativas, ${o.neutral} neutral (${o.count} total)`)
    .join('\n') || 'Sin datos medidos';

  // Datos globales de cuenta
  const acct = accountData.account || {};
  const topSection = (acct.top_performers || []).map(a => `- ${a.name}: ROAS ${a.roas.toFixed(2)}x, $${a.spend} spend, ${a.purchases} compras, CPA $${a.cpa.toFixed(0)}, freq ${a.frequency.toFixed(1)}`).join('\n') || 'Sin datos';
  const bottomSection = (acct.underperformers || []).map(a => `- ${a.name}: ROAS ${a.roas.toFixed(2)}x, $${a.spend} spend, ${a.purchases} compras, CPA $${a.cpa.toFixed(0)}, freq ${a.frequency.toFixed(1)}`).join('\n') || 'Ninguno';

  const context = `
## PANORAMA GLOBAL DE LA CUENTA (ultimos 7 dias)
- Ad sets activos (produccion): ${acct.active_adsets || 0}
- Spend total 7d: $${acct.total_spend_7d || 0}
- Revenue total 7d: $${acct.total_revenue_7d || 0}
- ROAS global: ${acct.global_roas || 0}x
- CPA global: $${acct.global_cpa || 0}
- Compras totales 7d: ${acct.total_purchases_7d || 0}

### Top 5 Ad Sets (mejor ROAS)
${topSection}

### Ad Sets con Bajo Rendimiento (ROAS < 1.5x con $20+ spend)
${bottomSection}

## DATOS DE AGENTES

### Patrones Creativos de Tests (Prometheus)
${patterns.patterns?.length > 0 ? patterns.patterns.map(p => `- ${p.scene}: ${p.win_rate}% win rate (${p.wins}W/${p.losses}L), ROAS prom: ${p.avg_roas}x, ${p.samples} tests`).join('\n') : 'Sin datos de tests aun (20 tests en learning day 0)'}

### Performance de Creativos Uploaded (datos reales en produccion)
${uploadedSection}

### Senales Predictivas de Tests
${signals.signals.length > 0 ? signals.signals.map(s => `- ${s.description} (${s.samples} muestras)`).join('\n') : 'Insuficientes datos (tests en fase de learning)'}

### Acciones de Athena con Impacto Medido
${athenaSection}

### Estado de Agentes
- Athena: ${accountData.athena.actions_7d} acciones (7d)
- Prometheus: ${accountData.prometheus.graduated} graduados, ${accountData.prometheus.killed} killed, ${accountData.prometheus.active} activos
- Apollo: ${accountData.apollo.ready_pool} creativos en pool

### Tests totales finalizados: ${totalTests}
### Creativos uploaded con metricas: ${uploadedData.total}
### Acciones de Athena medidas: ${athenaData.total}
`;

  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres Zeus, el cerebro central de un sistema autonomo de Meta Ads para Jersey Pickles (ecommerce food, mercado US, ~$3K/dia).

Tienes 3 agentes:
- Apollo (genera creativos con Gemini + Claude)
- Prometheus (testea creativos en ad sets dedicados $10/dia)
- Athena (gestiona ad sets de produccion: scale, pause, hold)

Tu rol: analizar el PANORAMA COMPLETO de la cuenta + los datos de cada agente, y generar directivas estrategicas. No solo mires tests — mira toda la cuenta.

Basado en los datos, genera directivas para los agentes.

${context}

Responde SOLO en JSON:
{
  "directives": [
    {
      "target_agent": "apollo|prometheus|athena|all",
      "directive_type": "prioritize|avoid|adjust|alert",
      "directive": "texto corto y accionable",
      "category": "creative_pattern|test_signal|account_pattern|cross_agent",
      "confidence": 0.0-1.0,
      "data": {
        "scenes": ["first 40 chars of scene text that should be boosted/avoided"],
        "styles": ["ugly-ad|pov-selfie|overhead-flat|close-up-texture|action-shot"],
        "angles": ["casual-fun|curiosity|social-proof|urgency|humor|controversy|sensory"]
      }
    }
  ],
  "thoughts": [
    "Pensamiento 1 — algo que descubriste analizando los datos",
    "Pensamiento 2 — un patron interesante que notaste",
    "Pensamiento 3 — una hipotesis que quieres validar"
  ],
  "intelligence_summary": "resumen de 2-3 lineas de lo que aprendiste"
}

Reglas:
- Max 5 directivas por ciclo
- Solo genera directivas con confianza > 0.4
- Basate en datos reales, no inventes
- Si no hay datos suficientes para una directiva, no la generes
- Prioriza directivas accionables
- IMPORTANTE para Apollo: en "data" incluye los keys exactos. Para scenes usa los primeros 40 chars del texto de la escena. Para styles usa: ugly-ad, pov-selfie, overhead-flat, close-up-texture, action-shot. Para angles usa: casual-fun, curiosity, social-proof, urgency, humor, controversy, sensory.
- Si no tienes datos para "scenes", "styles" o "angles", omite esos campos de data
- En "thoughts": habla en primera persona como Zeus. Ej: "Noto que las escenas outdoor tienen 3x mas graduaciones que indoor", "Los tests que convierten en 48h casi siempre graduan", "Athena escalo 3 ad sets esta semana y 2 mejoraron"
- Max 5 thoughts, sé especifico con datos reales`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[ZEUS] Claude no devolvio JSON valido');
      return 0;
    }

    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Intentar limpiar JSON malformado (comillas sin escapar, trailing commas)
      let cleaned = jsonMatch[0]
        .replace(/,\s*([}\]])/g, '$1')  // trailing commas
        .replace(/[\x00-\x1f]/g, ' '); // control chars
      try {
        result = JSON.parse(cleaned);
      } catch (_) {
        logger.error(`[ZEUS] JSON parse error: ${parseErr.message}. Raw: ${jsonMatch[0].substring(0, 200)}...`);
        return 0;
      }
    }
    let created = 0;

    for (const d of (result.directives || [])) {
      if (d.confidence < 0.4) continue;

      await ZeusDirective.create({
        target_agent: d.target_agent,
        directive_type: d.directive_type,
        directive: d.directive,
        data: d.data || {},
        confidence: d.confidence,
        based_on_samples: totalDataPoints,
        category: d.category || 'general',
        active: true,
        expires_at: new Date(Date.now() + 72 * 3600000) // expira en 72h
      });
      created++;
    }

    // Guardar pensamientos como BrainInsights (stream de consciencia de Zeus)
    const thoughts = result.thoughts || [];
    for (const thought of thoughts) {
      await BrainInsight.create({
        insight_type: 'brain_thinking',
        severity: 'info',
        title: `⚡ Zeus: ${thought.substring(0, 80)}${thought.length > 80 ? '...' : ''}`,
        body: thought,
        generated_by: 'zeus',
        entities: [],
        data_points: { source: 'zeus_learner', directives_created: created, total_tests: totalTests }
      });
    }
    if (thoughts.length > 0) {
      logger.info(`[ZEUS] ${thoughts.length} pensamientos guardados`);
    }

    // Guardar summary en SystemConfig
    await SystemConfig.set('zeus_intelligence_summary', {
      summary: result.intelligence_summary || '',
      updated_at: new Date(),
      patterns_count: patterns.patterns?.length || 0,
      total_tests: totalTests,
      thoughts_count: thoughts.length
    });

    return created;

  } catch (err) {
    logger.error(`[ZEUS] Error generando directivas con Claude: ${err.message}`);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN ZEUS LEARNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runZeusLearner() {
  const startTime = Date.now();
  const cycleId = `zeus_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Zeus Learner [${cycleId}] ═══`);

  // Fase 1: Aprender patrones creativos (de tests de Prometheus)
  const patterns = await learnCreativePatterns();
  logger.info(`[ZEUS] Patrones de tests: ${patterns.tests_processed} tests procesados`);

  // Fase 2: Aprender senales de tests
  const signals = await learnTestSignals();
  logger.info(`[ZEUS] Senales de test: ${signals.signals.length} senales, ${signals.total_tests} tests analizados`);

  // Fase 2.5: Aprender de creativos uploaded (legacy con metricas reales)
  const uploadedData = await learnFromUploadedCreatives();
  logger.info(`[ZEUS] Creativos uploaded: ${uploadedData.total} con metricas, ${uploadedData.performers?.length || 0} escenas`);

  // Fase 2.6: Aprender de acciones de Athena
  const athenaData = await learnFromAthenaActions();
  logger.info(`[ZEUS] Acciones de Athena: ${athenaData.total} medidas`);

  // Fase 3: Datos de cuenta
  const accountData = await gatherAccountIntelligence();

  // Fase 4: Generar directivas + pensamientos (Claude)
  const directivesCreated = await generateDirectives(patterns, signals, accountData, uploadedData, athenaData);
  logger.info(`[ZEUS] Directivas generadas: ${directivesCreated}`);

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Zeus Learner completado [${cycleId}]: ${patterns.tests_processed} tests aprendidos, ${directivesCreated} directivas — ${elapsed} ═══`);

  return {
    patterns_learned: patterns.patterns?.length || 0,
    tests_processed: patterns.tests_processed,
    signals: signals.signals.length,
    directives_generated: directivesCreated,
    account_data: accountData,
    elapsed,
    cycle_id: cycleId
  };
}

module.exports = { runZeusLearner };
