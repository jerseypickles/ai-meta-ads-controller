// ═══════════════════════════════════════════════════════════════════════════════
// Apollo Video — MOTOR Seedance 2.0 vía PiAPI
// Image-to-video async: submit → task_id → poll → output.video (URL).
// Schema confirmado contra la API real (2026-05-30): model="seedance",
// task_type="seedance-2-preview-vip" (NORMAL HD, no fast), input.mode="first_last_frames",
// input.image_urls=[URL pública], input.resolution="1080p". Gated en PIAPI_KEY.
//
// IMPORTANTE (doc PiAPI): el campo `resolution` SOLO lo respeta el tier VIP
// (`seedance-2-preview-vip`). Los modelos estándar (`seedance-2-preview` /
// `-fast`) salen a 480p fijo. Por eso el default es VIP → 1080p real. Sigue
// siendo el modelo NORMAL (no fast), es el tier de alta resolución del mismo.
// Ver memoria apollo-video / dionysus-agent.
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const logger = require('../../../utils/logger');

const BASE_URL = process.env.PIAPI_BASE_URL || 'https://api.piapi.ai/api/v1';
const MODEL = 'seedance';
// NORMAL HD por default (no fast) — pedido del creador: 1080p + máxima fidelidad.
// VIP es el único tier que respeta `resolution`. Override por env si hace falta.
const TASK_TYPE = process.env.SEEDANCE_TASK_TYPE || 'seedance-2-preview-vip';
const RESOLUTION = process.env.SEEDANCE_RESOLUTION || '1080p'; // 720p | 1080p (solo VIP)
const POLL_BASE_DELAY_MS = 5000;
const POLL_MAX_DELAY_MS = 20000;
// El tier VIP 1080p renderiza MUCHO más lento que el 480p estándar (cola VIP +
// más cómputo); observado 24min+ con la cola congestionada. Subimos el timeout a
// 25min para no marcar failed videos que en realidad iban a salir bien. Override por env.
const POLL_TIMEOUT_MS = parseInt(process.env.SEEDANCE_POLL_TIMEOUT_MS || String(25 * 60 * 1000), 10);
// Mandar `seed` para que dos jobs con mismo prompt+imagen no salgan idénticos (diversidad).
// OPT-IN (default OFF): no está verificado contra la API live de PiAPI; si el tier rechaza
// el campo `seed`, rompería TODA la generación. Activar con SEEDANCE_SEND_SEED=true tras
// confirmar que PiAPI lo acepta. La diversidad principal ya viene del explore + rotación de estilo.
const SEND_SEED = process.env.SEEDANCE_SEND_SEED === 'true';

function _key() {
  const k = process.env.PIAPI_KEY;
  if (!k) throw new Error('PIAPI_KEY no configurada — motor Seedance no disponible');
  return k;
}
function _headers() {
  return { 'x-api-key': _key(), 'Content-Type': 'application/json' };
}

/** Submit del job image-to-video. Devuelve task_id. */
async function _submit({ imageUrl, lastFrameUrl, prompt, durationSeconds, aspectRatio, seed }) {
  const input = {
    mode: 'first_last_frames',     // imagen = primer frame → preserva fidelidad del producto
    prompt,
    duration: durationSeconds,
    aspect_ratio: aspectRatio,
    resolution: RESOLUTION,        // 1080p (solo lo respeta el tier VIP) — pedido del creador: máxima calidad
    // Piloto 2026-06-09: con lastFrameUrl el modo usa AMBOS anclas (primer + último frame)
    // → Seedance interpola entre dos estados conocidos en vez de adivinar la física.
    image_urls: lastFrameUrl ? [imageUrl, lastFrameUrl] : [imageUrl]
  };
  if (SEND_SEED && Number.isFinite(seed)) input.seed = seed;
  const body = { model: MODEL, task_type: TASK_TYPE, input };

  // RETRY con backoff: PiAPI devuelve 500/429 transitorios seguido (~46% de los videos
  // morían por esto sin reintentar). Reintenta hasta 3x en errores transitorios (5xx/429/
  // red). Errores 4xx "reales" (400/401/403) no se reintentan. 2026-06-08.
  const DELAYS = [4000, 12000, 30000];
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await axios.post(`${BASE_URL}/task`, body, { headers: _headers(), timeout: 30000 });
      if (res.data?.code !== 200) {
        throw new Error(`PiAPI submit: ${res.data?.message || JSON.stringify(res.data).slice(0, 200)}`);
      }
      const taskId = res.data?.data?.task_id;
      if (!taskId) throw new Error('PiAPI submit sin task_id');
      if (attempt > 1) logger.info(`[SEEDANCE] submit OK en intento ${attempt} (recuperado de transitorio)`);
      return taskId;
    } catch (err) {
      lastErr = err;
      const code = err.response?.status;
      const transient = !code || code >= 500 || code === 429; // 5xx/429/red = transitorio
      if (!transient || attempt === 4) throw err;
      const delay = DELAYS[attempt - 1] || 30000;
      logger.warn(`[SEEDANCE] submit falló (${code || err.message}) — reintento ${attempt + 1}/4 en ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Poll hasta completar. Devuelve la URL del video. */
async function _poll(taskId) {
  const start = Date.now();
  let delay = POLL_BASE_DELAY_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, delay));
    const res = await axios.get(`${BASE_URL}/task/${taskId}`, { headers: _headers(), timeout: 30000 });
    const d = res.data?.data || {};
    const status = (d.status || '').toLowerCase();
    if (status === 'completed' || status === 'success') {
      const url = d.output?.video || d.output?.video_url;
      if (!url) throw new Error(`PiAPI completado sin video (output: ${JSON.stringify(d.output)})`);
      return url;
    }
    if (status === 'failed') {
      throw new Error(`PiAPI job falló: ${JSON.stringify(d.logs || d.error)}`);
    }
    delay = Math.min(delay * 1.4, POLL_MAX_DELAY_MS);
  }
  throw new Error(`PiAPI timeout (${POLL_TIMEOUT_MS / 1000}s) esperando task ${taskId}`);
}

/**
 * Genera un video corto (≤5s) image-to-video desde una imagen de referencia PÚBLICA.
 * @param {object} opts
 * @param {string} opts.imageUrl - URL PÚBLICA de la imagen origen (PiAPI la descarga)
 * @param {string} opts.prompt - motion prompt (ver motion-prompts.js)
 * @param {number} [opts.durationSeconds=5]
 * @param {string} [opts.aspectRatio='9:16']
 * @returns {Promise<{video_url, task_id, model, task_type, elapsed_s}>}
 */
async function generateVideoFromImage(opts) {
  const { imageUrl, lastFrameUrl = null, prompt, durationSeconds = 5, aspectRatio = '9:16' } = opts;
  if (!imageUrl) throw new Error('Seedance: falta imageUrl (URL pública)');
  if (!prompt) throw new Error('Seedance: falta motion prompt');
  const seed = Number.isFinite(opts.seed) ? opts.seed : Math.floor(Math.random() * 1e9);

  const t0 = Date.now();
  logger.info(`[SEEDANCE] ${MODEL}/${TASK_TYPE} image-to-video${lastFrameUrl ? ' · 🎬 FIRST+LAST frames' : ''} · ${durationSeconds}s ${aspectRatio} · ${RESOLUTION}${SEND_SEED ? ` · seed ${seed}` : ''}`);
  const taskId = await _submit({ imageUrl, lastFrameUrl, prompt, durationSeconds, aspectRatio, seed });
  logger.info(`[SEEDANCE] task ${taskId} en cola, pooleando...`);
  // Avisar el task_id apenas se emite (para persistirlo y poder reconciliar si el
  // proceso muere mid-render).
  if (typeof opts.onSubmit === 'function') { try { await opts.onSubmit(taskId); } catch (_) {} }
  const videoUrl = await _poll(taskId);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  logger.info(`[SEEDANCE] ✅ video listo en ${elapsed}s · ${videoUrl}`);
  return { video_url: videoUrl, task_id: taskId, model: MODEL, task_type: TASK_TYPE, elapsed_s: elapsed };
}

/**
 * Saca el watermark "AI生成" que ByteDance quema en TODO video de Seedance (obligación
 * legal china de etiquetar IA — no se puede desactivar al generar). Servicio APARTE de PiAPI
 * (task_type remove-watermark, ~$0.008/seg). Async: submit → poll → URL limpia. Recibe una
 * URL PÚBLICA del mp4 con marca, devuelve la URL sin marca. Fail-open en el caller (si falla,
 * queda el video con marca). Activable/desactivable por env (DIONYSUS_REMOVE_WATERMARK).
 * @param {string} videoUrl - URL pública del mp4 con watermark
 * @param {number} [durationSeconds] - PiAPI auto-detecta si no se pasa
 * @returns {Promise<string>} URL del video sin watermark
 */
async function removeWatermark(videoUrl, durationSeconds) {
  if (!videoUrl) throw new Error('removeWatermark: falta videoUrl');
  const input = { video_url: videoUrl };
  if (Number.isFinite(durationSeconds)) input.duration = durationSeconds;
  const body = { model: MODEL, task_type: 'remove-watermark', input };
  const DELAYS = [4000, 12000, 30000];
  let lastErr, taskId;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await axios.post(`${BASE_URL}/task`, body, { headers: _headers(), timeout: 30000 });
      if (res.data?.code !== 200) throw new Error(`PiAPI remove-watermark: ${res.data?.message || JSON.stringify(res.data).slice(0, 200)}`);
      taskId = res.data?.data?.task_id;
      if (!taskId) throw new Error('PiAPI remove-watermark sin task_id');
      break;
    } catch (err) {
      lastErr = err;
      const code = err.response?.status;
      const transient = !code || code >= 500 || code === 429;
      if (!transient || attempt === 4) throw err;
      await new Promise(r => setTimeout(r, DELAYS[attempt - 1] || 30000));
    }
  }
  if (!taskId) throw lastErr;
  logger.info(`[SEEDANCE] 🧽 remove-watermark task ${taskId} en cola...`);
  const url = await _poll(taskId);
  logger.info(`[SEEDANCE] ✅ watermark "AI生成" removido · ${url}`);
  return url;
}

function isAvailable() {
  return !!process.env.PIAPI_KEY;
}

/** Una sola consulta del estado de un task (sin loop). Para reconciliación. */
async function getTaskResult(taskId) {
  const res = await axios.get(`${BASE_URL}/task/${taskId}`, { headers: _headers(), timeout: 30000 });
  const d = res.data?.data || {};
  return { status: (d.status || '').toLowerCase(), video_url: d.output?.video || d.output?.video_url || null };
}

module.exports = { generateVideoFromImage, removeWatermark, isAvailable, getTaskResult, MODEL, TASK_TYPE };
