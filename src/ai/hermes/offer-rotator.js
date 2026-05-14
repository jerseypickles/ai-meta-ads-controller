/**
 * Offer Rotator — refactor estratégico 13-may-2026 post-feedback cold acquisition.
 *
 * Brief del user (resumen):
 *   - Cold viewer = 0.5s de atención → product clarity + craving + offer + action
 *   - NO siempre "FREE [product]" — diversificar (BRING YOUR JAR, TASTING FLIGHT,
 *     PULL UP & POUR, NJ LOCALS, etc.)
 *   - FREE [product] cap ~50% del weight, otras categorías el resto
 *   - REMOVE mystery_pickle entirely (anti-pattern: curiosity ≠ store visit)
 *   - Solo "1ST-TIMER PERK" como mystery aceptable (porque el gift está garantizado)
 *
 * Trigger hierarchy aplicada: concrete offer > cultural FOMO > visceral craving >
 *   wordplay > editorial premium.
 *
 * Anti-patterns sacados del pool:
 *   - mystery_pickle entero (blind_taste, mystery_drop, flavor_of_week, roulette)
 *   - everything_bagel (no es viralmente craveable como chamoy/tajín)
 */

const OFFERS = {
  // ═══════════════════════════════════════════════════════════════
  // GROUP 1 — FREE [PRODUCT]: cap ~50% del total (cultural FOMO trigger)
  // Solo productos con visual virality real (chamoy, tajín, olive)
  // ═══════════════════════════════════════════════════════════════
  free_chamoy: {
    type: 'free_chamoy',
    weight: 0.20,
    short_label: 'Free Chamoy',
    group: 'free_product',
    description: 'Chamoy pickle hero — cultural FOMO Mexicano + visceral red drip',
    variants: [
      {
        id: 'chamoy_classic',
        title: 'FREE CHAMOY',
        hook: 'on your 1st visit',
        product_focus: 'chamoy-drenched pickle popsicle',
        treatment_keywords: [
          'generously drenched in glossy thick deep red chamoy sauce',
          'coating two thirds of the pickle leaving bottom third showing natural emerald green skin',
          'viscous chamoy drips slowly falling in irregular natural drops',
          'scattered bright red Tajín seasoning crystals catching the light',
          'on a wooden popsicle stick'
        ],
        accent_color: 'bright red',
        cultural_hook: 'chamoy + Tajín = Mexican/Latino paleta culture, viral on TikTok'
      }
    ]
  },

  free_tajin: {
    type: 'free_tajin',
    weight: 0.15,
    short_label: 'Free Tajín',
    group: 'free_product',
    description: 'Tajín-crusted pickle — chili-lime FOMO',
    variants: [
      {
        id: 'tajin_classic',
        title: 'FREE TAJÍN',
        hook: 'on your 1st visit',
        product_focus: 'Tajín-crusted pickle with lime',
        treatment_keywords: [
          'thick crystalline crust of vibrant red Tajín chili-lime seasoning',
          'covering most of the surface with visible texture of seasoning crystals',
          'glossy drizzle of fresh lime juice running down the side catching light',
          'small pieces of fresh lime zest visible on the surface',
          'fresh lime wedge resting at the base with juice droplets'
        ],
        accent_color: 'deep red',
        cultural_hook: 'Tajín = universal Mexican-American snack signal'
      }
    ]
  },

  free_olive: {
    type: 'free_olive',
    weight: 0.15,
    short_label: 'Free Olive',
    group: 'free_product',
    description: 'Stuffed olive single — premium cheese FOMO',
    variants: [
      {
        id: 'olive_feta',
        title: 'FREE OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'feta-stuffed Castelvetrano olive',
        treatment_keywords: [
          'large glossy green Castelvetrano olive stuffed densely with crumbly white feta cheese',
          'a clean fresh bite revealing the compacted feta filling packed inside with visible crumbly chunky texture',
          'small distinct fragments of feta visible on the bite edge',
          'subtle natural sheen of olive oil on the skin',
          'a few small leaves of fresh oregano scattered on top',
          'real droplets of olive brine clinging to the surface'
        ],
        accent_color: 'deep red',
        cultural_hook: 'gourmet Mediterranean premium positioning'
      },
      {
        id: 'olive_blue',
        title: 'FREE OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'blue cheese-stuffed olive',
        treatment_keywords: [
          'large glossy green olive stuffed densely with crumbly blue cheese',
          'clean fresh bite revealing the compacted blue cheese filling with distinct blue-grey veining',
          'cheese chunks showing the blue mold veins on the bite edge',
          'subtle natural sheen of olive oil',
          'single fresh thyme sprig resting on top'
        ],
        accent_color: 'deep red',
        cultural_hook: 'blue cheese pairing — sophisticated bar snack'
      }
    ]
  },

  // ═══════════════════════════════════════════════════════════════
  // GROUP 2 — NON-FREE OFFERS: el otro ~50% (diversidad para no entrenar
  // a la audience como discount-only)
  // ═══════════════════════════════════════════════════════════════
  bring_your_jar: {
    type: 'bring_your_jar',
    weight: 0.10,
    short_label: 'Bring Your Jar',
    group: 'community_repeat',
    description: 'Refill ritual — sustainability + repeat visit driver',
    variants: [
      {
        id: 'refill_jar',
        title: 'BRING YOUR JAR',
        hook: 'free refill on your visit',
        product_focus: 'fresh pickle dropped into an open glass jar',
        treatment_keywords: [
          'a glass jar mid-refill with fresh pickles tumbling in',
          'brine splashing in slow motion',
          'pickles glossy and abundant',
          'a hand from below holding the jar with intentional clean glass surface'
        ],
        accent_color: 'forest green'
      },
      {
        id: 'trae_frasco',
        title: 'TRAE TU FRASCO',
        hook: 'te lo rellenamos gratis',
        product_focus: 'jar refill — Spanish-first version',
        treatment_keywords: [
          'fresh pickles being poured into a glass jar',
          'brine cascade catching light',
          'abundant pickle quantity visible',
          'Mexican-style ceramic counter texture in background blur'
        ],
        accent_color: 'bright red',
        cultural_hook: 'bilingual NJ Hispanic market'
      }
    ]
  },

  tasting_flight: {
    type: 'tasting_flight',
    weight: 0.08,
    short_label: 'Tasting Flight',
    group: 'discovery',
    description: 'Multi-variant sampler — lowers commitment, drives discovery',
    variants: [
      {
        id: 'flight_classic',
        title: 'TASTING FLIGHT',
        hook: '5 flavors free, just pull up',
        product_focus: 'wooden flight paddle with 5 small pickle samples',
        treatment_keywords: [
          'wooden tasting paddle with 5 small cups',
          'each cup holds a different colored pickle (green dill, red Tajín, yellow curry, dark hot honey, classic green)',
          'abundance and variety visible',
          'tiny pretzel sticks or toothpicks for picking'
        ],
        accent_color: 'cream'
      }
    ]
  },

  build_your_box: {
    type: 'build_your_box',
    weight: 0.07,
    short_label: 'Build Your Box',
    group: 'bundle_aov',
    description: 'Bundle psychology — raises AOV, repeat customer signal',
    variants: [
      {
        id: 'box_4_plus_1',
        title: 'BUILD YOUR BOX',
        hook: '1 jar on us with any 4',
        product_focus: 'open craft cardboard box with multiple pickle jars',
        treatment_keywords: [
          'open kraft cardboard gift-box style with 4 visible jars of different pickles',
          'jars labeled simply',
          'one extra jar slightly outside the box suggesting the free bonus',
          'overhead three-quarter angle showing abundance'
        ],
        accent_color: 'bright red'
      }
    ]
  },

  pull_up_pour: {
    type: 'pull_up_pour',
    weight: 0.10,
    short_label: 'Pull Up',
    group: 'jersey_slang_immediate',
    description: 'Jersey slang + energy + immediate FOMO',
    variants: [
      {
        id: 'pickle_shot',
        title: 'PULL UP & POUR',
        hook: 'free pickle juice shot today',
        product_focus: 'small shot glass of pickle juice',
        treatment_keywords: [
          'a small shot glass filled with bright cloudy yellow-green pickle brine',
          'condensation droplets on the cold glass',
          'a single pickle spear used as garnish',
          'hand from below holding the shot in toast position'
        ],
        accent_color: 'electric green'
      },
      {
        id: 'late_fridays',
        title: 'OPEN LATE FRIDAYS',
        hook: 'late-night crunch on us',
        product_focus: 'pickle backlit with late-night neon vibe',
        treatment_keywords: [
          'a classic dill pickle in clean fresh light NOT moody',
          'subtle bright pink/cyan glow on the edges suggesting late-night neon',
          'still product-first — the pickle dominates the frame',
          'maybe a tiny "OPEN" sign blurred in background'
        ],
        accent_color: 'electric pink'
      }
    ]
  },

  nj_locals: {
    type: 'nj_locals',
    weight: 0.10,
    short_label: 'NJ Locals',
    group: 'local_pride',
    description: 'Geographic targeting — local pride + recurring discount',
    variants: [
      {
        id: 'sunday_locals',
        title: 'NJ LOCALS',
        hook: '10% off every Sunday',
        product_focus: 'pickle with subtle NJ-state-shape brand cue',
        treatment_keywords: [
          'a vibrant classic dill pickle as hero',
          'tiny garnish detail referencing NJ (could be small green pepper, Jersey-style mustard splash, or sub-roll crumb)',
          'product is the absolute hero — local nod is subtle'
        ],
        accent_color: 'bright red'
      }
    ]
  },

  first_timer_perk: {
    type: 'first_timer_perk',
    weight: 0.05,
    short_label: '1st-Timer Perk',
    group: 'mystery_only_guaranteed_gift',
    description: 'The ONLY acceptable mystery — gift itself is guaranteed',
    variants: [
      {
        id: 'surprise_jar',
        title: '1ST-TIMER PERK',
        hook: 'surprise jar from the chef',
        product_focus: 'wrapped jar with kraft paper and twine',
        treatment_keywords: [
          'a glass pickle jar partially wrapped in kraft paper with butcher twine',
          'a handwritten chef tag visible',
          'one pickle visible through the gap in wrapping',
          'still bright and inviting NOT dark or mysterious'
        ],
        accent_color: 'cream'
      }
    ]
  }
};

// ─── Background palette — solo BRIGHT/CRAVEABLE (anti-patterns removed) ───
const BACKGROUND_PALETTE = [
  'vibrant solid mustard yellow seamless paper background',
  'deep mustard cream yellow seamless paper background',
  'dusty terracotta seamless paper background',
  'soft vintage cream seamless paper background',
  'warm burnt orange seamless paper background',
  'soft dusty pink seamless paper background',
  'sage cream seamless paper background',
  'butter yellow seamless paper background',
  'salmon pink seamless paper background',
  'paper-bag tan seamless paper background'
];
// REMOVED anti-patterns: deep matte black, dark forest green, rich navy blue,
//                       cool sage green (era ambiguo)

// ─── POV — solo A-tier (hand_below default, macro permitido, overhead) ─────
const POV_TEMPLATES = [
  {
    id: 'hand_below',
    description: 'first-person POV hand from below holding a single large real',
    notes: 'A-tier default — intimate, ad-style, action implied, foot traffic winning shot',
    weight: 0.55
  },
  {
    id: 'macro_closeup',
    description: 'extreme macro close-up shot tightly framed on a single large real',
    notes: 'texture-focused, drip details, hunger trigger',
    weight: 0.25
  },
  {
    id: 'overhead_dramatic',
    description: 'overhead three-quarter angle shot dramatically lit of a single large real',
    notes: 'editorial top-down with depth, abundance shots',
    weight: 0.20
  }
];
// REMOVED anti-pattern: side_profile (museum-quality minimalist = curiosity not craving)

// ─── Typography combos — solo A-tier punchy (anti-patterns removed) ────────
const TYPOGRAPHY_COMBOS = [
  {
    id: 'classic_editorial',
    headline: 'very large white serif typography in Bodoni style',
    subhead: 'smaller flowing italic script',
    tagline: 'bold sans-serif uppercase',
    brand_line: 'tiny small-caps'
  },
  {
    id: 'bold_display',
    headline: 'extremely heavy slab-serif (Rockwell Black) typography',
    subhead: 'bold italic complement',
    tagline: 'thick sans-serif',
    brand_line: 'all-caps tracked sans'
  },
  {
    id: 'retro_diner',
    headline: 'hand-painted bold serif with subtle distress texture',
    subhead: 'flowing 1950s diner script',
    tagline: 'condensed retro display font',
    brand_line: 'rounded vintage sans'
  },
  {
    id: 'punchy_modern',
    headline: 'extra-bold sans-serif (Futura Black) all-caps with tight tracking',
    subhead: 'condensed italic',
    tagline: 'monospace caps',
    brand_line: 'small-caps tracked'
  }
];
// REMOVED anti-patterns:
//   - high_fashion (Didot ultra-thin = curiosity, slow read)
//   - modern_minimal (Helvetica Light + spacious = negative-space dominant)
//   - urban_grunge (stencil grunge = brand confusion in 0.5s)

/**
 * Weighted random pick básico de offer (sin anti-repeat).
 */
function pickOffer() {
  const totalWeight = Object.values(OFFERS).reduce((sum, o) => sum + o.weight, 0);
  let r = Math.random() * totalWeight;
  for (const offer of Object.values(OFFERS)) {
    r -= offer.weight;
    if (r <= 0) return offer;
  }
  return OFFERS.free_chamoy;
}

/**
 * Pick variante de un offer (sin anti-repeat).
 */
function pickVariant(offer) {
  return offer.variants[Math.floor(Math.random() * offer.variants.length)];
}

/**
 * Pick offer + variant evitando repetir las últimas 2 usadas en BD.
 */
async function pickOfferAvoidingRepeat() {
  const HermesProposal = require('../../db/models/HermesProposal');

  const recent = await HermesProposal.find({})
    .sort({ generated_at: -1 })
    .limit(2)
    .select('offer_type offer_details.title')
    .lean();

  const lastOfferType = recent[0]?.offer_type;
  const lastVariantTitle = recent[0]?.offer_details?.title;

  let candidate = pickOffer();
  if (lastOfferType && candidate.type === lastOfferType) {
    const remaining = Object.values(OFFERS).filter(o => o.type !== lastOfferType);
    const totalWeight = remaining.reduce((s, o) => s + o.weight, 0);
    if (totalWeight > 0) {
      let r = Math.random() * totalWeight;
      for (const offer of remaining) {
        r -= offer.weight;
        if (r <= 0) { candidate = offer; break; }
      }
    }
  }

  let variant = pickVariant(candidate);
  if (candidate.type === lastOfferType && variant.title === lastVariantTitle && candidate.variants.length > 1) {
    const remainingVariants = candidate.variants.filter(v => v.title !== lastVariantTitle);
    variant = remainingVariants[Math.floor(Math.random() * remainingVariants.length)];
  }

  return { offer: candidate, variant };
}

async function pickBackground() {
  const HermesProposal = require('../../db/models/HermesProposal');
  const last = await HermesProposal.findOne({})
    .sort({ generated_at: -1 })
    .select('overlay_config.background_color')
    .lean();

  const lastBg = last?.overlay_config?.background_color;
  const candidates = BACKGROUND_PALETTE.filter(bg => bg !== lastBg);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function pickPOV() {
  const HermesProposal = require('../../db/models/HermesProposal');
  const last = await HermesProposal.findOne({})
    .sort({ generated_at: -1 })
    .select('overlay_config.pov_id')
    .lean();

  const lastPOV = last?.overlay_config?.pov_id;
  const candidates = POV_TEMPLATES.filter(p => p.id !== lastPOV);

  // Weighted pick — hand_below tiene mayor weight como A-tier default
  const totalWeight = candidates.reduce((s, p) => s + (p.weight || 0.33), 0);
  let r = Math.random() * totalWeight;
  for (const pov of candidates) {
    r -= (pov.weight || 0.33);
    if (r <= 0) return pov;
  }
  return candidates[0];
}

async function pickTypography() {
  const HermesProposal = require('../../db/models/HermesProposal');
  const last = await HermesProposal.findOne({})
    .sort({ generated_at: -1 })
    .select('overlay_config.typography_id')
    .lean();

  const lastTypo = last?.overlay_config?.typography_id;
  const candidates = TYPOGRAPHY_COMBOS.filter(t => t.id !== lastTypo);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function getOffer(type) {
  return OFFERS[type] || null;
}

function listOffers() {
  return Object.values(OFFERS).map(o => ({
    type: o.type,
    short_label: o.short_label,
    weight: o.weight,
    group: o.group,
    variant_count: o.variants.length
  }));
}

// Re-export pickVisualConcept para conveniencia (vive en visual-concepts.js)
const { pickVisualConcept, listConcepts } = require('./visual-concepts');

module.exports = {
  OFFERS,
  BACKGROUND_PALETTE,
  POV_TEMPLATES,
  TYPOGRAPHY_COMBOS,
  pickOffer,
  pickVariant,
  pickOfferAvoidingRepeat,
  pickBackground,
  pickPOV,
  pickTypography,
  pickVisualConcept,
  listConcepts,
  getOffer,
  listOffers
};
