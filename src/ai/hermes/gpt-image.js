/**
 * GPT Image 2 wrapper — generación 100% AI para Hermes.
 *
 * Modelo: gpt-image-2 (lanzado 21-abr-2026). Capacidad clave que motivó
 * el redesign de Hermes: genera text DENTRO de la imagen con precisión
 * (vs DALL-E que pifiaba letras). Esto elimina la necesidad del overlay
 * post-generación con sharp.
 *
 * API: client.images.generate({ model: 'gpt-image-2', prompt, size, ... })
 * Returns: { data: [{ b64_json: '...' }] }
 *
 * Sizes soportados:
 *   - 1024x1024 (square, default)
 *   - 1024x1536 (portrait, mejor para feed mobile Meta)
 *   - 1536x1024 (landscape)
 *
 * Retry policy: 3 intentos con exponential backoff. Errores transient
 * (rate limit, server) reintentan. Errores permanentes (invalid prompt,
 * auth) fallan rápido.
 */

const OpenAI = require('openai');
const config = require('../../../config');
const logger = require('../../utils/logger');

const openai = new OpenAI({
  apiKey: config.imageGen?.openai?.apiKey || process.env.OPENAI_API_KEY,
  timeout: 180 * 1000,   // 3 min — gpt-image-2 high quality puede tardar 60-90s
  maxRetries: 0          // retry lo manejamos nosotros con backoff custom
});

const MODEL = 'gpt-image-2';
const DEFAULT_SIZE = '1024x1536';     // portrait — mejor ratio para Meta feed/stories
// Quality 'medium' (no 'high') porque high tarda 180s vs medium ~30-60s.
// Para foot traffic ads la diferencia visual no justifica la espera + el
// riesgo de timeout 30s del axios cliente. Si se quiere subir a high,
// también hay que subir timeout cliente y considerar polling async.
const DEFAULT_QUALITY = 'medium';

/**
 * Genera una imagen con gpt-image-2.
 *
 * @param {string} prompt - Prompt visual detallado en inglés (gpt-image-2 entiende mejor inglés)
 * @param {Object} options
 * @param {string} [options.size] - '1024x1024' | '1024x1536' | '1536x1024'
 * @param {string} [options.quality] - 'low' | 'medium' | 'high'
 * @param {AbortSignal} [options.signal] - para cancelar
 * @returns {Promise<{base64: string, model: string, size: string, elapsed_s: number}>}
 */
async function generateImage(prompt, options = {}) {
  const size = options.size || DEFAULT_SIZE;
  const quality = options.quality || DEFAULT_QUALITY;
  const maxRetries = 3;

  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[GPT-IMAGE] Generating ${size} ${quality} quality (attempt ${attempt}/${maxRetries})...`);

      const result = await openai.images.generate({
        model: MODEL,
        prompt,
        size,
        quality,
        n: 1
      });

      const b64 = result?.data?.[0]?.b64_json;
      if (!b64) {
        throw new Error('Respuesta sin b64_json — formato inesperado');
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[GPT-IMAGE] Generated ${size} in ${elapsed}s (attempt ${attempt})`);

      return {
        base64: b64,
        model: MODEL,
        size,
        quality,
        elapsed_s: parseFloat(elapsed)
      };
    } catch (err) {
      const status = err.status || err.response?.status;
      const code = err.code || err.error?.code;
      const message = err.message || 'Unknown error';

      // Errores permanentes — fallar rápido sin retry
      const isPermanent =
        status === 400 ||                              // bad request (prompt inválido, etc.)
        status === 401 ||                              // auth error
        status === 403 ||                              // forbidden
        code === 'content_policy_violation' ||
        code === 'invalid_prompt';

      if (isPermanent) {
        logger.error(`[GPT-IMAGE] Permanent error (${status}/${code}): ${message}`);
        throw err;
      }

      // Errores transient (rate limit, 5xx, timeout) — retry con backoff
      if (attempt < maxRetries) {
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 30000);  // 5s, 10s, 20s
        logger.warn(`[GPT-IMAGE] Transient error (${status}/${code}): ${message} — retry in ${delay/1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      logger.error(`[GPT-IMAGE] Failed after ${maxRetries} attempts: ${message}`);
      throw err;
    }
  }
}

module.exports = { generateImage, MODEL };
