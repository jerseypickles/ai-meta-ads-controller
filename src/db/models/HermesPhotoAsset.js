const mongoose = require('mongoose');

/**
 * HermesPhotoAsset — banco de fotos pro reales que Hermes usa como base.
 *
 * A diferencia de Apollo (que genera imágenes 100% con Gemini), Hermes parte
 * de fotos profesionales (ej. el "Big Dill Chamoy" del 12-may-2026) y solo
 * compone overlays + brand sticker encima. Por eso necesita un banco.
 *
 * El usuario sube fotos desde el dashboard. Las taggea por offer compatibles
 * (free_pickle, big_dill_chamoy, mystery_pickle) y producto. Hermes pickea
 * según rotation + performance histórica.
 */
const hermesPhotoAssetSchema = new mongoose.Schema({
  // Identificación
  filename: { type: String, required: true },
  url: { type: String, default: '' },           // URL pública si está en disk/S3
  image_base64: { type: String, default: '' },  // Fallback inline (consistente con Apollo pattern)
  mime_type: { type: String, default: 'image/jpeg' },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },

  // Tags + classification
  tags: [{ type: String, index: true }],        // ej: ['hero', 'big-dill', 'product-only', 'with-hand']
  offer_types: [{ type: String, enum: ['free_pickle', 'big_dill_chamoy', 'mystery_pickle', 'any'], index: true }],
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductBank', default: null },
  mood: { type: String, enum: ['playful', 'gourmet', 'casual', 'bold', 'cozy', ''], default: '' },

  // Estado
  active: { type: Boolean, default: true, index: true },
  archived: { type: Boolean, default: false },

  // Rotation tracking — para que Hermes no use siempre la misma
  usage_count: { type: Number, default: 0 },
  last_used_at: { type: Date, default: null },

  // Performance agregada (sumada de los HermesProposal que la usaron)
  performance: {
    used_in_ads_count: { type: Number, default: 0 },
    total_spend: { type: Number, default: 0 },
    total_link_clicks: { type: Number, default: 0 },
    avg_ctr: { type: Number, default: 0 },
    avg_cost_per_click: { type: Number, default: 0 },
    estimated_visits: { type: Number, default: 0 },
    manual_visits_attributed: { type: Number, default: 0 },
    last_measured_at: { type: Date, default: null }
  },

  // Metadata
  uploaded_at: { type: Date, default: Date.now, index: true },
  uploaded_by: { type: String, default: 'user' },
  notes: { type: String, default: '' }
});

// Índices para queries comunes de Hermes
hermesPhotoAssetSchema.index({ active: 1, offer_types: 1, last_used_at: 1 });

module.exports = mongoose.model('HermesPhotoAsset', hermesPhotoAssetSchema);
