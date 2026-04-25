const mongoose = require('mongoose');

/**
 * DemeterSnapshot — reconciliación diaria entre gasto Meta Ads y revenue Shopify.
 *
 * Un snapshot por día (YYYY-MM-DD en ET). Idempotente: el cron lo regenera
 * cada día y también re-computa los últimos 7 días para capturar refunds
 * retroactivos.
 *
 * Métricas:
 *   meta_spend        — total spend de Meta Ads ese día (suma MetricSnapshot)
 *   gross_sales       — total bruto de Shopify (sin descuentos/refunds aplicados)
 *   discounts         — descuentos aplicados a las orders
 *   refunds           — refunds emitidos ese día (puede aplicar a orders pasadas)
 *   net_sales         — gross - discounts - refunds
 *   shopify_fees_est  — estimado de fees de Shopify Payments (2.9% + $0.30/order)
 *   net_after_fees    — métrica primaria: net_sales - shopify_fees_est
 *   orders_count      — número de orders ese día (excluye canceladas)
 *
 * Derivadas:
 *   meta_roas         — Meta-reported (purchase_value / spend del día)
 *   cash_roas         — net_after_fees / meta_spend (la métrica que importa)
 *   gap_pct           — (meta_roas - cash_roas) / meta_roas * 100
 *                       — gap > 0 = Meta sobre-atribuye vs cash real
 */
const demeterSnapshotSchema = new mongoose.Schema({
  // Fecha en ET (YYYY-MM-DD). Único por día.
  date_et: {
    type: String,
    required: true,
    unique: true,
    index: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  // Bordes UTC del día ET — guardados para auditoría
  range_start_utc: { type: Date, required: true },
  range_end_utc: { type: Date, required: true },

  // ═══ Meta side ═══
  meta_spend: { type: Number, default: 0, min: 0 },
  meta_purchase_value: { type: Number, default: 0, min: 0 },
  meta_roas: { type: Number, default: 0, min: 0 },

  // ═══ Shopify side ═══
  // gross_sales = subtotal_price (productos sin tax ni shipping). Match con
  // "AOV × orders" de Shopify Analytics. NO match con "Total sales".
  gross_sales: { type: Number, default: 0, min: 0 },
  discounts: { type: Number, default: 0, min: 0 },
  refunds: { type: Number, default: 0, min: 0 },
  net_sales: { type: Number, default: 0 },              // gross - discounts - refunds (productos)
  // ─── Refactor 2026-04-25: campos nuevos para reconciliación cash real ───
  // total_sales = subtotal + shipping + tax - discounts (matchea Shopify "Total sales")
  total_sales: { type: Number, default: 0, min: 0 },
  taxes: { type: Number, default: 0, min: 0 },          // tax recolectado (vas a pagar al gobierno)
  shipping: { type: Number, default: 0, min: 0 },       // shipping cobrado al cliente
  shopify_fees_est: { type: Number, default: 0, min: 0 },
  net_after_fees: { type: Number, default: 0 },         // legacy: net_sales - fees
  // Cash que entra realmente al banco (lo que importa contablemente)
  cash_to_bank: { type: Number, default: 0 },           // total_sales - refunds - shopify_fees
  // Tuyo de verdad: cash_to_bank - tax que pasás al gobierno
  net_for_merchant: { type: Number, default: 0 },       // cash_to_bank - taxes
  orders_count: { type: Number, default: 0, min: 0 },

  // ═══ Reconciliación ═══
  // cash_roas ahora lee net_for_merchant (lo que es REALMENTE tuyo, post-tax).
  // Antes era net_after_fees (que ignoraba tax) — número inflado.
  cash_roas: { type: Number, default: 0 },             // net_for_merchant / meta_spend
  gap_pct: { type: Number, default: 0 },               // (meta_roas - cash_roas) / meta_roas * 100

  // ═══ Meta operacional del snapshot ═══
  computed_at: { type: Date, default: Date.now },
  computation_ms: { type: Number, default: 0 },
  shopify_orders_fetched: { type: Number, default: 0 },
  shopify_refunds_fetched: { type: Number, default: 0 },
  computation_error: { type: String, default: null }
});

demeterSnapshotSchema.index({ date_et: -1 });
demeterSnapshotSchema.index({ computed_at: -1 });

module.exports = mongoose.model('DemeterSnapshot', demeterSnapshotSchema);
