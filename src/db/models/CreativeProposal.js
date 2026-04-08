const mongoose = require('mongoose');

/**
 * CreativeProposal — Creativos generados por el Creative Agent pendientes de aprobacion.
 * El usuario aprueba o rechaza, y el agente aprende de las decisiones.
 */
const creativeProposalSchema = new mongoose.Schema({
  // Target
  adset_id: { type: String, required: true, index: true },
  adset_name: { type: String, default: '' },

  // Product used
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductBank' },
  product_name: { type: String, default: '' },

  // Generated content
  image_path: { type: String, default: '' },
  image_filename: { type: String, default: '' },
  image_base64: { type: String, default: '' }, // fallback: store image in DB if filesystem is ephemeral
  scene: { type: String, default: '' },
  scene_short: { type: String, default: '' },
  headline: { type: String, default: '' },
  primary_text: { type: String, default: '' },
  link_url: { type: String, default: '' },
  prompt_used: { type: String, default: '' },

  // Status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'uploaded', 'failed', 'ready', 'testing', 'graduated', 'killed', 'expired'],
    default: 'pending',
    index: true
  },

  // Approval
  decided_at: { type: Date, default: null },
  rejection_reason: { type: String, default: '' },

  // After upload to Meta
  meta_ad_id: { type: String, default: null },
  meta_creative_id: { type: String, default: null },
  meta_ad_name: { type: String, default: '' },

  // Feedback humano sobre calidad del creativo
  human_feedback: {
    rating: { type: String, enum: ['good', 'bad', null], default: null },
    reason: { type: String, enum: ['wrong_product', 'bad_image', 'bad_copy', 'wrong_colors', 'not_realistic', 'other', null], default: null },
    note: { type: String, default: '' },
    rated_at: { type: Date, default: null }
  },

  // Performance tracking (filled by impact measurement)
  performance: {
    roas_7d: { type: Number, default: null },
    spend_7d: { type: Number, default: null },
    purchases_7d: { type: Number, default: null },
    ctr_7d: { type: Number, default: null },
    measured_at: { type: Date, default: null }
  },

  created_at: { type: Date, default: Date.now, index: true }
});

creativeProposalSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('CreativeProposal', creativeProposalSchema);
