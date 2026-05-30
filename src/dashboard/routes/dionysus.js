// ═══════════════════════════════════════════════════════════════════════════════
// Rutas de DIONISIO 🎭 — cola de video pendiente + aprobación manual
// GET  /pending        → videos esperando review (preview + meta)
// POST /run            → gatilla runDionysus (genera nuevos videos)
// POST /:id/approve     → aprueba → status 'ready' (Prometheus lo testea)
// POST /:id/reject      → rechaza
// Montado bajo /api/dionysus (auth via middleware global).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const CreativeProposal = require('../../db/models/CreativeProposal');
const logger = require('../../utils/logger');

// GET /pending — videos en cola de aprobación
router.get('/pending', async (req, res) => {
  try {
    const pending = await CreativeProposal.find({ media_type: 'video', status: 'pending_video_review' })
      .sort({ created_at: -1 })
      .select('headline primary_text product_name video_url motion_variant source_proposal_id created_at')
      .lean();
    res.json({ count: pending.length, pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /run — gatillar un ciclo de Dionisio (async)
router.post('/run', async (req, res) => {
  try {
    const { runDionysus } = require('../../ai/agent/dionysus-agent');
    // async: respondemos ya, corre en background
    runDionysus().then(r => logger.info(`[DIONISIO] run manual: ${JSON.stringify(r).slice(0, 200)}`))
      .catch(e => logger.error(`[DIONISIO] run manual falló: ${e.message}`));
    res.json({ started: true, message: 'Dionisio generando videos (revisá la cola en unos minutos)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/approve — aprobar → 'ready' (elegible para Prometheus)
router.post('/:id/approve', async (req, res) => {
  try {
    const p = await CreativeProposal.findById(req.params.id);
    if (!p || p.media_type !== 'video') return res.status(404).json({ error: 'video proposal no encontrado' });
    if (p.status !== 'pending_video_review') return res.status(400).json({ error: `estado inválido: ${p.status}` });
    p.status = 'ready';
    p.decided_at = new Date();
    await p.save();
    logger.info(`[DIONISIO] video aprobado: "${p.headline}" → ready (Prometheus lo testeará)`);
    res.json({ success: true, status: 'ready' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reject — rechazar
router.post('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const p = await CreativeProposal.findById(req.params.id);
    if (!p || p.media_type !== 'video') return res.status(404).json({ error: 'video proposal no encontrado' });
    p.status = 'rejected';
    p.decided_at = new Date();
    p.rejection_reason = reason || 'rechazado manualmente';
    await p.save();
    logger.info(`[DIONISIO] video rechazado: "${p.headline}"`);
    res.json({ success: true, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
