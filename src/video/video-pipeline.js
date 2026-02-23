/**
 * Video Pipeline — "Director Creativo" Mode v5
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. Claude Vision analyzes product → recommends best commercial scene → designs 12 NARRATIVE BEATS (story arc)
 *   3. OpenAI gpt-image-1.5 generates 12 shots as a sequential narrative (async, polled)
 *   4. Claude Vision judges each shot quality (1-10 score + feedback)
 *   5. User reviews storyboard with scores, can regenerate low-scoring shots
 *   6. Kling 2.6 converts each approved shot to a 5s video clip
 *   7. FFmpeg stitches all clips into ONE complete commercial video
 */

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { toFile } = require('openai');
const { fal } = require('@fal-ai/client');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const { execFile } = require('child_process');

const SHOTS_DIR = path.join(config.system.uploadsDir, 'video-shots');
const VIDEOS_DIR = path.join(config.system.uploadsDir, 'video-clips');
const FINALS_DIR = path.join(config.system.uploadsDir, 'video-finals');

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

// ═══ 12 NARRATIVE BEATS — Sequential story arc for ONE commercial ═══
// These are ordered to tell a coherent story from opening to closing
const NARRATIVE_BEATS = [
  { key: 'beat-01-scene-establish', label: '1. Escena', order: 1, narrative: 'Opening wide shot establishing the scene/environment. No product visible yet — just the beautiful setting that creates mood and context. The audience sees WHERE the story takes place.' },
  { key: 'beat-02-product-reveal', label: '2. Revelacion', order: 2, narrative: 'The product enters the scene or is revealed for the first time. Dramatic entrance — perhaps placed by a hand, or camera discovers it. Full product visible, centered, eye-level hero shot.' },
  { key: 'beat-03-hero-closeup', label: '3. Hero Close', order: 3, narrative: 'Tight close-up on the product label and branding. Fill 70% of frame. This is the "money shot" for brand recognition — sharp focus on name, logo, key text.' },
  { key: 'beat-04-detail-texture', label: '4. Detalle', order: 4, narrative: 'Extreme macro close-up on a distinctive product detail — the seal, cap, texture of the packaging, an ingredient visible through glass, condensation droplets on the surface.' },
  { key: 'beat-05-context-lifestyle', label: '5. Contexto', order: 5, narrative: 'Wide three-quarter shot showing the product IN its natural context. Props, utensils, complementary foods around it. Lifestyle moment — someone WOULD use this product here.' },
  { key: 'beat-06-product-open', label: '6. Abriendo', order: 6, narrative: 'The product is being OPENED or has just been opened. Show the contents — the inside, the real food/product revealed. If a jar: lid off, contents visible from above. If a bag: torn open, contents spilling slightly.' },
  { key: 'beat-07-contents-glory', label: '7. Contenido', order: 7, narrative: 'Glory shot of the CONTENTS themselves — the actual food/product outside its packaging. Dripping, glistening, textured, appetizing. Close-up of the real product being served, poured, or displayed.' },
  { key: 'beat-08-action-use', label: '8. Accion', order: 8, narrative: 'Action/interaction shot — the product being USED. A fork lifting food, liquid being poured, hands grabbing, product being applied. Dynamic movement, human interaction with the product.' },
  { key: 'beat-09-ingredient-splash', label: '9. Ingredientes', order: 9, narrative: 'Key ingredients floating or arranged artistically around the product. Fresh herbs, spices, vegetables, elements that compose this product — suggesting quality and freshness.' },
  { key: 'beat-10-mood-artistic', label: '10. Artistico', order: 10, narrative: 'Artistic/cinematic beauty shot — dramatic lighting, bokeh, tilted angle, or creative composition. This is the "Instagram-worthy" frame. Product visible but the mood and aesthetics take center stage.' },
  { key: 'beat-11-group-arrangement', label: '11. Composicion', order: 11, narrative: 'Full arrangement shot — product with all props, ingredients, and scene elements beautifully composed. Like a magazine cover or catalog hero image. Everything comes together.' },
  { key: 'beat-12-closing-hero', label: '12. Cierre', order: 12, narrative: 'Final closing hero shot — product centered, clean, powerful. This is the last frame the viewer sees. Brand clearly visible, call-to-action composition. Clean background, maximum impact.' },
];

// Keep backward compat alias
const SHOT_TYPES = NARRATIVE_BEATS;

// ═══ CAMERA MOTIONS for Kling ═══
const CAMERA_MOTIONS = [
  { key: 'slow-dolly-in', prompt: 'Slow cinematic dolly in toward the product, smooth camera movement', label: 'Dolly In' },
  { key: 'slow-orbit', prompt: 'Slow 360 orbit around the product, smooth circular camera movement', label: 'Orbit 360' },
  { key: 'slow-zoom', prompt: 'Slow zoom into product details, cinematic focus pull', label: 'Zoom In' },
  { key: 'push-reveal', prompt: 'Slow push forward revealing the product, cinematic reveal shot', label: 'Push Reveal' },
  { key: 'tilt-up', prompt: 'Slow tilt up from product base to top, cinematic vertical movement', label: 'Tilt Up' },
  { key: 'dolly-out', prompt: 'Slow dolly out pulling back from product, cinematic wide reveal', label: 'Dolly Out' },
  { key: 'handheld', prompt: 'Subtle handheld camera movement, natural gentle sway, lifestyle feel', label: 'Handheld' },
  { key: 'static', prompt: 'Static camera, product gently animating, studio lighting, subtle movement', label: 'Estatico' },
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
    `${b.order}. ${b.key} — "${b.label}": ${b.narrative}`
  ).join('\n');

  const content = [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 }
    },
    {
      type: 'text',
      text: `You are an expert commercial video director. You are creating a 60-second product commercial video with 12 sequential shots that tell a COMPLETE STORY from opening to closing.

User's product description: "${productDescription}"

STEP 1 — Identify the product:
- Exact product name and brand
- Product category (pickles, chips, salsa, beverage, snack, sauce, etc.)
- Key visual elements (colors, packaging type, distinguishing features)
- Target audience and brand personality

STEP 2 — Choose the BEST commercial scene:
From the available scenes below, pick the ONE scene that would create the most compelling, authentic commercial for THIS specific product. Consider:
- What context would a real customer see this product in?
- What setting makes the product look most appealing and authentic?
- What scene creates the strongest emotional connection?

Available scenes:
${scenesListText}

STEP 3 — Design 12 NARRATIVE BEATS (sequential story):
This is NOT 12 independent shots. This is a 12-beat STORY ARC that flows like a real commercial:
- Beat 1-2: OPENING — establish the world, then reveal the product
- Beat 3-5: DEVELOPMENT — show the product in detail, brand, and lifestyle context
- Beat 6-8: CLIMAX — product opened, contents shown, action/interaction (the exciting part!)
- Beat 9-11: RESOLUTION — ingredients, beauty shots, full composition
- Beat 12: CLOSING — final hero frame, brand impact

For EACH of the 12 narrative beats below, write a specific OpenAI image generation prompt. Each prompt MUST:
- Start with "Edit this product photograph. Change ONLY the background and surroundings."
- Describe the chosen scene context specifically for this product
- Include the specific narrative moment and composition for that beat
- Maintain VISUAL CONTINUITY — same scene, same lighting, same color palette, same props throughout all 12
- For beats 6-8 (action shots): describe the product being opened, contents visible, food being served/used, hands interacting — even though the original photo shows a sealed product, describe the SCENE as if the product is open/in-use
- Be 2-3 sentences, detailed and specific

IMPORTANT for action beats (6, 7, 8):
- Beat 6: Show the product AS IF it's being opened — lid off, contents beginning to be revealed
- Beat 7: Show the actual CONTENTS of the product — the food itself, outside the packaging, glistening, appetizing
- Beat 8: Show HUMAN INTERACTION — hands, utensils, the product being served, poured, grabbed

The 12 narrative beats are:
${beatsText}

STEP 4 — Design 12 video prompts for Kling 2.6:
For each beat, write a 5-second video motion prompt that:
- Describes camera movement APPROPRIATE to this narrative moment (slow reveal for opening, dynamic for action, steady for closing)
- Includes product-specific environmental motion (condensation forming, steam rising, liquid dripping, crumbs falling, ice crackling, etc.)
- Creates FLOW between beats — each video clip should feel like it connects to the next
- Keep in English, 1-2 sentences each

The 12 clips will be concatenated into ONE 60-second commercial, so design the camera movements to create natural transitions between beats.

Return ONLY valid JSON:
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "targetAudience": "...",
  "chosenScene": "scene-key",
  "sceneLabel": "Scene Label",
  "sceneReason": "2-3 sentence explanation of why this scene is ideal for this product",
  "narrativeSummary": "One paragraph describing the commercial story arc from opening to closing",
  "shots": {
    "beat-01-scene-establish": {
      "imagePrompt": "Edit this product photograph. Change ONLY the background and surroundings. ...",
      "videoPrompt": "Slow cinematic establishing shot..."
    },
    "beat-02-product-reveal": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-03-hero-closeup": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-04-detail-texture": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-05-context-lifestyle": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-06-product-open": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-07-contents-glory": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-08-action-use": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-09-ingredient-splash": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-10-mood-artistic": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-11-group-arrangement": { "imagePrompt": "...", "videoPrompt": "..." },
    "beat-12-closing-hero": { "imagePrompt": "...", "videoPrompt": "..." }
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
  const apiKey = config.imageGen.openai.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Product image not found: ' + productImagePath);
  }

  ensureDir(SHOTS_DIR);
  const client = new OpenAI({ apiKey });
  const mimeType = getMimeType(productImagePath);
  const productDescription = options.productDescription || 'product';
  const directorPlan = options.directorPlan;
  const job = shotJobs.get(jobId);

  // Use director plan shots if available, otherwise fall back to default
  const numShots = options.numShots || 12;
  const shotKeys = directorPlan
    ? Object.keys(directorPlan.shots).slice(0, numShots)
    : SHOT_TYPES.slice(0, numShots).map(s => s.key);

  for (let i = 0; i < shotKeys.length; i++) {
    const shotKey = shotKeys[i];
    const shotType = SHOT_TYPES.find(s => s.key === shotKey);
    const shotLabel = shotType?.label || shotKey;

    // Build prompt: use director plan's specific prompt or generate a default
    let fullPrompt;
    if (directorPlan?.shots?.[shotKey]?.imagePrompt) {
      fullPrompt = [
        directorPlan.shots[shotKey].imagePrompt,
        `\nThe product is: ${productDescription}.`,
        '\nVertical 9:16 format (1080x1920).',
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
        '\nVertical 9:16 format (1080x1920).',
        '\nThe product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions.',
        ' Do NOT re-render, redraw, or generate a 3D version of the product.',
        ' Keep it as the original flat photographic element.',
        ' Photorealistic, high-end commercial product photography quality.'
      ].join('');
    }

    try {
      logger.info(`[VIDEO-PIPE] Job ${jobId}: Generating shot ${i + 1}/${shotKeys.length}: ${shotKey}`);

      const imageFile = await toFile(fs.createReadStream(productImagePath), null, { type: mimeType });

      const result = await client.images.edit({
        model: 'gpt-image-1.5',
        image: imageFile,
        prompt: fullPrompt,
        size: '1024x1536',
        n: 1,
        input_fidelity: 'high'
      });

      const imageUrl = result.data[0]?.url || result.data[0]?.b64_json;
      let filename;

      if (imageUrl && imageUrl.startsWith('http')) {
        const res = await fetch(imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        filename = `shot-${shotKey}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else if (result.data[0]?.b64_json) {
        const buffer = Buffer.from(result.data[0].b64_json, 'base64');
        filename = `shot-${shotKey}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else {
        throw new Error('No image data in response');
      }

      job.shots.push({
        angle: shotKey,
        label: shotLabel,
        filename,
        url: `/uploads/video-shots/${filename}`,
        videoPrompt: directorPlan?.shots?.[shotKey]?.videoPrompt || '',
        status: 'completed'
      });
      job.completed++;

      if (i < shotKeys.length - 1) await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      logger.error(`[VIDEO-PIPE] Job ${jobId}: Shot ${shotKey} failed: ${err.message}`);
      job.shots.push({ angle: shotKey, label: shotLabel, filename: null, url: null, status: 'failed', error: err.message });
      job.failed++;

      if (err.status === 429) {
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

async function judgeShots(shotUrls, productDescription, originalImagePath) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  // Load original product photo once (for reference in each batch)
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

    // Include original product photo as reference
    if (origImageContent) {
      content.push(origImageContent);
      content.push({
        type: 'text',
        text: '↑ ORIGINAL product reference photo (this is what the product should look like)'
      });
    }

    // Include each shot in this batch
    for (const shot of batch) {
      const filePath = path.join(config.system.uploadsDir, shot.url.replace('/uploads/', ''));
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
          text: `↑ Shot: "${shot.label}" (key: ${shot.angle})`
        });
      }
    }

    const shotKeysInBatch = batch.map(s => s.angle).join(', ');
    content.push({
      type: 'text',
      text: `You are a quality control judge for product commercial photography. The product is: "${productDescription}".

Score EACH generated shot on a scale of 1-10 based on these criteria:
1. **Label Fidelity (40%)**: Is the product label/text readable, undistorted, and matching the original? Any warping, blurring, or text alteration is a major penalty.
2. **Product Integrity (25%)**: Does the product shape, color, and packaging match the original photo exactly? No reshaping, 3D rendering, or artistic reinterpretation.
3. **Scene Quality (20%)**: Is the background/scene realistic, well-lit, and commercially appealing? Good composition and professional feel.
4. **Commercial Value (15%)**: Would this image work as a frame in a real product commercial? Is it ad-quality?

You are judging these shots: ${shotKeysInBatch}

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

async function regenerateSingleShot(productImagePath, shotKey, imagePrompt, productDescription) {
  const apiKey = config.imageGen.openai.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  ensureDir(SHOTS_DIR);
  const client = new OpenAI({ apiKey });
  const mimeType = getMimeType(productImagePath);

  const fullPrompt = [
    imagePrompt,
    `\nThe product is: ${productDescription}.`,
    '\nVertical 9:16 format (1080x1920).',
    '\nThe product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions.',
    ' Do NOT re-render, redraw, or generate a 3D version of the product.',
    ' Keep it as the original flat photographic element.',
    ' Do NOT add lighting effects (rim light, glow, highlights) ON the product.',
    ' Do NOT alter, warp, or reshape the packaging.',
    ' The product should look physically placed in the new scene.',
    ' Photorealistic, high-end commercial product photography quality.'
  ].join('');

  logger.info(`[VIDEO-PIPE] Regenerating shot: ${shotKey}`);

  const imageFile = await toFile(fs.createReadStream(productImagePath), null, { type: mimeType });

  const result = await client.images.edit({
    model: 'gpt-image-1.5',
    image: imageFile,
    prompt: fullPrompt,
    size: '1024x1536',
    n: 1,
    input_fidelity: 'high'
  });

  const imageUrl = result.data[0]?.url || result.data[0]?.b64_json;
  let filename;

  if (imageUrl && imageUrl.startsWith('http')) {
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    filename = `shot-${shotKey}-${Date.now()}.png`;
    fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
  } else if (result.data[0]?.b64_json) {
    const buffer = Buffer.from(result.data[0].b64_json, 'base64');
    filename = `shot-${shotKey}-${Date.now()}.png`;
    fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
  } else {
    throw new Error('No image data in response');
  }

  const shotType = SHOT_TYPES.find(s => s.key === shotKey);
  return {
    angle: shotKey,
    label: shotType?.label || shotKey,
    filename,
    url: `/uploads/video-shots/${filename}`,
    status: 'completed'
  };
}

// ═══ STEP 5: Generate Video from Shot with Kling 2.6 via fal.ai ═══

function initFal() {
  const falKey = config.fal?.apiKey;
  if (!falKey) throw new Error('FAL_KEY not configured');
  fal.config({ credentials: falKey });
}

async function submitVideoJob(imageUrl, options = {}) {
  initFal();

  const {
    cameraMotion = 'slow-dolly-in',
    duration = 5,
    aspectRatio = '9:16'
  } = options;

  const motion = CAMERA_MOTIONS.find(m => m.key === cameraMotion) || CAMERA_MOTIONS[0];
  const prompt = options.prompt || `${motion.prompt}, professional product commercial, cinematic quality, studio lighting, 4K`;

  const { request_id } = await fal.queue.submit('fal-ai/kling-video/v2.6/pro/image-to-video', {
    input: {
      prompt,
      image_url: imageUrl,
      duration,
      aspect_ratio: aspectRatio,
      cfg_scale: 0.7
    }
  });

  logger.info(`[VIDEO-PIPE] Kling job queued: ${request_id}`);
  return { requestId: request_id, status: 'queued', cameraMotion: motion.key };
}

async function checkVideoStatus(requestId) {
  initFal();

  const status = await fal.queue.status('fal-ai/kling-video/v2.6/pro/image-to-video', {
    requestId,
    logs: false
  });

  if (status.status === 'COMPLETED') {
    const result = await fal.queue.result('fal-ai/kling-video/v2.6/pro/image-to-video', { requestId });
    return {
      requestId,
      status: 'completed',
      videoUrl: result.video?.url || result.data?.video?.url || null
    };
  }

  return {
    requestId,
    status: status.status === 'IN_PROGRESS' ? 'processing' : status.status === 'IN_QUEUE' ? 'queued' : status.status?.toLowerCase() || 'unknown'
  };
}

async function submitVideoBatch(shots, options = {}) {
  const results = [];
  const batchSize = 3;

  for (let i = 0; i < shots.length; i += batchSize) {
    const batch = shots.slice(i, i + batchSize);

    const promises = batch.map(async (shot) => {
      try {
        const result = await submitVideoJob(shot.imageUrl, {
          cameraMotion: shot.cameraMotion || options.cameraMotion,
          duration: shot.duration || options.duration,
          aspectRatio: shot.aspectRatio || options.aspectRatio,
          prompt: shot.prompt || options.prompt
        });
        return { shotAngle: shot.angle, imageUrl: shot.imageUrl, ...result };
      } catch (err) {
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

const stitchJobs = new Map();

function startStitchJob(clipUrls) {
  const jobId = `stitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    status: 'running',
    totalClips: clipUrls.length,
    downloaded: 0,
    error: null,
    outputUrl: null,
    startedAt: new Date().toISOString()
  };
  stitchJobs.set(jobId, job);

  _stitchBackground(jobId, clipUrls).catch(err => {
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

async function _stitchBackground(jobId, clipUrls) {
  ensureDir(FINALS_DIR);
  const job = stitchJobs.get(jobId);
  const tmpDir = path.join(FINALS_DIR, `tmp-${jobId}`);
  ensureDir(tmpDir);

  // Step A: Download all clip videos
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

  // Step B: Create FFmpeg concat list file
  const concatListPath = path.join(tmpDir, 'concat.txt');
  const concatContent = localFiles.map(f => `file '${f}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent);

  // Step C: Find ffmpeg binary — try system, then ffmpeg-static
  let ffmpegPath = 'ffmpeg';
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) ffmpegPath = ffmpegStatic;
  } catch (_) {
    // ffmpeg-static not installed, use system ffmpeg
  }

  // Step D: Concatenate with FFmpeg
  const outputFilename = `commercial-${Date.now()}.mp4`;
  const outputPath = path.join(FINALS_DIR, outputFilename);

  await new Promise((resolve, reject) => {
    const args = [
      '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ];

    logger.info(`[VIDEO-PIPE] Stitch ${jobId}: Running FFmpeg concat...`);
    execFile(ffmpegPath, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        logger.error(`[VIDEO-PIPE] FFmpeg error: ${stderr || err.message}`);
        reject(new Error(`FFmpeg failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });

  // Step E: Cleanup temp files
  try {
    for (const f of localFiles) fs.unlinkSync(f);
    fs.unlinkSync(concatListPath);
    fs.rmdirSync(tmpDir);
  } catch (_) { /* ignore cleanup errors */ }

  job.status = 'done';
  job.outputUrl = `/uploads/video-finals/${outputFilename}`;
  job.outputFilename = outputFilename;
  job.finishedAt = new Date().toISOString();
  logger.info(`[VIDEO-PIPE] Stitch ${jobId} completed: ${outputFilename}`);
}

module.exports = {
  AVAILABLE_SCENES,
  SHOT_TYPES,
  NARRATIVE_BEATS,
  CAMERA_MOTIONS,
  analyzeProductAndRecommendScene,
  startShotGenerationJob,
  getShotJobStatus,
  judgeShots,
  regenerateSingleShot,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch,
  startStitchJob,
  getStitchJobStatus
};
