/**
 * Visual Concepts — los 10 "money shots" del repertorio Hermes (14-may-2026).
 *
 * El problema que resuelven: con solo offer/POV/typography/background rotando,
 * los creativos terminaban viéndose iguales (siempre "cups en tabla de madera").
 * Estos 10 concepts cambian el LENGUAJE VISUAL completo de cada ad.
 *
 * Cada concept define:
 *   - shot_description: prompt LITERAL para gpt-image-2 (qué shot generar)
 *   - composition_directive: garantiza negative space upper 25% + lower 15%
 *     para overlay programático (el texto va POR ENCIMA, no rendered por
 *     gpt-image-2)
 *   - lighting + mood: el feel del shot
 *   - product_compatibility: qué productos del catálogo aplican
 *   - weight: probabilidad de selección
 *
 * El rotator hace anti-repeat sobre el visual_concept_id de las últimas 2
 * proposals — fuerza variedad mucho mayor que offer-rotator solo.
 */

const VISUAL_CONCEPTS = {
  the_drip: {
    id: 'the_drip',
    label: 'THE DRIP',
    weight: 0.23,
    shot_description: 'extreme macro close-up of glossy thick deep red chamoy sauce pouring in slow motion from above onto a single bright green pickle slice, viscous chamoy strands suspended mid-air mid-fall, droplets clinging to the pickle surface, wet glossy texture catching hard light, tiny scattered bright red Tajín seasoning crystals visible',
    composition_directive: 'subject centered occupying middle 60 percent of frame vertically, upper 25 percent of frame is pure dark seamless negative space with nothing in it, lower 15 percent of frame is pure dark seamless negative space with nothing in it',
    lighting: 'single hard rim light from upper left creating dramatic specular highlights on the wet surface, deep shadows in the negative space zones',
    mood: 'dramatic, dynamic, mid-action, hunger-triggering',
    product_compatibility: ['free_chamoy', 'free_tajin', 'free_pickle_juice'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'pure black seamless background, slight vignetting'
  },

  the_stick: {
    id: 'the_stick',
    label: 'THE STICK',
    weight: 0.20,
    shot_description: 'single large bright emerald green dill pickle skewered on a thick natural wooden popsicle stick held upright by a hand from below entering frame from the bottom, glossy wet pickle skin with bumpy texture clearly visible, single droplet of fresh brine running down the side of the pickle, the pickle dominates as hero subject',
    composition_directive: 'pickle on stick occupies central vertical 65 percent of frame, hand barely visible only at bottom edge, upper 25 percent of frame is clean simple background with no objects, lower 15 percent of frame has only the wooden stick base with empty space around it',
    lighting: 'bright natural sunlight from upper left, clean shadows, bright cheerful daylight feel',
    mood: 'iconic, brand-building, street food energy, immediate craving',
    product_compatibility: ['free_chamoy', 'free_tajin', 'free_big_dill', 'free_pickle_juice'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'vibrant solid mustard yellow seamless paper background'
  },

  the_bite: {
    id: 'the_bite',
    label: 'THE BITE',
    weight: 0.17,
    shot_description: 'extreme macro close-up of a single pickle slice or pickle spear with a clean fresh bite taken from one side, the bite reveals the dramatic cross-section interior with pale crisp green firm flesh visible, tiny brine droplets spraying out from the bite, visible crunch texture, exterior glossy and wet contrasting against the matte interior',
    composition_directive: 'pickle bite shot centered in middle 55 percent of frame, upper 25 percent of frame is clean simple negative space with no objects, lower 20 percent of frame is clean simple negative space with no objects',
    lighting: 'soft natural diffused window light from upper left, gentle highlight on bite edge, subtle shadows',
    mood: 'texture porn, crunch, fresh, visceral hunger',
    product_compatibility: ['free_chamoy', 'free_tajin', 'free_big_dill', 'free_olive', 'free_pickle_flight'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'soft vintage cream seamless paper background'
  },

  the_lick: {
    id: 'the_lick',
    label: 'THE LICK',
    weight: 0.11,
    shot_description: 'a hand entering frame from the right side fingers gripping a pickle chip dripping with glossy red chamoy sauce, chamoy running down the fingers, wet glossy texture on both skin and chip, single drop of chamoy mid-fall from the bottom of the chip, casual messy abundance, no faces visible only hand and forearm',
    composition_directive: 'hand and pickle chip occupy right two-thirds of middle vertical band of frame, upper 25 percent of frame is clean empty background, lower 15 percent of frame is clean empty surface',
    lighting: 'warm natural daylight from upper right, glossy specular highlights on wet skin and chip, soft shadows',
    mood: 'visceral, messy, intimate, hunger taking over',
    product_compatibility: ['free_chamoy', 'free_tajin', 'free_pickle_juice'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'warm burnt orange seamless paper background'
  },

  the_pour_action: {
    id: 'the_pour_action',
    label: 'THE POUR',
    weight: 0.09,
    shot_description: 'a chamoy sauce bottle or a Tajín seasoning shaker tilted at the top of frame mid-pour with liquid or seasoning streaming downward onto a single pickle target below, the stream caught in mid-motion as a continuous flowing arc, splash pattern visible on the pickle surface, action frozen in time, droplets and grains suspended in the air around the stream',
    composition_directive: 'pouring vessel at top quarter of frame just barely visible, stream of liquid or seasoning fills middle band, target pickle in lower middle, upper 22 percent of frame has only the vessel rim and stream beginning with mostly empty background, lower 15 percent of frame is clean empty surface',
    lighting: 'hard side spotlight from left to catch the stream texture, dark background to make the stream pop, dramatic',
    mood: 'dynamic, action moment, ASMR-like, in-the-act',
    product_compatibility: ['free_chamoy', 'free_tajin', 'free_big_dill'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'deep moody dark brown seamless background'
  },

  the_olive_bar: {
    id: 'the_olive_bar',
    label: 'THE OLIVE BAR',
    weight: 0.12,
    shot_description: 'five distinct bright green stuffed olives arranged in a clean tight horizontal row across the middle of the frame, each olive shows its filling clearly and distinctly: one with bright red pimento, one with crumbly white feta cheese, one with blue-grey blue cheese veining, one with bright green jalapeño slice and visible seeds, one with whole white peeled garlic clove, all olives glistening with olive oil, scattered fresh oregano and rosemary sprigs as accent, abundance and variety showcased',
    composition_directive: 'olives arranged in horizontal row occupying middle 55 percent of frame vertically, upper 25 percent of frame is clean empty background with no objects, lower 20 percent of frame is clean empty surface with at most a tiny rosemary sprig accent',
    lighting: 'bright clean overhead studio light, each olive crisply lit with visible filling textures, soft shadows underneath, gourmet food magazine clarity',
    mood: 'discovery, variety, gourmet abundance, premium showcase',
    product_compatibility: ['free_olive_flight', 'free_olive'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'soft warm cream seamless paper background'
  },

  the_cocktail: {
    id: 'the_cocktail',
    label: 'THE COCKTAIL',
    weight: 0.06,
    shot_description: 'classic martini glass filled with crystal clear icy liquid, garnished with three large bright green stuffed olives skewered on a single silver cocktail pick crossing the rim, condensation droplets running down the outside of the glass, the olives clearly stuffed with visible filling such as bright red pimento or crumbly white feta peeking through, sophisticated cocktail bar atmosphere',
    composition_directive: 'martini glass centered occupying middle 60 percent of frame, glass positioned slightly low so olives sit at center height, upper 25 percent of frame is moody empty background with subtle bokeh, lower 15 percent of frame is clean empty bar surface',
    lighting: 'moody bar lighting, single warm spotlight from upper right hitting the glass and olives, deep blue shadow tones in negative space, glass refraction visible',
    mood: 'sophisticated, after-work, discovery of olives category, adult premium',
    product_compatibility: ['free_olive', 'free_olive_flight'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'deep moody dark blue with subtle bokeh of distant bar lights'
  },

  the_stack: {
    id: 'the_stack',
    label: 'THE STACK',
    weight: 0.02,
    shot_description: 'multiple stuffed olives tumbling and falling mid-air from above into frame, mix of different stuffed olives visible (some with bright red pimento filling, some with crumbly white feta filling, some with green jalapeño filling), olives caught in motion at various heights, droplets of olive brine suspended around them, dynamic explosive composition',
    composition_directive: 'olives scattered across middle 55 percent of frame in motion, upper 25 percent of frame shows only one or two olives entering frame from top with mostly empty background, lower 20 percent of frame has only a couple of olives reaching the bottom with empty surface',
    lighting: 'bright clean studio light, hard shadows on the falling olives for depth, freeze-motion clarity',
    mood: 'dynamic, abundance, variety showcase, fun energy',
    product_compatibility: ['free_olive', 'free_olive_flight'],
    aspect_ratio: 'vertical 9:16 portrait',
    background: 'bright clean white seamless paper background'
  }
};

/**
 * Build the canonical image_prompt para gpt-image-2 dado un visual_concept.
 *
 * Garantiza:
 *   - Negative space upper 25% + lower 15% para overlay programático
 *   - NEGATIVE PROMPT explícito: NO text, NO typography, NO signs, NO labels
 *   - Aspect ratio vertical 9:16
 *   - Photography style (Kodak Portra 400 + Canon 5D + 100mm macro film grain)
 *
 * @param {Object} concept - visual concept (de VISUAL_CONCEPTS)
 * @param {Object} variant - offer variant (treatment_keywords override defaults)
 * @returns {string} prompt ready para gpt-image-2
 */
function buildImagePrompt(concept, variant) {
  const treatmentLine = variant?.treatment_keywords?.length
    ? `Product treatment details: ${variant.treatment_keywords.join(', ')}.`
    : '';

  return `Documentary editorial food photograph shot on Kodak Portra 400 film with a Canon 5D Mark IV and 100mm macro lens, natural authentic photography style.

SHOT: ${concept.shot_description}.

${treatmentLine}

LIGHTING: ${concept.lighting}.

BACKGROUND: ${concept.background}.

COMPOSITION (CRITICAL): ${concept.composition_directive}. The upper and lower negative space zones must be COMPLETELY EMPTY of any objects, products, props, garnishes, plates, hands, or visual elements — these zones will be used for text overlay applied separately after image generation.

ASPECT RATIO: ${concept.aspect_ratio}.

FILM STYLE: slight 35mm film grain, photographed in the editorial style of Bon Appétit magazine, not a 3D render or digital illustration.

STRICT NEGATIVE PROMPTS (the image must NOT contain any of these): NO text of any kind, NO typography, NO words, NO letters, NO numbers, NO signs, NO labels, NO logos, NO writing, NO lettering, NO brand names, NO menu boards, NO chalkboards with writing, NO product packaging with visible text, NO captions, NO subtitles, NO watermarks, NO badges, NO emblems anywhere in the image. The image must be PURELY photographic food content with no graphic design elements whatsoever. Do NOT show real human faces in detail. Do NOT include competitor brand names visible in the frame.`;
}

/**
 * Pick a visual concept evitando repetir las últimas 2 usadas, ponderado por
 * weight + filtrado por product compatibility con el offer.
 *
 * @param {string} offerType - tipo de offer (free_chamoy, etc) para filter
 * @returns {Promise<Object>} visual concept
 */
async function pickVisualConcept(offerType) {
  const HermesProposal = require('../../db/models/HermesProposal');

  const recent = await HermesProposal.find({})
    .sort({ generated_at: -1 })
    .limit(2)
    .select('overlay_config.visual_concept_id')
    .lean();

  const recentIds = recent
    .map(p => p.overlay_config?.visual_concept_id)
    .filter(Boolean);

  let candidates = Object.values(VISUAL_CONCEPTS);

  // Filter por product compatibility — solo concepts que combinan con el offer
  if (offerType) {
    const compatible = candidates.filter(c =>
      !c.product_compatibility || c.product_compatibility.includes(offerType)
    );
    if (compatible.length > 0) candidates = compatible;
  }

  // Anti-repeat — sacar los últimos 2 si hay candidatos suficientes
  const filtered = candidates.filter(c => !recentIds.includes(c.id));
  if (filtered.length > 0) candidates = filtered;

  // Weighted random
  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * totalWeight;
  for (const concept of candidates) {
    r -= concept.weight;
    if (r <= 0) return concept;
  }
  return candidates[0];
}

function getConcept(id) {
  return VISUAL_CONCEPTS[id] || null;
}

function listConcepts() {
  return Object.values(VISUAL_CONCEPTS).map(c => ({
    id: c.id,
    label: c.label,
    weight: c.weight,
    mood: c.mood,
    compatible_offers: c.product_compatibility
  }));
}

module.exports = {
  VISUAL_CONCEPTS,
  buildImagePrompt,
  pickVisualConcept,
  getConcept,
  listConcepts
};
