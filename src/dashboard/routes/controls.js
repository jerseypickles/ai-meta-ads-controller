const express = require('express');
const router = express.Router();
const config = require('../../../config');
const KillSwitch = require('../../safety/kill-switch');
const { CooldownManager } = require('../../safety/cooldown-manager');
const { getMetaClient } = require('../../meta/client');
const UnifiedPolicyAgent = require('../../ai/unified/unified-policy-agent');
const { isKillSwitchActive, getUnresolvedSafetyEvents, isAIEnabled, setAIEnabled } = require('../../db/queries');
const SystemConfig = require('../../db/models/SystemConfig');
const ActionLog = require('../../db/models/ActionLog');
const logger = require('../../utils/logger');

const SUPPORTED_ENGINE_MODES = ['unified_shadow', 'unified_live'];

// In-memory store for background cycle run jobs
const cycleRunJobs = new Map();
const CYCLE_RUN_JOB_TTL = 10 * 60 * 1000; // 10 minutes

function normalizeEngineMode(mode) {
  return SUPPORTED_ENGINE_MODES.includes(mode) ? mode : 'unified_shadow';
}

async function executeCycleForMode(mode) {
  const normalizedMode = normalizeEngineMode(mode);

  if (normalizedMode !== mode) {
    logger.warn(`[ENGINE_MODE] Modo no soportado "${mode}". Se usara "${normalizedMode}".`);
  }

  const policyMode = normalizedMode === 'unified_live' ? 'live' : 'shadow';
  const unified = new UnifiedPolicyAgent({ mode: policyMode });
  const result = await unified.runCycle({ mode: policyMode });

  return {
    mode: normalizedMode,
    cycle_id: result?.cycleId || null,
    recommendations: result?.recommendations || 0,
    executed: result?.execution?.executed || 0,
    learning_processed: result?.learningProcessed || 0,
    learning_average_reward: result?.learningAverageReward || 0
  };
}

function triggerCycleInBackground(mode, source) {
  const normalizedMode = normalizeEngineMode(mode);
  setImmediate(async () => {
    try {
      logger.info(`[AUTO_CYCLE] Disparando ciclo (${normalizedMode}) por ${source}`);
      const result = await executeCycleForMode(normalizedMode);
      logger.info(`[AUTO_CYCLE] Ciclo completado (${normalizedMode}) — recomendaciones=${result.recommendations}, ejecutadas=${result.executed}`);
    } catch (error) {
      logger.error(`[AUTO_CYCLE] Error en ciclo automático (${normalizedMode}) por ${source}:`, error.message);
    }
  });
}

// GET /api/controls/status — Estado general de controles
router.get('/status', async (req, res) => {
  try {
    const [killSwitchActive, aiEnabled] = await Promise.all([
      isKillSwitchActive(),
      isAIEnabled()
    ]);
    const decisionEngineMode = await SystemConfig.get(
      'decision_engine_mode',
      config.system.decisionEngineMode || 'unified_shadow'
    );
    const safetyEvents = await getUnresolvedSafetyEvents();
    const cooldownMgr = new CooldownManager();
    const activeCooldowns = await cooldownMgr.getActiveCooldowns();

    res.json({
      kill_switch_active: killSwitchActive,
      ai_enabled: aiEnabled,
      decision_engine_mode: normalizeEngineMode(decisionEngineMode),
      unresolved_safety_events: safetyEvents.length,
      safety_events: safetyEvents,
      active_cooldowns: activeCooldowns.length,
      cooldowns: activeCooldowns
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/controls/engine-mode — Modo actual del motor de decisiones
router.get('/engine-mode', async (req, res) => {
  try {
    const mode = await SystemConfig.get(
      'decision_engine_mode',
      config.system.decisionEngineMode || 'unified_shadow'
    );
    res.json({ decision_engine_mode: normalizeEngineMode(mode) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/controls/engine-mode — Cambiar modo del motor de decisiones
router.put('/engine-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    const validModes = SUPPORTED_ENGINE_MODES;
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: `mode invalido. Usa: ${validModes.join(', ')}` });
    }

    await SystemConfig.set('decision_engine_mode', mode, req.user?.user || 'dashboard');
    const aiEnabled = await isAIEnabled();
    if (aiEnabled) {
      triggerCycleInBackground(mode, 'engine_mode_change');
    }

    logger.warn(`[ENGINE_MODE] Motor de decisiones cambiado a: ${mode}`);
    res.json({
      success: true,
      decision_engine_mode: mode,
      auto_cycle_triggered: aiEnabled
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/run-cycle — Ejecutar un ciclo IA inmediato (background + polling)
router.post('/run-cycle', async (req, res) => {
  try {
    const aiEnabled = await isAIEnabled();
    if (!aiEnabled) {
      return res.status(400).json({ error: 'IA desactivada. Activa IA antes de ejecutar un ciclo manual.' });
    }

    const mode = await SystemConfig.get(
      'decision_engine_mode',
      config.system.decisionEngineMode || 'unified_shadow'
    );
    const normalizedMode = normalizeEngineMode(mode);

    const jobId = `cycle_run_${Date.now()}`;
    cycleRunJobs.set(jobId, { status: 'running', startedAt: Date.now(), result: null, error: null });

    // Respond immediately
    res.json({ success: true, async: true, job_id: jobId, message: `Ciclo IA (${normalizedMode}) iniciado en background` });

    // Execute in background
    (async () => {
      const result = await executeCycleForMode(normalizedMode);
      cycleRunJobs.set(jobId, {
        status: 'completed',
        startedAt: cycleRunJobs.get(jobId)?.startedAt,
        result,
        error: null
      });
      logger.info(`[MANUAL] Ciclo IA completado — job ${jobId}`);
    })().catch(error => {
      logger.error('Error ejecutando ciclo IA manual:', error);
      cycleRunJobs.set(jobId, {
        status: 'failed',
        startedAt: cycleRunJobs.get(jobId)?.startedAt,
        result: null,
        error: error.message
      });
    }).finally(() => {
      setTimeout(() => cycleRunJobs.delete(jobId), CYCLE_RUN_JOB_TTL);
    });
  } catch (error) {
    logger.error('Error iniciando ciclo IA:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/controls/run-cycle-status/:jobId — Poll status of background cycle run
router.get('/run-cycle-status/:jobId', async (req, res) => {
  const job = cycleRunJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job no encontrado o expirado' });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  if (job.status === 'running') {
    return res.json({ status: 'running', elapsed_seconds: elapsed });
  }

  if (job.status === 'completed') {
    return res.json({ status: 'completed', elapsed_seconds: elapsed, result: job.result });
  }

  return res.json({ status: 'failed', elapsed_seconds: elapsed, error: job.error });
});

// POST /api/controls/kill-switch — Activar/desactivar kill switch
router.post('/kill-switch', async (req, res) => {
  try {
    const { action } = req.body; // 'trigger' o 'reset'
    const ks = new KillSwitch();

    if (action === 'trigger') {
      const result = await ks.triggerEmergencyPause('Activado manualmente desde el dashboard');
      logger.warn('Kill switch activado manualmente');
      return res.json(result);
    }

    if (action === 'reset') {
      const result = await ks.manualReset();
      logger.warn('Kill switch reseteado manualmente');
      return res.json(result);
    }

    res.status(400).json({ error: 'Acción debe ser "trigger" o "reset"' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/pause/:entityId — Pausar manualmente
router.post('/pause/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const meta = getMetaClient();

    await meta.updateStatus(entityId, 'PAUSED');

    // Registrar acción manual
    await ActionLog.create({
      entity_type: req.body.entity_type || 'adset',
      entity_id: entityId,
      entity_name: req.body.entity_name || entityId,
      action: 'pause',
      before_value: 'ACTIVE',
      after_value: 'PAUSED',
      reasoning: 'Pausado manualmente desde el dashboard',
      confidence: 'high',
      success: true
    });

    // Establecer cooldown
    const cooldownMgr = new CooldownManager();
    await cooldownMgr.setCooldown(entityId, req.body.entity_type || 'adset', 'pause', 'manual');

    res.json({
      success: true,
      message: `${entityId} pausado`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/delete/:entityId — Eliminar via HTTP DELETE en Meta API
router.post('/delete/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const meta = getMetaClient();

    await meta.deleteObject(entityId);

    await ActionLog.create({
      entity_type: req.body.entity_type || 'ad',
      entity_id: entityId,
      entity_name: req.body.entity_name || entityId,
      action: 'delete',
      before_value: req.body.previous_status || 'ACTIVE',
      after_value: 'DELETED',
      reasoning: req.body.reason || 'Eliminado manualmente desde el dashboard',
      confidence: 'high',
      success: true
    });

    res.json({
      success: true,
      message: `${entityId} eliminado`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/activate/:entityId — Activar manualmente
router.post('/activate/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const meta = getMetaClient();

    await meta.updateStatus(entityId, 'ACTIVE');

    await ActionLog.create({
      entity_type: req.body.entity_type || 'adset',
      entity_id: entityId,
      entity_name: req.body.entity_name || entityId,
      action: 'reactivate',
      before_value: 'PAUSED',
      after_value: 'ACTIVE',
      reasoning: 'Reactivado manualmente desde el dashboard',
      confidence: 'high',
      success: true
    });

    const cooldownMgr = new CooldownManager();
    await cooldownMgr.setCooldown(entityId, req.body.entity_type || 'adset', 'reactivate', 'manual');

    res.json({
      success: true,
      message: `${entityId} activado`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/ai-toggle — Activar/desactivar control de IA
router.post('/ai-toggle', async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Campo "enabled" debe ser true o false' });
    }

    await setAIEnabled(enabled, 'dashboard');
    let cycleTriggered = false;
    if (enabled) {
      const mode = await SystemConfig.get(
        'decision_engine_mode',
        config.system.decisionEngineMode || 'unified_shadow'
      );
      cycleTriggered = true;
      triggerCycleInBackground(normalizeEngineMode(mode), 'ai_toggle_enabled');
    }

    logger.warn(`IA ${enabled ? 'ACTIVADA' : 'DESACTIVADA'} desde el dashboard`);

    res.json({
      success: true,
      ai_enabled: enabled,
      auto_cycle_triggered: cycleTriggered,
      message: enabled
        ? 'IA activada — ciclo automático disparado y luego seguirá por cron'
        : 'IA desactivada — solo se recolectarán datos, sin decisiones ni ejecuciones'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/controls/ai-status — Estado actual del switch de IA
router.get('/ai-status', async (req, res) => {
  try {
    const aiEnabled = await isAIEnabled();
    res.json({ ai_enabled: aiEnabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/controls/cooldown/:entityId — Gestionar cooldown
router.post('/cooldown/:entityId', async (req, res) => {
  try {
    const { entityId } = req.params;
    const { action } = req.body; // 'set' o 'clear'
    const cooldownMgr = new CooldownManager();

    if (action === 'clear') {
      await cooldownMgr.clearCooldown(entityId);
      return res.json({ success: true, message: 'Cooldown eliminado' });
    }

    res.status(400).json({ error: 'Acción debe ser "clear"' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
