const mongoose = require('mongoose');

/**
 * HermesProposal — un ad compuesto (foto + overlay + copy) listo para revisión
 * o ya publicado en Meta.
 *
 * Flujo de status:
 *   pending    — Hermes lo generó, espera approval del usuario en dashboard
 *   approved   — usuario aprobó, listo para subir a Meta
 *   rejected   — usuario rechazó (no se sube)
 *   live       — subido a Meta, ad activo
 *   paused     — pausado en Meta
 *   completed  — ciclo terminado (fatigue, oferta cambió, etc)
 *   expired    — generado pero nunca aprobado en 72h → auto-expire
 */
const hermesProposalSchema = new mongoose.Schema({
  // Source asset
  photo_asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HermesPhotoAsset', required: true, index: true },

  // Composed image (foto base + text overlay)
  composed_image_base64: { type: String, default: '' },  // El ad final listo para Meta
  composed_image_url: { type: String, default: '' },

  // Overlay config snapshot — para audit y para regenerar si quieren
  overlay_config: {
    offer_text: { type: String, default: '' },           // ej "FREE PICKLE ON YOUR 1ST VISIT"
    brand_text: { type: String, default: '' },           // ej "JERSEY PICKLES NJ"
    address_text: { type: String, default: '' },         // ej "123 Main St, Trenton NJ"
    overlay_style: { type: String, default: 'bottom-strip' },  // bottom-strip, full-overlay, sticker
    text_color: { type: String, default: '#FFFFFF' },
    background_color: { type: String, default: '#000000' }
  },

  // Generated copy (Claude in JP voice)
  headline: { type: String, default: '' },               // 40 char max recomendado por Meta
  primary_text: { type: String, default: '' },           // 125 char visible, hasta 500 OK
  description: { type: String, default: '' },            // opcional, link description
  cta_button: { type: String, default: 'GET_DIRECTIONS' },

  // Offer this ad promotes
  offer_type: {
    type: String,
    enum: ['free_pickle', 'big_dill_chamoy', 'mystery_pickle'],
    required: true,
    index: true
  },
  offer_details: {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    valid_until: { type: Date, default: null }           // null = always-on
  },

  // Status flow
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'live', 'paused', 'completed', 'expired'],
    default: 'pending',
    index: true
  },
  decided_at: { type: Date, default: null },
  decided_by: { type: String, default: '' },
  rejection_reason: { type: String, default: '' },

  // Meta deployment (cuando se sube)
  meta_campaign_id: { type: String, default: null, index: true },
  meta_adset_id: { type: String, default: null },
  meta_ad_id: { type: String, default: null, index: true },
  meta_creative_id: { type: String, default: null },
  meta_published_at: { type: Date, default: null },

  // Performance tracking (sync from Meta + manual visits)
  performance: {
    spend: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    link_clicks: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    cpm: { type: Number, default: 0 },
    cost_per_click: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    estimated_store_visits: { type: Number, default: 0 },   // From Meta Store Visits if configured
    manual_visits_reported: { type: Number, default: 0 },   // From HermesStoreVisit logs
    measured_at: { type: Date, default: null }
  },

  // Cycle metadata
  cycle_id: { type: String, default: '', index: true },     // ej "hermes_1715543822_abc123"
  generated_at: { type: Date, default: Date.now, index: true }
});

// Índices compuestos para queries del dashboard
hermesProposalSchema.index({ status: 1, generated_at: -1 });
hermesProposalSchema.index({ offer_type: 1, status: 1, generated_at: -1 });

module.exports = mongoose.model('HermesProposal', hermesProposalSchema);
