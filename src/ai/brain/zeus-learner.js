const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const BrainMemory = require('../../db/models/BrainMemory');
const ZeusDirective = require('../../db/models/ZeusDirective');
const MetricSnapshot = require('../../db/models/MetricSnapshot');

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
// FASE 3: AGREGAR DATOS DE CUENTA
// ═══════════════════════════════════════════════════════════════════════════════

async function gatherAccountIntelligence() {
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
    athena: { actions_7d: recentActions.length, action_types: actionSummary },
    prometheus: { graduated: testMap.graduated || 0, killed: testMap.killed || 0, expired: testMap.expired || 0, active: (testMap.learning || 0) + (testMap.evaluating || 0) },
    apollo: { ready_pool: readyCount }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 4: GENERAR DIRECTIVAS CON CLAUDE
// ═══════════════════════════════════════════════════════════════════════════════

async function generateDirectives(patterns, signals, accountData) {
  // Desactivar directivas viejas (se reemplazan cada ciclo)
  await ZeusDirective.updateMany(
    { active: true, created_at: { $lt: new Date(Date.now() - 48 * 3600000) } },
    { $set: { active: false } }
  );

  // Si no hay suficientes datos, no generar
  const totalTests = (accountData.prometheus.graduated || 0) + (accountData.prometheus.killed || 0) + (accountData.prometheus.expired || 0);
  if (totalTests < 3) {
    logger.info('[ZEUS] Insuficientes datos para generar directivas (< 3 tests finalizados)');
    return 0;
  }

  const context = `
## DATOS DE APRENDIZAJE DEL SISTEMA

### Patrones Creativos (escenas)
${patterns.patterns.length > 0 ? patterns.patterns.map(p => `- ${p.scene}: ${p.win_rate}% win rate (${p.wins}W/${p.losses}L), ROAS prom: ${p.avg_roas}x, ${p.samples} tests`).join('\n') : 'Sin datos suficientes'}

### Senales de Tests
${signals.signals.length > 0 ? signals.signals.map(s => `- ${s.description} (${s.samples} muestras)`).join('\n') : 'Sin datos suficientes'}

### Estado de Agentes (ultimos 7 dias)
- Athena: ${accountData.athena.actions_7d} acciones ejecutadas
- Prometheus: ${accountData.prometheus.graduated} graduados, ${accountData.prometheus.killed} killed, ${accountData.prometheus.active} activos
- Apollo: ${accountData.apollo.ready_pool} creativos en pool

### Tests totales finalizados: ${totalTests}
`;

  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres Zeus, el cerebro central de un sistema de Meta Ads con 3 agentes:
- Apollo (genera creativos con Gemini)
- Prometheus (testea creativos en ad sets dedicados)
- Athena (gestiona ad sets de produccion)

Basado en los datos de aprendizaje, genera directivas para los agentes.

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
      "data": {}
    }
  ],
  "intelligence_summary": "resumen de 2-3 lineas de lo que aprendiste"
}

Reglas:
- Max 5 directivas por ciclo
- Solo genera directivas con confianza > 0.4
- Basate en datos reales, no inventes
- Si no hay datos suficientes para una directiva, no la generes
- Prioriza directivas accionables`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return 0;

    const result = JSON.parse(jsonMatch[0]);
    let created = 0;

    for (const d of (result.directives || [])) {
      if (d.confidence < 0.4) continue;

      await ZeusDirective.create({
        target_agent: d.target_agent,
        directive_type: d.directive_type,
        directive: d.directive,
        data: d.data || {},
        confidence: d.confidence,
        based_on_samples: totalTests,
        category: d.category || 'general',
        active: true,
        expires_at: new Date(Date.now() + 72 * 3600000) // expira en 72h
      });
      created++;
    }

    // Guardar summary en SystemConfig
    if (result.intelligence_summary) {
      const SystemConfig = require('../../db/models/SystemConfig');
      await SystemConfig.set('zeus_intelligence_summary', {
        summary: result.intelligence_summary,
        updated_at: new Date(),
        patterns_count: patterns.patterns?.length || 0,
        total_tests: totalTests
      });
    }

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

  // Fase 1: Aprender patrones creativos
  const patterns = await learnCreativePatterns();
  logger.info(`[ZEUS] Patrones creativos: ${patterns.tests_processed} tests procesados`);

  // Fase 2: Aprender senales de tests
  const signals = await learnTestSignals();
  logger.info(`[ZEUS] Senales de test: ${signals.signals.length} senales, ${signals.total_tests} tests analizados`);

  // Fase 3: Datos de cuenta
  const accountData = await gatherAccountIntelligence();

  // Fase 4: Generar directivas
  const directivesCreated = await generateDirectives(patterns, signals, accountData);
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
