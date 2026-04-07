const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const ZeusDirective = require('../../db/models/ZeusDirective');
const TestRun = require('../../db/models/TestRun');
const CreativeProposal = require('../../db/models/CreativeProposal');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');

const _zeusJobs = {};

// ═══ POST /run — Trigger manual ═══
router.post('/run', async (req, res) => {
  try {
    const jobId = `zeus_job_${Date.now()}`;
    _zeusJobs[jobId] = { status: 'running', started_at: new Date() };
    res.json({ async: true, job_id: jobId, message: 'Zeus Learner iniciado' });

    const { runZeusLearner } = require('../../ai/brain/zeus-learner');
    runZeusLearner().then(result => {
      _zeusJobs[jobId] = { status: 'completed', ...result };
    }).catch(err => {
      _zeusJobs[jobId] = { status: 'failed', error: err.message };
      logger.error(`[ZEUS] Job ${jobId} fallo: ${err.message}`);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /run-status/:jobId ═══
router.get('/run-status/:jobId', (req, res) => {
  const job = _zeusJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status !== 'running') {
    setTimeout(() => delete _zeusJobs[req.params.jobId], 5 * 60 * 1000);
  }
});

// ═══ GET /directives — Directivas activas ═══
router.get('/directives', async (req, res) => {
  try {
    const directives = await ZeusDirective.find({ active: true })
      .sort({ confidence: -1, created_at: -1 })
      .lean();
    res.json({ directives, count: directives.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /intelligence — Resumen completo de lo que Zeus sabe ═══
router.get('/intelligence', async (req, res) => {
  try {
    // Directivas activas
    const directives = await ZeusDirective.find({ active: true }).sort({ confidence: -1 }).lean();

    // Summary guardado
    const summary = await SystemConfig.get('zeus_intelligence_summary', null);

    // Stats de tests
    const testStats = await TestRun.aggregate([
      { $group: { _id: '$phase', count: { $sum: 1 }, avg_roas: { $avg: '$metrics.roas' }, total_spend: { $sum: '$metrics.spend' } } }
    ]);
    const testMap = {};
    for (const t of testStats) testMap[t._id] = t;

    // Graduation rate
    const graduated = testMap.graduated?.count || 0;
    const killed = testMap.killed?.count || 0;
    const expired = testMap.expired?.count || 0;
    const totalFinished = graduated + killed + expired;
    const graduationRate = totalFinished > 0 ? Math.round((graduated / totalFinished) * 100) : 0;

    // Patrones por escena (top 10)
    const scenePatterns = await TestRun.aggregate([
      { $match: { phase: { $in: ['graduated', 'killed', 'expired'] } } },
      { $lookup: { from: 'creativeproposals', localField: 'proposal_id', foreignField: '_id', as: 'proposal' } },
      { $unwind: { path: '$proposal', preserveNullAndEmptyArrays: true } },
      { $group: {
        _id: '$proposal.scene_short',
        total: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ['$phase', 'graduated'] }, 1, 0] } },
        avg_roas: { $avg: '$metrics.roas' },
        total_spend: { $sum: '$metrics.spend' }
      }},
      { $match: { _id: { $ne: null } } },
      { $sort: { wins: -1 } },
      { $limit: 10 }
    ]);

    // Intelligence score (0-100 basado en datos disponibles)
    const dataPoints = totalFinished * 3 + directives.length * 5;
    const intelligenceScore = Math.min(100, Math.round(dataPoints / 2));

    res.json({
      summary: summary?.summary || 'Zeus aun esta recopilando datos...',
      intelligence_score: intelligenceScore,
      directives: {
        active: directives,
        total_ever: await ZeusDirective.countDocuments()
      },
      testing: {
        graduated, killed, expired,
        active: (testMap.learning?.count || 0) + (testMap.evaluating?.count || 0),
        graduation_rate: graduationRate,
        avg_roas_graduated: Math.round((testMap.graduated?.avg_roas || 0) * 100) / 100,
        total_spend: Object.values(testMap).reduce((s, t) => s + (t.total_spend || 0), 0)
      },
      scene_patterns: scenePatterns.map(s => ({
        scene: s._id,
        win_rate: s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0,
        wins: s.wins,
        total: s.total,
        avg_roas: Math.round((s.avg_roas || 0) * 100) / 100,
        spend: Math.round(s.total_spend || 0)
      })),
      last_learning: summary?.updated_at || null
    });
  } catch (err) {
    logger.error(`[ZEUS] Error en /intelligence: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /stats — Stats rapidas ═══
router.get('/stats', async (req, res) => {
  try {
    const activeDirectives = await ZeusDirective.countDocuments({ active: true });
    const totalDirectives = await ZeusDirective.countDocuments();
    const summary = await SystemConfig.get('zeus_intelligence_summary', null);

    res.json({
      active_directives: activeDirectives,
      total_directives: totalDirectives,
      intelligence_score: summary?.patterns_count ? Math.min(100, summary.patterns_count * 10 + summary.total_tests * 3) : 0,
      last_learning: summary?.updated_at || null,
      summary: summary?.summary || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /conversations — Comunicaciones entre Zeus y agentes ═══
router.get('/conversations', async (req, res) => {
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');
    const conversations = await ZeusConversation.find()
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    res.json({ conversations, count: conversations.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /thoughts — Stream de consciencia de Zeus ═══
router.get('/thoughts', async (req, res) => {
  try {
    const BrainInsight = require('../../db/models/BrainInsight');
    const thoughts = await BrainInsight.find({
      generated_by: 'zeus'
    }).sort({ created_at: -1 }).limit(30).lean();

    res.json({ thoughts, count: thoughts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
