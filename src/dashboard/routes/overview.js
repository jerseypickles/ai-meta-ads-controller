const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const { getLatestSnapshots } = require('../../db/queries');

// Mapa agent_type (ActionLog) → id de orbe de la galaxia
const AGENT_TYPE_MAP = {
  account_agent: 'athena', athena: 'athena',
  creative_agent: 'apollo', apollo: 'apollo',
  testing_agent: 'prometheus', prometheus: 'prometheus',
  ares_agent: 'ares', ares_brain: 'ares', ares_portfolio: 'ares',
  demeter: 'demeter',
  dionysus: 'dionisio', dionisio: 'dionisio',
  hermes: 'hermes',
  zeus: 'zeus', zeus_oracle: 'zeus'
};

const AGENT_IDS = ['zeus', 'athena', 'apollo', 'prometheus', 'demeter', 'dionisio', 'ares', 'hermes'];

// ═══ GET /api/overview — snapshot para la vista galaxia ═══
router.get('/', async (req, res) => {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

    const [campaigns, adsets, recentActions] = await Promise.all([
      getLatestSnapshots('campaign'),
      getLatestSnapshots('adset'),
      ActionLog.find({ created_at: { $gte: startOfDay } }).sort({ created_at: -1 }).limit(200).lean()
    ]);

    // ── KPIs globales (hoy) ── spend/revenue desde campañas; budget desde adsets
    let spendToday = 0, revenueToday = 0, activeBudget = 0;
    for (const c of (campaigns || [])) {
      if (c.status !== 'ACTIVE') continue;
      const t = c.metrics?.today || c.metrics?.last_1d || {};
      spendToday += t.spend || 0;
      revenueToday += (t.spend || 0) * (t.roas || 0);
    }
    for (const a of (adsets || [])) {
      if (a.status === 'ACTIVE') activeBudget += a.daily_budget || 0;
    }
    const global = {
      roas_today: spendToday > 0 ? +(revenueToday / spendToday).toFixed(2) : 0,
      revenue_today: Math.round(revenueToday),
      active_budget: Math.round(activeBudget),
      spend_today: Math.round(spendToday)
    };

    // ── Por agente: status + acciones hoy + última acción ──
    const byAgent = {};
    for (const id of AGENT_IDS) byAgent[id] = { id, status: 'active', actions_today: 0, last_action: null };
    for (const a of recentActions) {
      const id = AGENT_TYPE_MAP[a.agent_type];
      if (!id || !byAgent[id]) continue;
      byAgent[id].actions_today += 1;
      if (!byAgent[id].last_action) {
        byAgent[id].last_action = {
          action: a.action, entity_name: a.entity_name,
          reasoning: (a.reasoning || '').slice(0, 160),
          at: a.created_at, success: a.success
        };
      }
    }

    // KPIs específicos de Ares (slice end-to-end real)
    const aresCbos = (campaigns || []).filter(c => c.status === 'ACTIVE' && /\[ares|\[seed|graduates exploration|winners famélicos/i.test(c.entity_name || ''));
    byAgent.ares.kpis = {
      cbos_activos: aresCbos.length,
      spend_hoy: Math.round(aresCbos.reduce((s, c) => s + ((c.metrics?.today || c.metrics?.last_1d || {}).spend || 0), 0))
    };

    // KPIs reales del resto de agentes (fail-soft: cada query en su try)
    const w7 = new Date(Date.now() - 7 * 86400000);
    try {
      const TestRun = require('../../db/models/TestRun');
      const [testsActivos, grad7, killed7] = await Promise.all([
        TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } }),
        TestRun.countDocuments({ phase: 'graduated', graduated_at: { $gte: w7 } }),
        TestRun.countDocuments({ phase: 'killed', $or: [{ killed_at: { $gte: w7 } }, { updated_at: { $gte: w7 } }] })
      ]);
      const wr = (grad7 + killed7) > 0 ? Math.round((grad7 / (grad7 + killed7)) * 100) : 0;
      byAgent.prometheus.kpis = { tests_activos: testsActivos, win_rate: wr };
    } catch (e) { logger.warn(`[OVERVIEW] prometheus kpis: ${e.message}`); }
    try {
      const CreativeProposal = require('../../db/models/CreativeProposal');
      byAgent.apollo.kpis = { creativos_7d: await CreativeProposal.countDocuments({ created_at: { $gte: w7 } }) };
    } catch (e) { logger.warn(`[OVERVIEW] apollo kpis: ${e.message}`); }
    try {
      const { getAccountCashSignal } = require('../../ai/agent/demeter-cash-signal');
      const cs = await getAccountCashSignal();
      byAgent.demeter.kpis = { cash_roas: cs.available ? +Number(cs.cash_roas_14d).toFixed(2) : null };
    } catch (e) { logger.warn(`[OVERVIEW] demeter kpis: ${e.message}`); }
    // Athena: "Performance" = ROAS de cuenta (lo que optimiza)
    byAgent.athena.kpis = { performance: global.roas_today };
    try {
      const TestRun = require('../../db/models/TestRun');
      const [vid, vgrad] = await Promise.all([
        TestRun.countDocuments({ media_type: 'video', phase: { $in: ['learning', 'evaluating'] } }),
        TestRun.countDocuments({ media_type: 'video', phase: 'graduated', graduated_at: { $gte: w7 } })
      ]);
      byAgent.dionisio.kpis = { tests_video: vid, graduados_7d: vgrad };
    } catch (e) { logger.warn(`[OVERVIEW] dionisio kpis: ${e.message}`); }
    try {
      byAgent.hermes.kpis = { publicaciones_7d: await ActionLog.countDocuments({ agent_type: 'hermes', created_at: { $gte: w7 } }) };
    } catch (e) { logger.warn(`[OVERVIEW] hermes kpis: ${e.message}`); }

    // ── Actividad reciente (timeline + feed) ──
    const activity = recentActions.slice(0, 15).map(a => ({
      agent: AGENT_TYPE_MAP[a.agent_type] || 'zeus',
      action: a.action, entity_name: a.entity_name,
      at: a.created_at, success: a.success
    }));

    res.json({
      global,
      agents: AGENT_IDS.map(id => byAgent[id]),
      activity,
      generated_at: new Date()
    });
  } catch (err) {
    logger.error(`[OVERVIEW-API] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /api/overview/history — historial del sistema (plataforma de datos) ═══
// agent_type crudo → id de orbe de la galaxia (incluye valores legacy del enum)
const HIST_AGENT_MAP = {
  scaling: 'athena', performance: 'athena', pacing: 'athena', account_agent: 'athena', athena: 'athena',
  creative: 'apollo', creative_agent: 'apollo', apollo: 'apollo',
  testing_agent: 'prometheus', prometheus: 'prometheus',
  ares_agent: 'ares', ares_portfolio: 'ares', ares_brain: 'ares', ares: 'ares',
  zeus_agent: 'zeus', brain: 'zeus', unified_agent: 'zeus', ai_manager: 'zeus', warehouse_throttle: 'zeus',
  hermes: 'hermes', demeter: 'demeter', dionysus: 'dionisio', dionisio: 'dionisio',
  manual: 'manual', manual_script: 'manual'
};

router.get('/history', async (req, res) => {
  try {
    const agent = req.query.agent && req.query.agent !== 'all' ? req.query.agent : null;
    const days = Math.min(parseInt(req.query.days, 10) || 30, 120);
    const limit = Math.min(parseInt(req.query.limit, 10) || 150, 400);
    const since = new Date(Date.now() - days * 86400000);

    const q = { executed_at: { $gte: since } };
    if (agent) {
      const raws = Object.keys(HIST_AGENT_MAP).filter(k => HIST_AGENT_MAP[k] === agent);
      q.agent_type = { $in: raws };
    }

    const [docs, all] = await Promise.all([
      ActionLog.find(q).sort({ executed_at: -1 }).limit(limit).lean(),
      ActionLog.find({ executed_at: { $gte: since } }).select('agent_type follow_up_verdict').lean()
    ]);

    const entries = docs.map(d => ({
      id: String(d._id),
      agent: HIST_AGENT_MAP[d.agent_type] || 'manual',
      agent_type: d.agent_type || 'manual',
      action: d.action,
      entity_name: d.entity_name || '', entity_type: d.entity_type || '', campaign_name: d.campaign_name || '',
      change_percent: d.change_percent || 0,
      before: d.before_value, after: d.after_value,
      reasoning: d.reasoning || '',
      success: d.success,
      verdict: d.follow_up_verdict || 'pending',
      confidence: d.confidence || null,
      roas: d.metrics_at_execution?.roas ?? null,
      at: d.executed_at
    }));

    // Stats sobre toda la ventana (no solo la página)
    const byAgent = {}; const verdict = { positive: 0, negative: 0, neutral: 0, pending: 0 };
    for (const d of all) {
      const a = HIST_AGENT_MAP[d.agent_type] || 'manual';
      byAgent[a] = (byAgent[a] || 0) + 1;
      const v = d.follow_up_verdict || 'pending';
      verdict[v] = (verdict[v] || 0) + 1;
    }
    const decided = verdict.positive + verdict.negative;
    const win_rate = decided > 0 ? Math.round((verdict.positive / decided) * 100) : null;

    res.json({ entries, total: all.length, shown: entries.length, by_agent: byAgent, verdict, win_rate, days });
  } catch (err) {
    logger.error(`[OVERVIEW-API] /history: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
