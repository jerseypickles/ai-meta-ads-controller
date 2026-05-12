/**
 * Photo Bank — selecciona la foto base para componer un ad.
 *
 * A diferencia de Apollo (genera desde cero con Gemini), Hermes parte de fotos
 * pro reales que el usuario sube al banco. La selección considera:
 *   1. Tag/offer compatibility (foto del Big Dill Chamoy solo aplica a esa oferta)
 *   2. Rotation freshness (evitar usar la misma foto repetidamente)
 *   3. Performance histórica (si una foto convierte mejor, peso mayor)
 *
 * Para MVP: prioriza fotos menos usadas recientemente. Performance ranking
 * llega en Fase 3.
 */

const HermesPhotoAsset = require('../../db/models/HermesPhotoAsset');
const logger = require('../../utils/logger');

/**
 * Selecciona una foto base para el offer dado.
 *
 * Lógica:
 *   - Filtra fotos activas, no archivadas, compatibles con el offer
 *   - Ordena por last_used_at ASC (las menos recientes primero)
 *   - Aplica jitter para no usar siempre la misma cuando hay tie
 *   - Si no hay match estricto, fallback a fotos con offer_type='any'
 *
 * @param {string} offerType - free_pickle | big_dill_chamoy | mystery_pickle
 * @returns {Promise<HermesPhotoAsset|null>}
 */
async function pickPhotoForOffer(offerType) {
  // Primero: match estricto por offer
  let candidates = await HermesPhotoAsset.find({
    active: true,
    archived: false,
    offer_types: offerType
  })
    .sort({ last_used_at: 1, usage_count: 1 })
    .limit(5)
    .lean();

  // Fallback: fotos generales (offer_types incluye 'any')
  if (candidates.length === 0) {
    candidates = await HermesPhotoAsset.find({
      active: true,
      archived: false,
      offer_types: 'any'
    })
      .sort({ last_used_at: 1, usage_count: 1 })
      .limit(5)
      .lean();
  }

  if (candidates.length === 0) {
    logger.warn(`[HERMES-PHOTOBANK] No photos available for offer=${offerType} (and no 'any' fallback)`);
    return null;
  }

  // De las top-5, jitter random para no usar siempre la primera
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  logger.info(`[HERMES-PHOTOBANK] Picked photo ${picked._id} (${picked.filename}) for offer=${offerType} — last used ${picked.last_used_at || 'never'}`);
  return picked;
}

/**
 * Marca una foto como usada (incrementa counter + actualiza timestamp).
 * Llamar después de crear una HermesProposal exitosa.
 */
async function markPhotoUsed(photoAssetId) {
  await HermesPhotoAsset.findByIdAndUpdate(photoAssetId, {
    $inc: { usage_count: 1 },
    $set: { last_used_at: new Date() }
  });
}

/**
 * Cuenta fotos disponibles para un offer (útil para pre-check del cron).
 */
async function countAvailable(offerType) {
  const strict = await HermesPhotoAsset.countDocuments({
    active: true,
    archived: false,
    offer_types: offerType
  });
  const generic = await HermesPhotoAsset.countDocuments({
    active: true,
    archived: false,
    offer_types: 'any'
  });
  return { strict, generic, total: strict + generic };
}

module.exports = { pickPhotoForOffer, markPhotoUsed, countAvailable };
