// ═══════════════════════════════════════════════════════════════════════════════
// video-signals.js — SEÑALES CREATIVAS ABSTRACTAS (Pilar 4 del Dionisio fabuloso).
//
// Las 5 dimensiones del juez (fidelidad/freno_scroll/apetito/autenticidad/calidad) son
// el JUICIO. Esto es más profundo: descompone POR QUÉ un creativo funciona en señales
// abstractas que se correlacionan contra el outcome real → el sistema aprende qué
// PALANCAS creativas mueven la aguja (no solo "bite_tease ganó", sino "los hooks de
// curiosidad + craving de comida generan 2.3x outcome").
//
// Se extraen de la IMAGEN-fuente (Claude visión) — está guardada (no expira como el mp4),
// así que se pueden puntuar videos viejos retroactivamente. La intensidad de motion se
// deriva del motion_variant (no necesita re-analizar el video).
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../../config');
const logger = require('../../../utils/logger');

// Señales que Claude puntúa desde la imagen (0-100). Predictores de performance.
const IMAGE_SIGNALS = ['hook_strength', 'curiosity_gap', 'food_craving', 'visual_energy', 'visual_contrast', 'clarity', 'production_quality', 'authenticity'];
// Intensidad de motion derivada del motion_variant (no de la imagen).
const MOTION_INTENSITY = {
  bite_tease: 85, pinch_twirl: 80, pull_up: 70, lift_drip: 65, dip_drip: 60,
  pour_bowl: 75, cooler_grab: 55, two_hand_open: 50, on_food: 60, fridge_reveal: 45,
  pantry_shelf: 35, table_spread: 20
};
const ALL_SIGNALS = [...IMAGE_SIGNALS, 'motion_intensity'];

const PROMPT = (productName) => `You are a senior UGC food-ad performance analyst. Score this image — the FIRST FRAME of a 5-second vertical video ad for "${productName}" (Jersey Pickles) — on these creative signals, 0-100 each, as PREDICTORS of how the ad will perform in a feed. Be discriminating: SPREAD the scores across the range, do NOT cluster everything at 70-90. A flat/ordinary frame should score low.

- hook_strength: how strongly the opening grabs attention and stops the scroll
- curiosity_gap: does it open a "I need to see what happens" curiosity loop
- food_craving: how intensely it makes a real viewer crave / want to eat the food
- visual_energy: dynamism, vibrancy, life and movement-potential in the frame
- visual_contrast: color and composition contrast that POPS against a busy feed
- clarity: is the hero subject instantly clear and readable in under a second
- production_quality: polish and craft — but UGC-real, NOT over-produced/stock
- authenticity: does it read as genuine handheld real-person UGC vs staged/stock/AI

Return ONLY JSON with all 8 keys as integers 0-100:
{"hook_strength":<n>,"curiosity_gap":<n>,"food_craving":<n>,"visual_energy":<n>,"visual_contrast":<n>,"clarity":<n>,"production_quality":<n>,"authenticity":<n>}`;

/**
 * Extrae las señales creativas de una imagen-fuente. null si falla (fail-open).
 * @param {string} imageBase64 - imagen (sin prefijo data:)
 * @param {string} productName
 * @param {string} motionVariant - para derivar motion_intensity
 */
async function extractCreativeSignals(imageBase64, productName = 'the product', motionVariant = '') {
  const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !imageBase64 || imageBase64.length < 100) return null;
  const mediaType = imageBase64.startsWith('/9j/') ? 'image/jpeg'
    : imageBase64.startsWith('iVBOR') ? 'image/png'
    : imageBase64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: config.claude.model,
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: PROMPT(productName) }
      ]}]
    });
    const text = resp.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) return null;
    const r = JSON.parse(json[0]);
    const out = {};
    for (const s of IMAGE_SIGNALS) out[s] = Math.max(0, Math.min(100, Math.round(r[s] || 0)));
    out.motion_intensity = MOTION_INTENSITY[motionVariant] ?? 50; // derivado del motion
    out.extracted_at = new Date();
    return out;
  } catch (e) {
    logger.warn(`[VIDEO-SIGNALS] extracción falló (fail-open): ${e.message}`);
    return null;
  }
}

module.exports = { extractCreativeSignals, ALL_SIGNALS, IMAGE_SIGNALS, MOTION_INTENSITY };
