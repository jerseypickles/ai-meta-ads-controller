const mongoose = require('mongoose');

/**
 * HermesStoreVisit — log manual de visitas físicas a la tienda NJ.
 *
 * Como elegimos NO usar lead form / email capture, el tracking de foot traffic
 * es semi-manual: cuando alguien llega a la tienda y menciona el ad / oferta,
 * alguien en tienda registra la visita en el dashboard.
 *
 * Esto es ground truth que cruza contra los estimated_store_visits de Meta.
 */
const hermesStoreVisitSchema = new mongoose.Schema({
  // Timestamp
  visited_at: { type: Date, default: Date.now, index: true },

  // Source — qué oferta dijeron que vieron
  source_offer: {
    type: String,
    enum: ['free_pickle', 'big_dill_chamoy', 'mystery_pickle', 'other', 'unknown'],
    required: true,
    index: true
  },
  source_proposal_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HermesProposal', default: null },
  source_platform: { type: String, enum: ['facebook', 'instagram', 'unknown'], default: 'unknown' },

  // Conversion outcome
  converted_to_purchase: { type: Boolean, default: false },
  purchase_amount: { type: Number, default: 0 },
  products_bought: [{ type: String }],                  // ej ['classic dill', 'big-dill-chamoy']

  // Customer info (opcional, sin PII obligatorio)
  customer_zip: { type: String, default: '' },          // útil para validar radio targeting
  is_first_visit: { type: Boolean, default: null },     // null si no se preguntó
  visitor_party_size: { type: Number, default: 1 },     // si vinieron en grupo

  // Metadata
  logged_by: { type: String, default: '' },             // nombre del empleado o "system"
  notes: { type: String, default: '' },

  created_at: { type: Date, default: Date.now }
});

// Índices comunes para stats
hermesStoreVisitSchema.index({ visited_at: -1, source_offer: 1 });
hermesStoreVisitSchema.index({ source_proposal_id: 1 });

module.exports = mongoose.model('HermesStoreVisit', hermesStoreVisitSchema);
