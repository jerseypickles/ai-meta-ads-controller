/**
 * Image Engine — dispatcher de motor de generación de imágenes (17-may-2026).
 *
 * Apollo puede generar con dos motores. El motor activo se controla con la
 * env var APOLLO_IMAGE_ENGINE:
 *   - 'gemini'      → Gemini 3 Pro Image Preview (gemini-image.js)
 *   - 'gpt-image-2' → OpenAI gpt-image-2 (gpt-image.js)
 *
 * Default: 'gemini' (estado histórico). El creador setea APOLLO_IMAGE_ENGINE
 * =gpt-image-2 en Render para activar el cambio sin redeploy.
 *
 * El dispatcher acepta la firma estilo Gemini (aspectRatio/imageSize/
 * referenceImages/productImagePath) y la adapta a cada motor — los callers
 * de Apollo no cambian su forma de llamar.
 *
 * NOTA aspect ratio: gpt-image-2 no tiene 9:16 nativo. Sus tamaños son
 * 1024x1024, 1024x1536 (2:3) y 1536x1024. Un pedido '9:16' se mapea al
 * portrait más cercano (1024x1536). Los creativos con gpt-image-2 salen 2:3,
 * que funciona bien para Meta feed.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { generateImageWithGemini } = require('./gemini-image');
const { generateImage: generateWithGptImage } = require('./gpt-image');

const DEFAULT_ENGINE = process.env.APOLLO_IMAGE_ENGINE || 'gemini';

/** aspectRatio (estilo Gemini) → size de gpt-image-2 */
function aspectToGptSize(aspectRatio) {
  if (aspectRatio === '1:1') return '1024x1024';
  if (aspectRatio === '16:9') return '1536x1024';
  // 9:16, 4:5 y demás portraits → el portrait disponible más cercano
  return '1024x1536';
}

/**
 * Convierte las referencias estilo Gemini (objetos {image_base64}|{path} o
 * string paths o productImagePath) al formato de gpt-image-2 ({buffer,...}).
 */
function adaptReferencesForGpt(opts) {
  const all = [];
  if (Array.isArray(opts.referenceImages)) all.push(...opts.referenceImages);
  if (opts.productImagePath) all.push(opts.productImagePath);

  const out = [];
  for (const ref of all) {
    try {
      if (typeof ref === 'string') {
        out.push({ buffer: fs.readFileSync(path.resolve(ref)), filename: path.basename(ref) });
      } else if (ref && ref.image_base64) {
        out.push({ buffer: Buffer.from(ref.image_base64, 'base64'), filename: 'ref.png', mime_type: ref.mime_type || 'image/png' });
      } else if (ref && ref.path) {
        out.push({ buffer: fs.readFileSync(path.resolve(ref.path)), filename: path.basename(ref.path) });
      }
    } catch (err) {
      logger.warn(`[IMAGE-ENGINE] skip reference (${err.message})`);
    }
  }
  return out;
}

/**
 * Genera UNA imagen con el motor activo. Firma compatible con
 * generateImageWithGemini — devuelve siempre el mismo shape para los callers.
 *
 * @param {string} prompt
 * @param {object} opts - { referenceImages, productImagePath, aspectRatio, imageSize, maxRetries, engine? }
 * @returns {Promise<{base64, mimeType, model, generation_time_s, attempts, engine}>}
 */
async function generateCreativeImage(prompt, opts = {}) {
  const engine = opts.engine || DEFAULT_ENGINE;

  if (engine === 'gpt-image-2') {
    const referenceImages = adaptReferencesForGpt(opts);
    const result = await generateWithGptImage(prompt, {
      size: aspectToGptSize(opts.aspectRatio),
      quality: 'medium',
      referenceImages
    });
    return {
      base64: result.base64,
      mimeType: 'image/png',
      model: result.model,
      generation_time_s: result.elapsed_s,
      attempts: 1,
      engine: 'gpt-image-2'
    };
  }

  // Default: Gemini
  const result = await generateImageWithGemini(prompt, opts);
  return { ...result, engine: 'gemini' };
}

module.exports = { generateCreativeImage, DEFAULT_ENGINE, aspectToGptSize };
