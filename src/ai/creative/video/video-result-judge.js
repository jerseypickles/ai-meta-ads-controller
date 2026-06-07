// ═══════════════════════════════════════════════════════════════════════════════
// JUEZ DE VIDEO REAL — Gemini mira el mp4 generado (no la foto).
// Claude no procesa video; Gemini sí entiende movimiento nativo. Juzga lo que el
// juez de imagen NO puede ver: ¿el motion ocurrió? ¿hay warping/freezing/morphing?
// ¿el producto se mantiene fiel en movimiento? ¿se ve creíble y apetitoso animado?
// Su veredicto se guarda en el proposal y entra al reconciliador (video-learning).
// ═══════════════════════════════════════════════════════════════════════════════

const { GoogleGenAI } = require('@google/genai');
const logger = require('../../../utils/logger');

const MODEL = process.env.GEMINI_VIDEO_MODEL || 'gemini-2.5-flash';
const MAX_MB = 18; // límite inline de Gemini (~20MB request); 5s suele ser < 10MB

const PROMPT = (productName, motion) => `You are a senior DTC food-ad video editor watching this 5-second UGC video ad for "${productName}". The intended interaction was "${motion}". Judge HONESTLY whether a real person scrolling would find it believable and appetizing — and whether the AI animation broke.

Watch the MOTION across the whole clip (this is video, not a photo). Check:
- motion_ok: did the intended interaction actually happen and look natural? (not a still that barely moves)
- artifacts: warping/morphing/melting, hands or product deforming, impossible physics → "none" | "minor" | "severe"
- frozen: are objects stuck/frozen/floating in the air instead of moving with real gravity?
- fidelity_ok: does the product (jar, label, the food) stay CONSISTENT and recognizable the whole clip (not morphing into something else)?
- appetizing: does it look genuinely mouth-watering / craveable in motion? (0-100)
- overall: overall video quality a real viewer would perceive (0-100). A clip with severe artifacts or a frozen/morphing product is LOW even if pretty.

verdict: "good" (ship it) | "weak" (meh, low overall) | "reject" (broken: severe artifacts / frozen / product morphs / wrong item).

Return ONLY JSON:
{"overall":<0-100>,"motion_ok":<true|false>,"artifacts":"<none|minor|severe>","frozen":<true|false>,"fidelity_ok":<true|false>,"appetizing":<0-100>,"verdict":"<good|weak|reject>","notes":"<one sentence, concrete>"}`;

/**
 * @param {string} videoUrl - URL pública del mp4 (PiAPI ephemeral)
 * @param {string} productName
 * @param {string} motion - motion_variant
 * @returns {Promise<object|null>} veredicto o null si falla (fail-open: no bloquea el pipeline)
 */
async function judgeVideoResult(videoUrl, productName = 'the product', motion = '') {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey || !videoUrl) return null;
  try {
    // Descargar el mp4 → base64 inline (con timeout: URLs ephemeral muertas pueden colgar)
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try { res = await fetch(videoUrl, { signal: ctrl.signal }); } finally { clearTimeout(to); }
    if (!res.ok) throw new Error(`fetch video ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MB * 1024 * 1024) { logger.warn(`[VIDEO-RESULT-JUDGE] video ${(buf.length / 1048576).toFixed(1)}MB > ${MAX_MB}MB — skip`); return null; }
    const b64 = buf.toString('base64');

    const genAI = new GoogleGenAI({ apiKey });
    const response = await genAI.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'video/mp4', data: b64 } },
        { text: PROMPT(productName, motion) }
      ]}]
    });

    const text = response?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('Gemini sin JSON');
    const r = JSON.parse(json[0]);
    return {
      overall: Math.max(0, Math.min(100, r.overall || 0)),
      motion_ok: r.motion_ok !== false,
      artifacts: ['none', 'minor', 'severe'].includes(r.artifacts) ? r.artifacts : 'minor',
      frozen: !!r.frozen,
      fidelity_ok: r.fidelity_ok !== false,
      appetizing: Math.max(0, Math.min(100, r.appetizing || 0)),
      verdict: ['good', 'weak', 'reject'].includes(r.verdict) ? r.verdict : 'weak',
      notes: r.notes || '',
      model: MODEL,
      judged_at: new Date()
    };
  } catch (e) {
    logger.warn(`[VIDEO-RESULT-JUDGE] falló (fail-open): ${e.message}`);
    return null;
  }
}

module.exports = { judgeVideoResult };
