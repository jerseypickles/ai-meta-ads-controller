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

// Variantes — la INTERACCIÓN vende: una mano levanta/saca un pickle chip y la
// salsa/brine chorrea glossy. Eso da hambre. Evitar el "sostener quieto" (DNA
// pobre). Como es image-to-video, el movimiento anima lo que YA está en la foto
// (idealmente una mano con un chip). {product} = nombre del producto.
const VARIANTS = [
  {
    // HERO — el que vende: levantar el chip y que la salsa chorree.
    key: 'lift_drip',
    motion: 'A hand slowly lifts a single pickle chip up out of the {product} jar. ' +
            'A glossy strand of sauce / brine drips slowly off the chip back into the jar. ' +
            'The chip stays in focus, the motion is smooth and appetizing.'
  },
  {
    // Mojar en chamoy y que chorree (para productos con salsa).
    key: 'dip_drip',
    motion: 'A hand holds a sauced pickle chip just above the {product} tub and the thick ' +
            'glossy chamoy sauce drips slowly off it in a stretching strand back into the tub. ' +
            'Mouth-watering, the chip glistening and in focus.'
  },
  {
    // Sacar lentamente el chip cubierto de salsa.
    key: 'pull_up',
    motion: 'A hand slowly pulls a sauce-coated pickle chip upward out of the {product} tub, ' +
            'the chip glistening wet, a little sauce dripping off the bottom edge.'
  },
  {
    // Fallback de bajo movimiento para fotos donde NO hay mano/chip (solo frasco):
    // una gota cae al frasco, mínima animación que no distorsiona.
    key: 'micro_drip',
    motion: 'A single glossy drop of brine slowly drips off the rim of the {product} jar ' +
            'back inside. Minimal movement, product stays sharp and undistorted.'
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
