/**
 * Image Judge — Claude analiza las imagenes generadas y rankea por potencial de CTR/performance.
 * Usa vision de Claude para ver las imagenes reales y evaluar calidad creativa.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

const GENERATED_DIR = path.join(config.system.uploadsDir, 'generated');

const JUDGE_SYSTEM_PROMPT = `You are an elite Meta Ads creative strategist with deep expertise in performance marketing, specifically ecommerce ads on Facebook and Instagram. You have analyzed thousands of ad creatives and their performance data.

Your job: Look at a batch of AI-generated product ad images and RANK them by predicted Click-Through Rate (CTR) performance on Meta Ads.

═══════════════════════════════════════════════════════════════
 WHAT MAKES ADS PERFORM ON META (your scoring criteria)
═══════════════════════════════════════════════════════════════

SCROLL-STOPPING POWER (0-25 points):
- Does this image make someone STOP scrolling in their feed?
- Pattern interrupt: does it look different from typical feed content?
- Visual contrast and composition that catches the eye
- Organic-style ads that look like real content often outperform polished ones because they don't trigger "ad blindness"

TEXT OVERLAY EFFECTIVENESS (0-25 points):
- Is the handwritten text readable, compelling, and well-placed?
- Does it add personality and relatability?
- Hook quality: does the text make you curious or create FOMO?
- Text should NOT overlap or obscure the product
- Messy/scribbled text > clean text for organic style (feels more authentic)
- Arrows and doodles that draw attention to the product

PRODUCT PRESERVATION (0-20 points):
- Does the product look REAL and unmodified? (not 3D rendered, not warped)
- Is the label readable and intact?
- Does it look like someone physically placed the product in the scene?
- Penalty for: 3D rendering, label distortion, invented text, unnatural glow

SCENE AUTHENTICITY (0-15 points):
- Does the environment feel real and lived-in?
- Specific details that make the scene believable
- Lighting that matches the environment naturally
- For organic style: does it actually look like a real moment in someone's life?

EMOTIONAL TRIGGER (0-15 points):
- Relatability: "that's literally my kitchen/desk/car"
- Curiosity: "what is that? I need to click"
- FOMO: "everyone has this and I don't"
- Humor/personality that makes it shareable

═══════════════════════════════════════════════════════════════
 COMMON FAILURES TO PENALIZE
═══════════════════════════════════════════════════════════════

- Product looks like a 3D render instead of a real photo → heavy penalty
- Label text is garbled, blurry, or hallucinated → heavy penalty
- Text overlays overlap the product label → medium penalty
- Scene looks too clean/staged for organic style → medium penalty
- Text is unreadable or too small → medium penalty
- No text overlays when style requires them (organic, meme) → penalty
- Product is warped, stretched, or reshaped → heavy penalty
- Image looks like digital art instead of a photograph → heavy penalty

═══════════════════════════════════════════════════════════════
 OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "rankings": [
    {
      "index": 0,
      "rank": 1,
      "score": 85,
      "predicted_ctr": "high",
      "verdict": "Short verdict in Spanish — 1-2 sentences on why this would perform well/poorly",
      "strengths": ["strength 1 in Spanish", "strength 2"],
      "weaknesses": ["weakness 1 in Spanish"],
      "scroll_stop": 22,
      "text_quality": 20,
      "product_preservation": 18,
      "scene_authenticity": 13,
      "emotional_trigger": 12
    }
  ],
  "overall_notes": "Brief overall analysis in Spanish — which images to use, which to discard, general quality assessment"
}

predicted_ctr values: "high" (score 75+), "medium" (score 50-74), "low" (score below 50)
Rankings must be sorted by score descending (best first).
index = the original position (0-based) of the image in the input array.`;

/**
 * Juzga un batch de imagenes generadas usando Claude Vision.
 * @param {Array<{filename: string, scene_label: string, prompt: string}>} images
 * @param {string} style - El estilo usado (ugly-ad, polished, ugc, meme)
 * @param {string} format - feed o stories
 * @returns {Object} Rankings y analysis
 */
async function judgeImages(images, style, format) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');

  // Filter only successful images (with filename)
  const validImages = images.filter(img => img.filename && !img.error);
  if (validImages.length === 0) {
    throw new Error('No hay imagenes validas para juzgar');
  }

  const client = new Anthropic({ apiKey });

  // Build vision content with all images
  const content = [];

  content.push({
    type: 'text',
    text: `Judge these ${validImages.length} AI-generated Meta Ad images. Style: "${style}". Format: ${format === 'stories' ? '9:16 Stories' : '1:1 Feed'}.

Analyze each image carefully and rank them by predicted CTR performance. Consider scroll-stopping power, text overlay quality, product preservation, scene authenticity, and emotional trigger.

Here are the images:`
  });

  // Add each image with its context
  for (let i = 0; i < validImages.length; i++) {
    const img = validImages[i];
    const filePath = path.join(GENERATED_DIR, img.filename);

    if (!fs.existsSync(filePath)) {
      logger.warn(`[IMAGE-JUDGE] Imagen no encontrada: ${img.filename}`);
      continue;
    }

    // Read image as base64
    const imageBuffer = fs.readFileSync(filePath);
    const base64 = imageBuffer.toString('base64');

    content.push({
      type: 'text',
      text: `\n--- IMAGE ${i + 1} (index: ${img.originalIndex ?? i}) | Scene: "${img.scene_label}" ---`
    });

    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: base64
      }
    });
  }

  content.push({
    type: 'text',
    text: `\nNow rank ALL ${validImages.length} images by predicted CTR. Be honest and critical — if an image has problems (3D rendering, bad text, warped product), score it low. Respond with ONLY valid JSON.`
  });

  logger.info(`[IMAGE-JUDGE] Enviando ${validImages.length} imagenes a Claude para juicio...`);
  const startTime = Date.now();

  const response = await client.messages.create({
    model: config.claude.judgeModel,
    max_tokens: 4096,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }]
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[IMAGE-JUDGE] Claude respondio en ${elapsed}s`);

  const text = response.content[0]?.text || '';

  let parsed;
  try {
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    logger.error(`[IMAGE-JUDGE] Error parseando respuesta: ${e.message}`);
    logger.error(`[IMAGE-JUDGE] Raw (primeros 500 chars): ${text.substring(0, 500)}`);
    // Fallback: return neutral rankings
    parsed = {
      rankings: validImages.map((img, i) => ({
        index: img.originalIndex ?? i,
        rank: i + 1,
        score: 50,
        predicted_ctr: 'medium',
        verdict: 'No se pudo analizar esta imagen',
        strengths: [],
        weaknesses: [],
        scroll_stop: 12, text_quality: 12, product_preservation: 10, scene_authenticity: 8, emotional_trigger: 8
      })),
      overall_notes: 'Error al analizar — rankings por defecto'
    };
  }

  // Ensure rankings are sorted by score
  if (parsed.rankings) {
    parsed.rankings.sort((a, b) => (b.score || 0) - (a.score || 0));
    // Reassign ranks after sort
    parsed.rankings.forEach((r, i) => { r.rank = i + 1; });
  }

  return {
    rankings: parsed.rankings || [],
    overall_notes: parsed.overall_notes || '',
    judge_time_s: parseFloat(elapsed),
    images_judged: validImages.length
  };
}

/**
 * Fidelity gate — verifica que el PRODUCTO en la imagen generada sea fiel a la(s)
 * imagen(es) de referencia real(es), sobre todo COLOR y contenido del envase.
 * Distinto de judgeImages (que rankea CTR sin ver la referencia): este compara
 * generada vs referencia, así atrapa cosas como el tomate VERDE saliendo ROJO.
 *
 * Fail-open: si no hay API key, no hay referencia, o falla el parseo → pass:true
 * (nunca bloquea la generación por un error propio).
 *
 * @param {string} generatedBase64 - imagen generada (base64, sin data: prefix)
 * @param {Array<object|string>} referenceImages - refs: {image_base64,mime_type} | {path} | string path
 * @param {string} productName
 * @returns {Promise<{pass:boolean, score?:number, color_match?:boolean, issues?:string[], verdict?:string, skipped?:string}>}
 */
async function judgeCreative(generatedBase64, referenceImages = [], productName = '', style = '') {
  const apiKey = config.claude.apiKey;
  if (!apiKey) return { fidelity_pass: true, quality_score: null, skipped: 'no_api_key' };
  if (!generatedBase64) return { fidelity_pass: true, quality_score: null, skipped: 'no_image' };

  // Extraer base64 de las referencias (formato flexible)
  const refs = [];
  for (const r of (referenceImages || [])) {
    try {
      if (typeof r === 'string') refs.push({ b64: fs.readFileSync(path.resolve(r)).toString('base64'), mt: 'image/png' });
      else if (r && r.image_base64) refs.push({ b64: r.image_base64, mt: r.mime_type || 'image/jpeg' });
      else if (r && r.path && fs.existsSync(r.path)) refs.push({ b64: fs.readFileSync(path.resolve(r.path)).toString('base64'), mt: 'image/png' });
    } catch (_) { /* skip ref ilegible */ }
  }
  const hasRef = refs.length > 0;

  try {
    const client = new Anthropic({ apiKey });
    const content = [{
      type: 'text',
      text: `Sos QA de creativos para ads de Meta (Facebook/Instagram). ${hasRef ? `Te muestro PRIMERO la(s) foto(s) REAL(es) del producto "${productName}" (referencia) y LUEGO la imagen generada por IA.` : 'Te muestro una imagen generada por IA para un ad.'} Evaluá:\n${hasRef ? '1. FIDELIDAD: ¿el producto generado matchea la referencia, sobre todo COLOR y contenido del envase? (ej: tomate rojo cuando la ref es verde = falla grave).\n2. ' : ''}CALIDAD CTR: ¿esta imagen PARA el scroll en el feed? Considerá pattern-interrupt, composición, autenticidad (parece foto real de un cliente, NO render/stock/3D), gancho visual. Estilo buscado: "${style || 'organic'}".`
    }];
    if (hasRef) {
      content.push({ type: 'text', text: '\nREFERENCIA(S):' });
      refs.forEach(r => content.push({ type: 'image', source: { type: 'base64', media_type: r.mt, data: r.b64 } }));
      content.push({ type: 'text', text: '\nGENERADA:' });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: generatedBase64 } });
    content.push({
      type: 'text',
      text: `\nRespondé SOLO JSON, sin markdown: {${hasRef ? '"fidelity_score":0-100,"color_match":true|false,' : ''}"quality_score":0-100,"predicted_ctr":"high|medium|low","issues":["..."],"verdict":"1 frase"}. ${hasRef ? 'color_match=false si el color/contenido difiere de la ref; fidelity_score<70 si hay desviación seria de color/contenido/forma/label. ' : ''}quality_score = potencial de CTR/scroll-stop (alto = para el scroll; bajo = genérico/aburrido/render/stock).`
    });

    const resp = await client.messages.create({ model: config.claude.judgeModel, max_tokens: 500, messages: [{ role: 'user', content }] });
    const text = resp.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch (e) {
      logger.warn(`[IMAGE-JUDGE] judgeCreative parse error: ${text.slice(0, 150)}`);
      return { fidelity_pass: true, quality_score: null, skipped: 'parse_error' };
    }
    const fidScore = typeof parsed.fidelity_score === 'number' ? parsed.fidelity_score : null;
    const fidelity_pass = !hasRef ? true : ((parsed.color_match !== false) && (fidScore == null || fidScore >= 70));
    const quality_score = typeof parsed.quality_score === 'number' ? parsed.quality_score : null;
    return { fidelity_pass, fidelity_score: fidScore, color_match: parsed.color_match, quality_score, predicted_ctr: parsed.predicted_ctr || null, issues: parsed.issues || [], verdict: parsed.verdict || '' };
  } catch (err) {
    logger.warn(`[IMAGE-JUDGE] judgeCreative error (fail-open): ${err.message}`);
    return { fidelity_pass: true, quality_score: null, skipped: 'error' };
  }
}

module.exports = { judgeImages, judgeCreative };
