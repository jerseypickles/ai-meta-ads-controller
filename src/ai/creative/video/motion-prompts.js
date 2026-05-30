// ═══════════════════════════════════════════════════════════════════════════════
// Apollo Video — BANCO DE MOTION PROMPTS (Seedance 2.0 image-to-video)
// Estilo UGC handheld iPhone, micro-motion. La regla de oro: MÍNIMO movimiento +
// "label readable" → protege la fidelidad del producto (el frame de origen lo
// congela; el video solo agrega micro-vida). Clips ≤5s. Ver memoria apollo-video.
// ═══════════════════════════════════════════════════════════════════════════════

// Base compartida — el "ADN" de todos los motion prompts (UGC, sin cinemático).
// Empuja FUERTE hacia foto-realismo y color fiel: el modelo tiende a sobre-saturar
// y dar "look AI"; estas instrucciones lo frenan para que pase el ojo humano.
const BASE_STYLE =
  'Photorealistic real handheld iPhone video, looks shot by a real person, NOT AI-generated. ' +
  'Almost no movement, just ambient micro-motion. ' +
  'Barely perceptible handheld micro-drift, faint focus breathing, no smooth gimbal motion. ' +
  'Authentic unedited phone footage, natural realistic lighting, true-to-life accurate colors, ' +
  'neutral white balance, NO color grading, NO oversaturation, NO boosted contrast, ' +
  'preserve the exact original colors of the source image, ' +
  'real skin tones, natural film grain, realistic textures and imperfections, ' +
  'no cinematic effects, no glossy CGI look, no slow-motion, no zoom, no plastic surfaces.';

// Variantes — cada una aporta UN micro-gesto distinto. Mantener todas low-motion.
// {product} se reemplaza por el nombre del producto (ej. "Jersey Pickles Chamoy").
const VARIANTS = [
  {
    key: 'micro_drip',
    motion: 'A single tiny drop slowly drips back into the open {product} tub. ' +
            'The hand holds the product still just above the tub.'
  },
  {
    key: 'breeze_napkin',
    motion: 'A faint breeze flutters the edge of the crumpled kraft paper napkin nearby. ' +
            'The {product} sits still, product in focus.'
  },
  {
    key: 'wet_shimmer',
    motion: 'Sunlight shimmers faintly on the wet surface of the {product}. ' +
            'No movement other than the light catching the glaze.'
  },
  {
    key: 'hand_hold',
    motion: 'A hand holds the {product} still in frame, barely perceptible natural hand tremor. ' +
            'Nothing else moves.'
  },
  {
    key: 'steam_curl',
    motion: 'A barely visible curl of cool condensation/vapor rises slowly off the fresh {product}. ' +
            'Everything else stays still.'
  }
];

/**
 * Construye el prompt completo de motion para un producto + variante.
 * @param {string} productName - ej. "Jersey Pickles Chamoy"
 * @param {string} [variantKey] - si se omite, rota/elige una
 */
function buildMotionPrompt(productName, variantKey = null) {
  const v = (variantKey && VARIANTS.find(x => x.key === variantKey)) || VARIANTS[0];
  const motion = v.motion.replace(/\{product\}/g, productName);
  const readable = `Keep the ${productName} label readable and undistorted at all times.`;
  return {
    variant: v.key,
    prompt: `${motion} ${BASE_STYLE} ${readable}`
  };
}

/** Elige una variante por índice rotativo (para variar entre generaciones). */
function pickVariant(index = 0) {
  return VARIANTS[index % VARIANTS.length].key;
}

module.exports = { buildMotionPrompt, pickVariant, VARIANTS, BASE_STYLE };
