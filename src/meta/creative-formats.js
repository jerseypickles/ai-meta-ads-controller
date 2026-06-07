// ═══════════════════════════════════════════════════════════════════════════════
// CREATIVE FORMATS — ad creative MULTI-FORMATO por placement desde una imagen fuente.
// gpt-image-2 (Apollo) da 2:3 (1024x1536), NO 9:16 real → en Reels/Stories Meta
// recorta la imagen. Padeamos a 9:16 REAL (fondo desenfocado, contenido completo
// visible) para el vertical + recorte 4:5 para feed. Fallback a single 9:16 si Meta
// rechaza el multiformato. Usado por testing-agent (Prometheus) y creative-agent (Apollo).
// ═══════════════════════════════════════════════════════════════════════════════

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

// Padea a 9:16 real con fondo desenfocado — NO recorta el contenido (lo centra).
async function padTo916(srcBuf) {
  const md = await sharp(srcBuf).metadata();
  const w = md.width, h = md.height, target916 = Math.round(w * 16 / 9);
  if (h >= target916 - 4) return srcBuf; // ya es 9:16 (o más alto) → sin cambios
  const bg = await sharp(srcBuf).resize(w, target916, { fit: 'cover' }).blur(40).toBuffer();
  return await sharp(bg).composite([{ input: srcBuf, top: Math.round((target916 - h) / 2), left: 0 }]).png().toBuffer();
}

// Recorta 4:5 centrado (feed). null si la imagen no es más alta que 4:5.
async function cropTo45(srcBuf) {
  const md = await sharp(srcBuf).metadata();
  const w = md.width, h = md.height, targetH = Math.round(w * 5 / 4);
  if (h <= targetH) return null;
  return await sharp(srcBuf).extract({ left: 0, top: Math.round((h - targetH) / 2), width: w, height: targetH }).png().toBuffer();
}

/**
 * Sube assets 9:16 + 4:5 y crea el creative multi-formato (fallback single 9:16).
 * @param {object} meta - meta client
 * @param {Buffer} srcBuf - imagen fuente (cualquier ratio; típicamente 2:3 de gpt-image)
 * @param {object} creativeBase - { page_id, headline, body, description, cta, link_url, instagram_user_id }
 * @param {string} tag - prefijo para temp files
 * @returns {Promise<{creative_id, name, image_hash}>}
 */
async function createMultiFormatCreative(meta, srcBuf, creativeBase, tag = 'cf') {
  const tmpDir = os.tmpdir();
  // Vertical 9:16 real
  let vertBuf = srcBuf;
  try { vertBuf = await padTo916(srcBuf); } catch (e) { logger.warn(`[CREATIVE-FMT] pad 9:16 falló (uso original): ${e.message}`); }
  const tmpV = path.join(tmpDir, `${tag}_v_${Date.now()}.png`);
  fs.writeFileSync(tmpV, vertBuf);
  const upVert = await meta.uploadImage(tmpV); try { fs.unlinkSync(tmpV); } catch (_) {}

  // Feed 4:5
  let upFeed = null;
  try {
    const feedBuf = await cropTo45(srcBuf);
    if (feedBuf) {
      const tmpF = path.join(tmpDir, `${tag}_f_${Date.now()}.png`);
      fs.writeFileSync(tmpF, feedBuf);
      upFeed = await meta.uploadImage(tmpF); try { fs.unlinkSync(tmpF); } catch (_) {}
    }
  } catch (e) { logger.warn(`[CREATIVE-FMT] crop 4:5 falló: ${e.message}`); }

  let result;
  if (upFeed) {
    try {
      result = await meta.createAdCreativeMultiFormat({ ...creativeBase, image_hash_vertical: upVert.image_hash, image_hash_feed: upFeed.image_hash });
    } catch (e) {
      logger.warn(`[CREATIVE-FMT] multiformato falló → single 9:16: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  if (!result) result = await meta.createAdCreative({ ...creativeBase, image_hash: upVert.image_hash });
  return { ...result, image_hash: upVert.image_hash };
}

module.exports = { createMultiFormatCreative, padTo916, cropTo45 };
