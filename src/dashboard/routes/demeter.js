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

// GET /summary?days=7  o  /summary?range=mtd (month-to-date en ET)
router.get('/summary', async (req, res) => {
  try {
    const range = req.query.range;
    let snaps;
    let daysRequested;

    if (range === 'mtd') {
      const { _helpers } = require('../../ai/agent/demeter-agent');
      const todayEt = _helpers.todayInET();           // YYYY-MM-DD
      const monthPrefix = todayEt.substring(0, 7);    // YYYY-MM
      snaps = await DemeterSnapshot.find({ date_et: { $regex: `^${monthPrefix}` } })
        .sort({ date_et: -1 })
        .lean();
      daysRequested = snaps.length;
    } else {
      const days = Math.min(parseInt(req.query.days || '7', 10), 90);
      snaps = await DemeterSnapshot.find({})
        .sort({ date_et: -1 })
        .limit(days)
        .lean();
      daysRequested = days;
    }

    if (snaps.length === 0) {
      return res.json({ count: 0, days_requested: daysRequested, summary: null });
    }

    const sum = (key) => snaps.reduce((a, s) => a + (s[key] || 0), 0);
    const avg = (key) => sum(key) / snaps.length;

    const totalSpend = sum('meta_spend');
    const totalGross = sum('gross_sales');                // productos
    const totalShipping = sum('shipping');                // cobrado
    const totalTaxes = sum('taxes');                      // recolectado para gob.
    const totalSales = sum('total_sales');                // matchea Shopify UI
    const totalDiscounts = sum('discounts');
    const totalRefunds = sum('refunds');
    const totalFees = sum('shopify_fees_est');
    const totalCashToBank = sum('cash_to_bank');
    const totalNetForMerchant = sum('net_for_merchant');
    const totalNetAfterFees = sum('net_after_fees');      // legacy
    const totalOrders = sum('orders_count');

    // Cash ROAS aggregate (weighted) — usa net_for_merchant ahora
    const aggCashRoas = totalSpend > 0 ? totalNetForMerchant / totalSpend : 0;
    const aggMetaRoas = totalSpend > 0 ? sum('meta_purchase_value') / totalSpend : 0;
    const aggGapPct = aggMetaRoas > 0 ? ((aggMetaRoas - aggCashRoas) / aggMetaRoas) * 100 : 0;

    res.json({
      count: snaps.length,
      days_requested: daysRequested,
      mode: range === 'mtd' ? 'mtd' : 'rolling',
      date_range: {
        from: snaps[snaps.length - 1].date_et,
        to: snaps[0].date_et
      },
      summary: {
        total_meta_spend: +totalSpend.toFixed(2),
        // Shopify breakdown (claro):
        total_gross_sales: +totalGross.toFixed(2),         // productos
        total_shipping: +totalShipping.toFixed(2),
        total_taxes: +totalTaxes.toFixed(2),
        total_discounts: +totalDiscounts.toFixed(2),
        total_refunds: +totalRefunds.toFixed(2),
        total_fees: +totalFees.toFixed(2),
        total_sales: +totalSales.toFixed(2),               // matchea Shopify UI
        // Cash flow:
        total_cash_to_bank: +totalCashToBank.toFixed(2),   // entró al banco
        total_net_for_merchant: +totalNetForMerchant.toFixed(2),  // tuyo de verdad
        total_net_after_fees: +totalNetAfterFees.toFixed(2), // legacy compat
        total_orders: totalOrders,
        avg_cash_roas: +aggCashRoas.toFixed(3),
        avg_meta_roas: +aggMetaRoas.toFixed(3),
        avg_gap_pct: +aggGapPct.toFixed(1),
        avg_order_value: totalOrders > 0 ? +(totalSales / totalOrders).toFixed(2) : 0,
        net_profit: +(totalNetForMerchant - totalSpend).toFixed(2)
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

    // Aggregar MTD — usamos net_for_merchant (post-tax) como métrica primaria
    const sum = (arr, k) => arr.reduce((a, s) => a + (s[k] || 0), 0);
    const mtd = {
      days_with_data: mtdSnaps.length,
      meta_spend: +sum(mtdSnaps, 'meta_spend').toFixed(2),
      meta_purchase_value: +sum(mtdSnaps, 'meta_purchase_value').toFixed(2),
      gross_sales: +sum(mtdSnaps, 'gross_sales').toFixed(2),
      total_sales: +sum(mtdSnaps, 'total_sales').toFixed(2),
      cash_to_bank: +sum(mtdSnaps, 'cash_to_bank').toFixed(2),
      net_for_merchant: +sum(mtdSnaps, 'net_for_merchant').toFixed(2),
      net_after_fees: +sum(mtdSnaps, 'net_after_fees').toFixed(2), // legacy
      orders: sum(mtdSnaps, 'orders_count'),
      refunds: +sum(mtdSnaps, 'refunds').toFixed(2)
    };
    mtd.cash_roas = mtd.meta_spend > 0 ? +(mtd.net_for_merchant / mtd.meta_spend).toFixed(3) : 0;
    mtd.profit = +(mtd.net_for_merchant - mtd.meta_spend).toFixed(2);

    // Run-rate: últimos 7 días con data (ventana móvil)
    const last7 = mtdSnaps.slice(-7);
    let runRate = null;
    let confidence = 'low';
    let projection = null;

    if (last7.length > 0 && monthStatus === 'in_progress') {
      const rr = {
        days: last7.length,
        avg_meta_spend: sum(last7, 'meta_spend') / last7.length,
        avg_meta_purchase_value: sum(last7, 'meta_purchase_value') / last7.length,
        avg_gross_sales: sum(last7, 'gross_sales') / last7.length,
        avg_total_sales: sum(last7, 'total_sales') / last7.length,
        avg_net_for_merchant: sum(last7, 'net_for_merchant') / last7.length,
        avg_cash_to_bank: sum(last7, 'cash_to_bank') / last7.length,
        avg_net_after_fees: sum(last7, 'net_after_fees') / last7.length, // legacy
        avg_orders: sum(last7, 'orders_count') / last7.length,
        avg_cash_roas: 0
      };
      rr.avg_cash_roas = rr.avg_meta_spend > 0
        ? +(rr.avg_net_for_merchant / rr.avg_meta_spend).toFixed(3) : 0;
      runRate = rr;

      // Confidence basado en variabilidad del cash_roas
      const roasValues = last7.map(s => s.cash_roas || 0).filter(v => v > 0);
      if (roasValues.length >= 4) {
        const mean = roasValues.reduce((a, v) => a + v, 0) / roasValues.length;
        const variance = roasValues.reduce((a, v) => a + (v - mean) ** 2, 0) / roasValues.length;
        const stdDev = Math.sqrt(variance);
        const cv = mean > 0 ? stdDev / mean : 1;
        if (last7.length >= 7 && cv < 0.30) confidence = 'high';
        else if (last7.length >= 4 && cv < 0.50) confidence = 'medium';
        else confidence = 'low';
      }

      // Projection días restantes (usa net_for_merchant)
      const daysRemaining = lastDayOfMonth - mtd.days_with_data;
      const projSpend = +(mtd.meta_spend + rr.avg_meta_spend * daysRemaining).toFixed(2);
      const projNetForMerchant = +(mtd.net_for_merchant + rr.avg_net_for_merchant * daysRemaining).toFixed(2);
      const projCashToBank = +(mtd.cash_to_bank + rr.avg_cash_to_bank * daysRemaining).toFixed(2);
      const projTotalSales = +(mtd.total_sales + rr.avg_total_sales * daysRemaining).toFixed(2);
      const projOrders = Math.round(mtd.orders + rr.avg_orders * daysRemaining);
      const projGross = +(mtd.gross_sales + rr.avg_gross_sales * daysRemaining).toFixed(2);

      projection = {
        days_remaining: daysRemaining,
        projected_meta_spend: projSpend,
        projected_gross_sales: projGross,
        projected_total_sales: projTotalSales,
        projected_cash_to_bank: projCashToBank,
        projected_net_for_merchant: projNetForMerchant,
        projected_net_after_fees: projNetForMerchant, // alias para compat con UI vieja
        projected_orders: projOrders,
        projected_cash_roas: projSpend > 0 ? +(projNetForMerchant / projSpend).toFixed(3) : 0,
        projected_profit: +(projNetForMerchant - projSpend).toFixed(2)
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

// GET /shadow-comparison?days=14
//
// Lee acciones de ares_brain con shadow_cash_consideration en metadata.
// Cruza con su outcome (ActionLog.metrics_after_3d / 7d) si está medido.
// Retorna comparativa decisión-real vs decisión-cash-aware + outcomes.
router.get('/shadow-comparison', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '14', 10), 60);
    const since = new Date(Date.now() - days * 86400000);

    const ActionLog = require('../../db/models/ActionLog');
    const actions = await ActionLog.find({
      agent_type: 'ares_brain',
      success: true,
      executed_at: { $gte: since },
      'metadata.shadow_cash_consideration': { $exists: true }
    }).sort({ executed_at: -1 }).limit(100).lean();

    // Computar deltas ROAS si hay measurement
    function delta(before, after) {
      if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return null;
      return +(((after - before) / before) * 100).toFixed(1);
    }

    const items = actions.map(a => {
      const shadow = a.metadata?.shadow_cash_consideration || {};
      const before = a.metrics_at_execution || {};
      const after3d = a.metrics_after_3d;
      const after7d = a.metrics_after_7d;
      return {
        action_id: a._id,
        executed_at: a.executed_at,
        action: a.action,
        entity_name: a.entity_name,
        before_value: a.before_value,
        after_value: a.after_value,
        reasoning: (a.reasoning || '').substring(0, 200),
        shadow: {
          cash_roas_at_decision: shadow.cash_roas_at_decision,
          zone_at_decision: shadow.zone_at_decision,
          trend_at_decision: shadow.trend_at_decision,
          alt_decision: shadow.alt_decision || 'same',
          reasoning_diff: shadow.reasoning_diff
        },
        outcome: {
          measured_3d: a.impact_measured,
          measured_7d: a.impact_7d_measured,
          roas_delta_3d_pct: delta(before.roas_7d, after3d?.roas_7d),
          roas_delta_7d_pct: delta(before.roas_7d, after7d?.roas_7d)
        }
      };
    });

    // Agregados para análisis rápido
    const aggregates = {
      total: items.length,
      by_alt: items.reduce((acc, i) => {
        const k = i.shadow.alt_decision || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      by_zone: items.reduce((acc, i) => {
        const k = i.shadow.zone_at_decision || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {})
    };

    // Veredicto retrospectivo: para acciones con alt_decision !== 'same' Y
    // outcome medido, ¿el outcome real fue bueno o malo?
    const disagreements = items.filter(i =>
      i.shadow.alt_decision && i.shadow.alt_decision !== 'same' &&
      (i.outcome.measured_3d || i.outcome.measured_7d)
    );
    const verdictBuckets = { cash_was_right: 0, cash_was_wrong: 0, ambiguous: 0 };
    disagreements.forEach(d => {
      const delta = d.outcome.roas_delta_7d_pct ?? d.outcome.roas_delta_3d_pct;
      if (delta == null) { verdictBuckets.ambiguous++; return; }
      // Si cash sugería holdear/less_aggressive y outcome real fue malo (delta <0) → cash had a point
      // Si cash sugería holdear/less_aggressive y outcome real fue bueno → Meta tenía razón, cash too conservative
      const cashWasMoreCautious = ['hold', 'less_aggressive'].includes(d.shadow.alt_decision);
      if (cashWasMoreCautious) {
        if (delta < -5) verdictBuckets.cash_was_right++;
        else if (delta > 5) verdictBuckets.cash_was_wrong++;
        else verdictBuckets.ambiguous++;
      } else {
        // more_aggressive: cash queria más fuerte. Si outcome bueno, cash had a point.
        if (delta > 5) verdictBuckets.cash_was_right++;
        else if (delta < -5) verdictBuckets.cash_was_wrong++;
        else verdictBuckets.ambiguous++;
      }
    });

    res.json({
      days_window: days,
      aggregates,
      verdict: {
        disagreements_total: disagreements.length,
        ...verdictBuckets,
        explanation: 'cash_was_right = decisión cash-aware coincide con outcome real (cash hubiera prevenido pérdida o capturado upside)'
      },
      items
    });
  } catch (err) {
    logger.error(`[demeter route] shadow-comparison: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /shadow-backfill?days=7
//
// Re-evalúa retrospectivamente acciones de ares_brain SIN shadow data.
// Para cada acción:
//   1. Calcula el cash_signal que existía el día de la acción (o más reciente)
//   2. Pide a Opus que considere: "tuviste esta acción real, cash signal era X.
//      ¿Hubieras cambiado tu decisión?"
//   3. Persiste shadow_cash_consideration en ActionLog.metadata
//
// Útil para inicializar el tab Shadow con data sin esperar ciclos nuevos.
// Costo: ~$0.10 por acción (Opus tokens). Limit max 20 acciones por call.
router.post('/shadow-backfill', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days || req.query?.days || '14', 10), 30);
    const ActionLog = require('../../db/models/ActionLog');
    const since = new Date(Date.now() - days * 86400000);

    // Acciones del brain SIN shadow_cash_consideration (no re-procesar)
    const actions = await ActionLog.find({
      agent_type: 'ares_brain',
      success: true,
      executed_at: { $gte: since },
      'metadata.shadow_cash_consideration': { $exists: false }
    }).sort({ executed_at: -1 }).limit(20).lean();

    if (actions.length === 0) {
      return res.json({ ok: true, processed: 0, message: 'no hay acciones sin shadow para backfill' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('../../../config');
    const claude = new Anthropic({ apiKey: config.claude.apiKey });

    const results = [];

    for (const action of actions) {
      try {
        // Cash signal del día de la acción (o más reciente disponible)
        const actionDate = new Date(action.executed_at);
        actionDate.setUTCHours(0, 0, 0, 0);
        const dateEt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York'
        }).format(actionDate);

        // 7d previos al día de la acción para cash_roas_7d retrospectivo
        const since14 = new Date(actionDate.getTime() - 14 * 86400000);
        const sinceStr = since14.toISOString().slice(0, 10);
        const snaps = await DemeterSnapshot.find({
          date_et: { $gte: sinceStr, $lte: dateEt }
        }).sort({ date_et: -1 }).lean();

        if (snaps.length < 4) {
          results.push({ action_id: action._id, skipped: 'datos demeter insuficientes' });
          continue;
        }

        const sum = (arr, k) => arr.reduce((a, s) => a + (s[k] || 0), 0);
        const last7 = snaps.slice(0, 7);
        const prev7 = snaps.slice(7, 14);
        const cashRoas7d = sum(last7, 'meta_spend') > 0
          ? sum(last7, 'net_for_merchant') / sum(last7, 'meta_spend') : 0;
        const metaRoas7d = sum(last7, 'meta_spend') > 0
          ? sum(last7, 'meta_purchase_value') / sum(last7, 'meta_spend') : 0;
        const cashPrev = prev7.length >= 4 && sum(prev7, 'meta_spend') > 0
          ? sum(prev7, 'net_for_merchant') / sum(prev7, 'meta_spend') : null;
        const trend = cashPrev != null
          ? (cashRoas7d - cashPrev > 0.15 ? 'mejorando'
            : cashRoas7d - cashPrev < -0.15 ? 'empeorando' : 'estable')
          : 'estable';
        let zone, zoneHint;
        if (cashRoas7d >= 3.0) { zone = 'green'; zoneHint = 'cash sano'; }
        else if (cashRoas7d >= 2.0) { zone = 'yellow'; zoneHint = 'cash aceptable'; }
        else if (cashRoas7d >= 1.5) { zone = 'orange'; zoneHint = 'cash bajo'; }
        else { zone = 'red'; zoneHint = 'cash crítico'; }

        // Pedir a Opus que razone retrospective
        const prompt = `Sos Ares Brain — agente Portfolio Manager. Hiciste esta acción REAL en el pasado:

ACCIÓN EJECUTADA:
- Tipo: ${action.action}
- Entity: ${action.entity_name}
- Cambio: ${action.before_value} → ${action.after_value}
- Reasoning original: "${(action.reasoning || '').substring(0, 500)}"
- Fecha: ${action.executed_at}

EN ESE MOMENTO el cash ROAS account-level (Demeter) reportaba:
- cash_roas_7d: ${cashRoas7d.toFixed(2)}x
- meta_roas_7d: ${metaRoas7d.toFixed(2)}x
- gap pct: ${metaRoas7d > 0 ? (((metaRoas7d - cashRoas7d) / metaRoas7d) * 100).toFixed(1) : 0}%
- zona: ${zone} (${zoneHint})
- trend vs 7d previos: ${trend}${cashPrev != null ? ` (era ${cashPrev.toFixed(2)}x)` : ''}

PREGUNTA: si hubieras tenido esta info del cash ROAS al momento de decidir, ¿habrías hecho la misma acción? Considerá que vos decidiste con Meta ROAS por CBO (que típicamente es más alto que cash ROAS por atribución).

Responde SOLO con JSON válido:
{
  "alt_decision": "same" | "hold" | "less_aggressive" | "more_aggressive",
  "reasoning_diff": "1-2 oraciones explicando POR QUÉ cambiarías o no"
}

No agregues nada antes ni después del JSON.`;

        const response = await claude.messages.create({
          model: 'claude-opus-4-7',
          max_tokens: 500,
          system: 'Sos Ares Brain re-evaluando una decisión histórica con cash ROAS awareness. Responde SOLO con JSON válido.',
          messages: [{ role: 'user', content: prompt }]
        });

        const txt = response.content?.[0]?.text || '';
        const jsonMatch = txt.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          results.push({ action_id: action._id, skipped: 'opus no devolvió JSON' });
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          results.push({ action_id: action._id, skipped: 'JSON parse error' });
          continue;
        }

        const validAlts = ['same', 'hold', 'less_aggressive', 'more_aggressive'];
        if (!validAlts.includes(parsed.alt_decision)) {
          results.push({ action_id: action._id, skipped: `alt_decision inválido: ${parsed.alt_decision}` });
          continue;
        }

        // Persistir
        const shadowConsideration = {
          cash_roas_at_decision: +cashRoas7d.toFixed(3),
          zone_at_decision: zone,
          trend_at_decision: trend,
          alt_decision: parsed.alt_decision,
          reasoning_diff: (parsed.reasoning_diff || '').substring(0, 500),
          recorded_at: new Date(),
          backfilled: true  // marca para distinguir de shadow real-time
        };

        // Bug Mongoose: $set sobre dot path en Mixed field a veces no persiste.
        // Workaround: load doc, mutate, markModified, save.
        const doc = await ActionLog.findById(action._id);
        if (!doc) {
          results.push({ action_id: action._id, skipped: 'doc no encontrado' });
          continue;
        }
        if (!doc.metadata) doc.metadata = {};
        doc.metadata.shadow_cash_consideration = shadowConsideration;
        doc.markModified('metadata');
        await doc.save();

        results.push({
          action_id: action._id,
          action: action.action,
          entity: action.entity_name,
          alt_decision: parsed.alt_decision,
          cash_roas: +cashRoas7d.toFixed(2),
          zone
        });
      } catch (err) {
        logger.error(`[demeter shadow-backfill] ${action._id}: ${err.message}`);
        results.push({ action_id: action._id, skipped: err.message });
      }
    }

    const processed = results.filter(r => r.alt_decision).length;
    res.json({
      ok: true,
      total_candidates: actions.length,
      processed,
      results
    });
  } catch (err) {
    logger.error(`[demeter route] shadow-backfill: ${err.message}`);
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
