// ═══════════════════════════════════════════════════════════════════════════════
// video-postpro.js — POST-PRODUCCIÓN de Dionisio (2026-06-10).
//
// Primer paso del salto "render crudo → ad producido": HOOK TEXT OVERLAY estilo
// UGC nativo (Anton bold condensada, MAYÚSCULAS, blanco con borde negro grueso,
// centrado arriba, visible los primeros ~3s). El texto lo decide el copy del
// source (hook_text, generado por Claude); la tipografía es deliberadamente
// "motivante" — pedido del creador: nada de fuentes normales/apagadas.
//
// A/B 50% (VIDEO_OVERLAY_RATE): la cohorte used_text_overlay la mide el
// reconciliador (el overlay debería mover el THUMBSTOP — es un hook).
// Fail-open: si ffmpeg falla, el video sale crudo como antes.
//
// El mp4 procesado vive en el disco de Render (UPLOADS_DIR/vfinal) y se sirve
// público en /vfinal/:id.mp4 — Meta lo descarga de ahí al lanzar el test, y el
// result-judge (Gemini) juzga el video YA terminado (con overlay).
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const logger = require('../../../utils/logger');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const FINAL_DIR = path.join(UPLOADS_DIR, 'vfinal');
const FONT_PATH = path.join(__dirname, '..', '..', '..', '..', 'assets', 'fonts', 'Anton-Regular.ttf');
const OVERLAY_UNTIL_S = parseFloat(process.env.VIDEO_OVERLAY_SECONDS || '3.0');
const CLEANUP_DAYS = 14; // los videos ya viven en Meta tras el launch; el disco es buffer

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ai-meta-ads-controller.onrender.com';

function _ffmpegPath() {
  try { const p = require('ffmpeg-static'); if (p) return p; } catch (_) { /* fallback */ }
  return 'ffmpeg';
}

// SANITIZAR en vez de escapar (2026-06-10): el escaping dentro del string quoted
// de drawtext es frágil — verificado empíricamente que ' rompe el parser y que
// ':' y '\n' se comen el texto en silencio. Los hooks UGC en MAYÚSCULAS no los
// necesitan ("DONT SCROLL" / "POV PICKLE HEAVEN" es nativo del estilo). Solo
// quedan letras, números, espacios y . ! ? & -
function _sanitizeDrawtext(t) {
  return String(t)
    .replace(/['’`]/g, '')
    .replace(/[^A-Za-z0-9 .!?&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// drawtext NO hace word-wrap (y el \n literal se come el texto — verificado):
// partimos el hook en máx 2 líneas balanceadas y cada línea va en su PROPIO
// filtro drawtext encadenado.
function _wrapHookLines(text) {
  const t = String(text).trim().toUpperCase();
  if (t.length <= 16) return [t];
  const words = t.split(/\s+/);
  if (words.length < 2) return [t];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (!best || diff < best.diff) best = { a, b, diff };
  }
  return [best.a, best.b];
}

function _cleanupOldFinals() {
  try {
    const cutoff = Date.now() - CLEANUP_DAYS * 86400000;
    for (const f of fs.readdirSync(FINAL_DIR)) {
      const p = path.join(FINAL_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) { /* skip */ }
    }
  } catch (_) { /* dir puede no existir aún */ }
}

/**
 * Descarga el render de Seedance, quema el hook overlay y devuelve la URL pública
 * del video final. null si algo falla (el caller usa el video crudo — fail-open).
 * @param {string} videoUrl - URL del mp4 crudo (PiAPI)
 * @param {string} hookText - texto del gancho (≤ ~6 palabras; se fuerza UPPERCASE)
 * @param {string} outId - id del proposal (nombre del archivo final)
 */
async function applyHookOverlay({ videoUrl, hookText, outId }) {
  if (!videoUrl || !hookText || !outId) return null;
  if (!fs.existsSync(FONT_PATH)) { logger.warn(`[VIDEO-POSTPRO] fuente no encontrada: ${FONT_PATH}`); return null; }

  fs.mkdirSync(FINAL_DIR, { recursive: true });
  _cleanupOldFinals();

  const rawPath = path.join(FINAL_DIR, `${outId}-raw.mp4`);
  const outPath = path.join(FINAL_DIR, `${outId}.mp4`);

  try {
    const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(rawPath, resp.data);

    const lines = _wrapHookLines(_sanitizeDrawtext(hookText)).filter(Boolean);
    if (!lines.length) throw new Error('hook vacío post-sanitización');
    // Estilo UGC nativo: grande (h/15 ≈ 128px en 1920), borde negro grueso, arriba
    // centrado en safe area, visible 0.15s→3s (el hook vive donde vive el thumbstop).
    // Cada línea = un drawtext propio (multilinea con \n es frágil en el parser).
    const vf = lines.map((ln, i) => [
      `fontfile=${FONT_PATH}`,
      `text='${ln}'`,
      'fontsize=h/15',
      'fontcolor=white',
      'bordercolor=black',
      'borderw=9',
      'x=(w-text_w)/2',
      `y=h*0.10+(h/13.5)*${i}`,
      `enable='between(t,0.15,${OVERLAY_UNTIL_S})'`
    ].join(':')).map(d => `drawtext=${d}`).join(',');

    await new Promise((resolve, reject) => {
      execFile(
        _ffmpegPath(),
        ['-y', '-i', rawPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', outPath],
        { timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => err ? reject(new Error(`ffmpeg: ${(stderr || err.message).slice(-400)}`)) : resolve()
      );
    });

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10000) {
      throw new Error('output vacío o demasiado chico');
    }
    logger.info(`[VIDEO-POSTPRO] ✓ overlay "${hookText}" quemado → ${outId}.mp4 (${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
    return `${PUBLIC_BASE_URL}/vfinal/${outId}.mp4`;
  } catch (e) {
    logger.warn(`[VIDEO-POSTPRO] overlay falló para ${outId} (fail-open, sale crudo): ${e.message}`);
    try { fs.unlinkSync(outPath); } catch (_) { /* noop */ }
    return null;
  } finally {
    try { fs.unlinkSync(rawPath); } catch (_) { /* noop */ }
  }
}

/** Ruta absoluta del final en disco (para servirlo en /vfinal/:id.mp4). */
function finalPathFor(outId) {
  if (!/^[a-f0-9]{24}$/i.test(String(outId))) return null; // solo ObjectIds — anti path-traversal
  return path.join(FINAL_DIR, `${outId}.mp4`);
}

module.exports = { applyHookOverlay, finalPathFor };
