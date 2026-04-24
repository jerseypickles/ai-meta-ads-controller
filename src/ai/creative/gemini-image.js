/**
 * Gemini Image Generator — helper único compartido por todos los callers.
 *
 * Consolida 2 pipelines previos (creative-agent.js + image-generator.js con OpenAI)
 * en un único punto de entrada. Motor operativo: gemini-3-pro-image-preview.
 *
 * Retry robusto: 3 intentos con exponential backoff para errores transitorios
 * (429 rate limit, 500 server error, network errors). Errores permanentes
 * (400 bad request, 401 auth) fallan inmediatamente sin retry.
 *
 * Referencias visuales:
 *   - Desde DB (CreativeAsset con image_base64) → inlineData directo
 *   - Desde disco (productImagePath o ref.path) → fs.readFileSync + base64
 *
 * Config Meta-Ads típica: aspectRatio '9:16' (stories), imageSize '2K'.
 * Overridable por caller para flexibilidad futura.
 */

const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const DEFAULT_MODEL = 'gemini-3-pro-image-preview';
const DEFAULT_ASPECT_RATIO = '9:16';
const DEFAULT_IMAGE_SIZE = '2K';
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientError(err) {
  // 429 rate limit — retry
  if (err.status === 429 || err.code === 'rate_limit_exceeded') return true;
  // 500/502/503 server errors — retry
  if (err.status >= 500 && err.status < 600) return true;
  // Network / timeout — retry
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') return true;
  // Mensaje común de rate limit
  if (err.message && /rate limit|try again/i.test(err.message)) return true;
  return false;
}

function backoffDelayMs(attempt) {
  // Exponential: 5s, 15s, 30s (cap 30s)
  return Math.min(30000, 5000 * Math.pow(3, attempt - 1));
}

/**
 * Convierte una referencia a {mimeType, data (base64)} para inlineData de Gemini.
 * Soporta: ref.image_base64 (DB) | ref.path (disco) | string path directo.
 */
function refToInlinePart(ref) {
  // String path directo (para productImagePath simple)
  if (typeof ref === 'string') {
    const absPath = path.resolve(ref);
    const imageData = fs.readFileSync(absPath);
    const ext = path.extname(ref).toLowerCase();
    return {
      inlineData: {
        mimeType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
        data: imageData.toString('base64')
      }
    };
  }

  // Object: preferir image_base64 de DB, fallback a path
  if (ref.image_base64) {
    return {
      inlineData: {
        mimeType: ref.mime_type || 'image/jpeg',
        data: ref.image_base64
      }
    };
  }

  if (ref.path) {
    const absPath = path.resolve(ref.path);
    const imageData = fs.readFileSync(absPath);
    const ext = path.extname(ref.path).toLowerCase();
    return {
      inlineData: {
        mimeType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
        data: imageData.toString('base64')
      }
    };
  }

  return null;
}

/**
 * Helper low-level: genera UNA imagen con Gemini.
 *
 * @param {string} prompt - Texto del prompt
 * @param {object} opts
 * @param {Array<object|string>} [opts.referenceImages] - Refs visuales (DB o disco)
 * @param {string} [opts.productImagePath] - Shortcut para una sola ref de disco
 * @param {string} [opts.aspectRatio='9:16'] - '1:1' | '9:16' | '16:9' | '4:5'
 * @param {string} [opts.imageSize='2K'] - '1K' | '2K'
 * @param {string} [opts.model] - Override del modelo
 * @param {number} [opts.maxRetries=3] - Intentos máximos
 * @returns {Promise<{base64: string, mimeType: string, model: string, generation_time_s: number, attempts: number}>}
 */
async function generateImageWithGemini(prompt, opts = {}) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');

  const model = opts.model || DEFAULT_MODEL;
  const aspectRatio = opts.aspectRatio || DEFAULT_ASPECT_RATIO;
  const imageSize = opts.imageSize || DEFAULT_IMAGE_SIZE;
  const maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;

  const genAI = new GoogleGenAI({ apiKey });

  // Armar parts: prompt + todas las referencias visuales
  const parts = [{ text: prompt }];

  const refs = [];
  if (Array.isArray(opts.referenceImages)) refs.push(...opts.referenceImages);
  if (opts.productImagePath) refs.push(opts.productImagePath);

  for (const ref of refs) {
    try {
      const part = refToInlinePart(ref);
      if (part) parts.push(part);
    } catch (err) {
      logger.warn(`[GEMINI-IMAGE] skip reference (${err.message})`);
    }
  }

  let lastErr = null;
  const start = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[GEMINI-IMAGE] ${model} · ${aspectRatio} ${imageSize} · intento ${attempt}/${maxRetries}`);

      const response = await genAI.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig: { aspectRatio, imageSize }
        }
      });

      // Extraer primera imagen de la respuesta
      const candidateParts = response?.candidates?.[0]?.content?.parts || [];
      for (const part of candidateParts) {
        if (part.inlineData) {
          const elapsed = (Date.now() - start) / 1000;
          logger.info(`[GEMINI-IMAGE] ✓ imagen generada en ${elapsed.toFixed(1)}s (attempt ${attempt})`);
          return {
            base64: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png',
            model,
            generation_time_s: parseFloat(elapsed.toFixed(1)),
            attempts: attempt
          };
        }
      }

      // Gemini respondió pero sin imagen — texto rechazado, safety, etc.
      throw new Error('Gemini did not return an image (possible safety block or rejection)');
    } catch (err) {
      lastErr = err;
      const transient = isTransientError(err);
      logger.warn(`[GEMINI-IMAGE] attempt ${attempt} falló: ${err.message} (transient=${transient})`);

      if (!transient || attempt >= maxRetries) {
        break;
      }

      const delay = backoffDelayMs(attempt);
      logger.info(`[GEMINI-IMAGE] esperando ${delay / 1000}s antes de reintentar...`);
      await sleep(delay);
    }
  }

  throw new Error(`Gemini image generation failed after ${maxRetries} attempts: ${lastErr?.message || 'unknown error'}`);
}

module.exports = {
  generateImageWithGemini,
  // Exports secundarios para testing
  _refToInlinePart: refToInlinePart,
  _isTransientError: isTransientError
};
