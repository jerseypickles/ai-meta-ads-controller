const mongoose = require('mongoose');

/**
 * HermesReference — imágenes de referencia que Hermes pasa a gpt-image-2.
 *
 * gpt-image-2 genera con mucha más fidelidad cuando recibe imágenes de
 * referencia (via images.edit multi-image input). El creador sube fotos
 * del producto REAL de Jersey Pickles + estilos/paletas que quiere
 * mantener — gpt-image-2 las usa como ancla visual en cada ciclo, así los
 * creativos muestran el producto real y no uno inventado.
 *
 * Match: cada referencia se etiqueta con los offer types a los que aplica
 * (offer_match). 'any' = aplica a todos. El agente carga las refs activas
 * que matcheen el offer del ciclo y se las pasa a gpt-image-2.
 */
const hermesReferenceSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  image_base64: { type: String, required: true },
  mime_type: { type: String, default: 'image/png' },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },

  // A qué offers aplica esta referencia. 'any' = todos los offers.
  // Valores válidos: free_chamoy, free_tajin, free_olive_flight, free_olive,
  // free_pickle_flight, free_big_dill, free_pickle_juice, 'any'.
  offer_match: { type: [String], default: ['any'], index: true },

  // Propósito — informativo, para agrupar en la UI del tab.
  purpose: { type: String, enum: ['product', 'style', 'color'], default: 'product' },

  active: { type: Boolean, default: true, index: true },
  notes: { type: String, default: '' },

  uploaded_at: { type: Date, default: Date.now, index: true },
  uploaded_by: { type: String, default: 'user' }
});

hermesReferenceSchema.index({ active: 1, offer_match: 1 });

module.exports = mongoose.model('HermesReference', hermesReferenceSchema);
