const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const ActionLog = require('../../db/models/ActionLog');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const ZeusDirective = require('../../db/models/ZeusDirective');
const BrainInsight = require('../../db/models/BrainInsight');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

const CACHE_KEY = 'brain_briefing_cache';
const CACHE_TTL_MIN = 15;
// Cache de context separado — mucho más corto (60s) que el briefing porque el
// NCC polle cada 30s y necesita data razonablemente fresca. Antes se
// re-ejecutaba gatherSystemContext() completo en cada request (19s p99 real)
// por 2 queries costosas sin índices (adsetMetrics con regex = 10.7s,
// strategyBreakdown aggregate = 7.1s). Cache 60s = cache hit ~50ms.
const CONTEXT_CACHE_KEY = 'brain_briefing_context_cache';
const CONTEXT_CACHE_TTL_SEC = 60;

async function getContextCached() {
  try {
    const cached = await SystemConfig.get(CONTEXT_CACHE_KEY, null);
    if (cached && cached.generated_at) {
      const ageSec = (Date.now() - new Date(cached.generated_at).getTime()) / 1000;
      if (ageSec < CONTEXT_CACHE_TTL_SEC) {
        return { context: cached.context, from_cache: true, age_sec: Math.round(ageSec) };
      }
    }
  } catch (_) { /* cache miss → regenerar */ }

  const context = await gatherSystemContext();
  try {
    await SystemConfig.set(CONTEXT_CACHE_KEY, {
      context,
      generated_at: new Date().toISOString()
    }, 'briefing');
  } catch (_) { /* silent — no bloquear response si cache set falla */ }
  return { context, from_cache: false, age_sec: 0 };
}

async function gatherSystemContext() {
  const now = Date.now();
  const DAY = 86400000;

  // Actions last 24h
  const actionsBy = await ActionLog.aggregate([
    { $match: { executed_at: { $gte: new Date(now - DAY) }, success: true } },
    { $group: { _id: '$agent_type', actions: { $sum: 1 }, last: { $max: '$executed_at' } } }
  ]);

  // Zeus directives last 24h
  const zeusDirs = await ZeusDirective.find({ created_at: { $gte: new Date(now - DAY) } }).lean();
  const zeusDirsExec = zeusDirs.filter(d => d.executed).length;
  const zeusCycles = new Set(zeusDirs.map(d => {
    const d2 = new Date(d.created_at);
    return Math.floor(d2.getTime() / (6 * 3600000));
  })).size;

  // Account metrics hoy + 7d
  const adsetSnapshots = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', snapshot_at: { $gte: new Date(now - DAY) } } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      status: { $first: '$status' },
      spend_today: { $first: '$metrics.today.spend' },
      revenue_today: { $first: '$metrics.today.purchase_value' },
      spend_7d: { $first: '$metrics.last_7d.spend' },
      revenue_7d: { $first: '$metrics.last_7d.purchase_value' }
    }},
    { $match: { status: 'ACTIVE' } }
  ]);

  const todaySpend = adsetSnapshots.reduce((s, a) => s + (a.spend_today || 0), 0);
  const todayRev = adsetSnapshots.reduce((s, a) => s + (a.revenue_today || 0), 0);
  const spend7d = adsetSnapshots.reduce((s, a) => s + (a.spend_7d || 0), 0);
  const rev7d = adsetSnapshots.reduce((s, a) => s + (a.revenue_7d || 0), 0);
  const roas_today = todaySpend > 0 ? todayRev / todaySpend : 0;
  const roas_7d = spend7d > 0 ? rev7d / spend7d : 0;

  // Tests outcomes last 24h
  const testsLast24h = await TestRun.countDocuments({
    $or: [
      { graduated_at: { $gte: new Date(now - DAY) } },
      { killed_at: { $gte: new Date(now - DAY) } },
      { expired_at: { $gte: new Date(now - DAY) } }
    ]
  });
  const graduatedLast24h = await TestRun.countDocuments({ graduated_at: { $gte: new Date(now - DAY) } });
  const killedLast24h = await TestRun.countDocuments({ killed_at: { $gte: new Date(now - DAY) } });

  // Graduates cohort — closest to SUCCESS
  const activeTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } }).lean();

  // Pickled Heat type progress — top closest to SUCCESS
  const adsetMetrics = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'adset', entity_name: { $regex: '\\[Prometheus\\]' } } },
    { $sort: { snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      name: { $first: '$entity_name' },
      stage: { $first: '$learning_stage' },
      conv: { $first: '$learning_stage_conversions' },
      roas_7d: { $first: '$metrics.last_7d.roas' }
    }},
    { $match: { stage: 'LEARNING' } },
    { $sort: { conv: -1 } },
    { $limit: 5 }
  ]);

  // Pending recommendations / alerts
  const activeDirectives = await ZeusDirective.find({ active: true, executed: false }).lean();

  // Apollo pool
  const readyPool = await CreativeProposal.countDocuments({ status: 'ready' });

  // Proposals strategy breakdown 7d
  const strategyBreakdown = await CreativeProposal.aggregate([
    { $match: { created_at: { $gte: new Date(now - 7 * DAY) } } },
    { $group: { _id: '$evolution_strategy', count: { $sum: 1 } } }
  ]);

  return {
    zeus: {
      cycles_24h: zeusCycles,
      directives_24h: zeusDirs.length,
      executed_24h: zeusDirsExec,
      active_pending: activeDirectives.length
    },
    agents: actionsBy.reduce((acc, a) => { acc[a._id || 'unknown'] = { actions: a.actions, last: a.last }; return acc; }, {}),
    account: {
      spend_today: Math.round(todaySpend),
      revenue_today: Math.round(todayRev),
      roas_today: roas_today.toFixed(2),
      spend_7d: Math.round(spend7d),
      revenue_7d: Math.round(rev7d),
      roas_7d: roas_7d.toFixed(2),
      active_adsets: adsetSnapshots.length
    },
    prometheus: {
      tests_resolved_24h: testsLast24h,
      graduated_24h: graduatedLast24h,
      killed_24h: killedLast24h,
      active_tests: activeTests.length
    },
    graduates_closest_success: adsetMetrics.map(a => ({
      name: a.name,
      conv: a.conv || 0,
      needed: 50 - (a.conv || 0),
      roas: (a.roas_7d || 0).toFixed(2)
    })),
    apollo: {
      ready_pool: readyPool,
      strategy_last_7d: strategyBreakdown.reduce((acc, s) => { acc[s._id || 'random'] = s.count; return acc; }, {})
    }
  };
}

async function generateBriefing(context) {
  const now = new Date();
  const hourET = parseInt(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  const greeting = hourET < 6 ? 'madrugada' : hourET < 12 ? 'buen día' : hourET < 18 ? 'buena tarde' : 'buenas noches';

  const prompt = `Eres el asistente personal de Cristopher. Generas un briefing matutino del sistema autónomo de Meta Ads de Jersey Pickles.

Tu estilo:
- Conversacional, breve, directo
- Como asistente personal de confianza, no robot
- Español natural, no traducido
- Prioriza lo importante, no listes todo

Contexto del sistema (últimas 24h):

CUENTA HOY:
- Spend: $${context.account.spend_today}
- Revenue: $${context.account.revenue_today}
- ROAS hoy: ${context.account.roas_today}x
- ROAS 7d: ${context.account.roas_7d}x
- Ad sets activos: ${context.account.active_adsets}

ZEUS (CEO):
- Ciclos corridos: ${context.zeus.cycles_24h}
- Directivas emitidas: ${context.zeus.directives_24h}
- Ejecutadas: ${context.zeus.executed_24h}
- Pendientes: ${context.zeus.active_pending}

PROMETHEUS (testing):
- Tests resueltos: ${context.prometheus.tests_resolved_24h}
- Graduados: ${context.prometheus.graduated_24h}
- Matados: ${context.prometheus.killed_24h}
- Activos: ${context.prometheus.active_tests}

APOLLO (creativos):
- Pool ready: ${context.apollo.ready_pool}
- Strategy mix 7d: ${JSON.stringify(context.apollo.strategy_last_7d)}

GRADUATES MÁS CERCA DE SUCCESS:
${context.graduates_closest_success.map(g => `- ${g.name}: ${g.conv}/50 conv, ROAS ${g.roas}x`).join('\n')}

AGENTES ACCIONES 24H:
${Object.entries(context.agents).map(([k, v]) => `- ${k}: ${v.actions} acciones`).join('\n')}

Genera el briefing con este formato JSON exacto (sin backticks, solo JSON válido):

{
  "greeting": "${greeting}, Cristopher",
  "summary_line": "Una línea que capture el día en 15-20 palabras",
  "overnight_events": [
    "3-5 eventos relevantes de lo que pasó en las últimas horas",
    "usa emojis sutiles: 💭 🦉 ☀️ 🔥 ⚔️ ⚡",
    "menciona números concretos",
    "máximo 12 palabras por evento"
  ],
  "key_metrics": [
    { "label": "Revenue hoy", "value": "$X", "trend": "up/down/flat/neutral" },
    { "label": "ROAS 7d", "value": "Xx", "trend": "up/down" }
  ],
  "attention_items": [
    "1-3 cosas que requieren tu atención, con contexto breve"
  ],
  "zeus_today": [
    "1-2 predicciones de qué decidirá Zeus hoy, basado en datos"
  ],
  "mood": "positive/neutral/cautious/alert"
}`;

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in briefing response');
  return JSON.parse(jsonMatch[0]);
}

// GET /api/brain/briefing — morning briefing (cached 15min) + context (cached 60s)
router.get('/briefing', async (req, res) => {
  try {
    const cached = await SystemConfig.get(CACHE_KEY, null);
    if (cached && cached.generated_at) {
      const ageMin = (Date.now() - new Date(cached.generated_at).getTime()) / 60000;
      if (ageMin < CACHE_TTL_MIN && !req.query.force) {
        // Briefing cached 15min OK. Context usa su propio cache 60s — antes
        // re-ejecutaba gatherSystemContext() cada llamada (19s real), ahora
        // hit cache ~50ms cuando NCC polle cada 30s.
        const { context: freshContext } = await getContextCached().catch(() => ({ context: cached.context }));
        return res.json({
          ...cached.briefing,
          context: freshContext || cached.context,
          from_cache: true,
          age_min: Math.round(ageMin)
        });
      }
    }

    // Cache miss full: regenerar briefing + context (context usa su cache
    // interno si otra request en paralelo ya lo pobló).
    const { context } = await getContextCached();
    const briefing = await generateBriefing(context);

    await SystemConfig.set(CACHE_KEY, {
      briefing,
      context,
      generated_at: new Date().toISOString()
    }, 'briefing');

    res.json({ ...briefing, from_cache: false, context });
  } catch (err) {
    logger.error(`[BRIEFING] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
