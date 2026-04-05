const mongoose = require('mongoose');

/**
 * ProductBank — Banco de productos con PNGs de referencia para Creative Agent.
 * Cada producto tiene imágenes de referencia que Gemini usa para generar
 * creativos en diferentes escenas.
 */
const productBankSchema = new mongoose.Schema({
  product_name: { type: String, required: true },
  product_slug: { type: String, required: true, unique: true, index: true },
  link_url: { type: String, default: 'https://jerseypickles.com' },

  // PNGs de referencia subidos por el usuario
  png_references: [{
    filename: { type: String, required: true },
    original_name: { type: String, default: '' },
    type: { type: String, enum: ['front-view', 'top-down', 'side', 'open', 'other'], default: 'front-view' },
    uploaded_at: { type: Date, default: Date.now },
    _id: false
  }],

  // Performance tracking — se actualiza cuando el Account Agent mide impacto
  performance: {
    total_ads_created: { type: Number, default: 0 },
    total_spend: { type: Number, default: 0 },
    total_purchases: { type: Number, default: 0 },
    avg_roas: { type: Number, default: 0 },
    best_scene: { type: String, default: '' },
    worst_scene: { type: String, default: '' }
  },

  // Scene performance — qué escenas funcionan mejor para este producto
  scene_performance: [{
    scene: { type: String },
    ads_created: { type: Number, default: 0 },
    avg_roas: { type: Number, default: 0 },
    total_spend: { type: Number, default: 0 },
    _id: false
  }],

  active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductBank', productBankSchema);
