// ═══════════════════════════════════════════════════════════════════════════════
// Webhook de Shopify → Meta CAPI. Fase 1: orders/paid → Purchase.
// Montado en /webhooks/shopify con express.raw (HMAC necesita el body crudo) y
// FUERA de /api (Shopify no manda JWT). Responde 200 rápido + procesa async.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const config = require('../../../config');
const logger = require('../../utils/logger');
const router = express.Router();

function verifyHmac(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', config.shopify.webhookSecret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (_) { return false; }
}

// POST /webhooks/shopify/orders-paid
router.post('/orders-paid', (req, res) => {
  const raw = req.body; // Buffer (express.raw)
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyHmac(raw, hmac)) {
    logger.warn('[CAPI] webhook orders/paid: HMAC inválido — rechazado');
    return res.status(401).send('invalid hmac');
  }
  // Responder 200 YA (Shopify reintenta si tarda); el envío a Meta va async.
  res.status(200).send('ok');
  let order;
  try { order = JSON.parse(raw.toString('utf8')); }
  catch (e) { return logger.error(`[CAPI] webhook body no parseable: ${e.message}`); }
  const { processOrderPaid } = require('../../integrations/meta-capi');
  processOrderPaid(order)
    .then(r => { if (r && !r.skipped) logger.debug(`[CAPI] order ${order.id} procesada: ${JSON.stringify(r)}`); })
    .catch(e => logger.error(`[CAPI] processOrderPaid order=${order?.id} falló: ${e.message}`));
});

module.exports = router;
