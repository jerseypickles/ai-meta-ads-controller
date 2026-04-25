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
    // Tres campanas CBO (CBO 3 agregada abril 2026 como tier de rescate/medicion)
    const aresCampaignId = await SystemConfig.get('ares_campaign_id', null);
    const aresCampaign2Id = await SystemConfig.get('ares_campaign_2_id', null);
    const aresCampaign3Id = await SystemConfig.get('ares_campaign_3_id', null);

    // Duplicaciones realizadas (incluye fast-tracks)
    const duplications = await ActionLog.find({
      action: { $in: ['duplicate_adset', 'fast_track_duplicate'] },
      agent_type: 'ares_agent',
      success: true
    }).sort({ executed_at: -1 }).lean();

    const allSnapshots = await getLatestSnapshots('adset');

    // Helper: mapear ad sets de una campana
    const mapCampaignAdsets = (campaignId) => {
      if (!campaignId) return [];
      return allSnapshots
        .filter(s => s.campaign_id === campaignId && s.status === 'ACTIVE')
        .map(s => {
          const m7 = s.metrics?.last_7d || {};
          const m3 = s.metrics?.last_3d || {};
          return {
            adset_id: s.entity_id, adset_name: s.entity_name,
            daily_budget: s.daily_budget || 0,
            roas_7d: Math.round((m7.roas || 0) * 100) / 100,
            roas_3d: Math.round((m3.roas || 0) * 100) / 100,
            spend_7d: Math.round(m7.spend || 0),
            purchases_7d: m7.purchases || 0,
            frequency: Math.round((m7.frequency || 0) * 10) / 10,
            ctr: Math.round((m7.ctr || 0) * 100) / 100
          };
        });
    };

    // Helper: calcular stats de una lista de ad sets
    const calcStats = (adsets) => {
      const spend = adsets.reduce((s, a) => s + a.spend_7d, 0);
      const revenue = adsets.reduce((s, a) => s + Math.round(a.roas_7d * a.spend_7d), 0);
      const purchases = adsets.reduce((s, a) => s + a.purchases_7d, 0);
      return {
        roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
        spend_7d: spend, revenue_7d: revenue, purchases_7d: purchases,
        cpa: purchases > 0 ? Math.round(spend / purchases * 100) / 100 : 0,
        active_clones: adsets.length
      };
    };

    const cbo1Adsets = mapCampaignAdsets(aresCampaignId);
    const cbo2Adsets = mapCampaignAdsets(aresCampaign2Id);
    const cbo3Adsets = mapCampaignAdsets(aresCampaign3Id);
    const allAdsets = [...cbo1Adsets, ...cbo2Adsets, ...cbo3Adsets];
    const cbo1Stats = calcStats(cbo1Adsets);
    const cbo2Stats = calcStats(cbo2Adsets);
    const cbo3Stats = calcStats(cbo3Adsets);
    const totalStats = calcStats(allAdsets);

    // Candidatos (no duplicados aun)
    const EXCLUDE_PATTERNS = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'EXCLUDE', 'MANUAL ONLY', '[ARES]'];
    const alreadyDuplicated = new Set(duplications.map(d => d.entity_id));
    const candidates = allSnapshots.filter(s => {
      if (s.status !== 'ACTIVE') return false;
      const name = (s.entity_name || '').toUpperCase();
      if (EXCLUDE_PATTERNS.some(ex => name.includes(ex.toUpperCase()))) return false;
      if (alreadyDuplicated.has(s.entity_id)) return false;
      // Criterios endurecidos (abril 2026 — match ares-agent.js):
      // ROAS sostenido 14d (fallback 7d), $500+ spend, 30+ purch, freq < 2.0
      const m14 = s.metrics?.last_14d || s.metrics?.last_7d || {};
      const m7 = s.metrics?.last_7d || {};
      const roas = m14.roas || 0;
      const spend = m14.spend || 0;
      const purchases = m14.purchases || 0;
      const freq = m7.frequency || 0;
      const learningConv = s.learning_stage_conversions || 0;
      const isSuccess = s.learning_stage === 'SUCCESS';
      return roas >= 3.0 && spend >= 500 && purchases >= 30 && freq < 2.0 && (isSuccess || learningConv >= 40);
    }).map(s => {
      const m7 = s.metrics?.last_7d || {};
      return {
        entity_id: s.entity_id, entity_name: s.entity_name,
        roas_7d: Math.round((m7.roas || 0) * 100) / 100,
        spend_7d: Math.round(m7.spend || 0),
        purchases_7d: m7.purchases || 0,
        frequency: Math.round((m7.frequency || 0) * 10) / 10
      };
    }).sort((a, b) => b.roas_7d - a.roas_7d);

    res.json({
      campaign_id: aresCampaignId,
      campaign_2_id: aresCampaign2Id,
      campaign_3_id: aresCampaign3Id,
      // Metricas por CBO individual
      cbo1: { ...cbo1Stats, adsets: cbo1Adsets },
      cbo2: { ...cbo2Stats, adsets: cbo2Adsets },
      cbo3: { ...cbo3Stats, adsets: cbo3Adsets },
      // Metricas combinadas
      cbo: totalStats,
      // Legacy + global
      clone_budget: 30,
      active_duplicates: allAdsets.length,
      total_duplicated: duplications.length,
      avg_roas: totalStats.roas,
      total_spend_7d: totalStats.spend_7d,
      adsets: allAdsets,
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

// ═══ GET /cbo-health — snapshots más recientes por CBO + resumen + history ═══
router.get('/cbo-health', async (req, res) => {
  try {
    const CBOHealthSnapshot = require('../../db/models/CBOHealthSnapshot');

    // Último snapshot por CBO
    const latest = await CBOHealthSnapshot.aggregate([
      { $sort: { campaign_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { is_zombie: 1, daily_budget: -1 } }
    ]);

    // Sparkline ROAS 7 días (12 snapshots/día × 7 = 84 puntos max por CBO)
    const since = new Date(Date.now() - 7 * 86400000);
    const history = await CBOHealthSnapshot.find({
      snapshot_at: { $gte: since }
    }).sort({ snapshot_at: 1 }).lean();

    const byCampaign = {};
    for (const h of history) {
      if (!byCampaign[h.campaign_id]) byCampaign[h.campaign_id] = [];
      byCampaign[h.campaign_id].push({
        t: h.snapshot_at,
        roas_3d: h.cbo_roas_3d,
        concentration: h.concentration_index_3d,
        starved: h.starved_count
      });
    }

    res.json({
      snapshots: latest,
      history_by_campaign: byCampaign,
      summary: {
        total: latest.length,
        zombies: latest.filter(s => s.is_zombie).length,
        collapse: latest.filter(s => s.collapse_detected).length,
        saturating: latest.filter(s =>
          s.concentration_sustained_3d && s.favorite_declining && s.favorite_freq > 2
        ).length
      }
    });
  } catch (err) {
    logger.error(`[ARES-API] Error en /cbo-health: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ GET /portfolio-actions — timeline de acciones del Portfolio Manager ═══
router.get('/portfolio-actions', async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '72', 10), 336);
    const since = new Date(Date.now() - hours * 3600000);

    const actions = await ActionLog.find({
      agent_type: { $in: ['ares_portfolio', 'ares_agent', 'ares_brain'] },
      executed_at: { $gte: since }
    }).sort({ executed_at: -1 }).limit(100).lean();

    // Enriquecer con metadata para render
    const enriched = actions.map(a => ({
      id: a._id,
      action: a.action,
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      entity_name: a.entity_name,
      agent_type: a.agent_type,
      executed_at: a.executed_at,
      success: a.success,
      before_value: a.before_value,
      after_value: a.after_value,
      reasoning: a.reasoning,
      detector: a.metadata?.detector
        || (a.agent_type === 'ares_brain' ? 'brain_llm' : null),
      error: a.error,
      is_portfolio: a.agent_type === 'ares_portfolio',
      is_brain: a.agent_type === 'ares_brain',
      metadata: a.metadata || {}
    }));

    // Resumen por tipo
    const summary = {
      total: enriched.length,
      portfolio_actions: enriched.filter(e => e.is_portfolio).length,
      brain_actions: enriched.filter(e => e.is_brain).length,
      duplications: enriched.filter(e => e.action === 'duplicate_adset').length,
      pauses: enriched.filter(e => e.action === 'pause').length,
      scale_ups: enriched.filter(e => e.action === 'scale_up').length,
      failures: enriched.filter(e => !e.success).length,
      by_detector: {}
    };
    for (const a of enriched.filter(e => e.detector)) {
      summary.by_detector[a.detector] = (summary.by_detector[a.detector] || 0) + 1;
    }

    res.json({ actions: enriched, summary, window_hours: hours });
  } catch (err) {
    logger.error(`[ARES-API] Error en /portfolio-actions: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═══ POST /cbo-health/run — trigger manual del monitor ═══
router.post('/cbo-health/run', async (req, res) => {
  try {
    const { runCBOHealthMonitor } = require('../../ai/agent/cbo-health-monitor');
    const result = await runCBOHealthMonitor();
    res.json({ ok: true, snapshots_created: result.length });
  } catch (err) {
    logger.error(`[ARES-API] Error en /cbo-health/run: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
