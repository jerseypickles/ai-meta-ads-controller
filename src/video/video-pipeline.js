/**
 * Video Pipeline — "Director Creativo" Mode
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. Claude Vision analyzes product → recommends best commercial scene → designs 12 cinematic shots
 *   3. OpenAI gpt-image-1.5 generates 12 shots within the SAME scene (async, polled)
 *   4. Claude Vision judges each shot quality (1-10 score + feedback)
 *   5. User reviews storyboard with scores, can regenerate low-scoring shots
 *   6. Kling 2.6 converts each approved shot to a 5s video clip
 */

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { toFile } = require('openai');
const { fal } = require('@fal-ai/client');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const SHOTS_DIR = path.join(config.system.uploadsDir, 'video-shots');
const VIDEOS_DIR = path.join(config.system.uploadsDir, 'video-clips');

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

// ═══ 12 CINEMATIC SHOT TYPES (used within the chosen scene) ═══
const SHOT_TYPES = [
  { key: 'hero-center', label: 'Hero Central', composition: 'Product perfectly centered, straight-on eye-level shot, balanced symmetrical framing, full product visible' },
  { key: 'close-up-label', label: 'Close-up Label', composition: 'Tight close-up on the product label/branding, filling 70% of the frame, sharp focus on text and logo' },
  { key: 'three-quarter', label: 'Tres Cuartos', composition: 'Product at a slight three-quarter angle view, showing depth and dimension of the packaging' },
  { key: 'overhead-top', label: 'Cenital', composition: 'Top-down overhead bird\'s eye view looking straight down at the product from above' },
  { key: 'low-angle', label: 'Angulo Bajo', composition: 'Low angle looking up at the product, making it appear grand and prominent, hero perspective' },
  { key: 'wide-context', label: 'Contexto Amplio', composition: 'Wide shot showing the product smaller in frame with the full scene/environment visible around it' },
  { key: 'macro-detail', label: 'Macro Detalle', composition: 'Extreme close-up on a distinctive detail — texture, seal, cap, ingredient highlight, or unique packaging feature' },
  { key: 'rule-thirds-left', label: 'Tercios Izquierda', composition: 'Product positioned on the left third of frame, negative space on right, artistic editorial composition' },
  { key: 'rule-thirds-right', label: 'Tercios Derecha', composition: 'Product positioned on the right third of frame, negative space on left, dynamic commercial composition' },
  { key: 'tilted-dynamic', label: 'Dinamico Inclinado', composition: 'Slightly tilted/dutch angle for energy and dynamism, product still clearly visible, action feel' },
  { key: 'depth-bokeh', label: 'Profundidad Bokeh', composition: 'Product sharp in foreground with heavy bokeh blurring the background scene, cinematic depth of field' },
  { key: 'group-props', label: 'Con Elementos', composition: 'Product surrounded by complementary props and contextual elements that enhance the scene storytelling' },
];

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

  const shotTypesText = SHOT_TYPES.map((s, i) =>
    `${i + 1}. ${s.key} — "${s.label}": ${s.composition}`
  ).join('\n');

  const content = [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 }
    },
    {
      type: 'text',
      text: `You are an expert commercial video director. Analyze this product photograph and act as creative director for a cohesive product commercial video.

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

STEP 3 — Design 12 cinematic shots within that scene:
For each of the 12 shot types below, write a specific OpenAI image generation prompt that places this product in the chosen scene with that specific camera composition. Each prompt MUST:
- Start with "Edit this product photograph. Change ONLY the background and surroundings."
- Describe the chosen scene context specifically for this product
- Include the specific camera composition/framing for that shot type
- Be 2-3 sentences, detailed enough for high-quality generation
- All 12 shots must share the SAME visual world (same scene, same lighting mood, same color palette)

The 12 shot types are:
${shotTypesText}

STEP 4 — Design 12 video prompts for Kling 2.6:
For each shot, also write a cinematic 5-second video motion prompt describing:
- Camera movement specific to this shot type
- Product-specific environmental interactions (condensation, splash, steam, crumbs, etc.)
- Atmosphere and mood continuity
- Keep in English, 1-2 sentences each

Return ONLY valid JSON:
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "targetAudience": "...",
  "chosenScene": "scene-key",
  "sceneLabel": "Scene Label",
  "sceneReason": "2-3 sentence explanation of why this scene is ideal for this product",
  "shots": {
    "hero-center": {
      "imagePrompt": "Edit this product photograph. Change ONLY the background and surroundings. ...",
      "videoPrompt": "Slow cinematic dolly in toward..."
    },
    "close-up-label": { "imagePrompt": "...", "videoPrompt": "..." },
    "three-quarter": { "imagePrompt": "...", "videoPrompt": "..." },
    "overhead-top": { "imagePrompt": "...", "videoPrompt": "..." },
    "low-angle": { "imagePrompt": "...", "videoPrompt": "..." },
    "wide-context": { "imagePrompt": "...", "videoPrompt": "..." },
    "macro-detail": { "imagePrompt": "...", "videoPrompt": "..." },
    "rule-thirds-left": { "imagePrompt": "...", "videoPrompt": "..." },
    "rule-thirds-right": { "imagePrompt": "...", "videoPrompt": "..." },
    "tilted-dynamic": { "imagePrompt": "...", "videoPrompt": "..." },
    "depth-bokeh": { "imagePrompt": "...", "videoPrompt": "..." },
    "group-props": { "imagePrompt": "...", "videoPrompt": "..." }
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

async function judgeShots(shotUrls, productDescription, originalImagePath) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  const content = [];

  // Include original product photo as reference
  if (originalImagePath && fs.existsSync(originalImagePath)) {
    const origBuffer = fs.readFileSync(originalImagePath);
    const origBase64 = origBuffer.toString('base64');
    const origMime = getMimeType(originalImagePath);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: origMime, data: origBase64 }
    });
    content.push({
      type: 'text',
      text: '↑ ORIGINAL product reference photo (this is what the product should look like)'
    });
  }

  // Include each generated shot (limit to avoid token overflow)
  const shotsToJudge = shotUrls.slice(0, 12);
  for (const shot of shotsToJudge) {
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

  content.push({
    type: 'text',
    text: `You are a quality control judge for product commercial photography. The product is: "${productDescription}".

Score EACH generated shot on a scale of 1-10 based on these criteria:
1. **Label Fidelity (40%)**: Is the product label/text readable, undistorted, and matching the original? Any warping, blurring, or text alteration is a major penalty.
2. **Product Integrity (25%)**: Does the product shape, color, and packaging match the original photo exactly? No reshaping, 3D rendering, or artistic reinterpretation.
3. **Scene Quality (20%)**: Is the background/scene realistic, well-lit, and commercially appealing? Good composition and professional feel.
4. **Commercial Value (15%)**: Would this image work as a frame in a real product commercial? Is it ad-quality?

For each shot, provide:
- score: 1-10 integer
- verdict: "approve" (7-10), "marginal" (5-6), or "reject" (1-4)
- reason: One sentence explaining the score, focusing on the most important issue

Return ONLY valid JSON:
{
  "scores": {
    "shot-key": { "score": 8, "verdict": "approve", "reason": "Label is sharp and readable, product perfectly placed in scene" },
    ...for each shot...
  },
  "overallAverage": 7.5,
  "summary": "One sentence overall assessment"
}`
  });

  logger.info(`[VIDEO-PIPE] Calling Claude Quality Judge for ${shotsToJudge.length} shots...`);

  const response = await anthropic.messages.create({
    model: config.claude.model,
    max_tokens: 4096,
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
  logger.info(`[VIDEO-PIPE] Quality Judge: avg ${parsed.overallAverage}/10 — ${parsed.summary}`);

  return parsed;
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

module.exports = {
  AVAILABLE_SCENES,
  SHOT_TYPES,
  CAMERA_MOTIONS,
  analyzeProductAndRecommendScene,
  startShotGenerationJob,
  getShotJobStatus,
  judgeShots,
  regenerateSingleShot,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch
};
