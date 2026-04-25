/**
 * Shopify Admin API client — usado por Demeter para reconciliación cash.
 *
 * Rate limiting: Shopify Admin API por default permite 2 calls/sec en plans
 * estándar (40 calls/sec en Plus). Usamos Bottleneck para garantizar 2/sec
 * conservador. Cursor pagination para orders/refunds — el reservoir bucket
 * de Shopify se replenisha automáticamente entre calls.
 *
 * No persistimos las orders crudas — solo agregamos los totales necesarios
 * para DemeterSnapshot. Si en el futuro queremos atribución per-creative
 * (UTMs), ahí sí guardaremos orders raw.
 */

const axios = require('axios');
const Bottleneck = require('bottleneck');
const config = require('../../config');
const logger = require('../utils/logger');

const limiter = new Bottleneck({
  minTime: 500,           // 2 calls/sec (más conservador que el límite real)
  maxConcurrent: 1
});

function getBaseUrl() {
  if (!config.shopify.shopDomain) {
    throw new Error('SHOPIFY_SHOP_DOMAIN no configurado en env');
  }
  return `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`;
}

function getHeaders() {
  if (!config.shopify.adminToken) {
    throw new Error('SHOPIFY_ADMIN_TOKEN no configurado en env');
  }
  return {
    'X-Shopify-Access-Token': config.shopify.adminToken,
    'Content-Type': 'application/json'
  };
}

/**
 * GET helper con rate limit + retry exponencial en 429/5xx.
 * Retorna { data, headers } para que callers lean Link header (cursor).
 */
async function get(path, params = {}, attempt = 1) {
  return limiter.schedule(async () => {
    try {
      const res = await axios.get(`${getBaseUrl()}${path}`, {
        headers: getHeaders(),
        params,
        timeout: 30000
      });
      return { data: res.data, headers: res.headers };
    } catch (err) {
      const status = err.response?.status;
      // Retry transient — 429 (rate limit) o 5xx
      if ((status === 429 || (status >= 500 && status < 600)) && attempt <= 3) {
        const wait = Math.min(2 ** attempt * 1000, 8000);
        logger.warn(`[shopify] ${status} en ${path}, retry ${attempt}/3 tras ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        return get(path, params, attempt + 1);
      }
      throw new Error(
        `Shopify ${path} falló: ${status || 'no-status'} ${err.response?.data?.errors || err.message}`
      );
    }
  });
}

/**
 * Parse Link header de Shopify cursor pagination.
 * Header format: <url1>; rel="previous", <url2>; rel="next"
 * Retorna page_info del cursor "next" o null si no hay más páginas.
 */
function parseNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader.split(',').find(p => p.includes('rel="next"'));
  if (!next) return null;
  const m = next.match(/page_info=([^&>]+)/);
  return m ? m[1] : null;
}

/**
 * Fetch ALL orders en un date range (auto-pagination con cursor).
 * Filtra por created_at (cuándo se hizo la order — no cuándo pagada).
 *
 * Returns: array de orders con campos relevantes para reconciliación:
 *   total_price, subtotal_price, total_discounts, total_tax,
 *   current_total_price, financial_status, created_at, id, name
 *
 * Excluye orders canceladas (cancelled_at != null).
 */
async function getOrdersForDateRange(startUtc, endUtc) {
  const orders = [];
  const limit = 250;
  let pageInfo = null;

  // Initial query con date range
  const initialParams = {
    status: 'any',
    created_at_min: startUtc.toISOString(),
    created_at_max: endUtc.toISOString(),
    limit,
    fields: 'id,name,created_at,cancelled_at,financial_status,total_price,subtotal_price,total_discounts,total_tax,current_total_price,refunds'
  };

  let { data, headers } = await get('/orders.json', initialParams);
  orders.push(...(data.orders || []));
  pageInfo = parseNextCursor(headers.link);

  // Pagination loop — Shopify cursor based, NO date params allowed con page_info
  while (pageInfo) {
    ({ data, headers } = await get('/orders.json', { limit, page_info: pageInfo }));
    orders.push(...(data.orders || []));
    pageInfo = parseNextCursor(headers.link);
  }

  // Filtrar canceladas (Shopify las incluye con status=any)
  return orders.filter(o => !o.cancelled_at);
}

/**
 * Fetch refunds emitidos en un date range.
 * Refunds tienen processed_at separado de la order original — un refund del
 * día X puede corresponder a order del día X−7.
 *
 * Shopify NO tiene un endpoint /refunds.json global con filtro por fecha.
 * Workaround: traer orders del rango Y de los N días anteriores que pueden
 * tener refunds nuevos, e iterar refunds inline.
 *
 * Para nuestro caso (snapshot diario + re-compute 7 días) traemos orders
 * de los últimos 60 días y filtramos refunds.processed_at en rango.
 */
async function getRefundsForDateRange(startUtc, endUtc, lookbackDays = 60) {
  const lookbackStart = new Date(startUtc.getTime() - lookbackDays * 86400000);
  const orders = await getOrdersForDateRange(lookbackStart, endUtc);

  const refunds = [];
  for (const o of orders) {
    for (const r of (o.refunds || [])) {
      const processedAt = new Date(r.processed_at);
      if (processedAt >= startUtc && processedAt <= endUtc) {
        // Sumar el valor del refund — Shopify guarda transactions[].amount
        const amount = (r.transactions || [])
          .filter(tx => tx.kind === 'refund' && tx.status === 'success')
          .reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
        refunds.push({
          order_id: o.id,
          order_name: o.name,
          processed_at: processedAt,
          amount
        });
      }
    }
  }
  return refunds;
}

/**
 * Health check — verifica que el token funcione.
 */
async function ping() {
  try {
    const { data } = await get('/shop.json');
    return { ok: true, shop: data.shop?.myshopify_domain, plan: data.shop?.plan_name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getOrdersForDateRange, getRefundsForDateRange, ping };
