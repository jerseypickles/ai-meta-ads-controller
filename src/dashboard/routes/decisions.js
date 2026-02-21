const express = require('express');
const router = express.Router();
const Decision = require('../../db/models/Decision');
const { getDecisionsPaginated, getDecisionStats } = require('../../db/queries');
const ActionExecutor = require('../../meta/action-executor');

function refreshDecisionStats(decisionDoc) {
  const actionable = (decisionDoc.decisions || []).filter(d => d.action !== 'no_action');
  decisionDoc.total_actions = actionable.length;
  decisionDoc.approved_actions = actionable.filter(d =>
    ['approved', 'executed'].includes(d.recommendation_status)
  ).length;
  decisionDoc.rejected_actions = actionable.filter(d => d.recommendation_status === 'rejected').length;
  decisionDoc.executed_actions = actionable.filter(d => d.recommendation_status === 'executed').length;
}

// GET /api/decisions — Historial de decisiones (paginado)
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await getDecisionsPaginated(page, limit);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/decisions/stats — Estadísticas de decisiones
// Dashboard.jsx espera: { cycles_today, actions_today, actions_week, success_rate }
router.get('/stats', async (req, res) => {
  try {
    const stats = await getDecisionStats();
    const today = stats.today || {};
    const week = stats.week || {};

    const totalWeek = week.total_actions || 0;
    const executedWeek = week.executed || 0;

    res.json({
      cycles_today: today.total_cycles || 0,
      actions_today: today.executed || 0,
      actions_week: executedWeek,
      success_rate: totalWeek > 0 ? (executedWeek / totalWeek) * 100 : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/decisions/:id/items/:itemId/approve — Aprobar recomendación
router.post('/:id/items/:itemId/approve', async (req, res) => {
  try {
    const decision = await Decision.findById(req.params.id);
    if (!decision) return res.status(404).json({ error: 'Decisión no encontrada' });

    const item = decision.decisions.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (item.action === 'no_action') return res.status(400).json({ error: 'no_action no requiere aprobación' });
    if (item.recommendation_status === 'executed') {
      return res.status(400).json({ error: 'Recomendación ya ejecutada' });
    }

    item.recommendation_status = 'approved';
    item.reviewed_by = req.user?.user || 'admin';
    item.reviewed_at = new Date();

    refreshDecisionStats(decision);
    await decision.save();
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/decisions/:id/items/:itemId/reject — Rechazar recomendación
router.post('/:id/items/:itemId/reject', async (req, res) => {
  try {
    const decision = await Decision.findById(req.params.id);
    if (!decision) return res.status(404).json({ error: 'Decisión no encontrada' });

    const item = decision.decisions.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (item.action === 'no_action') return res.status(400).json({ error: 'no_action no requiere rechazo' });
    if (item.recommendation_status === 'executed') {
      return res.status(400).json({ error: 'No se puede rechazar una recomendación ya ejecutada' });
    }

    item.recommendation_status = 'rejected';
    item.reviewed_by = req.user?.user || 'admin';
    item.reviewed_at = new Date();

    refreshDecisionStats(decision);
    await decision.save();
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/decisions/:id/items/:itemId/execute — Ejecutar recomendación aprobada
router.post('/:id/items/:itemId/execute', async (req, res) => {
  try {
    const decision = await Decision.findById(req.params.id);
    if (!decision) return res.status(404).json({ error: 'Decisión no encontrada' });

    const item = decision.decisions.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (item.action === 'no_action') return res.status(400).json({ error: 'no_action no es ejecutable' });

    const status = item.recommendation_status || 'pending';
    if (status === 'executed') {
      return res.status(400).json({ error: 'Recomendación ya ejecutada' });
    }
    if (status !== 'approved') {
      return res.status(400).json({ error: 'Debes aprobar la recomendación antes de ejecutarla' });
    }

    const executor = new ActionExecutor();
    const result = await executor.executeSingle(decision, item, req.user?.user || 'admin');
    if (!result.success) {
      return res.status(400).json({ error: result.reason || 'No se pudo ejecutar la recomendación' });
    }

    res.json({ success: true, item, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/decisions/:id — Decisión individual con contexto completo
router.get('/:id', async (req, res) => {
  try {
    const decision = await Decision.findById(req.params.id).lean();
    if (!decision) {
      return res.status(404).json({ error: 'Decisión no encontrada' });
    }
    res.json(decision);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
