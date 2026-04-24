/**
 * Image Generator — Gemini 3 Pro Image Preview
 *
 * Refactor 2026-04-24: este módulo ANTES usaba OpenAI gpt-image-1.5 pero el
 * pipeline autónomo de Apollo (creative-agent.js:cron) ya usaba Gemini. Había
 * 2 motores distintos para generación — el UI del dashboard usaba uno y el cron
 * usaba otro. Ahora ambos unifican en gemini-image.js (helper compartido).
 *
 * API pública mantenida intacta (generateImage / generateBatch /
 * generateDualFormatBatch) para no romper callers del dashboard.
 * Cambios en el return:
 *   - engine: 'openai' → 'gemini'
 *   - model: 'gpt-image-1.5' → 'gemini-3-pro-image-preview'
 *   - file_type: mantenido 'image/png' (Gemini puede devolver PNG o WEBP)
 */

const config = require('../../../config');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateImageWithGemini } = require('./gemini-image');

const GENERATED_DIR = path.join(config.system.uploadsDir, 'generated');

function ensureDir() {
  if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mapeo formato (feed/stories) → aspectRatio de Gemini
function getAspectRatio(format) {
  if (format === 'stories') return '9:16';
  return '1:1';
}

// Mapeo formato → label en config (preservado para compat con la UI)
function getFormatLabel(format) {
  return config.imageGen.formats?.[format]?.label || format;
}

/**
 * Genera una imagen con Gemini usando la imagen del producto como referencia.
 * Mantiene la misma API que la versión OpenAI anterior — los callers no
 * necesitan cambiar nada. Retry robusto (3 intentos, exponential backoff)
 * delegado al helper gemini-image.
 *
 * @param {string} prompt - Texto del prompt
 * @param {string} format - 'feed' (1:1) o 'stories' (9:16)
 * @param {string} productImagePath - Path a la imagen del producto (referencia)
 * @param {number} [maxRetries=3] - Intentos máximos (se pasan al helper)
 */
async function generateImage(prompt, format, productImagePath, maxRetries = 3) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  const aspectRatio = getAspectRatio(format);
  const startTime = Date.now();

  const result = await generateImageWithGemini(prompt, {
    productImagePath,
    aspectRatio,
    imageSize: '2K',
    maxRetries
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Persistir a disco — callers del dashboard leen file_path para servir
  // previews. Mantenemos este contrato histórico.
  ensureDir();
  const ext = result.mimeType === 'image/webp' ? 'webp' : 'png';
  const filename = `gemini-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const filePath = path.join(GENERATED_DIR, filename);
  const buffer = Buffer.from(result.base64, 'base64');
  fs.writeFileSync(filePath, buffer);

  return {
    engine: 'gemini',
    model: result.model,
    filename,
    file_path: filePath,
    file_type: result.mimeType,
    size_bytes: buffer.length,
    generation_time_s: parseFloat(elapsed),
    prompt,
    format,
    format_label: getFormatLabel(format),
    attempts: result.attempts
  };
}

/**
 * Genera múltiples imágenes secuencialmente. El helper interno maneja
 * retry per-imagen con backoff, así que acá solo orquestamos secuencial
 * con un pequeño delay entre calls (respeta rate limits sanamente).
 */
async function generateBatch(prompts, format, productImagePath) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  const DELAY_BETWEEN_MS = 2000;

  logger.info(`[IMAGE-GEN] Batch Gemini: ${prompts.length} imágenes secuenciales...`);

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

    if (i < prompts.length - 1) await sleep(DELAY_BETWEEN_MS);
  }

  const successCount = output.filter(o => !o.error).length;
  logger.info(`[IMAGE-GEN] Batch completo: ${successCount}/${prompts.length} exitosas`);

  return output;
}

/**
 * Genera ambos formatos (feed 1:1 + stories 9:16) para cada prompt.
 * 3 prompts × 2 formats = 6 imágenes. Prefixes format instruction para
 * guiar mejor al motor aunque ya pasamos el aspectRatio en config.
 */
async function generateDualFormatBatch(prompts, productImagePath) {
  if (!productImagePath || !fs.existsSync(productImagePath)) {
    throw new Error('Se requiere imagen de producto para generar');
  }

  const DELAY_BETWEEN_MS = 2000;
  const totalImages = prompts.length * 2;

  logger.info(`[IMAGE-GEN] Dual-format Gemini: ${prompts.length} escenas × 2 formatos = ${totalImages} imágenes...`);

  const output = [];
  let imageNum = 0;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];

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

      if (imageNum < totalImages) await sleep(DELAY_BETWEEN_MS);
    }
  }

  const successCount = output.filter(o => !o.error).length;
  logger.info(`[IMAGE-GEN] Dual-format completo: ${successCount}/${totalImages} exitosas`);

  return output;
}

module.exports = { generateImage, generateBatch, generateDualFormatBatch };
