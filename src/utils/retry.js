const logger = require('./logger');

/**
 * Ejecuta una función con reintentos y backoff exponencial.
 * @param {Function} fn - Función async a ejecutar
 * @param {Object} options - Opciones de retry
 * @param {number} options.maxRetries - Número máximo de reintentos (default: 3)
 * @param {number} options.baseDelay - Delay base en ms (default: 1000)
 * @param {number} options.maxDelay - Delay máximo en ms (default: 30000)
 * @param {Function} options.shouldRetry - Función que decide si reintentar (default: siempre)
 * @param {string} options.label - Etiqueta para logs
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true,
    label = 'operation'
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error, attempt)) {
        const metaError = error.response?.data?.error;
        logger.error(`${label}: Fallo después de ${attempt + 1} intentos`, {
          error: error.message,
          ...(metaError ? { meta_error_code: metaError.code, meta_error_type: metaError.type, meta_error_message: metaError.message, meta_error_subcode: metaError.error_subcode } : {})
        });
        throw error;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5);

      logger.warn(`${label}: Intento ${attempt + 1} falló, reintentando en ${Math.round(jitter)}ms`, {
        error: error.message
      });

      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw lastError;
}

/**
 * Determina si un error HTTP de Meta API debería reintentarse.
 */
function shouldRetryMetaError(error) {
  if (!error.response) return true; // Error de red
  const status = error.response.status;
  const errorCode = error.response?.data?.error?.code;

  // NO reintentar en rate limit de app (code 17) — empeora la penalización
  if (errorCode === 17 || errorCode === 4) return false;

  // Reintentar en rate limit HTTP (429), errores de servidor (5xx)
  return status === 429 || status >= 500;
}

module.exports = { withRetry, shouldRetryMetaError };
