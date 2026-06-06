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
const { productUnit } = require('./video-dna');

const PROMPT = (productName, expectedUnit) => `You are a senior DTC food-ad video editor judging whether a STATIC image will make a HIGH-CONVERTING 5-second vertical UGC video ad (image-to-video) for "${productName}".

The video keeps the image as the FIRST FRAME and animates what is already in it — it CANNOT add objects that aren't there.

═══ STEP 1 — PRODUCT FIDELITY (hard gate, check this FIRST) ═══
For "${productName}", the hero item the hand holds/shows SHOULD be: ${expectedUnit}.
Look at what is ACTUALLY held / shown. If it does NOT match — e.g. the product is a chunky salsa/relish/dip but the image shows a solid pickle chip held up, or it shows the wrong food — that is a FIDELITY FAIL: return score 15-25, suitable false, reason starting "fidelity:". A beautiful shot of the WRONG item is still a FAIL. A correct jar LABEL is NOT enough — the HELD / HERO item must match the product too.

═══ STEP 2 — VIDEO SUITABILITY (only if fidelity passes) ═══
Reward (80-100): a HAND interacting with the CORRECT product unit (lifting / holding / dipping / scooping it), glossy sauce/brine that can DRIP, hero item in sharp focus, authentic handheld UGC daylight.
Mediocre (45-70): product (jar/tub) clean and in focus but NO hand / no interaction → only a tiny passive drip.
Penalize (0-35): static jar with nothing to animate, cluttered/busy scenes that would morph/warp, product small / cut off / blurry / unreadable label, heavy text/graphics overlays.

SCORE WITH SPREAD — reserve 95-100 ONLY for genuinely exceptional shots (perfect focus + dynamic interaction + appetizing drip). A merely-fine hand+product shot is ~80-85, not 95. Do not default to 95.

suggested_motion: pick what the image GENUINELY supports — "lift_drip", "dip_drip", "pull_up", "drip" (passive jar-only), or "none".

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

  const expectedUnit = productUnit(productName);
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    { type: 'text', text: PROMPT(productName, expectedUnit) }
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
