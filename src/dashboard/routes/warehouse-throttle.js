/**
 * Warehouse Throttle API — control desde frontend.
 *
 * GET  /api/system/warehouse-throttle           → status + config
 * POST /api/system/warehouse-throttle/enable    → activar
 * POST /api/system/warehouse-throttle/disable   → desactivar
 * POST /api/system/warehouse-throttle/recovery  → cambiar a recovery_mode
 * POST /api/system/warehouse-throttle/extend    → +N días al auto_disable
 * POST /api/system/warehouse-throttle/update    → cambiar target / días / etc
 * POST /api/system/warehouse-throttle/run-now   → forzar ciclo manual (debug)
 */

const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const wh = require('../../safety/warehouse-throttle');

router.get('/', async (req, res) => {
  try {
    const status = await wh.getStatus();
    const config = await wh.getConfig();
    res.json({ status, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/enable', async (req, res) => {
  try {
    const { target_daily_spend, reason } = req.body || {};
    const updates = {
      enabled: true,
      enabled_at: new Date().toISOString(),
      recovery_mode: false
    };
    if (typeof target_daily_spend === 'number' && target_daily_spend > 0) {
      updates.target_daily_spend = target_daily_spend;
    }
    if (reason) updates.reason = String(reason).substring(0, 200);
    const cfg = await wh.setConfig(updates);
    logger.info(`[warehouse-throttle] ENABLED · target $${cfg.target_daily_spend}/d · reason: ${cfg.reason}`);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disable', async (req, res) => {
  try {
    const cfg = await wh.setConfig({ enabled: false, recovery_mode: false, enabled_at: null });
    logger.info('[warehouse-throttle] DISABLED');
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery', async (req, res) => {
  try {
    const { recovery_target_daily_spend } = req.body || {};
    const updates = { recovery_mode: true };
    if (typeof recovery_target_daily_spend === 'number' && recovery_target_daily_spend > 0) {
      updates.recovery_target_daily_spend = recovery_target_daily_spend;
    }
    const cfg = await wh.setConfig(updates);
    logger.info(`[warehouse-throttle] RECOVERY mode ON · target $${cfg.recovery_target_daily_spend}/d`);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/extend', async (req, res) => {
  try {
    const { days = 7 } = req.body || {};
    const cfg = await wh.getConfig();
    const newDays = (cfg.auto_disable_after_days || 21) + Math.abs(parseInt(days, 10) || 7);
    const updated = await wh.setConfig({ auto_disable_after_days: newDays });
    logger.info(`[warehouse-throttle] EXTENDED auto_disable: ${cfg.auto_disable_after_days} → ${newDays}d`);
    res.json({ ok: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/update', async (req, res) => {
  try {
    const allowed = [
      'target_daily_spend',
      'recovery_target_daily_spend',
      'floor_per_cbo',
      'floor_per_adset',
      'pause_apollo',
      'pause_prometheus',
      'pause_ares_scaling',
      'auto_disable_after_days',
      'reason',
      'roas_tiers'
    ];
    const updates = {};
    for (const k of allowed) {
      if (k in (req.body || {})) updates[k] = req.body[k];
    }
    const cfg = await wh.setConfig(updates);
    logger.info(`[warehouse-throttle] UPDATED: ${Object.keys(updates).join(', ')}`);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/run-now', async (req, res) => {
  try {
    const result = await wh.runThrottleCycle();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /rescale-now — bajada/subida inmediata proporcional a targetTotal.
// Body: { target_total: number, dryRun?: bool (default true), respectFloors?: bool }
// A diferencia de run-now, opera también sobre adsets paused.
router.post('/rescale-now', async (req, res) => {
  try {
    const { target_total, dryRun = true, respectFloors = true } = req.body || {};
    if (typeof target_total !== 'number' || target_total <= 0) {
      return res.status(400).json({ error: 'target_total (positive number) required' });
    }
    const result = await wh.rescaleAll(target_total, { dryRun, respectFloors });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /set-budgets — set explícito de daily_budget para entities específicas.
// Body: { updates: [{entity_id, daily_budget}, ...] }
router.post('/set-budgets', async (req, res) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array required' });
    }
    const { getMetaClient } = require('../../meta/client');
    const ActionLog = require('../../db/models/ActionLog');
    const meta = getMetaClient();
    let applied = 0, errors = 0;
    const results = [];
    for (const u of updates) {
      try {
        await meta.updateBudget(u.entity_id, u.daily_budget);
        await ActionLog.create({
          entity_type: u.kind || 'campaign',
          entity_id: u.entity_id,
          entity_name: u.name || '',
          action: 'scale_up',
          before_value: u.before || 0,
          after_value: u.daily_budget,
          success: true,
          executed_at: new Date(),
          agent_type: 'warehouse_throttle',
          reasoning: u.reason || 'Manual set-budget via API',
          metadata: { source: 'manual_set_budget' }
        });
        applied++;
        results.push({ entity_id: u.entity_id, ok: true, after: u.daily_budget });
      } catch (err) {
        errors++;
        results.push({ entity_id: u.entity_id, ok: false, error: err.message?.substring(0, 200) });
      }
    }
    res.json({ ok: true, applied, errors, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /cleanup-archived-snapshots — borrar MetricSnapshot de entities archived
// O entity_id específico (cuando una entity ya no existe en Meta).
// Body: { dryRun?: bool, entity_id?: string, entity_ids?: [string] }
//   - sin entity_id ni entity_ids → borra status=ARCHIVED
//   - con entity_id → borra solo snapshots de ese entity
//   - con entity_ids → borra snapshots de la lista
router.post('/cleanup-archived-snapshots', async (req, res) => {
  try {
    const MetricSnapshot = require('../../db/models/MetricSnapshot');
    const { dryRun = true, entity_id, entity_ids } = req.body || {};

    let filter;
    if (entity_id) {
      filter = { entity_id };
    } else if (Array.isArray(entity_ids) && entity_ids.length > 0) {
      filter = { entity_id: { $in: entity_ids } };
    } else {
      filter = { status: 'ARCHIVED' };
    }

    if (dryRun) {
      const count = await MetricSnapshot.countDocuments(filter);
      const sample = await MetricSnapshot.find(filter).limit(5).select('entity_id entity_type entity_name daily_budget status').lean();
      return res.json({ dryRun: true, filter, would_delete: count, sample });
    }

    const result = await MetricSnapshot.deleteMany(filter);
    res.json({ ok: true, filter, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
