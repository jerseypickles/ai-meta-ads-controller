const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');

// Job tracking para run async
const _testingJobs = {};

// ═══ GET /format-breakdown — VIDEO vs FOTO, atribución correcta por media_type ═══
// Responde "¿quién rinde mejor y quién se apaga más?" usando el media_type REAL del
// TestRun (no el emoji del nombre, que se pierde al graduar). Cuenta TODO el histórico,
// incluido lo apagado/borrado. ?since=YYYY-MM-DD (default 2026-05-28, cuenta nueva).
router.get('/format-breakdown', async (req, res) => {
  try {
    const since = new Date(req.query.since || '2026-05-28T00:00:00Z');
    const rows = await TestRun.find({ launched_at: { $gte: since } })
      .select('media_type phase metrics deflated_at').lean();
    const acc = (mt) => ({ media_type: mt, total: 0, graduated: 0, killed: 0, expired: 0, active: 0, deflated: 0, spend: 0, revenue: 0, purchases: 0 });
    const out = { image: acc('image'), video: acc('video') };
    for (const r of rows) {
      const t = out[r.media_type === 'video' ? 'video' : 'image'];
      const m = r.metrics || {};
      t.total++;
      t.spend += m.spend || 0;
      t.revenue += (m.roas || 0) * (m.spend || 0);
      t.purchases += m.purchases || 0;
      if (r.deflated_at) t.deflated++;
      if (r.phase === 'graduated') t.graduated++;
      else if (r.phase === 'killed') t.killed++;
      else if (r.phase === 'expired') t.expired++;
      else if (r.phase === 'learning' || r.phase === 'evaluating') t.active++;
    }
    for (const k of ['image', 'video']) {
      const t = out[k];
      const finished = t.killed + t.expired + t.graduated;
      t.roas = t.spend > 0 ? +(t.revenue / t.spend).toFixed(2) : 0;
      t.cpa = t.purchases > 0 ? +(t.spend / t.purchases).toFixed(0) : 0;
      t.graduation_rate = finished > 0 ? Math.round((t.graduated / finished) * 100) : 0;
      // "tasa de apagado": killed + deflated sobre todo lo que tuvo chance (no active)
      const settled = t.total - t.active;
      t.shutdown_rate = settled > 0 ? Math.round(((t.killed + t.deflated) / settled) * 100) : 0;
      t.spend = Math.round(t.spend); t.revenue = Math.round(t.revenue);
    }
    res.json({ since: since.toISOString().slice(0, 10), image: out.image, video: out.video });
  } catch (err) {
    logger.error(`[TESTING-AGENT] format-breakdown error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /run — Trigger manual ═══
router.post('/run', async (req, res) => {
  try {
    const jobId = `testing_job_${Date.now()}`;
    _testingJobs[jobId] = { status: 'running', started_at: new Date() };
    res.json({ async: true, job_id: jobId, message: 'Testing Agent iniciado' });

    const { runTestingAgent } = require('../../ai/agent/testing-agent');
    runTestingAgent().then(result => {
      _testingJobs[jobId] = { status: 'completed', ...result };
    }).catch(err => {
      _testingJobs[jobId] = { status: 'failed', error: err.message };
      logger.error(`[TESTING-AGENT] Job ${jobId} fallo: ${err.message}`);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /run-status/:jobId — Polling ═══
router.get('/run-status/:jobId', (req, res) => {
  const job = _testingJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status !== 'running') {
    setTimeout(() => delete _testingJobs[req.params.jobId], 5 * 60 * 1000);
  }
});

// ═══ GET /tests — Listar tests con filtro ═══
router.get('/tests', async (req, res) => {
  try {
    const { phase } = req.query;
    const filter = {};
    if (phase) filter.phase = phase;

    const tests = await TestRun.find(filter)
      .sort({ launched_at: -1 })
      .limit(100)
      .lean();

    // Enriquecer con datos de la propuesta
    const proposalIds = tests.map(t => t.proposal_id);
    const proposals = await CreativeProposal.find({ _id: { $in: proposalIds } })
      .select('headline primary_text scene_short product_name media_type video_url')
      .lean();
    const proposalMap = {};
    for (const p of proposals) proposalMap[p._id.toString()] = p;

    const enriched = tests.map(t => ({
      ...t,
      proposal: proposalMap[t.proposal_id?.toString()] || null
    }));

    // Stats
    const activeCount = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });
    const graduatedCount = await TestRun.countDocuments({ phase: 'graduated' });
    const killedCount = await TestRun.countDocuments({ phase: 'killed' });
    const expiredCount = await TestRun.countDocuments({ phase: 'expired' });
    const totalFinished = graduatedCount + killedCount + expiredCount;
    const graduationRate = totalFinished > 0 ? Math.round((graduatedCount / totalFinished) * 100) : 0;
    const dailyBudget = activeCount * 10; // $10 por test

    res.json({
      tests: enriched,
      stats: {
        active: activeCount,
        graduated: graduatedCount,
        killed: killedCount,
        expired: expiredCount,
        graduation_rate: graduationRate,
        daily_budget_exposure: dailyBudget
      }
    });
  } catch (err) {
    logger.error(`[TESTING-AGENT] Error listando tests: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /tests/:id — Detalle de un test ═══
router.get('/tests/:id', async (req, res) => {
  try {
    const test = await TestRun.findById(req.params.id).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const proposal = await CreativeProposal.findById(test.proposal_id).lean();

    res.json({ test, proposal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /tests/:id/kill — Kill manual ═══
router.post('/tests/:id/kill', async (req, res) => {
  try {
    const test = await TestRun.findById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    if (!['learning', 'evaluating'].includes(test.phase)) {
      return res.status(400).json({ error: `Test ya esta en fase ${test.phase}` });
    }

    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // Eliminar test ad set
    try { await meta.updateStatus(test.test_adset_id, 'DELETED'); } catch (_) {
      try { await meta.updateStatus(test.test_adset_id, 'PAUSED'); } catch (__) {}
    }

    // Actualizar
    test.phase = 'killed';
    test.killed_at = new Date();
    test.kill_reason = req.body.reason || 'Manual kill por usuario';
    test.assessments.push({
      day_number: Math.floor((Date.now() - new Date(test.launched_at).getTime()) / 86400000),
      phase: 'killed',
      assessment: `KILL MANUAL: ${test.kill_reason}`
    });
    await test.save();

    await CreativeProposal.findByIdAndUpdate(test.proposal_id, {
      $set: { status: 'killed', rejection_reason: test.kill_reason, decided_at: new Date() }
    });

    res.json({ success: true, message: 'Test killed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /stats — Stats agregadas ═══
router.get('/stats', async (req, res) => {
  try {
    const active = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });
    const graduated = await TestRun.countDocuments({ phase: 'graduated' });
    const killed = await TestRun.countDocuments({ phase: 'killed' });
    const expired = await TestRun.countDocuments({ phase: 'expired' });
    const totalFinished = graduated + killed + expired;
    const readyPool = await CreativeProposal.countDocuments({ status: 'ready' });

    res.json({
      active,
      graduated,
      killed,
      expired,
      graduation_rate: totalFinished > 0 ? Math.round((graduated / totalFinished) * 100) : 0,
      daily_budget_exposure: active * 10,
      ready_pool: readyPool
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /tests/:id/image — Servir imagen de la propuesta ═══
// Chain de fallback (2026-04-24):
//   1. Si proposal.image_base64 existe → servir directamente
//   2. Si proposal.image_url cacheada → proxy-fetch + servir
//   3. Si proposal.meta_creative_id → Meta API fetch image_url, cache, proxy
//   4. Else → 404
router.get('/tests/:id/image', async (req, res) => {
  try {
    const test = await TestRun.findById(req.params.id).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    // MULTI-AD (2026-06-13): ?proposal=<id> sirve la imagen de una VARIANTE del grupo
    // (debe ser uno de los ad_variants del test, si no se ignora y se usa el principal).
    let targetProposalId = test.proposal_id;
    const reqProp = req.query.proposal;
    if (reqProp && Array.isArray(test.ad_variants)) {
      const match = test.ad_variants.find(v => String(v.proposal_id) === String(reqProp));
      if (match) targetProposalId = match.proposal_id;
    }

    const proposal = await CreativeProposal.findById(targetProposalId)
      .select('image_base64 image_url meta_creative_id')
      .lean();
    if (!proposal) return res.status(404).json({ error: 'No proposal' });

    // ─── Path 1: imagen directo en DB (flujo nuevo) ──────────────────────
    if (proposal.image_base64) {
      const buffer = Buffer.from(proposal.image_base64, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Content-Length', buffer.length);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }

    // ─── Path 2: URL cacheada (de un fetch previo a Meta) ────────────────
    let imageUrl = proposal.image_url || null;

    // ─── Path 3: fetch a Meta API + cache ────────────────────────────────
    if (!imageUrl && proposal.meta_creative_id) {
      try {
        const { getMetaClient } = require('../../meta/client');
        const meta = getMetaClient();
        const creative = await meta.get(proposal.meta_creative_id, {
          fields: 'image_url,thumbnail_url,image_hash,object_story_spec'
        });
        // Para VIDEO el thumbnail vive en object_story_spec.video_data.image_url
        // (no en image_url/thumbnail_url) — por eso los videos salían "preview no disponible".
        imageUrl = creative?.image_url || creative?.thumbnail_url
          || creative?.object_story_spec?.video_data?.image_url || null;

        // Cache en la DB para próximas visitas (no re-fetch Meta)
        if (imageUrl) {
          await CreativeProposal.updateOne(
            { _id: targetProposalId },
            { $set: { image_url: imageUrl } }
          ).catch(() => {});
        }
      } catch (err) {
        logger.warn(`[testing-agent] Meta creative fetch falló para ${proposal.meta_creative_id}: ${err.message}`);
      }
    }

    if (!imageUrl) return res.status(404).json({ error: 'No image available' });

    // Proxy del URL remoto — pipe al response
    try {
      const axios = require('axios');
      const upstream = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000
      });
      res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.set('Content-Length', upstream.data.length);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(Buffer.from(upstream.data));
    } catch (err) {
      // URL de Meta puede haber expirado — limpiamos cache para retry en próxima visita
      if (proposal.image_url === imageUrl) {
        await CreativeProposal.updateOne(
          { _id: targetProposalId },
          { $set: { image_url: '' } }
        ).catch(() => {});
      }
      return res.status(502).json({ error: `upstream fetch failed: ${err.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
