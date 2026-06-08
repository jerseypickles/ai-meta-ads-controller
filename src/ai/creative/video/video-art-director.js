// ═══════════════════════════════════════════════════════════════════════════════
// video-art-director.js — el DIRECTOR CREATIVO de Dionisio.
//
// El DNA fijo (motions/hooks/scenes) solo puede redescubrir lo que ya pusimos. Esto
// hace que el espacio creativo CREZCA: para una parte de cada tanda, Claude INVENTA un
// concepto de primer-frame NUEVO (escenario/ángulo/composición que nunca probamos),
// con el producto. Esos conceptos se testean como todo → los que pegan enriquecen el
// DNA. Es la diferencia entre "elegir del menú" e "inventar platos nuevos".
//
// Restricciones duras: producto fiel + label legible, UGC real (no stock/IA), y
// ANIMABLE con UN motion simple (es el primer frame de un video de 5s; nada de física
// multi-objeto que rompe). El LLM devuelve el motion_hint más cercano para el video.
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../../config');
const logger = require('../../../utils/logger');

const VALID_MOTIONS = ['lift_drip', 'dip_drip', 'pull_up', 'pinch_twirl', 'bite_tease', 'pour_bowl', 'on_food'];

const CONCEPT_PROMPT = (productName, inspiration) => `You are a world-class UGC food-ad creative director for "${productName}" (Jersey Pickles, a US pickles & condiments brand). Invent ONE fresh, scroll-stopping FIRST-FRAME image concept for a 5-second vertical UGC video ad that we have NOT tried before.

What already works (push BEYOND these — do NOT copy them, transcend them): ${inspiration || 'a hand lifting the product out of the jar with brine dripping'}.

HARD RULES (a concept that breaks these is useless):
- The product jar/tub is the HERO, its label clearly readable and true to the real product.
- Authentic real-person UGC iPhone look — candid, in-the-moment, NOT staged, NOT stock, NOT AI-looking.
- It is the FIRST FRAME of a 5s video → it MUST be animatable with ONE simple natural motion (a hand lifting / dipping / pouring into something / a bite / a reach). NO complex multi-object physics (no several things flying or pouring at once — those break in AI video).
- Vertical 9:16, mouth-watering, product in sharp focus.
- Be GENUINELY NOVEL: a fresh scenario, angle, context, mood, time of day, or composition we have not seen. Surprise me — think what makes a real person STOP scrolling mid-feed.

Return ONLY JSON:
{"concept_tag":"<short-kebab-name, 2-4 words>","image_prompt":"<full vivid image description ready for an image model: the product + the ONE animatable interaction + the fresh setting/angle/mood>","motion_hint":"<lift_drip|dip_drip|pull_up|pinch_twirl|bite_tease|pour_bowl|on_food — the closest simple motion to animate it>","why":"<one sentence: why this stops the scroll>"}`;

/**
 * Claude inventa un concepto de imagen NOVEDOSO. null si falla (fail-open al template).
 * @returns {{concept_tag, image_prompt, motion_hint, why}|null}
 */
async function inventCreativeConcept(productName, inspiration = '') {
  const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: config.claude.model,
      max_tokens: 600,
      messages: [{ role: 'user', content: CONCEPT_PROMPT(productName, inspiration) }]
    });
    const text = resp.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) return null;
    const r = JSON.parse(json[0]);
    if (!r.image_prompt || r.image_prompt.length < 20) return null;
    const motion = VALID_MOTIONS.includes(r.motion_hint) ? r.motion_hint : 'lift_drip';
    return {
      concept_tag: (r.concept_tag || 'creative').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
      image_prompt: r.image_prompt.trim(),
      motion_hint: motion,
      why: (r.why || '').trim()
    };
  } catch (e) {
    logger.warn(`[ART-DIRECTOR] inventar concepto falló (fail-open): ${e.message}`);
    return null;
  }
}

/**
 * Envuelve el concepto del LLM con fidelidad + UGC. El LLM inventa la IDEA; esto
 * garantiza que el producto salga fiel (label, color) y con look UGC real.
 */
function buildCreativePrompt(productName, conceptPrompt, fidelityClause, styleClause) {
  const matchPiece = `CRITICAL: the pickled food shown must be the SAME product inside this "${productName}" jar — same type and same color as the reference contents. Do NOT substitute a different food.`;
  return `Create a vertical 9:16 photograph. ${conceptPrompt} For the product "${productName}": the jar/tub from the reference photo is clearly visible in the shot with its label readable. ${matchPiece} ${fidelityClause} ${styleClause} Photorealistic real handheld iPhone UGC — looks shot by a real person, NOT AI. Mouth-watering, product in sharp focus.`;
}

module.exports = { inventCreativeConcept, buildCreativePrompt };
