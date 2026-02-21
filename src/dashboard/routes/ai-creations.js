const express = require('express');
const router = express.Router();
const AICreation = require('../../db/models/AICreation');
const logger = require('../../utils/logger');

/**
 * GET /api/ai-creations
 * Listar todas las creaciones de la IA con filtros opcionales.
 */
router.get('/', async (req, res) => {
  try {
    const { type, verdict, limit = 50 } = req.query;
    const filter = {};
    if (type) filter.creation_type = type;
    if (verdict) filter.verdict = verdict;

    const creations = await AICreation.find(filter)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .lean();

    // Calcular stats generales
    const all = await AICreation.find({}).lean();
    const total = all.length;
    const positive = all.filter(c => c.verdict === 'positive').length;
    const negative = all.filter(c => c.verdict === 'negative').length;
    const pending = all.filter(c => c.verdict === 'pending').length;
    const successRate = total > 0 && (total - pending) > 0
      ? Math.round((positive / (total - pending)) * 100)
      : 0;

    res.json({
      creations,
      stats: {
        total,
        positive,
        negative,
        neutral: all.filter(c => c.verdict === 'neutral').length,
        pending,
        success_rate: successRate
      }
    });
  } catch (error) {
    logger.error('Error listando AI creations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-creations/stats
 * Estadisticas rapidas para badges/dashboard.
 */
router.get('/stats', async (req, res) => {
  try {
    const [total, positive, negative, pending] = await Promise.all([
      AICreation.countDocuments(),
      AICreation.countDocuments({ verdict: 'positive' }),
      AICreation.countDocuments({ verdict: 'negative' }),
      AICreation.countDocuments({ verdict: 'pending' })
    ]);

    const measured = total - pending;
    res.json({
      total,
      positive,
      negative,
      neutral: measured - positive - negative,
      pending,
      success_rate: measured > 0 ? Math.round((positive / measured) * 100) : 0
    });
  } catch (error) {
    logger.error('Error obteniendo stats de AI creations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai-creations/:id
 * Detalle de una creacion especifica.
 */
router.get('/:id', async (req, res) => {
  try {
    const creation = await AICreation.findById(req.params.id).lean();
    if (!creation) return res.status(404).json({ error: 'Creacion no encontrada' });
    res.json(creation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
