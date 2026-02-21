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
    frequency: parseFloat(insight.frequency || 0)
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

module.exports = {
  extractPurchaseValue,
  extractPurchaseCount,
  extractCPA,
  parseInsightRow,
  calculateROASTrend,
  calculateSpendVelocity,
  parseBudget,
  getTimeRanges
};
