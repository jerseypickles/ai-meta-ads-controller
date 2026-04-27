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

module.exports = router;
