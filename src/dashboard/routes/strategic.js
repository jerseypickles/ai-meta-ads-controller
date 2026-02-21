const express = require('express');
const router = express.Router();
const StrategicInsight = require('../../db/models/StrategicInsight');
const StrategicDirective = require('../../db/models/StrategicDirective');
const StrategicAgent = require('../../ai/strategic/strategic-agent');
const logger = require('../../utils/logger');

/**
 * GET /api/strategic/latest
 * Ultimo ciclo de analisis estrategico con todos sus insights.
 */
router.get('/latest', async (req, res) => {
  try {
    // Obtener el cycle_id mas reciente
    const latest = await StrategicInsight.findOne()
      .sort({ created_at: -1 })
      .lean();

    if (!latest) {
      return res.json({ cycle_id: null, insights: [], account_summary: null, account_health: null });
    }

    // Obtener todos los insights de ese ciclo
    const insights = await StrategicInsight.find({ cycle_id: latest.cycle_id })
      .sort({ severity: 1, created_at: -1 })
      .lean();

    // Ordenar por severidad: critical > high > medium > low
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    insights.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

    res.json({
      cycle_id: latest.cycle_id,
      created_at: latest.created_at,
      account_summary: latest.account_summary,
      account_health: latest.account_health,
      insights,
      total: insights.length,
      actionable: insights.filter(i => i.actionable).length,
      pending: insights.filter(i => i.status === 'pending').length
    });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /latest: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/strategic/history
 * Historial de ciclos estrategicos con resumen.
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    // Agrupar por cycle_id para obtener resumen de cada ciclo
    const cycles = await StrategicInsight.aggregate([
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: '$cycle_id',
          created_at: { $first: '$created_at' },
          account_summary: { $first: '$account_summary' },
          account_health: { $first: '$account_health' },
          total_insights: { $sum: 1 },
          critical_count: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
          high_count: { $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] } },
          actionable_count: { $sum: { $cond: ['$actionable', 1, 0] } },
          pending_count: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          insight_types: { $addToSet: '$insight_type' }
        }
      },
      { $sort: { created_at: -1 } },
      { $limit: limit }
    ]);

    res.json({ cycles, total: cycles.length });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /history: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/strategic/insights/:type
 * Filtrar insights por tipo.
 */
router.get('/insights/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const insights = await StrategicInsight.find({ insight_type: type })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    res.json({ insights, total: insights.length, type });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /insights/${req.params.type}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/strategic/acknowledge/:id
 * Marcar un insight como visto/reconocido.
 */
router.post('/acknowledge/:id', async (req, res) => {
  try {
    const insight = await StrategicInsight.findByIdAndUpdate(
      req.params.id,
      {
        status: 'acknowledged',
        acknowledged_by: req.body.user || 'admin',
        acknowledged_at: new Date()
      },
      { new: true }
    );

    if (!insight) {
      return res.status(404).json({ error: 'Insight no encontrado' });
    }

    res.json({ success: true, insight });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /acknowledge: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/strategic/implement/:id
 * Marcar un insight como implementado.
 */
router.post('/implement/:id', async (req, res) => {
  try {
    const insight = await StrategicInsight.findByIdAndUpdate(
      req.params.id,
      {
        status: 'implemented',
        acknowledged_by: req.body.user || 'admin',
        acknowledged_at: new Date()
      },
      { new: true }
    );

    if (!insight) {
      return res.status(404).json({ error: 'Insight no encontrado' });
    }

    res.json({ success: true, insight });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /implement: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/strategic/dismiss/:id
 * Descartar un insight.
 */
router.post('/dismiss/:id', async (req, res) => {
  try {
    const insight = await StrategicInsight.findByIdAndUpdate(
      req.params.id,
      {
        status: 'dismissed',
        acknowledged_by: req.body.user || 'admin',
        acknowledged_at: new Date()
      },
      { new: true }
    );

    if (!insight) {
      return res.status(404).json({ error: 'Insight no encontrado' });
    }

    res.json({ success: true, insight });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /dismiss: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/strategic/directives
 * Directivas estrategicas activas que guian al agente algoritmico.
 */
router.get('/directives', async (req, res) => {
  try {
    const directives = await StrategicDirective.find({
      status: { $in: ['active', 'applied'] },
      expires_at: { $gt: new Date() }
    })
      .sort({ created_at: -1 })
      .lean();

    res.json({ directives, total: directives.length });
  } catch (error) {
    logger.error(`[API_STRATEGIC] Error en /directives: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Estado del ciclo en memoria (solo un ciclo a la vez)
let runningCycle = { active: false, startedAt: null, result: null };

/**
 * POST /api/strategic/run-cycle
 * Ejecutar un ciclo de analisis estrategico manualmente.
 * Lanza el ciclo en background y retorna inmediatamente.
 */
router.post('/run-cycle', async (req, res) => {
  if (runningCycle.active) {
    return res.json({ success: false, error: 'Ya hay un ciclo en curso', status: 'running' });
  }

  try {
    logger.info('[API_STRATEGIC] Ejecutando ciclo estrategico manual...');
    runningCycle = { active: true, startedAt: new Date(), result: null };

    // Lanzar en background
    const agent = new StrategicAgent();
    agent.runCycle().then(result => {
      runningCycle = { active: false, startedAt: null, result };
      logger.info(`[API_STRATEGIC] Ciclo completado: ${result.success ? 'OK' : 'ERROR'}`);
    }).catch(error => {
      runningCycle = { active: false, startedAt: null, result: { success: false, error: error.message } };
      logger.error(`[API_STRATEGIC] Error en ciclo: ${error.message}`);
    });

    res.json({ success: true, status: 'started', message: 'Ciclo iniciado. Consultando estado...' });
  } catch (error) {
    runningCycle = { active: false, startedAt: null, result: null };
    logger.error(`[API_STRATEGIC] Error en /run-cycle: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/strategic/run-status
 * Consultar el estado del ciclo en curso.
 */
router.get('/run-status', async (req, res) => {
  if (runningCycle.active) {
    const elapsed = Math.round((Date.now() - runningCycle.startedAt.getTime()) / 1000);
    return res.json({ status: 'running', elapsed_seconds: elapsed });
  }

  if (runningCycle.result) {
    const result = runningCycle.result;
    runningCycle.result = null; // Limpiar despues de leer
    return res.json({ status: 'completed', result });
  }

  res.json({ status: 'idle' });
});

module.exports = router;
