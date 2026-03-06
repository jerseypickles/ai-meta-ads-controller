const { centsToDollars } = require('../utils/formatters');

/**
 * Extrae el valor de compras (revenue) de las actions de Meta.
 * Meta retorna actions y action_values como arrays con action_type.
 */
function extractPurchaseValue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;

  const purchase = actionValues.find(a =>
    a.action_type === 'omni_purchase' ||
    a.action_type === 'purchase' ||
    a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );

  return purchase ? parseFloat(purchase.value) : 0;
}

/**
 * Extrae el conteo de compras de las actions de Meta.
 */
function extractPurchaseCount(actions) {
  if (!actions || !Array.isArray(actions)) return 0;

  const purchase = actions.find(a =>
    a.action_type === 'omni_purchase' ||
    a.action_type === 'purchase' ||
    a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );

  return purchase ? parseInt(purchase.value) : 0;
}

/**
 * Extrae el conteo de add_to_cart del pixel de Meta.
 */
function extractAddToCartCount(actions) {
  if (!actions || !Array.isArray(actions)) return 0;
  const atc = actions.find(a =>
    a.action_type === 'offsite_conversion.fb_pixel_add_to_cart' ||
    a.action_type === 'add_to_cart'
  );
  return atc ? parseInt(atc.value) : 0;
}

/**
 * Extrae el conteo de initiate_checkout del pixel de Meta.
 */
function extractInitiateCheckoutCount(actions) {
  if (!actions || !Array.isArray(actions)) return 0;
  const ic = actions.find(a =>
    a.action_type === 'offsite_conversion.fb_pixel_initiate_checkout' ||
    a.action_type === 'initiate_checkout'
  );
  return ic ? parseInt(ic.value) : 0;
}

/**
 * Extrae el valor de add_to_cart del pixel de Meta.
 */
function extractAddToCartValue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  const atc = actionValues.find(a =>
    a.action_type === 'offsite_conversion.fb_pixel_add_to_cart' ||
    a.action_type === 'add_to_cart'
  );
  return atc ? parseFloat(atc.value) : 0;
}

/**
 * Extrae CPA de cost_per_action_type de Meta.
 */
function extractCPA(costPerAction) {
  if (!costPerAction || !Array.isArray(costPerAction)) return 0;

  const purchase = costPerAction.find(a =>
    a.action_type === 'omni_purchase' ||
    a.action_type === 'purchase' ||
    a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );

  return purchase ? parseFloat(purchase.value) : 0;
}

/**
 * Parsea un insight row de Meta a nuestro formato de métricas.
 */
function parseInsightRow(insight) {
  const spend = parseFloat(insight.spend || 0);
  const purchaseValue = extractPurchaseValue(insight.action_values);
  const purchases = extractPurchaseCount(insight.actions);

  // Use inline_link_clicks (clicks to destination URL) instead of generic "clicks"
  // Meta's generic "clicks" includes ALL clicks: profile, reactions, comments, see more, etc.
  // inline_link_clicks = only clicks that navigate to your website/store
  // This matches what Meta Ads Manager shows by default as "Link Clicks"
  const linkClicks = parseInt(insight.inline_link_clicks || 0);

  // Pixel funnel metrics
  const addToCart = extractAddToCartCount(insight.actions);
  const addToCartValue = extractAddToCartValue(insight.action_values);
  const initiateCheckout = extractInitiateCheckoutCount(insight.actions);

  return {
    spend,
    impressions: parseInt(insight.impressions || 0),
    clicks: linkClicks,
    ctr: parseFloat(insight.inline_link_click_ctr || 0),
    cpm: parseFloat(insight.cpm || 0),
    cpc: parseFloat(insight.cost_per_inline_link_click || 0),
    purchases,
    purchase_value: purchaseValue,
    roas: spend > 0 ? purchaseValue / spend : 0,
    cpa: purchases > 0 ? spend / purchases : 0,
    reach: parseInt(insight.reach || 0),
    frequency: parseFloat(insight.frequency || 0),
    add_to_cart: addToCart,
    add_to_cart_value: addToCartValue,
    initiate_checkout: initiateCheckout
  };
}

/**
 * Calcula la tendencia del ROAS comparando ventanas de tiempo.
 */
function calculateROASTrend(roas3d, roas7d) {
  if (!roas7d || roas7d === 0) return 'stable';

  const ratio = roas3d / roas7d;

  if (ratio > 1.1) return 'improving';   // 3d ROAS > 10% mejor que 7d
  if (ratio < 0.9) return 'declining';    // 3d ROAS > 10% peor que 7d
  return 'stable';
}

/**
 * Calcula la velocidad de gasto (pacing).
 * 1.0 = on pace, <1.0 = underpacing, >1.0 = overpacing
 */
function calculateSpendVelocity(todaySpend, dailyBudget) {
  if (!dailyBudget || dailyBudget === 0) return 0;

  const now = new Date();
  const hoursElapsed = now.getHours() + (now.getMinutes() / 60);

  if (hoursElapsed === 0) return 0;

  const expectedSpend = dailyBudget * (hoursElapsed / 24);
  return expectedSpend > 0 ? todaySpend / expectedSpend : 0;
}

/**
 * Parsea el presupuesto de Meta (viene en centavos) a dólares.
 */
function parseBudget(metaBudget) {
  if (!metaBudget) return 0;
  return centsToDollars(parseInt(metaBudget));
}

/**
 * Genera los rangos de fecha para cada ventana de tiempo.
 * 5 ventanas: today, last_3d, last_7d, last_14d, last_30d
 *
 * IMPORTANTE: Usa moment-timezone con America/New_York para que las fechas
 * coincidan con el timezone de la cuenta de Meta Ads. Sin esto, después de
 * las 7 PM ET el toISOString() devuelve la fecha UTC (día siguiente) y
 * Meta retorna vacío porque ese día todavía no existe en su timezone.
 */
function getTimeRanges() {
  const moment = require('moment-timezone');
  const TIMEZONE = require('../../config').system.timezone || 'America/New_York';

  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');

  const ranges = {};

  // Hoy
  ranges.today = {
    since: today,
    until: today
  };

  // Últimos 3 días
  ranges.last_3d = {
    since: moment().tz(TIMEZONE).subtract(2, 'days').format('YYYY-MM-DD'),
    until: today
  };

  // Últimos 7 días
  ranges.last_7d = {
    since: moment().tz(TIMEZONE).subtract(6, 'days').format('YYYY-MM-DD'),
    until: today
  };

  // Últimos 14 días
  ranges.last_14d = {
    since: moment().tz(TIMEZONE).subtract(13, 'days').format('YYYY-MM-DD'),
    until: today
  };

  // Últimos 30 días
  ranges.last_30d = {
    since: moment().tz(TIMEZONE).subtract(29, 'days').format('YYYY-MM-DD'),
    until: today
  };

  return ranges;
}

/**
 * Agrega rows diarios (de time_increment=1) en ventanas de tiempo.
 * Recibe un array de rows parseados con parseInsightRow, cada uno con un campo `date_start`.
 * Devuelve un objeto { today: {...}, last_3d: {...}, last_7d: {...}, last_14d: {...}, last_30d: {...} }
 *
 * Esto permite hacer UNA sola call a Meta con 30 días de datos diarios
 * y calcular las 5 ventanas localmente, en vez de 5 calls separadas.
 */
function aggregateDailyInsights(dailyRows, entityIdField) {
  const moment = require('moment-timezone');
  const TIMEZONE = require('../../config').system.timezone || 'America/New_York';
  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');

  // Boundaries for each window (inclusive)
  const windows = {
    today:    { since: today },
    last_3d:  { since: moment().tz(TIMEZONE).subtract(2, 'days').format('YYYY-MM-DD') },
    last_7d:  { since: moment().tz(TIMEZONE).subtract(6, 'days').format('YYYY-MM-DD') },
    last_14d: { since: moment().tz(TIMEZONE).subtract(13, 'days').format('YYYY-MM-DD') },
    last_30d: { since: moment().tz(TIMEZONE).subtract(29, 'days').format('YYYY-MM-DD') }
  };

  // Group rows by entity
  const byEntity = {};
  for (const row of dailyRows) {
    const eid = row[entityIdField];
    if (!eid) continue;
    if (!byEntity[eid]) byEntity[eid] = [];
    byEntity[eid].push(row);
  }

  // For each entity, sum daily rows into each window
  const result = {}; // { entityId: { today: metrics, last_3d: metrics, ... } }

  for (const [eid, rows] of Object.entries(byEntity)) {
    result[eid] = {};

    for (const [windowName, { since }] of Object.entries(windows)) {
      // Filter rows that fall within this window
      const windowRows = rows.filter(r => r.date_start >= since && r.date_start <= today);

      if (windowRows.length === 0) {
        result[eid][windowName] = null; // Will be filled with emptyMetrics by caller
        continue;
      }

      // Sum additive metrics across days
      const summed = {
        spend: 0, impressions: 0, clicks: 0, purchases: 0, purchase_value: 0,
        reach: 0, add_to_cart: 0, add_to_cart_value: 0, initiate_checkout: 0
      };

      for (const r of windowRows) {
        const parsed = parseInsightRow(r);
        summed.spend += parsed.spend;
        summed.impressions += parsed.impressions;
        summed.clicks += parsed.clicks;
        summed.purchases += parsed.purchases;
        summed.purchase_value += parsed.purchase_value;
        summed.reach += parsed.reach; // Note: reach across days is approximate (not deduplicated)
        summed.add_to_cart += parsed.add_to_cart;
        summed.add_to_cart_value += parsed.add_to_cart_value;
        summed.initiate_checkout += parsed.initiate_checkout;
      }

      // Compute derived metrics from summed values
      result[eid][windowName] = {
        spend: summed.spend,
        impressions: summed.impressions,
        clicks: summed.clicks,
        ctr: summed.impressions > 0 ? (summed.clicks / summed.impressions) * 100 : 0,
        cpm: summed.impressions > 0 ? (summed.spend / summed.impressions) * 1000 : 0,
        cpc: summed.clicks > 0 ? summed.spend / summed.clicks : 0,
        purchases: summed.purchases,
        purchase_value: summed.purchase_value,
        roas: summed.spend > 0 ? summed.purchase_value / summed.spend : 0,
        cpa: summed.purchases > 0 ? summed.spend / summed.purchases : 0,
        reach: summed.reach,
        frequency: summed.reach > 0 ? summed.impressions / summed.reach : 0,
        add_to_cart: summed.add_to_cart,
        add_to_cart_value: summed.add_to_cart_value,
        initiate_checkout: summed.initiate_checkout
      };
    }
  }

  return result;
}

module.exports = {
  extractPurchaseValue,
  extractPurchaseCount,
  extractAddToCartCount,
  extractInitiateCheckoutCount,
  extractAddToCartValue,
  extractCPA,
  parseInsightRow,
  aggregateDailyInsights,
  calculateROASTrend,
  calculateSpendVelocity,
  parseBudget,
  getTimeRanges
};
