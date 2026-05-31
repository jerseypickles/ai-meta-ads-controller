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

// Mapeo de pasos del funnel → action_types de Meta, EN ORDEN DE PREFERENCIA.
// Meta devuelve el MISMO evento bajo varios nombres (omni_*, fb_pixel_*, raw) con
// el mismo valor → hay que tomar UNO (el primero presente), NO sumar (triplicaría).
// Orden: omni_* (total cross-channel dedupeado) → fb_pixel_* → raw.
const EVENT_TYPES = {
  landing_page_view: ['omni_landing_page_view', 'landing_page_view'],
  view_content: ['omni_view_content', 'offsite_conversion.fb_pixel_view_content', 'view_content'],
  add_to_cart: ['omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
  initiate_checkout: ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
  purchase: ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase']
};

// Umbrales de cuellos de botella (tasas %, sobre 7d). Configurables por env.
const TH = {
  lpv_to_vc: parseFloat(process.env.ARGOS_TH_LPV_VC || '30'),
  vc_to_atc: parseFloat(process.env.ARGOS_TH_VC_ATC || '3'),
  atc_to_ic: parseFloat(process.env.ARGOS_TH_ATC_IC || '30'),
  ic_to_purchase: parseFloat(process.env.ARGOS_TH_IC_PUR || '40')
};

// Toma el PRIMER action_type presente de la lista (dedup) — NO suma (el mismo
// evento viene bajo varios nombres con el mismo valor).
function _pickEvent(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const a = actions.find(x => x.action_type === t);
    if (a) return parseInt(a.value) || 0;
  }
  return 0;
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
    landing_page_view: _pickEvent(actions, EVENT_TYPES.landing_page_view),
    view_content: _pickEvent(actions, EVENT_TYPES.view_content),
    add_to_cart: _pickEvent(actions, EVENT_TYPES.add_to_cart),
    initiate_checkout: _pickEvent(actions, EVENT_TYPES.initiate_checkout),
    purchase: _pickEvent(actions, EVENT_TYPES.purchase),
    spend: parseFloat(r.spend) || 0
  };
  return f;
}

/**
 * Analiza el pixel sobre una ventana (days, default 30). Funnel + tasas + issues:
 * detecta eventos sub-instrumentados (LPV/VC/ATC/IC que no disparan vs los clicks
 * y las compras) — el caso típico de pixel mal configurado.
 */
async function analyzePixel(days = 30) {
  const moment = require('moment-timezone');
  const TZ = config.system.timezone || 'America/New_York';
  const today = moment().tz(TZ).format('YYYY-MM-DD');
  const yesterday = moment().tz(TZ).subtract(1, 'days').format('YYYY-MM-DD');
  const since = moment().tz(TZ).subtract(days, 'days').format('YYYY-MM-DD');

  // Ventana principal (incluye hoy para no perder días en cuentas nuevas).
  const f = await getAccountFunnel({ since, until: today });

  const rates = {
    click_to_lpv: _rate(f.landing_page_view, f.link_clicks),
    lpv_to_vc: _rate(f.view_content, f.landing_page_view),
    vc_to_atc: _rate(f.add_to_cart, f.view_content),
    atc_to_ic: _rate(f.initiate_checkout, f.add_to_cart),
    ic_to_purchase: _rate(f.purchase, f.initiate_checkout)
  };

  const issues = [];
  const pur = f.purchase, clicks = f.link_clicks;

  // ── 1. PageView casi no dispara vs clicks (pixel no carga / bounce) ──
  if (clicks >= 50 && f.landing_page_view < clicks * 0.3) {
    issues.push({
      severity: 'critical', kind: 'broken_event', event: 'landing_page_view',
      message: `Solo ${rates.click_to_lpv}% de los clicks registran Landing Page View (${f.landing_page_view}/${clicks}) — el pixel no carga en la mayoría de las visitas (o bounce altísimo / problema de tracking)`,
      detail: { lpv: f.landing_page_view, link_clicks: clicks, rate: rates.click_to_lpv }
    });
  }

  // ── 2. ViewContent < compras = el evento de vista de producto no dispara ──
  if (pur >= 3 && f.view_content < pur) {
    issues.push({
      severity: 'critical', kind: 'broken_event', event: 'view_content',
      message: `ViewContent (${f.view_content}) es MENOR que las compras (${pur}) — debería ser muchísimo mayor. El evento ViewContent casi no se registra; el pixel no trackea las vistas de producto`,
      detail: { view_content: f.view_content, purchase: pur }
    });
  }

  // ── 3. AddToCart sin registrar ──
  if (pur >= 3 && f.add_to_cart === 0) {
    issues.push({
      severity: 'warning', kind: 'broken_event', event: 'add_to_cart',
      message: `0 AddToCart con ${pur} compras — el evento AddToCart no se está registrando (el theme no lo dispara, o los clientes usan "Buy Now" salteando el carrito)`,
      detail: { add_to_cart: 0, purchase: pur }
    });
  }

  // ── 4. InitiateCheckout < compras = checkout no dispara confiable ──
  if (pur >= 3 && f.initiate_checkout < pur) {
    issues.push({
      severity: 'warning', kind: 'broken_event', event: 'initiate_checkout',
      message: `InitiateCheckout (${f.initiate_checkout}) menor que las compras (${pur}) — el evento de checkout no dispara confiable (deberían ser ≥ compras)`,
      detail: { initiate_checkout: f.initiate_checkout, purchase: pur }
    });
  }

  // ── 5. ATC pero 0 compras (checkout/purchase roto) ──
  if (f.add_to_cart >= 20 && pur === 0) {
    issues.push({
      severity: 'critical', kind: 'broken_event', event: 'purchase',
      message: `${f.add_to_cart} AddToCart pero 0 compras — el evento Purchase o el checkout está roto`,
      detail: { add_to_cart: f.add_to_cart, purchase: 0 }
    });
  }

  // ── 6. Cuellos de botella reales (solo si los eventos SÍ disparan con volumen) ──
  const bottlenecks = [
    { step: 'vc_to_atc', rate: rates.vc_to_atc, vol: f.view_content, th: TH.vc_to_atc, msg: 'poca gente agrega al carrito desde el producto' },
    { step: 'atc_to_ic', rate: rates.atc_to_ic, vol: f.add_to_cart, th: TH.atc_to_ic, msg: 'se caen entre carrito y checkout' },
    { step: 'ic_to_purchase', rate: rates.ic_to_purchase, vol: f.initiate_checkout, th: TH.ic_to_purchase, msg: 'abandonan el checkout' }
  ];
  for (const b of bottlenecks) {
    if (b.vol >= 30 && b.rate < b.th) {
      issues.push({
        severity: 'warning', kind: 'funnel_bottleneck', event: b.step,
        message: `Cuello de botella ${b.step}: ${b.rate}% (umbral ${b.th}%) — ${b.msg}`,
        detail: { rate: b.rate, threshold: b.th, volume: b.vol }
      });
    }
  }

  if (issues.length === 0) {
    issues.push({ severity: 'info', kind: 'healthy', event: 'pixel', message: 'Pixel sano — eventos disparando y funnel sin cuellos críticos.', detail: {} });
  }

  let score = 100;
  for (const i of issues) score -= i.severity === 'critical' ? 40 : i.severity === 'warning' ? 15 : 0;
  score = Math.max(0, score);

  return {
    window_days: days,
    funnel_7d: f,          // ahora es la ventana elegida (mantengo el nombre por compat del panel)
    funnel_today: f,
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
