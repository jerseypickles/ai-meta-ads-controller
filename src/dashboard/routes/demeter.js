/**
 * Demeter routes — cash reconciliation snapshots.
 *
 * GET /snapshots?days=30   — array de DemeterSnapshot, ordenado más reciente primero
 * GET /today                — snapshot LIVE del día actual (consulta Shopify ahora,
 *                              NO re-graba en DB. Útil para HUD intraday)
 * GET /summary?days=7       — agregados: avg cash_roas, total spend, total
 *                              revenue, avg gap_pct, suma orders
 * POST /run-now              — trigger manual del cron (útil para debugging)
 */

const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const DemeterSnapshot = require('../../db/models/DemeterSnapshot');

// GET /snapshots?days=30
router.get('/snapshots', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const snaps = await DemeterSnapshot.find({})
      .sort({ date_et: -1 })
      .limit(days)
      .lean();
    res.json({ count: snaps.length, snapshots: snaps });
  } catch (err) {
    logger.error(`[demeter route] snapshots: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /today — live computation, no graba DB
router.get('/today', async (req, res) => {
  try {
    const { _helpers, runDailySnapshot } = require('../../ai/agent/demeter-agent');
    const todayEt = _helpers.todayInET();

    // Si ya hay snapshot del día (no debería hasta 00:05 mañana),
    // usar ese. Sino, computar live.
    const existing = await DemeterSnapshot.findOne({ date_et: todayEt }).lean();
    if (existing) return res.json({ live: false, snapshot: existing });

    // Live compute — graba en DB de paso (idempotente, replazará en cron 00:05)
    const snap = await runDailySnapshot(todayEt);
    res.json({ live: true, snapshot: snap });
  } catch (err) {
    logger.error(`[demeter route] today: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /summary?days=7
router.get('/summary', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    const snaps = await DemeterSnapshot.find({})
      .sort({ date_et: -1 })
      .limit(days)
      .lean();

    if (snaps.length === 0) {
      return res.json({ count: 0, days_requested: days, summary: null });
    }

    const sum = (key) => snaps.reduce((a, s) => a + (s[key] || 0), 0);
    const avg = (key) => sum(key) / snaps.length;

    const totalSpend = sum('meta_spend');
    const totalNetAfterFees = sum('net_after_fees');
    const totalGross = sum('gross_sales');
    const totalRefunds = sum('refunds');
    const totalOrders = sum('orders_count');

    // Cash ROAS aggregate (no es promedio simple — es weighted)
    const aggCashRoas = totalSpend > 0 ? totalNetAfterFees / totalSpend : 0;
    const aggMetaRoas = totalSpend > 0 ? sum('meta_purchase_value') / totalSpend : 0;
    const aggGapPct = aggMetaRoas > 0 ? ((aggMetaRoas - aggCashRoas) / aggMetaRoas) * 100 : 0;

    res.json({
      count: snaps.length,
      days_requested: days,
      date_range: {
        from: snaps[snaps.length - 1].date_et,
        to: snaps[0].date_et
      },
      summary: {
        total_meta_spend: +totalSpend.toFixed(2),
        total_gross_sales: +totalGross.toFixed(2),
        total_net_after_fees: +totalNetAfterFees.toFixed(2),
        total_refunds: +totalRefunds.toFixed(2),
        total_orders: totalOrders,
        avg_cash_roas: +aggCashRoas.toFixed(3),
        avg_meta_roas: +aggMetaRoas.toFixed(3),
        avg_gap_pct: +aggGapPct.toFixed(1),
        avg_order_value: totalOrders > 0 ? +(totalGross / totalOrders).toFixed(2) : 0,
        net_profit: +(totalNetAfterFees - totalSpend).toFixed(2)
      }
    });
  } catch (err) {
    logger.error(`[demeter route] summary: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /run-now — manual trigger (corre días=opcional, default 7)
router.post('/run-now', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days || '7', 10), 30);
    const { backfillSnapshots } = require('../../ai/agent/demeter-agent');
    const t0 = Date.now();
    const results = await backfillSnapshots(days);
    res.json({
      ok: true,
      elapsed_ms: Date.now() - t0,
      results
    });
  } catch (err) {
    logger.error(`[demeter route] run-now: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
