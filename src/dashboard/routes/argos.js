// ═══════════════════════════════════════════════════════════════════════════════
// Rutas de ARGOS 🦚 — análisis del pixel (funnel + salud)
// GET  /intelligence  → reporte live (funnel + tasas + issues + health) con cache
// GET  /history       → últimos snapshots (tendencia del health/funnel)
// POST /run           → fuerza un análisis nuevo + persiste
// Montado bajo /api/argos.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const ArgosSnapshot = require('../../db/models/ArgosSnapshot');
const logger = require('../../utils/logger');

let _cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// GET /intelligence — reporte live (cacheado 5min). Si el cache está frío, analiza.
router.get('/intelligence', async (req, res) => {
  try {
    if (_cache.data && Date.now() - _cache.ts < CACHE_TTL) {
      return res.json({ ...(_cache.data), cached: true });
    }
    const { analyzePixel } = require('../../ai/agent/argos-agent');
    const report = await analyzePixel();
    _cache = { data: report, ts: Date.now() };
    res.json({ ...report, cached: false });
  } catch (e) {
    // Fallback al último snapshot persistido si la API de Meta falla.
    const last = await ArgosSnapshot.findOne().sort({ created_at: -1 }).lean().catch(() => null);
    if (last) return res.json({ ...last, stale: true, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /history — tendencia (health + funnel) de los últimos N snapshots
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const snaps = await ArgosSnapshot.find().sort({ created_at: -1 }).limit(limit)
      .select('health_score funnel_today funnel_7d rates created_at').lean();
    res.json({ snapshots: snaps.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /run — fuerza análisis + persiste (async)
router.post('/run', async (req, res) => {
  try {
    const { runArgos } = require('../../ai/agent/argos-agent');
    runArgos().then(r => { _cache = { data: r, ts: Date.now() }; logger.info('[ARGOS] run manual completado'); })
      .catch(e => logger.error(`[ARGOS] run manual falló: ${e.message}`));
    res.json({ started: true, message: 'Argos analizando el pixel…' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
