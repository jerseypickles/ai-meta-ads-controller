// ═══════════════════════════════════════════════════════════════════════════════
// META CONVERSIONS API (CAPI) — envío server-side de eventos. Fase 1: Purchase.
// - Construye el payload desde el webhook orders/paid de Shopify.
// - Hashea PII con SHA-256 (email, teléfono, nombre, dirección, customer id).
// - event_id = purchase_<orderId> → DEDUPLICA con el custom pixel del navegador.
// - NO hashea: ip, user_agent, fbp, fbc.
// - Reintentos vía CapiEvent (Mongo) + cron sweeper. Sin Redis.
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const CapiEvent = require('../db/models/CapiEvent');

const MAX_ATTEMPTS = parseInt(process.env.META_CAPI_MAX_ATTEMPTS || '6', 10);

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Normalizadores antes de hashear (reglas de Meta).
function hEmail(v) { return v ? sha256(String(v).trim().toLowerCase()) : null; }
function hPhone(v) { const d = String(v || '').replace(/\D/g, ''); return d ? sha256(d) : null; }      // solo dígitos, E.164 sin +
function hName(v) { return v ? sha256(String(v).trim().toLowerCase()) : null; }
function hCity(v) { const c = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, ''); return c ? sha256(c) : null; }
function hState(v) { const s = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, ''); return s ? sha256(s) : null; }
function hZip(v) { const z = String(v || '').trim().toLowerCase().split('-')[0].replace(/\s/g, ''); return z ? sha256(z) : null; }
function hCountry(v) { const c = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, ''); return c ? sha256(c) : null; }
function hId(v) { return (v != null && v !== '') ? sha256(String(v).trim().toLowerCase()) : null; }

// arma user_data dejando solo las claves con valor (Meta espera arrays para hashed).
function buildUserData(order) {
  const cust = order.customer || {};
  const ship = order.shipping_address || order.billing_address || {};
  const cd = order.client_details || {};

  // fbp/fbc desde note_attributes (Opción A — el custom pixel los guarda como cart attributes).
  const attrs = {};
  for (const a of (order.note_attributes || [])) if (a && a.name) attrs[a.name] = a.value;
  const fbp = attrs._fbp || attrs.fbp || null;
  const fbc = attrs._fbc || attrs.fbc || null;

  const ud = {};
  const em = hEmail(order.email || cust.email); if (em) ud.em = [em];
  const ph = hPhone(order.phone || cust.phone || ship.phone); if (ph) ud.ph = [ph];
  const fn = hName(cust.first_name || ship.first_name); if (fn) ud.fn = [fn];
  const ln = hName(cust.last_name || ship.last_name); if (ln) ud.ln = [ln];
  const ct = hCity(ship.city); if (ct) ud.ct = [ct];
  const st = hState(ship.province_code); if (st) ud.st = [st];
  const zp = hZip(ship.zip); if (zp) ud.zp = [zp];
  const co = hCountry(ship.country_code); if (co) ud.country = [co];
  const ext = hId(cust.id); if (ext) ud.external_id = [ext];
  if (cd.browser_ip) ud.client_ip_address = cd.browser_ip;
  if (cd.user_agent) ud.client_user_agent = cd.user_agent;
  if (fbp) ud.fbp = fbp;
  if (fbc) ud.fbc = fbc;
  return ud;
}

/** Construye el evento Purchase (un objeto del array data[]). */
function buildPurchasePayload(order) {
  const items = order.line_items || [];
  const numItems = items.reduce((s, li) => s + (parseInt(li.quantity) || 0), 0);
  const eventTime = Math.floor(new Date(order.processed_at || order.created_at || Date.now()).getTime() / 1000);
  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: `purchase_${order.id}`,
    action_source: 'website',
    event_source_url: order.order_status_url || (order.landing_site_ref || 'https://jerseypickles.com/'),
    user_data: buildUserData(order),
    custom_data: {
      currency: order.currency || 'USD',
      value: parseFloat(order.total_price || order.current_total_price || 0),
      content_ids: items.map(li => String(li.product_id)).filter(Boolean),
      contents: items.map(li => ({ id: String(li.product_id), quantity: parseInt(li.quantity) || 1 })),
      num_items: numItems,
      order_id: String(order.id)
    }
  };
}

/** Construye el evento InitiateCheckout desde el webhook checkouts/create. */
function buildInitiateCheckoutPayload(checkout) {
  const items = checkout.line_items || [];
  const numItems = items.reduce((s, li) => s + (parseInt(li.quantity) || 0), 0);
  const eventTime = Math.floor(new Date(checkout.created_at || Date.now()).getTime() / 1000);
  const token = checkout.token || checkout.id;
  return {
    event_name: 'InitiateCheckout',
    event_time: eventTime,
    event_id: `ic_${token}`,   // estable por checkout → dedup si el navegador usa el mismo
    action_source: 'website',
    event_source_url: checkout.abandoned_checkout_url || 'https://jerseypickles.com/',
    user_data: buildUserData(checkout),   // buildUserData es genérico (lee customer/shipping/note_attributes)
    custom_data: {
      currency: checkout.currency || 'USD',
      value: parseFloat(checkout.total_price || checkout.subtotal_price || 0),
      content_ids: items.map(li => String(li.product_id)).filter(Boolean),
      contents: items.map(li => ({ id: String(li.product_id), quantity: parseInt(li.quantity) || 1 })),
      num_items: numItems
    }
  };
}

/** POST del payload a Meta. Devuelve {ok, events_received, fbtrace_id, error}. */
async function postToMeta(eventPayload) {
  if (!config.capi.accessToken) return { ok: false, error: 'META_CAPI_ACCESS_TOKEN no configurado' };
  const url = `https://graph.facebook.com/${config.capi.apiVersion}/${config.capi.pixelId}/events`;
  const body = { data: [eventPayload] };
  if (config.capi.testEventCode) body.test_event_code = config.capi.testEventCode;
  try {
    const { data } = await axios.post(url, body, { params: { access_token: config.capi.accessToken }, timeout: 15000 });
    return { ok: true, events_received: data.events_received, fbtrace_id: data.fbtrace_id };
  } catch (e) {
    const err = e.response?.data?.error;
    return { ok: false, error: err ? `${err.message} (code ${err.code})` : e.message, fbtrace_id: err?.fbtrace_id };
  }
}

/** Procesa una orden pagada: upsert idempotente + intento de envío. */
async function processOrderPaid(order) {
  if (!config.capi.enabled) return { skipped: 'disabled' };
  const orderId = String(order.id);
  const payload = buildPurchasePayload(order);

  // Idempotencia: upsert por order_id. Si ya está 'sent', no reenviar.
  let doc = await CapiEvent.findOne({ order_id: orderId });
  if (doc && doc.status === 'sent') return { skipped: 'already_sent', order_id: orderId };
  if (!doc) {
    doc = await CapiEvent.create({ order_id: orderId, event_id: payload.event_id, payload, status: 'pending' });
  } else {
    doc.payload = payload; await doc.save();
  }
  return sendCapiEvent(doc);
}

/** Procesa un checkout creado (InitiateCheckout): upsert idempotente por token + envío. */
async function processCheckoutCreated(checkout) {
  if (!config.capi.enabled) return { skipped: 'disabled' };
  const token = String(checkout.token || checkout.id || '');
  if (!token) return { skipped: 'no_token' };
  const dedupKey = `ic_${token}`;   // se guarda en order_id (campo de clave única genérica)
  const payload = buildInitiateCheckoutPayload(checkout);

  let doc = await CapiEvent.findOne({ order_id: dedupKey });
  if (doc && doc.status === 'sent') return { skipped: 'already_sent', key: dedupKey };
  if (!doc) {
    doc = await CapiEvent.create({ order_id: dedupKey, event_id: payload.event_id, event_name: 'InitiateCheckout', payload, status: 'pending' });
  } else {
    doc.payload = payload; await doc.save();
  }
  return sendCapiEvent(doc);
}

/** Envía un CapiEvent (nuevo o reintento) y actualiza su estado. */
async function sendCapiEvent(doc) {
  doc.attempts += 1;
  const r = await postToMeta(doc.payload);
  if (r.ok) {
    doc.status = 'sent'; doc.sent_at = new Date(); doc.events_received = r.events_received; doc.fbtrace_id = r.fbtrace_id || ''; doc.last_error = '';
    await doc.save();
    const testTag = config.capi.testEventCode ? ` · 🧪 TEST(${config.capi.testEventCode})` : ' · LIVE';
    logger.info(`[CAPI] ✅ ${doc.event_name || 'Purchase'} enviado ${doc.order_id} · events_received=${r.events_received} · fbtrace=${r.fbtrace_id}${testTag}`);
    return { ok: true, order_id: doc.order_id, events_received: r.events_received };
  }
  // backoff exponencial: 1m, 2m, 4m, 8m… cap 1h
  const backoffMin = Math.min(60, Math.pow(2, doc.attempts - 1));
  doc.status = doc.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  doc.next_retry_at = new Date(Date.now() + backoffMin * 60000);
  doc.last_error = r.error || 'unknown'; doc.fbtrace_id = r.fbtrace_id || doc.fbtrace_id;
  await doc.save();
  logger.warn(`[CAPI] ⚠ ${doc.event_name || 'Purchase'} falló ${doc.order_id} intento ${doc.attempts}/${MAX_ATTEMPTS}: ${r.error} → ${doc.status === 'failed' ? 'FAILED' : `retry en ${backoffMin}m`}`);
  return { ok: false, order_id: doc.order_id, error: r.error };
}

/** Sweeper de reintentos (cron): reenvía los pending vencidos. */
async function retryFailedCapiEvents() {
  const due = await CapiEvent.find({ status: 'pending', attempts: { $lt: MAX_ATTEMPTS }, next_retry_at: { $lte: new Date() } }).limit(50);
  if (!due.length) return { retried: 0 };
  let ok = 0;
  for (const d of due) { const r = await sendCapiEvent(d); if (r.ok) ok++; }
  logger.info(`[CAPI] sweeper: ${due.length} reintentos · ${ok} ok`);
  return { retried: due.length, ok };
}

module.exports = { processOrderPaid, processCheckoutCreated, retryFailedCapiEvents, buildPurchasePayload, buildInitiateCheckoutPayload, sendCapiEvent };
