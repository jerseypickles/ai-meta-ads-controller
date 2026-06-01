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

const _cache = {}; // por ventana de días
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// GET /intelligence?days=30 — reporte live (cacheado 5min por ventana).
router.get('/intelligence', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const c = _cache[days];
    if (c && Date.now() - c.ts < CACHE_TTL) {
      return res.json({ ...(c.data), cached: true });
    }
    const { analyzePixel } = require('../../ai/agent/argos-agent');
    const report = await analyzePixel(days);
    _cache[days] = { data: report, ts: Date.now() };
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

// GET /capi-stats — salud del envío server-side (Meta Conversions API).
// Lee la colección CapiEvent: totales por estado, últimas 24h, match quality
// (qué señal lleva cada evento) y las últimas compras enviadas.
router.get('/capi-stats', async (req, res) => {
  try {
    const config = require('../../../config');
    const CapiEvent = require('../../db/models/CapiEvent');
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    // event_name ausente en docs viejos = Purchase (era el default). Matchea ambos.
    const PURCHASE = { $or: [{ event_name: 'Purchase' }, { event_name: { $exists: false } }] };

    // Totales por estado — solo Purchase (los KPIs de plata son de compras).
    const byStatus = await CapiEvent.aggregate([
      { $match: PURCHASE },
      { $group: { _id: '$status', n: { $sum: 1 } } }
    ]);
    const totals = { sent: 0, pending: 0, failed: 0 };
    for (const r of byStatus) if (r._id in totals) totals[r._id] = r.n;
    totals.total = totals.sent + totals.pending + totals.failed;

    // Enviados últimas 24h + valor (Purchase).
    const sent24 = await CapiEvent.find({ ...PURCHASE, status: 'sent', sent_at: { $gte: since24h } })
      .select('payload sent_at').lean();
    const sentToday = sent24.length;
    const valueToday = sent24.reduce((s, d) => s + (d.payload?.custom_data?.value || 0), 0);

    // InitiateCheckout — totales por estado + enviados 24h.
    const icByStatus = await CapiEvent.aggregate([
      { $match: { event_name: 'InitiateCheckout' } },
      { $group: { _id: '$status', n: { $sum: 1 } } }
    ]);
    const ic = { sent: 0, pending: 0, failed: 0 };
    for (const r of icByStatus) if (r._id in ic) ic[r._id] = r.n;
    ic.sent_today = await CapiEvent.countDocuments({ event_name: 'InitiateCheckout', status: 'sent', sent_at: { $gte: since24h } });

    // Match Quality — sobre los últimos 200 Purchase enviados: qué % llevó cada señal.
    const recentSent = await CapiEvent.find({ ...PURCHASE, status: 'sent' })
      .sort({ sent_at: -1 }).limit(200).select('payload').lean();
    const mqKeys = { em: 'em', ph: 'ph', fn: 'fn', ln: 'ln', ct: 'ct', zp: 'zp',
                     external_id: 'external_id', fbp: 'fbp', fbc: 'fbc',
                     ip: 'client_ip_address', ua: 'client_user_agent' };
    const mqCount = {}; Object.keys(mqKeys).forEach(k => mqCount[k] = 0);
    let keySum = 0;
    for (const d of recentSent) {
      const ud = d.payload?.user_data || {};
      let n = 0;
      for (const [k, src] of Object.entries(mqKeys)) {
        if (ud[src] != null && (!Array.isArray(ud[src]) || ud[src].length)) { mqCount[k]++; n++; }
      }
      keySum += n;
    }
    const denom = recentSent.length || 1;
    const match_quality = {};
    Object.keys(mqKeys).forEach(k => match_quality[k] = Math.round((mqCount[k] / denom) * 100));
    match_quality.avg_keys = recentSent.length ? +(keySum / recentSent.length).toFixed(1) : 0;
    match_quality.sample = recentSent.length;

    // Últimas 20 compras (cualquier estado) para el feed.
    const recent = await CapiEvent.find(PURCHASE).sort({ created_at: -1 }).limit(20)
      .select('order_id event_id status events_received fbtrace_id last_error attempts created_at sent_at payload').lean();
    const recentOut = recent.map(d => {
      const ud = d.payload?.user_data || {};
      return {
        order_id: d.order_id,
        value: d.payload?.custom_data?.value || 0,
        currency: d.payload?.custom_data?.currency || 'USD',
        status: d.status,
        events_received: d.events_received,
        fbtrace_id: d.fbtrace_id || '',
        last_error: d.last_error || '',
        attempts: d.attempts,
        sent_at: d.sent_at,
        created_at: d.created_at,
        has_fbp: ud.fbp != null,
        has_fbc: ud.fbc != null,
        dedup_ok: typeof d.event_id === 'string' && d.event_id.startsWith('purchase_')
      };
    });

    const lastSent = await CapiEvent.findOne({ ...PURCHASE, status: 'sent' }).sort({ sent_at: -1 }).select('sent_at').lean();

    res.json({
      enabled: !!config.capi.enabled,
      configured: !!config.capi.accessToken,
      pixel_id: config.capi.pixelId,
      test_mode: !!config.capi.testEventCode,
      totals, sent_today: sentToday, value_today: valueToday,
      initiate_checkout: ic,
      match_quality, recent: recentOut,
      last_sent_at: lastSent?.sent_at || null
    });
  } catch (e) {
    logger.error(`[ARGOS] capi-stats falló: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /run — fuerza análisis + persiste (async)
router.post('/run', async (req, res) => {
  try {
    const { runArgos } = require('../../ai/agent/argos-agent');
    runArgos().then(r => { if (r && !r.error) _cache[r.window_days || 30] = { data: r, ts: Date.now() }; logger.info('[ARGOS] run manual completado'); })
      .catch(e => logger.error(`[ARGOS] run manual falló: ${e.message}`));
    res.json({ started: true, message: 'Argos analizando el pixel…' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
