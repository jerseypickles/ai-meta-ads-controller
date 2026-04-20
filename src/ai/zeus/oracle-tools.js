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
const BrainMemory = require('../../db/models/BrainMemory');
const SafetyEvent = require('../../db/models/SafetyEvent');
const AICreation = require('../../db/models/AICreation');
const SystemConfig = require('../../db/models/SystemConfig');
const { getLatestSnapshots, getSnapshotHistory, getOverviewHistory } = require('../../db/queries');

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
  },
  {
    name: 'query_adset_detail',
    description: 'Zoom-in completo a UN ad set específico: métricas actuales + historia últimos 30 días + tests asociados + acciones ejecutadas + memoria del brain. Usa esta cuando el usuario pregunte por algo específico.',
    input_schema: {
      type: 'object',
      properties: {
        adset_query: { type: 'string', description: 'ID o substring del nombre del ad set' },
        days_back: { type: 'number', default: 14, description: 'Cuántos días de historia traer' }
      },
      required: ['adset_query']
    }
  },
  {
    name: 'query_overview_history',
    description: 'Time-series día-por-día del portfolio completo: spend, revenue, ROAS, CPA diarios. Úsalo para responder "cómo fue el día X", "cómo venimos la semana", trends.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 14, description: 'Número de días hacia atrás (max 90)' }
      },
      required: []
    }
  },
  {
    name: 'query_time_series',
    description: 'Time-series día-por-día de UNA entidad específica. Útil para trackear evolución de un ad set o campaña.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID de Meta' },
        days_back: { type: 'number', default: 14, description: 'Días hacia atrás' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'query_brain_memory',
    description: 'Memoria que el Brain tiene sobre una entidad: patrones aprendidos, preferencias, historial de acciones, notas.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID o name substring' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'query_safety_events',
    description: 'Eventos de safety: kill switch triggers, anomalías detectadas, cooldown hits. Histórico de "qué se evitó hacer y por qué".',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 7 },
        severity: { type: 'string', enum: ['all', 'critical', 'high', 'medium'], default: 'all' },
        limit: { type: 'number', default: 15 }
      },
      required: []
    }
  },
  {
    name: 'query_creative_proposals',
    description: 'Pipeline de creativos de Apollo: proposals generadas, ready, testing, graduados, killed. Filtros por status y ventana temporal.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'ready', 'testing', 'graduated', 'killed', 'rejected'], default: 'all' },
        hours_back: { type: 'number', default: 48 },
        limit: { type: 'number', default: 20 }
      },
      required: []
    }
  },
  {
    name: 'query_ai_creations',
    description: 'Entidades creadas por AI (ad sets, ads) con su ciclo de vida: learning/testing/scaling/killed + verdict measurable a 1d/3d/7d.',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['all', 'learning', 'testing', 'scaling', 'killed', 'graduated'], default: 'all' },
        days_back: { type: 'number', default: 14 },
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

async function handleQueryAdsetDetail(input) {
  const days = Math.min(input.days_back || 14, 90);
  const snapshots = await getLatestSnapshots('adset');

  // Resolver entity por id o por nombre
  let match = snapshots.find(s => s.entity_id === input.adset_query);
  if (!match) {
    const q = (input.adset_query || '').toLowerCase();
    match = snapshots.find(s => (s.entity_name || '').toLowerCase().includes(q));
  }
  if (!match) return { error: `No encontré un ad set con query "${input.adset_query}"` };

  // History día-por-día
  const history = await getSnapshotHistory(match.entity_id, days).catch(() => []);

  // Actions ejecutadas sobre este adset
  const actions = await ActionLog.find({ entity_id: match.entity_id, success: true })
    .sort({ executed_at: -1 }).limit(20).lean();

  // Tests con este adset como source
  const tests = await TestRun.find({ source_adset_id: match.entity_id })
    .sort({ launched_at: -1 }).limit(10).lean();

  // Memoria del brain
  const memory = await BrainMemory.findOne({ entity_id: match.entity_id }).lean();

  const m7 = match.metrics?.last_7d || {};
  const m14 = match.metrics?.last_14d || {};
  return {
    entity: {
      id: match.entity_id,
      name: match.entity_name,
      campaign: match.campaign_name,
      status: match.status,
      daily_budget: match.daily_budget,
      learning_stage: match.learning_stage
    },
    current_metrics: {
      roas_7d: +(m7.roas || 0).toFixed(2),
      spend_7d: Math.round(m7.spend || 0),
      purchases_7d: m7.purchases || 0,
      cpa_7d: m7.purchases > 0 ? +(m7.spend / m7.purchases).toFixed(2) : null,
      frequency: +(m7.frequency || 0).toFixed(2),
      ctr: +(m7.ctr || 0).toFixed(2),
      roas_14d: +(m14.roas || 0).toFixed(2)
    },
    daily_history: history.slice(-days).map(h => ({
      date: h.date,
      spend: Math.round(h.spend || 0),
      roas: +(h.roas || 0).toFixed(2),
      purchases: h.purchases || 0
    })),
    recent_actions: actions.slice(0, 10).map(a => ({
      action: a.action, agent: a.agent_type, executed_at: a.executed_at,
      reasoning: a.reasoning?.substring(0, 150),
      impact_7d: a.impact_7d ? { roas_delta: a.impact_7d.roas_delta } : null
    })),
    tests: tests.map(t => ({
      phase: t.phase, launched_at: t.launched_at,
      roas: t.metrics?.roas, purchases: t.metrics?.purchases,
      source_adset: t.source_adset_name
    })),
    brain_memory: memory ? {
      notes: memory.notes?.substring(0, 300),
      action_count: memory.action_history?.length || 0,
      last_updated: memory.last_updated_at
    } : null
  };
}

async function handleQueryOverviewHistory(input) {
  const days = Math.min(input.days_back || 14, 90);
  const history = await getOverviewHistory(days).catch(() => []);
  return history.map(h => ({
    date: h.date,
    spend: Math.round(h.spend || 0),
    revenue: Math.round(h.revenue || 0),
    roas: +(h.roas || 0).toFixed(2),
    purchases: h.purchases || 0,
    cpa: h.purchases > 0 ? +(h.spend / h.purchases).toFixed(2) : null
  }));
}

async function handleQueryTimeSeries(input) {
  if (!input.entity_id) return { error: 'entity_id requerido' };
  const days = Math.min(input.days_back || 14, 90);
  const history = await getSnapshotHistory(input.entity_id, days).catch(() => []);
  return {
    entity_id: input.entity_id,
    days_back: days,
    series: history.map(h => ({
      date: h.date,
      spend: Math.round(h.spend || 0),
      roas: +(h.roas || 0).toFixed(2),
      purchases: h.purchases || 0,
      frequency: +(h.frequency || 0).toFixed(2)
    }))
  };
}

async function handleQueryBrainMemory(input) {
  if (!input.entity_id) return { error: 'entity_id requerido' };

  // Intentar match exacto por id
  let memory = await BrainMemory.findOne({ entity_id: input.entity_id }).lean();

  // Si no, buscar por substring en nombre
  if (!memory) {
    const regex = new RegExp(input.entity_id.substring(0, 30), 'i');
    memory = await BrainMemory.findOne({ entity_name: regex }).lean();
  }

  if (!memory) return { error: `Sin memoria para "${input.entity_id}"` };

  return {
    entity_id: memory.entity_id,
    entity_name: memory.entity_name,
    entity_type: memory.entity_type,
    notes: memory.notes,
    patterns: memory.patterns,
    preferences: memory.preferences,
    recent_actions: (memory.action_history || []).slice(-10).map(a => ({
      action: a.action,
      date: a.date,
      outcome: a.outcome
    })),
    last_updated: memory.last_updated_at
  };
}

async function handleQuerySafetyEvents(input) {
  const days = input.days_back || 7;
  const since = new Date(Date.now() - days * 86400000);
  const filter = { created_at: { $gte: since } };
  if (input.severity && input.severity !== 'all') filter.severity = input.severity;

  const events = await SafetyEvent.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return events.map(e => ({
    type: e.event_type,
    severity: e.severity,
    entity: e.entity_name,
    reason: e.reason?.substring(0, 200),
    action_taken: e.action_taken,
    created_at: e.created_at
  }));
}

async function handleQueryCreativeProposals(input) {
  const hours = input.hours_back || 48;
  const since = new Date(Date.now() - hours * 3600000);
  const filter = { created_at: { $gte: since } };
  if (input.status && input.status !== 'all') filter.status = input.status;

  const proposals = await CreativeProposal.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 20, 50))
    .lean();

  return proposals.map(p => ({
    headline: p.headline,
    status: p.status,
    product: p.product_name,
    scene: p.scene_short,
    evolution_strategy: p.evolution_strategy,
    created_at: p.created_at,
    rejection_reason: p.rejection_reason
  }));
}

async function handleQueryAICreations(input) {
  const days = input.days_back || 14;
  const since = new Date(Date.now() - days * 86400000);
  const filter = { created_at: { $gte: since } };
  if (input.phase && input.phase !== 'all') filter.lifecycle_phase = input.phase;

  const creations = await AICreation.find(filter)
    .sort({ created_at: -1 })
    .limit(Math.min(input.limit || 15, 40))
    .lean();

  return creations.map(c => ({
    type: c.creation_type,
    entity_name: c.entity_name,
    phase: c.lifecycle_phase,
    verdict: c.verdict,
    created_at: c.created_at,
    measured_1d: c.impact_1d ? { roas: c.impact_1d.roas, purchases: c.impact_1d.purchases } : null,
    measured_7d: c.impact_7d ? { roas: c.impact_7d.roas, purchases: c.impact_7d.purchases } : null
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
  query_duplications: handleQueryDuplications,
  query_adset_detail: handleQueryAdsetDetail,
  query_overview_history: handleQueryOverviewHistory,
  query_time_series: handleQueryTimeSeries,
  query_brain_memory: handleQueryBrainMemory,
  query_safety_events: handleQuerySafetyEvents,
  query_creative_proposals: handleQueryCreativeProposals,
  query_ai_creations: handleQueryAICreations
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
