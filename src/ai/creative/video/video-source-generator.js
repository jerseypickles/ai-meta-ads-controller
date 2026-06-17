// ═══════════════════════════════════════════════════════════════════════════════
// VÍA DE IMÁGENES-FUENTE PARA VIDEO (tag: 'video_source')
// Genera fotos de INTERACCIÓN (mano levantando/mojando un pickle chip, salsa/brine
// chorreando) — el primer-frame ideal para que Dionisio anime el lift/drip.
//
// - Es una vía DEDICADA: NO entra al pipeline de fotos de Apollo ni al testeo de
//   Prometheus. Las imágenes quedan status 'video_source' + tag 'video_source'.
// - Mantiene un POOL de máx POOL_TARGET imágenes sin consumir; se rellena a medida
//   que Dionisio las anima (video es caro → el pool de imágenes es barato pero acotado).
// - Usa la foto real del producto (ProductBank.png_references) como referencia para
//   fidelidad del label, igual que Apollo.
// Ver memoria dionysus-agent.
// ═══════════════════════════════════════════════════════════════════════════════

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../../config');
const logger = require('../../../utils/logger');
const ProductBank = require('../../../db/models/ProductBank');
const CreativeProposal = require('../../../db/models/CreativeProposal');
const { generateCreativeImage } = require('../image-engine');
const dna = require('./video-dna');

const POOL_TARGET = parseInt(process.env.VIDEO_SOURCE_POOL_TARGET || '60', 10); // 2026-06-05: 16→40. 2026-06-16: 40→60 — abrir lugar para generar la tanda con los arquetipos NUEVOS (A/B); el pool estaba lleno de sources viejos clásicos. Env-overridable.
const PER_CYCLE_CAP = parseInt(process.env.VIDEO_SOURCE_PER_CYCLE || '8', 10);  // 2026-06-05: 4→8
const ENABLED = process.env.VIDEO_SOURCE_ENABLED !== 'false';
// 🎨 Director creativo: % de generaciones que inventan un concepto NUEVO (el LLM, no el
// template fijo) → el DNA crece su espacio en vez de cerrarse. 2026-06-08, Dionisio fabuloso.
const CREATIVE_RATE = parseFloat(process.env.VIDEO_SOURCE_CREATIVE_RATE || '0.15'); // 2026-06-16: 0.3→0.15 — los conceptos libres del art-director (vapor/escarcha/efectos artificiales) eran los que más rebotaba el juez (100% reject). Más peso a templates limpios + arquetipos. Env-overridable.
// PILOTO first+last frame (2026-06-09): genera el frame FINAL como EDICIÓN del inicial
// (misma escena, solo cambia el estado del motion) para motions con `end` definido en el
// DNA. Seedance interpola entre ambos → la física deja de ser adivinanza. Apagar con env.
const END_FRAME_ENABLED = process.env.VIDEO_END_FRAME_ENABLED !== 'false';

const FIDELITY = 'The product container and its LABEL must remain a pixel-perfect match to the reference photo — same shape, same label design, same text, same colors, same proportions. Do NOT redraw, re-render, or restyle the packaging or the label. CRITICAL COLOR FIDELITY: replicate the EXACT colors of the product and its contents from the reference; do not shift them toward what this food "usually" looks like.';

// Física segura para image-to-video (2026-06-09): el motor de video pega/congela objetos
// sueltos en posiciones ambiguas (caso: spear apoyado en la tapa quedó COLGADO de la tapa
// al abrirla). Toda imagen-fuente debe nacer sin trampas de física.
const PHYSICS_SAFE = 'PHYSICS-SAFE FOR VIDEO (this image will be animated): every solid item must be either firmly HELD by a hand, fully INSIDE the container, or resting FLAT on a stable surface. NEVER place a loose piece on top of / leaning against the lid, the rim, an edge, or anything that could move — and never floating in mid-air. THE JAR/TUB ITSELF obeys the same law: it must be resting on a visible surface (shelf, table, counter) or held by a hand — NEVER suspended in mid-air. ONE HAND DOES ONE THING: if a hand is holding the piece, it cannot also be holding the jar — so the jar must sit on a surface. Only liquid (a brine drip) may hang.';

// MOODS de estilo de IMAGEN — se rota uno por imagen para que las fuentes (y por
// ende los videos) no salgan todas con el mismo look. Core: UGC real, NO-IA, fieles.
const STYLE_MOODS = [
  'Authentic UGC iPhone photo, handheld, natural daylight, shallow casual framing. Photorealistic and appetizing — looks shot by a real person, NOT AI. Real skin tones on the hand, realistic glossy sauce texture, natural shadows. No text overlays, no graphics, no filters, no color grading.',
  'Real iPhone UGC photo in warm late-afternoon light, cozy and appetizing, true-to-life colors (no heavy grading), handheld casual angle, natural soft shadows, looks shot by a real person NOT AI, no text overlays, no graphics, no filters.',
  'Bright clean iPhone photo in fresh daylight, crisp and mouth-watering, true neutral colors, close casual handheld framing, real skin tones, realistic glossy texture, NOT AI, no text overlays, no graphics, no color grading.'
];
function pickImageStyle() {
  return STYLE_MOODS[Math.floor(Math.random() * STYLE_MOODS.length)];
}

// ARQUETIPOS de video-source (2026-06-16, decisión del creador): exploramos 2 tipos de UGC
// NUEVOS junto al clásico, "de a poco" — el clásico sigue siendo MAYORÍA (es el probado).
// La data (conversión por arquetipo, vía el testeo + DNA) decide cuál escalar. Ratio
// env-overridable. classic 50% / pov_hand 30% (A) / person 20% (B).
const ARCHETYPE_RATIO = {
  classic: parseFloat(process.env.VIDEO_ARCH_CLASSIC || '0.5'),
  pov_hand: parseFloat(process.env.VIDEO_ARCH_POV || '0.3'),
  person: parseFloat(process.env.VIDEO_ARCH_PERSON || '0.2')
};
function pickArchetype() {
  const entries = Object.entries(ARCHETYPE_RATIO).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0) || 1;
  let r = Math.random() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return 'classic';
}

/** La pieza real del producto (food-aware) + guardrail anti-substitución. Compartido. */
function buildMatchPiece(productName, motionKey) {
  const isFood = ['on_food'].includes(motionKey);
  const unit = isFood ? dna.productUnitFood(productName) : dna.productUnit(productName);
  const matchPiece = isFood
    ? `CRITICAL: on the burger show ${unit} — round coin slices cut from the SAME pickled food as inside this "${productName}" jar (same type and color as the reference contents), lying FLAT as a topping. Do NOT stand a whole pickle spear upright on the burger, and do NOT substitute a different food.`
    : `CRITICAL: the pickled item shown must be ${unit} — the SAME pickled food that is inside this "${productName}" jar (same type, same color as the contents visible in the reference). Do NOT substitute a generic pickle chip or any different food.`;
  return { unit, matchPiece };
}

// HOOK/energía visual (2026-06-13): el 43% se va en el primer segundo; visual_energy es la
// señal que más predice la venta. Empujamos un primer frame que para el scroll.
const ENERGY = 'HIGH VISUAL ENERGY — bold, vivid, high-contrast and dynamic so it stops the thumb instantly in a busy feed; NOT a calm/flat/static product shot.';

/** Construye el prompt de imagen para un producto + (motion, scene) del DNA + ARQUETIPO. */
function buildSourcePrompt(productName, motionKey, sceneKey, hookKey, archetype = 'classic') {
  const { unit, matchPiece } = buildMatchPiece(productName, motionKey);

  // A — POV 1ra persona, producto/pieza en mano a cámara, SIN cara. Riesgo AI bajo.
  if (archetype === 'pov_hand') {
    return `Create a vertical 9:16 FIRST-PERSON POV photograph: the viewer's OWN hand (arm extended selfie-style toward the phone) holding up the "${productName}" jar/tub close to the camera with its LABEL clearly readable and facing the lens — or holding ${unit} pulled out toward the camera with brine dripping. Authentic real-person UGC iPhone selfie angle, casual and in-the-moment, NOT staged, NOT AI. NO face in frame — only the hand/arm and the product. ${matchPiece} ${FIDELITY} ${pickImageStyle()} The PRODUCT (its label/brand) and the hand are the hero, mouth-watering and in sharp focus. The jar is HELD by the hand — never floating; only a liquid brine drip may hang. ${ENERGY}`;
  }

  // B — Persona real en cuadro sosteniendo/comiendo el producto, cara candid (no primer
  // plano extremo). Riesgo AI alto (caras) → FOTORREALISMO DURO de cara + el juez filtra.
  if (archetype === 'person') {
    return `Create a vertical 9:16 authentic UGC selfie-style photograph of a real, casual everyday young person (candid, natural, NOT a posed model, NOT a stock photo) holding the "${productName}" jar/tub or about to bite/eat ${unit}, reacting with genuine enjoyment. Real iPhone front-camera UGC look — handheld, in-the-moment, natural daylight. Medium framing (head-and-shoulders or waist-up); the face is visible but NATURAL and candid, NOT an extreme close-up of the face. The "${productName}" jar with its LABEL readable is clearly in frame as the hero alongside the person. ${matchPiece} ${FIDELITY} ${pickImageStyle()} ` +
      // FOTORREALISMO DE CARA (la parte más difícil, 2026-06-17): el rostro tiene que ser CREÍBLE.
      `PHOTOREALISM — THE FACE MUST BE BELIEVABLE (this is the hardest part): real human skin with visible pores, fine texture and minor natural imperfections; a slightly asymmetric, natural face — NOT a flawless airbrushed model; an authentic candid expression caught mid-moment; shot on a real iPhone front camera with natural available light and a touch of real-photo grain. ABSOLUTELY AVOID THE AI LOOK: no plastic or waxy skin, no airbrushed perfection, no glassy doll eyes, no over-symmetric face, no CGI render sheen, no beauty-filter, no stock-photo posing. Real hands with exactly five fingers, natural human proportions, nothing warped or uncanny. It MUST be indistinguishable from a real photo of a real person. The jar is held by the person — never floating. ${ENERGY}`;
  }

  // classic — food-porn close-up (mano + pieza + chorrito). El probado.
  const interaction = dna.buildImageScene(motionKey, sceneKey, productName, hookKey);
  return `Create a vertical photograph of ${interaction}, for the product "${productName}". ` +
    `The jar/tub from the reference photo is clearly visible in the shot with its label readable. ` +
    `${matchPiece} ${PHYSICS_SAFE} ${FIDELITY} ${pickImageStyle()} The hand and the dripping brine should be the hero of the shot, mouth-watering and in sharp focus. ` +
    ENERGY;
}

/**
 * "LEER ANTES DE GENERAR" (2026-06-10, idea del creador): detecta la FORMA física del
 * producto mirando el frasco REAL (label + contenido visible) con visión — UNA vez por
 * producto, se guarda en ProductBank. La forma manda sobre las heurísticas de nombre
 * en video-dna (3 bugs de adivinanza: salsa→chip, spears→whole, horseradish→cuchara).
 */
async function ensureProductForm(product) {
  try {
    if (product.product_form) { dna.setProductForm(product.product_name, product.product_form); return product.product_form; }
    const ref = (product.png_references || []).find(r => r.image_base64);
    if (!ref) return null;
    const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const client = new Anthropic({ apiKey });
    const mediaType = ref.mime_type || 'image/jpeg';
    const resp = await client.messages.create({
      model: config.claude.judgeModel || config.claude.model, // visión fina: el label chico importa
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: ref.image_base64 } },
        { type: 'text', text: `Look at this product photo: READ THE LABEL (every word, including small print like "Pickle Chips") and look at the visible contents inside the jar. Classify the product's physical FORM as exactly ONE of: "chips" (round cross-cut pickle slices), "spears" (long wedge strips), "whole" (entire cucumbers/vegetables), "dip" (spoonable salsa/relish/sauce), "shredded" (sauerkraut-style strands), "onion_slices", "tomato_whole", "other". IMPORTANT: trust the label and the visible contents over what the product NAME sounds like (e.g. "Sweet Horseradish" whose label says "Pickle Chips" = chips, NOT a sauce). Respond with ONLY JSON: {"form":"<one of the options>"}` }
      ]}]
    });
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    const form = m ? (JSON.parse(m[0]).form || '').toLowerCase() : '';
    const VALID = ['chips', 'spears', 'whole', 'dip', 'shredded', 'onion_slices', 'tomato_whole', 'other'];
    if (!VALID.includes(form)) return null;
    await ProductBank.updateOne({ _id: product._id }, { $set: { product_form: form, product_form_detected_at: new Date() } });
    dna.setProductForm(product.product_name, form);
    logger.info(`[VIDEO-SOURCE] 🔎 forma detectada del frasco real: "${product.product_name}" = ${form}`);
    return form;
  } catch (e) {
    logger.warn(`[VIDEO-SOURCE] detección de forma falló para ${product.product_name} (sigo con heurística): ${e.message}`);
    return null;
  }
}

/** Genera un headline + copy corto para el creativo (en inglés, mercado US). */
async function generateCopy(productName) {
  try {
    const dna = require('./video-dna');
    const unit = dna.productUnit(productName);
    const isDip = dna.isDip(productName);
    const isShredded = dna.isShredded(productName);
    // Descripción fiel del producto + guardrail anti-mislabel (el bug del "tomato dip":
    // pickled tomatoes ENTEROS salían con copy de "dip/dipping/salsa").
    const typeNote = isDip
      ? 'This IS a dip/salsa/relish — copy about dipping/scooping is fine.'
      : isShredded
        ? 'This is shredded sauerkraut/slaw (a topping for hot dogs/sausages). Do NOT call it a "dip", "salsa" or "sauce".'
        : 'IMPORTANT: this is NOT a dip, salsa or sauce — do NOT call it a "dip"/"salsa"/"sauce" or say "dipping"/"scooping". Describe it as the real product (you eat the piece itself).';
    const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
    const claude = new Anthropic({ apiKey });
    const resp = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Write punchy UGC ad copy in ENGLISH (US market) for a short video of Jersey Pickles "${productName}". The product shown is: ${unit}. ${typeNote} Return ONLY JSON: {"headline":"<max 6 words, hooky>","primary_text":"<1-2 short sentences, casual, appetizing, with 1-2 emojis>","hook_text":"<ON-SCREEN text hook burned into the first 2 seconds of the video: max 5 words, ALL ENERGY, scroll-stopping, native TikTok style (e.g. 'POV: PICKLE HEAVEN', 'WAIT FOR THE DRIP'), NO emojis, NO punctuation except : and ..., NO brand name>"}`
      }]
    });
    const txt = resp.content?.[0]?.text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (j.headline) return { headline: j.headline, primary_text: j.primary_text || '', hook_text: (j.hook_text || '').slice(0, 40) };
    }
  } catch (e) {
    logger.warn(`[VIDEO-SOURCE] copy falló (uso fallback): ${e.message}`);
  }
  return { headline: `${productName} hits different 🔥`, primary_text: `That first crunch of Jersey Pickles ${productName} 🤤 Grab a jar.` };
}

/**
 * BACKFILL del frame final para fuentes pre-piloto que aún esperan en el pool.
 * Solo motions con `end` definido en el DNA. Edición anclada al primer frame.
 * @returns {number} cuántas se backfillearon en esta corrida
 */
async function backfillEndFrames(cap = 8) {
  // Motions del piloto = los que tienen estado final definido
  const pilotMotions = dna.MOTIONS.filter(m => m.end).map(m => m.key);
  const missing = await CreativeProposal.find({
    media_type: 'image', tags: 'video_source', status: { $nin: ['failed', 'rejected'] },
    motion_variant: { $in: pilotMotions },
    image_base64: { $type: 'string', $ne: '' },
    $or: [{ end_frame_base64: { $exists: false } }, { end_frame_base64: '' }]
  }).sort({ created_at: -1 }).limit(cap).select('product_name motion_variant image_base64').lean();
  if (!missing.length) return 0;

  let done = 0;
  for (const s of missing) {
    const endScene = dna.buildEndFrameScene(s.motion_variant, s.product_name);
    if (!endScene) continue;
    try {
      const endPrompt = `Edit this exact photograph (the FIRST reference image): recreate it EXACTLY — same scene, same hand(s), same product piece, same jar and label, same lighting, same camera angle and framing — changing ONLY this: ${endScene}. This is the FINAL frame of a 5-second video that STARTS at the reference photograph, so everything that is not part of that one change must stay pixel-consistent. ${FIDELITY}`;
      const endResult = await generateCreativeImage(endPrompt, {
        referenceImages: [{ image_base64: s.image_base64, mime_type: 'image/png' }],
        aspectRatio: '9:16', imageSize: '2K'
      });
      if (endResult?.base64) {
        await CreativeProposal.findByIdAndUpdate(s._id, { $set: { end_frame_base64: endResult.base64 } });
        done++;
        logger.info(`[VIDEO-SOURCE] 🎬 end-frame backfilled: ${s.product_name} (${s.motion_variant})`);
      }
    } catch (e) {
      logger.warn(`[VIDEO-SOURCE] backfill end-frame falló para ${s._id} (${s.motion_variant}): ${e.message}`);
    }
  }
  return done;
}

/**
 * Cuenta las imágenes-fuente DISPONIBLES (sin consumir): tag video_source, no
 * failed/rejected, y que todavía no tienen un video hijo vivo (no animadas).
 */
async function countAvailableSources() {
  const sources = await CreativeProposal.find({
    media_type: 'image', tags: 'video_source', status: { $nin: ['failed', 'rejected'] }
  }).select('_id').lean();
  if (!sources.length) return 0;
  const ids = sources.map(s => s._id);
  const animated = await CreativeProposal.find({
    media_type: 'video', source_proposal_id: { $in: ids }, status: { $ne: 'failed' }
  }).select('source_proposal_id').lean();
  const done = new Set(animated.map(v => String(v.source_proposal_id)));
  return sources.filter(s => !done.has(String(s._id))).length;
}

/**
 * Rellena el pool de imágenes-fuente hasta POOL_TARGET (cap PER_CYCLE_CAP por corrida).
 */
async function generateVideoSources() {
  if (!ENABLED) { logger.info('[VIDEO-SOURCE] deshabilitado'); return { skipped: 'disabled' }; }

  // BACKFILL first+last (2026-06-09): el pool existente es pre-piloto — fabricarle el
  // frame final a las fuentes que ya están esperando, no solo a las nuevas. Corre ANTES
  // del early-return de pool lleno (si no, con pool lleno nunca se backfillearía).
  let backfilled = 0;
  if (END_FRAME_ENABLED) {
    try { backfilled = await backfillEndFrames(PER_CYCLE_CAP); }
    catch (e) { logger.warn(`[VIDEO-SOURCE] backfill end-frames falló: ${e.message}`); }
  }

  const available = await countAvailableSources();
  const need = Math.min(POOL_TARGET - available, PER_CYCLE_CAP);
  if (need <= 0) {
    logger.info(`[VIDEO-SOURCE] pool lleno (${available}/${POOL_TARGET}) — no genero${backfilled ? ` · ${backfilled} end-frames backfilled` : ''}`);
    return { available, generated: 0, backfilled };
  }

  // Productos con referencia PNG (para fidelidad del label).
  const products = (await ProductBank.find({ active: true }).lean())
    .filter(p => p.png_references && p.png_references.length > 0);
  if (!products.length) {
    logger.warn('[VIDEO-SOURCE] no hay productos con png_references — skip');
    return { available, generated: 0, skipped: 'no_products' };
  }

  // DNA stats para exploit/explore (qué motion / scene / hook rinde mejor hasta ahora).
  const [motionStats, sceneStats, hookStats] = await Promise.all([
    dna.getDimensionStats('motion').catch(() => ({})),
    dna.getDimensionStats('scene').catch(() => ({})),
    dna.getDimensionStats('hook').catch(() => ({}))
  ]);

  // Conceptos del art-director que YA GRADUARON → inspiración para inventar MÁS en esas
  // direcciones probadas (el DNA crece con la novedad que funcionó, no solo con motions fijos).
  let winningConcepts = [];
  try {
    const won = await CreativeProposal.find({ media_type: 'video', status: 'graduated', creative_concept: { $ne: null } })
      .sort({ created_at: -1 }).select('creative_concept').limit(8).lean();
    winningConcepts = [...new Set(won.map(p => p.creative_concept).filter(Boolean))];
  } catch (_) { /* noop */ }

  // Señales que la CALIBRACIÓN probó que predicen el outcome → guía al director creativo
  // (cierra el loop: el director explora PERO sabiendo qué palancas funcionan).
  let signalGuidance = '';
  try {
    const SystemConfig = require('../../../db/models/SystemConfig');
    const { LEARNINGS_KEY } = require('./video-learning');
    const L = await SystemConfig.get(LEARNINGS_KEY, null);
    const sig = L?.signal_rank || [];
    const NAMES = { hook_strength: 'Hook Strength', curiosity_gap: 'Curiosity Gap', food_craving: 'Food Craving', visual_energy: 'Visual Energy', visual_contrast: 'Visual Contrast', clarity: 'Clarity', production_quality: 'Production Quality', authenticity: 'Authenticity', motion_intensity: 'Motion Intensity' };
    const pos = sig.filter(s => s.corr >= 0.3).map(s => `${NAMES[s.signal] || s.signal} (corr ${s.corr})`);
    // Negativas: con poca data son ruidosas + 'authenticity' es pilar de marca (NO tocar)
    // → solo actuamos sobre negativas claras y NO-críticas, con umbral conservador.
    const neg = sig.filter(s => s.corr <= -0.3 && s.signal !== 'authenticity').map(s => NAMES[s.signal] || s.signal);
    if (pos.length) signalGuidance = `MAXIMIZE these proven levers (ranked by how much they predict real success): ${pos.join(', ')}. Keep the authentic real-UGC look (always — it's the brand).${neg.length ? ` Avoid over-doing: ${neg.join(', ')}.` : ''}`;
  } catch (_) { /* noop */ }

  logger.info(`[VIDEO-SOURCE] pool ${available}/${POOL_TARGET} → genero ${need}`);
  let generated = 0;

  for (let i = 0; i < need; i++) {
    const product = products[i % products.length];
    // LEER ANTES DE GENERAR: forma física del frasco real → registro de video-dna.
    // Una vez por producto (queda en ProductBank); manda sobre heurísticas de nombre.
    await ensureProductForm(product);
    // Exploit/explore: sesga hacia el motion/scene ganador, sigue probando los otros.
    // allowedKeys excluye motions que no le quedan al producto (ej. on_food en spears →
    // un spear sobre un burger se ve raro; esos productos usan las otras posturas).
    let motionKey = dna.pickWeighted('motion', motionStats, { allowedKeys: dna.motionsForProduct(product.product_name) });
    let sceneKey = dna.pickWeighted('scene', sceneStats);
    let hookKey = dna.pickWeighted('hook', hookStats); // el gancho de los primeros 1-2s
    let prompt = null, creativeConcept = null;
    // Arquetipo de UGC (classic/pov_hand/person) — exploración A/B vs el clásico.
    const archetype = pickArchetype();

    // 🎨 DIRECTOR CREATIVO: una parte de las generaciones INVENTA un concepto nuevo (el LLM)
    // en vez del template fijo → explora territorio que no está en el menú del DNA.
    // Solo para el CLÁSICO: A/B usan su template controlado (si no, el concepto libre del
    // director rompe el framing POV/persona que estamos explorando).
    if (archetype === 'classic' && Math.random() < CREATIVE_RATE) {
      try {
        const { inventCreativeConcept, buildCreativePrompt } = require('./video-art-director');
        const topMotions = Object.entries(motionStats).filter(([, s]) => (s.graduated || 0) > 0)
          .sort((a, b) => (b[1].graduated || 0) - (a[1].graduated || 0)).slice(0, 3).map(([k]) => k);
        // inspiración = motions ganadores + conceptos creativos que ya graduaron
        const inspiration = [...topMotions, ...winningConcepts.map(c => `concepto "${c}"`)].join(', ');
        const concept = await inventCreativeConcept(product.product_name, inspiration, signalGuidance);
        if (concept) {
          prompt = buildCreativePrompt(product.product_name, concept.image_prompt, FIDELITY, pickImageStyle());
          motionKey = concept.motion_hint; // motion válido para animar el video
          sceneKey = ''; hookKey = '';
          creativeConcept = concept.concept_tag;
          logger.info(`[VIDEO-SOURCE] 🎨 concepto NUEVO del art-director: "${concept.concept_tag}" (${product.product_name}) — ${concept.why}`);
        }
      } catch (e) { logger.warn(`[VIDEO-SOURCE] art-director falló (uso template): ${e.message}`); }
    }
    if (!prompt) prompt = buildSourcePrompt(product.product_name, motionKey, sceneKey, hookKey, archetype);

    try {
      const refImages = product.png_references.map(ref => ({
        image_base64: ref.image_base64,
        mime_type: ref.mime_type,
        path: !ref.image_base64 ? null : null
      }));
      const result = await generateCreativeImage(prompt, { referenceImages: refImages, aspectRatio: '9:16', imageSize: '2K' });
      if (!result?.base64) { logger.warn(`[VIDEO-SOURCE] sin imagen para ${product.product_name}`); continue; }

      // PILOTO first+last: frame FINAL como edición del inicial (el inicial va PRIMERO
      // en las referencias para anclar escena/mano/label; el ref del producto refuerza
      // la fidelidad). Fail-open: si falla, el video sale solo con primer frame como hoy.
      let endFrameBase64 = '';
      const endScene = END_FRAME_ENABLED ? dna.buildEndFrameScene(motionKey, product.product_name) : null;
      if (endScene) {
        try {
          const endPrompt = `Edit this exact photograph (the FIRST reference image): recreate it EXACTLY — same scene, same hand(s), same product piece, same jar and label, same lighting, same camera angle and framing — changing ONLY this: ${endScene}. This is the FINAL frame of a 5-second video that STARTS at the reference photograph, so everything that is not part of that one change must stay pixel-consistent. ${FIDELITY}`;
          const endResult = await generateCreativeImage(endPrompt, {
            referenceImages: [{ image_base64: result.base64, mime_type: 'image/png' }, ...refImages.slice(0, 1)],
            aspectRatio: '9:16', imageSize: '2K'
          });
          if (endResult?.base64) endFrameBase64 = endResult.base64;
        } catch (e) { logger.warn(`[VIDEO-SOURCE] end-frame falló para ${product.product_name} (sigue solo first): ${e.message}`); }
      }

      const copy = await generateCopy(product.product_name);
      // Fallback de hook si el LLM no lo dio: primeras 5 palabras del headline
      const hookText = copy.hook_text || (copy.headline || '').split(/\s+/).slice(0, 5).join(' ');
      await CreativeProposal.create({
        product_id: product._id,
        product_name: product.product_name,
        adset_id: 'video_source',
        headline: copy.headline,
        primary_text: copy.primary_text,
        hook_text: hookText,
        link_url: product.link_url || 'https://jerseypickles.com',
        image_base64: result.base64,
        end_frame_base64: endFrameBase64,
        media_type: 'image',
        status: 'video_source',
        tags: ['video_source'],
        motion_variant: motionKey,  // motion baked en la imagen
        scene: sceneKey,            // escena (dimensión DNA)
        hook_variant: hookKey,      // gancho (dimensión DNA nueva)
        creative_concept: creativeConcept, // concepto del art-director (null si template)
        source_archetype: archetype,        // classic/pov_hand/person — dimensión de exploración A/B
        style: 'video_source'
      });
      generated++;
      logger.info(`[VIDEO-SOURCE] ✓ "${copy.headline}" (${product.product_name}, [${archetype}] ${creativeConcept ? '🎨 ' + creativeConcept : motionKey + '/' + sceneKey + '/' + hookKey})${endFrameBase64 ? ' · 🎬 par first+last' : ''}`);
    } catch (e) {
      logger.error(`[VIDEO-SOURCE] error generando para ${product.product_name}: ${e.message}`);
    }
  }

  const nowAvailable = await countAvailableSources();
  logger.info(`[VIDEO-SOURCE] ciclo: ${generated} generadas · pool ahora ${nowAvailable}/${POOL_TARGET}`);
  return { available: nowAvailable, generated };
}

module.exports = { generateVideoSources, countAvailableSources, POOL_TARGET };
