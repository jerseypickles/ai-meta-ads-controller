/**
 * Video Pipeline — "Director Creativo" Mode v8 — Grok Imagine Direct API
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. Claude Vision analyzes product → detects ingredients → recommends best commercial scene → designs 12 NARRATIVE BEATS (hybrid CONTEXT + PRODUCT story arc)
 *   3. Grok Imagine generates shots via xAI API: CONTEXT via text-to-image, PRODUCT via image edit
 *   4. Claude Vision judges each shot quality with type-specific criteria (1-10 score + feedback)
 *   5. User reviews storyboard with scores, can regenerate low-scoring shots
 *   6. Grok Imagine Video converts each approved shot to a 6-15s video clip (720p, native audio) via xAI API
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

// ═══ VIDEO MODEL OPTIONS — Grok Imagine Video via xAI API ═══
const VIDEO_MODELS = {
  'grok-imagine-720p': { key: 'grok-imagine-720p', label: 'Grok Imagine 720p', resolution: '720p', costPerSec: 0.07, recommended: true },
  'grok-imagine-480p': { key: 'grok-imagine-480p', label: 'Grok Imagine 480p', resolution: '480p', costPerSec: 0.05, recommended: false }
};

const DEFAULT_VIDEO_MODEL = 'grok-imagine-720p';

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

async function analyzeProductAndRecommendScene(productImagePath, productDescription) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  const imageBuffer = fs.readFileSync(productImagePath);
  const base64 = imageBuffer.toString('base64');
  const mediaType = getMimeType(productImagePath);

  const scenesListText = AVAILABLE_SCENES.map((s, i) =>
    `${i + 1}. ${s.key} — "${s.label}": ${s.description}`
  ).join('\n');

  const beatsText = NARRATIVE_BEATS.map((b) =>
    `${b.order}. ${b.key} [${b.type.toUpperCase()}] — "${b.label}": ${b.narrative}`
  ).join('\n');

  const musicListText = MUSIC_TRACKS.filter(m => m.file).map((m, i) =>
    `${i + 1}. ${m.key} — "${m.label}": ${m.mood}`
  ).join('\n');

  const content = [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 }
    },
    {
      type: 'text',
      text: `You are an expert commercial video director. You are creating a 60-second product commercial video with 12 sequential shots that tell a COMPLETE STORY using a hybrid approach: CONTEXT shots (ingredients, lifestyle, process) alternating with PRODUCT shots (hero, closeup, action).

User's product description: "${productDescription}"

STEP 1 — Identify the product:
- Exact product name and brand
- Product category (pickles, chips, salsa, beverage, snack, sauce, etc.)
- Key visual elements (colors, packaging type, distinguishing features)
- Target audience and brand personality
- IMPORTANT: Identify the main INGREDIENTS of this product by looking at the label, packaging, and product type. List 3-6 key ingredients (e.g., cucumber, dill, vinegar, garlic for pickles).

STEP 2 — Choose the BEST commercial scene:
From the available scenes below, pick the ONE scene that would create the most compelling, authentic commercial for THIS specific product. Consider:
- What context would a real customer see this product in?
- What setting makes the product look most appealing and authentic?
- What scene creates the strongest emotional connection?

Available scenes:
${scenesListText}

STEP 3 — Design 12 NARRATIVE BEATS (hybrid CONTEXT + PRODUCT story):
This is a 12-beat STORY ARC with TWO types of shots:

**CONTEXT shots** (type: "context") — These are generated from SCRATCH using text-to-image (NO product photo).
- Write a COMPLETE descriptive prompt for an entirely new image
- Must relate to the product's actual ingredients, process, or lifestyle
- Do NOT start with "Edit this product photograph" — instead describe the full scene
- Be specific to THIS product's actual ingredients and category
- Examples: "A sun-drenched cucumber field...", "Hands chopping fresh dill on a wooden board...", "A rustic farmhouse table set for summer lunch..."

**PRODUCT shots** (type: "product") — These use the product photo as reference.
- Start with "Edit this product photograph. Change ONLY the background and surroundings."
- The product must remain EXACTLY as in the original photo
- Describe the scene context specific to this product

Story arc flow:
- Beat 1-2 [CONTEXT]: ORIGIN — ingredients in nature, fresh harvest
- Beat 3 [PRODUCT]: REVEAL — product appears dramatically
- Beat 4 [CONTEXT]: PROCESS — artisanal craft/preparation
- Beat 5 [PRODUCT]: BRAND — label hero close-up
- Beat 6 [CONTEXT]: LIFESTYLE — where the product is enjoyed
- Beat 7 [PRODUCT]: ACTION — product opened, being used
- Beat 8 [CONTEXT]: BEAUTY — ingredient art composition
- Beat 9 [PRODUCT]: GLORY — contents outside packaging, appetizing
- Beat 10 [CONTEXT]: MOOD — artistic atmosphere shot
- Beat 11-12 [PRODUCT]: CLIMAX & CLOSE — final composition + hero

The 12 narrative beats are:
${beatsText}

STEP 4 — Design 12 video prompts for Grok Imagine Video:
For each beat, write a 6-second video motion prompt that:
- Describes camera movement APPROPRIATE to this narrative moment
- For CONTEXT shots: use cinematic movements like aerials, tracking, crane shots
- For PRODUCT shots: use closer movements like dolly in, orbit, zoom
- Includes environmental motion (wind through fields, steam rising, liquid dripping, etc.)
- Creates FLOW between beats — each clip should connect naturally to the next
- Keep in English, 1-2 sentences each

STEP 5 — Choose background music:
From the available music tracks below, pick the ONE that best matches the mood:

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
  "sceneReason": "2-3 sentence explanation of why this scene is ideal for this product",
  "narrativeSummary": "One paragraph describing the commercial story arc from opening to closing",
  "videoModel": "grok-imagine-720p",
  "recommendedMusic": "music-track-key",
  "closingText": "Brand Name",
  "shots": {
    "beat-01-ingredient-origin": {
      "type": "context",
      "imagePrompt": "A sun-drenched cucumber field in mid-summer, rows of green vines stretching to the horizon...",
      "videoPrompt": "Slow cinematic aerial push over the field, golden hour light..."
    },
    "beat-02-fresh-harvest": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." },
    "beat-03-product-reveal": { "type": "product", "imagePrompt": "Edit this product photograph. Change ONLY the background...", "videoPrompt": "..." },
    "beat-04-craft-process": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." },
    "beat-05-label-hero": { "type": "product", "imagePrompt": "Edit this product photograph...", "videoPrompt": "..." },
    "beat-06-lifestyle-scene": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." },
    "beat-07-product-in-action": { "type": "product", "imagePrompt": "Edit this product photograph...", "videoPrompt": "..." },
    "beat-08-ingredient-beauty": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." },
    "beat-09-contents-glory": { "type": "product", "imagePrompt": "Edit this product photograph...", "videoPrompt": "..." },
    "beat-10-mood-atmosphere": { "type": "context", "imagePrompt": "...", "videoPrompt": "..." },
    "beat-11-final-composition": { "type": "product", "imagePrompt": "Edit this product photograph...", "videoPrompt": "..." },
    "beat-12-closing-hero": { "type": "product", "imagePrompt": "Edit this product photograph...", "videoPrompt": "..." }
  }
}`
    }
  ];

  logger.info('[VIDEO-PIPE] Calling Claude Director Creativo to analyze product and recommend scene...');

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
  logger.info(`[VIDEO-PIPE] Claude recommends scene "${parsed.chosenScene}" for ${parsed.brand} ${parsed.productName}: ${parsed.sceneReason}`);

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

  // Use director plan shots if available, otherwise fall back to default
  const numShots = options.numShots || 12;
  const shotKeys = directorPlan
    ? Object.keys(directorPlan.shots).slice(0, numShots)
    : SHOT_TYPES.slice(0, numShots).map(s => s.key);

  for (let i = 0; i < shotKeys.length; i++) {
    const shotKey = shotKeys[i];
    const shotType = SHOT_TYPES.find(s => s.key === shotKey);
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

// ═══ STEP 5: Generate Video from Shot via xAI Grok Imagine Video API ═══

function _getXaiKey() {
  const xaiKey = config.xai?.apiKey;
  if (!xaiKey) throw new Error('XAI_API_KEY not configured — set XAI_API_KEY env var');
  return xaiKey;
}

async function submitVideoJob(imageUrl, options = {}) {
  const xaiKey = _getXaiKey();

  const {
    cameraMotion = 'slow-dolly-in',
    duration = 5,
    aspectRatio = '9:16',
    videoModel = DEFAULT_VIDEO_MODEL
  } = options;

  const modelConfig = VIDEO_MODELS[videoModel] || VIDEO_MODELS[DEFAULT_VIDEO_MODEL];
  const motion = CAMERA_MOTIONS.find(m => m.key === cameraMotion) || CAMERA_MOTIONS[0];
  const prompt = options.prompt || `${motion.prompt}, professional product commercial, cinematic quality, studio lighting, 4K`;

  const body = {
    model: 'grok-imagine-video',
    prompt,
    image_url: imageUrl,
    duration: Math.max(1, Math.min(15, Math.round(duration))),
    aspect_ratio: aspectRatio,
    resolution: modelConfig.resolution || '720p'
  };

  logger.info(`[VIDEO-PIPE] Submitting to xAI: image=${imageUrl?.substring(0, 80)}, duration=${body.duration}, aspect=${body.aspect_ratio}, resolution=${body.resolution}`);

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

  logger.info(`[VIDEO-PIPE] ${modelConfig.label} job queued: ${requestId} (${duration}s, $${(duration * modelConfig.costPerSec).toFixed(3)})`);
  return { requestId, status: 'queued', cameraMotion: motion.key, videoModel: modelConfig.key };
}

async function checkVideoStatus(requestId, videoModel) {
  const xaiKey = _getXaiKey();

  let res;
  try {
    res = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${xaiKey}` }
    });
  } catch (err) {
    logger.error(`[VIDEO-PIPE] Network error checking video status: ${err.message}`);
    return { requestId, status: 'failed', error: `Network error: ${err.message}` };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    logger.warn(`[VIDEO-PIPE] Video status check failed (${res.status}) for ${requestId}: ${errBody.substring(0, 200)}`);
    // Treat 404/410 as terminal — the request ID is invalid or from a different system
    if (res.status === 404 || res.status === 410) {
      return { requestId, status: 'failed', error: `Request not found (${res.status})` };
    }
    return { requestId, status: 'failed', error: `Status check failed (${res.status})` };
  }

  const result = await res.json();

  // xAI status values: "done", "pending", "expired"
  if (result.status === 'done') {
    return {
      requestId,
      status: 'completed',
      videoUrl: result.video?.url || null
    };
  }

  if (result.status === 'expired') {
    return { requestId, status: 'failed', error: 'Video generation request expired' };
  }

  return { requestId, status: 'processing' };
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

module.exports = {
  AVAILABLE_SCENES,
  SHOT_TYPES,
  NARRATIVE_BEATS,
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
  getAvailableMusicTracks
};
