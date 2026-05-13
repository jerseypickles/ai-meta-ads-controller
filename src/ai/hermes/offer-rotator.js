/**
 * Offer Rotator — selecciona oferta + sub-variante turnante.
 *
 * Estructura (refactor 13-may-2026 post-feedback editorial prompt):
 *
 *   Cada offer tiene N sub-variantes (call-to-action distintos).
 *   Esto reemplaza el campo `title` único con un pool rotativo:
 *     - free_pickle puede ser FREE PICKLE, FREE REFILL, FREE TASTING, etc.
 *     - big_dill_chamoy puede ser CHAMOY, TAJÍN, HOT HONEY, etc.
 *
 *   Anti-repeat funciona a 2 niveles:
 *     1. Offer type (no repetir free_pickle 2 ciclos seguidos)
 *     2. Sub-variant (no repetir "FREE REFILL" 2 ciclos del mismo offer)
 */

const OFFERS = {
  free_pickle: {
    type: 'free_pickle',
    weight: 0.50,
    short_label: 'Free Pickle',
    description: 'Gateway offer — primera visita, gancho de fricción cero.',
    variants: [
      {
        id: 'first_visit',
        title: 'FREE PICKLE',
        hook: 'on your 1st visit',
        treatment_keywords: ['classic glossy dill', 'natural emerald green', 'beads of brine moisture'],
        accent_color: 'bright red'
      },
      {
        id: 'refill',
        title: 'FREE REFILL',
        hook: 'with any jar purchase',
        treatment_keywords: ['fresh pickle dropped into a jar', 'brine splashing', 'just-opened lid nearby'],
        accent_color: 'deep red'
      },
      {
        id: 'tasting',
        title: 'FREE TASTING',
        hook: 'every Saturday',
        treatment_keywords: ['pickle slice on a toothpick', 'cutting board with multiple varieties faded behind', 'fresh dill sprig nearby'],
        accent_color: 'forest green'
      },
      {
        id: 'bundle',
        title: 'BUY 2 GET 1',
        hook: 'all weekend',
        treatment_keywords: ['three pickle spears arranged vertically', 'one of them with a bite taken'],
        accent_color: 'crimson'
      },
      {
        id: 'flight',
        title: 'FREE FLIGHT',
        hook: 'with any $20+ jar',
        treatment_keywords: ['small pickle slices on individual wooden tasting paddles', 'pickle as star of the flight'],
        accent_color: 'burnt orange'
      }
    ]
  },

  big_dill_chamoy: {
    type: 'big_dill_chamoy',
    weight: 0.30,
    short_label: 'Big Dill',
    description: 'Hero product line — pickles tratados con sabores premium o virales.',
    variants: [
      {
        id: 'chamoy',
        title: 'BIG DILL CHAMOY',
        hook: 'limited time only',
        treatment_keywords: [
          'generously drenched in glossy thick deep red chamoy sauce',
          'coating roughly two thirds of the pickle leaving bottom third showing natural emerald green skin',
          'viscous chamoy drips slowly falling in irregular natural drops',
          'scattered bright red Tajín seasoning crystals clinging to the chamoy',
          'on a wooden popsicle stick'
        ],
        accent_color: 'bright red'
      },
      {
        id: 'tajin',
        title: 'BIG DILL TAJÍN',
        hook: 'this week only',
        treatment_keywords: [
          'thick crystalline crust of vibrant red Tajín chili-lime seasoning',
          'covering most of the surface with visible texture of seasoning crystals',
          'glossy drizzle of fresh lime juice running down the side',
          'small pieces of fresh lime zest on the surface',
          'fresh lime wedge resting at the base'
        ],
        accent_color: 'deep red'
      },
      {
        id: 'hot_honey',
        title: 'BIG DILL HOT HONEY',
        hook: 'sweet heat drop',
        treatment_keywords: [
          'amber hot honey glaze dripping in slow viscous streams',
          'red chili flakes scattered across the honey coating catching the light',
          'subtle steam suggestion',
          'fresh thyme sprig as garnish'
        ],
        accent_color: 'golden yellow'
      },
      {
        id: 'everything_bagel',
        title: 'BIG DILL EVERYTHING',
        hook: 'NJ deli twist',
        treatment_keywords: [
          'pickle rolled in everything bagel seasoning',
          'sesame seeds poppy seeds garlic flakes onion bits visible',
          'small flake of cream cheese on top'
        ],
        accent_color: 'cream'
      }
    ]
  },

  mystery_pickle: {
    type: 'mystery_pickle',
    weight: 0.20,
    short_label: 'Mystery',
    description: 'Repeat-visit driver. Sabor rotando semanalmente, foco en surprise.',
    variants: [
      {
        id: 'mystery_drop',
        title: 'MYSTERY DROP',
        hook: 'this Tuesday only',
        treatment_keywords: [
          'pickle partially wrapped in brown butcher paper revealing only part',
          'question mark suggestion or mystery vibe',
          'unidentifiable coating or color hint'
        ],
        accent_color: 'electric purple'
      },
      {
        id: 'flavor_of_week',
        title: 'FLAVOR OF THE WEEK',
        hook: 'rotating Tuesdays',
        treatment_keywords: [
          'pickle with unusual but appetizing coating (this week could be curry-yellow, ranch-white, sriracha-red)',
          'fresh herbs as garnish suggesting flavor profile',
          'subtle date stamp suggestion'
        ],
        accent_color: 'forest green'
      },
      {
        id: 'blind_taste',
        title: 'BLIND TASTE',
        hook: 'no spoilers',
        treatment_keywords: [
          'pickle in dramatic silhouette lighting hiding the exact coating color',
          'mysterious moody side-lit shot',
          'minimal props'
        ],
        accent_color: 'pale gold'
      },
      {
        id: 'roulette',
        title: 'PICKLE ROULETTE',
        hook: 'spin to win',
        treatment_keywords: [
          'pickle dramatically centered',
          'subtle motion blur suggesting spinning',
          'one bite taken showing surprise interior color'
        ],
        accent_color: 'crimson red'
      }
    ]
  }
};

// ─── Background palette (rota) ────────────────────────────────────────
// Colores seamless paper estilo editorial Bon Appétit
const BACKGROUND_PALETTE = [
  'deep matte black seamless paper background',
  'vibrant solid mustard yellow seamless paper background',
  'deep mustard cream yellow seamless paper background',
  'cool sage green seamless paper background',
  'dusty terracotta seamless paper background',
  'soft vintage cream seamless paper background',
  'dark forest green seamless paper background',
  'rich navy blue seamless paper background',
  'warm burnt orange seamless paper background',
  'soft dusty pink seamless paper background'
];

// ─── POV rotation (4 ángulos) ─────────────────────────────────────────
const POV_TEMPLATES = [
  {
    id: 'hand_below',
    description: 'first-person POV hand from below holding a single large real',
    notes: 'intimate, ad-style, action implied'
  },
  {
    id: 'macro_closeup',
    description: 'extreme macro close-up shot tightly framed on a single large real',
    notes: 'shallow depth of field, texture-focused'
  },
  {
    id: 'overhead_dramatic',
    description: 'overhead three-quarter angle shot dramatically lit of a single large real',
    notes: 'editorial top-down with depth'
  },
  {
    id: 'side_profile',
    description: 'side profile macro shot at table level showing the full silhouette of a single large real',
    notes: 'minimalist, brand-like, museum-quality'
  }
];

// ─── Typography combos (rotativos) ────────────────────────────────────
// Cada combo define el look del 30% top + 10% bottom del layout
const TYPOGRAPHY_COMBOS = [
  {
    id: 'classic_editorial',
    headline: 'very large white serif typography in Bodoni style',
    subhead: 'smaller flowing italic script',
    tagline: 'bold sans-serif uppercase',
    brand_line: 'tiny small-caps'
  },
  {
    id: 'modern_minimal',
    headline: 'large thin Helvetica Light all-caps with wide letter-spacing',
    subhead: 'smaller italic Garamond serif',
    tagline: 'bold geometric sans-serif',
    brand_line: 'monospace small-caps'
  },
  {
    id: 'retro_diner',
    headline: 'hand-painted bold serif with subtle distress texture',
    subhead: 'flowing 1950s script',
    tagline: 'condensed retro display font',
    brand_line: 'rounded vintage sans'
  },
  {
    id: 'urban_grunge',
    headline: 'rough stencil display font',
    subhead: 'spray-paint italic',
    tagline: 'bold condensed industrial sans',
    brand_line: 'plain typewriter mono'
  },
  {
    id: 'high_fashion',
    headline: 'ultra-thin elegant serif (Didot style)',
    subhead: 'delicate italic script',
    tagline: 'tracked-out modern sans',
    brand_line: 'small-caps with extreme letter spacing'
  },
  {
    id: 'bold_display',
    headline: 'extremely heavy slab-serif (Rockwell Black)',
    subhead: 'bold italic complement',
    tagline: 'thick sans-serif',
    brand_line: 'all-caps tracked sans'
  }
];

/**
 * Weighted random pick básico de offer (sin anti-repeat).
 */
function pickOffer() {
  const random = Math.random();
  let cumulative = 0;
  for (const offer of Object.values(OFFERS)) {
    cumulative += offer.weight;
    if (random <= cumulative) return offer;
  }
  return OFFERS.free_pickle;
}

/**
 * Pick variante de un offer (sin anti-repeat).
 */
function pickVariant(offer) {
  return offer.variants[Math.floor(Math.random() * offer.variants.length)];
}

/**
 * Pick offer + variant evitando repetir la última usada en BD.
 * Antiguamente pickOfferAvoidingRepeat — ahora extendido a 2 niveles.
 */
async function pickOfferAvoidingRepeat() {
  const HermesProposal = require('../../db/models/HermesProposal');

  // Buscar últimas 2 proposals para conocer offer_type + variante (vía
  // offer_details.title que persistimos)
  const recent = await HermesProposal.find({})
    .sort({ generated_at: -1 })
    .limit(2)
    .select('offer_type offer_details.title')
    .lean();

  const lastOfferType = recent[0]?.offer_type;
  const lastVariantTitle = recent[0]?.offer_details?.title;

  // 1. Pick offer type
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

  // 2. Pick variant del offer, evitando la última de ese mismo offer
  let variant = pickVariant(candidate);
  if (candidate.type === lastOfferType && variant.title === lastVariantTitle && candidate.variants.length > 1) {
    const remainingVariants = candidate.variants.filter(v => v.title !== lastVariantTitle);
    variant = remainingVariants[Math.floor(Math.random() * remainingVariants.length)];
  }

  return { offer: candidate, variant };
}

/**
 * Pick background color rotativo (anti-repeat sobre la última usada).
 */
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

/**
 * Pick POV rotativo (anti-repeat sobre la última usada).
 */
async function pickPOV() {
  const HermesProposal = require('../../db/models/HermesProposal');
  const last = await HermesProposal.findOne({})
    .sort({ generated_at: -1 })
    .select('overlay_config.pov_id')
    .lean();

  const lastPOV = last?.overlay_config?.pov_id;
  const candidates = POV_TEMPLATES.filter(p => p.id !== lastPOV);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick typography combo rotativo.
 */
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
    variant_count: o.variants.length
  }));
}

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
  getOffer,
  listOffers
};
