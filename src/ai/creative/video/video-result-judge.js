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

const PROMPT = (productName, motion) => `You are a BRUTALLY CRITICAL senior video editor reviewing this 5-second AI-generated UGC food ad for "${productName}" (intended interaction: "${motion}"). Your job is to find what's WRONG. Every AI video (Seedance) has flaws — if you think it's flawless, you are NOT looking hard enough. Watch the MOTION across the whole clip, frame by frame.

HUNT for these (almost always present at some level):
- product/label MORPHING or shifting between frames (text warps, jar changes shape mid-clip)
- hands/fingers warping, extra fingers, rubbery/melting deformation
- unnatural drip/physics (drip that doesn't fall right, liquid that snaps, floats or teleports)
- ⚠️ a product/jar/object FLOATING, LEVITATING or FLYING off a surface/shelf into the air instead of being held or resting on a surface — this is a SEVERE artifact → verdict MUST be "reject"
- frozen / stuck objects instead of real gravity
- ❄️ a falling/pouring/dropping piece that HANGS, FREEZES, STUTTERS or PAUSES in mid-air for even a brief instant instead of falling continuously and smoothly under gravity — watch the whole arc of any dropping object frame by frame; a piece that "sticks" mid-fall then continues is a SEVERE freeze artifact → set frozen=true and verdict "reject"
- the "AI look": too-smooth plasticky surfaces, staged/stocky background, uncanny lighting
- the intended motion NOT actually happening (a barely-moving near-still frame)
- 🧩 INCOHERENCE (analyze the WHOLE scene, not just one object) — the item the hand holds/shows does NOT match the contents of the jar/box/container in the SAME shot (e.g. a flat round CHIP in the hand while the jar/container clearly holds WHOLE pickles or spears), OR impossible scale/proportions (a piece far too big/small for its jar), OR elements that don't make sense together. A real person would notice "wait, that doesn't match". This is a SEVERE coherence break → verdict MUST be "reject".

SCORE WITH REAL SPREAD — do NOT default to 90:
- 90-100: genuinely flawless AND scroll-stopping. RARE — reserve it.
- 75-89: good but has at least one visible minor flaw.
- 55-74: watchable but a real problem a viewer would notice.
- 0-54: broken — morphing product, severe artifacts, frozen, or wrong item.
A competent-but-unremarkable clip is ~70-78, NOT 90. Be strict.

verdict: "good" (overall ≥80 AND no severe issue) | "weak" (overall 55-79, real flaw) | "reject" (overall <55 / severe artifacts / product morphs / frozen / motion didn't happen / INCOHERENT held-item-vs-container).
"coherent": false ONLY if there is a real scene-coherence break (held item ≠ container contents, impossible proportions, elements that don't fit). Most clips are coherent → true.
You MUST name the single biggest weakness in "weakness" — every clip has one, find it.

Return ONLY JSON:
{"overall":<0-100>,"motion_ok":<true|false>,"artifacts":"<none|minor|severe>","frozen":<true|false>,"fidelity_ok":<true|false>,"coherent":<true|false>,"appetizing":<0-100>,"verdict":"<good|weak|reject>","weakness":"<the single biggest flaw, concrete>","notes":"<one sentence>"}`;

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
    const coherent = r.coherent !== false;
    let verdict = ['good', 'weak', 'reject'].includes(r.verdict) ? r.verdict : 'weak';
    if (!coherent) verdict = 'reject'; // incoherencia interna (pieza ≠ envase, proporciones) → reject SIEMPRE
    return {
      overall: Math.max(0, Math.min(100, r.overall || 0)),
      motion_ok: r.motion_ok !== false,
      artifacts: ['none', 'minor', 'severe'].includes(r.artifacts) ? r.artifacts : 'minor',
      frozen: !!r.frozen,
      fidelity_ok: r.fidelity_ok !== false,
      coherent,
      appetizing: Math.max(0, Math.min(100, r.appetizing || 0)),
      verdict,
      weakness: r.weakness || '',
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
