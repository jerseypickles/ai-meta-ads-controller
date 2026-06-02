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

// MOTION — interacción con el producto. `{unit}` = la pieza real del producto
// (rodaja de cebolla, tomate, pickle chip, etc — se reemplaza por producto).
// `img` = qué hace la mano en la foto (gpt-image), `vid` = cómo se anima (Seedance).
const MOTIONS = [
  { key: 'lift_drip',
    img: 'a hand slowly lifting {unit} up out of the jar, a glossy strand of brine dripping off it back into the jar',
    vid: 'A hand slowly lifts {unit} up out of the jar; a glossy strand of brine drips slowly off it back into the jar. It stays in focus.' },
  { key: 'dip_drip',
    img: 'a hand holding {unit} just above the open tub, thick glossy brine/sauce dripping off it in a stretching strand',
    vid: 'A hand holds {unit} above the tub and thick glossy brine drips slowly off it in a stretching strand back into the tub.' },
  { key: 'pull_up',
    img: 'a hand pulling {unit} upward out of the tub, glistening wet, a little brine dripping',
    vid: 'A hand slowly pulls {unit} upward out of the tub, glistening wet, a little brine dripping off the bottom edge.' },
  { key: 'pinch_twirl',
    img: 'two fingers pinching {unit} held up close to the camera, glistening with brine',
    vid: 'Two fingers pinch {unit} held close to the camera and slowly twirl it a few degrees; it glistens and a single drop forms at the bottom.' },
  { key: 'bite_tease',
    img: 'a hand holding {unit} up close to the camera as if about to take a bite, glossy and dripping',
    vid: 'A hand holds {unit} up close as if about to take a bite; a slow drop of brine falls and it glistens.' },
  { key: 'two_hand_open',
    img: 'two hands holding the jar and just twisting the lid open, the product and brine visible at the rim',
    vid: 'Two hands hold the jar and slowly twist the lid open; the brine ripples and the top piece shifts slightly.' },
  { key: 'fridge_reveal', selfScene: true,
    img: 'a hand opening a home refrigerator door, revealing several {product} jars neatly lined up on the fridge shelf inside, cool soft fridge light spilling out, light condensation on the jars, POV handheld UGC, the {product} labels readable',
    vid: 'A hand slowly pulls the refrigerator door open, revealing the {product} jars lined up on the shelf as the cool fridge light spills out; faint condensation, almost no other movement.' },
  // ── Composiciones distintas (no la toma típica de mano+chip+drip) ──
  { key: 'pour_bowl', selfScene: true,
    img: 'a hand tilting the open {product} jar to pour pickle chips and brine into a white ceramic bowl on a kitchen counter, chips mid-tumble, glossy and fresh, UGC iPhone',
    vid: 'A hand tilts the {product} jar and the pickle chips with brine tumble slowly out into the bowl.' },
  { key: 'cooler_grab', selfScene: true,
    img: "a hand reaching into an ice-filled cooler and pulling out a frosty {product} jar, ice cubes and water droplets all around, condensation on the glass, backyard summer, UGC iPhone",
    vid: 'A hand lifts the frosty {product} jar up out of the ice; water droplets slide down the glass, ice settles slightly.' },
  { key: 'pantry_shelf', selfScene: true,
    img: 'several {product} jars neatly lined up on a wooden pantry shelf at home, a hand reaching toward the front jar, warm soft light, labels readable, UGC iPhone',
    vid: 'A hand reaches and slides one {product} jar forward off the shelf; the other jars stay still.' },
  { key: 'on_food', selfScene: true,
    img: 'a hand placing {unit_food} on top of a juicy cheeseburger on a plate, the {product} as the hero topping, melty cheese, casual kitchen, mouth-watering UGC iPhone',
    vid: 'A hand lays {unit_food} onto the burger; a single drop of brine falls and faint steam rises from the food.' },
  { key: 'table_spread', selfScene: true,
    img: "an open {product} jar in the center of a picnic table surrounded by a snack spread (chips, dips, drinks), top-down casual flat-lay, sunny outdoor, UGC iPhone, label readable",
    vid: 'Almost still — a faint breeze and soft light shift across the {product} jar and the spread; ambient micro-motion only.' }
];

// Deriva la "pieza" real del producto a partir del nombre — para no poner un
// "pickle chip" genérico cuando el producto es cebolla, tomate, etc.
function productUnit(name = '') {
  const n = name.toLowerCase();
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
  const n = name.toLowerCase();
  if (n.includes('onion')) return 'a pickled red onion slice';
  if (n.includes('tomato')) return 'a thick slice of pickled tomato';
  if (n.includes('jalap') || n.includes('pepper')) return 'a few pickled jalapeño slices';
  if (n.includes('bean')) return 'a couple of pickled green beans';
  if (n.includes('okra')) return 'a couple of pickled okra slices';
  return productUnit(name); // chips / pepinillos ya son planos → sirven en comida
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

const DIMS = { motion: MOTIONS, camera: CAMERAS, scene: SCENES };

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
 * Exploit/explore: pick ponderado de un valor de la dimensión.
 * Cada valor arranca con `floor` (explore) y suma bonus por avg_roas si tiene
 * muestra suficiente (exploit). Sin data → todos parejos (explore puro).
 */
function pickWeighted(dim, statsByKey = {}, { minSamples = 2, floor = 1, k = 1.2, kHold = 3 } = {}) {
  const values = DIMS[dim] || [];
  if (!values.length) return null;
  const weights = values.map(v => {
    const s = statsByKey[v.key];
    let w = floor;
    if (s && s.n >= minSamples) {
      // ROAS = verdad de negocio (domina). hold_rate = señal TEMPRANA de retención
      // (llega antes que las compras) → nudge mientras el ROAS junta muestra.
      if (s.avg_roas > 0) w += s.avg_roas * k;
      if (s.avg_hold > 0) w += s.avg_hold * kHold;
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
  const field = dim === 'motion' ? 'motion_variant' : dim;
  const vids = await CreativeProposal.find({
    media_type: 'video', status: { $in: ['testing', 'graduated', 'killed', 'expired'] }
  }).select(`${field} status`).lean();
  if (!vids.length) return {};
  const ids = vids.map(v => v._id);
  const runs = await TestRun.find({ proposal_id: { $in: ids } }).select('proposal_id metrics').lean();
  const byProp = {};
  for (const t of runs) byProp[String(t.proposal_id)] = t.metrics || {};
  const agg = {};
  for (const v of vids) {
    const key = v[field];
    if (!key) continue;
    const m = byProp[String(v._id)] || {};
    agg[key] = agg[key] || { n: 0, roas_sum: 0, ctr_sum: 0, hold_sum: 0, thumb_sum: 0, graduated: 0, killed: 0 };
    agg[key].n++;
    agg[key].roas_sum += (m.roas || 0);
    agg[key].ctr_sum += (m.ctr || 0);
    agg[key].hold_sum += (m.hold_rate || 0);    // % que ve el video completo
    agg[key].thumb_sum += (m.thumbstop_rate || 0); // % que se queda a verlo
    if (v.status === 'graduated') agg[key].graduated++;
    if (v.status === 'killed') agg[key].killed++;
  }
  const out = {};
  for (const key in agg) {
    const a = agg[key];
    out[key] = {
      n: a.n, avg_roas: a.roas_sum / a.n, avg_ctr: a.ctr_sum / a.n,
      avg_hold: a.hold_sum / a.n, avg_thumbstop: a.thumb_sum / a.n,
      graduated: a.graduated, killed: a.killed
    };
  }
  return out;
}

// Reemplaza {unit} (una pieza del producto) y {product} (el frasco/nombre entero).
function _fill(text, productName) {
  const unit = productUnit(productName);
  const unitFood = productUnitFood(productName);
  return text
    .replace(/\{unit_food\}/g, unitFood)   // primero el más específico
    .replace(/\{unit\}/g, unit)
    .replace(/\{product\}/g, productName || 'the product');
}

/** Prompt de la IMAGEN-fuente (gpt-image): interacción (con la pieza REAL) + escena.
 *  Si el motion trae escena propia (selfScene, ej. heladera), NO se le pega otra. */
function buildImageScene(motionKey, sceneKey, productName) {
  const m = get('motion', motionKey);
  let img = _fill(m.img, productName);
  if (!m.selfScene) {
    const s = get('scene', sceneKey);
    img += `, ${s.img}`;
  }
  return img;
}

/** Prompt del VIDEO (Seedance): motion (con pieza real) + cámara + estilo base. */
function buildVideoPrompt(productName, motionKey, cameraKey) {
  const m = get('motion', motionKey);
  const c = get('camera', cameraKey);
  const readable = `Keep the ${productName || 'product'} label readable and undistorted at all times.`;
  return `${_fill(m.vid, productName)} ${c.vid} ${BASE_STYLE} ${readable}`;
}

module.exports = {
  MOTIONS, CAMERAS, SCENES, DIMS, BASE_STYLE, productUnit, productUnitFood,
  get, keys, pickWeighted, getDimensionStats, buildImageScene, buildVideoPrompt
};
