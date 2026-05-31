// ═══════════════════════════════════════════════════════════════════════════════
// ARGOS 🦚 — Agente de análisis del PIXEL (funnel + salud de eventos)
// Argos Panoptes, "el que todo lo ve". Lee TODOS los eventos del pixel vía Meta
// (actions): impressions → link_clicks → landing_page_view → view_content →
// add_to_cart → initiate_checkout → purchase. Mapea el funnel, calcula drop-off,
// y detecta eventos rotos / caídas (pixel o CAPI roto) y cuellos de botella.
// Read-only: NO ejecuta acciones; diagnostica para el creador + Zeus.
// ═══════════════════════════════════════════════════════════════════════════════

const config = require('../../../config');
const logger = require('../../utils/logger');
const ArgosSnapshot = require('../../db/models/ArgosSnapshot');
const { getMetaClient } = require('../../meta/client');

// Mapeo de pasos del funnel → action_types posibles de Meta (browser + CAPI + omni).
const EVENT_TYPES = {
  landing_page_view: ['landing_page_view'],
  view_content: ['offsite_conversion.fb_pixel_view_content', 'view_content', 'omni_view_content'],
  add_to_cart: ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart', 'omni_add_to_cart'],
  initiate_checkout: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout'],
  purchase: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase']
};

// Umbrales de cuellos de botella (tasas %, sobre 7d). Configurables por env.
const TH = {
  lpv_to_vc: parseFloat(process.env.ARGOS_TH_LPV_VC || '30'),
  vc_to_atc: parseFloat(process.env.ARGOS_TH_VC_ATC || '3'),
  atc_to_ic: parseFloat(process.env.ARGOS_TH_ATC_IC || '30'),
  ic_to_purchase: parseFloat(process.env.ARGOS_TH_IC_PUR || '40')
};

function _sumEvent(actions, types) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) if (types.includes(a.action_type)) total += parseInt(a.value) || 0;
  return total;
}

function _rate(num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; }

/** Trae el funnel a nivel cuenta para un time_range (1 call). */
async function getAccountFunnel(timeRange) {
  const meta = getMetaClient();
  const rows = await meta.getInsights(config.meta.adAccountId, {
    fields: 'spend,impressions,inline_link_clicks,actions,action_values',
    time_range: JSON.stringify(timeRange)
  });
  const r = (rows && rows[0]) || {};
  const actions = r.actions || [];
  const f = {
    impressions: parseInt(r.impressions) || 0,
    link_clicks: parseInt(r.inline_link_clicks) || 0,
    landing_page_view: _sumEvent(actions, EVENT_TYPES.landing_page_view),
    view_content: _sumEvent(actions, EVENT_TYPES.view_content),
    add_to_cart: _sumEvent(actions, EVENT_TYPES.add_to_cart),
    initiate_checkout: _sumEvent(actions, EVENT_TYPES.initiate_checkout),
    purchase: _sumEvent(actions, EVENT_TYPES.purchase),
    spend: parseFloat(r.spend) || 0
  };
  return f;
}

/**
 * Analiza el pixel: funnel 7d + hoy, tasas de conversión, e issues (eventos rotos,
 * caídas, cuellos de botella). Devuelve el reporte estructurado.
 */
async function analyzePixel() {
  const moment = require('moment-timezone');
  const TZ = config.system.timezone || 'America/New_York';
  const today = moment().tz(TZ).format('YYYY-MM-DD');
  const yesterday = moment().tz(TZ).subtract(1, 'days').format('YYYY-MM-DD');
  const since7 = moment().tz(TZ).subtract(7, 'days').format('YYYY-MM-DD');

  const [funnelToday, funnel7d] = await Promise.all([
    getAccountFunnel({ since: today, until: today }),
    getAccountFunnel({ since: since7, until: yesterday })
  ]);

  // Tasas sobre 7d (señal estable, no el día parcial).
  const rates = {
    click_to_lpv: _rate(funnel7d.landing_page_view, funnel7d.link_clicks),
    lpv_to_vc: _rate(funnel7d.view_content, funnel7d.landing_page_view),
    vc_to_atc: _rate(funnel7d.add_to_cart, funnel7d.view_content),
    atc_to_ic: _rate(funnel7d.initiate_checkout, funnel7d.add_to_cart),
    ic_to_purchase: _rate(funnel7d.purchase, funnel7d.initiate_checkout)
  };

  const issues = [];

  // ── 1. EVENTOS ROTOS (top-funnel, disparan instantáneo → 0 hoy = roto) ──
  // landing_page_view / view_content no tienen lag de atribución; si en 7d había
  // volumen y HOY hay clicks pero 0 del evento → el pixel/CAPI se rompió.
  for (const ev of ['landing_page_view', 'view_content']) {
    const baselineDaily = funnel7d[ev] / 7;
    if (baselineDaily >= 5 && funnelToday[ev] === 0 && funnelToday.link_clicks >= 10) {
      issues.push({
        severity: 'critical', kind: 'broken_event', event: ev,
        message: `${ev} dejó de dispararse hoy (${funnelToday.link_clicks} clicks, 0 ${ev}) — pixel/CAPI probablemente roto`,
        detail: { today: 0, baseline_daily: Math.round(baselineDaily) }
      });
    }
  }

  // ── 2. ATC pero 0 compras en 7d (checkout/pixel de purchase roto) ──
  if (funnel7d.add_to_cart >= 20 && funnel7d.purchase === 0) {
    issues.push({
      severity: 'critical', kind: 'broken_event', event: 'purchase',
      message: `${funnel7d.add_to_cart} ATC en 7d pero 0 compras registradas — el evento Purchase o el checkout está roto`,
      detail: { add_to_cart_7d: funnel7d.add_to_cart, purchase_7d: 0 }
    });
  }

  // ── 3. CUELLOS DE BOTELLA del funnel (tasas bajas con volumen) ──
  const bottlenecks = [
    { step: 'lpv_to_vc', rate: rates.lpv_to_vc, vol: funnel7d.landing_page_view, th: TH.lpv_to_vc, msg: 'la landing no engancha (pocos llegan a ver el producto)' },
    { step: 'vc_to_atc', rate: rates.vc_to_atc, vol: funnel7d.view_content, th: TH.vc_to_atc, msg: 'poca gente agrega al carrito desde el producto (oferta/precio/PDP)' },
    { step: 'atc_to_ic', rate: rates.atc_to_ic, vol: funnel7d.add_to_cart, th: TH.atc_to_ic, msg: 'se caen entre carrito y checkout' },
    { step: 'ic_to_purchase', rate: rates.ic_to_purchase, vol: funnel7d.initiate_checkout, th: TH.ic_to_purchase, msg: 'abandonan el checkout (fricción de pago/envío)' }
  ];
  for (const b of bottlenecks) {
    if (b.vol >= 30 && b.rate < b.th) {
      issues.push({
        severity: 'warning', kind: 'funnel_bottleneck', event: b.step,
        message: `Cuello de botella ${b.step}: ${b.rate}% (umbral ${b.th}%) — ${b.msg}`,
        detail: { rate: b.rate, threshold: b.th, volume_7d: b.vol }
      });
    }
  }

  if (issues.length === 0) {
    issues.push({ severity: 'info', kind: 'healthy', event: 'pixel', message: 'Pixel sano — eventos disparando y funnel sin cuellos críticos.', detail: {} });
  }

  // Health score
  let score = 100;
  for (const i of issues) score -= i.severity === 'critical' ? 40 : i.severity === 'warning' ? 15 : 0;
  score = Math.max(0, score);

  return {
    funnel_today: funnelToday,
    funnel_7d: funnel7d,
    rates,
    issues,
    health_score: score,
    pixel_id: config.meta.pixelId || ''
  };
}

/** Corre Argos: analiza + persiste snapshot + loguea issues. */
async function runArgos() {
  const t0 = Date.now();
  try {
    const report = await analyzePixel();
    await ArgosSnapshot.create(report);
    const crit = report.issues.filter(i => i.severity === 'critical');
    const warn = report.issues.filter(i => i.severity === 'warning');
    logger.info(`[ARGOS] pixel health ${report.health_score}/100 · ${crit.length} críticos · ${warn.length} warnings · ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const i of crit) logger.warn(`[ARGOS] 🔴 ${i.message}`);
    return report;
  } catch (e) {
    logger.error(`[ARGOS] falló: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = { runArgos, analyzePixel, getAccountFunnel };
