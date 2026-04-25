/**
 * Demeter Agent — Cash Reconciliation.
 *
 * Computa DemeterSnapshot diarios reconciliando Meta spend vs Shopify revenue.
 * Idempotente — se puede correr múltiples veces sobre la misma fecha y
 * siempre regenera (delete + insert).
 *
 * Por qué importa: el ROAS que reporta Meta puede ser muy distinto del cash
 * real. View-through attribution, last-click overlap entre canales, refunds
 * que no llegan a Meta, fees de Shopify — todo eso crea gap. Demeter mide
 * ese gap explícitamente para que las decisiones futuras de Athena/Ares
 * tengan base en cash, no en attribution.
 *
 * Hoy fase 1 — solo lectura/reportería. No emite directives ni ejecuta
 * acciones. Eso queda para fase 2 cuando tengamos 3-4 semanas de baseline.
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const DemeterSnapshot = require('../../db/models/DemeterSnapshot');
const shopify = require('../../integrations/shopify-client');

/**
 * Helper: convierte una fecha YYYY-MM-DD (ET) a un rango UTC [start, end).
 *
 * ET es America/New_York: UTC-5 (EST) o UTC-4 (EDT). Hardcodear el offset
 * sería bug en transición DST. Usamos formateo Intl con timeZone para
 * obtener el offset correcto del día.
 */
function dateRangeET(dateEt) {
  // dateEt es 'YYYY-MM-DD'. Construyo 00:00 ET de ese día.
  // Truco: format con timeZone:'America/New_York' un Date que represente
  //   esa fecha en UTC, comparar offset, ajustar.
  // Más simple: usar Date.UTC y restar el offset que tenga ese día.
  const [year, month, day] = dateEt.split('-').map(Number);

  // Construir un Date a las 12:00 UTC del día (mediodía — evita edge cases DST)
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Obtener qué hora es en ET en ese momento — diff con UTC = offset en horas
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(noonUtc);
  const etHour = Number(parts.find(p => p.type === 'hour').value);
  const offsetHours = 12 - etHour;  // DST: 4 (EDT) o 5 (EST)

  // 00:00 ET = offsetHours horas en UTC
  const startUtc = new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0, 0));
  const endUtc = new Date(startUtc.getTime() + 24 * 3600000);
  return { startUtc, endUtc };
}

/**
 * Hoy en ET como YYYY-MM-DD.
 */
function todayInET() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date()); // en-CA = YYYY-MM-DD
}

/**
 * N días atrás en ET (incluye hoy si N=0).
 */
function daysAgoEt(n) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date(Date.now() - n * 86400000));
}

/**
 * Sumariza orders + refunds en agregados para el snapshot.
 */
function aggregateShopify(orders, refunds) {
  let gross = 0, discounts = 0, refundTotal = 0, netSales = 0;

  for (const o of orders) {
    // total_price: gross después de descuentos pero antes de refunds
    // subtotal_price: gross antes de descuentos, antes de tax y shipping
    // current_total_price: total_price - refunds aplicados a esta order
    gross += parseFloat(o.subtotal_price || 0);
    discounts += parseFloat(o.total_discounts || 0);
  }

  for (const r of refunds) {
    refundTotal += parseFloat(r.amount || 0);
  }

  netSales = gross - discounts - refundTotal;

  return {
    gross_sales: +gross.toFixed(2),
    discounts: +discounts.toFixed(2),
    refunds: +refundTotal.toFixed(2),
    net_sales: +netSales.toFixed(2),
    orders_count: orders.length,
    refunds_count: refunds.length
  };
}

/**
 * Computa Shopify fees estimados (Shopify Payments US standard).
 * Fórmula: gross_sales * feePercent + orders_count * feeFlat
 */
function estimateShopifyFees(grossSales, ordersCount) {
  return +(grossSales * config.shopify.feePercent + ordersCount * config.shopify.feeFlat).toFixed(2);
}

/**
 * Pull Meta spend + purchase_value para un date range específico.
 * Usamos getAccountInsights con level='account' para totales del account.
 */
async function fetchMetaTotals(startUtc, endUtc) {
  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // Meta espera since/until en YYYY-MM-DD. Convertimos rango UTC a fechas
    // calendario UTC (no ET — Meta interpreta el time_range en account TZ pero
    // pasamos el rango ET como bounds). Más limpio: dejar a Meta interpretar.
    const sinceDate = startUtc.toISOString().slice(0, 10);
    const untilDate = new Date(endUtc.getTime() - 1).toISOString().slice(0, 10);

    const insights = await meta.getAccountInsights('account', {
      since: sinceDate,
      until: untilDate
    });

    if (!insights || insights.length === 0) {
      return { spend: 0, purchase_value: 0 };
    }

    const row = insights[0]; // level=account devuelve 1 row
    const spend = parseFloat(row.spend || 0);

    // purchase_value viene en action_values con type=purchase u omni_purchase
    let purchase_value = 0;
    if (Array.isArray(row.action_values)) {
      for (const av of row.action_values) {
        if (av.action_type === 'purchase' || av.action_type === 'omni_purchase') {
          purchase_value = Math.max(purchase_value, parseFloat(av.value || 0));
        }
      }
    }

    return { spend, purchase_value };
  } catch (err) {
    logger.error(`[demeter] Meta insights falló: ${err.message}`);
    return { spend: 0, purchase_value: 0, error: err.message };
  }
}

/**
 * Computa snapshot completo para un día (ET). Idempotente — si ya existe
 * uno para ese date_et, lo reemplaza.
 */
async function runDailySnapshot(dateEt) {
  const t0 = Date.now();
  const { startUtc, endUtc } = dateRangeET(dateEt);

  logger.info(`[demeter] computando snapshot ${dateEt} (${startUtc.toISOString()} → ${endUtc.toISOString()})`);

  // ─── Pull en paralelo: Meta + Shopify ────────────────────────────────
  let metaTotals, orders, refunds;
  let computationError = null;

  try {
    [metaTotals, orders, refunds] = await Promise.all([
      fetchMetaTotals(startUtc, endUtc),
      shopify.getOrdersForDateRange(startUtc, endUtc),
      shopify.getRefundsForDateRange(startUtc, endUtc, 60)
    ]);
  } catch (err) {
    computationError = err.message;
    logger.error(`[demeter] Pull falló para ${dateEt}: ${err.message}`);
    metaTotals = { spend: 0, purchase_value: 0 };
    orders = [];
    refunds = [];
  }

  // ─── Aggregate ───────────────────────────────────────────────────────
  const sh = aggregateShopify(orders, refunds);
  const shopifyFees = estimateShopifyFees(sh.gross_sales, sh.orders_count);
  const netAfterFees = +(sh.net_sales - shopifyFees).toFixed(2);

  // ROAS — protegidos contra division by zero
  const metaRoas = metaTotals.spend > 0
    ? +(metaTotals.purchase_value / metaTotals.spend).toFixed(3)
    : 0;
  const cashRoas = metaTotals.spend > 0
    ? +(netAfterFees / metaTotals.spend).toFixed(3)
    : 0;
  const gapPct = metaRoas > 0
    ? +(((metaRoas - cashRoas) / metaRoas) * 100).toFixed(1)
    : 0;

  // ─── Upsert (idempotente) ────────────────────────────────────────────
  const elapsed = Date.now() - t0;
  const doc = {
    date_et: dateEt,
    range_start_utc: startUtc,
    range_end_utc: endUtc,
    meta_spend: +metaTotals.spend.toFixed(2),
    meta_purchase_value: +metaTotals.purchase_value.toFixed(2),
    meta_roas: metaRoas,
    gross_sales: sh.gross_sales,
    discounts: sh.discounts,
    refunds: sh.refunds,
    net_sales: sh.net_sales,
    shopify_fees_est: shopifyFees,
    net_after_fees: netAfterFees,
    orders_count: sh.orders_count,
    cash_roas: cashRoas,
    gap_pct: gapPct,
    computed_at: new Date(),
    computation_ms: elapsed,
    shopify_orders_fetched: sh.orders_count,
    shopify_refunds_fetched: sh.refunds_count,
    computation_error: computationError
  };

  await DemeterSnapshot.findOneAndUpdate(
    { date_et: dateEt },
    { $set: doc },
    { upsert: true, new: true }
  );

  logger.info(
    `[demeter] ${dateEt} ✓ Meta=$${doc.meta_spend} (ROAS ${metaRoas}x) | ` +
    `Shopify net=$${netAfterFees} (${sh.orders_count} orders, $${sh.refunds} refunds) | ` +
    `cash ROAS ${cashRoas}x | gap ${gapPct}% | ${elapsed}ms`
  );

  return doc;
}

/**
 * Backfill — corre snapshots para los últimos N días.
 *
 * OPTIMIZADO 2026-04-25: en vez de N llamadas a Shopify (una por día),
 * hace 1 sola fetch del rango master (N + 60d lookback de refunds) y
 * filtra in-memory por día. Reduce calls de O(N²) a O(N).
 *
 * Backfill 60d antes: 60 × 60d lookback = 3,600 días de orders pulled
 *                     ~430 API calls × 0.5s = 3.5 min solo Shopify
 * Backfill 60d ahora: 1 master pull (120d) + 60 calls Meta API daily
 *                     ~24 API calls Shopify + 60 Meta = ~70s total
 */
async function backfillSnapshots(days = 7) {
  const t0 = Date.now();
  logger.info(`[demeter] backfill start: ${days} días`);

  // Paso 1: 1 sola pull master de Shopify orders cubriendo TODO el rango
  // del backfill + 60d de lookback para refunds retroactivos.
  const oldestDate = daysAgoEt(days - 1);
  const newestDate = daysAgoEt(0);
  const { startUtc: backfillStart } = dateRangeET(oldestDate);
  const { endUtc: backfillEnd } = dateRangeET(newestDate);
  const masterStart = new Date(backfillStart.getTime() - 60 * 86400000);

  let masterOrders = [];
  try {
    logger.info(`[demeter] master pull Shopify: ${masterStart.toISOString()} → ${backfillEnd.toISOString()}`);
    masterOrders = await shopify.getOrdersForDateRange(masterStart, backfillEnd);
    logger.info(`[demeter] master pull OK: ${masterOrders.length} orders fetched`);
  } catch (err) {
    logger.error(`[demeter] master pull falló: ${err.message}`);
    return [{ date_et: 'master', ok: false, error: err.message }];
  }

  // Paso 2: para cada día, filtrar in-memory + 1 call Meta API
  const results = [];
  for (let i = 0; i < days; i++) {
    const dateEt = daysAgoEt(i);
    try {
      const snap = await runDailySnapshotFromMaster(dateEt, masterOrders);
      results.push({ date_et: dateEt, ok: true, cash_roas: snap.cash_roas });
    } catch (err) {
      logger.error(`[demeter] backfill ${dateEt} falló: ${err.message}`);
      results.push({ date_et: dateEt, ok: false, error: err.message });
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const ok = results.filter(r => r.ok).length;
  logger.info(`[demeter] backfill done: ${ok}/${days} days · ${elapsed}s`);
  return results;
}

/**
 * Variante de runDailySnapshot que recibe orders pre-fetched (filter in-memory).
 * Solo llama Meta API per-day. Usado por backfillSnapshots optimizado.
 */
async function runDailySnapshotFromMaster(dateEt, masterOrders) {
  const t0 = Date.now();
  const { startUtc, endUtc } = dateRangeET(dateEt);

  // Filtrar orders del día (created_at en rango ET)
  const dayOrders = masterOrders.filter(o => {
    const t = new Date(o.created_at).getTime();
    return t >= startUtc.getTime() && t < endUtc.getTime();
  });

  // Filtrar refunds del día (processed_at en rango ET, viene de cualquier order
  // de los últimos 60d por eso necesitamos masterOrders con lookback)
  const dayRefunds = [];
  for (const o of masterOrders) {
    for (const r of (o.refunds || [])) {
      const processedAt = new Date(r.processed_at);
      if (processedAt >= startUtc && processedAt < endUtc) {
        const amount = (r.transactions || [])
          .filter(tx => tx.kind === 'refund' && tx.status === 'success')
          .reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
        dayRefunds.push({ order_id: o.id, processed_at: processedAt, amount });
      }
    }
  }

  // Meta totals (1 call per día — único API call que queda)
  let metaTotals;
  let computationError = null;
  try {
    metaTotals = await fetchMetaTotals(startUtc, endUtc);
  } catch (err) {
    metaTotals = { spend: 0, purchase_value: 0 };
    computationError = err.message;
  }

  // Aggregate + roas + upsert (igual que runDailySnapshot)
  const sh = aggregateShopify(dayOrders, dayRefunds);
  const shopifyFees = estimateShopifyFees(sh.gross_sales, sh.orders_count);
  const netAfterFees = +(sh.net_sales - shopifyFees).toFixed(2);

  const metaRoas = metaTotals.spend > 0
    ? +(metaTotals.purchase_value / metaTotals.spend).toFixed(3) : 0;
  const cashRoas = metaTotals.spend > 0
    ? +(netAfterFees / metaTotals.spend).toFixed(3) : 0;
  const gapPct = metaRoas > 0
    ? +(((metaRoas - cashRoas) / metaRoas) * 100).toFixed(1) : 0;

  const elapsed = Date.now() - t0;
  const doc = {
    date_et: dateEt,
    range_start_utc: startUtc,
    range_end_utc: endUtc,
    meta_spend: +metaTotals.spend.toFixed(2),
    meta_purchase_value: +metaTotals.purchase_value.toFixed(2),
    meta_roas: metaRoas,
    gross_sales: sh.gross_sales,
    discounts: sh.discounts,
    refunds: sh.refunds,
    net_sales: sh.net_sales,
    shopify_fees_est: shopifyFees,
    net_after_fees: netAfterFees,
    orders_count: sh.orders_count,
    cash_roas: cashRoas,
    gap_pct: gapPct,
    computed_at: new Date(),
    computation_ms: elapsed,
    shopify_orders_fetched: sh.orders_count,
    shopify_refunds_fetched: sh.refunds_count,
    computation_error: computationError
  };

  await DemeterSnapshot.findOneAndUpdate(
    { date_et: dateEt },
    { $set: doc },
    { upsert: true, new: true }
  );

  logger.info(
    `[demeter] ${dateEt} ✓ Meta=$${doc.meta_spend} (ROAS ${metaRoas}x) | ` +
    `Shopify net=$${netAfterFees} (${sh.orders_count} orders, $${sh.refunds} refunds) | ` +
    `cash ROAS ${cashRoas}x | gap ${gapPct}% | ${elapsed}ms`
  );

  return doc;
}

module.exports = {
  runDailySnapshot,
  backfillSnapshots,
  // exports para tests/debugging
  _helpers: { dateRangeET, todayInET, daysAgoEt, aggregateShopify, estimateShopifyFees }
};
