/**
 * Video Pipeline — "Director Creativo" Mode v8 — Grok Imagine Direct API
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. Claude Vision analyzes product → detects ingredients → recommends best commercial scene → designs 12 NARRATIVE BEATS (hybrid CONTEXT + PRODUCT story arc)
 *   3. Grok Imagine generates shots via xAI API: CONTEXT via text-to-image, PRODUCT via image edit
 *   4. Claude Vision judges each shot quality with type-specific criteria (1-10 score + feedback)
 *   5. User reviews storyboard with scores, can regenerate low-scoring shots
 *   6. Grok Imagine Video converts each approved shot to a 5-10s video clip (720p, native audio) via xAI API
 *   7. FFmpeg stitches all clips into ONE complete commercial video
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const { execFile } = require('child_process');

const SHOTS_DIR = path.join(config.system.uploadsDir, 'video-shots');
const VIDEOS_DIR = path.join(config.system.uploadsDir, 'video-clips');
const FINALS_DIR = path.join(config.system.uploadsDir, 'video-finals');
const MUSIC_DIR = path.join(__dirname, 'music');

// ═══ MUSIC TRACKS — Local royalty-free background music catalog ═══
// Replace placeholder .m4a files with real royalty-free tracks for production
const MUSIC_TRACKS = [
  { key: 'upbeat-energy', label: 'Energetico', file: 'upbeat-energy.m4a', mood: 'Upbeat, energetic, fun — great for snacks, party foods, youthful brands' },
  { key: 'ambient-calm', label: 'Ambiente Calmo', file: 'ambient-calm.m4a', mood: 'Ambient, calm, peaceful — ideal for organic, natural, wellness products' },
  { key: 'premium-elegant', label: 'Premium Elegante', file: 'premium-elegant.m4a', mood: 'Elegant, sophisticated, premium — luxury products, gourmet foods, high-end brands' },
  { key: 'organic-natural', label: 'Organico Natural', file: 'organic-natural.m4a', mood: 'Warm, earthy, natural — farm-to-table, rustic, artisanal products' },
  { key: 'party-fun', label: 'Fiesta', file: 'party-fun.m4a', mood: 'Festive, celebratory, bright — party snacks, beverages, social occasions' },
  { key: 'cinematic-dramatic', label: 'Cinematico', file: 'cinematic-dramatic.m4a', mood: 'Cinematic, dramatic, powerful — hero product launches, bold brands, intense flavor profiles' },
  { key: 'none', label: 'Sin Musica', file: null, mood: 'No background music' },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  return types[ext] || 'image/png';
}

// ═══ AVAILABLE SCENES (Claude picks the best one) ═══
const AVAILABLE_SCENES = [
  { key: 'studio-hero', label: 'Estudio Hero', description: 'Premium studio with clean surface, soft gradient background, professional directional lighting' },
  { key: 'kitchen-warm', label: 'Cocina Calida', description: 'Warm wooden kitchen countertop, cozy home kitchen, copper utensils, morning sunlight' },
  { key: 'picnic-outdoor', label: 'Picnic Exterior', description: 'Rustic picnic blanket outdoors, sunny park, golden hour, summer lifestyle' },
  { key: 'party-table', label: 'Mesa de Fiesta', description: 'Festive party table with decorations, confetti, party snacks, celebration mood' },
  { key: 'ingredients-splash', label: 'Splash Ingredientes', description: 'Key ingredients floating/splashing around product, dark dramatic background, spotlight' },
  { key: 'rustic-wood', label: 'Rustico Madera', description: 'Weathered dark wood surface, artisanal farmhouse setting, moody warm lighting' },
  { key: 'neon-modern', label: 'Neon Moderno', description: 'Sleek dark surface with neon color accents, urban nightlife, bold social media aesthetic' },
  { key: 'ice-fresh', label: 'Hielo Fresco', description: 'Crushed ice, water droplets, frost, cool blue lighting, refreshing commercial feel' },
  { key: 'marble-elegant', label: 'Marmol Elegante', description: 'White marble surface with gold accents, diffused premium lighting, luxury aesthetic' },
  { key: 'bbq-grill', label: 'BBQ Parrilla', description: 'BBQ grill with smoke, charcoal glow, grilled food background, summer cookout' },
  { key: 'colorful-flat', label: 'Flat Lay Color', description: 'Top-down flat lay, vibrant solid background, complementary props, social media style' },
  { key: 'nature-green', label: 'Naturaleza Verde', description: 'Mossy natural stone, fresh green leaves and herbs, dappled forest sunlight, farm-to-table' },
];

// ═══ BEAT TYPES ═══
const BEAT_TYPES = {
  context: { key: 'context', label: 'Contexto', description: 'Generated from scratch via text-to-image. No product photo needed.' },
  product: { key: 'product', label: 'Producto', description: 'Generated via image edit using the product photo as reference.' }
};

// ═══ VIDEO MODEL OPTIONS — Grok Imagine (xAI) + Sora 2 Pro (OpenAI) ═══
const VIDEO_MODELS = {
  'grok-imagine-720p': { key: 'grok-imagine-720p', label: 'Grok Imagine 720p', provider: 'xai', resolution: '720p', soraSize: null, costPerSec: 0.07, recommended: false },
  'sora-2-pro':        { key: 'sora-2-pro', label: 'Sora 2 Pro', provider: 'openai', resolution: '720p', soraSize: '720x1280', costPerSec: 0.21, recommended: true },
  'sora-2':            { key: 'sora-2', label: 'Sora 2', provider: 'openai', resolution: '720p', soraSize: '720x1280', costPerSec: 0.10, recommended: false }
};

const DEFAULT_VIDEO_MODEL = 'sora-2-pro';

// ═══ 12 NARRATIVE BEATS — Hybrid CONTEXT + PRODUCT story arc ═══
// CONTEXT beats: text-to-image (ingredients, lifestyle, process) — no product photo needed
// PRODUCT beats: image edit (hero, closeup, action) — uses product photo as reference
const NARRATIVE_BEATS = [
  { key: 'beat-01-ingredient-origin', label: '1. Origen', order: 1, type: 'context', narrative: 'Opening wide shot of the key ingredient in its natural environment — a sun-drenched field, a garden, an orchard. No product visible. Establishes origin, quality, and natural beauty.' },
  { key: 'beat-02-fresh-harvest', label: '2. Cosecha', order: 2, type: 'context', narrative: 'Close-up of the key ingredient freshly harvested — texture, dewdrops, vibrant color. Macro shot that makes you almost taste the freshness. No product visible.' },
  { key: 'beat-03-product-reveal', label: '3. Revelacion', order: 3, type: 'product', narrative: 'The product enters the scene or is revealed for the first time. Dramatic entrance — perhaps placed by a hand, or camera discovers it. Full product visible, centered, eye-level hero shot.' },
  { key: 'beat-04-craft-process', label: '4. Proceso', order: 4, type: 'context', narrative: 'Artisanal preparation scene — hands crafting, kitchen process, traditional method. Shows the care and craft behind the product. No product visible, just the process.' },
  { key: 'beat-05-label-hero', label: '5. Label Hero', order: 5, type: 'product', narrative: 'Tight close-up on the product label and branding. Fill 70% of frame. This is the "money shot" for brand recognition — sharp focus on name, logo, key text.' },
  { key: 'beat-06-lifestyle-scene', label: '6. Lifestyle', order: 6, type: 'context', narrative: 'Beautiful lifestyle scene showing the context where this product is enjoyed — a set table, a picnic, a party, a kitchen gathering. No product visible, just the mood and occasion.' },
  { key: 'beat-07-product-in-action', label: '7. Accion', order: 7, type: 'product', narrative: 'The product is being OPENED or USED. Show contents — the inside revealed. If a jar: lid off, contents visible. If a bag: torn open, contents spilling. Dynamic interaction.' },
  { key: 'beat-08-ingredient-beauty', label: '8. Ingredientes', order: 8, type: 'context', narrative: 'Key ingredients artistically arranged — fresh herbs, spices, vegetables beautifully composed. Suggests quality and freshness. No product visible, pure ingredient beauty.' },
  { key: 'beat-09-contents-glory', label: '9. Contenido', order: 9, type: 'product', narrative: 'Glory shot of the CONTENTS themselves — the actual food outside its packaging. Dripping, glistening, textured, appetizing. Close-up of the real product being served or displayed.' },
  { key: 'beat-10-mood-atmosphere', label: '10. Atmosfera', order: 10, type: 'context', narrative: 'Artistic/cinematic beauty shot of the atmosphere — dramatic lighting, bokeh, steam, smoke, or creative composition. Sets the mood. No product visible.' },
  { key: 'beat-11-final-composition', label: '11. Composicion', order: 11, type: 'product', narrative: 'Full arrangement shot — product with all props, ingredients, and scene elements beautifully composed. Like a magazine cover or catalog hero image. Everything comes together.' },
  { key: 'beat-12-closing-hero', label: '12. Cierre', order: 12, type: 'product', narrative: 'Final closing hero shot — product centered, clean, powerful. This is the last frame the viewer sees. Brand clearly visible, call-to-action composition. Clean background, maximum impact.' },
];

// Keep backward compat alias
const SHOT_TYPES = NARRATIVE_BEATS;

// ═══ COMMERCIAL TEMPLATES — Optimized vertical ad formats ═══
// Each template has a different narrative style and beat count for vertical ads (Reels/TikTok/Stories)
const COMMERCIAL_TEMPLATES = [
  {
    key: 'classic-12',
    label: 'Clasico (12 Beats)',
    description: 'Full 12-beat cinematic commercial — origin to closing hero. Best for longer ads (45-60s).',
    beats: NARRATIVE_BEATS,
    duration: '45-60s',
    style: 'cinematic',
    clipDuration: 5
  },
  {
    key: 'quick-cut-food',
    label: 'Quick-Cut Comida',
    description: 'Fast-paced food commercial — macro ingredients, product glory, eating moment. Perfect for 15-20s vertical ads.',
    beats: [
      { key: 'qc-01-ingredient-macro', label: '1. Macro Ingrediente', order: 1, type: 'context', narrative: 'Extreme macro close-up of the KEY ingredient — glistening, wet, textured. Cucumber slice with water droplets, garlic clove being crushed, dill sprig with dew. Fill the ENTIRE frame. Food photography style, dramatic dark background, single spotlight.' },
      { key: 'qc-02-splash-action', label: '2. Splash/Accion', order: 2, type: 'context', narrative: 'Dynamic action shot — ingredients falling into brine/liquid, a splash of vinegar, spices cascading, or vegetables being sliced. Frozen motion, dramatic lighting, high-speed photography style. Dark background, vivid colors.' },
      { key: 'qc-03-product-hero', label: '3. Producto Hero', order: 3, type: 'product', narrative: 'The product jar/package revealed dramatically — centered, eye-level, with the key ingredients arranged around it. Professional product photography, clean and bold. The product must be THE star.' },
      { key: 'qc-04-open-reveal', label: '4. Abierto/Revelado', order: 4, type: 'context', narrative: 'The product OPENED — close-up of the actual food contents. For pickles: glistening spears in brine, visible herbs and spices floating. For sauces: thick pour. Extreme close-up, appetizing, make the viewer salivate. Warm lighting.' },
      { key: 'qc-05-eating-moment', label: '5. Momento de Comer', order: 5, type: 'context', narrative: 'The CRUNCH/BITE moment — a pickle being bitten with a visible snap, or the product being added to a burger/sandwich/plate. The satisfying moment of consumption. Close-up, lifestyle, warm tones.' },
      { key: 'qc-06-final-pack', label: '6. Pack Final', order: 6, type: 'product', narrative: 'Final closing shot — product centered, clean background, brand clearly visible. Call-to-action composition. The last frame — strong, clean, memorable brand impression.' }
    ],
    duration: '15-20s',
    style: 'fast-paced',
    clipDuration: 3
  },
  {
    key: 'recipe-pairing',
    label: 'Receta/Pairing',
    description: 'Shows the product as the star ingredient in a recipe or food pairing. Great for "how to use" ads (25-35s).',
    beats: [
      { key: 'rp-01-base-food', label: '1. Base Food', order: 1, type: 'context', narrative: 'Beautiful shot of the BASE food being prepared — a burger being assembled, a charcuterie board being arranged, a sandwich being built, a salad being tossed. The food looks good but is NOT YET complete. Warm kitchen lighting, overhead or 45-degree angle.' },
      { key: 'rp-02-product-enters', label: '2. Producto Entra', order: 2, type: 'product', narrative: 'The product jar/package appears next to the base food — placed by a hand or revealed with a camera movement. The product is the missing ingredient. Side-by-side with the food, anticipation builds.' },
      { key: 'rp-03-product-open', label: '3. Abriendo', order: 3, type: 'context', narrative: 'Hands opening the product — lid twisting off a jar, bag being opened, cap being removed. Close-up on the opening action. You can see the contents inside for the first time. Satisfying, tactile.' },
      { key: 'rp-04-adding-product', label: '4. Agregando', order: 4, type: 'context', narrative: 'The MONEY SHOT — the product being ADDED to the food. Pickles being placed on a burger, sauce being drizzled, toppings being scattered. Close-up, slow-motion feel, the moment of transformation. Food goes from good to AMAZING.' },
      { key: 'rp-05-finished-dish', label: '5. Plato Terminado', order: 5, type: 'context', narrative: 'The finished dish in its full glory — beautifully plated/assembled with the product as the visible star. Overhead shot or hero angle. Restaurant-quality food photography. The product has transformed the food.' },
      { key: 'rp-06-bite-reaction', label: '6. Mordida/Reaccion', order: 6, type: 'context', narrative: 'Someone taking a bite or the finished dish being picked up. The enjoyment moment. Close-up of the bite, cross-section visible showing the product inside. Warm, inviting, makes you hungry.' },
      { key: 'rp-07-product-final', label: '7. Producto Final', order: 7, type: 'product', narrative: 'Final product hero shot — jar/package alongside the finished dish. Brand clearly visible. This is "buy this product to make THIS food" composition. Clean, aspirational.' }
    ],
    duration: '25-35s',
    style: 'recipe',
    clipDuration: 5
  },
  {
    key: 'lifestyle-party',
    label: 'Lifestyle/Social',
    description: 'Product in social contexts — picnics, BBQs, game night, parties. Emotional connection ads (25-35s).',
    beats: [
      { key: 'lp-01-setting-scene', label: '1. Escena Social', order: 1, type: 'context', narrative: 'Wide establishing shot of a social setting — a backyard BBQ with string lights, a game-night table with snacks, a beach picnic setup, a tailgate party. Warm golden hour lighting, inviting atmosphere. No product visible yet, just the mood.' },
      { key: 'lp-02-people-gathering', label: '2. Reunion', order: 2, type: 'context', narrative: 'People gathering around food — hands reaching for snacks, friends laughing around a table, someone setting out plates. The anticipation of a shared meal. Lifestyle photography, candid feel, warm tones.' },
      { key: 'lp-03-product-star', label: '3. Producto Estrella', order: 3, type: 'product', narrative: 'The product placed CENTER STAGE on the table/scene among other foods — it stands out, it is the star. Surrounded by complementary foods and props. Eye-level hero shot, the product draws your eye first.' },
      { key: 'lp-04-serving-moment', label: '4. Sirviendo', order: 4, type: 'context', narrative: 'Someone serving or sharing the product — opening the jar at the table, placing pickles on a shared plate, passing the product to a friend. The social sharing moment. Warm, authentic, lifestyle.' },
      { key: 'lp-05-enjoyment', label: '5. Disfrute', order: 5, type: 'context', narrative: 'Close-up of the product being enjoyed in context — a pickle on a plate next to a burger, the product as part of a full spread. Appetizing food composition showing the product as essential to the occasion.' },
      { key: 'lp-06-atmosphere-joy', label: '6. Atmosfera', order: 6, type: 'context', narrative: 'Joy and atmosphere shot — golden light, happy gathering vibe, clinking drinks, sunset behind the scene. Emotional closing atmosphere that makes you want to BE there with this product. Cinematic, warm.' },
      { key: 'lp-07-product-close', label: '7. Cierre Producto', order: 7, type: 'product', narrative: 'Final product shot — clean, beautiful, the jar/package in golden light. Brand visible, memorable. The emotional association: this product = great times with people you love.' }
    ],
    duration: '25-35s',
    style: 'lifestyle',
    clipDuration: 5
  },
  {
    key: 'asmr-texture',
    label: 'ASMR/Texturas',
    description: 'Extreme close-ups, textures, satisfying visuals. Hypnotic food content for scroll-stopping ads (15-25s).',
    beats: [
      { key: 'as-01-texture-extreme', label: '1. Textura Extrema', order: 1, type: 'context', narrative: 'EXTREME macro close-up of a key ingredient texture — the bumpy skin of a pickle, seeds on a cucumber slice, crystallized salt, a garlic clove cross-section. So close you can almost feel it. Dark background, dramatic single-source lighting, every detail visible.' },
      { key: 'as-02-liquid-flow', label: '2. Liquido/Flujo', order: 2, type: 'context', narrative: 'Satisfying liquid shot — brine pouring in slow-motion, vinegar dripping off a pickle, oil drizzling, condensation droplets rolling down a cold jar. Macro, mesmerizing, ASMR-visual. Dramatic lighting on dark background.' },
      { key: 'as-03-crunch-snap', label: '3. Crunch/Snap', order: 3, type: 'context', narrative: 'The CRUNCH moment — a pickle being snapped in half showing the crisp interior, a chip breaking, something being sliced cleanly. Cross-section reveal. Frozen moment of breakage/crunch. Extreme close-up, you can almost HEAR it.' },
      { key: 'as-04-product-drip', label: '4. Producto Brillante', order: 4, type: 'product', narrative: 'The product jar/package glistening — covered in condensation droplets, freshly pulled from the fridge, wet and cold. The packaging looks touchable, premium, irresistible. Close-up, dramatic lighting.' },
      { key: 'as-05-contents-glory', label: '5. Contenido Gloria', order: 5, type: 'context', narrative: 'The product contents in GLORY — pickles piled up glistening with brine, sauce pooling beautifully, the food product arranged to show every texture and color. Overhead or close macro. Appetizing, satisfying, mouth-watering. Professional food styling.' },
      { key: 'as-06-brand-close', label: '6. Cierre Marca', order: 6, type: 'product', narrative: 'Final brand shot — the product clean and centered, a single droplet of condensation running down the jar. Minimal, powerful, brand clearly visible. Dark premium background.' }
    ],
    duration: '15-25s',
    style: 'asmr',
    clipDuration: 4
  },
  {
    key: 'before-after',
    label: 'Antes/Despues',
    description: 'Boring food → add product → AMAZING food. Problem-solution format that sells (20-30s).',
    beats: [
      { key: 'ba-01-boring-food', label: '1. Comida Aburrida', order: 1, type: 'context', narrative: 'A plain, boring-looking meal — a basic sandwich with just bread and meat, a plain burger, an empty salad, bland crackers on a plate. Intentionally dull lighting, flat composition. This food NEEDS something. Muted colors, flat angle.' },
      { key: 'ba-02-something-missing', label: '2. Falta Algo', order: 2, type: 'context', narrative: 'Close-up showing the "gap" — the empty space on the plate, the boring side of the sandwich, the missing topping. A hand hovering as if thinking "what should I add?". The problem is clear: this food is incomplete.' },
      { key: 'ba-03-product-solution', label: '3. La Solucion', order: 3, type: 'product', narrative: 'The product ENTERS as the SOLUTION — dramatically placed, well-lit, hero shot. The lighting changes from dull to warm/vibrant. The product is the answer. Centered, powerful, eye-level.' },
      { key: 'ba-04-transformation', label: '4. Transformacion', order: 4, type: 'context', narrative: 'The TRANSFORMATION — the product being added to the food. Pickles placed on the burger, sauce drizzled on the plate, toppings scattered. Dynamic, appetizing, the moment everything changes. Close-up, warm vibrant lighting replaces the dull tone.' },
      { key: 'ba-05-amazing-result', label: '5. Resultado Increible', order: 5, type: 'context', narrative: 'The AMAZING finished result — the same meal now looks STUNNING. Vibrant colors, professional food photography, appetizing angles. Hero shot of the transformed food. The contrast with Beat 1 is dramatic and obvious.' },
      { key: 'ba-06-product-hero', label: '6. Producto Hero', order: 6, type: 'product', narrative: 'Final hero shot — the product next to the amazing finished food. "This product made THAT happen." Brand visible, clean composition, warm premium lighting. Buy this.' }
    ],
    duration: '20-30s',
    style: 'before-after',
    clipDuration: 5
  }
];

// ═══ CAMERA MOTIONS for video generation ═══
const CAMERA_MOTIONS = [
  { key: 'slow-dolly-in', prompt: 'Slow cinematic dolly in toward the subject, smooth camera movement', label: 'Dolly In' },
  { key: 'slow-orbit', prompt: 'Slow 360 orbit around the subject, smooth circular camera movement', label: 'Orbit 360' },
  { key: 'slow-zoom', prompt: 'Slow zoom into details, cinematic focus pull', label: 'Zoom In' },
  { key: 'push-reveal', prompt: 'Slow push forward revealing the subject, cinematic reveal shot', label: 'Push Reveal' },
  { key: 'tilt-up', prompt: 'Slow tilt up from base to top, cinematic vertical movement', label: 'Tilt Up' },
  { key: 'dolly-out', prompt: 'Slow dolly out pulling back from subject, cinematic wide reveal', label: 'Dolly Out' },
  { key: 'handheld', prompt: 'Subtle handheld camera movement, natural gentle sway, lifestyle feel', label: 'Handheld' },
  { key: 'static', prompt: 'Static camera, subtle environmental movement, studio lighting', label: 'Estatico' },
  { key: 'aerial-push', prompt: 'Slow aerial push over landscape, cinematic drone-style movement', label: 'Aerial Push' },
  { key: 'tracking-lateral', prompt: 'Slow lateral tracking shot, smooth sideways camera movement', label: 'Tracking Lateral' },
  { key: 'crane-down', prompt: 'Slow crane movement descending from above, revealing the scene', label: 'Crane Down' },
];

// ═══ IN-MEMORY JOB TRACKER ═══
const shotJobs = new Map();

// ═══ STEP 1: Claude "Director Creativo" — Analyze product + pick scene + design shots ═══

async function analyzeProductAndRecommendScene(productImagePath, productDescription, templateKey) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  const imageBuffer = fs.readFileSync(productImagePath);
  const base64 = imageBuffer.toString('base64');
  const mediaType = getMimeType(productImagePath);

  // Select template (default to classic-12 for backward compat)
  const template = COMMERCIAL_TEMPLATES.find(t => t.key === templateKey) || COMMERCIAL_TEMPLATES[0];
  const templateBeats = template.beats;
  const numBeats = templateBeats.length;

  const scenesListText = AVAILABLE_SCENES.map((s, i) =>
    `${i + 1}. ${s.key} — "${s.label}": ${s.description}`
  ).join('\n');

  const beatsText = templateBeats.map((b) =>
    `${b.order}. ${b.key} [${b.type.toUpperCase()}] — "${b.label}": ${b.narrative}`
  ).join('\n');

  const musicListText = MUSIC_TRACKS.filter(m => m.file).map((m, i) =>
    `${i + 1}. ${m.key} — "${m.label}": ${m.mood}`
  ).join('\n');

  // Build the shot keys JSON example dynamically from the template beats
  const shotsJsonExample = templateBeats.map(b => {
    if (b.type === 'context') {
      return `    "${b.key}": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." }`;
    }
    return `    "${b.key}": { "type": "product", "imagePrompt": "Edit this product photograph. Change ONLY the background...", "videoPrompt": "..." }`;
  }).join(',\n');

  const content = [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 }
    },
    {
      type: 'text',
      text: `You are an expert commercial video director specializing in VERTICAL food product ads for social media (Reels, TikTok, Stories). You create scroll-stopping, appetite-inducing content.

User's product description: "${productDescription}"
Commercial template: "${template.label}" (${template.style} style, ${template.duration})

STEP 1 — Identify the product:
- Exact product name and brand (read the label carefully)
- Product category (pickles, chips, salsa, beverage, snack, sauce, etc.)
- Key visual elements (colors, packaging type, distinguishing features)
- Target audience and brand personality
- IMPORTANT: Identify the main INGREDIENTS of this product by looking at the label, packaging, and product type. List 3-6 key ingredients (e.g., cucumber, dill, vinegar, garlic for pickles).

STEP 2 — Choose the BEST commercial scene:
From the available scenes below, pick the ONE scene that would create the most compelling, authentic commercial for THIS specific product and the "${template.label}" template style. Consider:
- What context would a real customer see this product in?
- What setting makes the product look most appealing and authentic?
- What scene matches the "${template.style}" mood?

Available scenes:
${scenesListText}

STEP 3 — Design ${numBeats} NARRATIVE BEATS for the "${template.label}" template:
This is a ${numBeats}-beat story with TWO types of shots:

**CONTEXT shots** (type: "context") — Generated from SCRATCH using text-to-image (NO product photo).
CRITICAL RULES for context shots:
- Write a COMPLETE, DETAILED descriptive prompt (minimum 2-3 sentences) for an entirely new image
- Be HYPER-SPECIFIC to THIS exact product: name actual ingredients, actual colors, actual textures
- For food products: describe REAL food photography scenarios — actual dishes, actual ingredients, actual cooking steps
- Do NOT be generic. "Beautiful food scene" is BAD. "A thick-cut dill pickle spear being placed on a sizzling Angus beef burger, melted cheddar dripping down, on a rustic wooden cutting board" is GOOD.
- ALWAYS specify: lighting style, camera angle, background, composition, mood
- The image must look like a REAL PHOTOGRAPH shot by a professional food photographer
- Do NOT mention the product name/brand in context shots — just the food, ingredients, and scene

**PRODUCT shots** (type: "product") — Use the product photo as reference.
- Start with "Edit this product photograph. Change ONLY the background and surroundings."
- The product must remain EXACTLY as in the original photo
- Describe a specific, detailed scene around the product

The ${numBeats} beats are:
${beatsText}

STEP 4 — Design ${numBeats} video prompts:
For each beat, write a ${template.clipDuration || 5}-second video motion prompt:
- Describe specific camera movement (dolly in, orbit, crane down, tracking, etc.)
- Include environmental motion specific to the shot (steam rising, liquid dripping, crumbs falling, leaves blowing, condensation forming, etc.)
- For "${template.style}" style: ${template.style === 'fast-paced' ? 'use QUICK, DYNAMIC movements — fast pushes, snap zooms, quick cuts feel' : template.style === 'asmr' ? 'use SLOW, HYPNOTIC movements — very slow dollies, smooth orbits, gentle zooms' : template.style === 'recipe' ? 'use PRACTICAL movements — overhead tracking, close push-ins, hands-level angles' : template.style === 'before-after' ? 'use CONTRASTING movements — static/boring for "before", dynamic/cinematic for "after"' : 'use CINEMATIC movements appropriate to each narrative moment'}
- Keep in English, 1-2 sentences each

STEP 5 — Choose background music:
From the available music tracks below, pick the ONE that best matches the "${template.style}" mood:

Available music tracks:
${musicListText}

STEP 6 — Closing text:
Suggest text for the final frame overlay (2-4 words max) — typically the brand name or tagline.

Return ONLY valid JSON:
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "ingredients": ["ingredient1", "ingredient2", "ingredient3", "ingredient4"],
  "targetAudience": "...",
  "chosenScene": "scene-key",
  "sceneLabel": "Scene Label",
  "sceneReason": "2-3 sentence explanation of why this scene is ideal",
  "narrativeSummary": "One paragraph describing the commercial story arc",
  "templateKey": "${template.key}",
  "videoModel": "grok-imagine-720p",
  "recommendedMusic": "music-track-key",
  "closingText": "Brand Name",
  "shots": {
${shotsJsonExample}
  }
}`
    }
  ];

  logger.info(`[VIDEO-PIPE] Calling Claude Director Creativo (template: ${template.key}) to analyze product and recommend scene...`);

  const response = await anthropic.messages.create({
    model: config.claude.model,
    max_tokens: 8192,
    messages: [{ role: 'user', content }]
  });

  const rawText = response.content[0]?.text || '';

  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (!cleaned.startsWith('{')) {
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    }
  }

  const parsed = JSON.parse(cleaned);
  // Attach template info for downstream use
  parsed.templateKey = template.key;
  parsed.templateLabel = template.label;
  parsed.templateClipDuration = template.clipDuration;

  logger.info(`[VIDEO-PIPE] Claude recommends scene "${parsed.chosenScene}" for ${parsed.brand} ${parsed.productName} (template: ${template.label}): ${parsed.sceneReason}`);

  return parsed;
}

// ═══ STEP 2: Generate shots (async background job) ═══

function startShotGenerationJob(productImagePath, options = {}) {
  const jobId = `shots-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const numShots = options.numShots || 12;

  const job = {
    jobId,
    status: 'running',
    total: numShots,
    completed: 0,
    failed: 0,
    shots: [],
    directorPlan: options.directorPlan || null,
    startedAt: new Date().toISOString(),
    error: null
  };

  shotJobs.set(jobId, job);

  _generateShotsBackground(jobId, productImagePath, options).catch(err => {
    logger.error(`[VIDEO-PIPE] Background job ${jobId} crashed: ${err.message}`);
    const j = shotJobs.get(jobId);
    if (j) { j.status = 'failed'; j.error = err.message; }
  });

  return { jobId, status: 'running', total: numShots };
}

function getShotJobStatus(jobId) {
  const job = shotJobs.get(jobId);
  if (!job) return null;
  return { ...job };
}

async function _generateShotsBackground(jobId, productImagePath, options = {}) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Product image not found: ' + productImagePath);
  }

  const xaiKey = config.xai?.apiKey;
  if (!xaiKey) throw new Error('XAI_API_KEY not configured');

  ensureDir(SHOTS_DIR);
  const productDescription = options.productDescription || 'product';
  const directorPlan = options.directorPlan;
  const job = shotJobs.get(jobId);

  // Encode product image as base64 data URI once (needed for PRODUCT beats)
  const productImageBuffer = fs.readFileSync(productImagePath);
  const productBase64 = productImageBuffer.toString('base64');
  const productMime = getMimeType(productImagePath);
  const productDataUri = `data:${productMime};base64,${productBase64}`;

  // Resolve template beats for label lookup
  const templateKey = directorPlan?.templateKey;
  const template = templateKey ? COMMERCIAL_TEMPLATES.find(t => t.key === templateKey) : null;
  const allBeats = template ? template.beats : SHOT_TYPES;

  // Use director plan shots if available, otherwise fall back to default
  const numShots = options.numShots || allBeats.length;
  const shotKeys = directorPlan
    ? Object.keys(directorPlan.shots).slice(0, numShots)
    : allBeats.slice(0, numShots).map(s => s.key);

  for (let i = 0; i < shotKeys.length; i++) {
    const shotKey = shotKeys[i];
    const shotType = allBeats.find(s => s.key === shotKey) || SHOT_TYPES.find(s => s.key === shotKey);
    const shotLabel = shotType?.label || shotKey;

    // Determine beat type: context (text-to-image) or product (image edit)
    const beatType = directorPlan?.shots?.[shotKey]?.type || shotType?.type || 'product';
    const isContext = beatType === 'context';

    try {
      logger.info(`[VIDEO-PIPE] Job ${jobId}: Generating shot ${i + 1}/${shotKeys.length}: ${shotKey} [${beatType.toUpperCase()}] via xAI Grok Imagine`);

      let resultImageUrl;

      if (isContext) {
        // ── CONTEXT shot: xAI text-to-image (generate from scratch, no product photo) ──
        const contextPrompt = [
          directorPlan?.shots?.[shotKey]?.imagePrompt || `Beautiful ${productDescription} related scene.`,
          '\nVertical 9:16 format.',
          '\nPhotorealistic, high-end commercial photography quality.',
          ' Shot on professional cinema camera, shallow depth of field.',
          ' Natural lighting, rich colors, magazine-quality composition.'
        ].join('');

        const res = await fetch('https://api.x.ai/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
          body: JSON.stringify({
            model: 'grok-imagine-image',
            prompt: contextPrompt,
            n: 1,
            aspect_ratio: '2:3'
          })
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`xAI image gen failed (${res.status}): ${errBody.substring(0, 300)}`);
        }
        const result = await res.json();
        resultImageUrl = result.data?.[0]?.url;
      } else {
        // ── PRODUCT shot: xAI image edit (uses product photo as reference via base64 data URI) ──
        let fullPrompt;
        if (directorPlan?.shots?.[shotKey]?.imagePrompt) {
          fullPrompt = [
            directorPlan.shots[shotKey].imagePrompt,
            `\nThe product is: ${productDescription}.`,
            '\nVertical 9:16 format.',
            '\nThe product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions.',
            ' Do NOT re-render, redraw, or generate a 3D version of the product.',
            ' Keep it as the original flat photographic element.',
            ' Do NOT add lighting effects (rim light, glow, highlights) ON the product.',
            ' Do NOT alter, warp, or reshape the packaging.',
            ' The product should look physically placed in the new scene.',
            ' Photorealistic, high-end commercial product photography quality.'
          ].join('');
        } else {
          fullPrompt = [
            'Edit this product photograph. Change ONLY the background and surroundings.',
            ` ${shotType?.composition || 'Product centered in frame.'}`,
            `\nThe product is: ${productDescription}.`,
            '\nVertical 9:16 format.',
            '\nThe product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions.',
            ' Do NOT re-render, redraw, or generate a 3D version of the product.',
            ' Keep it as the original flat photographic element.',
            ' Photorealistic, high-end commercial product photography quality.'
          ].join('');
        }

        // xAI image edit uses JSON body with image array (not multipart)
        const res = await fetch('https://api.x.ai/v1/images/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
          body: JSON.stringify({
            model: 'grok-imagine-image',
            prompt: fullPrompt,
            image: { url: productDataUri, type: 'image_url' },
            n: 1
          })
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`xAI image edit failed (${res.status}): ${errBody.substring(0, 300)}`);
        }
        const result = await res.json();
        resultImageUrl = result.data?.[0]?.url;
      }

      if (!resultImageUrl) {
        throw new Error('No image URL in xAI Grok Imagine response');
      }

      // Download the generated image and save locally
      const dlRes = await fetch(resultImageUrl);
      if (!dlRes.ok) throw new Error(`Failed to download generated image: HTTP ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      const filename = `shot-${shotKey}-${Date.now()}.png`;
      fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);

      job.shots.push({
        angle: shotKey,
        label: shotLabel,
        type: beatType,
        filename,
        url: `/uploads/video-shots/${filename}`,
        videoPrompt: directorPlan?.shots?.[shotKey]?.videoPrompt || '',
        status: 'completed'
      });
      job.completed++;

      if (i < shotKeys.length - 1) await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      logger.error(`[VIDEO-PIPE] Job ${jobId}: Shot ${shotKey} [${beatType}] failed: ${err.message}`);
      job.shots.push({ angle: shotKey, label: shotLabel, type: beatType, filename: null, url: null, status: 'failed', error: err.message });
      job.failed++;

      if (err.status === 429 || err.message?.includes('429')) {
        logger.warn('[VIDEO-PIPE] Rate limited, waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  job.status = job.failed === job.total ? 'failed' : 'done';
  job.finishedAt = new Date().toISOString();
  logger.info(`[VIDEO-PIPE] Job ${jobId} finished: ${job.completed} ok, ${job.failed} failed`);
}

// ═══ STEP 3: Claude "Quality Judge" — Score each generated shot ═══
// Batches shots in groups of 4 to avoid 413 request_too_large errors

async function judgeShots(shotUrls, productDescription, originalImagePath, directorPlan) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  // Load original product photo once (for reference in PRODUCT shot batches)
  let origImageContent = null;
  if (originalImagePath && fs.existsSync(originalImagePath)) {
    const origBuffer = fs.readFileSync(originalImagePath);
    const origBase64 = origBuffer.toString('base64');
    const origMime = getMimeType(originalImagePath);
    origImageContent = {
      type: 'image',
      source: { type: 'base64', media_type: origMime, data: origBase64 }
    };
  }

  // Split shots into batches of 4
  const BATCH_SIZE = 4;
  const allShots = shotUrls.slice(0, 12);
  const batches = [];
  for (let i = 0; i < allShots.length; i += BATCH_SIZE) {
    batches.push(allShots.slice(i, i + BATCH_SIZE));
  }

  logger.info(`[VIDEO-PIPE] Quality Judge: ${allShots.length} shots in ${batches.length} batches of ${BATCH_SIZE}`);

  const allScores = {};
  let totalScore = 0;
  let scoreCount = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const content = [];

    // Determine types in this batch
    const batchHasProduct = batch.some(s => {
      const beatType = directorPlan?.shots?.[s.angle]?.type || s.type || SHOT_TYPES.find(st => st.key === s.angle)?.type || 'product';
      return beatType === 'product';
    });

    // Include original product photo as reference (only needed when batch has PRODUCT shots)
    if (origImageContent && batchHasProduct) {
      content.push(origImageContent);
      content.push({
        type: 'text',
        text: '↑ ORIGINAL product reference photo (for PRODUCT shots — this is what the product should look like)'
      });
    }

    // Include each shot in this batch with its type
    for (const shot of batch) {
      const filePath = path.join(config.system.uploadsDir, shot.url.replace('/uploads/', ''));
      const beatType = directorPlan?.shots?.[shot.angle]?.type || shot.type || SHOT_TYPES.find(st => st.key === shot.angle)?.type || 'product';
      if (fs.existsSync(filePath)) {
        const imgBuffer = fs.readFileSync(filePath);
        const base64 = imgBuffer.toString('base64');
        const mediaType = getMimeType(filePath);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 }
        });
        content.push({
          type: 'text',
          text: `↑ Shot: "${shot.label}" (key: ${shot.angle}) [TYPE: ${beatType.toUpperCase()}]`
        });
      }
    }

    // Build type-specific criteria info
    const shotKeysInBatch = batch.map(s => s.angle).join(', ');
    const shotTypesInfo = batch.map(s => {
      const beatType = directorPlan?.shots?.[s.angle]?.type || s.type || SHOT_TYPES.find(st => st.key === s.angle)?.type || 'product';
      return `${s.angle}: ${beatType.toUpperCase()}`;
    }).join(', ');

    content.push({
      type: 'text',
      text: `You are a quality control judge for product commercial photography. The product is: "${productDescription}".

Each shot has a TYPE that determines the scoring criteria:

**For PRODUCT shots** (uses product photo as reference):
1. **Label Fidelity (40%)**: Is the product label/text readable, undistorted, and matching the original? Any warping, blurring, or text alteration is a major penalty.
2. **Product Integrity (25%)**: Does the product shape, color, and packaging match the original photo exactly? No reshaping, 3D rendering, or artistic reinterpretation.
3. **Scene Quality (20%)**: Is the background/scene realistic, well-lit, and commercially appealing?
4. **Commercial Value (15%)**: Would this image work as a frame in a real product commercial?

**For CONTEXT shots** (generated from scratch, no product visible):
1. **Realism (40%)**: Does this look like a real photograph? No AI artifacts, no uncanny elements, natural textures and lighting.
2. **Relevance (30%)**: Is this clearly connected to the product/ingredients? Does it make sense in the commercial narrative?
3. **Commercial Quality (20%)**: Would this work in a professional commercial? Magazine-quality composition and lighting.
4. **Continuity (10%)**: Does this flow visually with the rest of the commercial? Consistent color palette and mood.

Shot types in this batch: ${shotTypesInfo}

For each shot, provide:
- score: 1-10 integer
- verdict: "approve" (7-10), "marginal" (5-6), or "reject" (1-4)
- reason: One sentence explaining the score, focusing on the most important issue

Return ONLY valid JSON:
{
  "scores": {
    "shot-key": { "score": 8, "verdict": "approve", "reason": "..." },
    ...for each shot in this batch...
  }
}`
    });

    logger.info(`[VIDEO-PIPE] Quality Judge batch ${b + 1}/${batches.length}: ${shotKeysInBatch}`);

    const response = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content }]
    });

    const rawText = response.content[0]?.text || '';
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    if (!cleaned.startsWith('{')) {
      const jsonStart = cleaned.indexOf('{');
      const jsonEnd = cleaned.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
      }
    }

    const batchResult = JSON.parse(cleaned);

    // Merge batch scores into allScores
    if (batchResult.scores) {
      for (const [key, val] of Object.entries(batchResult.scores)) {
        allScores[key] = val;
        if (val?.score) { totalScore += val.score; scoreCount++; }
      }
    }

    // Small delay between batches
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  const overallAverage = scoreCount > 0 ? Math.round((totalScore / scoreCount) * 10) / 10 : 0;
  const approved = Object.values(allScores).filter(s => s?.verdict === 'approve').length;
  const rejected = Object.values(allScores).filter(s => s?.verdict === 'reject').length;
  const summary = `${approved} aprobados, ${Object.values(allScores).length - approved - rejected} marginales, ${rejected} rechazados de ${scoreCount} evaluados`;

  logger.info(`[VIDEO-PIPE] Quality Judge complete: avg ${overallAverage}/10 — ${summary}`);

  return { scores: allScores, overallAverage, summary };
}

// ═══ STEP 4: Regenerate a single shot ═══

async function regenerateSingleShot(productImagePath, shotKey, imagePrompt, productDescription, beatType) {
  const xaiKey = config.xai?.apiKey;
  if (!xaiKey) throw new Error('XAI_API_KEY not configured');

  ensureDir(SHOTS_DIR);

  // Determine beat type from param, or from NARRATIVE_BEATS definition
  const shotType = SHOT_TYPES.find(s => s.key === shotKey);
  const isContext = (beatType || shotType?.type || 'product') === 'context';

  logger.info(`[VIDEO-PIPE] Regenerating shot: ${shotKey} [${isContext ? 'CONTEXT' : 'PRODUCT'}] via xAI Grok Imagine`);

  let resultImageUrl;

  if (isContext) {
    // CONTEXT: xAI text-to-image from scratch
    const contextPrompt = [
      imagePrompt,
      '\nVertical 9:16 format.',
      '\nPhotorealistic, high-end commercial photography quality.',
      ' Shot on professional cinema camera, shallow depth of field.',
      ' Natural lighting, rich colors, magazine-quality composition.'
    ].join('');

    const res = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: contextPrompt,
        n: 1,
        aspect_ratio: '2:3'
      })
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`xAI image gen failed (${res.status}): ${errBody.substring(0, 300)}`);
    }
    const result = await res.json();
    resultImageUrl = result.data?.[0]?.url;
  } else {
    // PRODUCT: xAI image edit with product photo (base64 data URI)
    const imageBuffer = fs.readFileSync(productImagePath);
    const base64 = imageBuffer.toString('base64');
    const mime = getMimeType(productImagePath);
    const dataUri = `data:${mime};base64,${base64}`;

    const fullPrompt = [
      imagePrompt,
      `\nThe product is: ${productDescription}.`,
      '\nVertical 9:16 format.',
      '\nThe product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions.',
      ' Do NOT re-render, redraw, or generate a 3D version of the product.',
      ' Keep it as the original flat photographic element.',
      ' Do NOT add lighting effects (rim light, glow, highlights) ON the product.',
      ' Do NOT alter, warp, or reshape the packaging.',
      ' The product should look physically placed in the new scene.',
      ' Photorealistic, high-end commercial product photography quality.'
    ].join('');

    const res = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: fullPrompt,
        image: { url: dataUri, type: 'image_url' },
        n: 1
      })
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`xAI image edit failed (${res.status}): ${errBody.substring(0, 300)}`);
    }
    const result = await res.json();
    resultImageUrl = result.data?.[0]?.url;
  }

  if (!resultImageUrl) {
    throw new Error('No image URL in xAI Grok Imagine response');
  }

  // Download the generated image and save locally
  const dlRes = await fetch(resultImageUrl);
  if (!dlRes.ok) throw new Error(`Failed to download generated image: HTTP ${dlRes.status}`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  const filename = `shot-${shotKey}-${Date.now()}.png`;
  fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);

  return {
    angle: shotKey,
    label: shotType?.label || shotKey,
    type: isContext ? 'context' : 'product',
    filename,
    url: `/uploads/video-shots/${filename}`,
    status: 'completed'
  };
}

// ═══ STEP 5: Generate Video — Multi-provider: xAI Grok Imagine + OpenAI Sora 2 ═══

function _getXaiKey() {
  const xaiKey = config.xai?.apiKey;
  if (!xaiKey) throw new Error('XAI_API_KEY not configured — set XAI_API_KEY env var');
  return xaiKey;
}

function _getOpenaiKey() {
  const key = config.imageGen?.openai?.apiKey;
  if (!key) throw new Error('OPENAI_API_KEY not configured — set OPENAI_API_KEY env var');
  return key;
}

// Resolve local /uploads/ image URL to a local file path
function _resolveLocalImage(imageUrl) {
  const uploadsMatch = imageUrl?.match(/\/uploads\/video-shots\/(.+)$/);
  if (uploadsMatch) {
    const localPath = path.join(SHOTS_DIR, uploadsMatch[1]);
    if (fs.existsSync(localPath)) return localPath;
  }
  return null;
}

// ── Router: picks provider based on videoModel ──

async function submitVideoJob(imageUrl, options = {}) {
  const videoModel = options.videoModel || DEFAULT_VIDEO_MODEL;
  const modelConfig = VIDEO_MODELS[videoModel] || VIDEO_MODELS[DEFAULT_VIDEO_MODEL];

  if (modelConfig.provider === 'openai') {
    return _submitSoraVideoJob(imageUrl, options, modelConfig);
  }
  return _submitXaiVideoJob(imageUrl, options, modelConfig);
}

async function checkVideoStatus(requestId, videoModel) {
  const modelKey = videoModel || DEFAULT_VIDEO_MODEL;
  const modelConfig = VIDEO_MODELS[modelKey] || VIDEO_MODELS[DEFAULT_VIDEO_MODEL];

  if (modelConfig.provider === 'openai') {
    return _checkSoraVideoStatus(requestId);
  }
  return _checkXaiVideoStatus(requestId);
}

// ── xAI Grok Imagine Video ──

async function _submitXaiVideoJob(imageUrl, options = {}, modelConfig) {
  const xaiKey = _getXaiKey();

  const {
    cameraMotion = 'slow-dolly-in',
    duration = 5,
    aspectRatio = '9:16'
  } = options;

  const motion = CAMERA_MOTIONS.find(m => m.key === cameraMotion) || CAMERA_MOTIONS[0];
  const prompt = options.prompt || `${motion.prompt}, professional product commercial, cinematic quality, studio lighting, 4K`;

  const body = {
    model: 'grok-imagine-video',
    prompt,
    duration: Math.max(1, Math.min(10, Math.round(duration))),
    aspect_ratio: aspectRatio,
    resolution: modelConfig.resolution || '720p'
  };

  // Add image for image-to-video — prefer base64 data URI for reliability
  if (imageUrl) {
    let resolvedImageUrl = imageUrl;
    const localPath = _resolveLocalImage(imageUrl);
    if (localPath) {
      const imgBuffer = fs.readFileSync(localPath);
      const mime = getMimeType(localPath);
      resolvedImageUrl = `data:${mime};base64,${imgBuffer.toString('base64')}`;
      logger.info(`[VIDEO-PIPE] xAI: Converted local image to base64 (${(imgBuffer.length / 1024).toFixed(0)}KB)`);
    }
    body.image = { url: resolvedImageUrl };
  }

  logger.info(`[VIDEO-PIPE] xAI submit: imageType=${body.image?.url?.startsWith('data:') ? 'base64' : 'url'}, duration=${body.duration}, resolution=${body.resolution}`);

  const res = await fetch('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`xAI video gen failed (${res.status}): ${errBody.substring(0, 300)}`);
  }

  const result = await res.json();
  const requestId = result.request_id || result.response_id || result.id;

  logger.info(`[VIDEO-PIPE] xAI job queued: ${requestId} (${body.duration}s, $${(body.duration * modelConfig.costPerSec).toFixed(3)})`);
  return { requestId, status: 'queued', cameraMotion: motion.key, videoModel: modelConfig.key };
}

async function _checkXaiVideoStatus(requestId) {
  const xaiKey = _getXaiKey();

  let res;
  try {
    res = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${xaiKey}` }
    });
  } catch (err) {
    logger.error(`[VIDEO-PIPE] xAI network error: ${err.message}`);
    return { requestId, status: 'failed', error: `Network error: ${err.message}` };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    logger.warn(`[VIDEO-PIPE] xAI status check failed (${res.status}) for ${requestId}: ${errBody.substring(0, 200)}`);
    if (res.status === 404 || res.status === 410) {
      return { requestId, status: 'failed', error: `Request not found (${res.status})` };
    }
    return { requestId, status: 'failed', error: `Status check failed (${res.status})` };
  }

  const result = await res.json();
  logger.info(`[VIDEO-PIPE] xAI status for ${requestId}: ${JSON.stringify(result)}`);

  if (result.video?.url) {
    return { requestId, status: 'completed', videoUrl: result.video.url };
  }
  if (result.status === 'done') {
    return { requestId, status: 'completed', videoUrl: null };
  }
  if (result.status === 'expired') {
    return { requestId, status: 'failed', error: 'Video generation request expired' };
  }
  return { requestId, status: 'processing' };
}

// ── OpenAI Sora 2 / Sora 2 Pro ──

async function _submitSoraVideoJob(imageUrl, options = {}, modelConfig) {
  const openaiKey = _getOpenaiKey();

  const {
    cameraMotion = 'slow-dolly-in',
    duration = 5
  } = options;

  const motion = CAMERA_MOTIONS.find(m => m.key === cameraMotion) || CAMERA_MOTIONS[0];
  const prompt = options.prompt || `${motion.prompt}, professional product commercial, cinematic quality, studio lighting, 4K`;

  // Sora accepts seconds as string: "5", "8", "10", "12", "15", "20"
  // Snap to nearest supported value
  const validSeconds = [5, 8, 10, 12, 15, 20];
  const sec = validSeconds.reduce((prev, curr) => Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev);

  // Sora uses 9:16 vertical: "720x1280" (width x height)
  const soraSize = modelConfig.soraSize || '720x1280';

  // Build multipart form data using Node's built-in FormData (Node 18+)
  const { FormData, Blob } = await import('node:buffer').then(() => ({ FormData: globalThis.FormData, Blob: globalThis.Blob }));
  const formData = new FormData();
  formData.append('model', modelConfig.key); // 'sora-2-pro' or 'sora-2'
  formData.append('prompt', prompt);
  formData.append('size', soraSize);
  formData.append('seconds', String(sec));

  // Add image for image-to-video
  if (imageUrl) {
    const localPath = _resolveLocalImage(imageUrl);
    if (localPath) {
      const imgBuffer = fs.readFileSync(localPath);
      const mime = getMimeType(localPath);
      const ext = path.extname(localPath).replace('.', '') || 'png';
      const blob = new Blob([imgBuffer], { type: mime });
      formData.append('input_reference', blob, `image.${ext}`);
      logger.info(`[VIDEO-PIPE] Sora: Attached local image (${(imgBuffer.length / 1024).toFixed(0)}KB, ${mime})`);
    } else {
      logger.warn(`[VIDEO-PIPE] Sora: Could not resolve local image for "${imageUrl}", sending text-only`);
    }
  }

  logger.info(`[VIDEO-PIPE] Sora submit: model=${modelConfig.key}, size=${soraSize}, seconds=${sec}, hasImage=${!!imageUrl}`);

  const res = await fetch('https://api.openai.com/v1/videos', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}` },
    body: formData
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Sora video gen failed (${res.status}): ${errBody.substring(0, 400)}`);
  }

  const result = await res.json();
  const requestId = result.id;

  logger.info(`[VIDEO-PIPE] Sora job queued: ${requestId} (${sec}s, $${(sec * modelConfig.costPerSec).toFixed(3)})`);
  return { requestId, status: 'queued', cameraMotion: motion.key, videoModel: modelConfig.key };
}

async function _checkSoraVideoStatus(requestId) {
  const openaiKey = _getOpenaiKey();

  let res;
  try {
    res = await fetch(`https://api.openai.com/v1/videos/${requestId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${openaiKey}` }
    });
  } catch (err) {
    logger.error(`[VIDEO-PIPE] Sora network error: ${err.message}`);
    return { requestId, status: 'failed', error: `Network error: ${err.message}` };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    logger.warn(`[VIDEO-PIPE] Sora status check failed (${res.status}) for ${requestId}: ${errBody.substring(0, 200)}`);
    if (res.status === 404) {
      return { requestId, status: 'failed', error: `Sora job not found (${res.status})` };
    }
    return { requestId, status: 'failed', error: `Sora status check failed (${res.status})` };
  }

  const result = await res.json();
  logger.info(`[VIDEO-PIPE] Sora status for ${requestId}: status=${result.status}, progress=${result.progress || 0}`);

  if (result.status === 'completed') {
    // Download the actual video content from /videos/{id}/content
    const videoUrl = await _downloadSoraVideo(requestId, openaiKey);
    return { requestId, status: 'completed', videoUrl };
  }

  if (result.status === 'failed') {
    return { requestId, status: 'failed', error: result.error?.message || 'Sora generation failed' };
  }

  // 'queued' or 'in_progress' — keep polling
  return { requestId, status: 'processing' };
}

async function _downloadSoraVideo(videoId, openaiKey) {
  ensureDir(VIDEOS_DIR);
  const outputPath = path.join(VIDEOS_DIR, `sora-${videoId}.mp4`);

  // If already downloaded, return cached
  if (fs.existsSync(outputPath)) {
    logger.info(`[VIDEO-PIPE] Sora: Using cached download for ${videoId}`);
    return `/uploads/video-clips/sora-${videoId}.mp4`;
  }

  logger.info(`[VIDEO-PIPE] Sora: Downloading video ${videoId}...`);
  const res = await fetch(`https://api.openai.com/v1/videos/${videoId}/content`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${openaiKey}` },
    redirect: 'follow'
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Sora download failed (${res.status}): ${errBody.substring(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  logger.info(`[VIDEO-PIPE] Sora: Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${outputPath}`);

  return `/uploads/video-clips/sora-${videoId}.mp4`;
}

async function submitVideoBatch(shots, options = {}) {
  const results = [];
  const batchSize = 3;

  for (let i = 0; i < shots.length; i += batchSize) {
    const batch = shots.slice(i, i + batchSize);

    const promises = batch.map(async (shot) => {
      try {
        logger.info(`[VIDEO-PIPE] Submitting clip: ${shot.angle} → ${shot.imageUrl?.substring(0, 80)}...`);
        const result = await submitVideoJob(shot.imageUrl, {
          cameraMotion: shot.cameraMotion || options.cameraMotion,
          duration: shot.duration || options.duration,
          aspectRatio: shot.aspectRatio || options.aspectRatio,
          prompt: shot.prompt || options.prompt,
          videoModel: shot.videoModel || options.videoModel || DEFAULT_VIDEO_MODEL
        });
        return { shotAngle: shot.angle, imageUrl: shot.imageUrl, ...result };
      } catch (err) {
        const detail = err.body || err.data || err.detail || '';
        logger.error(`[VIDEO-PIPE] Clip submit FAILED for ${shot.angle}: ${err.message} | status=${err.status || err.statusCode || 'N/A'} | detail=${JSON.stringify(detail)}`, { imageUrl: shot.imageUrl, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
        return { shotAngle: shot.angle, imageUrl: shot.imageUrl, requestId: null, status: 'error', error: err.message };
      }
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    if (i + batchSize < shots.length) await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

// ═══ STEP 7: Stitch clips into ONE commercial video via FFmpeg ═══
// Now with: crossfade transitions, background music, closing text overlay

const stitchJobs = new Map();

/**
 * Start a stitch job with optional production enhancements
 * @param {string[]} clipUrls - Array of video clip URLs
 * @param {Object} options - Production options
 * @param {string} options.musicTrack - Key from MUSIC_TRACKS (default 'none')
 * @param {string} options.brandText - Text overlay for closing frame (default '')
 * @param {number} options.crossfadeDuration - Crossfade duration in seconds (default 0.5)
 */
function startStitchJob(clipUrls, options = {}) {
  const jobId = `stitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    status: 'running',
    totalClips: clipUrls.length,
    downloaded: 0,
    error: null,
    outputUrl: null,
    musicTrack: options.musicTrack || 'none',
    brandText: options.brandText || '',
    startedAt: new Date().toISOString()
  };
  stitchJobs.set(jobId, job);

  _stitchBackground(jobId, clipUrls, options).catch(err => {
    logger.error(`[VIDEO-PIPE] Stitch job ${jobId} crashed: ${err.message}`);
    const j = stitchJobs.get(jobId);
    if (j) { j.status = 'failed'; j.error = err.message; }
  });

  return { jobId, status: 'running', totalClips: clipUrls.length };
}

function getStitchJobStatus(jobId) {
  const job = stitchJobs.get(jobId);
  if (!job) return null;
  return { ...job };
}

function getAvailableMusicTracks() {
  return MUSIC_TRACKS;
}

/** Get the FFmpeg binary path */
function _getFFmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) return ffmpegStatic;
  } catch (_) {}
  return 'ffmpeg';
}

async function _stitchBackground(jobId, clipUrls, options = {}) {
  ensureDir(FINALS_DIR);
  const job = stitchJobs.get(jobId);
  const tmpDir = path.join(FINALS_DIR, `tmp-${jobId}`);
  ensureDir(tmpDir);

  const crossfadeDuration = options.crossfadeDuration ?? 0.5;
  const musicKey = options.musicTrack || 'none';
  const brandText = options.brandText || '';
  const ffmpegPath = _getFFmpegPath();

  // ── Step A: Download all clip videos ──
  const localFiles = [];
  for (let i = 0; i < clipUrls.length; i++) {
    const url = clipUrls[i];
    const localPath = path.join(tmpDir, `clip-${String(i).padStart(2, '0')}.mp4`);
    try {
      logger.info(`[VIDEO-PIPE] Stitch ${jobId}: Downloading clip ${i + 1}/${clipUrls.length}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      localFiles.push(localPath);
      job.downloaded++;
    } catch (err) {
      logger.error(`[VIDEO-PIPE] Stitch ${jobId}: Failed to download clip ${i}: ${err.message}`);
      throw new Error(`Failed to download clip ${i + 1}: ${err.message}`);
    }
  }

  // ── Step B: Probe each clip to get exact duration ──
  const clipDurations = [];
  for (const f of localFiles) {
    const dur = await _probeClipDuration(ffmpegPath, f);
    clipDurations.push(dur);
  }

  const outputFilename = `commercial-${Date.now()}.mp4`;
  const outputPath = path.join(FINALS_DIR, outputFilename);

  // ── Step C: Build FFmpeg filter graph with xfade crossfades ──
  const n = localFiles.length;

  if (n < 2) {
    // Single clip — just copy it (no crossfade possible)
    fs.copyFileSync(localFiles[0], outputPath);
  } else {
    // Build xfade chain for N clips
    // First normalize all video streams to same pixel format for xfade compatibility
    const inputs = localFiles.map((f) => ['-i', f]).flat();
    const filterParts = [];

    // Normalize each clip to yuv420p (video models may output different pixel formats)
    for (let i = 0; i < n; i++) {
      filterParts.push(`[${i}:v]format=yuv420p,setpts=PTS-STARTPTS[vin${i}]`);
    }

    // Chain xfade transitions
    let prevLabel = '[vin0]';
    let cumulativeOffset = 0;

    for (let i = 1; i < n; i++) {
      const offset = cumulativeOffset + clipDurations[i - 1] - crossfadeDuration;
      const outLabel = i < n - 1 ? `[v${i}]` : '[vout]';
      filterParts.push(`${prevLabel}[vin${i}]xfade=transition=fade:duration=${crossfadeDuration}:offset=${offset.toFixed(3)}${outLabel}`);
      prevLabel = outLabel;
      cumulativeOffset = offset;
    }

    // Calculate total video duration (accounting for crossfades)
    const totalDuration = clipDurations.reduce((s, d) => s + d, 0) - (n - 1) * crossfadeDuration;

    // NOTE: Grok Imagine Video can generate native audio, but we use our own
    // music track as sole audio for consistency, or generate silence.

    // ── Step D: Closing text overlay on last seconds ──
    let videoFinal = '[vout]';
    if (brandText) {
      const textStart = Math.max(0, totalDuration - clipDurations[n - 1]);
      const escapedText = brandText.replace(/'/g, "'\\''").replace(/:/g, '\\:');
      filterParts.push(
        `[vout]drawtext=text='${escapedText}':fontsize=72:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2:enable='gte(t\\,${textStart.toFixed(2)})'` +
        `:alpha='if(lt(t\\,${(textStart + 0.8).toFixed(2)})\\,(t-${textStart.toFixed(2)})/0.8\\,1)'[vtxt]`
      );
      videoFinal = '[vtxt]';
    }

    // ── Step E: Audio — music track or silence ──
    let audioFinal = null;
    const musicTrack = MUSIC_TRACKS.find(m => m.key === musicKey);
    const musicFilePath = musicTrack?.file ? path.join(MUSIC_DIR, musicTrack.file) : null;
    let extraInputs = [];

    if (musicFilePath && fs.existsSync(musicFilePath)) {
      const musicIdx = n; // next input index after all video clips
      extraInputs = ['-i', musicFilePath];
      // Trim music to total duration, set volume, fade in at start, fade out at end
      filterParts.push(
        `[${musicIdx}:a]atrim=0:${totalDuration.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.35,afade=t=in:ss=0:d=2,afade=t=out:st=${Math.max(0, totalDuration - 3).toFixed(2)}:d=3[aout]`
      );
      audioFinal = '[aout]';
    } else {
      // No music selected — generate silent audio track with fixed duration
      extraInputs = ['-f', 'lavfi', '-t', totalDuration.toFixed(2), '-i', `anullsrc=r=44100:cl=stereo`];
      audioFinal = `[${n}:a]`;
    }

    // ── Step F: Execute FFmpeg ──
    const filterComplex = filterParts.join(';');
    const args = [
      ...inputs,
      ...extraInputs,
      '-filter_complex', filterComplex,
      '-map', videoFinal, '-map', audioFinal,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath
    ];

    logger.info(`[VIDEO-PIPE] Stitch ${jobId}: Running FFmpeg with xfade crossfades + music + text...`);
    logger.info(`[VIDEO-PIPE] Stitch ${jobId}: Clip durations: [${clipDurations.map(d => d.toFixed(2)).join(', ')}], total=${totalDuration.toFixed(2)}s`);
    logger.info(`[VIDEO-PIPE] Stitch ${jobId}: Filter graph: ${filterComplex}`);

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // Log the FULL stderr for debugging, send last meaningful part to client
          const fullErr = stderr || err.message || '';
          logger.error(`[VIDEO-PIPE] FFmpeg FULL stderr:\n${fullErr}`);
          // Find the actual error line (usually after the last "Error" or at the end)
          const lines = fullErr.split('\n').filter(l => l.trim());
          const errorLines = lines.filter(l => /error|invalid|failed|no such/i.test(l));
          const errMsg = errorLines.length > 0 ? errorLines.slice(-3).join(' | ') : lines.slice(-3).join(' | ');
          reject(new Error(`FFmpeg error: ${errMsg.substring(0, 500)}`));
        } else {
          resolve();
        }
      });
    });
  }

  // ── Step G: Cleanup temp files ──
  try {
    for (const f of localFiles) fs.unlinkSync(f);
    fs.rmdirSync(tmpDir, { recursive: true });
  } catch (_) { /* ignore cleanup errors */ }

  job.status = 'done';
  job.outputUrl = `/uploads/video-finals/${outputFilename}`;
  job.outputFilename = outputFilename;
  job.finishedAt = new Date().toISOString();
  logger.info(`[VIDEO-PIPE] Stitch ${jobId} completed: ${outputFilename}`);
}

/** Probe a video file's duration using ffprobe (via ffmpeg -i) */
function _probeClipDuration(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    // Use ffmpeg -i to get duration from stderr output
    execFile(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { timeout: 15000 }, (err, stdout, stderr) => {
      const combined = (stderr || '') + (stdout || '');
      const match = combined.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1]);
        const mins = parseInt(match[2]);
        const secs = parseInt(match[3]);
        const frac = parseInt(match[4]) / 100;
        resolve(hours * 3600 + mins * 60 + secs + frac);
      } else {
        // Fallback: assume 5 seconds per clip
        logger.warn(`[VIDEO-PIPE] Could not probe duration of ${filePath}, defaulting to 5s`);
        resolve(5);
      }
    });
  });
}

// ═══ ONE-CLICK AUTO-GENERATE — Full pipeline orchestration ═══
// Orchestrates: Claude Director → Generate shots → Submit video clips → Poll → Auto-stitch

const autoGenerateJobs = new Map();

function startAutoGenerateJob(productImagePath, options = {}) {
  const jobId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    status: 'running',
    phase: 'director',
    phaseLabel: 'Claude Director analizando producto...',
    progress: 0,
    directorPlan: null,
    shotsGenerated: 0,
    shotsTotal: 0,
    clipsSubmitted: 0,
    clipsCompleted: 0,
    clipsTotal: 0,
    stitchStatus: null,
    finalVideoUrl: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
  autoGenerateJobs.set(jobId, job);

  _autoGenerateBackground(jobId, productImagePath, options).catch(err => {
    logger.error(`[VIDEO-PIPE] Auto-generate job ${jobId} crashed: ${err.message}`);
    const j = autoGenerateJobs.get(jobId);
    if (j) { j.status = 'failed'; j.error = err.message; j.finishedAt = new Date().toISOString(); }
  });

  return { jobId, status: 'running' };
}

function getAutoGenerateJobStatus(jobId) {
  const job = autoGenerateJobs.get(jobId);
  if (!job) return null;
  return { ...job };
}

async function _autoGenerateBackground(jobId, productImagePath, options = {}) {
  const job = autoGenerateJobs.get(jobId);
  const {
    productDescription = 'packaged food product',
    templateKey = 'quick-cut-food',
    musicTrack = 'none',
    brandText = '',
    crossfadeDuration = 0.5,
    videoModel = DEFAULT_VIDEO_MODEL
  } = options;

  try {
    // ── PHASE 1: Claude Director Creativo ──
    job.phase = 'director';
    job.phaseLabel = 'Claude Director analizando producto...';
    job.progress = 5;
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Phase 1 — Claude Director (template: ${templateKey})`);

    const directorPlan = await analyzeProductAndRecommendScene(productImagePath, productDescription, templateKey);
    job.directorPlan = directorPlan;
    job.progress = 15;

    // Use recommended music/text from director if not overridden
    const finalMusic = musicTrack !== 'none' ? musicTrack : (directorPlan.recommendedMusic || 'none');
    const finalBrandText = brandText || directorPlan.closingText || '';

    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Director recommends scene="${directorPlan.chosenScene}", music="${finalMusic}", text="${finalBrandText}"`);

    // ── PHASE 2: Generate static shots ──
    const template = COMMERCIAL_TEMPLATES.find(t => t.key === templateKey) || COMMERCIAL_TEMPLATES[0];
    const numShots = template.beats.length;
    job.phase = 'shots';
    job.phaseLabel = `Generando ${numShots} imagenes con Grok Imagine...`;
    job.shotsTotal = numShots;
    job.progress = 20;
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Phase 2 — Generating ${numShots} shots`);

    const shotResult = startShotGenerationJob(productImagePath, {
      productDescription,
      numShots,
      directorPlan
    });

    // Poll shot generation until done
    let shotsDone = false;
    let shotJobData = null;
    while (!shotsDone) {
      await new Promise(r => setTimeout(r, 5000));
      shotJobData = getShotJobStatus(shotResult.jobId);
      if (!shotJobData) throw new Error('Shot job disappeared');
      job.shotsGenerated = shotJobData.completed || 0;
      job.progress = 20 + Math.round((job.shotsGenerated / numShots) * 30); // 20-50%
      job.phaseLabel = `Generando imagenes: ${job.shotsGenerated}/${numShots}...`;

      if (shotJobData.status === 'done' || shotJobData.status === 'failed') {
        shotsDone = true;
      }
    }

    const completedShots = (shotJobData.shots || []).filter(s => s.status === 'completed');
    if (completedShots.length < 2) {
      throw new Error(`Solo ${completedShots.length} imagenes se generaron exitosamente. Se necesitan al menos 2.`);
    }

    logger.info(`[VIDEO-PIPE] Auto ${jobId}: ${completedShots.length} shots generated successfully`);

    // ── PHASE 3: Submit video clips ──
    const clipDuration = template.clipDuration || 3;
    job.phase = 'clips';
    job.clipsTotal = completedShots.length;
    job.phaseLabel = `Generando ${completedShots.length} video clips...`;
    job.progress = 55;
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Phase 3 — Submitting ${completedShots.length} video clips (${clipDuration}s each)`);

    const shotsForBatch = completedShots.map(shot => ({
      imageUrl: shot.url, // local /uploads/ URL — submitVideoJob will convert to base64
      angle: shot.angle,
      cameraMotion: 'slow-dolly-in',
      prompt: directorPlan.shots?.[shot.angle]?.videoPrompt || `Cinematic food commercial shot, professional quality, ${clipDuration} seconds`
    }));

    const selectedModel = VIDEO_MODELS[videoModel] || VIDEO_MODELS[DEFAULT_VIDEO_MODEL];
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Using video model: ${selectedModel.label} (${selectedModel.provider})`);

    const batchResults = await submitVideoBatch(shotsForBatch, {
      duration: clipDuration,
      videoModel
    });

    job.clipsSubmitted = batchResults.filter(r => r.status === 'queued').length;
    const activeClips = batchResults.filter(r => r.requestId && r.status !== 'error');
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: ${job.clipsSubmitted} clips submitted, ${batchResults.filter(r => r.status === 'error').length} errors`);

    if (activeClips.length < 2) {
      throw new Error(`Solo ${activeClips.length} clips fueron enviados exitosamente. Se necesitan al menos 2.`);
    }

    // ── PHASE 4: Poll video clips until all done ──
    job.phase = 'clips-polling';
    job.phaseLabel = `Esperando ${activeClips.length} video clips...`;
    job.progress = 60;
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Phase 4 — Polling ${activeClips.length} clips`);

    const maxPollTime = 10 * 60 * 1000; // 10 minutes max
    const pollStart = Date.now();
    let allClipsDone = false;
    let clipStatuses = activeClips.map(c => ({ ...c }));

    while (!allClipsDone && (Date.now() - pollStart) < maxPollTime) {
      await new Promise(r => setTimeout(r, 15000));

      const pendingIds = clipStatuses
        .filter(c => c.status === 'queued' || c.status === 'processing')
        .map(c => c.requestId)
        .filter(Boolean);

      if (pendingIds.length === 0) { allClipsDone = true; break; }

      for (const id of pendingIds) {
        try {
          const status = await checkVideoStatus(id, videoModel);
          const idx = clipStatuses.findIndex(c => c.requestId === id);
          if (idx >= 0) clipStatuses[idx] = { ...clipStatuses[idx], ...status };
        } catch (err) {
          logger.warn(`[VIDEO-PIPE] Auto ${jobId}: Clip status check error for ${id}: ${err.message}`);
        }
      }

      const completed = clipStatuses.filter(c => c.status === 'completed').length;
      const failed = clipStatuses.filter(c => c.status === 'failed' || c.status === 'error').length;
      job.clipsCompleted = completed;
      job.progress = 60 + Math.round((completed / activeClips.length) * 25); // 60-85%
      job.phaseLabel = `Video clips: ${completed}/${activeClips.length} listos${failed > 0 ? `, ${failed} fallidos` : ''}...`;

      const stillPending = clipStatuses.filter(c => c.status === 'queued' || c.status === 'processing');
      if (stillPending.length === 0) allClipsDone = true;
    }

    const completedClipUrls = clipStatuses
      .filter(c => c.status === 'completed' && c.videoUrl)
      .map(c => c.videoUrl);

    if (completedClipUrls.length < 2) {
      throw new Error(`Solo ${completedClipUrls.length} video clips completados. Se necesitan al menos 2 para crear el comercial.`);
    }

    logger.info(`[VIDEO-PIPE] Auto ${jobId}: ${completedClipUrls.length} clips completed`);

    // ── PHASE 5: Stitch into final commercial ──
    job.phase = 'stitching';
    job.phaseLabel = `Ensamblando video comercial (${completedClipUrls.length} clips)...`;
    job.progress = 88;
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: Phase 5 — Stitching ${completedClipUrls.length} clips, music="${finalMusic}", text="${finalBrandText}"`);

    const stitchResult = startStitchJob(completedClipUrls, {
      musicTrack: finalMusic,
      brandText: finalBrandText,
      crossfadeDuration
    });

    // Poll stitch until done
    let stitchDone = false;
    while (!stitchDone) {
      await new Promise(r => setTimeout(r, 5000));
      const stitchData = getStitchJobStatus(stitchResult.jobId);
      if (!stitchData) throw new Error('Stitch job disappeared');
      job.stitchStatus = stitchData.status;
      job.progress = 90;

      if (stitchData.status === 'done') {
        stitchDone = true;
        job.finalVideoUrl = stitchData.outputUrl;
        job.progress = 100;
      } else if (stitchData.status === 'failed') {
        throw new Error(`Stitch failed: ${stitchData.error || 'unknown error'}`);
      }
    }

    job.status = 'done';
    job.phase = 'complete';
    job.phaseLabel = 'Video comercial listo!';
    job.finishedAt = new Date().toISOString();
    logger.info(`[VIDEO-PIPE] Auto ${jobId}: COMPLETE — Final video: ${job.finalVideoUrl}`);

  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    logger.error(`[VIDEO-PIPE] Auto ${jobId}: FAILED at phase "${job.phase}": ${err.message}`);
    throw err;
  }
}

module.exports = {
  AVAILABLE_SCENES,
  SHOT_TYPES,
  NARRATIVE_BEATS,
  COMMERCIAL_TEMPLATES,
  CAMERA_MOTIONS,
  MUSIC_TRACKS,
  BEAT_TYPES,
  VIDEO_MODELS,
  DEFAULT_VIDEO_MODEL,
  analyzeProductAndRecommendScene,
  startShotGenerationJob,
  getShotJobStatus,
  judgeShots,
  regenerateSingleShot,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch,
  startStitchJob,
  getStitchJobStatus,
  getAvailableMusicTracks,
  startAutoGenerateJob,
  getAutoGenerateJobStatus
};
