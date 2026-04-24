/**
 * Ares Brain Tools — tool definitions + handlers para Opus 4.7.
 *
 * Mismo patrón que src/ai/zeus/oracle-tools.js pero enfocado en decisiones
 * de Portfolio Management. El brain usa estas tools para explorar data y
 * ejecutar acciones bounded con safety gates.
 *
 * Commit 1 (read-only): solo queries.
 * Commit 2 (2026-04-24): añadidas 3 action tools — scale_cbo_budget,
 *   pause_adset, duplicate_adset_to_cbo. Todas pasan por los mismos safety
 *   gates del portfolio-manager procedural (cooldown + guard-rail + directive
 *   + capacity). Todas loggean ActionLog con agent_type='ares_brain' para
 *   distinguir de decisiones procedurales.
 * Commit 3 (2026-04-24): create_new_cbo — creación autónoma de CBOs con
 *   Ola 3 safety completa: cooldown cross-cycle 72h, max 2/week, emit
 *   SafetyEvent, ping proactivo a Zeus. Sin cap máximo de CBOs totales
 *   (decisión del creador).
 * Commit 4 (2026-04-24): learning loop — query_action_outcomes (lee
 *   ActionLog impact T+1d/3d/7d) + query_zeus_guidance (directives +
 *   journal + lessons). Ahora el brain ve qué funcionó y qué no de sus
 *   ciclos pasados, y lee lo que Zeus le enseñó. Self-calibration cycle
 *   to cycle.
 */

const MetricSnapshot = require('../../db/models/MetricSnapshot');
const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');
const ActionLog = require('../../db/models/ActionLog');
const TestRun = require('../../db/models/TestRun');
const SystemConfig = require('../../db/models/SystemConfig');
const logger = require('../../utils/logger');
const { runPortfolioAnalysis, _helpers: portfolioHelpers } = require('./ares-portfolio-manager');
const { CooldownManager } = require('../../safety/cooldown-manager');
const cooldowns = new CooldownManager();

// Cap absoluto por cambio de budget — aún si el LLM pide más, clamp aquí.
// Protección contra fuga de contexto o alucinación del modelo.
const BRAIN_BUDGET_CHANGE_MAX_PCT = 0.50;
const BRAIN_BUDGET_FLOOR = 30;  // no bajar CBO debajo de $30/d (coherente con portfolio floor $50, pero damos margen a tests)

// Ola 3 — creación autónoma de CBOs
const CBO_CREATE_COOLDOWN_HOURS = 72;         // Mínimo entre creaciones
const CBO_CREATE_MAX_PER_WEEK = 2;            // Cap duro semanal
const CBO_CREATE_BUDGET_MIN = 50;             // $50/d piso
const CBO_CREATE_BUDGET_MAX = 500;            // $500/d techo inicial (puede escalarse post-creación)
const CBO_CREATE_BUDGET_DEFAULT = 150;        // $150/d default si el LLM no pide
const CBO_CREATE_COOLDOWN_KEY = 'ares_brain_last_cbo_creation';  // SystemConfig key

async function logBrainAction({ entity_id, entity_name, entity_type, action, before_value, after_value, reasoning, metadata, success, error }) {
  try {
    await ActionLog.create({
      entity_type, entity_id, entity_name,
      action, success: !!success,
      executed_at: new Date(),
      agent_type: 'ares_brain',
      reasoning,
      before_value, after_value,
      metadata: metadata || {},
      error: error || null
    });
  } catch (err) {
    logger.error(`[ARES-BRAIN-TOOLS] logAction failed: ${err.message}`);
  }
}

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
  },
  // ─── LEARNING LOOP (Commit 4, 2026-04-24) ──────────────────────────────
  {
    name: 'query_action_outcomes',
    description: 'LO MÁS IMPORTANTE para aprendizaje. Retorna tus acciones pasadas (ares_brain + ares_portfolio) de los últimos N días CON sus outcomes medidos: ROAS delta 1d/3d/7d, CPA delta, verdict (positive/negative/neutral/pending). Usalo al INICIO de cada ciclo para ver qué funcionó y qué no. Si hiciste +15% y ROAS quedó flat → el paso fue tímido, next time ir más fuerte. Si pausaste zombie y CBO padre mejoró ROAS → confirma tesis. Si duplicaste y el clone no convirtió → ajustá criterio.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 7, description: 'Ventana en días. Default 7. Max 30.' },
        only_measured: { type: 'boolean', default: true, description: 'Si true, solo retorna acciones con impact ya medido (T+1d+). Si false, incluye pending.' },
        entity_id: { type: 'string', description: 'Opcional. Si pasás esto, filtra solo outcomes sobre esta CBO/adset.' }
      },
      required: []
    }
  },
  {
    name: 'query_zeus_guidance',
    description: 'Lee lo que Zeus (CEO) te está diciendo: (a) directivas activas para "ares" o "all", (b) últimos journal entries tipo lesson/mistake/pattern que puedan aplicarte, (c) hypotheses abiertas tocando portfolio. Usá esto cuando vayas a tomar una decisión grande (crear CBO, scale agresivo, kill batch) — chequeá si Zeus ya te dio contexto sobre esto. Hoy ya respetás directivas como bloqueos, esta tool te las muestra como ENSEÑANZA ("por qué existen"), no solo como reglas.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', default: 14, description: 'Cuántos días atrás leer journal. Default 14.' }
      },
      required: []
    }
  },
  // ─── WRITE TOOLS (Commit 2, 2026-04-24) ────────────────────────────────
  {
    name: 'scale_cbo_budget',
    description: 'Ajusta daily_budget de una CBO. Usá esto cuando hayas decidido scale_up/scale_down basado en tu análisis. Pasa por: cooldown 36h, guard-rail cap 50%, capacity, directive-guard. Si alguno bloquea, te lo digo y no se ejecuta — no es error, es diseño. Para scale_up: CBO healthy con evidencia ROAS sostenido. Para scale_down: protegé capital en CBOs underperforming. Reasoning obligatorio — queda auditable.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'ID de la CBO a ajustar' },
        new_daily_budget: { type: 'number', description: 'Nuevo budget en USD. Debe ser realista — si el cambio excede ±50% del actual, te lo rechazo.' },
        reasoning: { type: 'string', description: '2-3 oraciones con evidencia numérica. Ej: "ROAS 7d 3.2x sostenido con top-2 concentrando 88% spend. Scale +15% para que Meta explote cluster."' }
      },
      required: ['campaign_id', 'new_daily_budget', 'reasoning']
    }
  },
  {
    name: 'pause_adset',
    description: 'Pausa un adset (cambia status a PAUSED). Usá para: zombies confirmados (spend significativo + 0 conv + edad >5d), underperformers sostenidos, adsets en CBO saturada consumiendo overhead. Pasa por: cooldown 60h, directive-guard, capacity. NO pausá adsets en LEARNING (<72h). Reasoning obligatorio.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'ID del adset a pausar' },
        reasoning: { type: 'string', description: '2-3 oraciones con evidencia. Ej: "$75 spend 7d, 0 compras, 8d edad, ya salió de learning. Dentro de CBO saturada, consume overhead."' }
      },
      required: ['adset_id', 'reasoning']
    }
  },
  {
    name: 'create_new_cbo',
    description: 'Crea una CBO nueva en la cuenta de Meta. Úsala cuando: (a) hay cluster de 3+ winners (ROAS >3x) starved en CBOs saturadas y duplicate_adset_to_cbo no tiene target con headroom, (b) Prometheus graduates merecen campaign propia con budget dedicado, (c) diversificación: >70% del spend total concentrado en 1-2 CBOs. Safety Ola 3: cooldown 72h cross-cycle (no dos creaciones seguidas), max 2/semana total, emit SafetyEvent + ping a Zeus. La CBO se crea ACTIVA pero los adsets seed se duplican PAUSED para review. Reasoning debe ser excepcional — esta es la acción de mayor blast radius.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre de la CBO. Convención: "[Ares-Brain] Descripción - YYYY-MM-DD". Ej: "[Ares-Brain] Cluster Graduates - 2026-04-24"' },
        daily_budget: { type: 'number', description: `Daily budget en USD. Rango permitido: $${CBO_CREATE_BUDGET_MIN}-$${CBO_CREATE_BUDGET_MAX}. Default $${CBO_CREATE_BUDGET_DEFAULT}.` },
        objective: { type: 'string', description: 'Default OUTCOME_SALES (casi siempre esto para Jersey Pickles). Válidos: OUTCOME_SALES, OUTCOME_TRAFFIC, OUTCOME_LEADS.' },
        seed_adset_ids: { type: 'array', items: { type: 'string' }, description: 'IDs de adsets a duplicar a esta nueva CBO como seeds (PAUSED). Mínimo 1, máximo 5. Típicamente graduates de Prometheus o winners starved rescatados.' },
        reasoning: { type: 'string', description: '3-5 oraciones con evidencia detallada. Esta es la acción con mayor blast radius — justificá por qué una CBO NUEVA vs. duplicate_adset_to_cbo a una existente. Mencioná el cluster específico (nombres + ROAS + share actual).' }
      },
      required: ['name', 'daily_budget', 'seed_adset_ids', 'reasoning']
    }
  },
  {
    name: 'duplicate_adset_to_cbo',
    description: 'PATRÓN "MOVE" = duplica adset a CBO destino + pausa el original. Meta API NO permite mover adsets entre campañas, este es el workaround canónico. El duplicado se crea en PAUSED para que revises/actives manualmente. Si `pause_original: true` (default), el adset fuente se pausa como parte del mismo flujo. Usá para: rebalancear winners starved, mover graduates a CBO estable, redistribuir de CBO saturada a CBO con headroom. Cooldown 72h por entity.',
    input_schema: {
      type: 'object',
      properties: {
        source_adset_id: { type: 'string', description: 'ID del adset fuente' },
        target_campaign_id: { type: 'string', description: 'ID de la CBO destino' },
        new_daily_budget: { type: 'number', description: 'Budget del adset duplicado en USD. Default $75 si no se especifica. Conservá bajo — el duplicado arranca en learning.' },
        pause_original: { type: 'boolean', description: 'Si true (default), pausa el adset fuente al completar duplicación exitosa. Si false, solo duplica sin tocar el fuente (útil para testing en paralelo).' },
        reasoning: { type: 'string', description: '2-3 oraciones con evidencia de por qué mover. Ej: "Winner starved: ROAS 7d 3.4x, 3 compras, solo 2.1% del spend de CBO origen (saturada por cluster). Moviendo a CBO B con headroom."' }
      },
      required: ['source_adset_id', 'target_campaign_id', 'reasoning']
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// LEARNING LOOP HANDLERS (commit 4 — 2026-04-24)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computa el delta porcentual real entre dos valores numéricos de roas/cpa.
 * Retorna número redondeado 2 decimales o null si no computable.
 */
function deltaPct(before, after) {
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (before === 0) return null;
  return +(((after - before) / before) * 100).toFixed(2);
}

/**
 * Interpreta el outcome de una acción en lenguaje que el LLM entiende.
 * Esto es la capa que transforma números en aprendizaje accionable.
 */
function interpretOutcome(action, before, after1d, after3d, after7d) {
  // Deltas ROAS y spend
  const roasDelta1d = deltaPct(before.roas_7d, after1d?.roas_7d);
  const roasDelta3d = deltaPct(before.roas_7d, after3d?.roas_7d);
  const roasDelta7d = deltaPct(before.roas_7d, after7d?.roas_7d);
  const spendDelta1d = deltaPct(before.spend_today, after1d?.spend_today);
  const spendDelta3d = deltaPct(before.spend_today, after3d?.spend_today);

  // Verdict heurístico (el explicit follow_up_verdict también viene del documento)
  let heuristic_verdict = 'insufficient_data';
  const main_delta = roasDelta7d ?? roasDelta3d ?? roasDelta1d;
  if (main_delta !== null) {
    if (main_delta > 5) heuristic_verdict = 'improved';
    else if (main_delta < -5) heuristic_verdict = 'worsened';
    else heuristic_verdict = 'flat';
  }

  // Lección derivada — qué aprender de este outcome
  let lesson = null;
  if (action === 'scale_up' || action === 'scale_down') {
    if (heuristic_verdict === 'flat' && Math.abs(spendDelta3d || 0) > 5) {
      lesson = `Scale tuvo efecto en spend (${spendDelta3d}%) pero ROAS quedó flat — step fue tímido o CBO saturada. Next time: considerar step más agresivo O evaluar alternativa (create_cbo, mass_pause).`;
    } else if (heuristic_verdict === 'worsened') {
      lesson = `Scale empeoró ROAS (${main_delta}%). Si fue scale_up, puede ser que aumentamos budget en CBO sin winner claro. Si fue scale_down, puede que cortamos capital a CBO que sí estaba funcionando.`;
    } else if (heuristic_verdict === 'improved') {
      lesson = `Scale funcionó — ROAS mejoró ${main_delta}%. Patrón válido para CBOs similares.`;
    }
  } else if (action === 'pause' || action === 'pause_adset') {
    if (after3d?.roas_7d && before.roas_7d) {
      const parentImproved = heuristic_verdict === 'improved';
      lesson = parentImproved
        ? `Pause liberó capital y ROAS padre mejoró ${main_delta}%. Confirma tesis del zombie.`
        : `Pause no movió ROAS — quizás el adset no era el problema o la CBO padre tiene otros issues.`;
    }
  } else if (action === 'duplicate_adset') {
    lesson = 'Para duplicate outcomes, chequeá el adset clon en query_adset_detail — el impact measurement del source no refleja performance del clone.';
  }

  return {
    roas_delta_1d_pct: roasDelta1d,
    roas_delta_3d_pct: roasDelta3d,
    roas_delta_7d_pct: roasDelta7d,
    spend_delta_1d_pct: spendDelta1d,
    spend_delta_3d_pct: spendDelta3d,
    heuristic_verdict,
    lesson
  };
}

async function handleQueryActionOutcomes({ days_back = 7, only_measured = true, entity_id = null }) {
  const clampedDays = Math.min(Math.max(days_back, 1), 30);
  const since = new Date(Date.now() - clampedDays * 86400000);

  const query = {
    agent_type: { $in: ['ares_brain', 'ares_portfolio'] },
    success: true,
    executed_at: { $gte: since }
  };
  if (only_measured) {
    query.$or = [
      { impact_1d_measured: true },
      { impact_measured: true },
      { impact_7d_measured: true }
    ];
  }
  if (entity_id) query.entity_id = entity_id;

  const actions = await ActionLog.find(query)
    .sort({ executed_at: -1 })
    .limit(30)
    .lean();

  const outcomes = actions.map(a => {
    const before = a.metrics_at_execution || {};
    const interpretation = interpretOutcome(a.action, before, a.metrics_after_1d, a.metrics_after_3d, a.metrics_after_7d);
    return {
      action_id: a._id,
      executed_at: a.executed_at,
      agent: a.agent_type,
      action: a.action,
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      entity_name: a.entity_name,
      before_value: a.before_value,
      after_value: a.after_value,
      reasoning: (a.reasoning || '').substring(0, 300),
      detector: a.metadata?.detector || (a.metadata?.source === 'ares_brain_decision' ? 'brain_llm' : null),
      measured: {
        impact_1d: a.impact_1d_measured,
        impact_3d: a.impact_measured,
        impact_7d: a.impact_7d_measured
      },
      // Explicit follow_up_verdict del documento (si está set) + heurístico nuestro
      follow_up_verdict: a.follow_up_verdict,
      follow_up_deltas: a.follow_up_deltas,
      outcome: interpretation
    };
  });

  // Agregados para señales rápidas
  const aggregates = {
    total: outcomes.length,
    by_verdict: outcomes.reduce((acc, o) => {
      const v = o.outcome.heuristic_verdict;
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {}),
    by_action: outcomes.reduce((acc, o) => {
      acc[o.action] = (acc[o.action] || 0) + 1;
      return acc;
    }, {})
  };

  return {
    days_back: clampedDays,
    only_measured,
    filtered_by_entity: entity_id || null,
    aggregates,
    outcomes
  };
}

async function handleQueryZeusGuidance({ days_back = 14 }) {
  const ZeusDirective = require('../../db/models/ZeusDirective');
  const ZeusJournalEntry = require('../../db/models/ZeusJournalEntry');
  const ZeusHypothesis = require('../../db/models/ZeusHypothesis');

  const clampedDays = Math.min(Math.max(days_back, 1), 60);
  const since = new Date(Date.now() - clampedDays * 86400000);

  const [directives, journalEntries, hypotheses] = await Promise.all([
    // Directivas activas para ares o all
    ZeusDirective.find({
      target_agent: { $in: ['ares', 'all'] },
      active: true,
      $or: [
        { expires_at: null },
        { expires_at: { $gt: new Date() } }
      ]
    }).sort({ created_at: -1 }).limit(20).lean().catch(() => []),

    // Journal entries recientes que puedan aplicar
    ZeusJournalEntry.find({
      entry_type: { $in: ['lesson', 'mistake', 'pattern', 'weekly_reflection', 'observation'] },
      created_at: { $gte: since }
    }).sort({ created_at: -1 }).limit(15).lean().catch(() => []),

    // Hipótesis relacionadas a portfolio (si el modelo existe)
    ZeusHypothesis.find({
      status: { $in: ['open', 'testing', 'monitoring'] }
    }).sort({ created_at: -1 }).limit(10).lean().catch(() => [])
  ]);

  // Filtrar journal entries a los que tengan relevancia para ares/portfolio
  const arePortfolioKeywords = /ares|portfolio|cbo|budget|scale|starvation|saturation|winner|graduate|duplicate/i;
  const relevantJournal = journalEntries.filter(e => {
    const text = `${e.title || ''} ${e.content || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
    return arePortfolioKeywords.test(text);
  });

  const relevantHypotheses = hypotheses.filter(h => {
    const text = `${h.title || ''} ${h.hypothesis || ''} ${h.target_pattern || ''}`.toLowerCase();
    return arePortfolioKeywords.test(text);
  });

  return {
    directives: {
      total: directives.length,
      items: directives.map(d => ({
        id: d._id,
        target: d.target_agent,
        type: d.directive_type,
        text: d.directive,
        category: d.category,
        source: d.source,
        confidence: d.confidence,
        based_on_samples: d.based_on_samples,
        persistent: d.persistent,
        action_scope: d.action_scope || null,   // structured scope (si existe)
        llm_can_override: !!d.llm_can_override, // el brain puede pinguear override?
        created_at: d.created_at,
        expires_at: d.expires_at,
        executed: d.executed
      }))
    },
    lessons: {
      total: relevantJournal.length,
      items: relevantJournal.map(e => ({
        id: e._id,
        type: e.entry_type,
        title: e.title,
        content: (e.content || '').substring(0, 500),
        importance: e.importance,
        tags: e.tags,
        created_at: e.created_at
      }))
    },
    hypotheses: {
      total: relevantHypotheses.length,
      items: relevantHypotheses.map(h => ({
        id: h._id,
        title: h.title,
        hypothesis: (h.hypothesis || '').substring(0, 400),
        status: h.status,
        target_pattern: h.target_pattern,
        predicted_impact: h.predicted_impact,
        created_at: h.created_at
      }))
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS (commit 2 — 2026-04-24)
// Todas respetan los mismos safety gates que ares-portfolio-manager
// (cooldown, guard-rail, directive-guard granular, portfolio-capacity) +
// loggean ActionLog con agent_type='ares_brain' para auditoría separada.
// ═══════════════════════════════════════════════════════════════════════════

async function handleScaleCBOBudget({ campaign_id, new_daily_budget, reasoning }) {
  if (!campaign_id) return { error: 'campaign_id requerido' };
  if (typeof new_daily_budget !== 'number' || new_daily_budget <= 0) return { error: 'new_daily_budget inválido' };
  if (!reasoning || reasoning.length < 20) return { error: 'reasoning obligatorio (min 20 chars)' };

  // Cargar snapshot actual para before_value
  const snap = await MetricSnapshot.findOne({
    entity_type: 'campaign',
    entity_id: campaign_id
  }).sort({ snapshot_at: -1 }).lean();
  if (!snap) return { error: `campaign ${campaign_id} no encontrada` };

  const currentBudget = snap.daily_budget || 0;
  if (currentBudget <= 0) return { error: 'campaign sin daily_budget (ABO?)' };

  // Clamp absoluto independiente del LLM
  const pct = Math.abs((new_daily_budget - currentBudget) / currentBudget);
  if (pct > BRAIN_BUDGET_CHANGE_MAX_PCT) {
    return {
      rejected: true,
      reason: `cambio ${(pct*100).toFixed(0)}% > ${BRAIN_BUDGET_CHANGE_MAX_PCT*100}% max permitido por ciclo`,
      suggestion: `new_daily_budget debería estar entre $${Math.round(currentBudget * (1 - BRAIN_BUDGET_CHANGE_MAX_PCT))} y $${Math.round(currentBudget * (1 + BRAIN_BUDGET_CHANGE_MAX_PCT))}`
    };
  }
  const target = Math.max(Math.round(new_daily_budget), BRAIN_BUDGET_FLOOR);
  if (target === currentBudget) return { rejected: true, reason: 'nuevo budget idéntico al actual' };

  const actionType = target > currentBudget ? 'scale_up' : 'scale_down';

  // Gate compuesto — reusa el del portfolio-manager
  const gate = await portfolioHelpers.validateSafetyGates({
    entity_id: campaign_id,
    action_type: actionType,
    before_value: currentBudget,
    after_value: target
  });
  if (!gate.allowed) {
    await logBrainAction({
      entity_type: 'campaign', entity_id: campaign_id, entity_name: snap.entity_name,
      action: actionType, before_value: currentBudget, after_value: target,
      reasoning, metadata: { blocked_by: gate.reason, source: 'ares_brain_decision' },
      success: false, error: `gate_blocked: ${gate.reason}`
    });
    return { blocked: true, reason: gate.reason };
  }

  // Dedup LLM: si ares_brain ya scaled misma CBO en últimas 24h, skip
  const recentBrain = await ActionLog.findOne({
    entity_id: campaign_id,
    action: { $in: ['scale_up', 'scale_down'] },
    agent_type: 'ares_brain',
    executed_at: { $gte: new Date(Date.now() - 24 * 3600000) }
  }).lean();
  if (recentBrain) {
    return { blocked: true, reason: `brain ya actuó sobre esta CBO en últimas 24h (${recentBrain.action} a las ${recentBrain.executed_at})` };
  }

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateBudget(campaign_id, target);

    await cooldowns.setCooldown(campaign_id, 'campaign', actionType, 'ares_brain');
    await logBrainAction({
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: snap.entity_name,
      action: actionType,
      before_value: currentBudget,
      after_value: target,
      reasoning,
      metadata: { source: 'ares_brain_decision', pct_change: +pct.toFixed(3) },
      success: true
    });
    logger.info(`[ARES-BRAIN] ${actionType === 'scale_up' ? '↑' : '↓'} CBO "${snap.entity_name}" $${currentBudget}→$${target} (brain decision)`);
    return { executed: true, before: currentBudget, after: target, action: actionType };
  } catch (err) {
    await logBrainAction({
      entity_type: 'campaign', entity_id: campaign_id, entity_name: snap.entity_name,
      action: actionType, before_value: currentBudget, after_value: target,
      reasoning, metadata: { source: 'ares_brain_decision' },
      success: false, error: err.message
    });
    logger.error(`[ARES-BRAIN] scale_cbo_budget falló ${campaign_id}: ${err.message}`);
    return { error: `meta API falló: ${err.message}` };
  }
}

async function handlePauseAdset({ adset_id, reasoning }) {
  if (!adset_id) return { error: 'adset_id requerido' };
  if (!reasoning || reasoning.length < 20) return { error: 'reasoning obligatorio (min 20 chars)' };

  const snap = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: adset_id
  }).sort({ snapshot_at: -1 }).lean();
  if (!snap) return { error: `adset ${adset_id} no encontrado` };
  if (snap.status !== 'ACTIVE') return { rejected: true, reason: `adset ya está en estado ${snap.status}` };

  // Proteger learning phase — hard rule del brain, no dejamos que Opus salte
  const first = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: adset_id
  }).sort({ snapshot_at: 1 }).lean();
  const ageHours = first
    ? (Date.now() - new Date(first.snapshot_at).getTime()) / 3600000
    : 999;
  if (ageHours < 72) {
    return { blocked: true, reason: `adset con <72h en sistema (${Math.round(ageHours)}h) — protegido en learning phase` };
  }

  const gate = await portfolioHelpers.validateSafetyGates({
    entity_id: adset_id,
    action_type: 'pause'
  });
  if (!gate.allowed) {
    await logBrainAction({
      entity_type: 'adset', entity_id: adset_id, entity_name: snap.entity_name,
      action: 'pause', before_value: 'ACTIVE', after_value: 'PAUSED',
      reasoning, metadata: { blocked_by: gate.reason, source: 'ares_brain_decision' },
      success: false, error: `gate_blocked: ${gate.reason}`
    });
    return { blocked: true, reason: gate.reason };
  }

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();
    await meta.updateStatus(adset_id, 'PAUSED');

    await cooldowns.setCooldown(adset_id, 'adset', 'pause', 'ares_brain');
    await logBrainAction({
      entity_type: 'adset',
      entity_id: adset_id,
      entity_name: snap.entity_name,
      action: 'pause',
      before_value: 'ACTIVE',
      after_value: 'PAUSED',
      reasoning,
      metadata: { source: 'ares_brain_decision', parent_cbo: snap.campaign_id, age_hours: Math.round(ageHours) },
      success: true
    });
    logger.info(`[ARES-BRAIN] ✓ paused adset "${snap.entity_name}" (brain decision)`);
    return { executed: true, adset_name: snap.entity_name, age_hours: Math.round(ageHours) };
  } catch (err) {
    await logBrainAction({
      entity_type: 'adset', entity_id: adset_id, entity_name: snap.entity_name,
      action: 'pause', before_value: 'ACTIVE', after_value: 'PAUSED',
      reasoning, metadata: { source: 'ares_brain_decision' },
      success: false, error: err.message
    });
    logger.error(`[ARES-BRAIN] pause_adset falló ${adset_id}: ${err.message}`);
    return { error: `meta API falló: ${err.message}` };
  }
}

async function handleDuplicateAdsetToCBO({ source_adset_id, target_campaign_id, new_daily_budget, pause_original, reasoning }) {
  if (!source_adset_id) return { error: 'source_adset_id requerido' };
  if (!target_campaign_id) return { error: 'target_campaign_id requerido' };
  if (!reasoning || reasoning.length < 20) return { error: 'reasoning obligatorio (min 20 chars)' };

  const budget = typeof new_daily_budget === 'number' && new_daily_budget > 0 ? new_daily_budget : 75;
  const shouldPauseOriginal = pause_original !== false;

  const srcSnap = await MetricSnapshot.findOne({
    entity_type: 'adset',
    entity_id: source_adset_id
  }).sort({ snapshot_at: -1 }).lean();
  if (!srcSnap) return { error: `source adset ${source_adset_id} no encontrado` };

  // Protección: no duplicar a misma CBO (sería ruido, no rebalanceo)
  if (srcSnap.campaign_id === target_campaign_id) {
    return { rejected: true, reason: 'target_campaign_id == source campaign_id — sería duplicar dentro del mismo CBO' };
  }

  // Validar target existe y es CBO activa
  const targetSnap = await MetricSnapshot.findOne({
    entity_type: 'campaign',
    entity_id: target_campaign_id
  }).sort({ snapshot_at: -1 }).lean();
  if (!targetSnap) return { error: `target campaign ${target_campaign_id} no encontrada` };
  if (targetSnap.status !== 'ACTIVE') return { rejected: true, reason: `target campaign en estado ${targetSnap.status}` };
  if (!(targetSnap.daily_budget > 0)) return { rejected: true, reason: 'target no es CBO (sin daily_budget)' };

  // Gate: duplicate_adset action
  const gate = await portfolioHelpers.validateSafetyGates({
    entity_id: source_adset_id,
    action_type: 'duplicate_adset'
  });
  if (!gate.allowed) {
    await logBrainAction({
      entity_type: 'adset', entity_id: source_adset_id, entity_name: srcSnap.entity_name,
      action: 'duplicate_adset',
      reasoning, metadata: { blocked_by: gate.reason, source: 'ares_brain_decision' },
      success: false, error: `gate_blocked: ${gate.reason}`
    });
    return { blocked: true, reason: gate.reason };
  }

  // Si vamos a pausar el original, chequear cooldown de pause también
  if (shouldPauseOriginal) {
    const pauseGate = await portfolioHelpers.validateSafetyGates({
      entity_id: source_adset_id,
      action_type: 'pause'
    });
    if (!pauseGate.allowed) {
      return { blocked: true, reason: `duplicate OK pero pause original bloqueada (${pauseGate.reason}). Corré con pause_original=false o esperá.` };
    }
  }

  const cloneName = `[Ares-Brain] ${srcSnap.entity_name}`;

  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // 1. Duplicar
    const dupResult = await meta.duplicateAdSet(source_adset_id, {
      campaign_id: target_campaign_id,
      deep_copy: true,
      name: cloneName,
      status: 'PAUSED'  // duplicado siempre PAUSED — brain no activa, review manual
    });

    if (!dupResult?.success || !dupResult?.new_adset_id) {
      throw new Error(dupResult?.error || 'duplicateAdSet sin new_adset_id');
    }

    await cooldowns.setCooldown(source_adset_id, 'adset', 'duplicate_adset', 'ares_brain');
    await logBrainAction({
      entity_type: 'adset',
      entity_id: source_adset_id,
      entity_name: srcSnap.entity_name,
      action: 'duplicate_adset',
      before_value: srcSnap.campaign_id,
      after_value: target_campaign_id,
      reasoning,
      metadata: {
        source: 'ares_brain_decision',
        new_adset_id: dupResult.new_adset_id,
        target_campaign_id,
        target_campaign_name: targetSnap.entity_name,
        clone_status: 'PAUSED',
        clone_budget: budget,
        pause_original_planned: shouldPauseOriginal
      },
      success: true
    });
    logger.info(`[ARES-BRAIN] ✓ duplicated "${srcSnap.entity_name}" → "${targetSnap.entity_name}" (new_id=${dupResult.new_adset_id}, PAUSED)`);

    // 2. Pausar original (opcional — el "move" pattern)
    let pausedOriginal = false;
    let pauseError = null;
    if (shouldPauseOriginal) {
      try {
        await meta.updateStatus(source_adset_id, 'PAUSED');
        await cooldowns.setCooldown(source_adset_id, 'adset', 'pause', 'ares_brain');
        await logBrainAction({
          entity_type: 'adset', entity_id: source_adset_id, entity_name: srcSnap.entity_name,
          action: 'pause', before_value: 'ACTIVE', after_value: 'PAUSED',
          reasoning: `Pause original tras duplicar "${srcSnap.entity_name}" → CBO "${targetSnap.entity_name}" (new_id=${dupResult.new_adset_id}). Motivo del move: ${reasoning}`,
          metadata: {
            source: 'ares_brain_decision',
            move_pair: dupResult.new_adset_id,
            parent_cbo: srcSnap.campaign_id
          },
          success: true
        });
        pausedOriginal = true;
        logger.info(`[ARES-BRAIN] ✓ paused original "${srcSnap.entity_name}" (move pair ${dupResult.new_adset_id})`);
      } catch (err) {
        pauseError = err.message;
        logger.error(`[ARES-BRAIN] duplicate OK pero pause original falló: ${err.message}`);
      }
    }

    return {
      executed: true,
      new_adset_id: dupResult.new_adset_id,
      new_adset_status: 'PAUSED',
      source_paused: pausedOriginal,
      source_pause_error: pauseError,
      target_cbo_name: targetSnap.entity_name,
      requires_manual_activation: true
    };
  } catch (err) {
    await logBrainAction({
      entity_type: 'adset', entity_id: source_adset_id, entity_name: srcSnap.entity_name,
      action: 'duplicate_adset',
      reasoning, metadata: { source: 'ares_brain_decision', target_campaign_id },
      success: false, error: err.message
    });
    logger.error(`[ARES-BRAIN] duplicate_adset_to_cbo falló ${source_adset_id}: ${err.message}`);
    return { error: `meta API falló: ${err.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE NEW CBO (commit 3 — Ola 3 safety)
// ═══════════════════════════════════════════════════════════════════════════

async function emitSafetyEvent({ type, severity, description, details, entity_id, entity_name }) {
  try {
    const SafetyEvent = require('../../db/models/SafetyEvent');
    await SafetyEvent.create({
      event_type: type,
      severity,
      description,
      details: details || {},
      entity_id: entity_id || null,
      entity_name: entity_name || null,
      created_at: new Date()
    });
  } catch (err) {
    logger.error(`[ARES-BRAIN-TOOLS] SafetyEvent emit failed: ${err.message}`);
  }
}

async function pingZeusProactive({ content, context_snapshot }) {
  try {
    const ZeusChatMessage = require('../../db/models/ZeusChatMessage');
    const lastMsg = await ZeusChatMessage.findOne({}).sort({ created_at: -1 }).lean();
    if (!lastMsg?.conversation_id) {
      logger.warn('[ARES-BRAIN-TOOLS] no conversation found, skip Zeus ping');
      return { sent: false, reason: 'no_conversation' };
    }
    await ZeusChatMessage.create({
      conversation_id: lastMsg.conversation_id,
      role: 'assistant',
      content,
      proactive: true,
      context_snapshot: context_snapshot || {}
    });
    logger.info(`[ARES-BRAIN-TOOLS] ping proactivo a Zeus (conv=${lastMsg.conversation_id})`);
    return { sent: true, conversation_id: lastMsg.conversation_id };
  } catch (err) {
    logger.error(`[ARES-BRAIN-TOOLS] Zeus ping falló: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

async function handleCreateNewCBO({ name, daily_budget, objective, seed_adset_ids, reasoning }) {
  // Validaciones de input
  if (!name || name.length < 10) return { error: 'name obligatorio (min 10 chars, usá convención "[Ares-Brain] ...")' };
  if (!reasoning || reasoning.length < 60) return { error: 'reasoning obligatorio (min 60 chars — esta acción requiere justificación detallada)' };
  if (!Array.isArray(seed_adset_ids) || seed_adset_ids.length === 0) {
    return { error: 'seed_adset_ids requerido (al menos 1 adset existente para duplicar a la CBO)' };
  }
  if (seed_adset_ids.length > 5) {
    return { rejected: true, reason: `max 5 seeds por CBO nueva (pediste ${seed_adset_ids.length})` };
  }
  const validObjectives = ['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS'];
  const resolvedObjective = objective || 'OUTCOME_SALES';
  if (!validObjectives.includes(resolvedObjective)) {
    return { error: `objective "${resolvedObjective}" inválido. Válidos: ${validObjectives.join(', ')}` };
  }

  // Budget clamp
  const budgetNum = typeof daily_budget === 'number' ? daily_budget : CBO_CREATE_BUDGET_DEFAULT;
  if (budgetNum < CBO_CREATE_BUDGET_MIN || budgetNum > CBO_CREATE_BUDGET_MAX) {
    return {
      rejected: true,
      reason: `daily_budget $${budgetNum} fuera de rango permitido [$${CBO_CREATE_BUDGET_MIN}-$${CBO_CREATE_BUDGET_MAX}]`
    };
  }
  const resolvedBudget = Math.round(budgetNum);

  // ─── SAFETY OLA 3 ────────────────────────────────────────────────────

  // 1. Cooldown cross-cycle 72h via SystemConfig
  try {
    const lastCreation = await SystemConfig.get(CBO_CREATE_COOLDOWN_KEY);
    if (lastCreation?.at) {
      const hoursSince = (Date.now() - new Date(lastCreation.at).getTime()) / 3600000;
      if (hoursSince < CBO_CREATE_COOLDOWN_HOURS) {
        const remainingH = Math.round(CBO_CREATE_COOLDOWN_HOURS - hoursSince);
        await emitSafetyEvent({
          type: 'autonomous_cbo_blocked',
          severity: 'info',
          description: `CBO creation blocked por cooldown 72h (${remainingH}h restantes)`,
          details: { attempted_name: name, reasoning: reasoning.substring(0, 300), blocked_reason: 'cooldown_72h', last_creation_at: lastCreation.at }
        });
        return { blocked: true, reason: `cooldown 72h: última creación hace ${Math.round(hoursSince)}h, esperá ${remainingH}h más`, last_creation_at: lastCreation.at };
      }
    }
  } catch (err) {
    logger.warn(`[ARES-BRAIN-TOOLS] cooldown check falló (fail-open): ${err.message}`);
  }

  // 2. Max 2/week via ActionLog query
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const creationsThisWeek = await ActionLog.countDocuments({
      agent_type: 'ares_brain',
      action: 'create_campaign',
      success: true,
      executed_at: { $gte: weekAgo }
    });
    if (creationsThisWeek >= CBO_CREATE_MAX_PER_WEEK) {
      await emitSafetyEvent({
        type: 'autonomous_cbo_blocked',
        severity: 'warning',
        description: `CBO creation blocked por cap semanal (${creationsThisWeek}/${CBO_CREATE_MAX_PER_WEEK})`,
        details: { attempted_name: name, reasoning: reasoning.substring(0, 300), blocked_reason: 'weekly_cap', creations_this_week: creationsThisWeek }
      });
      return { blocked: true, reason: `cap semanal alcanzado: ${creationsThisWeek}/${CBO_CREATE_MAX_PER_WEEK} CBOs creadas en últimos 7d`, creations_this_week: creationsThisWeek };
    }
  } catch (err) {
    logger.warn(`[ARES-BRAIN-TOOLS] weekly cap check falló (fail-open): ${err.message}`);
  }

  // 3. Directive guard
  try {
    const { isActionBlockedForAgent } = require('../zeus/directive-guard');
    const directiveBlock = await isActionBlockedForAgent('ares', 'create_campaign');
    if (directiveBlock.blocked) {
      await emitSafetyEvent({
        type: 'autonomous_cbo_blocked',
        severity: 'warning',
        description: `CBO creation blocked por directiva Zeus: ${directiveBlock.reason}`,
        details: { attempted_name: name, blocked_reason: 'directive' }
      });
      return { blocked: true, reason: `directiva Zeus: ${directiveBlock.reason}` };
    }
  } catch (err) {
    logger.warn(`[ARES-BRAIN-TOOLS] directive check falló (fail-open): ${err.message}`);
  }

  // 4. Validar seed adsets existen y están ACTIVE
  const seedSnaps = [];
  for (const sid of seed_adset_ids) {
    const snap = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: sid })
      .sort({ snapshot_at: -1 }).lean();
    if (!snap) return { error: `seed adset ${sid} no encontrado` };
    if (snap.status !== 'ACTIVE') return { rejected: true, reason: `seed adset ${sid} en estado ${snap.status}` };
    seedSnaps.push(snap);
  }

  // ─── EJECUCIÓN ───────────────────────────────────────────────────────

  let campaignId = null;
  let createdAt = null;
  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // Crear CBO ACTIVA (los seeds entran PAUSED, así que no hay spend aún)
    const result = await meta.createCampaign({
      name,
      objective: resolvedObjective,
      status: 'ACTIVE',
      daily_budget: resolvedBudget
    });

    if (!result?.campaign_id) throw new Error('createCampaign sin campaign_id');
    campaignId = result.campaign_id;
    createdAt = new Date();

    // Persistir cooldown timestamp antes de intentar seeds — si los seeds fallan,
    // la CBO existe y ya consumió el cooldown
    await SystemConfig.set(CBO_CREATE_COOLDOWN_KEY, { at: createdAt.toISOString(), campaign_id: campaignId, name });

    await logBrainAction({
      entity_type: 'campaign',
      entity_id: campaignId,
      entity_name: name,
      action: 'create_campaign',
      before_value: null,
      after_value: resolvedBudget,
      reasoning,
      metadata: {
        source: 'ares_brain_decision',
        objective: resolvedObjective,
        daily_budget: resolvedBudget,
        seed_count: seed_adset_ids.length,
        ola: 3
      },
      success: true
    });
    logger.info(`[ARES-BRAIN] ✓✓ CREATED CBO "${name}" id=${campaignId} budget=$${resolvedBudget}/d`);
  } catch (err) {
    await logBrainAction({
      entity_type: 'campaign', entity_id: 'new', entity_name: name,
      action: 'create_campaign', before_value: null, after_value: resolvedBudget,
      reasoning, metadata: { source: 'ares_brain_decision', ola: 3 },
      success: false, error: err.message
    });
    logger.error(`[ARES-BRAIN] create_new_cbo falló: ${err.message}`);
    return { error: `meta API falló al crear CBO: ${err.message}` };
  }

  // ─── DUPLICAR SEEDS A LA NUEVA CBO (PAUSED) ──────────────────────────

  const seedsResult = [];
  for (const snap of seedSnaps) {
    try {
      const { getMetaClient } = require('../../meta/client');
      const meta = getMetaClient();
      const dup = await meta.duplicateAdSet(snap.entity_id, {
        campaign_id: campaignId,
        deep_copy: true,
        name: `[Seed] ${snap.entity_name}`,
        status: 'PAUSED'
      });
      if (dup?.success && dup?.new_adset_id) {
        await logBrainAction({
          entity_type: 'adset',
          entity_id: snap.entity_id,
          entity_name: snap.entity_name,
          action: 'duplicate_adset',
          before_value: snap.campaign_id,
          after_value: campaignId,
          reasoning: `Seed de CBO nueva "${name}" (${campaignId})`,
          metadata: {
            source: 'ares_brain_decision',
            parent_action: 'create_campaign',
            new_adset_id: dup.new_adset_id,
            new_cbo_id: campaignId,
            new_adset_status: 'PAUSED'
          },
          success: true
        });
        seedsResult.push({ source_id: snap.entity_id, source_name: snap.entity_name, new_adset_id: dup.new_adset_id, ok: true });
      } else {
        seedsResult.push({ source_id: snap.entity_id, source_name: snap.entity_name, ok: false, error: dup?.error || 'unknown' });
      }
    } catch (err) {
      seedsResult.push({ source_id: snap.entity_id, source_name: snap.entity_name, ok: false, error: err.message });
      logger.error(`[ARES-BRAIN] seed dup falló ${snap.entity_id}: ${err.message}`);
    }
  }
  const seedsOk = seedsResult.filter(s => s.ok).length;

  // ─── SAFETY EVENT + PROACTIVE PING ──────────────────────────────────

  await emitSafetyEvent({
    type: 'autonomous_cbo_created',
    severity: 'warning',
    description: `Ares Brain creó CBO autónoma "${name}" con budget $${resolvedBudget}/d + ${seedsOk}/${seed_adset_ids.length} seeds`,
    entity_id: campaignId,
    entity_name: name,
    details: {
      campaign_id: campaignId,
      daily_budget: resolvedBudget,
      objective: resolvedObjective,
      seeds: seedsResult,
      reasoning: reasoning.substring(0, 500),
      created_at: createdAt
    }
  });

  const zeusMsg = `**Ares Brain creó CBO nueva:** "${name}"\n\n- Campaign ID: \`${campaignId}\`\n- Budget: $${resolvedBudget}/d\n- Seeds duplicados (PAUSED): ${seedsOk}/${seed_adset_ids.length}\n- Objective: ${resolvedObjective}\n\n**Razón:** ${reasoning}\n\n_Los seeds están PAUSED — revisalos y activá los que quieras. La CBO madre está ACTIVA pero sin spend hasta que se activen adsets. Esta es decisión Ola 3 autónoma, sale en \`autonomous_cbo_created\` SafetyEvent._`;

  await pingZeusProactive({
    content: zeusMsg,
    context_snapshot: {
      source: 'ares_brain_create_cbo',
      campaign_id: campaignId,
      seeds: seedsResult
    }
  });

  return {
    executed: true,
    campaign_id: campaignId,
    campaign_name: name,
    daily_budget: resolvedBudget,
    objective: resolvedObjective,
    seeds_duplicated: seedsOk,
    seeds_failed: seedsResult.length - seedsOk,
    seeds_detail: seedsResult,
    safety_event_emitted: true,
    zeus_pinged: true,
    note: 'CBO activa, seeds PAUSED para review'
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
      // Learning loop (commit 4)
      case 'query_action_outcomes': return await handleQueryActionOutcomes(input || {});
      case 'query_zeus_guidance': return await handleQueryZeusGuidance(input || {});
      // Action tools (commit 2)
      case 'scale_cbo_budget': return await handleScaleCBOBudget(input || {});
      case 'pause_adset': return await handlePauseAdset(input || {});
      case 'duplicate_adset_to_cbo': return await handleDuplicateAdsetToCBO(input || {});
      // Ola 3 (commit 3) — autonomous CBO creation
      case 'create_new_cbo': return await handleCreateNewCBO(input || {});
      default: return { error: `tool no reconocida: ${name}` };
    }
  } catch (err) {
    logger.error(`[ARES-BRAIN-TOOLS] ${name} falló: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
