/**
 * Video Pipeline — OpenAI gpt-image-1.5 + Claude Vision + Kling 2.6 via fal.ai
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. OpenAI generates 12 shots from different angles (async, polled by frontend)
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

// ═══ ANGLE DEFINITIONS ═══
// 12 product photography angles — prompts emphasize label/brand fidelity
const PRODUCT_ANGLES = [
  { key: 'hero-front', label: 'Hero Frontal', prompt: 'Hero front-facing product shot, centered. The camera is directly in front of the product at eye level. The product label, brand name, logo and all text must be perfectly readable, sharp, and undistorted. Clean studio lighting, neutral white background, commercial product photography.' },
  { key: 'three-quarter-left', label: '3/4 Izquierda', prompt: 'Three-quarter angle from the left side, slight elevation. The product is rotated ~30 degrees to the left. All visible text, labels, and branding must remain sharp, legible and correctly spelled. Soft studio lighting, product photography.' },
  { key: 'three-quarter-right', label: '3/4 Derecha', prompt: 'Three-quarter angle from the right side, slight elevation. The product is rotated ~30 degrees to the right. All visible text, labels, and branding must remain sharp, legible and correctly spelled. Soft studio lighting, product photography.' },
  { key: 'side-left', label: 'Perfil Izquierdo', prompt: 'Clean side profile view from the left showing the side panel of the packaging. Any text on the side must be perfectly legible. Studio lighting, white background, product photography.' },
  { key: 'side-right', label: 'Perfil Derecho', prompt: 'Clean side profile view from the right showing the side panel of the packaging. Any text on the side must be perfectly legible. Studio lighting, white background, product photography.' },
  { key: 'top-down', label: 'Vista Superior', prompt: 'Top-down overhead flat lay view looking straight down at the product from above. If the top has branding or a lid label, it must be sharp and readable. Studio lighting, product photography.' },
  { key: 'low-angle', label: 'Angulo Bajo', prompt: 'Low angle shot looking slightly upward at the product, making it appear larger and more impressive. The front label must still be fully visible, sharp, and all text legible. Studio lighting, commercial photography.' },
  { key: 'close-up-detail', label: 'Detalle Close-Up', prompt: 'Close-up macro detail shot focusing on the product label texture, print quality, and fine details. Text must be razor sharp and perfectly readable. Shallow depth of field, studio lighting.' },
  { key: 'close-up-logo', label: 'Logo Close-Up', prompt: 'Close-up shot focused tightly on the brand logo and product name. The logo, brand name, and any tagline must be perfectly sharp, correctly spelled, and in the exact original colors. Studio lighting.' },
  { key: 'back-view', label: 'Vista Trasera', prompt: 'Back view showing the nutrition label, ingredients list, and back packaging. All text including small print must be readable and correctly reproduced. Studio lighting, product photography.' },
  { key: 'tilted-dynamic', label: 'Angulo Dinamico', prompt: 'Dynamic tilted angle with slight dutch angle for energetic composition. The product label and brand name must remain fully legible despite the angle. Studio lighting, commercial photography.' },
  { key: 'lifestyle-context', label: 'Lifestyle', prompt: 'Lifestyle shot with the product in a natural, appetizing setting appropriate for the product category. The front label and brand must remain clearly visible and sharp even in the lifestyle context. Warm lighting, food styling.' },
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
  const angles = PRODUCT_ANGLES.slice(0, numShots);
  const productDescription = options.productDescription || 'product';
  const job = shotJobs.get(jobId);

  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];

    // Build a prompt that heavily enforces label fidelity
    const fullPrompt = [
      angle.prompt,
      `\nThe product is: ${productDescription}.`,
      '\nCRITICAL REQUIREMENTS:',
      '- Preserve the EXACT product identity: every letter, word, logo, color, and graphic on the label must be identical to the source image.',
      '- All text on the packaging must be correctly spelled, properly aligned, and perfectly legible.',
      '- Do NOT invent, change, blur, warp, or remove any text or branding.',
      '- The product shape, size proportions, materials, and colors must match exactly.',
      '- Photorealistic rendering, high-end commercial product photography quality.',
      '- 9:16 vertical format, high resolution.'
    ].join('');

    try {
      logger.info(`[VIDEO-PIPE] Job ${jobId}: Generating angle ${i + 1}/${angles.length}: ${angle.key}`);

      const imageFile = await toFile(fs.createReadStream(productImagePath), null, { type: mimeType });

      const result = await client.images.edit({
        model: 'gpt-image-1.5',
        image: imageFile,
        prompt: fullPrompt,
        size: '1024x1536',
        n: 1
      });

      // Download and save
      const imageUrl = result.data[0]?.url || result.data[0]?.b64_json;
      let filename;

      if (imageUrl && imageUrl.startsWith('http')) {
        const res = await fetch(imageUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        filename = `shot-${angle.key}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else if (result.data[0]?.b64_json) {
        const buffer = Buffer.from(result.data[0].b64_json, 'base64');
        filename = `shot-${angle.key}-${Date.now()}.png`;
        fs.writeFileSync(path.join(SHOTS_DIR, filename), buffer);
      } else {
        throw new Error('No image data in response');
      }

      job.shots.push({
        angle: angle.key,
        label: angle.label,
        filename,
        url: `/uploads/video-shots/${filename}`,
        status: 'completed'
      });
      job.completed++;

      // Rate limit: delay between calls
      if (i < angles.length - 1) await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      logger.error(`[VIDEO-PIPE] Job ${jobId}: Angle ${angle.key} failed: ${err.message}`);
      job.shots.push({ angle: angle.key, label: angle.label, filename: null, url: null, status: 'failed', error: err.message });
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

Then generate a video prompt for EACH of these 12 shot angles. Each prompt should be specific to THIS product and describe what happens in the 5-second video clip — camera movement, product interaction, atmosphere.

The 12 angles are:
1. hero-front (Hero Frontal)
2. three-quarter-left (3/4 Izquierda)
3. three-quarter-right (3/4 Derecha)
4. side-left (Perfil Izquierdo)
5. side-right (Perfil Derecho)
6. top-down (Vista Superior)
7. low-angle (Angulo Bajo)
8. close-up-detail (Detalle Close-Up)
9. close-up-logo (Logo Close-Up)
10. back-view (Vista Trasera)
11. tilted-dynamic (Angulo Dinamico)
12. lifestyle-context (Lifestyle)

For each prompt:
- Describe a cinematic 5-second scene specific to this product
- Include product-specific details (e.g. for pickles: brine splashing, for chips: crumbs falling)
- Include camera movement description
- Keep prompts in English, 1-2 sentences each
- Make them visually exciting for a social media ad

Return ONLY valid JSON in this exact format:
{
  "productName": "...",
  "brand": "...",
  "category": "...",
  "prompts": {
    "hero-front": "Slow dolly in toward the jar of pickles as condensation drips down the glass, crisp studio lighting highlighting the green label",
    "three-quarter-left": "...",
    ...all 12 angles...
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
  PRODUCT_ANGLES,
  CAMERA_MOTIONS,
  startShotGenerationJob,
  getShotJobStatus,
  analyzeProductAndGeneratePrompts,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch
};
