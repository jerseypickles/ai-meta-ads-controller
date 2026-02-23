/**
 * Higgsfield AI Video Generation Client
 *
 * Wraps the Higgsfield SDK v2 and raw API for image-to-video generation.
 * Used to create product videos from uploaded photos.
 */

const config = require('../../config');
const logger = require('../utils/logger');

const API_BASE = 'https://platform.higgsfield.ai';

// Best motion presets for product videos (from API discovery)
const PRODUCT_MOTION_PRESETS = {
  'dolly-in':       { id: '81ca2cd2-05db-4222-9ba0-a32e5185adfb', label: 'Dolly In', description: 'Smooth camera move toward product' },
  '360-orbit':      { id: 'ea035f68-b350-40f1-b7f4-7dff999fdd67', label: '360 Orbit', description: 'Full orbit around product' },
  'crash-zoom-in':  { id: '3ec247ed-063d-476d-8266-48829c2eced6', label: 'Crash Zoom In', description: 'Dramatic zoom into product' },
  'lazy-susan':     { id: 'ce9dc38e-d6da-4368-9742-f73b559d802e', label: 'Lazy Susan', description: 'Turntable rotation' },
  'super-dolly-in': { id: '3a24a20d-b494-4e8a-9b5f-4ef05ee5073d', label: 'Super Dolly In', description: 'Extreme dolly toward product' },
  'handheld':       { id: '5be9d262-82d7-4a74-babf-ee8fefd5c3c3', label: 'Handheld', description: 'Natural handheld camera feel' },
  'push-to-glass':  { id: '30a02896-cdda-469d-9ed9-52cbba1c04a8', label: 'Push To Glass', description: 'Push close-up to surface' },
  'dolly-out':      { id: '23c62e5b-eba9-46e1-88a2-b6d5fa5afb8e', label: 'Dolly Out', description: 'Pull back from product reveal' },
  'tilt-up':        { id: '0b4c83e3-6ae2-4b85-86a5-f7f967fc2e73', label: 'Tilt Up', description: 'Camera tilts upward' },
  'tilt-down':      { id: '6b7ed83f-3b3d-4f78-9e4a-62a12a81e95c', label: 'Tilt Down', description: 'Camera tilts downward' },
  'pan-left':       { id: 'ccfe4c32-4a5e-4c50-b71e-e6d5756ad5e1', label: 'Pan Left', description: 'Horizontal pan left' },
  'pan-right':      { id: 'c06f78d8-cb10-4f86-8a7e-f339b3b5f6df', label: 'Pan Right', description: 'Horizontal pan right' },
};

class HiggsfieldClient {
  constructor() {
    this.apiKey = config.higgsfield?.apiKey;
    this.apiSecret = config.higgsfield?.apiSecret;
    this.headers = null;
    this._sdkReady = false;
  }

  _ensureConfig() {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Higgsfield API credentials not configured. Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.');
    }
    if (!this.headers) {
      this.headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'hf-api-key': this.apiKey,
        'hf-secret': this.apiSecret
      };
    }
  }

  _initSDK() {
    if (this._sdkReady) return;
    try {
      const { config: hfConfig } = require('@higgsfield/client/v2');
      hfConfig({ credentials: `${this.apiKey}:${this.apiSecret}` });
      this._sdkReady = true;
    } catch (err) {
      logger.warn(`[HIGGSFIELD] SDK init failed, using raw API: ${err.message}`);
    }
  }

  /**
   * Raw API request helper
   */
  async _request(method, path, body = null) {
    this._ensureConfig();
    const url = `${API_BASE}${path}`;
    const options = {
      method,
      headers: this.headers,
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Higgsfield API ${res.status}: ${text.substring(0, 500)}`);
    }

    return JSON.parse(text);
  }

  /**
   * List all available motion presets from the API
   */
  async listMotions() {
    return await this._request('GET', '/v1/motions');
  }

  /**
   * Get curated product video presets
   */
  getProductPresets() {
    return PRODUCT_MOTION_PRESETS;
  }

  /**
   * Generate image-to-video using the DoP model
   *
   * @param {string} imageUrl - Public URL of the source image
   * @param {Object} options
   * @param {string} options.prompt - Descriptive prompt for the video
   * @param {string} options.model - 'dop-turbo' | 'dop-lite' | 'dop-standard' (default: dop-turbo)
   * @param {string} options.motionPresetId - UUID of motion preset (optional)
   * @returns {Object} { jobSetId, status }
   */
  async generateVideo(imageUrl, options = {}) {
    this._ensureConfig();
    this._initSDK();

    const {
      prompt = 'Smooth cinematic camera movement on product, studio lighting, professional product video',
      model = 'dop-turbo',
      motionPresetId = null
    } = options;

    const input = {
      model,
      prompt,
      input_images: [{
        type: 'image_url',
        image_url: imageUrl
      }]
    };

    if (motionPresetId) {
      input.motion_preset_id = motionPresetId;
    }

    // Try SDK first (handles polling automatically)
    if (this._sdkReady) {
      try {
        const { higgsfield } = require('@higgsfield/client/v2');
        const jobSet = await higgsfield.subscribe('/v1/image2video/dop', {
          input,
          withPolling: true
        });

        const results = [];
        for (const job of jobSet.jobs) {
          if (job.results) {
            results.push({
              videoUrl: job.results.raw?.url || job.results.min?.url || null,
              thumbnailUrl: job.results.min?.url || null
            });
          }
        }

        return {
          jobSetId: jobSet.id,
          status: jobSet.isCompleted ? 'completed' : (jobSet.isFailed ? 'failed' : 'unknown'),
          results
        };
      } catch (err) {
        logger.warn(`[HIGGSFIELD] SDK subscribe failed, falling back to raw: ${err.message}`);
      }
    }

    // Fallback: raw API (submit only, poll separately)
    const data = await this._request('POST', '/v1/image2video/dop', { input });
    return {
      jobSetId: data.id || data.job_set_id,
      status: 'submitted',
      results: []
    };
  }

  /**
   * Submit video generation without waiting (async mode)
   */
  async submitVideo(imageUrl, options = {}) {
    this._ensureConfig();

    const {
      prompt = 'Smooth cinematic camera movement on product, studio lighting, professional product video',
      model = 'dop-turbo',
      motionPresetId = null
    } = options;

    const input = {
      model,
      prompt,
      input_images: [{
        type: 'image_url',
        image_url: imageUrl
      }]
    };

    if (motionPresetId) {
      input.motion_preset_id = motionPresetId;
    }

    // Use SDK fire-and-forget
    this._initSDK();
    if (this._sdkReady) {
      try {
        const { higgsfield } = require('@higgsfield/client/v2');
        const jobSet = await higgsfield.create('/v1/image2video/dop', { input });
        return { jobSetId: jobSet.id, status: 'submitted' };
      } catch (err) {
        logger.warn(`[HIGGSFIELD] SDK create failed, using raw: ${err.message}`);
      }
    }

    const data = await this._request('POST', '/v1/image2video/dop', { input });
    return { jobSetId: data.id || data.job_set_id, status: 'submitted' };
  }

  /**
   * Check status of a job set
   */
  async checkStatus(jobSetId) {
    const data = await this._request('GET', `/v1/job-sets/${jobSetId}`);

    const results = [];
    if (data.jobs) {
      for (const job of data.jobs) {
        if (job.results) {
          results.push({
            videoUrl: job.results.raw?.url || job.results.min?.url || null,
            thumbnailUrl: job.results.min?.url || null
          });
        }
      }
    }

    // Determine status
    let status = data.status || 'unknown';
    if (data.is_completed) status = 'completed';
    else if (data.is_failed) status = 'failed';
    else if (data.is_nsfw) status = 'nsfw_rejected';

    return {
      jobSetId,
      status,
      results,
      raw: data
    };
  }

  /**
   * Generate a batch of videos from multiple images
   * Submits all jobs in parallel, returns job IDs for polling
   *
   * @param {Array<{imageUrl: string, prompt?: string, motionPresetId?: string}>} images
   * @param {Object} globalOptions - Default options applied to all
   * @returns {Array<{imageUrl, jobSetId, status, error?}>}
   */
  async submitBatch(images, globalOptions = {}) {
    this._ensureConfig();
    this._initSDK();

    const results = [];
    // Process in batches of 3 to avoid rate limits
    const batchSize = 3;

    for (let i = 0; i < images.length; i += batchSize) {
      const batch = images.slice(i, i + batchSize);

      const promises = batch.map(async (img) => {
        try {
          const opts = {
            prompt: img.prompt || globalOptions.prompt,
            model: img.model || globalOptions.model || 'dop-turbo',
            motionPresetId: img.motionPresetId || globalOptions.motionPresetId
          };
          const result = await this.submitVideo(img.imageUrl, opts);
          return { imageUrl: img.imageUrl, ...result };
        } catch (err) {
          return { imageUrl: img.imageUrl, jobSetId: null, status: 'error', error: err.message };
        }
      });

      const batchResults = await Promise.all(promises);
      results.push(...batchResults);

      // Small delay between batches
      if (i + batchSize < images.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return results;
  }
}

// Singleton
let instance = null;
function getHiggsfieldClient() {
  if (!instance) instance = new HiggsfieldClient();
  return instance;
}

module.exports = { HiggsfieldClient, getHiggsfieldClient, PRODUCT_MOTION_PRESETS };
