const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const ActionLog = require('../../db/models/ActionLog');
const SystemConfig = require('../../db/models/SystemConfig');
const { getLatestSnapshots } = require('../../db/queries');

// ═══ In-memory job tracking ═══
const _aresJobs = {};

// ═══ POST /run — Trigger manual ═══
router.post('/run', async (req, res) => {
  try {
    const jobId = `ares_job_${Date.now()}`;
    _aresJobs[jobId] = { status: 'running', started_at: new Date() };
    res.json({ async: true, job_id: jobId, message: 'Ares Duplication Agent iniciado' });

    const { runAresAgent } = require('../../ai/agent/ares-agent');
    runAresAgent().then(result => {
      _aresJobs[jobId] = { status: 'completed', ...result };
    }).catch(err => {
      _aresJobs[jobId] = { status: 'failed', error: err.message };
      logger.error(`[ARES-API] Job ${jobId} fallo: ${err.message}`);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /run-status/:jobId — Polling ═══
router.get('/run-status/:jobId', (req, res) => {
  const job = _aresJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status !== 'running') {
    setTimeout(() => delete _aresJobs[req.params.jobId], 5 * 60 * 1000);
  }
});

// ═══ GET /intelligence — Datos completos del tab Ares ═══
router.get('/intelligence', async (req, res) => {
  try {
    // Campana Ares (CBO — budget a nivel de campana)
    const aresCampaignId = await SystemConfig.get('ares_campaign_id', null);

    // Duplicaciones realizadas
    const duplications = await ActionLog.find({
      action: 'duplicate_adset',
      agent_type: 'ares_agent',
      success: true
    }).sort({ executed_at: -1 }).lean();

    // Ad sets activos en la campana de Ares
    let aresAdSets = [];
    if (aresCampaignId) {
      const allSnapshots = await getLatestSnapshots('adset');
      aresAdSets = allSnapshots
        .filter(s => s.campaign_id === aresCampaignId && s.status === 'ACTIVE')
        .map(s => {
          const m7 = s.metrics?.last_7d || {};
          const m3 = s.metrics?.last_3d || {};
          return {
            adset_id: s.entity_id,
            adset_name: s.entity_name,
            daily_budget: s.daily_budget || 0,
            roas_7d: Math.round((m7.roas || 0) * 100) / 100,
            roas_3d: Math.round((m3.roas || 0) * 100) / 100,
            spend_7d: Math.round(m7.spend || 0),
            purchases_7d: m7.purchases || 0,
            frequency: Math.round((m7.frequency || 0) * 10) / 10,
            ctr: Math.round((m7.ctr || 0) * 100) / 100
          };
        });
    }

    // Candidatos actuales (ad sets que cumplen criterios y NO tienen clones activos)
    const allSnapshots = await getLatestSnapshots('adset');
    const EXCLUDE_PATTERNS = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'EXCLUDE', 'MANUAL ONLY', '[ARES]'];
    const alreadyDuplicated = new Set(duplications.map(d => d.entity_id));
    const candidates = allSnapshots.filter(s => {
      if (s.status !== 'ACTIVE') return false;
      const name = (s.entity_name || '').toUpperCase();
      if (EXCLUDE_PATTERNS.some(ex => name.includes(ex.toUpperCase()))) return false;
      if (alreadyDuplicated.has(s.entity_id)) return false;
      const m7 = s.metrics?.last_7d || {};
      return (m7.roas || 0) >= 4.0 && (m7.spend || 0) >= 100 && (m7.frequency || 0) < 2.0;
    }).map(s => {
      const m7 = s.metrics?.last_7d || {};
      return {
        entity_id: s.entity_id,
        entity_name: s.entity_name,
        roas_7d: Math.round((m7.roas || 0) * 100) / 100,
        spend_7d: Math.round(m7.spend || 0),
        purchases_7d: m7.purchases || 0,
        frequency: Math.round((m7.frequency || 0) * 10) / 10
      };
    }).sort((a, b) => b.roas_7d - a.roas_7d);

    // Stats de la campana CBO (lo que importa)
    const totalDuplicated = duplications.length;
    const cbo_spend = aresAdSets.reduce((s, a) => s + a.spend_7d, 0);
    const cbo_revenue = aresAdSets.reduce((s, a) => s + Math.round(a.roas_7d * a.spend_7d), 0);
    const cbo_roas = cbo_spend > 0 ? Math.round((cbo_revenue / cbo_spend) * 100) / 100 : 0;
    const cbo_purchases = aresAdSets.reduce((s, a) => s + a.purchases_7d, 0);
    const cbo_cpa = cbo_purchases > 0 ? Math.round(cbo_spend / cbo_purchases * 100) / 100 : 0;

    res.json({
      campaign_id: aresCampaignId,
      // Metricas CBO (campana como un todo)
      cbo: {
        roas: cbo_roas,
        spend_7d: cbo_spend,
        revenue_7d: cbo_revenue,
        purchases_7d: cbo_purchases,
        cpa: cbo_cpa,
        active_clones: aresAdSets.length
      },
      // Legacy fields (retrocompat)
      clone_budget: 30,
      active_duplicates: aresAdSets.length,
      total_duplicated: totalDuplicated,
      avg_roas: cbo_roas,
      total_spend_7d: cbo_spend,
      adsets: aresAdSets,
      candidates,
      recent_duplications: duplications.slice(0, 10).map(d => ({
        original_name: d.entity_name,
        clone_id: d.new_entity_id,
        clone_name: d.after_value,
        roas_at_dup: d.metrics_at_execution?.roas_7d || 0,
        executed_at: d.executed_at,
        reasoning: d.reasoning
      }))
    });
  } catch (err) {
    logger.error(`[ARES-API] Error en /intelligence: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
