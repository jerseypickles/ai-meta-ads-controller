const mongoose = require('mongoose');

const creativeAssetSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  original_name: { type: String, required: true },
  file_path: { type: String, required: true },
  file_type: { type: String, required: true },
  media_type: { type: String, enum: ['image', 'video'], required: true },

  // Propósito: ad-ready = se usa en ads, reference = contexto de estilo para IA
  purpose: { type: String, enum: ['ad-ready', 'reference'], default: 'ad-ready' },
  // Estilo visual del creative
  style: { type: String, enum: ['ugly-ad', 'organic', 'polished', 'ugc', 'meme', 'other'], default: 'other' },

  // AI generation tracking
  generated_by: { type: String, enum: ['manual', 'openai', 'flux', 'seedream', 'gemini', 'grok'], default: 'manual' },
  generation_prompt: { type: String, default: null },
  scene_label: { type: String, default: null },          // Scene description (e.g. "Cocina desordenada", "Car dashboard")
  reference_asset_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CreativeAsset' }],

  // Meta API references (después de subir)
  meta_image_hash: { type: String, default: null },
  meta_video_id: { type: String, default: null },
  meta_creative_id: { type: String, default: null },
  uploaded_to_meta: { type: Boolean, default: false },
  uploaded_at: { type: Date, default: null },

  // Ad format: feed (1:1) or stories (9:16)
  ad_format: { type: String, enum: ['feed', 'stories', ''], default: '' },

  // Metadata del creative
  headline: { type: String, default: '' },
  body: { type: String, default: '' },
  description: { type: String, default: '' },
  cta: { type: String, default: 'SHOP_NOW' },
  link_url: { type: String, default: '' },

  // Producto — identificado por IA o manualmente
  product_name: { type: String, default: '' },
  product_line: { type: String, default: '' },   // Linea de producto (ej: "Pickle Salsa", "Pickles", "Olives")
  flavor: { type: String, default: '' },          // Sabor/variante (ej: "Regular Dill", "Hot Mild", "Sour Tomatoes")
  product_detected_by: { type: String, enum: ['manual', 'ai', ''], default: '' },

  // Pareja de formatos: vincula 1:1 (feed) con 9:16 (stories) del mismo creative
  paired_asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CreativeAsset', default: null },

  // Organización
  tags: [{ type: String }],
  notes: { type: String, default: '' },

  // Tracking de uso
  times_used: { type: Number, default: 0 },
  used_in_ads: [{ type: String }],
  used_in_adsets: [{ type: String }],   // Ad set IDs donde se usa este creativo
  avg_ctr: { type: Number, default: 0 },
  avg_roas: { type: Number, default: 0 },

  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
});

creativeAssetSchema.index({ status: 1, created_at: -1 });
creativeAssetSchema.index({ purpose: 1, style: 1 });
creativeAssetSchema.index({ product_line: 1, flavor: 1 });

module.exports = mongoose.model('CreativeAsset', creativeAssetSchema);
