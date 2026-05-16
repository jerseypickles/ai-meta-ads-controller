/**
 * Offer Rotator — refactor estratégico 14-may-2026.
 *
 * Aprendizaje: la mezcla anterior incluía bundles (build_your_box) + discounts
 * (nj_locals Sunday 10% off) + mystery (first_timer_perk). NADA de eso drive
 * foot traffic para cold viewers — son ofertas de loyalty / repeat, no de
 * acquisition para primera visita.
 *
 * NUEVA REGLA: TODAS las ofertas son "FREE [PRODUCT] on your 1st visit".
 * Nada de descuentos %, bundles, mystery, "every Sunday".
 *
 * El único trigger que vale para cold acquisition foot traffic es:
 *   "If I drive there RIGHT NOW, I get [free X]"
 *
 * REGLA VISUAL (16-may-2026): el producto SIEMPRE se muestra SOLO — pickle
 * u oliva con chamoy/tajín/relleno chorreando, food porn macro. NUNCA en
 * frasco ni envase de retail. Por eso se eliminaron bring_your_jar y
 * bring_your_cup (su visual inevitablemente era un envase).
 * Todo el copy en INGLÉS (mercado US), sin versiones en español.
 *
 * Pool actual (7 ofertas, todas free + 1st visit):
 *   - FREE CHAMOY PICKLE       (cultural FOMO Mexicano, drip visceral)
 *   - FREE TAJÍN PICKLE        (cultural FOMO chili-lime)
 *   - FREE OLIVE FLIGHT        (prueba TODAS las olivas stuffed — 5 variedades)
 *   - FREE STUFFED OLIVE       (single olive de discovery)
 *   - FREE PICKLE FLIGHT       (prueba 5 sabores de pickle free)
 *   - FREE BIG DILL            (bestseller iconico, on us)
 *   - FREE PICKLE JUICE SHOT   (shot brine on us)
 */

const OFFERS = {
  // ═══════════════════════════════════════════════════════════════
  // FREE [PRODUCT] on 1st visit — TODAS las ofertas siguen este patrón.
  // Single trigger: "drive there now → get free X". Nada de bundles,
  // discounts %, mystery, ni recurring deals.
  // ═══════════════════════════════════════════════════════════════

  free_chamoy: {
    type: 'free_chamoy',
    weight: 0.21,
    short_label: 'Free Chamoy',
    group: 'free_1st_visit',
    description: 'Chamoy pickle on 1st visit — cultural FOMO Mexicano + drip visceral',
    variants: [
      {
        id: 'chamoy_classic',
        title: 'FREE CHAMOY PICKLE',
        hook: 'on your 1st visit',
        product_focus: 'chamoy-drenched pickle on a stick',
        treatment_keywords: [
          'generously drenched in glossy thick deep red chamoy sauce',
          'coating two thirds of the pickle leaving bottom third showing natural emerald green skin',
          'viscous chamoy drips slowly falling in irregular natural drops',
          'scattered bright red Tajín seasoning crystals catching the light',
          'on a wooden popsicle stick'
        ],
        accent_color: 'bright red',
        cultural_hook: 'chamoy + Tajín = Mexican/Latino paleta culture'
      }
    ]
  },

  free_tajin: {
    type: 'free_tajin',
    weight: 0.15,
    short_label: 'Free Tajín',
    group: 'free_1st_visit',
    description: 'Tajín-crusted pickle on 1st visit — chili-lime FOMO',
    variants: [
      {
        id: 'tajin_classic',
        title: 'FREE TAJÍN PICKLE',
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

  free_olive_flight: {
    type: 'free_olive_flight',
    weight: 0.17,
    short_label: 'Free Olive Flight',
    group: 'free_1st_visit',
    description: 'TODAS las olivas stuffed prueba free on 1st visit — discovery del olive bar entero',
    variants: [
      {
        id: 'olive_flight_5',
        title: 'FREE OLIVE FLIGHT',
        hook: 'try all our stuffed olives free',
        product_focus: '5 stuffed olives variety: garlic, jalapeño, pimento, blue cheese, feta',
        treatment_keywords: [
          'five different bright green stuffed olives arranged in a row',
          'each olive shows its distinct filling clearly: bright red pimento, crumbly white feta, blue-grey blue cheese, fresh green jalapeño, white garlic clove',
          'glossy olive oil sheen on each',
          'olives lined up on a small dark slate or wooden tasting paddle with cocktail picks',
          'visible variety and abundance, premium artisanal feel'
        ],
        accent_color: 'deep red',
        cultural_hook: 'olive bar discovery — gourmet Mediterranean premium'
      }
    ]
  },

  free_olive: {
    type: 'free_olive',
    weight: 0.12,
    short_label: 'Free Olive',
    group: 'free_1st_visit',
    description: 'Single stuffed olive on 1st visit — premium FOMO',
    variants: [
      {
        id: 'olive_pimento',
        title: 'FREE STUFFED OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'pimento-stuffed Castelvetrano olive',
        treatment_keywords: [
          'large glossy bright green Castelvetrano olive stuffed densely with bright red pimento',
          'clean fresh bite revealing the pimento filling clearly visible',
          'subtle natural sheen of olive oil on the skin',
          'fresh oregano sprig accent on the side',
          'real droplets of olive brine clinging to the surface'
        ],
        accent_color: 'deep red'
      },
      {
        id: 'olive_jalapeno',
        title: 'FREE STUFFED OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'jalapeño-stuffed olive',
        treatment_keywords: [
          'large glossy green olive stuffed with bright green jalapeño slice clearly visible',
          'clean fresh bite revealing the jalapeño filling with seeds visible',
          'subtle natural sheen of olive oil',
          'tiny chili flakes scattered around'
        ],
        accent_color: 'bright red'
      },
      {
        id: 'olive_blue',
        title: 'FREE STUFFED OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'blue cheese-stuffed olive',
        treatment_keywords: [
          'large glossy green olive stuffed densely with crumbly blue cheese',
          'clean fresh bite revealing the compacted blue cheese filling with distinct blue-grey veining',
          'subtle natural sheen of olive oil',
          'single fresh thyme sprig resting on top'
        ],
        accent_color: 'deep red'
      },
      {
        id: 'olive_garlic',
        title: 'FREE STUFFED OLIVE',
        hook: 'on your 1st visit',
        product_focus: 'garlic-stuffed olive',
        treatment_keywords: [
          'large glossy green olive stuffed with whole peeled garlic clove clearly visible',
          'clean fresh bite revealing the white garlic clove inside',
          'subtle natural sheen of olive oil',
          'tiny sprigs of rosemary scattered nearby'
        ],
        accent_color: 'forest green'
      }
    ]
  },

  free_pickle_flight: {
    type: 'free_pickle_flight',
    weight: 0.14,
    short_label: 'Free Pickle Flight',
    group: 'free_1st_visit',
    description: 'Prueba 5 sabores de pickle free on 1st visit',
    variants: [
      {
        id: 'pickle_flight_5',
        title: 'FREE PICKLE FLIGHT',
        hook: 'try 5 pickle flavors free',
        product_focus: 'wooden flight paddle with 5 different pickle varieties',
        treatment_keywords: [
          'wooden tasting paddle with 5 small bowls or cups',
          'each holds a different pickle variety: classic green dill, bright red chamoy, vibrant Tajín-coated, dark hot honey, golden curry',
          'abundance and color variety visible',
          'wooden cocktail picks or pretzel sticks for picking'
        ],
        accent_color: 'cream'
      }
    ]
  },

  free_big_dill: {
    type: 'free_big_dill',
    weight: 0.13,
    short_label: 'Free Big Dill',
    group: 'free_1st_visit',
    description: 'Big Dill bestseller free on 1st visit — brand icon',
    variants: [
      {
        id: 'big_dill_classic',
        title: 'FREE BIG DILL',
        hook: 'our bestseller, on us',
        product_focus: 'iconic Big Dill pickle — large classic dill',
        treatment_keywords: [
          'one extra-large classic dill pickle hero — emerald green with bumpy skin',
          'glossy wet surface with visible brine droplets',
          'fresh dill sprig casually placed beside',
          'a few peppercorns and a small piece of garlic visible',
          'the pickle dominates the frame as iconic hero'
        ],
        accent_color: 'forest green'
      }
    ]
  },

  free_pickle_juice: {
    type: 'free_pickle_juice',
    weight: 0.08,
    short_label: 'Free Pickle Juice',
    group: 'free_1st_visit',
    description: 'Pickle juice shot free on 1st visit — low commitment entry',
    variants: [
      {
        id: 'pickle_shot',
        title: 'FREE PICKLE JUICE',
        hook: 'shot on us, 1st visit',
        product_focus: 'shot glass of pickle brine',
        treatment_keywords: [
          'a small shot glass filled with bright cloudy yellow-green pickle brine',
          'condensation droplets on the cold glass',
          'a single small pickle spear used as garnish across the rim',
          'hand from below holding the shot in toast position'
        ],
        accent_color: 'electric green'
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

// ─── Typography combos — TODOS editoriales/magazine (16-may-2026) ──────────
// Los IDs deben matchear las keys de TYPOGRAPHY_FONTS en overlay-composer.js.
// Sacados los combos sans-display (Anton) — no se ven "magazine".
const TYPOGRAPHY_COMBOS = [
  { id: 'editorial_vogue',   label: 'Playfair Display Black — didone alto contraste, portada Vogue' },
  { id: 'editorial_classic', label: 'DM Serif Display — editorial cálido Bon Appétit' },
  { id: 'editorial_fatface', label: 'Abril Fatface — display serif retro deli/grocer' }
];

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
