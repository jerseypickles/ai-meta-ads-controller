/**
 * Copy Generator — refactor 14-may-2026.
 *
 * Antes: Claude generaba un image_prompt de 12 bloques que incluía
 * "magazine cover composition: upper 30 percent contains text reading X in
 * font Y" — gpt-image-2 renderizaba el texto DENTRO de la imagen. Resultado:
 * typography random, layout random, contaminación visual.
 *
 * Ahora: separación limpia de responsabilidades.
 *   - El image_prompt lo arma visual-concepts.js mecánicamente (deterministic):
 *     "documentary editorial photo... [visual_concept shot]... NO text, NO
 *     typography, NO signs..." → gpt-image-2 genera SOLO food porn limpio
 *     con negative space upper 25% + lower 15% reservados para overlay.
 *   - Este módulo Claude solo genera el COPY (headline + primary_text +
 *     tagline). Después el overlay-composer.js aplica el texto ENCIMA de la
 *     imagen con typography control programático (fonts custom embedded).
 *
 * Output Claude:
 *   1. headline: hook del ad de Meta (~30-40 chars, voz NJ)
 *   2. primary_text: cuerpo del ad de Meta (60-120 chars, voz NJ)
 *   3. tagline_with_arrow: NJ-voice tagline ALL CAPS con flecha → al final
 *      (~max 20 chars con la flecha incluida), usado en overlay bottom
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

const SYSTEM_PROMPT = `Eres el creative director de Jersey Pickles — tienda artisanal de pickles + olivas stuffed en South Hackensack, NJ (founded 2014). Generás COPY para Meta ads de COLD ACQUISITION (Get Directions CTA, foot traffic NJ store).

═══════════════════════════════════════════════════════════════════════
TU ÚNICA RESPONSABILIDAD: generar TEXTO (no imágenes).
═══════════════════════════════════════════════════════════════════════

La imagen la genera otro sistema (gpt-image-2) por separado, produciendo
food porn limpio sin texto. Tú producís solamente:
  1. headline — el hook principal arriba del ad
  2. primary_text — body del Meta ad (visible bajo la imagen en feed)
  3. tagline_with_arrow — tagline ALL CAPS que va en overlay bottom

═══════════════════════════════════════════════════════════════════════
REGLA #-1 — FILTRO ESTRATÉGICO COLD ACQUISITION
═══════════════════════════════════════════════════════════════════════

Cold viewer = 0.5 segundos de atención. La barra es "I want THAT right now",
no "huh, interesting". La cleverness es enemigo de performance.

TRIGGER HIERARCHY (de más fuerte a más débil):
  1. Clear concrete offer en headline (precio o gratis explícito)
  2. Cultural FOMO (chamoy, Tajín, paleta culture, Hispanic NJ market)
  3. Visceral physical craving (wet, glossy, drip, bite, juicy)
  4. Wordplay + brand wit (Big Dill, Olive Me, Brine Time)
  5. Editorial premium positioning

ANTI-PATTERNS PROHIBIDOS:
  ✗ Mystery / blind taste (curiosity ≠ store visit)
  ✗ Abstract invitations sin oferta ("Visit us", "Taste first")
  ✗ "Delicious", "premium", "award-winning" (vago corporativo)
  ✗ Headlines ambiguas o demasiado conceptuales
  ✗ CUALQUIER palabra en español — el copy SIEMPRE 100% en inglés

═══════════════════════════════════════════════════════════════════════
IDIOMA — CRÍTICO
═══════════════════════════════════════════════════════════════════════

TODO el copy (headline + primary_text + tagline) va 100% EN INGLÉS.
Mercado US. NUNCA generes texto en español, ni mezclado, ni una palabra.
Si la variant trae un hook en español, traducílo a inglés.

═══════════════════════════════════════════════════════════════════════
VOZ JERSEY PICKLES
═══════════════════════════════════════════════════════════════════════

- Confident, irreverent, NJ attitude
- Punny but smart ("Big Dill" sí, "Pickle-licious" no)
- Anti-corporate
- Casual con contracciones
- Termina invitando a visita física

EJEMPLOS DE TAGLINES (inventá similares, siempre en inglés):
- "BIG DILL CHAMOY →"
- "OLIVE ME →"
- "BRINE TIME →"
- "WALK IN, BITE OUT →"
- "PICKLE DROP →"
- "GET IN HERE →"
- "JERSEY GOLD →"
- "FRESH BRINE FRIDAYS →"
- "CRUNCH HOUR →"
- "DELI THERAPY →"
- "JERSEY OLIVE CLUB →"
- "STUFFED & ROLLING →"

═══════════════════════════════════════════════════════════════════════
REGLAS DURAS DE LONGITUD
═══════════════════════════════════════════════════════════════════════

- headline: 18-32 chars. Hook fuerte, sin emoji. UPPERCASE o Title Case.
- primary_text: 60-120 chars. Casual. Puede empezar con 🥒 emoji.
- tagline_with_arrow: max 20 chars TOTAL incluyendo la flecha → al final.
  ALL CAPS. NJ punny. DEBE incluir " →" al final.

═══════════════════════════════════════════════════════════════════════
COHERENCIA HEADLINE ↔ OFFER
═══════════════════════════════════════════════════════════════════════

El headline DEBE comunicar la offer concreta. Variant.title es la base
del headline pero podés ajustarlo a tu juicio para que pegue mejor.
Ejemplos válidos:
  - Variant title "FREE CHAMOY" → headline "FREE CHAMOY PICKLE" o "FREE CHAMOY 1ST VISIT"
  - Variant title "BRING YOUR JAR" → headline "FREE REFILL TODAY" o "BRING YOUR JAR, WE FILL IT"
  - Variant title "TASTING FLIGHT" → headline "5 PICKLES, ON US" o "TASTING FLIGHT FREE"

NO inventes ofertas distintas a la variant. Si la variant dice "free olive
1st visit", el headline NO puede prometer "free pickle" o "free chamoy".

Formato de respuesta: SOLO JSON válido (sin markdown fences, sin texto antes/después).
{
  "headline": "...",
  "primary_text": "...",
  "tagline_with_arrow": "..."
}`;

/**
 * Genera copy (headline + primary_text + tagline) para una variant.
 *
 * @param {Object} ctx
 * @param {Object} ctx.offer - Offer config
 * @param {Object} ctx.variant - Sub-variant elegida
 * @param {Object} ctx.visualConcept - Visual concept del rotator (label + mood)
 * @param {Object} ctx.addressInfo - { full, short }
 * @returns {Promise<{headline, primary_text, tagline_with_arrow, tokens_used, elapsed_s}>}
 */
async function generateCopy(ctx) {
  const { offer, variant, visualConcept, addressInfo } = ctx;

  const userPrompt = `Generá el JSON con headline + primary_text + tagline_with_arrow para esta combinación.

═══ OFFER ═══
Type: ${offer.type}
Variant title: "${variant.title}"
Variant hook: "${variant.hook}"
${variant.cultural_hook ? `Cultural angle: ${variant.cultural_hook}` : ''}

═══ VISUAL CONCEPT (contexto del shot, no lo describas literal) ═══
${visualConcept.label} — ${visualConcept.mood}

El shot visual es: ${visualConcept.shot_description.slice(0, 200)}...

El copy debe COMPLEMENTAR ese visual, no duplicarlo. Si el shot es THE DRIP
(chamoy chorreando), el headline NO necesita decir "chamoy dripping" — eso
ya se ve. Mejor headline que comunica la OFERTA, dejá que la imagen sea la
visual seduction.

═══ DIRECCIÓN ═══
${addressInfo.short}

═══ REGLAS DE OUTPUT ═══
- headline: 18-32 chars, hook de la oferta, sin emoji
- primary_text: 60-120 chars, casual NJ voice, puede empezar 🥒
- tagline_with_arrow: max 20 chars CON la flecha → al final, ALL CAPS, NJ punny

SOLO JSON. NO markdown fences.`;

  const startTime = Date.now();

  try {
    const response = await claude.messages.create({
      model: config.claude.model || 'claude-sonnet-4-6',
      max_tokens: 800,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    const required = ['headline', 'primary_text', 'tagline_with_arrow'];
    for (const f of required) {
      if (!parsed[f]) throw new Error(`Missing field: ${f}. Got keys: ${Object.keys(parsed).join(',')}`);
    }

    // Soft validations
    if (parsed.headline.length > 40) {
      logger.warn(`[HERMES-COPY] Headline ${parsed.headline.length}c > 40 — "${parsed.headline}"`);
    }
    if (parsed.tagline_with_arrow.length > 22) {
      logger.warn(`[HERMES-COPY] Tagline ${parsed.tagline_with_arrow.length}c > 22 — "${parsed.tagline_with_arrow}"`);
    }
    if (!parsed.tagline_with_arrow.includes('→')) {
      // Patch silently — append flecha si Claude se la olvidó
      parsed.tagline_with_arrow = parsed.tagline_with_arrow.trim() + ' →';
      logger.warn(`[HERMES-COPY] Tagline sin flecha — patched: "${parsed.tagline_with_arrow}"`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[HERMES-COPY] Copy generated for ${offer.type}/${variant.id} + ${visualConcept.label} in ${elapsed}s — H: "${parsed.headline}" | Tag: "${parsed.tagline_with_arrow}"`);

    return {
      headline: parsed.headline,
      primary_text: parsed.primary_text,
      tagline_with_arrow: parsed.tagline_with_arrow,
      tokens_used: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      cache_read: response.usage.cache_read_input_tokens || 0,
      elapsed_s: parseFloat(elapsed)
    };
  } catch (err) {
    logger.error(`[HERMES-COPY] generateCopy failed (${offer.type}/${variant?.id || '?'}): ${err.message}`);
    throw err;
  }
}

module.exports = { generateCopy, SYSTEM_PROMPT };
