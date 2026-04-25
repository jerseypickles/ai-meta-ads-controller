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
 *
 * Refactor 2026-04-25 — separa explícitamente:
 *   gross_sales = subtotal_price          (productos sin tax/shipping)
 *   shipping    = total_shipping_price    (cobrado al cliente)
 *   taxes       = total_tax               (recolectado para gobierno)
 *   discounts   = total_discounts
 *   total_sales = subtotal + shipping + tax - discounts  ← Shopify "Total sales"
 *
 * Verificación: total_sales debe ser ≈ Σ(total_price) de las orders.
 * Si hay diferencia mínima, viene de tip, gift_cards, otros adjustments.
 */
function aggregateShopify(orders, refunds) {
  let subtotal = 0, discounts = 0, shipping = 0, taxes = 0, totalPrice = 0;
  let refundTotal = 0;

  for (const o of orders) {
    subtotal += parseFloat(o.subtotal_price || 0);
    discounts += parseFloat(o.total_discounts || 0);
    taxes += parseFloat(o.total_tax || 0);
    // total_shipping_price_set viene como objeto: { shop_money: { amount, currency } }
    const shipMoney = o.total_shipping_price_set?.shop_money?.amount;
    shipping += parseFloat(shipMoney || 0);
    // total_price: lo que cobró Shopify al cliente (= subtotal + shipping + tax − discounts)
    totalPrice += parseFloat(o.total_price || 0);
  }

  for (const r of refunds) {
    refundTotal += parseFloat(r.amount || 0);
  }

  // Total sales = matchea "Total sales" del dashboard de Shopify Analytics.
  // Lo computamos sumando total_price (más confiable) en vez de la fórmula
  // subtotal+shipping+tax-discounts (puede tener drift por tips/gift cards).
  const totalSales = totalPrice;
  const netSales = subtotal - discounts - refundTotal;  // legacy, productos puros

  return {
    gross_sales: +subtotal.toFixed(2),       // productos
    discounts: +discounts.toFixed(2),
    shipping: +shipping.toFixed(2),          // cobrado al cliente
    taxes: +taxes.toFixed(2),                // recolectado, va al gobierno
    total_sales: +totalSales.toFixed(2),     // matchea Shopify UI
    refunds: +refundTotal.toFixed(2),
    net_sales: +netSales.toFixed(2),         // legacy para compat
    orders_count: orders.length,
    refunds_count: refunds.length
  };
}

/**
 * Computa Shopify fees estimados (Shopify Payments US standard).
 * Fórmula: gross_sales * feePercent + orders_count * feeFlat
 *
 * Nota 2026-04-25: aplicado sobre total_sales (no subtotal) porque Shopify
 * cobra fees sobre el total de la transacción, incluyendo shipping y tax.
 */
function estimateShopifyFees(totalSales, ordersCount) {
  return +(totalSales * config.shopify.feePercent + ordersCount * config.shopify.feeFlat).toFixed(2);
}

/**
 * Construye el doc DemeterSnapshot a partir de los aggregates.
 * Helper único para no duplicar lógica entre runDailySnapshot y
 * runDailySnapshotFromMaster.
 *
 * Flujo de cash (2026-04-25 v2):
 *   total_sales       = Shopify "Total sales" (total_price agregado)
 *   cash_to_bank      = total_sales − refunds − shopify_fees_est
 *   net_for_merchant  = cash_to_bank − taxes − shipping
 *                       (descuenta shipping porque va al carrier, y tax
 *                        porque va al gobierno — no es del merchant)
 *   cash_roas         = net_for_merchant / meta_spend
 */
function buildSnapshotDoc({ dateEt, startUtc, endUtc, metaTotals, sh, computationError, elapsed }) {
  const shopifyFees = estimateShopifyFees(sh.total_sales, sh.orders_count);

  // Cash que entra al banco: total ventas − refunds − fees Shopify
  const cashToBank = +(sh.total_sales - sh.refunds - shopifyFees).toFixed(2);

  // Tuyo de verdad: cash al banco menos lo que NO es del merchant
  // (shipping → carrier, tax → gobierno).
  // Asunción conservadora: shipping cobrado al cliente = shipping pagado
  // al carrier (net 0). Si el merchant gana margen en shipping, esto
  // sub-estima ligeramente. Pero es la asunción correcta por default.
  const netForMerchant = +(cashToBank - sh.taxes - sh.shipping).toFixed(2);

  // Legacy field (productos puros - fees) — mantenido para compat
  const netAfterFees = +(sh.net_sales - shopifyFees).toFixed(2);

  // ROAS
  const metaRoas = metaTotals.spend > 0
    ? +(metaTotals.purchase_value / metaTotals.spend).toFixed(3)
    : 0;
  // cash_roas = net_for_merchant / spend (lo que es REALMENTE tuyo)
  const cashRoas = metaTotals.spend > 0
    ? +(netForMerchant / metaTotals.spend).toFixed(3)
    : 0;
  const gapPct = metaRoas > 0
    ? +(((metaRoas - cashRoas) / metaRoas) * 100).toFixed(1)
    : 0;

  return {
    date_et: dateEt,
    range_start_utc: startUtc,
    range_end_utc: endUtc,
    meta_spend: +metaTotals.spend.toFixed(2),
    meta_purchase_value: +metaTotals.purchase_value.toFixed(2),
    meta_roas: metaRoas,
    gross_sales: sh.gross_sales,
    discounts: sh.discounts,
    shipping: sh.shipping,
    taxes: sh.taxes,
    total_sales: sh.total_sales,
    refunds: sh.refunds,
    net_sales: sh.net_sales,
    shopify_fees_est: shopifyFees,
    net_after_fees: netAfterFees,
    cash_to_bank: cashToBank,
    net_for_merchant: netForMerchant,
    orders_count: sh.orders_count,
    cash_roas: cashRoas,
    gap_pct: gapPct,
    computed_at: new Date(),
    computation_ms: elapsed,
    shopify_orders_fetched: sh.orders_count,
    shopify_refunds_fetched: sh.refunds_count,
    computation_error: computationError
  };
}

/**
 * Pull Meta spend + purchase_value para UN día específico.
 *
 * IMPORTANTE: Meta API trata since/until como inclusivos en ambos extremos.
 * Si pasás since='2026-04-01', until='2026-04-02', Meta devuelve 2 DÍAS.
 *
 * Bug fix 2026-04-25: antes calculábamos untilDate como (endUtc - 1ms) que
 * tras toISOString().slice(0,10) caía en el día CALENDARIO siguiente, lo que
 * duplicaba el spend de cada snapshot ~2x. Ahora pasamos dateEt explícito:
 * since=until=dateEt → Meta retorna el día calendario del account TZ.
 */
async function fetchMetaTotals(startUtc, endUtc, dateEt) {
  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // Para single-day: since == until == dateEt. Meta interpreta en account TZ.
    const sinceDate = dateEt;
    const untilDate = dateEt;

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
      fetchMetaTotals(startUtc, endUtc, dateEt),
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

  // ─── Aggregate + build doc ───────────────────────────────────────────
  const sh = aggregateShopify(orders, refunds);
  const elapsed = Date.now() - t0;
  const doc = buildSnapshotDoc({ dateEt, startUtc, endUtc, metaTotals, sh, computationError, elapsed });

  await DemeterSnapshot.findOneAndUpdate(
    { date_et: dateEt },
    { $set: doc },
    { upsert: true, new: true }
  );

  logger.info(
    `[demeter] ${dateEt} ✓ Meta=$${doc.meta_spend} (ROAS ${doc.meta_roas}x) | ` +
    `Total sales $${doc.total_sales} → bank $${doc.cash_to_bank} → tuyo $${doc.net_for_merchant} | ` +
    `cash ROAS ${doc.cash_roas}x | gap ${doc.gap_pct}% | ${elapsed}ms`
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
    metaTotals = await fetchMetaTotals(startUtc, endUtc, dateEt);
  } catch (err) {
    metaTotals = { spend: 0, purchase_value: 0 };
    computationError = err.message;
  }

  // Aggregate + build doc + upsert
  const sh = aggregateShopify(dayOrders, dayRefunds);
  const elapsed = Date.now() - t0;
  const doc = buildSnapshotDoc({ dateEt, startUtc, endUtc, metaTotals, sh, computationError, elapsed });

  await DemeterSnapshot.findOneAndUpdate(
    { date_et: dateEt },
    { $set: doc },
    { upsert: true, new: true }
  );

  logger.info(
    `[demeter] ${dateEt} ✓ spend $${doc.meta_spend} | total sales $${doc.total_sales} → ` +
    `bank $${doc.cash_to_bank} → tuyo $${doc.net_for_merchant} | ` +
    `cash ROAS ${doc.cash_roas}x · ${elapsed}ms`
  );

  return doc;
}

module.exports = {
  runDailySnapshot,
  backfillSnapshots,
  // exports para tests/debugging
  _helpers: { dateRangeET, todayInET, daysAgoEt, aggregateShopify, estimateShopifyFees }
};
