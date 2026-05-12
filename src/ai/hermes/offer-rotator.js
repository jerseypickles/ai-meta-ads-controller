/**
 * Offer Rotator — selecciona qué oferta promueve Hermes en este ciclo.
 *
 * Tres ofertas core (definidas en sesión de planning 12-may-2026):
 *   1. free_pickle      — gateway, always-on, 50% weight
 *   2. big_dill_chamoy  — hero product, 30% weight
 *   3. mystery_pickle   — repeat driver, Tuesday-themed, 20% weight
 *
 * En Fase 3 los weights pasarán a ser dinámicos según performance
 * (más visits/$ → más weight). Por ahora son estáticos para validar
 * el ciclo end-to-end.
 */

const OFFERS = {
  free_pickle: {
    type: 'free_pickle',
    weight: 0.50,
    title: 'FREE PICKLE ON YOUR 1ST VISIT',
    short_label: 'Free pickle',
    description: 'Walk in, get a free pickle. No purchase required.',
    valid_until: null,  // always-on
    voice_hooks: [
      "The first pickle's on us.",
      "Free pickle on us. Walk in, taste it.",
      "First-timers get a free pickle — that's the whole pitch."
    ]
  },
  big_dill_chamoy: {
    type: 'big_dill_chamoy',
    weight: 0.30,
    title: 'BIG DILL CHAMOY — LIMITED TIME',
    short_label: 'Big Dill Chamoy',
    description: 'Our chamoy-dipped pickle popsicle. Only in NJ.',
    valid_until: null,  // se actualiza si decides hacerla limited-time
    voice_hooks: [
      "Big Dill Chamoy. Pickle. Chamoy. Stick. Done.",
      "We dipped a pickle in chamoy and put it on a stick. Come try it.",
      "Yes, it's a pickle popsicle. Yes, you want one."
    ]
  },
  mystery_pickle: {
    type: 'mystery_pickle',
    weight: 0.20,
    title: 'MYSTERY PICKLE TUESDAYS',
    short_label: 'Mystery Pickle',
    description: 'New flavor every Tuesday. We pick. You taste.',
    valid_until: null,
    voice_hooks: [
      "Tuesday is Mystery Pickle day. We pick the flavor. No spoilers.",
      "Every Tuesday: one new flavor. You'll know when you taste it.",
      "Mystery Pickle Tuesdays. The flavor changes weekly. So do the regulars."
    ]
  }
};

/**
 * Selecciona una oferta usando weighted random pick.
 * @returns {Object} offer config
 */
function pickOffer() {
  const random = Math.random();
  let cumulative = 0;
  for (const offer of Object.values(OFFERS)) {
    cumulative += offer.weight;
    if (random <= cumulative) return offer;
  }
  // Fallback (no debería pasar si weights suman 1)
  return OFFERS.free_pickle;
}

/**
 * Devuelve oferta específica por tipo.
 */
function getOffer(type) {
  return OFFERS[type] || null;
}

/**
 * Lista todas las ofertas activas (para UI/debug).
 */
function listOffers() {
  return Object.values(OFFERS);
}

/**
 * Valida que los weights sumen ~1.0 (sanity check).
 */
function validateWeights() {
  const total = Object.values(OFFERS).reduce((sum, o) => sum + o.weight, 0);
  return Math.abs(total - 1.0) < 0.01;
}

module.exports = { OFFERS, pickOffer, getOffer, listOffers, validateWeights };
