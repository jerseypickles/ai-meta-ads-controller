// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO DNA — dimensiones aprendibles de Dionisio + exploit/explore + stats.
//
// 3 dimensiones, cada una con valores tagueables. Dionisio aprende cuál rinde
// mejor (por ROAS de los videos testeados) y sesga la generación hacia el ganador
// (exploit) sin dejar de probar los otros (explore), igual que Apollo con estilos.
//
//   motion  → cómo se agarra/manipula el chip (va en la IMAGEN y en el VIDEO)
//   camera  → movimiento de cámara (solo afecta el VIDEO / Seedance)
//   scene   → entorno (solo afecta la IMAGEN / gpt-image)
// ═══════════════════════════════════════════════════════════════════════════════

const CreativeProposal = require('../../../db/models/CreativeProposal');
const TestRun = require('../../../db/models/TestRun');

// Estilo base de realismo (compartido por todos los videos). Empuja foto-realismo
// y color fiel — el modelo tiende a sobre-saturar.
const BASE_STYLE =
  'Photorealistic real handheld iPhone video, looks shot by a real person, NOT AI-generated. ' +
  'Authentic unedited phone footage, natural realistic lighting, true-to-life accurate colors, ' +
  'neutral white balance, NO color grading, NO oversaturation, preserve the exact original colors, ' +
  'real skin tones, natural film grain, realistic textures, no glossy CGI look, no slow-motion, no zoom.';

// MOODS de estilo de VIDEO — se rota uno por video para romper la mismidad de "efecto".
// Todos preservan el core: realismo, NO-IA, colores fieles, label legible, sin zoom/slow-mo.
const VIDEO_STYLE_MOODS = [
  BASE_STYLE,
  'Real handheld iPhone footage in warm natural late-afternoon light, soft golden tones but ' +
  'TRUE-to-life colors (no heavy grading), authentic UGC feel, real skin tones, natural film grain, ' +
  'NOT AI-generated, no glossy CGI look, no slow-motion, no zoom.',
  'Authentic iPhone video shot in bright clean daylight, crisp and fresh, true neutral colors, ' +
  'natural window light, real handheld micro-shake, looks shot by a real person NOT AI, realistic ' +
  'textures, no oversaturation, no glossy CGI look, no slow-motion, no zoom.'
];
function pickVideoStyle() {
  return VIDEO_STYLE_MOODS[Math.floor(Math.random() * VIDEO_STYLE_MOODS.length)];
}

// MOTION — interacción con el producto. `{unit}` = la pieza real del producto
// (rodaja de cebolla, tomate, pickle chip, etc — se reemplaza por producto).
// `img` = qué hace la mano en la foto (gpt-image), `vid` = cómo se anima (Seedance).
// `end` (opcional) = estado FINAL del motion para el piloto first+last frame (2026-06-09):
// se genera como EDICIÓN del primer frame y Seedance interpola entre ambos — la física
// deja de ser adivinanza (sabe dónde termina todo). Solo motions con desenlace claro.
const MOTIONS = [
  { key: 'lift_drip',
    img: 'a hand slowly lifting {unit} up out of the jar, a glossy strand of brine dripping off it back into the jar',
    vid: 'A hand slowly lifts {unit} up out of the jar; a glossy strand of brine drips slowly off it back into the jar. It stays in focus.',
    end: 'the same hand now holds {unit} fully raised well above the jar, the brine strand stretched thin with one last drop falling back into the jar' },
  { key: 'dip_drip',
    img: 'a hand holding {unit} just above the open tub, thick glossy brine/sauce dripping off it in a stretching strand',
    vid: 'A hand holds {unit} above the tub and thick glossy brine drips slowly off it in a stretching strand back into the tub.',
    end: 'the same hand holds {unit} in the same position above the tub, the brine strand now thinned to one final small drop about to land in the tub' },
  { key: 'pull_up',
    img: 'a hand pulling {unit} upward out of the tub, glistening wet, a little brine dripping',
    vid: 'A hand slowly pulls {unit} upward out of the tub, glistening wet, a little brine dripping off the bottom edge.',
    end: 'the same hand now holds {unit} fully clear above the tub, glistening wet, one small drop of brine falling from its bottom edge' },
  { key: 'pinch_twirl',
    img: 'two fingers pinching {unit} held up close to the camera, glistening with brine',
    vid: 'Two fingers pinch {unit} held close to the camera and slowly twirl it a few degrees; it glistens and a single drop forms at the bottom.' },
  { key: 'bite_tease',
    img: 'a hand holding {unit} up close to the camera as if about to take a bite, glossy and dripping',
    vid: 'A hand holds {unit} up close as if about to take a bite; a slow drop of brine falls and it glistens.' },
  // two_hand_open REESCRITO 2026-06-09: "product visible at the rim" + "top piece shifts"
  // → el motor de imagen ponía una pieza suelta apoyada en la tapa, y Seedance la dejaba
  // PEGADA a la tapa al abrirla (caso reportado: spear colgando de la tapa del tub).
  // Ahora: piezas SIEMPRE adentro bajo el borde, la tapa se mueve SOLA.
  { key: 'two_hand_open',
    img: 'two hands holding the jar and just twisting the lid open, the product pieces resting fully INSIDE the jar below the rim (nothing on the lid, nothing leaning against the rim), brine surface visible',
    vid: 'Two hands hold the jar and slowly twist the lid open; the lid moves ALONE — nothing rests on it, sticks to it or hangs from it. The pieces stay fully inside the jar and the brine surface ripples gently.',
    end: 'the same two hands, the lid now fully unscrewed and held to one side in one hand, the open jar showing the product resting inside, brine surface calm' },
  { key: 'fridge_reveal', selfScene: true,
    img: 'a hand opening a home refrigerator door, revealing several {product} jars neatly lined up on the fridge shelf inside, cool soft fridge light spilling out, light condensation on the jars, POV handheld UGC, the {product} labels readable',
    vid: 'A hand slowly pulls the refrigerator door open, revealing the {product} jars lined up on the shelf as the cool fridge light spills out; faint condensation, almost no other movement.' },
  // ── Composiciones distintas (no la toma típica de mano+chip+drip) ──
  // pour_bowl REESCRITO 2026-06-07: usa {unit} (no "pickle chip" hardcodeado → fallaba
  // fidelidad en cebolla/tomate). Se QUITÓ el hilo de brine continuo jar→bowl: con anillos
  // (cebolla) Seedance los ensartaba como cuentas en el hilo y los congelaba "esperando" al
  // siguiente. Ahora UNA pieza cae sola, limpia, sin hilo del que colgarse. Brine solo en el bowl.
  { key: 'pour_bowl', selfScene: true,
    img: 'a hand tilting the open {product} jar over a white ceramic bowl on a kitchen counter, {unit} in mid-air falling cleanly straight down toward the bowl on its own (just that ONE piece, NOT strung or threaded on anything), a few more already resting in a little pooled brine in the bowl, UGC iPhone',
    vid: 'A hand tilts the {product} jar and {unit} tumbles off the rim and falls straight down into the bowl under full real-world gravity, landing among the few already resting in a little pooled brine. The piece falls completely on its OWN — it is NOT threaded, strung or beaded onto any strand of brine, it does NOT freeze or hang in the air, and it does NOT wait for another piece to fall with it. One single clean discrete drop at real-time speed.' },
  { key: 'cooler_grab', selfScene: true,
    img: "a hand reaching into an ice-filled cooler and pulling out a frosty {product} jar, ice cubes and water droplets all around, condensation on the glass, backyard summer, UGC iPhone",
    vid: 'A hand lifts the frosty {product} jar up out of the ice; water droplets slide down the glass, ice settles slightly.' },
  // pantry_shelf REESCRITO 2026-06-08: "slides the jar forward off the shelf" → Seedance
  // hacía FLOTAR el frasco en el aire (producto volando). Ahora la mano AGARRA el frasco
  // que se queda anclado en el estante; solo se mueven los dedos. Nada se desliza ni flota.
  { key: 'pantry_shelf', selfScene: true,
    img: 'several {product} jars neatly lined up on a wooden pantry shelf at home, a hand resting on and grasping the front jar, warm soft light, labels readable, UGC iPhone',
    vid: 'A hand reaches in and firmly grasps the front {product} jar, fingers wrapping around it — the jar stays put ON the shelf, held in the hand, only the hand and fingers move. Every jar stays grounded on the shelf under gravity: NOTHING floats, levitates, slides off on its own, or lifts into the air.' },
  { key: 'on_food', selfScene: true,
    img: 'a hand placing {unit_food} on top of {food} as the hero topping — {unit_food} sitting flat ON the food (NOT a whole pickle standing upright), juicy and mouth-watering, casual kitchen, UGC iPhone',
    vid: 'A hand places {unit_food} onto {food}; a single drop falls and faint steam rises from the hot food.' },
  { key: 'table_spread', selfScene: true,
    img: "an open {product} jar in the center of a picnic table surrounded by a snack spread (chips, dips, drinks), top-down casual flat-lay, sunny outdoor, UGC iPhone, label readable",
    vid: 'Almost still — a faint breeze and soft light shift across the {product} jar and the spread; ambient micro-motion only.' }
];

// Deriva la "pieza" real del producto a partir del nombre — para no poner un
// ═══ REGISTRO DE FORMAS (2026-06-10, idea del creador: "leer antes de generar") ═══
// La FORMA física del producto se detecta UNA vez mirando el frasco real (label +
// contenido) con visión y se guarda en ProductBank.product_form. Este registro en
// memoria la hace mandar SOBRE las heurísticas de nombre — que ya fallaron 3 veces:
// salsa→chip, spears→whole, y "Sweet Horseradish" (label dice Pickle Chips) →
// el motor de imagen lo dibujó como relish en cuchara por sus propios priors.
const PRODUCT_FORMS = {}; // product_name(lower) → forma
function setProductForm(name, form) { if (name && form) PRODUCT_FORMS[String(name).toLowerCase()] = form; }
function getProductForm(name) { return PRODUCT_FORMS[String(name || '').toLowerCase()] || null; }

const FORM_UNITS = {
  chips: 'a single solid crunchy pickle chip (a round cross-cut slice) — this product is SOLID pickle chips in brine, NOT a sauce, NOT a relish, NOT a condiment: NEVER show a spoon or anything spoonable',
  spears: 'a single long pickle SPEAR — a quarter-cut wedge strip with one flat cut side (NOT a whole round pickle, NOT a flat chip)',
  whole: 'a single WHOLE pickled cucumber (NOT a spear, NOT a chip)',
  dip: 'a generous heaping spoonful of the chunky pickled salsa/relish on a spoon, the chunks clearly visible (this product is a chunky dip, NOT a pickle chip)',
  shredded: 'a forkful of tangy shredded sauerkraut/cabbage strands lifted on a fork, the fine pale fermented strands clearly visible (this is shredded cabbage, NOT a pickle chip or a slice)',
  onion_slices: 'a single pickled red onion slice',
  tomato_whole: 'a single whole pickled tomato (plump, golf-ball size)'
};
const FORM_UNITS_FOOD = {
  chips: 'a pickle chip laid flat',
  spears: 'a few round pickle coin slices (cut crosswise from the spear) laid flat',
  whole: 'a few round pickle coin slices (cut crosswise) laid flat',
  dip: 'a generous spoonful of the chunky pickled relish spooned on top',
  shredded: 'a generous pile of shredded sauerkraut strands',
  onion_slices: 'a pickled red onion slice',
  tomato_whole: 'a thick slice of pickled tomato'
};

// "pickle chip" genérico cuando el producto es cebolla, tomate, etc.
function productUnit(name = '') {
  // La forma LEÍDA del frasco real manda sobre cualquier heurística de nombre.
  const knownForm = getProductForm(name);
  if (knownForm && FORM_UNITS[knownForm]) return FORM_UNITS[knownForm];
  const n = name.toLowerCase();
  // Dips/salsas/relishes: NO son una pieza sólida — van en CUCHARA, no como chip.
  // CRÍTICO: este branch va ANTES del catch de 'pickle', porque "pickled salsa"
  // incluye "pickle" y caía a "a single pickle chip" (bug reportado 2026-06-06:
  // video de Pickled Salsa salía con un pickle chip en mano en vez de la salsa).
  if (isDip(n)) return 'a generous heaping spoonful of the chunky pickled salsa/relish on a spoon, the chunks clearly visible (this product is a chunky dip, NOT a pickle chip)';
  if (isShredded(n)) return 'a forkful of tangy shredded sauerkraut/cabbage strands lifted on a fork, the fine pale fermented strands clearly visible (this is shredded cabbage, NOT a pickle chip or a slice)';
  if (isVarietyBox(n)) return 'a single WHOLE pickled cucumber/spear that MATCHES the whole pickles inside the jar/box in the shot (the variety box holds whole pickles — NOT a flat chip or a slice; the held piece and the container contents must be the same)';
  // SPEARS antes del catch genérico (2026-06-10, caso reportado: "Garlic Spears Spicy"
  // caía al genérico vago y el video sacaba un WHOLE pickle del frasco de spears).
  if (n.includes('spear')) return 'a single long pickle SPEAR — a quarter-cut wedge strip with one flat cut side (NOT a whole round pickle, NOT a flat chip)';
  if (n.includes('whole')) return 'a single WHOLE pickled cucumber (NOT a spear, NOT a chip)';
  if (n.includes('onion')) return 'a single pickled red onion slice';
  if (n.includes('tomato')) return 'a single whole pickled tomato (plump, golf-ball size)';
  if (n.includes('bean')) return 'a single pickled green bean';
  if (n.includes('okra')) return 'a single pickled okra pod';
  if (n.includes('jalap') || n.includes('pepper')) return 'a single pickled jalapeño slice';
  if (n.includes('chip') || n.includes('chili') || n.includes('chamoy') || n.includes('pickle') || n.includes('horseradish') || n.includes('cucumber')) return 'a single pickle chip';
  return 'a single piece of the pickled product (matching what is inside the jar)';
}

// Forma del producto cuando va EN COMIDA (sobre hamburguesa, etc): RODAJA/slice,
// no la pieza entera — un tomate entero sobre un burger se ve raro. Lo que ya es
// plano (chips, rodajas) se deja igual.
function productUnitFood(name = '') {
  // La forma LEÍDA del frasco real manda sobre cualquier heurística de nombre.
  const knownForm = getProductForm(name);
  if (knownForm && FORM_UNITS_FOOD[knownForm]) return FORM_UNITS_FOOD[knownForm];
  const n = name.toLowerCase();
  if (isShredded(n)) return 'a generous pile of shredded sauerkraut strands';
  if (n.includes('onion')) return 'a pickled red onion slice';
  if (n.includes('tomato')) return 'a thick slice of pickled tomato';
  if (n.includes('jalap') || n.includes('pepper')) return 'a few pickled jalapeño slices';
  if (n.includes('bean')) return 'a couple of pickled green beans laid flat';
  if (n.includes('okra')) return 'a couple of pickled okra slices';
  if (n.includes('chip')) return 'a pickle chip laid flat'; // ya es plano
  // spears / pepinillos ENTEROS → en comida van en RODAJAS (coins) planas, NO el spear
  // entero parado (se ve antinatural/IA sobre un burger, caso reportado 2026-06-05).
  if (n.includes('spear') || n.includes('whole') || n.includes('cucumber') || n.includes('pickle'))
    return 'a few round pickle coin slices (cut crosswise from the spear) laid flat';
  return productUnit(name);
}

// ¿El producto queda BIEN en comida (sobre un burger)? Solo lo naturalmente plano/chico:
// chips y rodajas (cebolla/jalapeño). Spears, pickles enteros, tomates, beans, okra se ven
// RAROS sobre un burger (un spear parado, un tomate entero) → mejor NO usar el motion
// on_food para ellos; usan las otras posturas (lift/dip/drip/etc). Caso reportado 2026-06-05.
function fitsOnFood(productName = '') {
  const n = (productName || '').toLowerCase();
  // Exclusión explícita: piezas enteras/grandes/no-topping que se ven raras en burger.
  if (n.includes('spear') || n.includes('whole') || n.includes('tomato') ||
      n.includes('bean') || n.includes('okra') || n.includes('salsa')) return false;
  // Chips (planos): chip/chili/chamoy/horseradish son todos chips de pickle → van en burger.
  if (n.includes('chip') || n.includes('chili') || n.includes('chamoy') || n.includes('horseradish')) return true;
  // Rodajas naturales que quedan bien en burger.
  if (n.includes('onion') || n.includes('jalap') || n.includes('pepper')) return true;
  // Sauerkraut/slaw: topping clásico (hot dog, salchicha, brat, reuben) → va en comida.
  if (isShredded(n)) return true;
  return false; // default conservador: si no es claramente apto, no on_food
}

// ¿El producto es un DIP (salsa/relish/sauce)? Va en cuchara, no es pieza sólida.
function isDip(name = '') {
  const n = (name || '').toLowerCase();
  return n.includes('salsa') || n.includes('relish') || n.includes('sauce') || n.includes('chow') || n.includes('dip');
}

// ¿El producto es RALLADO/en hebras (sauerkraut/slaw)? Como el dip, NO es pieza sólida
// (va en forkful/pila, no se pellizca ni se muerde un "chip"), pero NO es saucy.
function isShredded(name = '') {
  const n = (name || '').toLowerCase();
  return n.includes('sauerkraut') || n.includes('kraut') || n.includes('slaw');
}

// ¿El producto es una CAJA DE VARIEDAD ("Build Your Box" / a elección)? No es un pickle
// único → mostrar una pieza suelta da incoherencia (mano con chip, envase con whole).
// Se restringe a tomas de la CAJA/jars (no levantar una pieza) + pieza WHOLE consistente.
function isVarietyBox(name = '') {
  const n = (name || '').toLowerCase();
  return (n.includes('build') && n.includes('box')) || n.includes('your box') || n.includes('variety') || n.includes('your choice');
}

// Motions que asumen una PIEZA SÓLIDA sostenida en mano — no aplican a un dip:
// no se pellizca/gira ni se muerde una cucharada de salsa. (lift/dip/pull SÍ aplican:
// "lift a spoonful out of the jar" se ve bien.)
const SOLID_PIECE_MOTIONS = new Set(['pinch_twirl', 'bite_tease']);

// Motions DESHABILITADOS globalmente — físicamente difíciles para Seedance. pour_bowl
// anima un objeto en CAÍDA LIBRE → el motor lo congela/cuelga mid-aire (2/2 weak, freeze
// que el juez ni caza). Se mantiene en MOTIONS para la data histórica del DNA, pero no se
// genera. Re-habilitar si el motor de video mejora la física de caída. (2026-06-09)
const DISABLED_MOTIONS = new Set(['pour_bowl']);

// Motions PERMITIDOS para un producto (excluye los que no le quedan, ej. on_food en spears).
function motionsForProduct(productName = '') {
  const allKeys = MOTIONS.map(m => m.key).filter(k => !DISABLED_MOTIONS.has(k));
  let keys = fitsOnFood(productName) ? allKeys : allKeys.filter(k => k !== 'on_food');
  // Dips y rallados (sauerkraut): no se pellizca/gira ni se muerde una pieza sólida.
  if (isDip(productName) || isShredded(productName)) keys = keys.filter(k => !SOLID_PIECE_MOTIONS.has(k));
  // Caja de variedad ("Build Your Box"): el HÉROE es la CAJA, no un pickle suelto. Levantar
  // UN pickle entero alto sobre la caja (lift/dip/pull) se ve raro ("flotando"). Whitelist:
  // solo motions que MUESTRAN la caja/jars (abrir, revelar, en estante, en cooler, en mesa).
  if (isVarietyBox(productName)) keys = keys.filter(k => ['two_hand_open', 'fridge_reveal', 'cooler_grab', 'pantry_shelf', 'table_spread'].includes(k));
  return keys;
}

// CAMERA — movimiento de cámara (Seedance).
const CAMERAS = [
  { key: 'static',         vid: 'Locked-off static shot, no camera movement at all.' },
  { key: 'slow_push_in',   vid: 'Very slow, subtle push-in of the camera toward the product.' },
  { key: 'slight_tilt',    vid: 'A tiny handheld tilt of the camera following the product upward.' },
  { key: 'handheld_drift', vid: 'Barely perceptible handheld camera drift, natural and unedited.' }
];

// SCENE — entorno (gpt-image).
const SCENES = [
  { key: 'poolside',       img: 'outdoors by a backyard pool, sun loungers and softly blurred blue water behind' },
  { key: 'picnic_table',   img: 'on a weathered wooden picnic table outdoors, a paper plate and a crumpled napkin nearby' },
  { key: 'kitchen_counter',img: 'on a bright kitchen counter with natural window light, casual home setting' },
  { key: 'backyard_grill', img: 'beside a backyard BBQ grill, smoky summer cookout vibe' },
  { key: 'beach_day',      img: 'on a beach towel in the sand on a bright sunny beach day' }
];

// HOOK — el GANCHO de los primeros 1-2s (lo que frena el scroll). Nueva dimensión DNA
// (2026-06-08): hasta ahora TODOS los videos usaban el mismo gancho implícito (mano+jar)
// → el thumbstop salía uniforme (~55%) y no se aprendía nada del hook. Estos son
// modificadores ADITIVOS de framing/energía (no texto — gpt-image lo garabatea); cada uno
// es una forma distinta de abrir → distinto scroll-stop → el thumbstop vuelve a discriminar.
const HOOKS = [
  { key: 'standard',        img: '' }, // baseline: la toma actual, gancho implícito
  { key: 'macro_texture',   img: 'with the framing emphasis on an EXTREME close-up of the glistening wet product texture — hyper-detailed, mouth-watering, pores and drips visible' },
  { key: 'fast_reaction',   img: 'with spontaneous candid energy, as if the camera caught the exact instant it happened — real unstaged in-the-moment UGC, slightly imperfect' },
  { key: 'pov_first_person',img: 'from a true first-person POV looking down at your own hand (selfie-arm angle), immersive as if the viewer is doing it themselves' },
  { key: 'hero_drip',       img: 'with one exaggerated glossy strand of brine as the dramatic hero focal point of the frame — appetizing and bold' },
  { key: 'messy_real',      img: 'deliberately messy-real and authentic — a casual slightly cluttered home setting, anti-stock, maximum raw-UGC believability' }
];

const DIMS = { motion: MOTIONS, camera: CAMERAS, scene: SCENES, hook: HOOKS };

/** Devuelve el objeto de un valor de dimensión (o el primero si no existe). */
function get(dim, key) {
  const list = DIMS[dim] || [];
  return list.find(x => x.key === key) || list[0];
}

/** Lista de keys de una dimensión. */
function keys(dim) {
  return (DIMS[dim] || []).map(x => x.key);
}

/**
 * Exploit/explore: pick de un valor de la dimensión.
 * - `exploreRate` (40% default): EXPLORE forzado entre los valores MENOS usados →
 *   rompe el colapso a un solo motion (la causa de que "todos los videos se vean igual").
 * - resto: EXPLOIT ponderado por ROAS + hold, PENALIZADO por rechazos (desfiguración):
 *   el "no" del creador en la review manual baja el peso de ese combo (loop de animabilidad).
 */
function pickWeighted(dim, statsByKey = {}, opts = {}) {
  const { minSamples = 2, floor = 1, k = 1.2, kHold = 3, exploreRate = 0.4, allowedKeys = null } = opts;
  let values = DIMS[dim] || [];
  // allowedKeys: restringe el set candidato (ej. excluir on_food para productos que no
  // quedan bien en burger). Aplica a explore Y exploit porque ambos usan `values`.
  if (allowedKeys) values = values.filter(v => allowedKeys.includes(v.key));
  if (!values.length) return null;

  // EXPLORE forzado (40%): favorece lo menos usado (cobertura), sin sesgo de exploit.
  if (Math.random() < exploreRate) {
    const ranked = values
      .map(v => { const s = statsByKey[v.key] || {}; return { key: v.key, used: (s.n || 0) + (s.reject_n || 0) }; })
      .sort((a, b) => a.used - b.used);
    const pool = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3))); // tercio menos usado
    return pool[Math.floor(Math.random() * pool.length)].key;
  }

  // EXPLOIT (60%): ponderado por rendimiento, penalizado por desfiguración/rechazo.
  const weights = values.map(v => {
    const s = statsByKey[v.key];
    let w = floor;
    if (s && s.n >= minSamples) {
      // ROAS = verdad de negocio (domina). hold_rate = señal TEMPRANA de retención.
      if (s.avg_roas > 0) w += s.avg_roas * k;
      if (s.avg_hold > 0) w += s.avg_hold * kHold;
    }
    if (s && (s.reject_n || 0) > 0) {
      const tot = (s.n || 0) + s.reject_n;
      w *= Math.max(0.15, 1 - (s.reject_n / tot)); // rechazos bajan el peso; nunca a cero del todo
    }
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i].key;
  }
  return values[values.length - 1].key;
}

/**
 * Stats agregados de una dimensión desde los videos testeados (proposal_id→TestRun).
 * @returns {Object} { <valueKey>: { n, avg_roas, avg_ctr, graduated, killed } }
 */
async function getDimensionStats(dim) {
  const field = dim === 'motion' ? 'motion_variant' : dim === 'hook' ? 'hook_variant' : dim;
  // Videos que CORRIERON → señal de rendimiento (ROAS/hold).
  const vids = await CreativeProposal.find({
    media_type: 'video', status: { $in: ['testing', 'graduated', 'killed', 'expired'] }
  }).select(`${field} status`).lean();
  // Videos RECHAZADOS en review manual → señal NEGATIVA (desfiguración / "se nota IA" /
  // no apto). El "no" del creador enseña al DNA a evitar ese combo (loop de animabilidad).
  const rejected = await CreativeProposal.find({
    media_type: 'video', status: 'rejected'
  }).select(`${field}`).lean();

  const agg = {};
  const ensure = (key) => (agg[key] = agg[key] || { n: 0, roas_sum: 0, ctr_sum: 0, hold_sum: 0, thumb_sum: 0, graduated: 0, killed: 0, reject_n: 0 });

  if (vids.length) {
    const ids = vids.map(v => v._id);
    const runs = await TestRun.find({ proposal_id: { $in: ids } }).select('proposal_id metrics').lean();
    const byProp = {};
    for (const t of runs) byProp[String(t.proposal_id)] = t.metrics || {};
    for (const v of vids) {
      const key = v[field];
      if (!key) continue;
      const m = byProp[String(v._id)] || {};
      const a = ensure(key);
      a.n++;
      a.roas_sum += (m.roas || 0);
      a.ctr_sum += (m.ctr || 0);
      a.hold_sum += (m.hold_rate || 0);    // % que ve el video completo
      a.thumb_sum += (m.thumbstop_rate || 0); // % que se queda a verlo
      if (v.status === 'graduated') a.graduated++;
      if (v.status === 'killed') a.killed++;
    }
  }
  for (const v of rejected) { const key = v[field]; if (key) ensure(key).reject_n++; }

  const out = {};
  for (const key in agg) {
    const a = agg[key];
    out[key] = {
      n: a.n,
      avg_roas: a.n ? a.roas_sum / a.n : 0, avg_ctr: a.n ? a.ctr_sum / a.n : 0,
      avg_hold: a.n ? a.hold_sum / a.n : 0, avg_thumbstop: a.n ? a.thumb_sum / a.n : 0,
      graduated: a.graduated, killed: a.killed, reject_n: a.reject_n
    };
  }
  return out;
}

// Reemplaza {unit} (una pieza del producto) y {product} (el frasco/nombre entero).
// La COMIDA sobre la que va el topping (on_food) — por producto. Sauerkraut va en hot dog
// (su pairing clásico, como la foto de referencia), no en burger.
function foodFor(name = '') {
  const n = (name || '').toLowerCase();
  if (isShredded(n)) return 'a grilled hot dog or bratwurst in a soft bun on a plate';
  return 'a juicy cheeseburger on a plate';
}

function _fill(text, productName) {
  const unit = productUnit(productName);
  const unitFood = productUnitFood(productName);
  return text
    .replace(/\{unit_food\}/g, unitFood)   // primero el más específico
    .replace(/\{food\}/g, foodFor(productName))
    .replace(/\{unit\}/g, unit)
    .replace(/\{product\}/g, productName || 'the product');
}

/** Prompt de la IMAGEN-fuente (gpt-image): interacción (con la pieza REAL) + escena.
 *  Si el motion trae escena propia (selfScene, ej. heladera), NO se le pega otra. */
function buildImageScene(motionKey, sceneKey, productName, hookKey) {
  const m = get('motion', motionKey);
  let img = _fill(m.img, productName);
  if (!m.selfScene) {
    const s = get('scene', sceneKey);
    img += `, ${s.img}`;
  }
  // HOOK: modificador aditivo de framing/energía (el gancho de los primeros 1-2s).
  if (hookKey) {
    const h = get('hook', hookKey);
    if (h && h.img) img += `, ${h.img}`;
  }
  return img;
}

// Cláusula de FÍSICA NATURAL (2026-06-05) — a TODOS los videos. La IA de video tiende a
// congelar/pegar objetos en el aire (se nota artificial); esto fuerza gravedad real.
const NATURAL_PHYSICS =
  'CRITICAL realistic physics: everything obeys natural real-world gravity at real-time speed — ' +
  'product pieces and brine fall, drip and settle naturally; nothing floats, freezes mid-air, ' +
  'clumps, sticks together unnaturally, or moves in rubbery slow-motion. Each falling piece moves ' +
  'independently under its own gravity — pieces NEVER thread, string or bead onto a strand of ' +
  'liquid, and NEVER hang frozen waiting for another piece to fall with them. Falling pieces ' +
  'separate and land realistically.';

/** Prompt del VIDEO (Seedance): motion (con pieza real) + cámara + estilo ROTADO + física.
 *  styleOverride opcional (para tests deterministas); si no, rota un mood. */
function buildVideoPrompt(productName, motionKey, cameraKey, styleOverride, learnDirective = '', archetype = 'classic') {
  const c = get('camera', cameraKey);
  const style = styleOverride || pickVideoStyle();
  const readable = `Keep the ${productName || 'product'} label readable and undistorted at all times.`;
  const learned = learnDirective ? ` ${learnDirective}` : '';
  // PERSONA FRONTAL (arquetipo B, 2026-06-16): motion PROPIO con la cara ESTABLE. El AI-video
  // rompe caras cuando se mueven mucho (boca al hablar/morder = deformación). Movimiento
  // mínimo y creíble: sostener/mostrar el producto a cámara + leve reacción genuina. NADA de
  // hablar o morder en cámara. Reemplaza el motion de comida (que no le queda a una persona).
  if (archetype === 'person') {
    const personMotion = `Animate as authentic in-the-moment UGC: the person makes ONE subtle, natural movement — gently raising and showing the "${productName || 'product'}" toward the camera, with a small genuine smile or slight head tilt of enjoyment and light natural hand motion. KEEP THE FACE STABLE, calm and natural across every frame — minimal mouth movement, NO talking, NO biting on camera; the face and hands must NOT warp, melt, stretch or distort. Subtle, believable, human — like a real person casually showing a product they love.`;
    return `${personMotion} ${c.vid} ${style} ${NATURAL_PHYSICS} ${readable}${learned}`;
  }
  const m = get('motion', motionKey);
  return `${_fill(m.vid, productName)} ${c.vid} ${style} ${NATURAL_PHYSICS} ${readable}${learned}`;
}

/** Estado FINAL del motion (piloto first+last frame). null si el motion no tiene
 *  desenlace claro definido — en ese caso el video va solo con primer frame. */
function buildEndFrameScene(motionKey, productName) {
  const m = (MOTIONS.find(x => x.key === motionKey)) || null;
  if (!m || !m.end) return null;
  return _fill(m.end, productName);
}

module.exports = {
  MOTIONS, CAMERAS, SCENES, DIMS, BASE_STYLE, VIDEO_STYLE_MOODS, pickVideoStyle,
  productUnit, productUnitFood, fitsOnFood, isDip, isShredded, motionsForProduct,
  get, keys, pickWeighted, getDimensionStats, buildImageScene, buildVideoPrompt,
  buildEndFrameScene, HOOKS, setProductForm, getProductForm
};
