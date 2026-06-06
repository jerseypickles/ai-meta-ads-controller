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

module.exports = router;
