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

const POOL_TARGET = parseInt(process.env.VIDEO_SOURCE_POOL_TARGET || '30', 10); // máx imágenes sin consumir
const PER_CYCLE_CAP = parseInt(process.env.VIDEO_SOURCE_PER_CYCLE || '6', 10);  // máx generadas por corrida (evita bursts)
const ENABLED = process.env.VIDEO_SOURCE_ENABLED !== 'false';

// Intenciones de interacción — cada una mapea al motion que Dionisio aplicará luego.
const INTERACTIONS = [
  {
    motion: 'lift_drip',
    scene: 'a hand slowly lifting a single pickle chip up out of the open jar, a glossy strand of brine dripping off the chip back into the jar'
  },
  {
    motion: 'dip_drip',
    scene: 'a hand holding a single pickle chip right above the open tub, thick glossy chamoy/hot sauce dripping off the chip in a stretching strand back into the tub'
  },
  {
    motion: 'pull_up',
    scene: 'a hand pulling a single sauce-coated pickle chip upward out of the tub, the chip glistening wet with sauce, a little dripping off the bottom edge'
  }
];

const FIDELITY = 'The product container and its LABEL must remain a pixel-perfect match to the reference photo — same shape, same label design, same text, same colors, same proportions. Do NOT redraw, re-render, or restyle the packaging or the label. CRITICAL COLOR FIDELITY: replicate the EXACT colors of the product and its contents from the reference; do not shift them toward what this food "usually" looks like.';

const STYLE = 'Authentic UGC iPhone photo, handheld, natural daylight outdoors (backyard / picnic table / poolside vibe), shallow casual framing. Photorealistic and appetizing — looks shot by a real person, NOT AI. Real skin tones on the hand, realistic glossy sauce texture, natural shadows. No text overlays, no graphics, no filters, no color grading.';

/** Construye el prompt de imagen de interacción para un producto + intención. */
function buildSourcePrompt(productName, interaction) {
  return `Create a vertical photograph of ${interaction.scene}, for the product "${productName}". ` +
    `The jar/tub from the reference photo is clearly visible in the shot with its label readable. ` +
    `${FIDELITY} ${STYLE} The hand and the dripping sauce/brine should be the hero of the shot, mouth-watering and in sharp focus.`;
}

/** Genera un headline + copy corto para el creativo (en inglés, mercado US). */
async function generateCopy(productName) {
  try {
    const apiKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
    const claude = new Anthropic({ apiKey });
    const resp = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write punchy UGC ad copy in ENGLISH (US market) for a short video of Jersey Pickles "${productName}" — a hand lifting a chip with sauce dripping. Return ONLY JSON: {"headline":"<max 6 words, hooky>","primary_text":"<1-2 short sentences, casual, appetizing, with 1-2 emojis>"}`
      }]
    });
    const txt = resp.content?.[0]?.text || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (j.headline) return { headline: j.headline, primary_text: j.primary_text || '' };
    }
  } catch (e) {
    logger.warn(`[VIDEO-SOURCE] copy falló (uso fallback): ${e.message}`);
  }
  return { headline: `${productName} hits different 🔥`, primary_text: `That first crunch of Jersey Pickles ${productName} 🤤 Grab a jar.` };
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

  const available = await countAvailableSources();
  const need = Math.min(POOL_TARGET - available, PER_CYCLE_CAP);
  if (need <= 0) {
    logger.info(`[VIDEO-SOURCE] pool lleno (${available}/${POOL_TARGET}) — no genero`);
    return { available, generated: 0 };
  }

  // Productos con referencia PNG (para fidelidad del label).
  const products = (await ProductBank.find({ active: true }).lean())
    .filter(p => p.png_references && p.png_references.length > 0);
  if (!products.length) {
    logger.warn('[VIDEO-SOURCE] no hay productos con png_references — skip');
    return { available, generated: 0, skipped: 'no_products' };
  }

  logger.info(`[VIDEO-SOURCE] pool ${available}/${POOL_TARGET} → genero ${need}`);
  let generated = 0;

  for (let i = 0; i < need; i++) {
    // Rotar producto + intención de interacción para variedad.
    const product = products[i % products.length];
    const interaction = INTERACTIONS[i % INTERACTIONS.length];
    try {
      const refImages = product.png_references.map(ref => ({
        image_base64: ref.image_base64,
        mime_type: ref.mime_type,
        path: !ref.image_base64 ? null : null
      }));
      const prompt = buildSourcePrompt(product.product_name, interaction);
      const result = await generateCreativeImage(prompt, { referenceImages: refImages, aspectRatio: '9:16', imageSize: '2K' });
      if (!result?.base64) { logger.warn(`[VIDEO-SOURCE] sin imagen para ${product.product_name}`); continue; }

      const copy = await generateCopy(product.product_name);
      await CreativeProposal.create({
        product_id: product._id,
        product_name: product.product_name,
        adset_id: 'video_source',
        headline: copy.headline,
        primary_text: copy.primary_text,
        link_url: product.link_url || 'https://jerseypickles.com',
        image_base64: result.base64,
        media_type: 'image',
        status: 'video_source',
        tags: ['video_source'],
        motion_variant: interaction.motion,  // hint del motion que mejor le calza
        style: 'video_source'
      });
      generated++;
      logger.info(`[VIDEO-SOURCE] ✓ "${copy.headline}" (${product.product_name}, ${interaction.motion})`);
    } catch (e) {
      logger.error(`[VIDEO-SOURCE] error generando para ${product.product_name}: ${e.message}`);
    }
  }

  const nowAvailable = await countAvailableSources();
  logger.info(`[VIDEO-SOURCE] ciclo: ${generated} generadas · pool ahora ${nowAvailable}/${POOL_TARGET}`);
  return { available: nowAvailable, generated };
}

module.exports = { generateVideoSources, countAvailableSources, POOL_TARGET };
