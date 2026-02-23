/**
 * Video Pipeline — OpenAI gpt-image-1.5 + Claude Vision + Kling 2.6 via fal.ai
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. OpenAI generates 12 scene variations (async, polled by frontend)
 *   3. Claude Vision analyzes the product and generates smart prompts per shot
 *   4. Kling 2.6 converts each shot to a 5s video clip with camera motion + smart prompt
 *   5. Return video URLs for download/stitching
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

// ═══ SCENE DEFINITIONS ═══
// 12 commercial scenes — product stays identical, only background/context changes
// Uses same approach as Banco Creativo: "Edit this product photograph. Change ONLY the background and surroundings."
const PRODUCT_SCENES = [
  { key: 'studio-hero', label: 'Estudio Hero', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Premium studio product photography. Place the product centered on a clean, elegant surface with a soft gradient background. Professional directional lighting with subtle rim light on the background only. High-end e-commerce hero shot feel.' },
  { key: 'kitchen-warm', label: 'Cocina Calida', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a warm wooden kitchen countertop. Blurred background showing a cozy home kitchen with warm ambient lighting, copper utensils, and soft morning sunlight streaming through a window. Appetizing food photography feel.' },
  { key: 'picnic-outdoor', label: 'Picnic Exterior', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a rustic picnic blanket outdoors. Background shows a sunny park or garden with soft bokeh greenery. Natural golden hour sunlight. Summer lifestyle photography, relaxed and inviting mood.' },
  { key: 'party-table', label: 'Mesa de Fiesta', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a festive party table with colorful decorations, confetti, and party snacks scattered around. Warm, vibrant lighting. Celebration mood, fun and social atmosphere.' },
  { key: 'ingredients-splash', label: 'Splash Ingredientes', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Surround the product with its key ingredients floating and splashing dynamically around it — fresh vegetables, spices, herbs flying through the air. Dark dramatic background with spotlighting on the product. High-energy food commercial photography.' },
  { key: 'rustic-wood', label: 'Rustico Madera', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a weathered dark wood surface with rustic texture. Background shows an artisanal workshop or farmhouse setting, slightly blurred. Moody, warm directional lighting. Craft and authenticity feel.' },
  { key: 'neon-modern', label: 'Neon Moderno', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a sleek dark surface with vibrant neon color accents (purple, blue, pink) glowing in the background. Modern, trendy aesthetic. Urban nightlife commercial feel. Bold and eye-catching for social media.' },
  { key: 'ice-fresh', label: 'Hielo Fresco', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product surrounded by crushed ice, water droplets, and frost on a cold surface. Cool blue-tinted lighting. Condensation on surrounding surfaces. Refreshing, cold, and crisp commercial feel.' },
  { key: 'marble-elegant', label: 'Marmol Elegante', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a white marble surface with gold accent elements nearby. Soft, diffused premium lighting. Minimalist luxury aesthetic. High-end gourmet product photography.' },
  { key: 'bbq-grill', label: 'BBQ Parrilla', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product near a BBQ grill scene with visible smoke, charcoal glow, and grilled food in the blurred background. Warm orange firelight mixed with outdoor afternoon sun. Summer cookout atmosphere.' },
  { key: 'colorful-flat', label: 'Flat Lay Color', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Top-down flat lay composition. Place the product on a vibrant solid color background with complementary props arranged aesthetically around it — utensils, napkins, garnishes. Bright, even lighting. Social media flat lay photography style.' },
  { key: 'nature-green', label: 'Naturaleza Verde', prompt: 'Edit this product photograph. Change ONLY the background and surroundings. Place the product on a mossy natural stone surface surrounded by fresh green leaves and herbs. Dappled forest sunlight filtering through foliage. Organic, natural, and fresh feel. Farm-to-table aesthetic.' },
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

// ═══ IN-MEMORY JOB TRACKER for async shot generation ═══
const shotJobs = new Map();

/**
 * Start async shot generation — returns jobId immediately, generates in background
 */
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
    startedAt: new Date().toISOString(),
    error: null
  };

  shotJobs.set(jobId, job);

  // Run in background — don't await
  _generateShotsBackground(jobId, productImagePath, options).catch(err => {
    logger.error(`[VIDEO-PIPE] Background job ${jobId} crashed: ${err.message}`);
    const j = shotJobs.get(jobId);
    if (j) { j.status = 'failed'; j.error = err.message; }
  });

  return { jobId, status: 'running', total: numShots };
}

/**
 * Get status of a shot generation job
 */
function getShotJobStatus(jobId) {
  const job = shotJobs.get(jobId);
  if (!job) return null;
  return { ...job };
}

/**
 * Background worker — generates angle shots one by one, updates job state
 */
async function _generateShotsBackground(jobId, productImagePath, options = {}) {
  const apiKey = config.imageGen.openai.apiKey;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Product image not found: ' + productImagePath);
  }

  ensureDir(SHOTS_DIR);
  const client = new OpenAI({ apiKey });
  const mimeType = getMimeType(productImagePath);
  const numShots = options.numShots || 12;
  const scenes = PRODUCT_SCENES.slice(0, numShots);
  const productDescription = options.productDescription || 'product';
  const job = shotJobs.get(jobId);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Build prompt using Banco Creativo approach: preserve product, change only surroundings
    const fullPrompt = [
      scene.prompt,
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

    try {
      logger.info(`[VIDEO-PIPE] Job ${jobId}: Generating scene ${i + 1}/${scenes.length}: ${scene.key}`);

      const imageFile = await toFile(fs.createReadStream(productImagePath), null, { type: mimeType });

      const result = await client.images.edit({
        model: 'gpt-image-1.5',
        image: imageFile,
        prompt: fullPrompt,
        size: '1024x1536',
        n: 1,
        input_fidelity: 'high'
      });

      // Download and save
      const imageUrl = result.data[0]?.url || result.data[0]?.b64_json;
      let filename;

      if (imageUrl && imageUrl.startsWith('http')) {
        const res = await fetch(imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        filename = `shot-${scene.key}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else if (result.data[0]?.b64_json) {
        const buffer = Buffer.from(result.data[0].b64_json, 'base64');
        filename = `shot-${scene.key}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else {
        throw new Error('No image data in response');
      }

      job.shots.push({
        angle: scene.key,
        label: scene.label,
        filename,
        url: `/uploads/video-shots/${filename}`,
        status: 'completed'
      });
      job.completed++;

      // Rate limit: delay between calls
      if (i < scenes.length - 1) await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      logger.error(`[VIDEO-PIPE] Job ${jobId}: Scene ${scene.key} failed: ${err.message}`);
      job.shots.push({ angle: scene.key, label: scene.label, filename: null, url: null, status: 'failed', error: err.message });
      job.failed++;

      // If rate limited, wait longer
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

// ═══ STEP 2.5: Claude Vision — Analyze Product + Generate Smart Kling Prompts ═══

async function analyzeProductAndGeneratePrompts(shotUrls, productDescription) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropic = new Anthropic({ apiKey });

  // Pick up to 3 shots to analyze (hero-front preferred, plus 2 others)
  const shotsToAnalyze = [];
  for (const shot of shotUrls) {
    if (shotsToAnalyze.length >= 3) break;
    const filePath = path.join(config.system.uploadsDir, shot.url.replace('/uploads/', ''));
    if (fs.existsSync(filePath)) {
      shotsToAnalyze.push({ ...shot, filePath });
    }
  }

  if (shotsToAnalyze.length === 0) {
    throw new Error('No shot images available for analysis');
  }

  // Build vision message with images
  const content = [];
  for (const shot of shotsToAnalyze) {
    const imageBuffer = fs.readFileSync(shot.filePath);
    const base64 = imageBuffer.toString('base64');
    const mediaType = getMimeType(shot.filePath);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 }
    });
  }

  content.push({
    type: 'text',
    text: `You are a product video commercial director. Analyze these product images.

User's product description: "${productDescription}"

Based on the images, identify:
1. The exact product name and brand
2. Product category (chips, salsa, pickles, beverage, snack, etc.)
3. Key visual elements (colors, packaging type, distinguishing features)

Then generate a video prompt for EACH of these 12 scene variations. Each prompt should be specific to THIS product and describe what happens in the 5-second video clip — camera movement, environment interaction, atmosphere. The product itself stays the same in every scene, only the background and surroundings change.

The 12 scenes are:
1. studio-hero (Estudio Hero)
2. kitchen-warm (Cocina Calida)
3. picnic-outdoor (Picnic Exterior)
4. party-table (Mesa de Fiesta)
5. ingredients-splash (Splash Ingredientes)
6. rustic-wood (Rustico Madera)
7. neon-modern (Neon Moderno)
8. ice-fresh (Hielo Fresco)
9. marble-elegant (Marmol Elegante)
10. bbq-grill (BBQ Parrilla)
11. colorful-flat (Flat Lay Color)
12. nature-green (Naturaleza Verde)

For each prompt:
- Describe a cinematic 5-second scene specific to this product in that setting
- Include product-specific interactions with the environment (e.g. for pickles: condensation dripping, brine splash; for chips: crumbs falling around the bag)
- Include camera movement description
- Keep prompts in English, 1-2 sentences each
- Make them visually exciting for a social media vertical video ad

Return ONLY valid JSON in this exact format:
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "prompts": {
    "studio-hero": "Slow cinematic dolly in toward the jar on a clean studio surface, soft rim lighting revealing the label details as subtle condensation forms",
    "kitchen-warm": "...",
    ...all 12 scenes...
  }
}`
  });

  logger.info('[VIDEO-PIPE] Calling Claude Vision to analyze product and generate prompts...');

  const response = await anthropic.messages.create({
    model: config.claude.model,
    max_tokens: 4096,
    messages: [{ role: 'user', content }]
  });

  const rawText = response.content[0]?.text || '';

  // Parse JSON from response
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
  logger.info(`[VIDEO-PIPE] Claude identified: ${parsed.brand} ${parsed.productName} (${parsed.category})`);

  return parsed;
}

// ═══ STEP 3: Generate Video from Shot with Kling 2.6 via fal.ai ═══

function initFal() {
  const falKey = config.fal?.apiKey;
  if (!falKey) throw new Error('FAL_KEY not configured');
  fal.config({ credentials: falKey });
}

/**
 * Submit video job without waiting (returns request_id for polling)
 */
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

/**
 * Check status of a fal.ai queued job
 */
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

/**
 * Submit batch of video jobs (one per shot image)
 */
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
  PRODUCT_SCENES,
  CAMERA_MOTIONS,
  startShotGenerationJob,
  getShotJobStatus,
  analyzeProductAndGeneratePrompts,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch
};
