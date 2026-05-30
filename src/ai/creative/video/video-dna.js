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

// MOTION — interacción con el chip. `img` = qué hace la mano en la foto (gpt-image),
// `vid` = cómo se anima (Seedance).
const MOTIONS = [
  { key: 'lift_drip',
    img: 'a hand slowly lifting a single pickle chip up out of the jar, a glossy strand of brine dripping off it back into the jar',
    vid: 'A hand slowly lifts a single pickle chip up out of the jar; a glossy strand of brine drips slowly off the chip back into the jar. The chip stays in focus.' },
  { key: 'dip_drip',
    img: 'a hand holding a single sauced pickle chip just above the open tub, thick glossy chamoy sauce dripping off it in a stretching strand',
    vid: 'A hand holds a sauced pickle chip above the tub and thick glossy chamoy sauce drips slowly off it in a stretching strand back into the tub.' },
  { key: 'pull_up',
    img: 'a hand pulling a single sauce-coated pickle chip upward out of the tub, the chip glistening wet, a little sauce dripping',
    vid: 'A hand slowly pulls a sauce-coated pickle chip upward out of the tub, glistening wet, a little sauce dripping off the bottom edge.' },
  { key: 'pinch_twirl',
    img: 'two fingers pinching a single glistening pickle chip held up close to the camera, sauce coating it',
    vid: 'Two fingers pinch a pickle chip held close to the camera and slowly twirl it a few degrees; the sauce glistens and a single drop forms at the bottom.' },
  { key: 'bite_tease',
    img: 'a hand holding a sauced pickle chip up close to the camera as if about to take a bite, glossy and dripping',
    vid: 'A hand holds a sauced chip up close as if about to take a bite; a slow drop of sauce falls and the chip glistens.' },
  { key: 'two_hand_open',
    img: 'two hands holding the jar and just twisting the lid open, a chip and brine visible at the rim',
    vid: 'Two hands hold the jar and slowly twist the lid open; the brine ripples and the top chip shifts slightly.' }
];

// CAMERA — movimiento de cámara (Seedance).
const CAMERAS = [
  { key: 'static',         vid: 'Locked-off static shot, no camera movement at all.' },
  { key: 'slow_push_in',   vid: 'Very slow, subtle push-in of the camera toward the chip.' },
  { key: 'slight_tilt',    vid: 'A tiny handheld tilt of the camera following the chip upward.' },
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
function pickWeighted(dim, statsByKey = {}, { minSamples = 2, floor = 1, k = 1.2 } = {}) {
  const values = DIMS[dim] || [];
  if (!values.length) return null;
  const weights = values.map(v => {
    const s = statsByKey[v.key];
    let w = floor;
    if (s && s.n >= minSamples && s.avg_roas > 0) w += s.avg_roas * k;
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
    agg[key] = agg[key] || { n: 0, roas_sum: 0, ctr_sum: 0, graduated: 0, killed: 0 };
    agg[key].n++;
    agg[key].roas_sum += (m.roas || 0);
    agg[key].ctr_sum += (m.ctr || 0);
    if (v.status === 'graduated') agg[key].graduated++;
    if (v.status === 'killed') agg[key].killed++;
  }
  const out = {};
  for (const key in agg) {
    const a = agg[key];
    out[key] = { n: a.n, avg_roas: a.roas_sum / a.n, avg_ctr: a.ctr_sum / a.n, graduated: a.graduated, killed: a.killed };
  }
  return out;
}

/** Prompt de la IMAGEN-fuente (gpt-image): interacción + escena. */
function buildImageScene(motionKey, sceneKey) {
  const m = get('motion', motionKey);
  const s = get('scene', sceneKey);
  return `${m.img}, ${s.img}`;
}

/** Prompt del VIDEO (Seedance): motion + cámara + estilo base. */
function buildVideoPrompt(productName, motionKey, cameraKey) {
  const m = get('motion', motionKey);
  const c = get('camera', cameraKey);
  const readable = `Keep the ${productName || 'product'} label readable and undistorted at all times.`;
  return `${m.vid} ${c.vid} ${BASE_STYLE} ${readable}`;
}

module.exports = {
  MOTIONS, CAMERAS, SCENES, DIMS, BASE_STYLE,
  get, keys, pickWeighted, getDimensionStats, buildImageScene, buildVideoPrompt
};
