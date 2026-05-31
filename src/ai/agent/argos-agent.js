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

// Eventos del PIXEL (como los nombra Events Manager) → key interna del funnel.
const PIXEL_EVENT_MAP = {
  PageView: 'page_view',
  ViewContent: 'view_content',
  AddToCart: 'add_to_cart',
  InitiateCheckout: 'initiate_checkout',
  Purchase: 'purchase'
};

// Umbrales de cuellos de botella (tasas %, sobre 7d). Configurables por env.
const TH = {
  lpv_to_vc: parseFloat(process.env.ARGOS_TH_LPV_VC || '30'),
  vc_to_atc: parseFloat(process.env.ARGOS_TH_VC_ATC || '3'),
  atc_to_ic: parseFloat(process.env.ARGOS_TH_ATC_IC || '30'),
  ic_to_purchase: parseFloat(process.env.ARGOS_TH_IC_PUR || '40')
};

function _rate(num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; }

/** Metadata del pixel: nombre, último evento recibido, disponibilidad. */
async function getPixelMeta() {
  const meta = getMetaClient();
  const pid = config.meta.pixelId;
  try {
    return await meta.get(`/${pid}`, { fields: 'name,last_fired_time,is_unavailable' });
  } catch (e) {
    logger.warn(`[ARGOS] getPixelMeta falló: ${e.message}`);
    return {};
  }
}

/**
 * Funnel REAL del pixel (todos los eventos, no solo los atribuidos a ads) vía
 * el endpoint /{pixel_id}/stats?aggregation=event. Suma los conteos por evento
 * sobre la ventana. Es la misma data que muestra Events Manager.
 */
async function getPixelFunnel(days = 30) {
  const meta = getMetaClient();
  const pid = config.meta.pixelId;
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const res = await meta.get(`/${pid}/stats`, { aggregation: 'event', start, end });
  const buckets = res.data || [];
  const f = { page_view: 0, view_content: 0, add_to_cart: 0, initiate_checkout: 0, purchase: 0 };
  let minT = null, maxT = null, nBuckets = 0;
  for (const b of buckets) {
    nBuckets++;
    if (b.start_time) { if (!minT || b.start_time < minT) minT = b.start_time; if (!maxT || b.start_time > maxT) maxT = b.start_time; }
    for (const e of (b.data || [])) {
      const key = PIXEL_EVENT_MAP[e.value];
      if (key) f[key] += parseInt(e.count) || 0;
    }
  }
  f.range_start = minT; f.range_end = maxT; f.buckets = nBuckets;
  return f;
}

/**
 * Analiza el PIXEL (eventos reales, no solo atribuidos a ads) sobre una ventana.
 * Funnel PageView→ViewContent→AddToCart→InitiateCheckout→Purchase + frescura +
 * disponibilidad + cuellos de botella. Misma data que Events Manager.
 */
async function analyzePixel(days = 30) {
  const [f, pmeta] = await Promise.all([
    getPixelFunnel(days),
    getPixelMeta()
  ]);

  const rates = {
    pv_to_vc: _rate(f.view_content, f.page_view),
    vc_to_atc: _rate(f.add_to_cart, f.view_content),
    atc_to_ic: _rate(f.initiate_checkout, f.add_to_cart),
    ic_to_purchase: _rate(f.purchase, f.initiate_checkout)
  };

  const issues = [];

  // ── 1. Disponibilidad del pixel ──
  if (pmeta.is_unavailable) {
    issues.push({ severity: 'critical', kind: 'broken_event', event: 'pixel', message: 'Meta marca el pixel como NO DISPONIBLE — no está recibiendo eventos correctamente.', detail: {} });
  }

  // ── 2. Frescura (último evento recibido) ──
  if (pmeta.last_fired_time) {
    const hrs = (Date.now() - new Date(pmeta.last_fired_time).getTime()) / 3600000;
    if (hrs > 12) {
      issues.push({ severity: 'critical', kind: 'event_drop', event: 'pixel', message: `El pixel no recibe eventos hace ${Math.round(hrs)}h — probablemente caído o desconectado.`, detail: { hours: Math.round(hrs) } });
    } else if (hrs > 3) {
      issues.push({ severity: 'warning', kind: 'event_drop', event: 'pixel', message: `El pixel no recibe eventos hace ${Math.round(hrs)}h.`, detail: { hours: Math.round(hrs) } });
    }
  }

  // ── 3. Eventos que NO disparan (con PageView de volumen) ──
  const stepLabels = { view_content: 'ViewContent', add_to_cart: 'AddToCart', initiate_checkout: 'InitiateCheckout', purchase: 'Purchase' };
  if (f.page_view >= 100) {
    for (const ev of Object.keys(stepLabels)) {
      if (f[ev] === 0) {
        issues.push({ severity: ev === 'purchase' ? 'critical' : 'warning', kind: 'broken_event', event: ev,
          message: `${stepLabels[ev]} no dispara (0 eventos con ${f.page_view} PageView) — revisar tracking del evento.`, detail: { page_view: f.page_view } });
      }
    }
  }

  // ── 4. Cuellos de botella del funnel (tasas bajas con volumen) ──
  const bottlenecks = [
    { step: 'vc_to_atc', rate: rates.vc_to_atc, vol: f.view_content, th: TH.vc_to_atc, msg: 'poca gente agrega al carrito desde el producto' },
    { step: 'atc_to_ic', rate: rates.atc_to_ic, vol: f.add_to_cart, th: TH.atc_to_ic, msg: 'se caen entre carrito y checkout' },
    { step: 'ic_to_purchase', rate: rates.ic_to_purchase, vol: f.initiate_checkout, th: TH.ic_to_purchase, msg: 'abandonan el checkout' }
  ];
  for (const b of bottlenecks) {
    if (b.vol >= 30 && b.rate < b.th) {
      issues.push({ severity: 'warning', kind: 'funnel_bottleneck', event: b.step,
        message: `Cuello de botella ${b.step}: ${b.rate}% (umbral ${b.th}%) — ${b.msg}`, detail: { rate: b.rate, threshold: b.th, volume: b.vol } });
    }
  }

  if (issues.length === 0) {
    issues.push({ severity: 'info', kind: 'healthy', event: 'pixel', message: 'Pixel sano — todos los eventos disparando y funnel sin cuellos críticos.', detail: {} });
  }

  let score = 100;
  for (const i of issues) score -= i.severity === 'critical' ? 40 : i.severity === 'warning' ? 15 : 0;
  score = Math.max(0, score);

  return {
    window_days: days,
    funnel_7d: f,
    funnel_today: f,
    rates,
    issues,
    health_score: score,
    pixel_meta: { name: pmeta.name, last_fired_time: pmeta.last_fired_time, is_unavailable: !!pmeta.is_unavailable },
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

module.exports = { runArgos, analyzePixel, getPixelFunnel, getPixelMeta };
