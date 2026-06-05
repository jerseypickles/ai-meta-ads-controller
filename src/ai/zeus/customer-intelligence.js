// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER INTELLIGENCE — Pilar 1 de "Zeus con esteroides" (2026-06-05).
// Mina Shopify (orders detalladas con customer + line_items) → inteligencia de cliente:
// cohortes, LTV, recompra, RFM, producto. Zeus pasa de ver SOLO métricas de ads a
// entender a los CLIENTES. Cron diario → snapshot → entra al contexto de Zeus + tool.
// ═══════════════════════════════════════════════════════════════════════════════

const shopify = require('../../integrations/shopify-client');
const CustomerIntelligence = require('../../db/models/CustomerIntelligence');
const logger = require('../../utils/logger');

const WINDOW_DAYS = parseInt(process.env.CUSTOMER_INTEL_WINDOW_DAYS || '120', 10);
const RECENT_DAYS = 30; // recencia para "champion/new"

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Computa la inteligencia de cliente sobre la ventana y persiste un snapshot. */
async function computeCustomerIntelligence(windowDays = WINDOW_DAYS) {
  const end = new Date();
  const start = new Date(Date.now() - windowDays * 86400000);
  const orders = (await shopify.getOrdersDetailed(start, end))
    .filter(o => (parseFloat(o.total_price) || 0) > 0)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); // asc → la 1ra vista por cliente es su primera
  if (!orders.length) { logger.warn('[CUSTOMER-INTEL] sin orders en la ventana'); return null; }

  const now = Date.now();
  const byCustomer = {};
  const productAgg = {};       // producto → { revenue, units, orders }
  const acqProducts = {};      // producto → veces que fue de PRIMERA orden (adquisición)
  let totalRevenue = 0;

  for (const o of orders) {
    const rev = parseFloat(o.total_price) || 0;
    totalRevenue += rev;
    const items = o.line_items || [];
    for (const li of items) {
      const name = (li.title || li.name || 'unknown').slice(0, 60);
      const p = productAgg[name] || (productAgg[name] = { revenue: 0, units: 0, orders: 0 });
      p.revenue += (parseFloat(li.price) || 0) * (li.quantity || 1);
      p.units += (li.quantity || 1);
      p.orders += 1;
    }
    const cid = o.customer?.id ? String(o.customer.id) : null;
    if (!cid) continue; // guest sin customer → no entra a cohortes
    const created = new Date(o.created_at);
    let c = byCustomer[cid];
    if (!c) {
      c = byCustomer[cid] = { orders: 0, spent: 0, first: created, last: created };
      // primera orden de este cliente (orders están asc) → productos de adquisición
      for (const li of items) {
        const name = (li.title || li.name || 'unknown').slice(0, 60);
        acqProducts[name] = (acqProducts[name] || 0) + 1;
      }
    }
    c.orders++; c.spent += rev;
    if (created > c.last) c.last = created;
  }

  const customers = Object.values(byCustomer);
  const totalCustomers = customers.length;
  const repeat = customers.filter(c => c.orders >= 2);
  const avgLtv = totalCustomers ? customers.reduce((s, c) => s + c.spent, 0) / totalCustomers : 0;
  const avgOrders = totalCustomers ? customers.reduce((s, c) => s + c.orders, 0) / totalCustomers : 0;
  const avgAov = orders.length ? totalRevenue / orders.length : 0;

  // Días entre órdenes (solo repeat)
  let dbSum = 0, dbN = 0;
  for (const c of repeat) {
    const span = (c.last - c.first) / 86400000;
    if (span > 0) { dbSum += span / (c.orders - 1); dbN++; }
  }

  // RFM segments (umbrales por mediana)
  const freqMed = Math.max(2, median(customers.map(c => c.orders)));
  const monMed = median(customers.map(c => c.spent));
  const seg = { champions: 0, loyal: 0, at_risk: 0, new: 0, one_off: 0 };
  for (const c of customers) {
    const recencyD = (now - c.last) / 86400000;
    const recent = recencyD <= RECENT_DAYS;
    const frequent = c.orders >= freqMed;
    const highVal = c.spent >= monMed;
    if (recent && frequent && highVal) seg.champions++;
    else if (frequent) seg.loyal++;
    else if (!recent && c.orders >= 2) seg.at_risk++;
    else if (recent && c.orders === 1) seg.new++;
    else seg.one_off++;
  }

  const newRev = customers.filter(c => c.orders === 1).reduce((s, c) => s + c.spent, 0);
  const returningRev = totalRevenue - newRev;

  const topProducts = Object.entries(productAgg)
    .map(([name, p]) => ({ name, revenue: Math.round(p.revenue), units: p.units, orders: p.orders }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 12);
  const topAcquisition = Object.entries(acqProducts)
    .map(([name, n]) => ({ name, first_orders: n }))
    .sort((a, b) => b.first_orders - a.first_orders).slice(0, 8);

  const data = {
    window_days: windowDays,
    orders_count: orders.length,
    total_revenue: Math.round(totalRevenue),
    total_customers: totalCustomers,
    repeat_customers: repeat.length,
    repeat_rate: totalCustomers ? +(repeat.length / totalCustomers).toFixed(3) : 0,
    avg_ltv: +avgLtv.toFixed(2),
    avg_orders_per_customer: +avgOrders.toFixed(2),
    avg_aov: +avgAov.toFixed(2),
    avg_days_between_orders: dbN ? Math.round(dbSum / dbN) : null,
    rfm_segments: seg,
    revenue_split: {
      new_customers: Math.round(newRev),
      returning_customers: Math.round(returningRev),
      returning_pct: totalRevenue ? +((returningRev / totalRevenue) * 100).toFixed(1) : 0
    },
    top_products: topProducts,
    top_acquisition_products: topAcquisition  // qué producto es la "puerta de entrada"
  };

  try { await CustomerIntelligence.create({ computed_at: new Date(), window_days: windowDays, data }); }
  catch (e) { logger.warn(`[CUSTOMER-INTEL] no se pudo persistir: ${e.message}`); }
  logger.info(`[CUSTOMER-INTEL] ${totalCustomers} clientes · repeat ${(data.repeat_rate * 100).toFixed(0)}% · LTV $${avgLtv.toFixed(0)} · AOV $${avgAov.toFixed(0)} · returning ${data.revenue_split.returning_pct}% del revenue`);
  return data;
}

/** Lee el último snapshot (para el contexto de Zeus + la tool). */
async function getLatestCustomerIntelligence() {
  const doc = await CustomerIntelligence.findOne({}).sort({ computed_at: -1 }).lean();
  return doc ? { ...doc.data, computed_at: doc.computed_at } : null;
}

module.exports = { computeCustomerIntelligence, getLatestCustomerIntelligence, WINDOW_DAYS };
