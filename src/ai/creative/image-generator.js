/**
 * Image Generator — OpenAI gpt-image-1.5
 * Genera imagenes para Meta Ads usando la imagen del producto como input (image-to-image).
 */

const OpenAI = require('openai');
const { toFile } = require('openai');
const config = require('../../../config');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATED_DIR = path.join(config.system.uploadsDir, 'generated');

function ensureDir() {
  if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
  }
}

/**
 * Detect MIME type from file path
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  return types[ext] || 'image/png';
}

function getOpenAISize(format) {
  if (format === 'stories') return '1024x1536';
  return '1024x1024';
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Genera una imagen editada con OpenAI gpt-image-1.5
 * Includes automatic retry on 429 rate limit errors.
 */
async function generateImage(prompt, format, productImagePath, maxRetries = 3) {
  const apiKey = config.imageGen.openai.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada — revisar .env');
  }

  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  const client = new OpenAI({ apiKey });
  const size = getOpenAISize(format);
  const mimeType = getMimeType(productImagePath);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[IMAGE-GEN] OpenAI ${config.imageGen.openai.model} editando imagen ${size}... (intento ${attempt}/${maxRetries})`);
      const startTime = Date.now();

      // Use toFile helper to properly wrap the image with MIME type
      const imageFile = await toFile(fs.createReadStream(productImagePath), null, {
        type: mimeType
      });

      const result = await client.images.edit({
        model: config.imageGen.openai.model,
        image: imageFile,
        prompt,
        size,
        n: 1,
        input_fidelity: 'high'
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[IMAGE-GEN] OpenAI completo en ${elapsed}s`);

      const b64 = result.data[0].b64_json;
      if (!b64) throw new Error('OpenAI no retorno imagen');

      ensureDir();
      const filename = `openai-${crypto.randomBytes(8).toString('hex')}.png`;
      const filePath = path.join(GENERATED_DIR, filename);
      const buffer = Buffer.from(b64, 'base64');
      fs.writeFileSync(filePath, buffer);

      return {
        engine: 'openai',
        model: config.imageGen.openai.model,
        filename,
        file_path: filePath,
        file_type: 'image/png',
        size_bytes: buffer.length,
        generation_time_s: parseFloat(elapsed),
        prompt,
        format,
        format_label: config.imageGen.formats[format]?.label || format
      };
    } catch (err) {
      const is429 = err.status === 429 || err.code === 'rate_limit_exceeded' || (err.message && err.message.includes('Rate limit'));
      if (is429 && attempt < maxRetries) {
        // Parse retry-after from error message or default to 15s
        const retryMatch = err.message?.match(/try again in (\d+\.?\d*)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 15;
        logger.warn(`[IMAGE-GEN] Rate limit (429) — esperando ${waitSec}s antes de reintentar (intento ${attempt}/${maxRetries})`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Genera multiples imagenes secuencialmente con OpenAI.
 * Respeta rate limit de 5 imagenes/minuto con pausas entre llamadas.
 * Cada llamada individual tiene retry automático en caso de 429.
 *
 * @param {Array<{prompt: string, scene_label: string}>} prompts - Array de prompts con scene_label
 * @param {string} format - 'feed' o 'stories'
 * @param {string} productImagePath - Path a la imagen del producto
 * @returns {Array} - Resultados por cada prompt
 */
async function generateBatch(prompts, format, productImagePath) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  // OpenAI rate limit: 5 images/minute. Sequential processing already spaces calls
  // naturally (~50s per image). Add a small gap only as safety buffer.
  // The retry logic in generateImage handles any 429s that slip through.
  const DELAY_BETWEEN_MS = 2000;

  logger.info(`[IMAGE-GEN] Batch: generando ${prompts.length} imagenes secuencialmente (${DELAY_BETWEEN_MS / 1000}s entre cada una)...`);

  const output = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    logger.info(`[IMAGE-GEN] Imagen ${i + 1}/${prompts.length}: "${p.scene_label}"`);

    try {
      const result = await generateImage(p.prompt, format, productImagePath);
      output.push({ ...result, scene_label: p.scene_label });
    } catch (err) {
      logger.error(`[IMAGE-GEN] Batch imagen ${i + 1} fallo: ${err.message}`);
      output.push({ error: err.message || 'Error desconocido', scene_label: p.scene_label });
    }

    // Wait between calls (skip after last one)
    if (i < prompts.length - 1) {
      logger.info(`[IMAGE-GEN] Esperando ${DELAY_BETWEEN_MS / 1000}s antes de la siguiente imagen...`);
      await sleep(DELAY_BETWEEN_MS);
    }
  }

  const successCount = output.filter(o => !o.error).length;
  logger.info(`[IMAGE-GEN] Batch completo: ${successCount}/${prompts.length} exitosas`);

  return output;
}

/**
 * Genera imagenes en AMBOS formatos (1:1 feed + 9:16 stories) para cada prompt.
 * 3 prompts × 2 formats = 6 imagenes total.
 * Prefixes format instruction to each prompt before sending to OpenAI.
 *
 * @param {Array<{prompt: string, scene_label: string}>} prompts - Array de prompts (format-agnostic)
 * @param {string} productImagePath - Path a la imagen del producto
 * @returns {Array} - Resultados con format tag (feed/stories) per image
 */
async function generateDualFormatBatch(prompts, productImagePath) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  const DELAY_BETWEEN_MS = 2000;
  const totalImages = prompts.length * 2;

  logger.info(`[IMAGE-GEN] Dual-format batch: ${prompts.length} escenas × 2 formatos = ${totalImages} imagenes...`);

  const output = [];
  let imageNum = 0;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];

    // Generate both formats for this scene
    for (const fmt of ['feed', 'stories']) {
      imageNum++;
      const formatPrefix = fmt === 'stories'
        ? 'Vertical 9:16 format (1080x1920). '
        : 'Square 1:1 format (1080x1080). ';
      const fullPrompt = formatPrefix + p.prompt;
      const label = `${p.scene_label} (${fmt === 'feed' ? '1:1' : '9:16'})`;

      logger.info(`[IMAGE-GEN] Imagen ${imageNum}/${totalImages}: "${label}"`);

      try {
        const result = await generateImage(fullPrompt, fmt, productImagePath);
        output.push({ ...result, scene_label: p.scene_label, ad_format: fmt });
      } catch (err) {
        logger.error(`[IMAGE-GEN] Dual batch imagen ${imageNum} fallo: ${err.message}`);
        output.push({ error: err.message || 'Error desconocido', scene_label: p.scene_label, ad_format: fmt });
      }

      // Wait between calls (skip after last one)
      if (imageNum < totalImages) {
        logger.info(`[IMAGE-GEN] Esperando ${DELAY_BETWEEN_MS / 1000}s antes de la siguiente imagen...`);
        await sleep(DELAY_BETWEEN_MS);
      }
    }
  }

  const successCount = output.filter(o => !o.error).length;
  logger.info(`[IMAGE-GEN] Dual-format batch completo: ${successCount}/${totalImages} exitosas`);

  return output;
}

module.exports = { generateImage, generateBatch, generateDualFormatBatch };
