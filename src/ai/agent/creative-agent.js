const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const logger = require('../../utils/logger');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const ProductBank = require('../../db/models/ProductBank');
const ActionLog = require('../../db/models/ActionLog');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const { getLatestSnapshots, getAdsForAdSet } = require('../../db/queries');
const ZeusDirective = require('../../db/models/ZeusDirective');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

// ═══════════════════════════════════════════════════════════════════════════════
// SCENES BANK — escenas cotidianas para creative generation (22 escenas)
// ═══════════════════════════════════════════════════════════════════════════════
const SCENES = [
  // Clasicas (probadas)
  'parked car during daytime, container placed near cupholder with a crumpled napkin nearby, hand lifting a pickle from container with slight dripping brine',
  'living room couch at night watching TV, container on armrest with a blanket nearby and remote control visible, hand reaching in to grab a pickle',
  'beach towel on a sunny day, container on colorful towel with sunscreen and flip flops nearby, hand pulling out a pickle chip',
  'office desk during lunch break, container next to laptop and coffee mug, casual mid-bite moment',
  'kitchen counter while cooking, container open next to cutting board with ingredients around, hand grabbing a pickle',
  'backyard BBQ party, container on picnic table next to paper plates and drinks, casual outdoor setting',
  'picnic blanket in a park, container among other snacks on checkered blanket, natural sunlight',
  'grocery store aisle, hands holding the container showing the label, fluorescent store lighting',
  'road trip passenger seat, container between seats with snacks and water bottles around',
  'camping outdoors, container on a fold-out table near campfire setup, rustic outdoor mood',
  'tailgate party near a truck, container on cooler lid with drinks around, game day vibe',
  'pool side on a towel, container next to sunglasses and a drink, summer relaxation mood',
  // Nuevas (mas variedad)
  'gym bag open on bench in locker room, container peeking out next to a water bottle and towel, post-workout snack vibe',
  'game night table with board game and cards, container open among chips and dip, friends gathering mood',
  'late night kitchen raid at 2am, fridge light illuminating the scene, hand grabbing container in dim light',
  'breakfast table in the morning, container next to toast and coffee, sunny window light',
  'watching sports on TV with friends, container on coffee table among nachos and beer, excited energy',
  'unboxing moment, package just opened on doorstep, hands lifting container out of shipping box with tissue paper',
  'farmers market stand outdoors, container displayed among fresh produce, artisanal handmade vibe',
  'apartment balcony at sunset, container on small table with a drink, city skyline in background, chill vibes',
  'work from home setup, container on desk next to monitor and plant, casual afternoon snack',
  'food truck window, hand passing container to customer, street food festival energy'
];

// ═══════════════════════════════════════════════════════════════════════════════
// AD STYLES — estilos visuales para las imagenes
// ═══════════════════════════════════════════════════════════════════════════════
const AD_STYLES = [
  {
    key: 'ugly-ad',
    prompt: 'Create a realistic ugly-ad style iPhone photo. Keep the framing casual, the light natural, and the overall mood believable and unpolished. The photo should look like someone casually took it with their phone — not staged or professional.',
    weight: 3 // mas probable (probado)
  },
  {
    key: 'pov-selfie',
    prompt: 'Create a POV-style photo as if someone is taking a selfie or filming themselves. First person perspective, slightly tilted angle, casual and authentic. The viewer should feel like they ARE the person in the scene.',
    weight: 2
  },
  {
    key: 'overhead-flat',
    prompt: 'Create a clean overhead flat-lay photo looking straight down. Items neatly arranged but not too perfect. Bright natural lighting, slight shadows. Instagram-worthy but still casual.',
    weight: 2
  },
  {
    key: 'close-up-texture',
    prompt: 'Create an extreme close-up macro shot focusing on the food texture and details. Shallow depth of field, mouth-watering detail, condensation or brine visible. Make the viewer TASTE it through the screen.',
    weight: 1
  },
  {
    key: 'action-shot',
    prompt: 'Create a dynamic action shot — someone mid-bite, fork mid-air, brine dripping, or container being opened. Slight motion blur is OK. Capture the MOMENT of enjoyment, not a posed photo.',
    weight: 1
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// COPY ANGLES — angulos de mensaje para el copy
// ═══════════════════════════════════════════════════════════════════════════════
const COPY_ANGLES = [
  { key: 'casual-fun', instruction: 'Style: casual, fun, crave-inducing. Like a friend recommending a snack.', weight: 2 },
  { key: 'curiosity', instruction: 'Style: curiosity-driven hook. Make them NEED to know what this is. Use "wait..." or "you won\'t believe..." energy without being clickbait.', weight: 2 },
  { key: 'social-proof', instruction: 'Style: social proof / bandwagon. Imply everyone is obsessed. Use "everyone\'s talking about" or "the snack that broke TikTok" energy.', weight: 2 },
  { key: 'urgency', instruction: 'Style: gentle urgency. Limited batch, selling fast, seasonal. Not aggressive — just enough FOMO.', weight: 1 },
  { key: 'humor', instruction: 'Style: humor/meme energy. Self-aware, slightly absurd. "We put hot tomatoes in a jar and somehow it WORKS." Relatable and shareable.', weight: 2 },
  { key: 'controversy', instruction: 'Style: mild controversy / hot take. "Pickles are NOT a snack... until you try these." Provoke a reaction, make people want to comment.', weight: 1 },
  { key: 'sensory', instruction: 'Style: sensory description. Focus on taste, texture, crunch, heat, brine. Make them FEEL the flavor through words. Short, punchy, visceral.', weight: 1 }
];

// ═══════════════════════════════════════════════════════════════════════════════
// WEIGHTED RANDOM PICK
// ═══════════════════════════════════════════════════════════════════════════════
function weightedPick(items) {
  const totalWeight = items.reduce((sum, item) => sum + (item.weight || 1), 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= (item.weight || 1);
    if (random <= 0) return item;
  }
  return items[items.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT TEMPLATE — soporta single product y combo (multi-product)
// ═══════════════════════════════════════════════════════════════════════════════
function buildImagePrompt(productName, scene, refTypes, style, isCombo = false, comboProductNames = [], productDescription = '') {
  let prompt = '';

  // Describe references based on what was provided
  if (isCombo && comboProductNames.length > 1) {
    prompt += `Use the uploaded product container images as mandatory references for: ${comboProductNames.join(', ')}. `;
    prompt += 'Show ALL these containers together in the same scene — this is a product family/variety shot. ';
  } else {
    prompt += `CRITICAL: The uploaded ${refTypes.length} image(s) show the EXACT product "${productName}" from different angles. `;
    prompt += 'Study EVERY uploaded reference carefully — the container shape, label design, text, colors, proportions, and contents are ALL visible in the references. ';
    prompt += 'The product in the generated image MUST be a pixel-perfect match to the references. Same label, same text, same colors, same container type. ';
    prompt += 'Do NOT change, invent, or modify ANY aspect of the product. Do NOT add other products not shown in references. ';
    prompt += 'If the product contains RED tomatoes, show RED tomatoes — not green, not yellow. Match the EXACT color from references. ';
  }

  prompt += `Scene: ${scene}. `;
  prompt += style.prompt;

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════════════════════
async function generateImage(prompt, referenceImages) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');

  const genAI = new GoogleGenAI({ apiKey });

  // Build parts: text prompt + reference images (base64 from DB or file paths)
  const parts = [{ text: prompt }];

  for (const ref of referenceImages) {
    try {
      let base64, mimeType;

      if (ref.image_base64) {
        // Directo de DB (nuevo flujo)
        base64 = ref.image_base64;
        mimeType = ref.mime_type || 'image/jpeg';
      } else if (ref.path) {
        // Fallback: leer de disco (productos viejos)
        const absPath = path.resolve(ref.path);
        const imageData = fs.readFileSync(absPath);
        base64 = imageData.toString('base64');
        const ext = path.extname(ref.path).toLowerCase();
        mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      } else {
        continue;
      }

      parts.push({
        inlineData: { mimeType, data: base64 }
      });
    } catch (err) {
      logger.warn(`[CREATIVE-AGENT] Could not load reference image: ${err.message}`);
    }
  }

  const response = await genAI.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: '9:16',
        imageSize: '2K'
      }
    }
  });

  // Extract image as base64 directly — no filesystem needed
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      logger.info('[CREATIVE-AGENT] Image generated (in-memory base64)');
      return part.inlineData.data; // already base64 string
    }
  }

  throw new Error('Gemini did not return an image');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPY GENERATION (Claude)
// ═══════════════════════════════════════════════════════════════════════════════
async function generateCopy(productName, scene, copyAngle = null, isCombo = false, comboNames = []) {
  const angle = copyAngle || weightedPick(COPY_ANGLES);
  const productDesc = isCombo ? `the Jersey Pickles variety pack (${comboNames.join(' + ')})` : `Jersey Pickles "${productName}"`;

  const response = await claude.messages.create({
    model: config.claude.model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write ad copy for ${productDesc} in a ${scene} setting.

Return JSON only:
{
  "headline": "short punchy headline (max 40 chars)",
  "primary_text": "engaging ad text (max 125 chars) with 1-2 emojis"
}

${angle.instruction}
English only. Do NOT mention Jersey Pickles in the headline — save it for primary_text or skip it.`
    }]
  });

  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { ...JSON.parse(jsonMatch[0]), copy_angle: angle.key };
  } catch (e) {
    logger.warn(`[CREATIVE-AGENT] Copy parse error: ${e.message}`);
  }

  return {
    headline: `Try ${productName} Today`,
    primary_text: `Jersey Pickles ${productName} — the snack you didn't know you needed. Grab a jar! 🥒🔥`,
    copy_angle: 'fallback'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD TO META
// ═══════════════════════════════════════════════════════════════════════════════
async function uploadToMeta(adsetId, imagePath, headline, primaryText, linkUrl) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 1. Upload image to Meta (expects file path)
  if (!fs.existsSync(imagePath)) throw new Error(`Image file not found: ${imagePath}`);
  const upload = await meta.uploadImage(imagePath);
  const imageHash = upload.image_hash;

  // 2. Create ad creative using existing meta client method
  const pageId = process.env.META_PAGE_ID;
  const creative = await meta.createAdCreative({
    page_id: pageId,
    image_hash: imageHash,
    headline: headline,
    body: primaryText,
    description: '',
    cta: 'SHOP_NOW',
    link_url: linkUrl
  });

  // 3. Create ad in the ad set
  const adName = `${headline} [AI Creative Agent]`;
  const ad = await meta.createAd(adsetId, creative.creative_id, adName, 'ACTIVE');

  return { adId: ad.ad_id, creativeId: creative.creative_id, adName, imageHash };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN CREATIVE AGENT
// ═══════════════════════════════════════════════════════════════════════════════

const CreativeProposal = require('../../db/models/CreativeProposal');

/**
 * Run the Creative Agent.
 * Generates images + copy and saves as proposals for user approval.
 * Does NOT upload to Meta — user approves first.
 */
async function runCreativeAgent() {
  const startTime = Date.now();
  const cycleId = `creative_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Creative Agent [${cycleId}] ═══`);

  // 1. Expirar propuestas "ready" con mas de 48h sin ser tomadas por Testing Agent
  const staleReady = await CreativeProposal.updateMany(
    { status: 'ready', created_at: { $lt: new Date(Date.now() - 48 * 3600000) } },
    { $set: { status: 'expired', rejection_reason: 'auto: no tomada por Testing Agent en 48h', decided_at: new Date() } }
  );
  if (staleReady.modifiedCount > 0) {
    logger.info(`[CREATIVE-AGENT] Expiradas ${staleReady.modifiedCount} propuestas "ready" con +48h`);
  }

  // 2. Pre-scan: detectar ad sets con 0-1 ads activos y forzar flag (no depender del LLM)
  try {
    const activeAdsets = await getLatestSnapshots('adset');
    const excludeNames = ['[TEST]', 'AI -', 'AMAZON', 'DONT TOUCH', 'DONT_TOUCH', 'EXCLUDE', 'MANUAL ONLY', '[Ares]'];
    const onlyActive = activeAdsets.filter(s => s.status === 'ACTIVE' && !excludeNames.some(ex => (s.entity_name || '').toUpperCase().includes(ex.toUpperCase())));
    let autoFlagged = 0;

    for (const adset of onlyActive) {
      const ads = await getAdsForAdSet(adset.entity_id);
      const activeAds = ads.filter(a => a.status === 'ACTIVE');

      if (activeAds.length <= 1) {
        const mem = await BrainMemory.findOne({ entity_id: adset.entity_id }).lean();
        if (!mem?.agent_needs_new_creatives) {
          await BrainMemory.findOneAndUpdate(
            { entity_id: adset.entity_id },
            {
              $set: {
                entity_name: adset.entity_name,
                entity_type: 'adset',
                agent_needs_new_creatives: true,
                last_updated_at: new Date()
              }
            },
            { upsert: true }
          );
          autoFlagged++;
        }
      }
    }

    if (autoFlagged > 0) {
      logger.info(`[CREATIVE-AGENT] Pre-scan: ${autoFlagged} ad sets auto-flagged (0-1 active ads)`);
    }
  } catch (err) {
    logger.error(`[CREATIVE-AGENT] Pre-scan error (continuing anyway): ${err.message}`);
  }

  // 3. Check pool size — si ya hay suficientes reactivos, saltar esa parte (pero proactivos siempre)
  const MAX_POOL_SIZE = 30;
  const currentPool = await CreativeProposal.countDocuments({ status: 'ready' });
  const skipReactive = currentPool >= MAX_POOL_SIZE;
  if (skipReactive) {
    logger.info(`[CREATIVE-AGENT] Pool lleno (${currentPool} ready, max ${MAX_POOL_SIZE}) — saltando generacion reactiva, pero generando proactivos`);
  }

  // 4. Check for ad sets needing creatives (excluir legacy/AMAZON/TEST)
  const excludeRegex = /\[TEST\]|^AI -|AMAZON|DONT TOUCH|DONT_TOUCH|EXCLUDE|MANUAL ONLY|\[Ares\]/i;
  const needCreatives = skipReactive ? [] : await BrainMemory.find({
    agent_needs_new_creatives: true,
    entity_type: 'adset'
  }).lean();

  const filtered = needCreatives.filter(m => !excludeRegex.test(m.entity_name || ''));

  if (!skipReactive) {
    logger.info(`[CREATIVE-AGENT] ${filtered.length} ad sets need creatives`);
  }

  // 2. Get available products
  const products = await ProductBank.find({ active: true }).lean();
  if (products.length === 0) {
    logger.warn('[CREATIVE-AGENT] No products in bank — cannot generate creatives');
    return { generated: 0, elapsed: '0s', cycle_id: cycleId, error: 'No products in bank' };
  }

  // 3. Learn from test results + human feedback
  const testResults = await CreativeProposal.find({
    $or: [
      { status: { $in: ['graduated', 'killed', 'expired', 'approved', 'rejected'] } },
      { 'human_feedback.rating': { $ne: null } }
    ]
  }).sort({ created_at: -1 }).limit(150).lean();

  const approvedScenes = {};
  const rejectedScenes = {};
  const badSceneReasons = {}; // track why scenes fail (human feedback)

  for (const p of testResults) {
    const s = p.scene_short || 'unknown';

    // Human feedback tiene peso alto — es juicio directo del usuario
    if (p.human_feedback?.rating === 'bad') {
      rejectedScenes[s] = (rejectedScenes[s] || 0) + 3; // peso alto
      const reason = p.human_feedback.reason || 'other';
      if (!badSceneReasons[s]) badSceneReasons[s] = {};
      badSceneReasons[s][reason] = (badSceneReasons[s][reason] || 0) + 1;
    }
    if (p.human_feedback?.rating === 'good') {
      approvedScenes[s] = (approvedScenes[s] || 0) + 2;
    }

    // Test results
    if (p.status === 'graduated') approvedScenes[s] = (approvedScenes[s] || 0) + 3;
    if (p.status === 'approved') approvedScenes[s] = (approvedScenes[s] || 0) + 1;
    if (p.status === 'killed') rejectedScenes[s] = (rejectedScenes[s] || 0) + 2;
    if (p.status === 'rejected') rejectedScenes[s] = (rejectedScenes[s] || 0) + 1;
    // Expired = dato neutral

  if (Object.keys(badSceneReasons).length > 0) {
    logger.info(`[CREATIVE-AGENT] Human feedback: ${Object.entries(badSceneReasons).map(([s, r]) => `${s.substring(0,20)}: ${JSON.stringify(r)}`).join(', ')}`);
  }
  }

  let generated = 0;
  const results = [];

  // ── Leer directivas de Zeus para ajustar weights ──
  let zeusSceneBoosts = {};   // scene_short → bonus points
  let zeusStyleBoosts = {};   // style_key → bonus weight
  let zeusAngleBoosts = {};   // angle_key → bonus weight
  try {
    const directives = await ZeusDirective.find({
      target_agent: { $in: ['apollo', 'all'] },
      active: true
    }).lean();

    // Helper: convierte string a array (Zeus a veces devuelve string en vez de array)
    const toArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    };

    for (const d of directives) {
      const data = d.data || {};
      const scenes = toArray(data.scenes);
      const styles = toArray(data.styles);
      const angles = toArray(data.angles);

      if (d.directive_type === 'prioritize') {
        for (const s of scenes) zeusSceneBoosts[s] = (zeusSceneBoosts[s] || 0) + 5;
        for (const s of styles) zeusStyleBoosts[s] = (zeusStyleBoosts[s] || 0) + 3;
        for (const a of angles) zeusAngleBoosts[a] = (zeusAngleBoosts[a] || 0) + 2;
      } else if (d.directive_type === 'avoid') {
        for (const s of scenes) zeusSceneBoosts[s] = (zeusSceneBoosts[s] || 0) - 10;
        for (const s of styles) zeusStyleBoosts[s] = (zeusStyleBoosts[s] || 0) - 5;
        for (const a of angles) zeusAngleBoosts[a] = (zeusAngleBoosts[a] || 0) - 3;
      }
    }

    if (directives.length > 0) {
      logger.info(`[CREATIVE-AGENT] Zeus directivas aplicadas: ${directives.length} (${Object.keys(zeusSceneBoosts).length} scene boosts, ${Object.keys(zeusStyleBoosts).length} style boosts)`);
    }
  } catch (err) {
    logger.warn(`[CREATIVE-AGENT] Error leyendo Zeus directivas: ${err.message}`);
  }

  // Aplicar Zeus boosts a estilos y angulos
  const adjustedStyles = AD_STYLES.map(s => ({ ...s, weight: Math.max(0.1, (s.weight || 1) + (zeusStyleBoosts[s.key] || 0)) }));
  const adjustedAngles = COPY_ANGLES.map(a => ({ ...a, weight: Math.max(0.1, (a.weight || 1) + (zeusAngleBoosts[a.key] || 0)) }));

  // ── Leer señales tempranas de tests ACTIVOS de Prometheus (learning/evaluating) ──
  // Esto permite a Apollo reaccionar a patrones emergentes sin esperar graduaciones
  const liveSceneSignals = {}; // scene_short → { purchases, spend, roas, count }
  try {
    const TestRun = require('../../db/models/TestRun');
    const activeTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } })
      .populate('proposal_id', 'scene_short').lean();

    for (const t of activeTests) {
      const scene = t.proposal_id?.scene_short;
      if (!scene) continue;
      if (!liveSceneSignals[scene]) liveSceneSignals[scene] = { purchases: 0, spend: 0, revenue: 0, count: 0, clicks: 0, atc: 0 };
      const m = t.metrics || {};
      liveSceneSignals[scene].count++;
      liveSceneSignals[scene].purchases += m.purchases || 0;
      liveSceneSignals[scene].spend += m.spend || 0;
      liveSceneSignals[scene].revenue += (m.roas || 0) * (m.spend || 0);
      liveSceneSignals[scene].clicks += m.clicks || 0;
      liveSceneSignals[scene].atc += m.add_to_cart || 0;
    }

    // Loggear patrones detectados
    const signals = Object.entries(liveSceneSignals).filter(([_, d]) => d.spend >= 5);
    if (signals.length > 0) {
      const summary = signals
        .map(([s, d]) => `${s.substring(0, 25)}: ${d.purchases}pur/$${Math.round(d.spend)}`)
        .slice(0, 5).join(', ');
      logger.info(`[CREATIVE-AGENT] Live test signals: ${summary}`);
    }
  } catch (err) {
    logger.warn(`[CREATIVE-AGENT] Error leyendo live test signals: ${err.message}`);
  }

  // Helper: calcula bonus/penalty por señal de tests en vivo
  // Purchases son la verdad final. ATC puede estar en 0 por bug de tracking Meta.
  const liveSignalScore = (sceneShort) => {
    const d = liveSceneSignals[sceneShort];
    if (!d) return 0;
    const avgRoas = d.spend > 0 ? d.revenue / d.spend : 0;

    if (d.purchases > 0) {
      // Ganador fuerte: muchas compras + ROAS alto → boost maximo
      if (d.count >= 3 && d.purchases >= 4 && avgRoas >= 4.0) return 5;
      if (d.count >= 2 && d.purchases >= 3 && avgRoas >= 3.0) return 4;
      if (d.count >= 2 && d.purchases >= 2 && avgRoas >= 3.0) return Math.min(4, Math.floor(avgRoas / 3));
      if (d.count >= 1 && d.purchases >= 1 && avgRoas >= 5.0) return 2;
      // Tiene compras pero ROAS bajo → escena mediocre, penalty leve
      if (d.spend >= 30 && avgRoas < 2.0) return -1;
      return 0;
    }

    // Sin compras — penalizar basado en spend (mas gasto sin resultado = peor)
    if (d.count >= 2 && d.spend >= 15) return -4;
    if (d.count >= 1 && d.spend >= 15) return -3;
    if (d.count >= 1 && d.spend >= 10) return -2;
    return 0;
  };

  // ── Smart scene ranking: approved scenes + live signals + Zeus boosts ──
  const rankedScenes = SCENES
    .map(s => {
      const short = s.substring(0, 40);
      const app = approvedScenes[short] || 0;
      const rej = rejectedScenes[short] || 0;
      const zeusBoost = zeusSceneBoosts[short] || 0;
      const liveBoost = liveSignalScore(short);
      if (rej >= 3 && app <= rej && zeusBoost >= 0 && liveBoost <= 0) return null; // blacklisted
      const score = (app * 3) - (rej * 2) + (app === 0 && rej === 0 ? 1 : 0) + zeusBoost + liveBoost;
      return { scene: s, short, score, liveBoost };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (rankedScenes.length === 0) {
    logger.warn('[CREATIVE-AGENT] All scenes blacklisted — resetting to full pool');
    rankedScenes.push(...SCENES.map(s => ({ scene: s, short: s.substring(0, 40), score: 0 })));
  }

  // ── Smart product ranking: best ROAS first, then most ads created ──
  const rankedProducts = products
    .filter(p => p.png_references && p.png_references.length > 0)
    .sort((a, b) => {
      const roasA = a.performance?.avg_roas || 0;
      const roasB = b.performance?.avg_roas || 0;
      if (roasA !== roasB) return roasB - roasA; // best ROAS first
      return (b.performance?.total_ads_created || 0) - (a.performance?.total_ads_created || 0);
    });

  if (rankedProducts.length === 0) {
    logger.warn('[CREATIVE-AGENT] No products with PNG references — cannot generate');
    return { generated: 0, elapsed: '0s', cycle_id: cycleId, error: 'No products with PNGs' };
  }

  const PROPOSALS_PER_ADSET = 2;
  let globalSceneIndex = 0; // rotates across ad sets so each gets different scenes

  // Pre-cargar conteo de material existente por ad set (tests activos + proposals ready)
  const TestRun = require('../../db/models/TestRun');
  const activeTestCounts = {};
  const activeTests = await TestRun.find({ phase: { $in: ['learning', 'evaluating'] } }).select('source_adset_id').lean();
  for (const t of activeTests) activeTestCounts[t.source_adset_id] = (activeTestCounts[t.source_adset_id] || 0) + 1;
  const readyProposalCounts = {};
  const readyProps = await CreativeProposal.find({ status: 'ready', adset_id: { $ne: 'proactive' } }).select('adset_id').lean();
  for (const p of readyProps) readyProposalCounts[p.adset_id] = (readyProposalCounts[p.adset_id] || 0) + 1;

  const MAX_MATERIAL_PER_ADSET = 2; // max 2 entre tests + ready por ad set

  for (const memory of filtered) {
    const adsetId = memory.entity_id;
    const adsetName = memory.entity_name;

    // Skip si ya tiene suficiente material en pipeline
    const existingMaterial = (activeTestCounts[adsetId] || 0) + (readyProposalCounts[adsetId] || 0);
    if (existingMaterial >= MAX_MATERIAL_PER_ADSET) {
      logger.debug(`[CREATIVE-AGENT] ${adsetName}: ya tiene ${existingMaterial} en pipeline — skip`);
      continue;
    }

    try {
      // Pick product — match by name first, fallback to best ROAS
      let product = rankedProducts.find(p =>
        (adsetName || '').toLowerCase().includes(p.product_slug.toLowerCase()) ||
        (adsetName || '').toLowerCase().includes(p.product_name.toLowerCase())
      ) || rankedProducts[0];

      // Pick N different scenes for this ad set — rotate across ad sets
      const scenePicks = [];
      for (let i = 0; i < PROPOSALS_PER_ADSET && i < rankedScenes.length; i++) {
        const idx = (globalSceneIndex + i) % rankedScenes.length;
        scenePicks.push(rankedScenes[idx]);
      }
      globalSceneIndex = (globalSceneIndex + PROPOSALS_PER_ADSET) % rankedScenes.length;

      // Decidir si hacer combo — solo productos standard (excluir custom/BYB)
      const standardProducts = rankedProducts.filter(p => p.prompt_type !== 'custom');
      const doCombo = standardProducts.length >= 2 && product.prompt_type !== 'custom' && Math.random() < 0.3;
      let refImages, refTypes, comboNames = [];

      if (doCombo) {
        // Combo: solo productos standard (no BYB)
        const comboProducts = standardProducts.slice(0, Math.min(3, standardProducts.length));
        refImages = comboProducts.flatMap(p =>
          p.png_references.map(ref => ({
            image_base64: ref.image_base64,
            mime_type: ref.mime_type,
            path: !ref.image_base64 ? path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename) : null
          }))
        );
        refTypes = comboProducts.flatMap(p => p.png_references.map(ref => ref.type));
        comboNames = comboProducts.map(p => p.product_name);
        logger.info(`[CREATIVE-AGENT] Modo COMBO (solo standard): ${comboNames.join(' + ')}`);
      } else {
        // Single product
        refImages = product.png_references.map(ref => ({
          image_base64: ref.image_base64,
          mime_type: ref.mime_type,
          path: !ref.image_base64 ? path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename) : null
        }));
        refTypes = product.png_references.map(ref => ref.type);
      }

      for (const scenePick of scenePicks) {
        const scene = scenePick.scene;
        const sceneShort = scenePick.short;

        // Pick random style and copy angle (ajustados por Zeus)
        const style = weightedPick(adjustedStyles);
        const copyAngle = weightedPick(adjustedAngles);

        // Build prompt — custom template o generico
        let prompt;
        if (product.prompt_type === 'custom' && product.custom_prompt_template) {
          // Producto con prompt custom (ej: Build Your Box)
          prompt = product.custom_prompt_template.replace(/\{SCENE\}/g, scene);
          prompt += ' ' + style.prompt;
          logger.info(`[CREATIVE-AGENT] CUSTOM prompt for ${adsetName} — ${sceneShort} [${style.key}]`);
        } else {
          // Producto standard — prompt generico
          prompt = buildImagePrompt(
            product.product_name, scene, refTypes, style,
            doCombo, comboNames
          );
          logger.info(`[CREATIVE-AGENT] Generating for ${adsetName} — ${sceneShort} [${style.key}/${copyAngle.key}]${doCombo ? ' COMBO' : ''}...`);
        }
        const imageBase64 = await generateImage(prompt, refImages);

        // Generate copy with angle
        const copy = await generateCopy(product.product_name, sceneShort, copyAngle, doCombo, comboNames);

        // Save as proposal (NOT uploaded yet) — image stored as base64 in DB
        await CreativeProposal.create({
          adset_id: adsetId,
          adset_name: adsetName,
          product_id: product._id,
          product_name: doCombo ? comboNames.join(' + ') : product.product_name,
          image_base64: imageBase64,
          scene,
          scene_short: sceneShort,
          headline: copy.headline,
          primary_text: copy.primary_text,
          link_url: product.link_url || 'https://jerseypickles.com',
          prompt_used: prompt,
          status: 'ready'
        });

        generated++;

        // Limpiar flag — ya tiene material en pipeline
        await BrainMemory.findOneAndUpdate(
          { entity_id: adsetId },
          { $set: { agent_needs_new_creatives: false } }
        );

        results.push({
          adset_id: adsetId,
          adset_name: adsetName,
          product: product.product_name,
          scene: sceneShort,
          headline: copy.headline,
          status: 'pending_approval'
        });

        logger.info(`[CREATIVE-AGENT] ✅ ${adsetName}: "${copy.headline}" — pendiente de aprobacion`);
      }

    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Error for ${adsetName}: ${err.message}`);
      results.push({ adset_id: adsetId, adset_name: adsetName, error: err.message });
    }
  }

  // ═══ GENERACION PROACTIVA — siempre generar algunos para ad sets nuevos ═══
  const MIN_PROACTIVE_PER_CYCLE = 3; // siempre generar al menos 3 proactivos para escalar
  const MIN_POOL_SIZE = 10;
  const readyCount = await CreativeProposal.countDocuments({ status: 'ready' });
  const poolNeeded = Math.max(0, MIN_POOL_SIZE - readyCount - generated);
  const proactiveNeeded = Math.max(MIN_PROACTIVE_PER_CYCLE, poolNeeded);

  if (proactiveNeeded > 0 && rankedProducts.length > 0 && rankedScenes.length > 0) {
    logger.info(`[CREATIVE-AGENT] Pool bajo (${readyCount} + ${generated} generados). Generando ${proactiveNeeded} proactivos para escalar.`);

    for (let p = 0; p < proactiveNeeded; p++) {
      try {
        const product = rankedProducts[p % rankedProducts.length];
        const sceneIdx = (globalSceneIndex + p) % rankedScenes.length;
        const scenePick = rankedScenes[sceneIdx];
        const style = weightedPick(adjustedStyles);
        const copyAngle = weightedPick(adjustedAngles);

        // Referencias del producto
        const refImages = product.png_references.map(ref => ({
          image_base64: ref.image_base64,
          mime_type: ref.mime_type,
          path: !ref.image_base64 ? path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename) : null
        }));
        const refTypes = product.png_references.map(ref => ref.type);

        let prompt;
        if (product.prompt_type === 'custom' && product.custom_prompt_template) {
          prompt = product.custom_prompt_template.replace(/\{SCENE\}/g, scenePick.scene) + ' ' + style.prompt;
        } else {
          prompt = buildImagePrompt(product.product_name, scenePick.scene, refTypes, style, false, []);
        }

        logger.info(`[CREATIVE-AGENT] Proactivo ${p + 1}/${proactiveNeeded}: ${scenePick.short} [${style.key}/${copyAngle.key}]${product.prompt_type === 'custom' ? ' CUSTOM' : ''}`);
        const imageBase64 = await generateImage(prompt, refImages);
        const copy = await generateCopy(product.product_name, scenePick.short, copyAngle, false, []);

        // Propuesta proactiva: adset_id = 'proactive' — Prometheus crea ad set nuevo
        await CreativeProposal.create({
          adset_id: 'proactive',
          adset_name: 'Nuevo ad set (Prometheus)',
          product_id: product._id,
          product_name: product.product_name,
          image_base64: imageBase64,
          scene: scenePick.scene,
          scene_short: scenePick.short,
          headline: copy.headline,
          primary_text: copy.primary_text,
          link_url: product.link_url || 'https://jerseypickles.com',
          prompt_used: prompt,
          status: 'ready'
        });

        generated++;
      } catch (err) {
        logger.error(`[CREATIVE-AGENT] Error generando proactivo: ${err.message}`);
      }
    }
    globalSceneIndex = (globalSceneIndex + proactiveNeeded) % rankedScenes.length;
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Creative Agent completado [${cycleId}]: ${generated} propuestas generadas en ${elapsed} ═══`);

  // Reportar a Zeus
  try {
    const ZeusConversation = require('../../db/models/ZeusConversation');
    const boosts = Object.keys(zeusSceneBoosts).length;
    let msg = `Generé ${generated} propuestas en ${elapsed}.`;
    if (boosts > 0) {
      const boosted = Object.entries(zeusSceneBoosts).filter(([_, v]) => v > 0).map(([k]) => k.substring(0, 25));
      const avoided = Object.entries(zeusSceneBoosts).filter(([_, v]) => v < 0).map(([k]) => k.substring(0, 25));
      if (boosted.length > 0) msg += ` Prioricé tus escenas: ${boosted.join(', ')}.`;
      if (avoided.length > 0) msg += ` Evité: ${avoided.join(', ')}.`;
    } else {
      msg += ' Sin directivas tuyas este ciclo.';
    }
    await ZeusConversation.create({
      from: 'apollo', to: 'zeus', type: 'report', message: msg, cycle_id: cycleId,
      context: { generated, scene_boosts: boosts }
    });
  } catch (_) {}

  return { generated, results, elapsed, cycle_id: cycleId };
}

/**
 * Approve a creative proposal — upload to Meta.
 */
async function approveProposal(proposalId) {
  const proposal = await CreativeProposal.findById(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);

  // Upload to Meta — use file if exists, otherwise write base64 to temp file
  let imagePath = proposal.image_path;

  if (!imagePath || !fs.existsSync(imagePath)) {
    if (!proposal.image_base64) throw new Error('No image data available — file missing and no base64 in DB');
    // Write base64 to temp file
    const tmpDir = path.join(require('os').tmpdir(), 'creative-agent');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    imagePath = path.join(tmpDir, `proposal_${proposal._id}.png`);
    fs.writeFileSync(imagePath, Buffer.from(proposal.image_base64, 'base64'));
  }

  let uploadResult;
  try {
    uploadResult = await uploadToMeta(
      proposal.adset_id,
      imagePath,
      proposal.headline,
      proposal.primary_text,
      proposal.link_url
    );
  } catch (uploadErr) {
    // Upload fallo — marcar como failed pero NO limpiar el flag needs_new_creatives
    proposal.status = 'failed';
    proposal.decided_at = new Date();
    await proposal.save();
    logger.error(`[CREATIVE-AGENT] Upload failed for proposal ${proposalId}: ${uploadErr.message}`);
    throw new Error(`Upload a Meta fallo: ${uploadErr.message}`);
  }

  // Upload exitoso — actualizar proposal
  proposal.status = 'uploaded';
  proposal.decided_at = new Date();
  proposal.meta_ad_id = uploadResult.adId;
  proposal.meta_creative_id = uploadResult.creativeId;
  proposal.meta_ad_name = uploadResult.adName;
  await proposal.save();

  // Log
  await ActionLog.create({
    entity_type: 'adset',
    entity_id: proposal.adset_id,
    entity_name: proposal.adset_name,
    action: 'create_ad',
    after_value: uploadResult.adName,
    reasoning: `[CREATIVE-AGENT] Approved: "${proposal.headline}" for ${proposal.product_name} (${proposal.scene_short})`,
    confidence: 'high',
    agent_type: 'creative_agent',
    success: true,
    new_entity_id: uploadResult.adId
  });

  // Clear needs_new_creatives flag — solo si upload fue exitoso
  await BrainMemory.findOneAndUpdate(
    { entity_id: proposal.adset_id },
    { $set: { agent_needs_new_creatives: false, last_updated_at: new Date() } }
  );

  // Update product stats
  await ProductBank.findByIdAndUpdate(proposal.product_id, {
    $inc: { 'performance.total_ads_created': 1 },
    $set: { updated_at: new Date() }
  });

  logger.info(`[CREATIVE-AGENT] Proposal ${proposalId} approved and uploaded as ${uploadResult.adId}`);
  return { success: true, ad_id: uploadResult.adId, ad_name: uploadResult.adName };
}

/**
 * Reject a creative proposal.
 */
async function rejectProposal(proposalId, reason = '') {
  const proposal = await CreativeProposal.findById(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);

  proposal.status = 'rejected';
  proposal.decided_at = new Date();
  proposal.rejection_reason = reason;
  await proposal.save();

  logger.info(`[CREATIVE-AGENT] Proposal ${proposalId} rejected: ${reason || 'no reason'}`);
  return { success: true };
}

/**
 * Sync performance metrics for uploaded CreativeProposals + ProductBank stats.
 * Runs as part of jobCreativeMetricsSync (every 6h).
 */
async function syncProposalPerformance() {
  const MetricSnapshot = require('../../db/models/MetricSnapshot');

  // Auto-repair: match uploaded proposals missing meta_ad_id by ad name pattern
  try {
    const orphans = await CreativeProposal.find({
      status: 'uploaded',
      $or: [{ meta_ad_id: null }, { meta_ad_id: { $exists: false } }]
    }).lean();

    if (orphans.length > 0) {
      logger.info(`[CREATIVE-AGENT] Auto-repair: ${orphans.length} uploaded proposals missing meta_ad_id`);
      for (const orphan of orphans) {
        // Match by headline pattern — ads are named "{headline} [AI Creative Agent]"
        const expectedName = `${orphan.headline} [AI Creative Agent]`;
        const adSnapshot = await MetricSnapshot.findOne({
          entity_type: 'ad',
          entity_name: expectedName,
          parent_id: orphan.adset_id
        }).sort({ snapshot_at: -1 }).lean();

        if (adSnapshot) {
          await CreativeProposal.findByIdAndUpdate(orphan._id, {
            $set: { meta_ad_id: adSnapshot.entity_id, meta_ad_name: expectedName }
          });
          logger.info(`[CREATIVE-AGENT] Auto-repair: matched "${orphan.headline}" → ${adSnapshot.entity_id}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[CREATIVE-AGENT] Auto-repair error: ${err.message}`);
  }

  // Buscar propuestas con ad en Meta (uploaded + graduated)
  const uploaded = await CreativeProposal.find({
    status: { $in: ['uploaded', 'graduated'] },
    meta_ad_id: { $ne: null }
  }).lean();

  if (uploaded.length === 0) return { synced: 0, products_updated: 0 };

  let synced = 0;

  for (const proposal of uploaded) {
    try {
      // Buscar snapshot mas reciente del ad
      const snapshot = await MetricSnapshot.findOne({
        entity_type: 'ad',
        entity_id: proposal.meta_ad_id
      }).sort({ snapshot_at: -1 }).lean();

      if (!snapshot) continue;

      // Use best available window: 7d > 3d > today
      const m = (snapshot.metrics?.last_7d?.spend > 0 && snapshot.metrics.last_7d)
             || (snapshot.metrics?.last_3d?.spend > 0 && snapshot.metrics.last_3d)
             || (snapshot.metrics?.today?.spend > 0 && snapshot.metrics.today)
             || null;
      if (!m) continue;

      await CreativeProposal.findByIdAndUpdate(proposal._id, {
        $set: {
          'performance.roas_7d': m.roas || 0,
          'performance.spend_7d': m.spend || 0,
          'performance.purchases_7d': m.purchases || 0,
          'performance.ctr_7d': m.ctr || 0,
          'performance.measured_at': new Date()
        }
      });

      synced++;
    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Sync error for proposal ${proposal._id}: ${err.message}`);
    }
  }

  // Actualizar ProductBank stats agregando metricas de todas las propuestas uploaded
  const products = await ProductBank.find({ active: true }).lean();
  let productsUpdated = 0;

  for (const product of products) {
    try {
      const proposals = await CreativeProposal.find({
        product_id: product._id,
        status: 'uploaded',
        'performance.measured_at': { $ne: null }
      }).lean();

      if (proposals.length === 0) continue;

      const totalSpend = proposals.reduce((s, p) => s + (p.performance?.spend_7d || 0), 0);
      const totalPurchases = proposals.reduce((s, p) => s + (p.performance?.purchases_7d || 0), 0);
      const withRoas = proposals.filter(p => p.performance?.roas_7d > 0);
      const avgRoas = withRoas.length > 0
        ? withRoas.reduce((s, p) => s + p.performance.roas_7d, 0) / withRoas.length
        : 0;

      // Calcular best/worst scene
      const sceneMap = {};
      for (const p of proposals) {
        if (!p.scene_short || !p.performance?.roas_7d) continue;
        if (!sceneMap[p.scene_short]) sceneMap[p.scene_short] = { roas: [], spend: 0, ads: 0 };
        sceneMap[p.scene_short].roas.push(p.performance.roas_7d);
        sceneMap[p.scene_short].spend += p.performance.spend_7d || 0;
        sceneMap[p.scene_short].ads++;
      }

      const sceneEntries = Object.entries(sceneMap).map(([scene, data]) => ({
        scene,
        avg_roas: data.roas.reduce((a, b) => a + b, 0) / data.roas.length,
        total_spend: data.spend,
        ads_created: data.ads
      }));
      sceneEntries.sort((a, b) => b.avg_roas - a.avg_roas);

      await ProductBank.findByIdAndUpdate(product._id, {
        $set: {
          'performance.total_spend': totalSpend,
          'performance.total_purchases': totalPurchases,
          'performance.avg_roas': Math.round(avgRoas * 100) / 100,
          'performance.best_scene': sceneEntries[0]?.scene || '',
          'performance.worst_scene': sceneEntries[sceneEntries.length - 1]?.scene || '',
          scene_performance: sceneEntries,
          updated_at: new Date()
        }
      });

      productsUpdated++;
    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Product stats error for ${product.product_name}: ${err.message}`);
    }
  }

  logger.info(`[CREATIVE-AGENT] Performance sync: ${synced} propuestas actualizadas, ${productsUpdated} productos actualizados`);
  return { synced, products_updated: productsUpdated };
}

module.exports = { runCreativeAgent, approveProposal, rejectProposal, syncProposalPerformance, generateImage, generateCopy, uploadToMeta, SCENES };
