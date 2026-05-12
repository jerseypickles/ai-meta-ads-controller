/**
 * Scenes bank para Hermes — escenarios visuales LOCAL NJ.
 *
 * Diferencia clave vs Apollo (que tiene 22 scenes nacionales como "parked car",
 * "beach", "office desk"): Hermes solo usa scenes que evoquen vida cotidiana
 * en NJ / Tri-state area para reforzar el sentido "local store".
 *
 * Estas se inyectan en el prompt visual de gpt-image-2 junto con descripción
 * del producto + text overlay deseado + estilo brand Jersey Pickles.
 */

const NJ_SCENES = [
  {
    id: 'deli_counter',
    description: 'inside a classic New Jersey deli counter, glass display case with cheeses and meats visible, warm fluorescent lighting, mid-afternoon vibe',
    mood: 'classic',
    weight: 1.0
  },
  {
    id: 'diner_table',
    description: 'classic New Jersey diner table with checkered placemat, ketchup bottle and napkin dispenser visible in background, late breakfast hour soft window light',
    mood: 'nostalgic',
    weight: 1.0
  },
  {
    id: 'bbq_backyard',
    description: 'suburban New Jersey backyard BBQ in summer, grill smoke softly visible, paper plates and red solo cups on picnic table, golden hour warm sunset light',
    mood: 'casual',
    weight: 1.0
  },
  {
    id: 'boardwalk_picnic',
    description: 'Jersey Shore boardwalk picnic, wooden planks underneath, ocean breeze atmosphere, late afternoon golden light, casual snack moment',
    mood: 'breezy',
    weight: 0.9
  },
  {
    id: 'tailgate_giants',
    description: 'NFL tailgate party in a New Jersey stadium parking lot, truck bed visible, football game day energy, cooler with drinks and snacks, autumn afternoon light',
    mood: 'energetic',
    weight: 0.9
  },
  {
    id: 'charcuterie_board',
    description: 'rustic wooden charcuterie board on dark wood table, dim warm interior lighting like a Newark gastropub, multiple cheeses crackers and olives arranged artfully',
    mood: 'gourmet',
    weight: 1.0
  },
  {
    id: 'sandwich_close_up',
    description: 'overstuffed Italian sub sandwich cut diagonally on butcher paper, ingredients spilling out, Jersey deli style, harsh top-down lighting like a food magazine cover',
    mood: 'bold',
    weight: 1.0
  },
  {
    id: 'martini_bar',
    description: 'upscale dimly lit bar in Hoboken or Jersey City at night, polished bar top, martini glass with garnish, blurry city skyline behind, moody intimate lighting',
    mood: 'gourmet',
    weight: 0.8
  },
  {
    id: 'game_night',
    description: 'casual game night at home in suburban NJ living room, board game and snack bowls on coffee table, soft warm lamp light, friends gathering vibe',
    mood: 'cozy',
    weight: 0.8
  },
  {
    id: 'pizza_slice',
    description: 'classic New Jersey pizzeria slice on paper plate, brick oven visible in background slightly out of focus, casual lunch counter scene',
    mood: 'casual',
    weight: 0.8
  },
  {
    id: 'fridge_raid',
    description: 'late night kitchen scene in a NJ home, refrigerator door open with internal light glowing onto pickle jar, dark surroundings, 2am snack mood',
    mood: 'playful',
    weight: 0.7
  },
  {
    id: 'farmers_market',
    description: 'outdoor Saturday farmers market in Bergen County NJ, wooden crates and produce, friendly handmade vibe, dappled sunlight through canvas tent',
    mood: 'wholesome',
    weight: 0.7
  }
];

/**
 * Pick a scene compatible con la oferta + mood deseado.
 * Algunas scenes son más universales (peso 1.0), otras situacionales (0.7-0.9).
 */
function pickScene(filters = {}) {
  let candidates = NJ_SCENES;

  if (filters.mood) {
    candidates = candidates.filter(s => s.mood === filters.mood);
    if (candidates.length === 0) candidates = NJ_SCENES;  // fallback
  }

  // Weighted random pick
  const totalWeight = candidates.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * totalWeight;
  for (const scene of candidates) {
    r -= scene.weight;
    if (r <= 0) return scene;
  }
  return candidates[0];
}

/**
 * Pick scene that matches a specific offer type (algunas combinaciones
 * son más naturales — ej. martini_bar va bien con olive offers).
 */
function pickSceneForOffer(offerType) {
  const offerScenes = {
    free_pickle: ['deli_counter', 'diner_table', 'sandwich_close_up', 'fridge_raid', 'pizza_slice'],
    big_dill_chamoy: ['boardwalk_picnic', 'tailgate_giants', 'farmers_market', 'bbq_backyard'],
    mystery_pickle: ['charcuterie_board', 'game_night', 'martini_bar', 'deli_counter']
  };

  const preferredIds = offerScenes[offerType];
  if (!preferredIds || preferredIds.length === 0) {
    return pickScene();
  }

  const preferred = NJ_SCENES.filter(s => preferredIds.includes(s.id));
  if (preferred.length === 0) return pickScene();

  const totalWeight = preferred.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * totalWeight;
  for (const scene of preferred) {
    r -= scene.weight;
    if (r <= 0) return scene;
  }
  return preferred[0];
}

module.exports = { NJ_SCENES, pickScene, pickSceneForOffer };
