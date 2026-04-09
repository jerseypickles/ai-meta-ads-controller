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

  // ═══ DATOS GLOBALES DE LA CUENTA — TODAS LAS METRICAS ═══
  const allAdsets = await getLatestSnapshots('adset');
  const excludeNames = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'DONT_TOUCH', 'EXCLUDE', 'MANUAL ONLY'];
  const activeAdsets = allAdsets.filter(s => s.status === 'ACTIVE' && !excludeNames.some(ex => (s.entity_name || '').toUpperCase().includes(ex.toUpperCase())));

  // Agregar metricas globales por ventana (7d y 3d para tendencia)
  let g7d = { spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0, reach: 0 };
  let g3d = { spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0, reach: 0 };
  const adsetPerformance = [];

  for (const as of activeAdsets) {
    const m7 = as.metrics?.last_7d || {};
    const m3 = as.metrics?.last_3d || {};
    g7d.spend += m7.spend || 0;
    g7d.revenue += m7.purchase_value || 0;
    g7d.purchases += m7.purchases || 0;
    g7d.impressions += m7.impressions || 0;
    g7d.clicks += m7.clicks || 0;
    g7d.reach += m7.reach || 0;
    g3d.spend += m3.spend || 0;
    g3d.revenue += m3.purchase_value || 0;
    g3d.purchases += m3.purchases || 0;

    if ((m7.spend || 0) > 5) {
      adsetPerformance.push({
        name: as.entity_name,
        roas_7d: (m7.roas || 0).toFixed(2),
        roas_3d: (m3.roas || 0).toFixed(2),
        spend_7d: Math.round(m7.spend || 0),
        purchases_7d: m7.purchases || 0,
        cpa_7d: (m7.cpa || 0).toFixed(0),
        ctr_7d: (m7.ctr || 0).toFixed(2),
        cpm_7d: (m7.cpm || 0).toFixed(0),
        frequency_7d: (m7.frequency || 0).toFixed(1),
        daily_budget: as.daily_budget || 0,
        trend: as.analysis?.roas_trend || 'stable'
      });
    }
  }
  adsetPerformance.sort((a, b) => parseFloat(b.roas_7d) - parseFloat(a.roas_7d));

  // Metricas globales calculadas
  const globalRoas7d = g7d.spend > 0 ? (g7d.revenue / g7d.spend).toFixed(2) : '0';
  const globalRoas3d = g3d.spend > 0 ? (g3d.revenue / g3d.spend).toFixed(2) : '0';
  const globalCpa = g7d.purchases > 0 ? (g7d.spend / g7d.purchases).toFixed(0) : '0';
  const globalCtr = g7d.clicks > 0 && g7d.impressions > 0 ? ((g7d.clicks / g7d.impressions) * 100).toFixed(2) : '0';
  const globalCpm = g7d.impressions > 0 ? ((g7d.spend / g7d.impressions) * 1000).toFixed(0) : '0';
  const globalFreq = g7d.reach > 0 ? (g7d.impressions / g7d.reach).toFixed(1) : '0';
  const roasTrend = parseFloat(globalRoas3d) > parseFloat(globalRoas7d) * 1.05 ? 'MEJORANDO' : parseFloat(globalRoas3d) < parseFloat(globalRoas7d) * 0.95 ? 'BAJANDO' : 'ESTABLE';

  // Top y bottom
  const top5 = adsetPerformance.slice(0, 5);
  const bottom5 = adsetPerformance.filter(a => parseFloat(a.roas_7d) < 1.5 && a.spend_7d > 20).slice(-5);
  // Ad sets con frequency alta (quemando audiencia)
  const highFreq = adsetPerformance.filter(a => parseFloat(a.frequency_7d) >= 2.5);
  // Ad sets con CTR baja (creativos no enganchan)
  const lowCtr = adsetPerformance.filter(a => parseFloat(a.ctr_7d) < 0.8 && a.spend_7d > 30);
  // Total budget diario
  const totalDailyBudget = activeAdsets.reduce((s, a) => s + (a.daily_budget || 0), 0);

  // Funnel data global
  let totalAtc = 0, totalIc = 0;
  for (const as of activeAdsets) {
    totalAtc += as.metrics?.last_7d?.add_to_cart || 0;
    totalIc += as.metrics?.last_7d?.initiate_checkout || 0;
  }
  const clickToAtc = g7d.clicks > 0 ? ((totalAtc / g7d.clicks) * 100).toFixed(1) : '0';
  const atcToPurchase = totalAtc > 0 ? ((g7d.purchases / totalAtc) * 100).toFixed(1) : '0';

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
      total_daily_budget: Math.round(totalDailyBudget),
      spend_7d: Math.round(g7d.spend),
      revenue_7d: Math.round(g7d.revenue),
      purchases_7d: g7d.purchases,
      roas_7d: globalRoas7d,
      roas_3d: globalRoas3d,
      roas_trend: roasTrend,
      cpa: globalCpa,
      ctr: globalCtr,
      cpm: globalCpm,
      frequency: globalFreq,
      impressions_7d: g7d.impressions,
      reach_7d: g7d.reach,
      top_performers: top5,
      underperformers: bottom5,
      high_frequency: highFreq,
      low_ctr: lowCtr,
      atc_7d: totalAtc,
      ic_7d: totalIc,
      click_to_atc: clickToAtc,
      atc_to_purchase: atcToPurchase
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
  // Desactivar TODAS las directivas anteriores — cada ciclo reemplaza completamente
  await ZeusDirective.updateMany(
    { active: true },
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
  const fmtAdset = (a) => `- ${a.name}: ROAS ${a.roas_7d}x (3d: ${a.roas_3d}x ${a.trend}), $${a.spend_7d} spend, ${a.purchases_7d} compras, CPA $${a.cpa_7d}, CTR ${a.ctr_7d}%, freq ${a.frequency_7d}, budget $${a.daily_budget}/d`;
  const topSection = (acct.top_performers || []).map(fmtAdset).join('\n') || 'Sin datos';
  const bottomSection = (acct.underperformers || []).map(fmtAdset).join('\n') || 'Ninguno';
  const highFreqSection = (acct.high_frequency || []).map(a => `- ${a.name}: freq ${a.frequency_7d} (QUEMANDO AUDIENCIA), ROAS ${a.roas_7d}x`).join('\n') || 'Ninguno';
  const lowCtrSection = (acct.low_ctr || []).map(a => `- ${a.name}: CTR ${a.ctr_7d}% (CREATIVOS NO ENGANCHAN), $${a.spend_7d} spend`).join('\n') || 'Ninguno';

  const context = `
## PANORAMA FINANCIERO DE LA CUENTA (ultimos 7 dias)

### Metricas Globales
| Metrica | Valor 7d | Valor 3d | Tendencia |
|---------|----------|----------|-----------|
| ROAS | ${acct.roas_7d || 0}x | ${acct.roas_3d || 0}x | ${acct.roas_trend || 'N/A'} |
| Spend | $${acct.spend_7d || 0} | — | — |
| Revenue | $${acct.revenue_7d || 0} | — | — |
| Compras | ${acct.purchases_7d || 0} | — | — |
| CPA | $${acct.cpa || 0} | — | Target: $25 |
| CTR | ${acct.ctr || 0}% | — | Min: 1.0% |
| CPM | $${acct.cpm || 0} | — | — |
| Frequency | ${acct.frequency || 0} | — | Warning: 2.5, Critico: 4.0 |
| Reach 7d | ${acct.reach_7d || 0} | — | — |
| Add to Cart 7d | ${acct.atc_7d || 0} | — | — |
| Initiate Checkout 7d | ${acct.ic_7d || 0} | — | — |
| Click→ATC rate | ${acct.click_to_atc || 0}% | — | — |
| ATC→Purchase rate | ${acct.atc_to_purchase || 0}% | — | — |
| Ad sets activos | ${acct.active_adsets || 0} | — | — |
| Budget diario total | $${acct.total_daily_budget || 0}/dia | — | — |

### Top 5 Ad Sets (mejor ROAS)
${topSection}

### Ad Sets con Bajo Rendimiento (ROAS < 1.5x, $20+ spend)
${bottomSection}

### Ad Sets con Frequency Alta (quemando audiencia, freq >= 2.5)
${highFreqSection}

### Ad Sets con CTR Baja (creativos no enganchan, CTR < 0.8%)
${lowCtrSection}

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

## YOUR PREVIOUS DIRECTIVES (what you said last cycle)
${await (async () => {
  const prevDirectives = await ZeusDirective.find({ active: false }).sort({ created_at: -1 }).limit(5).lean();
  if (prevDirectives.length === 0) return 'No previous directives (first cycle or reset).';
  return prevDirectives.map(d => `- [${d.directive_type.toUpperCase()}] ${d.target_agent}: ${d.directive}`).join('\n');
})()}

## AGENT REPORTS SINCE LAST CYCLE (what they did with your directives)
${await (async () => {
  const ZeusConversation = require('../../db/models/ZeusConversation');
  const reports = await ZeusConversation.find({ type: 'report' }).sort({ created_at: -1 }).limit(6).lean();
  if (reports.length === 0) return 'No agent reports yet.';
  return reports.map(r => `- ${r.from}: ${r.message.substring(0, 120)}`).join('\n');
})()}

Based on your previous directives AND agent reports, generate UPDATED directives. If an agent already executed what you asked, move on. If they didnt, insist or adjust.

${context}

Return ONLY valid JSON. Keep ALL strings SHORT (max 80 chars). Use English only. No special characters. No quotes inside strings.

{
  "directives": [
    {
      "target_agent": "athena",
      "directive_type": "prioritize",
      "directive": "short action max 80 chars",
      "category": "account_pattern",
      "confidence": 0.8,
      "data": {}
    }
  ],
  "thoughts": [
    "short thought max 80 chars",
    "another thought max 80 chars"
  ],
  "intelligence_summary": "2 sentence summary max 150 chars"
}

Rules:
- Max 5 directives. Only confidence > 0.4.
- target_agent: athena, apollo, prometheus, or all
- directive_type: prioritize, avoid, adjust, or alert
- CRITICAL SAFETY: NEVER recommend pausing/killing an ad set unless it has $200+ spend 7d AND ROAS < 1.0x across ALL windows (today, 3d, 7d). If today ROAS is improving, recommend HOLD not pause. Low data = hold, not kill.
- NEVER make aggressive decisions based on 1-3 days of data alone. Always check 7d AND 14d trends.
- If 3d ROAS is better than 7d, the ad set is IMPROVING — do not pause it.
- SCALING SAFETY: Meta resets learning phase when budget changes >20%. NEVER say scale aggressively. Max recommend is +15% per action. Multiple small increases over days is better than one big jump.
- REDISTRIBUTION: When an old ad set dies (fatigued ad paused), its budget is NOT auto-redistributed (ABO not CBO). You must plan gradual scaling of [Prometheus] graduated ad sets to absorb the lost budget. Example: old ad set had $100/d → scale 3 [Prometheus] by +15% each over 2 weeks. Never dump budget all at once.
- KILL SAFETY: Athena should only kill a fatigued ad if the account has 10+ active ad sets with ROAS > 2x. Never leave the account short on capacity.
- For Apollo data field, include: scenes (first 40 chars), styles (ugly-ad/pov-selfie/overhead-flat/close-up-texture/action-shot), angles (casual-fun/curiosity/social-proof/urgency/humor/controversy/sensory)
- Max 5 thoughts. First person. Specific with real numbers.
- ALL strings must be short. No line breaks inside strings. No double quotes inside strings.`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[ZEUS] Claude no devolvio JSON valido');
      return 0;
    }

    let result;
    const rawJson = jsonMatch[0];

    // Intentar parsear con multiples estrategias de limpieza
    const cleanStrategies = [
      (s) => s, // sin cambios
      (s) => s.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]/g, ' '), // trailing commas + control chars
      (s) => s.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]/g, ' ').replace(/(?<!\\)"/g, (m, offset, str) => {
        // Solo reemplazar comillas problemáticas dentro de strings (no las estructurales)
        return m;
      }),
      (s) => {
        // Estrategia agresiva: extraer arrays de directives y thoughts por separado
        try {
          const directivesMatch = s.match(/"directives"\s*:\s*\[([\s\S]*?)\]/);
          const thoughtsMatch = s.match(/"thoughts"\s*:\s*\[([\s\S]*?)\]/);
          const summaryMatch = s.match(/"intelligence_summary"\s*:\s*"([\s\S]*?)"/);
          return JSON.stringify({
            directives: directivesMatch ? JSON.parse('[' + directivesMatch[1] + ']') : [],
            thoughts: thoughtsMatch ? thoughtsMatch[1].split(/",\s*"/).map(t => t.replace(/^"|"$/g, '').trim()).filter(Boolean) : [],
            intelligence_summary: summaryMatch ? summaryMatch[1] : ''
          });
        } catch (_) { return s; }
      }
    ];

    for (let i = 0; i < cleanStrategies.length; i++) {
      try {
        const cleaned = cleanStrategies[i](rawJson);
        result = JSON.parse(cleaned);
        if (i > 0) logger.info(`[ZEUS] JSON parseado con estrategia ${i + 1}`);
        break;
      } catch (e) {
        if (i === cleanStrategies.length - 1) {
          logger.error(`[ZEUS] JSON parse error tras ${cleanStrategies.length} estrategias: ${e.message}. Raw: ${rawJson.substring(0, 300)}...`);
          return 0;
        }
      }
    }
    let created = 0;

    const VALID_CATEGORIES = ['creative_pattern', 'test_signal', 'account_pattern', 'cross_agent', 'general'];
    const VALID_TARGETS = ['apollo', 'prometheus', 'athena', 'all'];
    const VALID_TYPES = ['prioritize', 'avoid', 'adjust', 'alert', 'insight'];

    for (const d of (result.directives || [])) {
      if (d.confidence < 0.4) continue;

      try {
        await ZeusDirective.create({
          target_agent: VALID_TARGETS.includes(d.target_agent) ? d.target_agent : 'all',
          directive_type: VALID_TYPES.includes(d.directive_type) ? d.directive_type : 'alert',
          directive: (d.directive || '').substring(0, 200),
          data: d.data || {},
          confidence: Math.min(1, Math.max(0, d.confidence || 0.5)),
          based_on_samples: totalDataPoints,
          category: VALID_CATEGORIES.includes(d.category) ? d.category : 'general',
          active: true,
          expires_at: new Date(Date.now() + 72 * 3600000)
        });
      } catch (createErr) {
        logger.warn(`[ZEUS] Error guardando directiva: ${createErr.message}. Saltando.`);
        continue;
      }
      created++;
    }

    // Guardar pensamientos como BrainInsights (stream de consciencia de Zeus)
    const ZeusConversation = require('../../db/models/ZeusConversation');
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
      // Tambien como conversacion
      await ZeusConversation.create({
        from: 'zeus', to: 'all', type: 'thought', message: thought
      });
    }

    // Registrar directivas como conversaciones
    for (const d of (result.directives || [])) {
      if (d.confidence < 0.4) continue;
      await ZeusConversation.create({
        from: 'zeus', to: d.target_agent, type: 'directive',
        message: `[${d.directive_type.toUpperCase()}] ${d.directive}`,
        context: d.data || {}
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
