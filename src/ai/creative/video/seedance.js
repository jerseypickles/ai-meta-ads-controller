// ═══════════════════════════════════════════════════════════════════════════════
// Apollo Video — MOTOR Seedance 2.0 (BytePlus ModelArk)
// Image-to-video async: submit → job_id → poll → video_url. Engine pinneado a
// seedance-2.0. Gated en BYTEPLUS_API_KEY.
//
// ⚠️ ENDPOINT/SHAPE TENTATIVO (de guía third-party): confirmar contra el console
// oficial de ModelArk cuando tengamos la key. Toda la parte HTTP está aislada en
// _submit() y _poll() para que sea un fix de un solo lugar. Ver memoria apollo-video.
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const logger = require('../../../utils/logger');

// Config (todo override-able por env, para ajustar al endpoint real sin redeploy de código).
const BASE_URL = process.env.BYTEPLUS_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3';
// Model ID real de Seedance 2.0 en BytePlus Ark (confirmado 2026-05-29).
const MODEL = process.env.SEEDANCE_MODEL || 'dreamina-seedance-2-0-260128'; // o -fast-260128
const SUBMIT_PATH = process.env.SEEDANCE_SUBMIT_PATH || '/contents/generations/tasks';
const POLL_BASE_DELAY_MS = 3000;
const POLL_MAX_DELAY_MS = 15000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000; // 6 min máx por video

function _apiKey() {
  const k = process.env.BYTEPLUS_API_KEY;
  if (!k) throw new Error('BYTEPLUS_API_KEY no configurada — motor Seedance 2.0 no disponible');
  return k;
}

function _headers() {
  return { Authorization: `Bearer ${_apiKey()}`, 'Content-Type': 'application/json' };
}

/**
 * Submit del job de image-to-video. Devuelve job_id.
 * ⚠️ Ajustar body/endpoint al shape oficial cuando tengamos la key.
 */
async function _submit({ imageBase64, imageUrl, prompt, durationSeconds, aspectRatio, resolution }) {
  const body = {
    model: MODEL,
    // image-to-video: una de las dos
    ...(imageUrl ? { image_url: imageUrl } : { image_base64: imageBase64 }),
    prompt,
    duration: durationSeconds,
    aspect_ratio: aspectRatio,
    resolution
  };
  const res = await axios.post(`${BASE_URL}${SUBMIT_PATH}`, body, { headers: _headers(), timeout: 30000 });
  const jobId = res.data?.job_id || res.data?.id || res.data?.task_id;
  if (!jobId) throw new Error(`Seedance: submit sin job_id (resp: ${JSON.stringify(res.data).slice(0, 200)})`);
  return jobId;
}

/** Poll del estado hasta completar (backoff 3s→15s). Devuelve video_url. */
async function _poll(jobId) {
  const start = Date.now();
  let delay = POLL_BASE_DELAY_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, delay));
    const res = await axios.get(`${BASE_URL}${SUBMIT_PATH}/${jobId}`, { headers: _headers(), timeout: 30000 });
    const status = (res.data?.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const url = res.data?.output?.video_url || res.data?.content?.video_url || res.data?.video_url;
      if (!url) throw new Error(`Seedance: completado sin video_url (resp: ${JSON.stringify(res.data).slice(0, 200)})`);
      return url;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Seedance: job falló — ${res.data?.error || res.data?.failure_reason || 'desconocido'}`);
    }
    delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS);
  }
  throw new Error(`Seedance: timeout (${POLL_TIMEOUT_MS / 1000}s) esperando job ${jobId}`);
}

/**
 * Genera un video corto (≤5s) a partir de una imagen de referencia.
 * @param {object} opts
 * @param {string} [opts.imageBase64] - imagen origen (o imageUrl)
 * @param {string} [opts.imageUrl]
 * @param {string} opts.prompt - motion prompt (ver motion-prompts.js)
 * @param {number} [opts.durationSeconds=5]
 * @param {string} [opts.aspectRatio='9:16']
 * @param {string} [opts.resolution='1080p']
 * @returns {Promise<{video_url, job_id, model, elapsed_s}>}
 */
async function generateVideoFromImage(opts) {
  const {
    imageBase64, imageUrl, prompt,
    durationSeconds = 5, aspectRatio = '9:16', resolution = '1080p'
  } = opts;
  if (!imageBase64 && !imageUrl) throw new Error('Seedance: falta imagen origen (imageBase64 o imageUrl)');
  if (!prompt) throw new Error('Seedance: falta motion prompt');

  const t0 = Date.now();
  logger.info(`[SEEDANCE] ${MODEL} image-to-video · ${durationSeconds}s ${aspectRatio} ${resolution}`);
  const jobId = await _submit({ imageBase64, imageUrl, prompt, durationSeconds, aspectRatio, resolution });
  logger.info(`[SEEDANCE] job ${jobId} en cola, pooleando...`);
  const videoUrl = await _poll(jobId);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  logger.info(`[SEEDANCE] ✅ video listo en ${elapsed}s · job ${jobId}`);
  return { video_url: videoUrl, job_id: jobId, model: MODEL, elapsed_s: elapsed };
}

/** Chequeo barato de disponibilidad (key presente). */
function isAvailable() {
  return !!process.env.BYTEPLUS_API_KEY;
}

module.exports = { generateVideoFromImage, isAvailable, MODEL };
