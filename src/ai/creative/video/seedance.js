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

function _key() {
  const k = process.env.PIAPI_KEY;
  if (!k) throw new Error('PIAPI_KEY no configurada — motor Seedance no disponible');
  return k;
}
function _headers() {
  return { 'x-api-key': _key(), 'Content-Type': 'application/json' };
}

/** Submit del job image-to-video. Devuelve task_id. */
async function _submit({ imageUrl, prompt, durationSeconds, aspectRatio }) {
  const body = {
    model: MODEL,
    task_type: TASK_TYPE,
    input: {
      mode: 'first_last_frames',     // imagen = primer frame → preserva fidelidad del producto
      prompt,
      duration: durationSeconds,
      aspect_ratio: aspectRatio,
      resolution: RESOLUTION,        // 1080p (solo lo respeta el tier VIP)
      image_urls: [imageUrl]
    }
  };
  const res = await axios.post(`${BASE_URL}/task`, body, { headers: _headers(), timeout: 30000 });
  if (res.data?.code !== 200) {
    throw new Error(`PiAPI submit: ${res.data?.message || JSON.stringify(res.data).slice(0, 200)}`);
  }
  const taskId = res.data?.data?.task_id;
  if (!taskId) throw new Error('PiAPI submit sin task_id');
  return taskId;
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
  const { imageUrl, prompt, durationSeconds = 5, aspectRatio = '9:16' } = opts;
  if (!imageUrl) throw new Error('Seedance: falta imageUrl (URL pública)');
  if (!prompt) throw new Error('Seedance: falta motion prompt');

  const t0 = Date.now();
  logger.info(`[SEEDANCE] ${MODEL}/${TASK_TYPE} image-to-video · ${durationSeconds}s ${aspectRatio} · ${RESOLUTION}`);
  const taskId = await _submit({ imageUrl, prompt, durationSeconds, aspectRatio });
  logger.info(`[SEEDANCE] task ${taskId} en cola, pooleando...`);
  const videoUrl = await _poll(taskId);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  logger.info(`[SEEDANCE] ✅ video listo en ${elapsed}s · ${videoUrl}`);
  return { video_url: videoUrl, task_id: taskId, model: MODEL, task_type: TASK_TYPE, elapsed_s: elapsed };
}

function isAvailable() {
  return !!process.env.PIAPI_KEY;
}

module.exports = { generateVideoFromImage, isAvailable, MODEL, TASK_TYPE };
