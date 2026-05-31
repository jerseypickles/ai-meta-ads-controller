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
const Anthropic = require('@anthropic-ai/sdk');
const ArgosSnapshot = require('../../db/models/ArgosSnapshot');
const { getMetaClient } = require('../../meta/client');
const { isExcludedCampaignId } = require('../../config/excluded-entities');

// Meta necesita ~50 conversiones (del evento optimizado) en 7d por adset para salir
// de la fase de aprendizaje. Clave para un pixel nuevo optimizando Purchase.
const LEARNING_TARGET = 50;

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
 * Estado de APRENDIZAJE por adset activo (learning_stage_info de Meta).
 * Para un pixel nuevo optimizando Purchase, esto es lo que más importa:
 * cuántas conversiones lleva cada adset hacia las ~50 para salir de learning.
 */
async function getLearningStatus() {
  const meta = getMetaClient();
  try {
    const adsets = await meta.getAllAdSets('name,campaign_id,effective_status,optimization_goal,learning_stage_info');
    return (adsets || [])
      .filter(a => a.effective_status === 'ACTIVE' && !isExcludedCampaignId(a.campaign_id))
      .map(a => ({
        name: a.name,
        optimization_goal: a.optimization_goal || '',
        status: a.learning_stage_info?.status || 'UNKNOWN',  // LEARNING | SUCCESS | LEARNING_LIMITED
        conversions: a.learning_stage_info?.conversions != null ? Number(a.learning_stage_info.conversions) : null
      }));
  } catch (e) {
    logger.warn(`[ARGOS] getLearningStatus falló: ${e.message}`);
    return [];
  }
}

/**
 * Diagnóstico FUNDAMENTADO con Claude — contextualizado a que el pixel es NUEVO
 * y los adsets optimizan SOLO Purchase, con el objetivo de que el pixel madure.
 */
async function generateDiagnosis({ funnel, pmeta, learning, ageDays }) {
  const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '';
  try {
    const claude = new Anthropic({ apiKey });
    const learnLines = learning.length
      ? learning.map(l => `- "${l.name}": ${l.status}${l.conversions != null ? `, ${l.conversions}/${LEARNING_TARGET} conv` : ''} (opt: ${l.optimization_goal})`).join('\n')
      : '(sin adsets activos optimizando conversión)';
    const prompt = `Sos ARGOS, el analista de salud del pixel de Meta de Jersey Pickles. Da un diagnóstico BREVE y FUNDAMENTADO (no genérico) en español neutro.

CONTEXTO CLAVE (no lo ignores):
- El pixel y la cuenta son NUEVOS (~${ageDays} días de datos). Todo arranca de cero.
- Los adsets optimizan SOLO Purchase. El OBJETIVO ahora es que el pixel ACUMULE señal de compra y MADURE (salga de learning), no perfeccionar el funnel todavía.
- Meta necesita ~${LEARNING_TARGET} conversiones del evento optimizado en 7d por adset para salir de aprendizaje.

DATA REAL del pixel (ventana ~${funnel.buckets ? ageDays : ''} días):
- PageView: ${funnel.page_view} · ViewContent: ${funnel.view_content} · AddToCart: ${funnel.add_to_cart} · InitiateCheckout: ${funnel.initiate_checkout} · Purchase: ${funnel.purchase}
- Último evento: ${pmeta.last_fired_time || 'n/d'} · pixel ${pmeta.is_unavailable ? 'NO DISPONIBLE' : 'disponible'}

APRENDIZAJE por adset:
${learnLines}

Escribí 3-5 frases: (1) en qué etapa real está el pixel (nuevo/madurando), (2) cuánta señal de Purchase lleva y qué tan lejos está de madurar (usá las conversiones vs ${LEARNING_TARGET}), (3) qué es esperable vs preocupante DADO que es nuevo y purchase-only (NO alarmar por VC/ATC bajos si es coherente), (4) 1-2 recomendaciones concretas para acelerar el aprendizaje. Sé concreto con los números.`;
    const resp = await claude.messages.create({
      model: config.claude.model, max_tokens: 380,
      messages: [{ role: 'user', content: prompt }]
    });
    return resp.content?.[0]?.text?.trim() || '';
  } catch (e) {
    logger.warn(`[ARGOS] generateDiagnosis falló: ${e.message}`);
    return '';
  }
}

/**
 * Analiza el PIXEL (eventos reales, no solo atribuidos a ads) sobre una ventana.
 * Funnel PageView→ViewContent→AddToCart→InitiateCheckout→Purchase + frescura +
 * disponibilidad + cuellos de botella. Misma data que Events Manager.
 */
async function analyzePixel(days = 30) {
  const [f, pmeta, learning] = await Promise.all([
    getPixelFunnel(days),
    getPixelMeta(),
    getLearningStatus()
  ]);

  // Edad del pixel = días desde el primer evento visto (cuenta nueva).
  const ageDays = f.range_start ? Math.max(1, Math.round((Date.now() - new Date(f.range_start).getTime()) / 86400000)) : days;

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

  // ── 5. Aprendizaje: adsets trabados (LEARNING_LIMITED) o progreso ──
  const limited = learning.filter(l => l.status === 'LEARNING_LIMITED');
  for (const l of limited) {
    issues.push({ severity: 'warning', kind: 'learning_limited', event: 'adset',
      message: `"${l.name}" en LEARNING LIMITED — no junta suficientes conversiones (${l.conversions ?? '?'}/${LEARNING_TARGET}); subí budget/audiencia o consolidá para que aprenda.`, detail: { conversions: l.conversions } });
  }

  if (issues.length === 0) {
    issues.push({ severity: 'info', kind: 'healthy', event: 'pixel', message: 'Pixel sano — todos los eventos disparando y funnel sin cuellos críticos.', detail: {} });
  }

  let score = 100;
  for (const i of issues) score -= i.severity === 'critical' ? 40 : i.severity === 'warning' ? 15 : 0;
  score = Math.max(0, score);

  // Maduración (clave para pixel nuevo + purchase-only)
  const learnAgg = {
    age_days: ageDays,
    purchases: f.purchase,
    purchases_per_week: ageDays > 0 ? Math.round((f.purchase / ageDays) * 7 * 10) / 10 : 0,
    target: LEARNING_TARGET,
    adsets: learning,
    in_learning: learning.filter(l => l.status === 'LEARNING').length,
    success: learning.filter(l => l.status === 'SUCCESS').length,
    limited: limited.length
  };

  const diagnosis = await generateDiagnosis({ funnel: f, pmeta, learning, ageDays });

  return {
    window_days: days,
    funnel_7d: f,
    funnel_today: f,
    rates,
    issues,
    health_score: score,
    maturation: learnAgg,
    diagnosis,
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
