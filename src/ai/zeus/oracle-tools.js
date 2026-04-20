/**
 * Zeus Oracle Tools — 9 tools read-only que Claude puede invocar para consultar
 * la base de datos durante una conversación con el creador.
 */
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const TestRun = require('../../db/models/TestRun');
const CreativeDNA = require('../../db/models/CreativeDNA');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const ZeusDirective = require('../../db/models/ZeusDirective');
const BrainInsight = require('../../db/models/BrainInsight');
const SystemConfig = require('../../db/models/SystemConfig');
const { getLatestSnapshots } = require('../../db/queries');

// ═══════════════════════════════════════════════════════════════════════════
// Tool definitions (Anthropic format)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  {
    name: 'query_portfolio',
    description: 'Devuelve un snapshot agregado del portfolio: spend/revenue/ROAS/CPA últimos 1d/3d/7d/14d + conteo de ad sets activos por campaña.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'query_adsets',
    description: 'Lista ad sets filtrados por rango de ROAS, spend mínimo, o nombre. Devuelve métricas 7d + status.',
    input_schema: {
      type: 'object',
      properties: {
        min_roas: { type: 'number', description: 'ROAS mínimo 7d' },
        max_roas: { type: 'number', description: 'ROAS máximo 7d' },
        min_spend_7d: { type: 'number', description: 'Spend mínimo últimos 7 días' },
        name_contains: { type: 'string', description: 'Substring en el nombre (case-insensitive)' },
        sort_by: { type: 'string', enum: ['roas', 'spend', 'purchases', 'frequency'], default: 'roas' },
        limit: { type: 'number', default: 20, description: 'Máximo 50' }
      },
      required: []
    }
  },
  {
    name: 'query_tests',
    description: 'Lista TestRuns de Prometheus por fase (learning/evaluating/graduated/killed/expired). Incluye métricas y assessments.',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['learning', 'evaluating', 'graduated', 'killed', 'expired', 'active'] },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_dnas',
    description: 'Top DNAs de Apollo ordenados por fitness (ROAS × confidence × recency). Muestra qué combos creativos ganan.',
    input_schema: {
      type: 'object',
      properties: {
        min_samples: { type: 'number', default: 2, description: 'Mínimo de tests por DNA' },
        sort_by: { type: 'string', enum: ['roas', 'score', 'win_rate', 'generation'], default: 'score' },
        limit: { type: 'number', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'query_actions',
    description: 'ActionLog: acciones ejecutadas por los agentes (pause, scale_up, duplicate_adset, etc.) con impacto medido.',
    input_schema: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', enum: ['account_agent', 'ares_agent', 'creative_agent', 'testing_agent', 'any'], default: 'any' },
        action: { type: 'string', description: 'Tipo específico de acción' },
        hours_back: { type: 'number', default: 48, description: 'Ventana temporal' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_directives',
    description: 'Directivas activas de Zeus (prioritize/avoid/tune) con confidence y scope.',
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: true }
      },
      required: []
    }
  },
  {
    name: 'query_insights',
    description: 'BrainInsights recientes: observaciones del análisis continuo (brain_thinking, anomaly, opportunity, pattern).',
    input_schema: {
      type: 'object',
      properties: {
        insight_type: { type: 'string', description: 'Filtrar por tipo (brain_thinking, hypothesis, anomaly, etc.)' },
        hours_back: { type: 'number', default: 24 },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_hypotheses',
    description: 'Hipótesis que Zeus ha formulado con su estado (pending, confirmed, rejected, inconclusive).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'confirmed', 'rejected', 'inconclusive'], default: 'all' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_duplications',
    description: 'Duplicaciones que Ares ejecutó: original → clone con ROAS at_dup + reasoning.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// Tool handlers
// ═══════════════════════════════════════════════════════════════════════════

async function handleQueryPortfolio() {
  const snapshots = await getLatestSnapshots('adset');
  const active = snapshots.filter(s => s.status === 'ACTIVE');

  const windows = ['last_1d', 'last_3d', 'last_7d', 'last_14d'];
  const aggregates = {};
  for (const w of windows) {
    const spend = active.reduce((s, a) => s + (a.metrics?.[w]?.spend || 0), 0);
    const revenue = active.reduce((s, a) => {
      const m = a.metrics?.[w] || {};
      return s + ((m.roas || 0) * (m.spend || 0));
    }, 0);
    const purchases = active.reduce((s, a) => s + (a.metrics?.[w]?.purchases || 0), 0);
    aggregates[w] = {
      spend: Math.round(spend),
      revenue: Math.round(revenue),
      roas: spend > 0 ? +(revenue / spend).toFixed(2) : 0,
      cpa: purchases > 0 ? +(spend / purchases).toFixed(2) : 0,
      purchases
    };
  }

  // By campaign
  const byCampaign = {};
  for (const s of active) {
    const cid = s.campaign_id || 'unknown';
    if (!byCampaign[cid]) byCampaign[cid] = { campaign_id: cid, campaign_name: s.campaign_name || '', adsets: 0, spend_7d: 0, revenue_7d: 0 };
    byCampaign[cid].adsets += 1;
    byCampaign[cid].spend_7d += s.metrics?.last_7d?.spend || 0;
    byCampaign[cid].revenue_7d += (s.metrics?.last_7d?.roas || 0) * (s.metrics?.last_7d?.spend || 0);
  }
  const campaigns = Object.values(byCampaign).map(c => ({
    ...c,
    spend_7d: Math.round(c.spend_7d),
    revenue_7d: Math.round(c.revenue_7d),
    roas_7d: c.spend_7d > 0 ? +(c.revenue_7d / c.spend_7d).toFixed(2) : 0
  })).sort((a, b) => b.spend_7d - a.spend_7d);

  return {
    active_adsets: active.length,
    aggregates,
    campaigns: campaigns.slice(0, 10)
  };
}

async function handleQueryAdsets(input) {
  const snapshots = await getLatestSnapshots('adset');
  let list = snapshots.filter(s => s.status === 'ACTIVE');

  if (input.name_contains) {
    const q = input.name_contains.toLowerCase();
    list = list.filter(s => (s.entity_name || '').toLowerCase().includes(q));
  }
  if (typeof input.min_roas === 'number') list = list.filter(s => (s.metrics?.last_7d?.roas || 0) >= input.min_roas);
  if (typeof input.max_roas === 'number') list = list.filter(s => (s.metrics?.last_7d?.roas || 0) <= input.max_roas);
  if (typeof input.min_spend_7d === 'number') list = list.filter(s => (s.metrics?.last_7d?.spend || 0) >= input.min_spend_7d);

  const sortBy = input.sort_by || 'roas';
  list.sort((a, b) => {
    const am = a.metrics?.last_7d || {};
    const bm = b.metrics?.last_7d || {};
    if (sortBy === 'spend') return (bm.spend || 0) - (am.spend || 0);
    if (sortBy === 'purchases') return (bm.purchases || 0) - (am.purchases || 0);
    if (sortBy === 'frequency') return (bm.frequency || 0) - (am.frequency || 0);
    return (bm.roas || 0) - (am.roas || 0);
  });

  const limit = Math.min(input.limit || 20, 50);
  return list.slice(0, limit).map(s => {
    const m = s.metrics?.last_7d || {};
    return {
      name: s.entity_name,
      id: s.entity_id,
      campaign: s.campaign_name,
      daily_budget: s.daily_budget || 0,
      spend_7d: Math.round(m.spend || 0),
      roas_7d: +(m.roas || 0).toFixed(2),
      purchases_7d: m.purchases || 0,
      cpa_7d: m.purchases > 0 ? +(m.spend / m.purchases).toFixed(2) : null,
      frequency: +(m.frequency || 0).toFixed(2),
      ctr: +(m.ctr || 0).toFixed(2),
      learning_stage: s.learning_stage || null
    };
  });
}

async function handleQueryTests(input) {
  const filter = {};
  if (input.phase === 'active') filter.phase = { $in: ['learning', 'evaluating'] };
  else if (input.phase) filter.phase = input.phase;

  const tests = await TestRun.find(filter)
    .sort({ launched_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .populate({ path: 'proposal_id', select: 'headline scene_short product_name' })
    .lean();

  return tests.map(t => ({
    name: t.test_adset_name,
    phase: t.phase,
    days_active: Math.floor((Date.now() - new Date(t.launched_at).getTime()) / 86400000),
    metrics: {
      spend: Math.round(t.metrics?.spend || 0),
      roas: +(t.metrics?.roas || 0).toFixed(2),
      purchases: t.metrics?.purchases || 0,
      ctr: +(t.metrics?.ctr || 0).toFixed(2)
    },
    source_adset: t.source_adset_name,
    product: t.proposal_id?.product_name,
    scene: t.proposal_id?.scene_short,
    headline: t.proposal_id?.headline,
    latest_assessment: t.assessments?.[t.assessments.length - 1]?.assessment || null,
    kill_reason: t.kill_reason || null
  }));
}

async function handleQueryDnas(input) {
  const filter = { 'fitness.tests_total': { $gte: input.min_samples || 2 } };
  const sort = input.sort_by === 'roas'
    ? { 'fitness.avg_roas': -1 }
    : input.sort_by === 'win_rate'
    ? { 'fitness.win_rate': -1 }
    : input.sort_by === 'generation'
    ? { generation: -1 }
    : { 'fitness.avg_roas': -1, 'fitness.sample_confidence': -1 };

  const dnas = await CreativeDNA.find(filter)
    .sort(sort)
    .limit(Math.min(input.limit || 10, 30))
    .lean();

  return dnas.map(d => ({
    dimensions: d.dimensions,
    generation: d.generation,
    fitness: {
      tests_total: d.fitness?.tests_total || 0,
      tests_graduated: d.fitness?.tests_graduated || 0,
      tests_killed: d.fitness?.tests_killed || 0,
      avg_roas: +(d.fitness?.avg_roas || 0).toFixed(2),
      win_rate: Math.round((d.fitness?.win_rate || 0) * 100),
      confidence: Math.round((d.fitness?.sample_confidence || 0) * 100),
      total_spend: Math.round(d.fitness?.total_spend || 0),
      total_revenue: Math.round(d.fitness?.total_revenue || 0)
    }
  }));
}

async function handleQueryActions(input) {
  const hours = input.hours_back || 48;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { executed_at: { $gte: since }, success: true };
  if (input.agent_type && input.agent_type !== 'any') filter.agent_type = input.agent_type;
  if (input.action) filter.action = input.action;

  const actions = await ActionLog.find(filter)
    .sort({ executed_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return actions.map(a => ({
    action: a.action,
    agent: a.agent_type,
    entity_name: a.entity_name,
    before: a.before_value,
    after: a.after_value,
    reasoning: a.reasoning?.substring(0, 200),
    executed_at: a.executed_at,
    impact_7d: a.impact_7d ? {
      roas_delta: +(a.impact_7d.roas_delta || 0).toFixed(2),
      spend_delta: Math.round(a.impact_7d.spend_delta || 0)
    } : null
  }));
}

async function handleQueryDirectives(input) {
  const filter = input.active_only === false ? {} : { active: true };
  const directives = await ZeusDirective.find(filter)
    .sort({ confidence: -1, created_at: -1 })
    .limit(30)
    .lean();
  return directives.map(d => ({
    directive: d.directive,
    type: d.directive_type,
    target_agent: d.target_agent,
    confidence: Math.round((d.confidence || 0) * 100),
    scope: d.scope,
    reasoning: d.reasoning?.substring(0, 200),
    created_at: d.created_at
  }));
}

async function handleQueryInsights(input) {
  const hours = input.hours_back || 24;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { created_at: { $gte: since } };
  if (input.insight_type) filter.insight_type = input.insight_type;

  const insights = await BrainInsight.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return insights.map(i => ({
    type: i.insight_type,
    title: i.title,
    content: i.content?.substring(0, 300),
    generated_by: i.generated_by,
    entity: i.entity_name,
    confidence: i.confidence,
    created_at: i.created_at
  }));
}

async function handleQueryHypotheses(input) {
  const filter = { insight_type: 'hypothesis' };
  if (input.status && input.status !== 'all') filter['metadata.status'] = input.status;

  const hyps = await BrainInsight.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .lean();

  return hyps.map(h => ({
    hypothesis: h.title,
    reasoning: h.content?.substring(0, 300),
    status: h.metadata?.status || 'pending',
    evidence: h.metadata?.evidence?.substring(0, 200) || null,
    recommendation: h.metadata?.recommendation?.substring(0, 200) || null,
    validated_at: h.metadata?.validated_at || null,
    created_at: h.created_at
  }));
}

async function handleQueryDuplications(input) {
  const dups = await ActionLog.find({
    action: { $in: ['duplicate_adset', 'fast_track_duplicate'] },
    agent_type: 'ares_agent',
    success: true
  }).sort({ executed_at: -1 })
    .limit(Math.min(input.limit || 15, 30))
    .lean();

  return dups.map(d => ({
    original_name: d.entity_name,
    clone_name: d.after_value,
    roas_at_dup: +(d.metrics_at_execution?.roas_7d || 0).toFixed(2),
    spend_at_dup: Math.round(d.metrics_at_execution?.spend_7d || 0),
    reasoning: d.reasoning?.substring(0, 200),
    executed_at: d.executed_at
  }));
}

const TOOL_HANDLERS = {
  query_portfolio: handleQueryPortfolio,
  query_adsets: handleQueryAdsets,
  query_tests: handleQueryTests,
  query_dnas: handleQueryDnas,
  query_actions: handleQueryActions,
  query_directives: handleQueryDirectives,
  query_insights: handleQueryInsights,
  query_hypotheses: handleQueryHypotheses,
  query_duplications: handleQueryDuplications
};

async function executeTool(toolName, input) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) throw new Error(`Unknown tool: ${toolName}`);
  return await handler(input || {});
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  executeTool
};
