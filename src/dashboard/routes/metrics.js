const express = require('express');
const router = express.Router();
const { getLatestSnapshots, getSnapshotHistory, getAccountOverview, getAdsForAdSet, getOverviewHistory } = require('../../db/queries');
const ActionLog = require('../../db/models/ActionLog');

// GET /api/metrics/overview/history — Historial diario para gráficos de tendencia
router.get('/overview/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = await getOverviewHistory(days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/overview — Resumen general de la cuenta
router.get('/overview', async (req, res) => {
  try {
    const overview = await getAccountOverview();
    // Mapear a nombres que el frontend espera
    res.json({
      spend_today: overview.today_spend,
      daily_budget: overview.total_daily_budget,
      roas_7d: overview.roas_7d,
      roas_3d: overview.roas_3d,
      roas_14d: overview.roas_14d,
      roas_30d: overview.roas_30d,
      spend_14d: overview.spend_14d,
      spend_30d: overview.spend_30d,
      active_adsets: overview.active_adsets,
      paused_adsets: overview.paused_adsets,
      total_adsets: overview.total_adsets,
      today_revenue: overview.today_revenue,
      today_roas: overview.today_roas
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/campaigns — Todas las campañas con últimas métricas
router.get('/campaigns', async (req, res) => {
  try {
    const snapshots = await getLatestSnapshots('campaign');
    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/adsets/actions — Acciones recientes de agentes por ad set (con cooldown)
// NOTA: debe estar ANTES de /adsets para que Express lo matchee correctamente
router.get('/adsets/actions', async (req, res) => {
  try {
    const COOLDOWN_DAYS = 3;
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const actions = await ActionLog.find({
      entity_type: 'adset',
      success: true,
      executed_at: { $gte: since }
    })
      .sort({ executed_at: -1 })
      .lean();

    // Agrupar por entity_id con info de cooldown
    const byAdSet = {};
    const now = new Date();

    for (const action of actions) {
      if (!byAdSet[action.entity_id]) {
        // Calcular cooldown basado en la acción más reciente (primera por el sort)
        const cooldownUntil = new Date(action.executed_at);
        cooldownUntil.setDate(cooldownUntil.getDate() + COOLDOWN_DAYS);
        const onCooldown = cooldownUntil > now;
        const hoursLeft = onCooldown ? Math.round((cooldownUntil - now) / (1000 * 60 * 60)) : 0;

        byAdSet[action.entity_id] = {
          actions: [],
          cooldown: onCooldown ? {
            active: true,
            until: cooldownUntil,
            hours_left: hoursLeft,
            last_agent: _extractAgent(action.reasoning),
            last_action: action.action
          } : { active: false }
        };
      }
      byAdSet[action.entity_id].actions.push({
        action: action.action,
        before_value: action.before_value,
        after_value: action.after_value,
        change_percent: action.change_percent,
        reasoning: action.reasoning,
        confidence: action.confidence,
        executed_at: action.executed_at,
        agent: _extractAgent(action.reasoning)
      });
    }

    res.json(byAdSet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/adsets — Todos los ad sets (con filtro opcional por campaña)
router.get('/adsets', async (req, res) => {
  try {
    let snapshots = await getLatestSnapshots('adset');

    // Filtro por campaña si se especifica
    if (req.query.campaign_id) {
      snapshots = snapshots.filter(s => s.campaign_id === req.query.campaign_id);
    }

    // Ordenar por ROAS 7d descendente por defecto
    const sortBy = req.query.sort || 'roas_7d';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    snapshots.sort((a, b) => {
      const aVal = _getNestedValue(a, sortBy);
      const bVal = _getNestedValue(b, sortBy);
      return (bVal - aVal) * sortOrder;
    });

    res.json(snapshots.map(_mapSnapshot));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/ads — Todos los ads (con filtro opcional por ad set)
router.get('/ads', async (req, res) => {
  try {
    let snapshots = await getLatestSnapshots('ad');

    if (req.query.adset_id) {
      snapshots = snapshots.filter(s => s.parent_id === req.query.adset_id);
    }

    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/ads/:adSetId — Ads/creativos de un ad set específico
router.get('/ads/:adSetId', async (req, res) => {
  try {
    const ads = await getAdsForAdSet(req.params.adSetId);
    res.json(ads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/history/:entityId — Historial de una entidad (para gráficos)
router.get('/history/:entityId', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = await getSnapshotHistory(req.params.entityId, days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/top-performers — Top y bottom ad sets
// Dashboard.jsx espera un array plano con { name, metrics: { roas_7d, spend_7d, cpa, trend } }
router.get('/top-performers', async (req, res) => {
  try {
    const snapshots = await getLatestSnapshots('adset');
    const active = snapshots.filter(s => s.status === 'ACTIVE');

    // Filtrar por gasto mínimo y ordenar por ROAS 7d
    const byRoas = [...active]
      .filter(s => (s.metrics?.last_7d?.spend || 0) > 20)
      .sort((a, b) => (b.metrics?.last_7d?.roas || 0) - (a.metrics?.last_7d?.roas || 0));

    // Mapear a formato que Dashboard.jsx espera
    const mapped = byRoas.map(s => ({
      name: s.entity_name,
      metrics: {
        roas_7d: s.metrics?.last_7d?.roas || 0,
        spend_7d: s.metrics?.last_7d?.spend || 0,
        cpa: s.metrics?.last_7d?.cpa || 0,
        trend: s.analysis?.roas_trend || 'stable'
      }
    }));

    const limit = parseInt(req.query.limit) || 10;
    res.json(mapped.slice(0, limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Extrae el tipo de agente del reasoning (formato: [BUDGET] ...)
 */
function _extractAgent(reasoning) {
  if (!reasoning) return 'unknown';
  const match = reasoning.match(/^\[(\w+)\]/);
  const tag = match ? match[1].toLowerCase() : 'unknown';
  if (['budget', 'performance', 'creative', 'pacing', 'unified_policy', 'unified'].includes(tag)) {
    return 'unified';
  }
  return tag;
}

/**
 * Mapea campos de snapshot (entity_id/entity_name) a id/name para el frontend
 */
function _mapSnapshot(s) {
  return {
    ...s,
    id: s.entity_id,
    name: s.entity_name
  };
}

function _getNestedValue(obj, path) {
  if (path === 'roas_7d') return obj.metrics?.last_7d?.roas || 0;
  if (path === 'roas_3d') return obj.metrics?.last_3d?.roas || 0;
  if (path === 'spend_7d') return obj.metrics?.last_7d?.spend || 0;
  if (path === 'cpa_7d') return obj.metrics?.last_7d?.cpa || 0;
  if (path === 'daily_budget') return obj.daily_budget || 0;
  return 0;
}

module.exports = router;
