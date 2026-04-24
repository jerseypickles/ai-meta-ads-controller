/**
 * Ares Brain Tools — tool definitions + handlers para Opus 4.7.
 *
 * Mismo patrón que src/ai/zeus/oracle-tools.js pero enfocado en decisiones
 * de Portfolio Management. El brain usa estas tools para explorar data y
 * ejecutar acciones bounded con safety gates.
 *
 * Commit 1 (read-only): solo queries.
 * Commit 2 añadirá: scale_cbo_budget, pause_adset, duplicate_adset_to_cbo.
 * Commit 3 añadirá: create_new_cbo (con safety de Ola 3).
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const TestRun = require('../../db/models/TestRun');
const SystemConfig = require('../../db/models/SystemConfig');
const logger = require('../../utils/logger');
const { runPortfolioAnalysis } = require('./ares-portfolio-manager');

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (Anthropic format)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  {
    name: 'query_cbo_health',
    description: 'Consulta el estado de salud de TODAS las CBOs activas. Retorna por cada CBO: daily_budget, active_adsets_count, ROAS 1d/3d/7d, spend por ventana, concentration (top-1/2/3), favorito y tenure, starved_count, collapse_detected, budget_pulse. Usá esto PRIMERO para ver el estado del portfolio.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_portfolio_state',
    description: 'Overview global del portfolio: total active_adsets, total spend today/7d, revenue, ROAS agregado, cantidad de CBOs activas, cantidad de graduates recientes, directivas Zeus activas. Contexto high-level.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_adset_detail',
    description: 'Drill-in a un adset específico: metrics 1d/3d/7d, historial acciones 30d, CBO padre, learning_stage, edad estimada por primer snapshot, recent delta (ROAS progression).',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'Entity ID del adset' }
      },
      required: ['adset_id']
    }
  },
  {
    name: 'query_graduates',
    description: 'Tests que graduaron recientemente (últimos N días). Un graduate = test validado con >=50 conversiones y ROAS estable >=3x. Son candidatos fuertes a escalado o a seed de CBO nueva.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 14, description: 'Ventana en días (default 14)' }
      },
      required: []
    }
  },
  {
    name: 'query_starved_winners',
    description: 'Adsets detectados como "winners starved": ROAS >=2x + >=1 compra en 7d pero reciben <3% del spend de su CBO padre. Son candidatos a rescue (duplicar a otra CBO o crear CBO nueva).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_recent_actions',
    description: 'Historial de acciones de Ares (legacy + portfolio + brain) en las últimas N horas. Evita re-ejecutar sobre mismas entidades.',
    input_schema: {
      type: 'object',
      properties: {
        hours_back: { type: 'number', default: 48 }
      },
      required: []
    }
  },
  {
    name: 'get_portfolio_recommendations',
    description: 'Ejecuta los 7 detectores procedurales (cluster_saturation, cbo_underperforming, mass_zombie_kill, cbo_saturated_winner, cbo_starvation, starved_winner_rescue, underperformer_kill) y retorna qué acciones RECOMIENDAN sin ejecutarlas. Usá esto como segunda opinión — los detectores son rápidos y conservadores. Podés aceptarlas, modificarlas, o rechazarlas.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_account_caps',
    description: 'Estado actual de los caps del account: max_active_adsets, max_scale_24h, max_duplications_24h, daily spend ceiling, circuit breaker status. Usá esto antes de decisiones que acerquen a caps.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS (read-only — commit 1)
// ═══════════════════════════════════════════════════════════════════════════

async function handleQueryCBOHealth() {
  const since = new Date(Date.now() - 3 * 3600000);
  const snaps = await CBOHealthSnapshot.aggregate([
    { $match: { snapshot_at: { $gte: since } } },
    { $sort: { campaign_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  return {
    cbos: snaps.map(s => ({
      id: s.campaign_id,
      name: s.campaign_name,
      is_zombie: s.is_zombie,
      daily_budget: s.daily_budget,
      active_adsets: s.active_adsets_count,
      budget_pulse: +s.budget_pulse.toFixed(1),
      roas_1d: +s.cbo_roas_1d.toFixed(2),
      roas_3d: +s.cbo_roas_3d.toFixed(2),
      roas_7d: +s.cbo_roas_7d.toFixed(2),
      spend_3d: Math.round(s.cbo_spend_3d),
      spend_7d: Math.round(s.cbo_spend_7d),
      revenue_7d: Math.round(s.cbo_revenue_7d),
      concentration_3d: +s.concentration_index_3d.toFixed(2),
      favorite: s.favorite_adset_name,
      favorite_tenure_days: s.favorite_tenure_days,
      favorite_roas_3d: +s.favorite_roas_3d.toFixed(2),
      favorite_roas_7d: +s.favorite_roas_7d.toFixed(2),
      favorite_declining: s.favorite_declining,
      starved_count: s.starved_count,
      collapse_detected: s.collapse_detected
    })),
    total: snaps.length
  };
}

async function handleQueryPortfolioState() {
  const now = Date.now();
  const DAY = 86400000;

  const [campaigns, adsetSnaps, activeTests, graduates, activeDirectives] = await Promise.all([
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'campaign', snapshot_at: { $gte: new Date(now - DAY) } } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { status: 'ACTIVE' } }
    ]),
    MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset', snapshot_at: { $gte: new Date(now - DAY) } } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { status: 'ACTIVE' } }
    ]),
    TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } }),
    TestRun.countDocuments({ graduated_at: { $gte: new Date(now - 14 * DAY) } }),
    require('../../db/models/ZeusDirective').countDocuments({ active: true, expires_at: { $gt: new Date() } })
  ]);

  const cboCount = campaigns.filter(c => Number(c.daily_budget) > 0).length;
  const aboCount = campaigns.length - cboCount;
  const totalSpendToday = adsetSnaps.reduce((s, a) => s + (a.metrics?.today?.spend || 0), 0);
  const totalRevToday = adsetSnaps.reduce((s, a) => s + (a.metrics?.today?.purchase_value || 0), 0);
  const totalSpend7d = adsetSnaps.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
  const totalRev7d = adsetSnaps.reduce((s, a) => s + (a.metrics?.last_7d?.purchase_value || 0), 0);

  return {
    campaigns: { cbo: cboCount, abo: aboCount, total_active: campaigns.length },
    adsets: { total_active: adsetSnaps.length },
    today: {
      spend: Math.round(totalSpendToday),
      revenue: Math.round(totalRevToday),
      roas: totalSpendToday > 0 ? +(totalRevToday / totalSpendToday).toFixed(2) : 0
    },
    last_7d: {
      spend: Math.round(totalSpend7d),
      revenue: Math.round(totalRev7d),
      roas: totalSpend7d > 0 ? +(totalRev7d / totalSpend7d).toFixed(2) : 0
    },
    tests: { active: activeTests, graduates_14d: graduates },
    directives_active: activeDirectives
  };
}

async function handleQueryAdsetDetail({ adset_id }) {
  if (!adset_id) return { error: 'adset_id requerido' };

  // Último snapshot
  const latest = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: adset_id
  }).sort({ snapshot_at: -1 }).lean();
  if (!latest) return { error: `adset ${adset_id} no encontrado` };

  // Primer snapshot para inferir edad
  const first = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: adset_id
  }).sort({ snapshot_at: 1 }).lean();
  const ageInSystemDays = first
    ? Math.round((Date.now() - new Date(first.snapshot_at).getTime()) / 86400000)
    : null;

  // Acciones recientes
  const actions = await ActionLog.find({
    entity_id: adset_id,
    executed_at: { $gte: new Date(Date.now() - 30 * 86400000) }
  }).sort({ executed_at: -1 }).limit(10).lean();

  const m = latest.metrics || {};
  return {
    id: adset_id,
    name: latest.entity_name,
    status: latest.status,
    campaign_id: latest.campaign_id,
    daily_budget: latest.daily_budget,
    learning_stage: latest.learning_stage,
    age_in_system_days: ageInSystemDays,
    metrics: {
      today: m.today ? { spend: Math.round(m.today.spend || 0), revenue: Math.round(m.today.purchase_value || 0), purchases: m.today.purchases || 0 } : null,
      last_3d: m.last_3d ? { spend: Math.round(m.last_3d.spend || 0), revenue: Math.round(m.last_3d.purchase_value || 0), purchases: m.last_3d.purchases || 0, roas: m.last_3d.spend > 0 ? +((m.last_3d.purchase_value || 0) / m.last_3d.spend).toFixed(2) : 0 } : null,
      last_7d: m.last_7d ? { spend: Math.round(m.last_7d.spend || 0), revenue: Math.round(m.last_7d.purchase_value || 0), purchases: m.last_7d.purchases || 0, roas: m.last_7d.spend > 0 ? +((m.last_7d.purchase_value || 0) / m.last_7d.spend).toFixed(2) : 0, frequency: +(m.last_7d.frequency || 0).toFixed(2), ctr: +(m.last_7d.ctr || 0).toFixed(2) } : null
    },
    recent_actions: actions.map(a => ({
      action: a.action,
      executed_at: a.executed_at,
      agent: a.agent_type,
      success: a.success,
      before: a.before_value,
      after: a.after_value,
      reasoning: (a.reasoning || '').substring(0, 200)
    }))
  };
}

async function handleQueryGraduates({ days_back = 14 }) {
  const since = new Date(Date.now() - days_back * 86400000);
  const graduates = await TestRun.find({
    graduated_at: { $gte: since }
  }).sort({ graduated_at: -1 }).limit(20).lean();

  return {
    total: graduates.length,
    days_back,
    graduates: graduates.map(g => ({
      id: g._id,
      test_adset_name: g.test_adset_name,
      test_adset_id: g.test_adset_id,
      source_adset_name: g.source_adset_name,
      graduated_at: g.graduated_at,
      roas: +(g.metrics?.roas || 0).toFixed(2),
      purchases: g.metrics?.purchases || 0,
      spend: Math.round(g.metrics?.spend || 0)
    }))
  };
}

async function handleQueryStarvedWinners() {
  // Corre los detectores procedurales y filtra solo starved_winner_rescue signals
  const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
  const since = new Date(Date.now() - 3 * 3600000);
  const snaps = await CBOHealthSnapshot.aggregate([
    { $match: { snapshot_at: { $gte: since }, is_zombie: false } },
    { $sort: { campaign_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  const starvedCandidates = [];
  for (const snap of snaps) {
    const adsets = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'adset', campaign_id: snap.campaign_id } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { status: 'ACTIVE' } }
    ]);
    const total7 = adsets.reduce((s, a) => s + (a.metrics?.last_7d?.spend || 0), 0);
    for (const a of adsets) {
      const m7 = a.metrics?.last_7d || {};
      const spend7 = m7.spend || 0;
      const roas7 = spend7 > 0 ? (m7.purchase_value || 0) / spend7 : 0;
      const share = total7 > 0 ? spend7 / total7 : 0;
      if (roas7 >= 2 && (m7.purchases || 0) >= 1 && share < 0.03) {
        starvedCandidates.push({
          adset_id: a.entity_id,
          adset_name: a.entity_name,
          parent_cbo_id: snap.campaign_id,
          parent_cbo_name: snap.campaign_name,
          roas_7d: +roas7.toFixed(2),
          purchases_7d: m7.purchases || 0,
          spend_7d: Math.round(spend7),
          spend_share_7d: +(share * 100).toFixed(2)
        });
      }
    }
  }

  // Top por ROAS
  starvedCandidates.sort((a, b) => b.roas_7d - a.roas_7d);
  return { total: starvedCandidates.length, candidates: starvedCandidates.slice(0, 15) };
}

async function handleQueryRecentActions({ hours_back = 48 }) {
  const since = new Date(Date.now() - hours_back * 3600000);
  const actions = await ActionLog.find({
    agent_type: { $in: ['ares_agent', 'ares_portfolio', 'ares_brain'] },
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).limit(30).lean();

  return {
    total: actions.length,
    hours_back,
    actions: actions.map(a => ({
      at: a.executed_at,
      agent: a.agent_type,
      action: a.action,
      entity: a.entity_name,
      before: a.before_value,
      after: a.after_value,
      success: a.success,
      detector: a.metadata?.detector || null,
      reasoning: (a.reasoning || '').substring(0, 150)
    }))
  };
}

async function handleGetPortfolioRecommendations() {
  // Llama al orchestrator de detectores en DRY_RUN mode — retorna lo que
  // RECOMENDARÍAN sin ejecutar. El brain decide luego aceptar/rechazar/ajustar.
  const { executePortfolioActionsForCBO } = require('./ares-portfolio-manager');
  const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
  const since = new Date(Date.now() - 3 * 3600000);
  const snaps = await CBOHealthSnapshot.aggregate([
    { $match: { snapshot_at: { $gte: since } } },
    { $sort: { campaign_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  // Mock meta client para dry-run — ninguna acción se ejecuta
  const metaMod = require('../../meta/client');
  const origGetClient = metaMod.getMetaClient;
  metaMod.getMetaClient = () => ({
    duplicateAdSet: async () => { throw new Error('DRY_RUN_BRAIN_INSPECT'); },
    updateStatus: async () => { throw new Error('DRY_RUN_BRAIN_INSPECT'); },
    updateBudget: async () => { throw new Error('DRY_RUN_BRAIN_INSPECT'); }
  });

  const candidates = [];
  try {
    for (const snap of snaps) {
      // Capturar logs para extraer lo que habrían hecho
      const { executed } = await executePortfolioActionsForCBO(snap, null, 10);
      // executed está vacío (todas fallaron DRY_RUN) pero ActionLog guardó
      // intentos fallidos con reasoning — esos son las recomendaciones
    }

    // Leer de ActionLog las acciones fallidas recientes de ares_portfolio (los intentos)
    const recentAttempts = await ActionLog.find({
      agent_type: 'ares_portfolio',
      executed_at: { $gte: new Date(Date.now() - 60000) },  // últimos 60s (lo que acabo de correr)
      success: false,
      error: { $regex: 'DRY_RUN_BRAIN_INSPECT' }
    }).sort({ executed_at: -1 }).lean();

    for (const a of recentAttempts) {
      candidates.push({
        detector: a.metadata?.detector,
        action: a.action,
        entity_type: a.entity_type,
        entity_id: a.entity_id,
        entity_name: a.entity_name,
        before: a.before_value,
        after: a.after_value,
        reasoning: (a.reasoning || '').substring(0, 200),
        metadata: a.metadata
      });
    }

    // Limpiar logs de DRY_RUN_BRAIN_INSPECT para no ensuciar historial
    await ActionLog.deleteMany({
      agent_type: 'ares_portfolio',
      error: 'DRY_RUN_BRAIN_INSPECT'
    });
  } finally {
    metaMod.getMetaClient = origGetClient;
  }

  return {
    total: candidates.length,
    candidates
  };
}

async function handleQueryAccountCaps() {
  try {
    const { getCapStatus } = require('../zeus/portfolio-capacity');
    const caps = await getCapStatus();
    return { caps };
  } catch (err) {
    return { error: 'portfolio-capacity module not available', message: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTE TOOL (dispatcher)
// ═══════════════════════════════════════════════════════════════════════════

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'query_cbo_health': return await handleQueryCBOHealth();
      case 'query_portfolio_state': return await handleQueryPortfolioState();
      case 'query_adset_detail': return await handleQueryAdsetDetail(input || {});
      case 'query_graduates': return await handleQueryGraduates(input || {});
      case 'query_starved_winners': return await handleQueryStarvedWinners();
      case 'query_recent_actions': return await handleQueryRecentActions(input || {});
      case 'get_portfolio_recommendations': return await handleGetPortfolioRecommendations();
      case 'query_account_caps': return await handleQueryAccountCaps();
      default: return { error: `tool no reconocida: ${name}` };
    }
  } catch (err) {
    logger.error(`[ARES-BRAIN-TOOLS] ${name} falló: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
