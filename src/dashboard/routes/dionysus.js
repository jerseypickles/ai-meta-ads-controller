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
    }).select('headline product_name motion_variant camera scene hook_variant status video_url').lean();

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
        motion_variant: v.motion_variant, camera: v.camera, scene: v.scene, hook_variant: v.hook_variant,
        status: v.status, video_url: v.video_url,
        ctr: r2(m.ctr), roas: r2(m.roas), spend: r2(m.spend), purchases: m.purchases || 0,
        impressions: m.impressions || 0,
        hold_rate: m.hold_rate || 0, thumbstop_rate: m.thumbstop_rate || 0
      };
    });

    // DNA por DIMENSIÓN (motion / camera / scene) — qué valor rinde mejor.
    const aggregateBy = (field) => {
      const by = {};
      for (const v of tested) {
        const k = v[field] || '—';
        by[k] = by[k] || { variant: k, n: 0, ctr_sum: 0, roas_sum: 0, hold_sum: 0, graduated: 0, killed: 0 };
        const b = by[k];
        b.n++; b.ctr_sum += v.ctr; b.roas_sum += v.roas; b.hold_sum += (v.hold_rate || 0);
        if (v.status === 'graduated') b.graduated++;
        if (v.status === 'killed') b.killed++;
      }
      return Object.values(by).map(b => ({
        variant: b.variant, tested: b.n,
        avg_ctr: r2(b.ctr_sum / b.n), avg_roas: r2(b.roas_sum / b.n),
        avg_hold: Math.round((b.hold_sum / b.n) * 100), // % visto completo
        graduated: b.graduated, killed: b.killed,
        win_rate: b.n ? Math.round((b.graduated / b.n) * 100) : 0
      })).sort((a, b) => b.avg_roas - a.avg_roas);
    };
    const dnaByDimension = {
      motion: aggregateBy('motion_variant'),
      camera: aggregateBy('camera'),
      scene: aggregateBy('scene'),
      hook: aggregateBy('hook_variant')
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

    // Learnings del reconciliador (ranking de motions por outcome real + calibración del juez)
    let learnings = null, weekly = [];
    try {
      const SystemConfig = require('../../db/models/SystemConfig');
      const VL = require('../../ai/creative/video/video-learning');
      learnings = await SystemConfig.get(VL.LEARNINGS_KEY, null);
      weekly = await VL.weeklyTrend(12);
    } catch (_) { /* noop */ }

    res.json({ pending, total_videos: totalVideos, tested_count: tested.length, source_pool: sourcePool, source_pool_target: sourcePoolTarget, dna, dna_by_dimension: dnaByDimension, tested, learnings, weekly });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending — videos en cola de aprobación
router.get('/pending', async (req, res) => {
  try {
    // Auto-sanar zombies (generating_video pegados) al abrir el panel.
    try {
      const { reconcileStuckVideos } = require('../../ai/agent/dionysus-agent');
      await reconcileStuckVideos();
    } catch (_) { /* no bloquear el panel si falla */ }
    const [pending, generating] = await Promise.all([
      CreativeProposal.find({ media_type: 'video', status: 'pending_video_review' })
        .sort({ created_at: -1 })
        .select('headline primary_text product_name video_url motion_variant video_judge_score video_judge_breakdown source_proposal_id created_at')
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

// GET /sources — imágenes-fuente DISPONIBLES (no consumidas) para mostrar en Apollo.
// "Consumida" = ya tiene un video hijo vivo (Dionisio la animó) → desaparece del tab
// para no seguir mostrándola. Mismo criterio que el dedup de _getCandidates.
router.get('/sources', async (req, res) => {
  try {
    const sources = await CreativeProposal.find({
      media_type: 'image', tags: 'video_source', status: { $nin: ['failed', 'rejected'] }
    }).sort({ created_at: -1 }).select('headline product_name motion_variant scene created_at').lean();
    const ids = sources.map(s => s._id);
    const animated = await CreativeProposal.find({
      media_type: 'video', source_proposal_id: { $in: ids }, status: { $ne: 'failed' }
    }).select('source_proposal_id').lean();
    const consumed = new Set(animated.map(v => String(v.source_proposal_id)));
    const available = sources.filter(s => !consumed.has(String(s._id)));
    res.json({ available, available_count: available.length, consumed_count: sources.length - available.length });
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

// POST /backfill-video-judge — juzga con Gemini los videos EXISTENTES (que tienen
// video_url) para tener data ya (sin esperar generaciones nuevas). Async + recalcula
// el reconciliador al terminar → llena la comparación Claude vs Gemini.
router.post('/backfill-video-judge', async (req, res) => {
  res.json({ started: true, message: 'Juzgando videos existentes con Gemini en background — refrescá Calibración en unos minutos' });
  (async () => {
    try {
      const { judgeVideoResult } = require('../../ai/creative/video/video-result-judge');
      const limit = Math.min(parseInt(req.body?.limit, 10) || 40, 60);
      const force = req.body?.force === true; // re-juzgar los ya juzgados (ej. tras cambiar el prompt)
      // recientes primero — sus URLs ephemeral siguen vivas (las viejas ya expiraron)
      const q = { media_type: 'video', video_url: { $regex: /^http/ } };
      if (!force) q.video_result_verdict = null;
      const vids = await CreativeProposal.find(q).sort({ created_at: -1 }).limit(limit).lean();
      let done = 0, reject = 0, fail = 0;
      for (const v of vids) {
        const verdict = await judgeVideoResult(v.video_url, v.product_name, v.motion_variant);
        if (!verdict) { fail++; continue; }
        await CreativeProposal.updateOne({ _id: v._id }, { $set: { video_result_verdict: verdict } });
        done++; if (verdict.verdict === 'reject') reject++;
        logger.info(`[BACKFILL-VIDEO-JUDGE] ${done}/${vids.length} ${verdict.verdict} ${verdict.overall} — "${(v.headline || '').slice(0, 30)}"`);
      }
      try { await require('../../ai/creative/video/video-learning').reconcile(); } catch (_) {}
      logger.info(`[BACKFILL-VIDEO-JUDGE] DONE: ${done} juzgados · ${reject} rotos · ${fail} fallaron (URL expirada?) de ${vids.length}`);
    } catch (e) { logger.error(`[BACKFILL-VIDEO-JUDGE] ${e.message}`); }
  })();
});

// POST /retry-failed — re-genera EXACTAMENTE los videos fallidos (no del pool). Async.
router.post('/retry-failed', async (req, res) => {
  res.json({ started: true, message: 'Recuperando los videos fallidos desde su fuente — revisá la cola en unos minutos' });
  (async () => {
    try {
      const { retryFailedVideos } = require('../../ai/agent/dionysus-agent');
      const r = await retryFailedVideos({ hoursBack: parseInt(req.body?.hoursBack, 10) || 6, limit: parseInt(req.body?.limit, 10) || 20 });
      logger.info(`[DIONISIO-RETRY] resultado: ${JSON.stringify(r)}`);
    } catch (e) { logger.error(`[DIONISIO-RETRY] ${e.message}`); }
  })();
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
    logger.info(`[DIONISIO] video aprobado: "${p.headline}" → ready`);
    // Lanzar el test YA — no esperar al cron de Prometheus (async, fire-and-forget).
    try {
      const { launchTests } = require('../../ai/agent/testing-agent');
      launchTests()
        .then(n => logger.info(`[DIONISIO] approve → launchTests inmediato: ${n} lanzado(s)`))
        .catch(e => logger.error(`[DIONISIO] approve → launchTests falló: ${e.message}`));
    } catch (e) {
      logger.warn(`[DIONISIO] no se pudo disparar launchTests inmediato: ${e.message}`);
    }
    res.json({ success: true, status: 'ready', launching: true });
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
