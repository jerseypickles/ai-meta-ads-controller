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

// GET /forecast?month=YYYY-MM (default mes en curso ET)
//
// Lógica:
//   - Determina rango del mes (1 al último día) en ET
//   - Lee snapshots month-to-date (MTD) que tenemos hasta hoy
//   - Calcula run-rate de últimos 7 días con data (ventana móvil)
//   - Proyecta días restantes del mes con ese run-rate
//   - Total cierre = MTD acumulado + (run_rate × días_restantes)
//
// Confidence:
//   - high: ≥7 días con data en MTD, std deviation cash_roas <30%
//   - medium: ≥4 días o std 30-50%
//   - low: <4 días o std >50% (run-rate muy volátil → forecast poco fiable)
router.get('/forecast', async (req, res) => {
  try {
    // Determinar mes target (default: mes en curso ET)
    let targetMonth = req.query.month;
    if (!targetMonth) {
      const todayEt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      targetMonth = todayEt.slice(0, 7); // YYYY-MM
    }
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      return res.status(400).json({ error: 'month inválido (formato YYYY-MM)' });
    }

    const [year, month] = targetMonth.split('-').map(Number);
    const lastDayOfMonth = new Date(year, month, 0).getDate(); // 0 = último día del mes
    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-${String(lastDayOfMonth).padStart(2, '0')}`;

    // Hoy en ET
    const todayEt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    // ¿El mes ya cerró, en curso, o futuro?
    let monthStatus, mtdEndDate;
    if (todayEt > monthEnd) {
      monthStatus = 'closed';
      mtdEndDate = monthEnd;
    } else if (todayEt < monthStart) {
      monthStatus = 'future';
      mtdEndDate = null;
    } else {
      monthStatus = 'in_progress';
      mtdEndDate = todayEt;
    }

    // Leer snapshots del mes hasta mtdEndDate
    let mtdSnaps = [];
    if (mtdEndDate) {
      mtdSnaps = await DemeterSnapshot.find({
        date_et: { $gte: monthStart, $lte: mtdEndDate }
      }).sort({ date_et: 1 }).lean();
    }

    // Aggregar MTD
    const sum = (arr, k) => arr.reduce((a, s) => a + (s[k] || 0), 0);
    const mtd = {
      days_with_data: mtdSnaps.length,
      meta_spend: +sum(mtdSnaps, 'meta_spend').toFixed(2),
      meta_purchase_value: +sum(mtdSnaps, 'meta_purchase_value').toFixed(2),
      gross_sales: +sum(mtdSnaps, 'gross_sales').toFixed(2),
      net_after_fees: +sum(mtdSnaps, 'net_after_fees').toFixed(2),
      orders: sum(mtdSnaps, 'orders_count'),
      refunds: +sum(mtdSnaps, 'refunds').toFixed(2)
    };
    mtd.cash_roas = mtd.meta_spend > 0 ? +(mtd.net_after_fees / mtd.meta_spend).toFixed(3) : 0;
    mtd.profit = +(mtd.net_after_fees - mtd.meta_spend).toFixed(2);

    // Run-rate: últimos 7 días con data (ventana móvil)
    const last7 = mtdSnaps.slice(-7);
    let runRate = null;
    let confidence = 'low';
    let projection = null;

    if (last7.length > 0 && monthStatus === 'in_progress') {
      const rr = {
        days: last7.length,
        avg_meta_spend: +sum(last7, 'meta_spend').toFixed(2) / last7.length,
        avg_meta_purchase_value: +sum(last7, 'meta_purchase_value').toFixed(2) / last7.length,
        avg_gross_sales: +sum(last7, 'gross_sales').toFixed(2) / last7.length,
        avg_net_after_fees: +sum(last7, 'net_after_fees').toFixed(2) / last7.length,
        avg_orders: sum(last7, 'orders_count') / last7.length,
        avg_cash_roas: 0
      };
      rr.avg_cash_roas = rr.avg_meta_spend > 0
        ? +(rr.avg_net_after_fees / rr.avg_meta_spend).toFixed(3) : 0;
      runRate = rr;

      // Confidence basado en variabilidad del cash_roas
      const roasValues = last7.map(s => s.cash_roas || 0).filter(v => v > 0);
      if (roasValues.length >= 4) {
        const mean = roasValues.reduce((a, v) => a + v, 0) / roasValues.length;
        const variance = roasValues.reduce((a, v) => a + (v - mean) ** 2, 0) / roasValues.length;
        const stdDev = Math.sqrt(variance);
        const cv = mean > 0 ? stdDev / mean : 1; // coefficient of variation
        if (last7.length >= 7 && cv < 0.30) confidence = 'high';
        else if (last7.length >= 4 && cv < 0.50) confidence = 'medium';
        else confidence = 'low';
      }

      // Projection días restantes
      const daysRemaining = lastDayOfMonth - mtd.days_with_data;
      const projSpend = +(mtd.meta_spend + rr.avg_meta_spend * daysRemaining).toFixed(2);
      const projNet = +(mtd.net_after_fees + rr.avg_net_after_fees * daysRemaining).toFixed(2);
      const projOrders = Math.round(mtd.orders + rr.avg_orders * daysRemaining);
      const projGross = +(mtd.gross_sales + rr.avg_gross_sales * daysRemaining).toFixed(2);

      projection = {
        days_remaining: daysRemaining,
        projected_meta_spend: projSpend,
        projected_gross_sales: projGross,
        projected_net_after_fees: projNet,
        projected_orders: projOrders,
        projected_cash_roas: projSpend > 0 ? +(projNet / projSpend).toFixed(3) : 0,
        projected_profit: +(projNet - projSpend).toFixed(2)
      };
    }

    res.json({
      target_month: targetMonth,
      month_label: new Date(year, month - 1, 1).toLocaleString('es-AR', { month: 'long', year: 'numeric' }),
      month_status: monthStatus,
      month_total_days: lastDayOfMonth,
      mtd_through: mtdEndDate,
      mtd,
      run_rate: runRate,
      projection,
      confidence
    });
  } catch (err) {
    logger.error(`[demeter route] forecast: ${err.message}`);
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
