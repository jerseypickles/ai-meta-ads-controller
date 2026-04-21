/**
 * Zeus Oracle Context — construye el contexto inicial (snapshot agregado)
 * que Zeus tiene al empezar cualquier conversación, sin tener que llamar tools.
 */
const TestRun = require('../../db/models/TestRun');
const CreativeDNA = require('../../db/models/CreativeDNA');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const ZeusDirective = require('../../db/models/ZeusDirective');
const BrainInsight = require('../../db/models/BrainInsight');
const ZeusPreference = require('../../db/models/ZeusPreference');
const ZeusPlaybook = require('../../db/models/ZeusPlaybook');
const SystemConfig = require('../../db/models/SystemConfig');
const { getLatestSnapshots } = require('../../db/queries');

/**
 * Construye un snapshot compacto del estado actual del sistema.
 * lastSeenAt: ISO string o null — si null, no se incluye el diff "desde última visita".
 */
async function buildOracleContext(lastSeenAt = null) {
  const now = new Date();
  const ctx = { generated_at: now.toISOString() };

  // Portfolio
  const snapshots = await getLatestSnapshots('adset');
  const active = snapshots.filter(s => s.status === 'ACTIVE');

  const agg = (w) => {
    const spend = active.reduce((s, a) => s + (a.metrics?.[w]?.spend || 0), 0);
    const revenue = active.reduce((s, a) => s + ((a.metrics?.[w]?.roas || 0) * (a.metrics?.[w]?.spend || 0)), 0);
    const purchases = active.reduce((s, a) => s + (a.metrics?.[w]?.purchases || 0), 0);
    return {
      spend: Math.round(spend),
      revenue: Math.round(revenue),
      roas: spend > 0 ? +(revenue / spend).toFixed(2) : 0,
      purchases
    };
  };

  ctx.portfolio = {
    active_adsets: active.length,
    last_1d: agg('last_1d'),
    last_7d: agg('last_7d'),
    last_14d: agg('last_14d')
  };

  // Agent activity summary
  const hoursSinceLast = lastSeenAt ? (Date.now() - new Date(lastSeenAt).getTime()) / 3600000 : 24;
  const since = new Date(Date.now() - hoursSinceLast * 3600000);

  // Athena/Brain actions
  const athenaActions = await ActionLog.countDocuments({
    agent_type: { $in: ['account_agent', 'brain', 'unified_agent'] },
    executed_at: { $gte: since },
    success: true
  });

  // Ares duplications
  const aresActions = await ActionLog.find({
    agent_type: 'ares_agent',
    executed_at: { $gte: since },
    success: true
  }).sort({ executed_at: -1 }).limit(5).lean();

  // Tests
  const testsSince = await TestRun.find({
    $or: [
      { launched_at: { $gte: since } },
      { graduated_at: { $gte: since } },
      { killed_at: { $gte: since } }
    ]
  }).limit(30).lean();

  const testsLaunched = testsSince.filter(t => new Date(t.launched_at) >= since).length;
  const testsGraduated = testsSince.filter(t => t.graduated_at && new Date(t.graduated_at) >= since).length;
  const testsKilled = testsSince.filter(t => t.killed_at && new Date(t.killed_at) >= since).length;

  const activeTests = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });

  // Apollo proposals
  const proposalsSince = await CreativeProposal.countDocuments({
    created_at: { $gte: since }
  });
  const readyPool = await CreativeProposal.countDocuments({ status: 'ready' });

  // DNA stats
  const totalDnas = await CreativeDNA.countDocuments({});
  const topDna = await CreativeDNA.findOne({ 'fitness.tests_total': { $gte: 2 } })
    .sort({ 'fitness.avg_roas': -1, 'fitness.sample_confidence': -1 })
    .lean();

  ctx.activity_since_last = {
    window_hours: Math.round(hoursSinceLast * 10) / 10,
    athena_actions: athenaActions,
    ares_duplications: aresActions.length,
    ares_duplications_detail: aresActions.slice(0, 3).map(a => ({
      original: a.entity_name,
      clone: a.after_value,
      roas: +(a.metrics_at_execution?.roas_7d || 0).toFixed(2)
    })),
    tests_launched: testsLaunched,
    tests_graduated: testsGraduated,
    tests_killed: testsKilled,
    apollo_proposals_generated: proposalsSince
  };

  // Current state
  ctx.current_state = {
    active_tests: activeTests,
    ready_pool: readyPool,
    total_dnas: totalDnas,
    top_dna: topDna ? {
      dimensions: topDna.dimensions,
      avg_roas: +(topDna.fitness?.avg_roas || 0).toFixed(2),
      tests: topDna.fitness?.tests_total || 0
    } : null
  };

  // Active directives (summaries)
  const directives = await ZeusDirective.find({ active: true })
    .sort({ confidence: -1 })
    .limit(8)
    .lean();
  ctx.active_directives = directives.map(d => ({
    directive: d.directive,
    type: d.directive_type,
    target: d.target_agent,
    confidence: Math.round((d.confidence || 0) * 100)
  }));

  // Recent hypotheses (validated only — give Zeus his verdict history)
  const validatedHyps = await BrainInsight.find({
    insight_type: 'hypothesis',
    'metadata.status': { $in: ['confirmed', 'rejected'] }
  }).sort({ created_at: -1 }).limit(5).lean();

  ctx.recent_validated_hypotheses = validatedHyps.map(h => ({
    hypothesis: h.title,
    status: h.metadata?.status,
    evidence: h.metadata?.evidence?.substring(0, 150)
  }));

  // Critical anomalies last 24h
  const anomalies = await BrainInsight.find({
    insight_type: 'anomaly',
    severity: { $in: ['critical', 'high'] },
    created_at: { $gte: new Date(Date.now() - 24 * 3600000) }
  }).sort({ created_at: -1 }).limit(5).lean();

  ctx.recent_anomalies = anomalies.map(a => ({
    title: a.title,
    severity: a.severity,
    entity: a.entity_name
  }));

  // Intelligence summary (if exists)
  try {
    const summary = await SystemConfig.get('zeus_intelligence_summary', null);
    if (summary?.summary) {
      ctx.zeus_intelligence_summary = summary.summary.substring(0, 500);
    }
  } catch (_) {}

  // Preferencias persistentes del creador (memoria cross-conversación)
  try {
    const prefs = await ZeusPreference.find({ active: true, status: 'active' })
      .sort({ category: 1, confidence: -1, updated_at: -1 })
      .limit(30)
      .lean();
    ctx.creator_preferences = prefs.map(p => ({
      key: p.key,
      value: p.value,
      category: p.category,
      confidence: p.confidence
    }));
  } catch (_) { ctx.creator_preferences = []; }

  // Playbooks activos — reglas operativas que Zeus escribió para sí mismo
  try {
    const playbooks = await ZeusPlaybook.find({ active: true })
      .sort({ confidence: -1 })
      .limit(15)
      .lean();
    ctx.own_playbooks = playbooks.map(p => ({
      title: p.title,
      trigger: p.trigger_pattern,
      action: p.action,
      confidence: Math.round((p.confidence || 0) * 100)
    }));
  } catch (_) { ctx.own_playbooks = []; }

  // Eventos estacionales próximos (awareness — no activación)
  try {
    const { getUpcomingEvents } = require('./seasonal-calendar');
    const events = await getUpcomingEvents(60);
    ctx.upcoming_seasonal_events = events.slice(0, 10);
  } catch (_) { ctx.upcoming_seasonal_events = []; }

  return ctx;
}

/**
 * Formatea el contexto como texto plano para inyectar en el system prompt.
 */
function formatContextForPrompt(ctx) {
  const lines = [];
  const p = ctx.portfolio;
  lines.push(`PORTFOLIO — ${p.active_adsets} ad sets activos`);
  lines.push(`  24h: $${p.last_1d.spend} gastados · $${p.last_1d.revenue} revenue · ${p.last_1d.roas}x ROAS · ${p.last_1d.purchases} compras`);
  lines.push(`  7d:  $${p.last_7d.spend} gastados · $${p.last_7d.revenue} revenue · ${p.last_7d.roas}x ROAS · ${p.last_7d.purchases} compras`);
  lines.push(`  14d: $${p.last_14d.spend} gastados · $${p.last_14d.revenue} revenue · ${p.last_14d.roas}x ROAS · ${p.last_14d.purchases} compras`);

  const a = ctx.activity_since_last;
  lines.push(`\nACTIVIDAD (últimas ~${a.window_hours}h):`);
  lines.push(`  Athena/Brain: ${a.athena_actions} acciones ejecutadas`);
  lines.push(`  Ares: ${a.ares_duplications} duplicaciones${a.ares_duplications_detail.length ? ' (' + a.ares_duplications_detail.map(d => `${d.original}→${d.roas}x`).join('; ') + ')' : ''}`);
  lines.push(`  Prometheus: ${a.tests_launched} tests lanzados, ${a.tests_graduated} graduados, ${a.tests_killed} killed`);
  lines.push(`  Apollo: ${a.apollo_proposals_generated} proposals generadas`);

  const s = ctx.current_state;
  lines.push(`\nESTADO ACTUAL:`);
  lines.push(`  ${s.active_tests} tests activos · ${s.ready_pool} creativos ready · ${s.total_dnas} DNAs en banco`);
  if (s.top_dna) {
    const d = s.top_dna.dimensions;
    lines.push(`  Top DNA: ${d.style || '?'} + ${d.copy_angle || '?'} @ ${s.top_dna.avg_roas}x (${s.top_dna.tests} tests)`);
  }

  if (ctx.active_directives.length) {
    lines.push(`\nDIRECTIVAS ACTIVAS (${ctx.active_directives.length}):`);
    for (const d of ctx.active_directives.slice(0, 5)) {
      lines.push(`  [${d.type}] ${d.directive} (conf ${d.confidence}%, target: ${d.target})`);
    }
  }

  if (ctx.recent_validated_hypotheses.length) {
    lines.push(`\nHIPÓTESIS RECIENTEMENTE VALIDADAS:`);
    for (const h of ctx.recent_validated_hypotheses) {
      lines.push(`  [${h.status}] ${h.hypothesis}`);
    }
  }

  if (ctx.recent_anomalies.length) {
    lines.push(`\nANOMALÍAS ÚLTIMAS 24H:`);
    for (const a of ctx.recent_anomalies) {
      lines.push(`  [${a.severity}] ${a.title}${a.entity ? ` (${a.entity})` : ''}`);
    }
  }

  if (ctx.zeus_intelligence_summary) {
    lines.push(`\nRESUMEN DE APRENDIZAJE PROPIO:`);
    lines.push(`  ${ctx.zeus_intelligence_summary}`);
  }

  if (ctx.creator_preferences?.length) {
    lines.push(`\nMEMORIA DEL CREADOR (preferencias persistentes — SIEMPRE respetalas):`);
    const byCategory = {};
    for (const p of ctx.creator_preferences) {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(`${p.key}: ${p.value}`);
    }
    for (const [cat, items] of Object.entries(byCategory)) {
      lines.push(`  [${cat}]`);
      for (const item of items) lines.push(`    - ${item}`);
    }
  }

  if (ctx.own_playbooks?.length) {
    lines.push(`\nTUS PROPIOS PLAYBOOKS (reglas que vos mismo escribiste, aplicá cuando el trigger matchee):`);
    for (const pb of ctx.own_playbooks) {
      lines.push(`  • ${pb.title} (conf ${pb.confidence}%)`);
      lines.push(`    cuando: ${pb.trigger}`);
      lines.push(`    →  ${pb.action}`);
    }
  }

  if (ctx.upcoming_seasonal_events?.length) {
    lines.push(`\nCALENDARIO — EVENTOS QUE VIENEN (awareness):`);
    for (const ev of ctx.upcoming_seasonal_events) {
      const marker = ev.days_away < 0 ? `(hace ${Math.abs(ev.days_away)}d — cool-down)` :
                     ev.days_away === 0 ? `(HOY)` :
                     ev.days_away <= 7 ? `(en ${ev.days_away}d — PEAK INCOMING)` :
                     ev.days_away <= (ev.anticipation_days || 14) ? `(en ${ev.days_away}d — anticipación)` :
                     `(en ${ev.days_away}d — future)`;
      lines.push(`  [${ev.priority}] ${ev.name} ${ev.date} ${marker}`);
      if (ev.messaging_theme) lines.push(`    tema: ${ev.messaging_theme}`);
    }
    lines.push(`  Si algún evento entra en anticipación (≤ anticipation_days) mencionálo al creador y sugerí acción preparatoria — NO crees directivas automáticas salvo que te lo pida.`);
  }

  return lines.join('\n');
}

module.exports = {
  buildOracleContext,
  formatContextForPrompt
};
