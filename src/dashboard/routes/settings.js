const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// Cargar configs actuales (en memoria, persisten al reiniciar desde archivos)
let safetyGuards = require('../../../config/safety-guards');
let kpiTargets = require('../../../config/kpi-targets');

// GET /api/settings — Toda la configuración actual
router.get('/', (req, res) => {
  res.json({
    safety_guards: safetyGuards,
    kpi_targets: kpiTargets,
    system: {
      timezone: process.env.TIMEZONE || 'America/New_York',
      node_env: process.env.NODE_ENV || 'development'
    }
  });
});

// PUT /api/settings/safety — Actualizar safety guards
router.put('/safety', (req, res) => {
  try {
    const updates = req.body;

    // Solo permitir actualizar campos conocidos
    const allowedFields = [
      'budget_ceiling_daily', 'min_adset_budget', 'max_single_adset_budget',
      'max_budget_increase_pct', 'max_budget_decrease_pct', 'max_total_daily_change_pct',
      'cooldown_hours', 'learning_phase_protection'
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        safetyGuards[key] = value;
      }
    }

    // Actualizar kill switch si se envía
    if (updates.kill_switch && typeof updates.kill_switch === 'object') {
      Object.assign(safetyGuards.kill_switch, updates.kill_switch);
    }

    logger.info('Safety guards actualizados desde dashboard:', updates);
    res.json({ success: true, safety_guards: safetyGuards });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/kpi — Actualizar KPI targets
router.put('/kpi', (req, res) => {
  try {
    const updates = req.body;

    const allowedFields = [
      'roas_target', 'roas_minimum', 'roas_excellent',
      'cpa_target', 'cpa_maximum', 'ctr_minimum',
      'frequency_warning', 'frequency_critical', 'cpm_benchmark',
      'daily_spend_target', 'underpacing_threshold', 'overpacing_threshold'
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        kpiTargets[key] = value;
      }
    }

    logger.info('KPI targets actualizados desde dashboard:', updates);
    res.json({ success: true, kpi_targets: kpiTargets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
