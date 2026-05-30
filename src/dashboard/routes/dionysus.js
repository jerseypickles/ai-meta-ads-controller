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
const TestRun = require('../../db/models/TestRun');
const logger = require('../../utils/logger');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// GET /stats — rendimiento de los videos testeados + DNA por motion variant.
// Es lo que Dionisio "aprende": qué tipo de movimiento rinde mejor.
router.get('/stats', async (req, res) => {
  try {
    // Videos que pasaron a testing/graduated/killed (ya tienen señal o veredicto).
    const videos = await CreativeProposal.find({
      media_type: 'video',
      status: { $in: ['testing', 'graduated', 'killed', 'expired'] }
    }).select('headline product_name motion_variant camera scene status video_url').lean();

    // Métricas desde el TestRun de cada video (proposal_id → TestRun).
    const ids = videos.map(v => v._id);
    const runs = await TestRun.find({ proposal_id: { $in: ids } })
      .select('proposal_id phase metrics metrics_at_graduation').lean();
    const runByProp = {};
    for (const t of runs) runByProp[String(t.proposal_id)] = t;

    const tested = videos.map(v => {
      const t = runByProp[String(v._id)] || {};
      const m = t.metrics || {};
      return {
        headline: v.headline, product_name: v.product_name,
        motion_variant: v.motion_variant, camera: v.camera, scene: v.scene,
        status: v.status, video_url: v.video_url,
        ctr: r2(m.ctr), roas: r2(m.roas), spend: r2(m.spend), purchases: m.purchases || 0,
        impressions: m.impressions || 0
      };
    });

    // DNA por DIMENSIÓN (motion / camera / scene) — qué valor rinde mejor.
    const aggregateBy = (field) => {
      const by = {};
      for (const v of tested) {
        const k = v[field] || '—';
        by[k] = by[k] || { variant: k, n: 0, ctr_sum: 0, roas_sum: 0, graduated: 0, killed: 0 };
        const b = by[k];
        b.n++; b.ctr_sum += v.ctr; b.roas_sum += v.roas;
        if (v.status === 'graduated') b.graduated++;
        if (v.status === 'killed') b.killed++;
      }
      return Object.values(by).map(b => ({
        variant: b.variant, tested: b.n,
        avg_ctr: r2(b.ctr_sum / b.n), avg_roas: r2(b.roas_sum / b.n),
        graduated: b.graduated, killed: b.killed,
        win_rate: b.n ? Math.round((b.graduated / b.n) * 100) : 0
      })).sort((a, b) => b.avg_roas - a.avg_roas);
    };
    const dnaByDimension = {
      motion: aggregateBy('motion_variant'),
      camera: aggregateBy('camera'),
      scene: aggregateBy('scene')
    };
    const dna = dnaByDimension.motion; // back-compat

    // Contadores de cola.
    const pending = await CreativeProposal.countDocuments({ media_type: 'video', status: 'pending_video_review' });
    const totalVideos = await CreativeProposal.countDocuments({ media_type: 'video', status: { $nin: ['failed', 'rejected'] } });

    // Pool de imágenes-fuente para video (vía dedicada con tag video_source).
    let sourcePool = 0, sourcePoolTarget = 30;
    try {
      const { countAvailableSources, POOL_TARGET } = require('../../ai/creative/video/video-source-generator');
      sourcePool = await countAvailableSources();
      sourcePoolTarget = POOL_TARGET;
    } catch (_) { /* noop */ }

    res.json({ pending, total_videos: totalVideos, tested_count: tested.length, source_pool: sourcePool, source_pool_target: sourcePoolTarget, dna, dna_by_dimension: dnaByDimension, tested });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending — videos en cola de aprobación
router.get('/pending', async (req, res) => {
  try {
    const [pending, generating] = await Promise.all([
      CreativeProposal.find({ media_type: 'video', status: 'pending_video_review' })
        .sort({ created_at: -1 })
        .select('headline primary_text product_name video_url motion_variant video_judge_score source_proposal_id created_at')
        .lean(),
      CreativeProposal.find({ media_type: 'video', status: 'generating_video' })
        .sort({ created_at: -1 })
        .select('headline product_name motion_variant video_judge_score created_at')
        .lean()
    ]);
    res.json({ count: pending.length, pending, generating });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /generate-sources — gatillar la generación del pool de imágenes-fuente (async)
router.post('/generate-sources', async (req, res) => {
  try {
    const { generateVideoSources } = require('../../ai/creative/video/video-source-generator');
    generateVideoSources().then(r => logger.info(`[VIDEO-SOURCE] run manual: ${JSON.stringify(r).slice(0, 200)}`))
      .catch(e => logger.error(`[VIDEO-SOURCE] run manual falló: ${e.message}`));
    res.json({ started: true, message: 'Generando imágenes-fuente para video (pool)' });
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
