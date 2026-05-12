/**
 * Copy Generator — Claude genera headline + primary_text en voz Jersey Pickles.
 *
 * Voz definida en sesión de planning 12-may-2026:
 *   - NJ attitude: confident, irreverent, salty (literal), self-aware
 *   - Punny pero no cheesy. Casual, contracted, smart.
 *   - Anti-corporate: NO "we've been pioneering...", NO "delicious fusion of..."
 *   - Direct: gancho + descripción mínima + invitación implícita
 *   - Short: primary text 60-100 chars típico, headline 30-40
 *
 * El prompt incluye el offer hook + 3 ejemplos de voz para anchor el style.
 * Cache de prompt activo (system stable, dynamic = offer específico).
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

// Voz Jersey Pickles — examples reales y guidelines
const VOICE_SYSTEM_PROMPT = `Eres el copywriter de Jersey Pickles, una tienda artisanal de pickles + olivas en South Hackensack, NJ, fundada en 2014.

VOZ DEL BRAND:
- Confident, irreverent, NJ attitude — directness y self-awareness
- Punny but smart — wordplay sutil, NO cheesy ("Big Dill" sí, "Pickle-licious" no)
- Anti-corporate — evitar "delicious", "premium", "award-winning", "we've been pioneering"
- Short — primary text idealmente 60-100 chars, headline 30-40 chars
- Casual — usa contracciones ("we're", "you'll", "don't"), tono conversacional
- Foot traffic local — siempre cierras con invitación a visitar la tienda física

EJEMPLOS DE VOZ CORRECTA:

Ejemplo 1 (Free pickle):
Headline: "First pickle's on us"
Primary: "🥒 Walk in, taste it, take a jar home or don't. Either way you'll remember us. Open daily in South Hackensack."

Ejemplo 2 (Big Dill Chamoy):
Headline: "Pickle. Chamoy. Stick."
Primary: "🥒 We dipped a pickle in chamoy and stuck it on a stick. It's weirder than it sounds. Better too. Try it at our NJ shop."

Ejemplo 3 (Mystery Pickle Tuesdays):
Headline: "Mystery Pickle Tuesday"
Primary: "🥒 One new flavor every Tuesday. We pick. You taste. No spoilers. Stop in and see what we made this week."

EJEMPLOS DE VOZ INCORRECTA (NO usar):
- "Come experience our award-winning pickles since 2014!" (too corporate)
- "Delicious handcrafted pickles for the whole family!" (too generic)
- "PICKLE LOVERS REJOICE! Premium quality jars now available!" (cringe caps + jargon)

REGLAS:
1. Headline: 30-40 chars. Hook fuerte, sin emoji.
2. Primary text: 60-120 chars típico. Puede empezar con 🥒 emoji. Termina mencionando que estamos en NJ / South Hackensack / "our shop".
3. NO incluir la dirección completa en el copy (eso va en overlay de imagen).
4. NO usar exclamaciones múltiples. Una max.
5. NO ALL CAPS sobre todo el texto.
6. Sin claims falsos (no "best", no "award-winning" si no es cierto).

Formato de respuesta: SOLO JSON válido. No texto antes/después.
{
  "headline": "...",
  "primary_text": "..."
}`;

/**
 * Genera copy para una oferta específica.
 * @param {Object} offer - Result de offer-rotator.pickOffer()
 * @returns {Promise<{headline: string, primary_text: string}>}
 */
async function generateCopy(offer) {
  const userPrompt = `Genera headline + primary text para esta oferta:

Oferta: ${offer.title}
Descripción interna: ${offer.description}
Voice hooks de inspiración (NO copiar literal, son punto de partida):
${offer.voice_hooks.map(h => `- "${h}"`).join('\n')}

Recuerda: short, punny, NJ attitude. Responde SOLO con el JSON.`;

  const startTime = Date.now();

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: [
        { type: 'text', text: VOICE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].text.trim();

    // Parse JSON (con tolerance para markdown fences que Claude a veces agrega)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.headline || !parsed.primary_text) {
      throw new Error(`Missing fields in response: ${JSON.stringify(parsed)}`);
    }

    // Validación de longitud — recomendación Meta
    if (parsed.headline.length > 60) {
      logger.warn(`[HERMES-COPY] Headline length ${parsed.headline.length} > 60 (Meta recommendation): "${parsed.headline}"`);
    }
    if (parsed.primary_text.length > 200) {
      logger.warn(`[HERMES-COPY] Primary text length ${parsed.primary_text.length} > 200 (visible truncate at ~125): "${parsed.primary_text.slice(0, 100)}..."`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[HERMES-COPY] Generated for ${offer.type} in ${elapsed}s — H: "${parsed.headline}"`);

    return {
      headline: parsed.headline,
      primary_text: parsed.primary_text,
      tokens_used: response.usage.input_tokens + response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens || 0
    };
  } catch (err) {
    logger.error(`[HERMES-COPY] Generation failed for offer=${offer.type}: ${err.message}`);
    throw err;
  }
}

module.exports = { generateCopy, VOICE_SYSTEM_PROMPT };
