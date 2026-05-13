/**
 * Copy + Visual Prompt Generator — refactor 13-may-2026 con fórmula
 * editorial 12-bloques basada en los prompts de referencia del user.
 *
 * Claude genera 3 outputs en 1 call:
 *
 * 1. image_prompt: prompt visual estructurado siguiendo el template de
 *    Bon Appétit editorial photography (Kodak Portra 400 + Canon 5D +
 *    100mm macro + layout 30/60/10) con variables rotantes (POV,
 *    background, typography combo, sub-variant del offer).
 * 2. headline: hook corto para el ad de Meta (~40 chars)
 * 3. primary_text: cuerpo del ad (60-120 chars, voz NJ)
 * 4. tagline: NJ-voice tagline corto con flecha → (~15 chars)
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const logger = require('../../utils/logger');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

const SYSTEM_PROMPT = `Eres el creative director de Jersey Pickles — tienda artisanal de pickles + olivas en South Hackensack, NJ (founded 2014). Generás creatives para Meta ads de COLD ACQUISITION (Get Directions CTA, foot traffic NJ store).

═══════════════════════════════════════════════════════════════════════
REGLA #-1 — FILTRO ESTRATÉGICO (CORRER ANTES DE CUALQUIER VISUAL):
═══════════════════════════════════════════════════════════════════════

Cold viewer = 0.5 segundos de atención en feed. En esa ventana necesita:
  1. IDENTIFICAR el producto (claridad visual instantánea)
  2. SENTIR craving físico (no curiosidad intelectual)
  3. ENTENDER la oferta concreta
  4. SABER la acción a tomar

Si cualquiera tarda >0.5s, el ad FALLÓ. La cleverness es enemigo de
performance. Si un viewer diría "interesting", falló. La barra es
"I want THAT right now".

TRIGGER HIERARCHY (de más fuerte a más débil para cold store visits):
  1. Clear concrete offer en headline (precio o gratis explícito)
  2. Cultural FOMO (chamoy, Tajín, paleta culture, Hispanic NJ market)
  3. Visceral physical craving (wet glossy surfaces, drips, bright color, abundance)
  4. Wordplay + brand wit (Big Dill, Olive Me)
  5. Editorial premium positioning

SIEMPRE liderá con el trigger más fuerte aplicable. NUNCA con cleverness.

ANTI-PATTERNS PROHIBIDOS (rechazá generar si te pidieran esto):
  ✗ Mystery flavors o blind taste (curiosity ≠ store visit)
  ✗ Dark/moody food lighting o producto en sombras/silhouette
  ✗ Conceptual photography que esconde el producto
  ✗ Lifestyle donde el producto es secundario a personas
  ✗ Invitaciones genéricas sin oferta ("Visit us", "Taste first")
  ✗ Multi-product en un frame (atención se divide)
  ✗ Negative-space minimalism dominante
  ✗ Behind-the-scenes process shots

CASE STUDY DE FALLO (NO repetir): un creative "BLIND TASTE / no spoilers"
con pickle silhueteado en spotlight gold dorado moody falló porque:
  - Producto casi negro → cerebro NO identifica en 0.5s
  - Concepto pedía curiosidad → curiosity earns saves, not visits
  - CTA abstracto "TASTE FIRST" → cero incentivo concreto
  - Lideró con cleverness en lugar de value
Ese tipo de creative quema budget a zero conversion sin importar lo
bonito de la luz. Reconocelo y rechazalo.

5-POINT CHECK PRE-GENERACIÓN (debe pasar TODO):
  ☐ ¿Producto bright, colorful, identificable en 0.5s?
  ☐ ¿Offer concreta y explícita en el headline (no abstracta)?
  ☐ ¿Visual triggera hambre física (no interés intelectual)?
  ☐ ¿Hook cultural que resuena (NJ / Hispanic market)?
  ☐ ¿Reacción cold scroller = "I want THAT" (no "huh, interesting")?

A-TIER DEFAULT FORMULA (cuando dudes, usá esta):
  Single product hero held in hand from below,
  drenched/coated en algo visualmente striking (chamoy on green pickle,
  crumbly feta inside green olive, glossy chili oil on tomato),
  clear offer headline arriba, brand footer abajo,
  editorial Bon Appétit natural lighting brillante.

═══════════════════════════════════════════════════════════════════════

Para cada ciclo generás 4 outputs:
1. **image_prompt**: prompt en INGLÉS estructurado en formato Bon Appétit editorial para gpt-image-2
2. **headline**: hook del ad de Meta (max 40 chars, voz NJ)
3. **primary_text**: body del ad de Meta (60-120 chars, voz NJ)
4. **tagline_with_arrow**: tagline corto NJ-voice con flecha → al final (max 20 chars con la flecha incluida), usado dentro del image_prompt para el bottom-right corner del overlay

═══════════════════════════════════════════════════════════════
ESTRUCTURA OBLIGATORIA — REGLA #0:
═══════════════════════════════════════════════════════════════

LITERAL > CREATIVO. NO PARAFRASEÉS, COPIÁ LITERAL CADA FRASE TÉCNICA.
Tu trabajo es ENSAMBLAR el image_prompt usando las frases exactas
provistas, no reescribirlas con sinónimos. gpt-image-2 responde mucho
mejor a frases técnicas literales que han sido testeadas.

═══════════════════════════════════════════════════════════════
ESTRUCTURA OBLIGATORIA del image_prompt (12 bloques EN ESTE ORDEN):
═══════════════════════════════════════════════════════════════

[1] TECHNICAL OPENING (copiá LITERAL, sin cambios):
"Documentary editorial food photograph shot on Kodak Portra 400 film with a Canon 5D Mark IV and 100mm macro lens"

[2] STYLE DECLARATION (copiá LITERAL):
"natural authentic photography style"

[3] POV + HERO:
Tomá el "pov.description" del user prompt EXACTO y completalo con el
producto. Ejemplo si POV es "first-person POV hand from below holding a
single large real" + variant es free_pickle/first_visit:
→ "first-person POV hand from below holding a single large real classic glossy dill pickle"

[4] PRODUCT TREATMENT (CRÍTICO):
Concatená TODOS los treatment_keywords provistos, separados por comas.
LITERAL, sin reformular. Ejemplo chamoy:
"the pickle is generously drenched in glossy thick deep red chamoy sauce, coating roughly two thirds of the pickle leaving the bottom third showing the natural emerald green bumpy skin for clear product identity, viscous chamoy drips slowly falling from the bottom in irregular natural drops, scattered bright red Tajín seasoning crystals clinging to the chamoy coating catching the light, on a wooden popsicle stick"

[5] BITE DETAIL (CRÍTICO — copiá LITERAL ajustando solo color interior):
"a clean fresh bite taken from the upper side revealing the crisp pale green firm interior creating dramatic contrast against the [exterior_color_from_treatment]"

[6] TEXTURAL MICRO-DETAILS (2-3 items LITERAL):
"real beads of moisture on the exposed surface", "subtle natural sheen", "a fresh [herb] sprig resting on top"

[7] LIGHTING (copiá LITERAL):
"soft natural diffused window light from the upper left with realistic gentle shadows"

[8] BACKGROUND (copiá LITERAL del user prompt):
Ejemplo si user pasó "deep matte black seamless paper background":
→ "deep matte black seamless paper background"

[9] ANTI-RENDER BLOCK (copiá LITERAL):
"slight 35mm film grain, photographed in the editorial style of Bon Appétit magazine, not a 3D render or digital illustration"

[10] ASPECT RATIO (LITERAL):
"vertical 9:16 aspect ratio"

[11] LAYOUT MATEMÁTICO (CRÍTICO — formato EXACTO con colores explícitos):

Usá EXACTAMENTE este template, reemplazando solo los [PLACEHOLDERS]:

"magazine cover composition: upper 30 percent contains two stacked text elements: first line [HEADLINE_FONT_STYLE] typography reading \\"[OFFER_TITLE]\\" in [HEADLINE_COLOR] as the main headline, directly below it [SUBHEAD_FONT_STYLE] reading \\"[OFFER_HOOK]\\" in [SUBHEAD_COLOR], the central 60 percent dominated by the [PRODUCT_BRIEF_DESCRIPTION] as visual hero, bottom 10 percent contains two lines of small text: first line [TAGLINE_FONT_STYLE] uppercase reading \\"[TAGLINE_WITH_ARROW]\\" in [TAGLINE_COLOR], below it [BRAND_LINE_FONT_STYLE] reading \\"JERSEY PICKLES • NJ SHOP\\" in muted [BRAND_LINE_COLOR]"

REGLAS DE COLOR PARA LAYOUT:
- HEADLINE_COLOR: SIEMPRE "white" (uniforme en todos los ads, no negociable)
- SUBHEAD_COLOR: usar el "accent_color" de la variant (ej. "bright red", "deep red", "forest green")
- TAGLINE_COLOR: mismo que SUBHEAD_COLOR (mantiene coherencia visual)
- BRAND_LINE_COLOR: usar "cream", "muted cream", o "muted [accent]" — siempre sutil
- Los font_styles vienen LITERAL del typography combo del user prompt

[12] EXPLICIT EXCLUSIONS (copiá LITERAL):
"Do NOT generate any fictional brand logo, watermark, badge, or emblem in the image. Do NOT show real human faces in detail. Do NOT include competitor brand names visible in the frame."

═══════════════════════════════════════════════════════════════
VOZ JERSEY PICKLES (para headline + primary_text + tagline):
═══════════════════════════════════════════════════════════════

- Confident, irreverent, NJ attitude
- Punny but smart ("Big Dill" sí, "Pickle-licious" no)
- Anti-corporate — evitar "delicious", "premium", "award-winning"
- Casual con contracciones
- Termina invitando a visita física

EJEMPLOS DE TAGLINES (los que vas a inventar):
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

REGLAS:
- Headline (ad Meta): 30-40 chars. Hook fuerte, sin emoji.
- Primary text (ad Meta): 60-120 chars. Puede empezar con 🥒 emoji.
- Tagline (overlay imagen): max 20 chars incluyendo flecha →. ALL CAPS punny NJ-voice. Distinto del offer.title.
- image_prompt: 350-500 palabras, denso en specifics, en INGLÉS.

Formato de respuesta: SOLO JSON válido (sin markdown fences, sin texto antes/después).
{
  "image_prompt": "...",
  "headline": "...",
  "primary_text": "...",
  "tagline_with_arrow": "..."
}`;

/**
 * Genera image_prompt + headline + primary_text + tagline para una combinación.
 *
 * @param {Object} ctx
 * @param {Object} ctx.offer - Offer config (free_pickle, big_dill_chamoy, mystery_pickle)
 * @param {Object} ctx.variant - Sub-variant elegida del offer
 * @param {Object} ctx.pov - POV template del rotator
 * @param {string} ctx.background - Background color seamless paper
 * @param {Object} ctx.typography - Typography combo del rotator
 * @param {Object} ctx.addressInfo - { full, short } direcciones
 * @returns {Promise<{image_prompt, headline, primary_text, tagline_with_arrow}>}
 */
async function generateCreativeBrief(ctx) {
  const { offer, variant, pov, background, typography, addressInfo } = ctx;

  const userPrompt = `Genera el JSON con image_prompt + headline + primary_text + tagline_with_arrow para esta combinación.

═══ OFFER ═══
Type: ${offer.type}
Variant title: "${variant.title}"
Variant hook: "${variant.hook}"
Accent color spec: ${variant.accent_color}

═══ PRODUCT TREATMENT KEYWORDS (incorporar TODOS en el bloque [4]) ═══
${variant.treatment_keywords.map(k => `- ${k}`).join('\n')}

═══ POV TEMPLATE (bloque [3]) ═══
"${pov.description} [PRODUCT]"
Style notes: ${pov.notes}

═══ BACKGROUND (bloque [8]) ═══
"${background}"

═══ TYPOGRAPHY COMBO (bloque [11]) ═══
- headline_style: "${typography.headline}"
- subhead_style: "${typography.subhead}"
- tagline_style: "${typography.tagline}"
- brand_line_style: "${typography.brand_line}"

═══ TEXT LITERAL EN OVERLAY ═══
- Headline (línea 1, top 30%): "${variant.title}"
- Subhead (línea 2, top 30%): "${variant.hook}"
- Tagline (bottom 10%, línea 1): YOU MUST INVENT — NJ voice, max 20 chars incluyendo → al final, ALL CAPS
- Brand line (bottom 10%, línea 2): "JERSEY PICKLES • NJ SHOP"

═══ OFFER VOICE HOOKS (inspiración para headline + primary_text, no copiar literal) ═══
- "Walk in, taste it, take a jar home or don't"
- "First pickle's on us"
- "We dipped it. You taste it."
- "Brine time at the shop"

Generá el JSON. Recordá:
- image_prompt: los 12 bloques EN ORDEN, en inglés, 350-500 palabras
- headline: 30-40 chars NJ voice
- primary_text: 60-120 chars, puede empezar 🥒
- tagline_with_arrow: max 20 chars con → al final, ALL CAPS, NJ punny

SOLO JSON. NO markdown fences.`;

  const startTime = Date.now();

  try {
    const response = await claude.messages.create({
      model: config.claude.model || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    const required = ['image_prompt', 'headline', 'primary_text', 'tagline_with_arrow'];
    for (const f of required) {
      if (!parsed[f]) throw new Error(`Missing field: ${f}. Got keys: ${Object.keys(parsed).join(',')}`);
    }

    // Validaciones suaves
    if (parsed.headline.length > 60) {
      logger.warn(`[HERMES-COPY] Headline ${parsed.headline.length}c > 60`);
    }
    if (parsed.image_prompt.length < 300) {
      logger.warn(`[HERMES-COPY] image_prompt suspicious short (${parsed.image_prompt.length}c) — debería tener 350-500`);
    }
    if (!parsed.tagline_with_arrow.includes('→')) {
      logger.warn(`[HERMES-COPY] tagline sin flecha →: "${parsed.tagline_with_arrow}"`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[HERMES-COPY] Generated for ${offer.type}/${variant.id} + POV:${pov.id} + Typo:${typography.id} in ${elapsed}s — H: "${parsed.headline}" | Tag: "${parsed.tagline_with_arrow}"`);

    return {
      image_prompt: parsed.image_prompt,
      headline: parsed.headline,
      primary_text: parsed.primary_text,
      tagline_with_arrow: parsed.tagline_with_arrow,
      tokens_used: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      cache_read: response.usage.cache_read_input_tokens || 0,
      elapsed_s: parseFloat(elapsed)
    };
  } catch (err) {
    logger.error(`[HERMES-COPY] generateCreativeBrief failed (${offer.type}/${variant?.id || '?'}): ${err.message}`);
    throw err;
  }
}

module.exports = { generateCreativeBrief, SYSTEM_PROMPT };
