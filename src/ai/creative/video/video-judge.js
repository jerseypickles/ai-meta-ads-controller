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

const PROMPT = (productName, expectedUnit) => `You are simulating a REAL person scrolling Instagram/TikTok who sees this image as the FIRST FRAME of a 5-second UGC food-ad for "${productName}". Judge honestly whether real people would STOP, crave it, trust it, and want to buy — not whether it is merely "technically fine". The video animates this static frame (image-to-video); it cannot add objects.

FIDELITY GATE (check FIRST): the hero item the hand holds/shows SHOULD be: ${expectedUnit}. If it shows the WRONG thing (e.g. a solid pickle chip when the product is a chunky salsa/dip, or the wrong food), real people are misled → fidelidad fails and the OVERALL score must be 15-25. A correct jar LABEL is NOT enough — the held/hero item must match.

Rate each dimension 0-100 as a real viewer would react, each with a SHORT concrete note:
- fidelidad: does the hero item truly match the product? (the gate)
- freno_scroll: would a real person actually STOP scrolling on this frame? (hook / visual pull / curiosity)
- apetito: does it look genuinely mouth-watering / craveable? (gloss, drip, freshness)
- autenticidad: does it read as REAL handheld UGC, or staged/AI/stocky? (trust)
- calidad: focus, framing, no warping/artifacts, label readable

Also: que_funciona (1-3 concrete things that land) and que_falla (1-3 concrete weaknesses; [] if none).

OVERALL score = honest blend, gated by fidelidad. SPREAD it — reserve 90-100 only for content real people would genuinely share/stop on; a merely-fine shot is ~70-80. Do NOT default to 95.

suggested_motion: "lift_drip" | "dip_drip" | "pull_up" | "drip" | "none".

Return ONLY JSON:
{"score":<0-100>,"suitable":<true|false>,"reason":"<one sentence verdict>","suggested_motion":"<...>","breakdown":{"fidelidad":{"score":<0-100>,"note":"<...>"},"freno_scroll":{"score":<0-100>,"note":"<...>"},"apetito":{"score":<0-100>,"note":"<...>"},"autenticidad":{"score":<0-100>,"note":"<...>"},"calidad":{"score":<0-100>,"note":"<...>"}},"que_funciona":["<...>"],"que_falla":["<...>"]}`;

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
      max_tokens: 700,
      messages: [{ role: 'user', content }]
    });
    const text = resp.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('judge sin JSON');
    const r = JSON.parse(json[0]);
    const score = Math.max(0, Math.min(100, r.score || 0));
    // suitable: respeta el del modelo pero gateado por MIN_SCORE
    const suitable = score >= MIN_SCORE && r.suitable !== false;
    return {
      score, suitable,
      reason: r.reason || '',
      suggested_motion: r.suggested_motion || 'none',
      breakdown: r.breakdown || null,           // {fidelidad,freno_scroll,apetito,autenticidad,calidad: {score,note}}
      que_funciona: Array.isArray(r.que_funciona) ? r.que_funciona : [],
      que_falla: Array.isArray(r.que_falla) ? r.que_falla : []
    };
  } catch (e) {
    logger.warn(`[VIDEO-JUDGE] falló (fail-closed: no apto): ${e.message}`);
    return { score: 0, suitable: false, reason: `judge error: ${e.message}`, suggested_motion: 'none' };
  }
}

module.exports = { judgeVideoSuitability, MIN_SCORE };
