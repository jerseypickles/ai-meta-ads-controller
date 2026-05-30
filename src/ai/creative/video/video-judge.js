// ═══════════════════════════════════════════════════════════════════════════════
// Dionisio — JUDGE de video-suitability (Claude Vision)
// Puntúa si una imagen aprobada saldrá BUEN video de 5s (micro-motion UGC).
// Filtro previo: solo las que pasan van al motor Seedance (controla costo + calidad).
// Patrón reusado de image-judge.js.
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../../config');
const logger = require('../../../utils/logger');

const MIN_SCORE = parseInt(process.env.DIONYSUS_VIDEO_MIN_SCORE || '60', 10);

const PROMPT = (productName) => `You are a senior DTC food-ad video editor judging whether a STATIC image will make a HIGH-CONVERTING 5-second vertical UGC video ad (image-to-video) for "${productName}".

The video keeps the image as the FIRST FRAME and animates what is already in it — it CANNOT add objects that aren't there. So a hand or a held chip must already be visible to animate an interaction.

What sells for this brand (reward HEAVILY, score 80-100):
- A HAND interacting with the product: lifting / picking up / holding a single pickle chip, dipping a chip, pulling a chip out of the jar or tub.
- Visible glossy sauce / chamoy / brine on the chip that can DRIP (appetizing, mouth-watering).
- The product/chip in sharp focus, authentic handheld UGC look, natural daylight.

Mediocre (score 40-65):
- Product (jar/tub) clean and in focus but NO hand and NO chip held → can only do a tiny passive drip. Lower video potential.

Penalize HEAVILY (score 0-35):
- Static jar just sitting there with nothing to animate, or cluttered/busy scenes that would morph/warp.
- Product small, cut off, blurry, label unreadable, or heavy text/graphics overlays.

suggested_motion: pick the interaction the image best supports:
- "lift_drip" = a hand can lift a chip out with sauce dripping (BEST).
- "dip_drip" = a held chip with sauce can drip back into the tub.
- "pull_up" = a hand pulling a sauced chip up.
- "drip" = no hand/chip, only a passive brine drip (jar-only fallback).
- "none" = not suitable.

Return ONLY JSON: {"score": <0-100>, "suitable": <true|false>, "reason": "<one sentence>", "suggested_motion": "<lift_drip|dip_drip|pull_up|drip|none>"}`;

/**
 * @param {string} imageBase64 - imagen generada (base64, sin prefijo data:)
 * @param {string} productName
 * @returns {Promise<{score, suitable, reason, suggested_motion}>}
 */
async function judgeVideoSuitability(imageBase64, productName = 'the product') {
  const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada — video-judge no disponible');
  // Sin imagen → no apto (no llamar a la API con data vacía).
  if (!imageBase64 || imageBase64.length < 100) {
    return { score: 0, suitable: false, reason: 'sin imagen', suggested_motion: 'none' };
  }
  const client = new Anthropic({ apiKey });

  // Detectar el formato real desde los magic bytes del base64 (las imágenes de
  // Apollo suelen ser JPEG; mandar image/png hardcodeado hace fallar a Claude).
  const mediaType = imageBase64.startsWith('/9j/') ? 'image/jpeg'
    : imageBase64.startsWith('iVBOR') ? 'image/png'
    : imageBase64.startsWith('UklGR') ? 'image/webp'
    : imageBase64.startsWith('R0lGOD') ? 'image/gif'
    : 'image/jpeg';

  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    { type: 'text', text: PROMPT(productName) }
  ];

  try {
    const resp = await client.messages.create({
      model: config.claude.model,
      max_tokens: 300,
      messages: [{ role: 'user', content }]
    });
    const text = resp.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('judge sin JSON');
    const r = JSON.parse(json[0]);
    const score = Math.max(0, Math.min(100, r.score || 0));
    // suitable: respeta el del modelo pero gateado por MIN_SCORE
    const suitable = score >= MIN_SCORE && r.suitable !== false;
    return { score, suitable, reason: r.reason || '', suggested_motion: r.suggested_motion || 'none' };
  } catch (e) {
    logger.warn(`[VIDEO-JUDGE] falló (fail-closed: no apto): ${e.message}`);
    return { score: 0, suitable: false, reason: `judge error: ${e.message}`, suggested_motion: 'none' };
  }
}

module.exports = { judgeVideoSuitability, MIN_SCORE };
