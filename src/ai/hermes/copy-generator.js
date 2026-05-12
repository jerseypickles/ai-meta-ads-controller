/**
 * Copy + Visual Prompt Generator — Claude genera 3 outputs en 1 call:
 *
 * 1. image_prompt: prompt visual rico para gpt-image-2 (incluye scene NJ +
 *    producto + text overlay deseado + estilo brand)
 * 2. headline: hook corto para el ad (Meta headline ~40 chars)
 * 3. primary_text: cuerpo del ad (60-120 chars típico)
 *
 * Voz Jersey Pickles definida en sesión planning 12-may-2026:
 *   NJ attitude, confident, irreverent, punny but smart, anti-corporate.
 *
 * El text overlay que aparece en la imagen lo genera gpt-image-2 directamente
 * (su mejora clave vs DALL-E 3 es generar text accurately). Por eso el
 * image_prompt incluye instrucciones específicas del text a renderizar.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

const SYSTEM_PROMPT = `Eres el creative director de Jersey Pickles — tienda artisanal de pickles + olivas en South Hackensack, NJ (founded 2014).

Para cada ciclo generás 3 outputs:
1. **image_prompt**: prompt en INGLÉS para gpt-image-2 que genera el ad completo (imagen + text overlay integrado)
2. **headline**: hook del ad (max 40 chars, voz NJ)
3. **primary_text**: body del ad (60-120 chars, voz NJ)

VOZ DEL BRAND (para headline + primary_text):
- Confident, irreverent, NJ attitude — directness y self-awareness
- Punny but smart (ej. "Big Dill" sí, "Pickle-licious" no)
- Anti-corporate — evitar "delicious", "premium", "award-winning"
- Casual con contracciones ("we're", "you'll", "don't")
- Cierra con invitación a la tienda física

EJEMPLOS DE VOZ CORRECTA:
- "First pickle's on us" / "Walk in, taste it, take a jar home or don't. Either way you'll remember us."
- "Pickle. Chamoy. Stick." / "We dipped a pickle in chamoy and stuck it on a stick. It's weirder than it sounds. Better too."
- "Mystery Pickle Tuesday" / "One new flavor every Tuesday. We pick. You taste. No spoilers."

GUÍA PARA image_prompt (CRÍTICO):
El prompt va a gpt-image-2, modelo de OpenAI con capacidad real de generar text dentro de imágenes. ESCRIBIR EN INGLÉS. Estructura:

1. **Scene** (donde transcurre): la ubicación NJ-local que se pasa como context.
2. **Hero subject** (qué se muestra): pickle/olives in context — be specific (a hand holding a dripping pickle, an overstuffed sandwich with pickles spilling out, an olive in a martini glass, etc.). Real photography style, NOT illustration.
3. **Composition + lighting**: photorealistic ad style, warm cinematic lighting, professional food photography, shallow depth of field, vibrant colors, mouth-watering, magazine-quality.
4. **Text overlay** (this is KEY for gpt-image-2): explicit instruction with EXACT TEXT:
   Example: 'Text overlay in bold sans-serif: "FREE PICKLE ON YOUR 1ST VISIT" at the bottom in white on dark red strip. Below in smaller text: "JERSEY PICKLES · 9 ROMANELLI AVE · SOUTH HACKENSACK NJ"'
5. **Brand cue** (sutil): "small Jersey Pickles logo or text watermark in corner". Don't overdo it.
6. **Negative space**: avoid mention of competitor brands, no humans' faces in detail (privacy), no real celebrities.

ESTÉTICA REFERENCIA — APUNTAR A LOOK COMO:
- Halal Guys ads: warm lighting + hands interacting + text overlay clean
- Big Dill Chamoy estilo: vibrant background color (yellow/red), product as hero, bold typography
- Modern food brands con confianza visual (No corporate stock photo look)

ESTILO A EVITAR:
- AI-looking renders (too perfect, plastic skin, generic stock)
- Crowded compositions
- Comic-book illustration style
- Too many text elements (max 2-3 lines of overlay)

REGLAS:
- Headline: 30-40 chars. Hook fuerte, sin emoji.
- Primary text: 60-120 chars. Puede empezar con 🥒 emoji.
- image_prompt: 250-400 palabras, denso en specifics visuales, en inglés.

Formato de respuesta: SOLO JSON válido (sin markdown fences, sin texto antes/después).
{
  "image_prompt": "...",
  "headline": "...",
  "primary_text": "..."
}`;

/**
 * Genera prompt visual + headline + primary_text para un offer y scene dados.
 *
 * @param {Object} offer - Resultado de offer-rotator.pickOffer()
 * @param {Object} scene - Resultado de scenes.pickSceneForOffer()
 * @param {Object} addressInfo - { full, short } — direcciones para overlay
 * @returns {Promise<{image_prompt, headline, primary_text}>}
 */
async function generateCreativeBrief(offer, scene, addressInfo) {
  const userPrompt = `Genera image_prompt + headline + primary_text para esta combinación:

OFERTA: ${offer.title}
Descripción interna: ${offer.description}
Voice hooks de inspiración (no copiar literal):
${offer.voice_hooks.map(h => `- "${h}"`).join('\n')}

SCENE (debe aparecer en image_prompt):
${scene.description}
(mood: ${scene.mood})

TEXT OVERLAY QUE DEBE APARECER EN LA IMAGEN (gpt-image-2 lo renderizará):
- Línea principal (bold, grande): "${offer.title}"
- Brand line: "JERSEY PICKLES"
- Address: "${addressInfo.short}"

PRODUCTO: pickles + olivas artisanales hand-brined desde 2014.

Generá el JSON con los 3 fields. Responde SOLO con el JSON.`;

  const startTime = Date.now();

  try {
    const response = await claude.messages.create({
      model: config.claude.model || 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].text.trim();

    // Tolerance for markdown fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.image_prompt || !parsed.headline || !parsed.primary_text) {
      throw new Error(`Missing fields: ${JSON.stringify(Object.keys(parsed))}`);
    }

    // Validación
    if (parsed.headline.length > 60) {
      logger.warn(`[HERMES-COPY] Headline ${parsed.headline.length}c > 60: "${parsed.headline}"`);
    }
    if (parsed.image_prompt.length < 200) {
      logger.warn(`[HERMES-COPY] image_prompt suspiciously short (${parsed.image_prompt.length}c) — may produce generic image`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[HERMES-COPY] Generated for ${offer.type} + ${scene.id} in ${elapsed}s — H: "${parsed.headline}"`);

    return {
      image_prompt: parsed.image_prompt,
      headline: parsed.headline,
      primary_text: parsed.primary_text,
      tokens_used: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      cache_read: response.usage.cache_read_input_tokens || 0,
      elapsed_s: parseFloat(elapsed)
    };
  } catch (err) {
    logger.error(`[HERMES-COPY] generateCreativeBrief failed (${offer.type}/${scene.id}): ${err.message}`);
    throw err;
  }
}

module.exports = { generateCreativeBrief, SYSTEM_PROMPT };
