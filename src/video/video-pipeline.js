/**
 * Video Pipeline — OpenAI gpt-image-1.5 + Kling 2.6 via fal.ai
 *
 * Workflow:
 *   1. Upload 1 product photo
 *   2. OpenAI generates 12 shots from different angles (image editing)
 *   3. Kling 2.6 converts each shot to a 5s video clip with camera motion
 *   4. Return video URLs for download/stitching
 */

const OpenAI = require('openai');
const { toFile } = require('openai');
const { fal } = require('@fal-ai/client');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
// 12 product photography angles for commercial-quality coverage
const PRODUCT_ANGLES = [
  { key: 'hero-front', prompt: 'Hero front-facing product shot, centered, clean studio lighting, white background, commercial photography' },
  { key: 'three-quarter-left', prompt: 'Three-quarter angle from the left side, slight elevation, soft studio lighting, product photography' },
  { key: 'three-quarter-right', prompt: 'Three-quarter angle from the right side, slight elevation, soft studio lighting, product photography' },
  { key: 'side-left', prompt: 'Clean side profile view from the left, studio lighting, white background, product photography' },
  { key: 'side-right', prompt: 'Clean side profile view from the right, studio lighting, white background, product photography' },
  { key: 'top-down', prompt: 'Top-down overhead flat lay view looking straight down, studio lighting, product photography' },
  { key: 'low-angle', prompt: 'Low angle dramatic shot looking slightly upward at the product, studio lighting, commercial photography' },
  { key: 'close-up-detail', prompt: 'Extreme close-up macro detail shot of product label and texture, sharp focus, studio lighting' },
  { key: 'close-up-logo', prompt: 'Close-up shot focused on brand logo and product name, sharp focus, studio lighting' },
  { key: 'back-view', prompt: 'Back view showing nutrition label / ingredients / back packaging, studio lighting, product photography' },
  { key: 'tilted-dynamic', prompt: 'Dynamic tilted angle, slight dutch angle, energetic composition, studio lighting, commercial photography' },
  { key: 'lifestyle-context', prompt: 'Lifestyle shot with the product in a natural setting, appetizing scene, warm lighting, food styling' },
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

// ═══ STEP 1: Generate Product Angle Shots with OpenAI ═══

async function generateAngleShots(productImagePath, options = {}) {
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
  const results = [];

  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    const fullPrompt = `${angle.prompt}. The product is: ${productDescription}. Maintain exact product identity, labels, colors, and branding. Photorealistic, high-end commercial product photography, 9:16 vertical format.`;

    try {
      logger.info(`[VIDEO-PIPE] Generating angle ${i + 1}/${angles.length}: ${angle.key}`);

      const imageFile = await toFile(fs.createReadStream(productImagePath), null, { type: mimeType });

      const result = await client.images.edit({
        model: 'gpt-image-1.5',
        image: imageFile,
        prompt: fullPrompt,
        size: '1024x1536', // vertical 9:16
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

      results.push({
        angle: angle.key,
        filename,
        url: `/uploads/video-shots/${filename}`,
        status: 'completed'
      });

      // Rate limit: small delay between calls
      if (i < angles.length - 1) await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      logger.error(`[VIDEO-PIPE] Angle ${angle.key} failed: ${err.message}`);
      results.push({ angle: angle.key, filename: null, url: null, status: 'failed', error: err.message });

      // If rate limited, wait longer
      if (err.status === 429) {
        logger.warn('[VIDEO-PIPE] Rate limited, waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  return results;
}

// ═══ STEP 2: Generate Video from Shot with Kling 2.6 via fal.ai ═══

function initFal() {
  const falKey = config.fal?.apiKey;
  if (!falKey) throw new Error('FAL_KEY not configured');
  fal.config({ credentials: falKey });
}

async function generateVideoFromShot(imageUrl, options = {}) {
  initFal();

  const {
    cameraMotion = 'slow-dolly-in',
    duration = 5,
    aspectRatio = '9:16'
  } = options;

  const motion = CAMERA_MOTIONS.find(m => m.key === cameraMotion) || CAMERA_MOTIONS[0];
  const prompt = options.prompt || `${motion.prompt}, professional product commercial, cinematic quality, studio lighting, 4K`;

  logger.info(`[VIDEO-PIPE] Submitting Kling 2.6 job: ${motion.key}, ${duration}s, ${aspectRatio}`);

  const result = await fal.subscribe('fal-ai/kling-video/v2.6/pro/image-to-video', {
    input: {
      prompt,
      image_url: imageUrl,
      duration,
      aspect_ratio: aspectRatio,
      cfg_scale: 0.7
    },
    logs: false
  });

  return {
    videoUrl: result.video?.url || result.data?.video?.url || null,
    status: result.video?.url ? 'completed' : 'failed',
    requestId: result.request_id || null
  };
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
  generateAngleShots,
  generateVideoFromShot,
  submitVideoJob,
  checkVideoStatus,
  submitVideoBatch
};
