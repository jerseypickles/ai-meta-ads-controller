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
- "Ugly ads" that look like organic content often outperform polished ones because they don't trigger "ad blindness"

TEXT OVERLAY EFFECTIVENESS (0-25 points):
- Is the handwritten text readable, compelling, and well-placed?
- Does it add personality and relatability?
- Hook quality: does the text make you curious or create FOMO?
- Text should NOT overlap or obscure the product
- Messy/scribbled text > clean text for ugly-ad style (feels more authentic)
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
- For ugly-ad: does it actually look like someone's messy counter/desk/car?

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
- Scene looks too clean/staged for ugly-ad style → medium penalty
- Text is unreadable or too small → medium penalty
- No text overlays when style requires them (ugly-ad, meme) → penalty
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
    model: config.claude.model,
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

module.exports = { judgeImages };
