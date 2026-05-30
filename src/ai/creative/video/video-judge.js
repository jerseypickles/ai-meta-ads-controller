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

const PROMPT = (productName) => `You are a senior performance video editor judging whether a STATIC product image will make a good 5-second ambient-motion vertical video ad (image-to-video, handheld UGC style, almost no movement) for "${productName}".

The video keeps the image as the first frame and only adds subtle micro-motion (a drip, a faint breeze, light shimmer). So the IMAGE must be a strong base.

Score 0-100 on video potential. Reward:
- Clean, in-focus product with a readable label.
- Clear composition with a clear subject (not cluttered).
- A scene that naturally benefits from subtle motion (liquid, condensation, a hand, food texture).
- Realistic / authentic look (UGC, not over-stylized).
Penalize heavily:
- Cluttered/busy scenes (would morph/warp badly when animated).
- Product small, cut off, blurry, or label unreadable.
- Heavy text overlays or graphics (look fake in motion).
- Anything that would distort the product when animated.

Return ONLY JSON: {"score": <0-100>, "suitable": <true|false>, "reason": "<one sentence>", "suggested_motion": "<drip|breeze|shimmer|hand_hold|none>"}`;

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
