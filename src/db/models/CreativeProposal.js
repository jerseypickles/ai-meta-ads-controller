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
  // URL de la imagen en Meta CDN — cached cuando recuperamos via Meta API.
  // Para proposals viejas sin image_base64, fetcheamos via meta_creative_id
  // y cacheamos aquí. Las URLs de Meta expiran eventualmente, pero se refrescan
  // en el próximo fetch si falla.
  image_url: { type: String, default: '' },
  scene: { type: String, default: '' },
  scene_short: { type: String, default: '' },
  headline: { type: String, default: '' },
  primary_text: { type: String, default: '' },
  link_url: { type: String, default: '' },
  prompt_used: { type: String, default: '' },

  // ═══ DNA — Creative dimensions (Abril 2026) ═══
  // 5 dimensiones trackeadas para Creative DNA system.
  // Cada creativo tiene un DNA unico — combinacion especifica de estas 5.
  // Se usa para CreativeDNA fitness tracking y Apollo evolutivo.
  style: { type: String, default: '', index: true },        // ugly-ad | pov-selfie | overhead-flat | close-up-texture | action-shot
  copy_angle: { type: String, default: '', index: true },   // curiosity | social-proof | urgency | humor | sensory | casual-fun | controversy
  framing: { type: String, default: '', index: true },      // auto-extraido del headline: curiosity | upgrade | obsession | transformation | question | bold-claim | other
  hook_type: { type: String, default: '', index: true },    // question | statement | exclamation | number
  dna_hash: { type: String, default: '', index: true },     // hash deterministico: "style|angle|scene|product|hook"
  // Fase 3 — evolution tracking: que estrategia genero este creativo
  evolution_strategy: { type: String, enum: ['random', 'exploit', 'mutate', 'crossover', 'explore'], default: 'random', index: true },
  parent_dna_hashes: [{ type: String }],   // linaje: si mutate/crossover, hashes de los padres
  generation: { type: Number, default: 0, index: true },  // 0 = random, 1+ = producto de evolucion

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

// Índice 2026-04-24: covering para strategyBreakdown del briefing
// aggregate {$match: {created_at: >=T}, $group: {_id: '$evolution_strategy'}}
// que antes tardaba 7.1s real. Con compound, Mongo puede usar index-only scan.
creativeProposalSchema.index({ created_at: -1, evolution_strategy: 1 });

module.exports = mongoose.model('CreativeProposal', creativeProposalSchema);
